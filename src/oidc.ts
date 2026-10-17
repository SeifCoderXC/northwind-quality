import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

export type OidcEnv = {
  OIDC_ISSUER_URL?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_GROUP_CLAIM?: string;
  OIDC_DIRECTOR_GROUP?: string;
};

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

type Jwk = JsonWebKey & { kid?: string };
type Jwks = { keys?: Jwk[] };

const PLACEHOLDERS = new Set(["change-me", "northwind-local", "harbor-local"]);

export function normalizedIssuer(value: string): string {
  return String(value || "").replace(/\/$/, "");
}

function issuerUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return url;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Public issuers are https. A loopback http issuer is the test double. */
export function oidcConfigured(env: OidcEnv): boolean {
  if (!issuerUrl(String(env.OIDC_ISSUER_URL || ""))) return false;
  const secret = String(env.OIDC_CLIENT_SECRET || "");
  if (!String(env.OIDC_CLIENT_ID || "").trim()) return false;
  if (!String(env.OIDC_GROUP_CLAIM || "").trim()) return false;
  if (!String(env.OIDC_DIRECTOR_GROUP || "").trim()) return false;
  if (secret.length < 16 || PLACEHOLDERS.has(secret)) return false;
  return true;
}

export function directoryUsername(issuer: string, sub: string): string {
  const digest = createHash("sha256").update(`${normalizedIssuer(issuer)}\n${sub}`).digest("hex").slice(0, 20);
  return `d${digest}`;
}

export function roleFromGroups(
  groups: unknown,
  directorGroup: string,
): { ok: true; role: "director" | "captain" } | { ok: false; error: string } {
  if (!Array.isArray(groups) || groups.some((item) => typeof item !== "string")) {
    return { ok: false, error: "The directory did not send a group list." };
  }
  return { ok: true, role: groups.includes(directorGroup) ? "director" : "captain" };
}

export function callbackUrl(hostHeader: string): string | undefined {
  const host = String(hostHeader || "").trim();
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return undefined;
  const hostname = host.replace(/:\d+$/, "");
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return undefined;
  return `http://${host}/api/oidc/callback`;
}

function sameOrigin(issuer: string, endpoint: string): boolean {
  try {
    return new URL(issuer).origin === new URL(endpoint).origin;
  } catch {
    return false;
  }
}

async function discover(
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; doc: Discovery } | { ok: false; error: string }> {
  const root = normalizedIssuer(issuer);
  if (!issuerUrl(root)) return { ok: false, error: "The directory is not reachable." };
  let response: Response;
  try {
    response = await fetchImpl(`${root}/.well-known/openid-configuration`);
  } catch {
    return { ok: false, error: "The directory is not reachable." };
  }
  if (!response.ok) return { ok: false, error: "The directory is not reachable." };
  const doc = (await response.json()) as Partial<Discovery>;
  if (normalizedIssuer(String(doc.issuer || "")) !== root) return { ok: false, error: "The directory rejected the sign-in." };
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    return { ok: false, error: "The directory rejected the sign-in." };
  }
  if (![doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri].every((endpoint) => sameOrigin(root, endpoint))) {
    return { ok: false, error: "The directory rejected the sign-in." };
  }
  return { ok: true, doc: doc as Discovery };
}

export async function beginDirectoryLogin(
  env: OidcEnv,
  redirectUri: string,
  fetchImpl: typeof fetch,
  _now: number,
): Promise<
  | { ok: true; location: string; state: string; nonce: string; verifier: string }
  | { ok: false; error: string }
> {
  if (!oidcConfigured(env)) return { ok: false, error: "Directory sign-in is not configured." };
  const found = await discover(String(env.OIDC_ISSUER_URL), fetchImpl);
  if (!found.ok) return found;
  const state = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(found.doc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", String(env.OIDC_CLIENT_ID));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { ok: true, location: url.toString(), state, nonce, verifier };
}

function rejected(): { ok: false; error: string } {
  return { ok: false, error: "The directory rejected the sign-in." };
}

export function verifyIdToken(
  token: string,
  jwks: Jwks,
  expected: { issuer: string; audience: string; nonce: string; now: number },
): { ok: true; claims: Record<string, unknown> } | { ok: false; error: string } {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return rejected();
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; kid?: string };
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return rejected();
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return rejected();
  const jwk = (jwks.keys || []).find((key) => key.kid === header.kid);
  if (!jwk) return rejected();
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return rejected();
  }
  const signature = Buffer.from(parts[2], "base64url");
  const valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, signature);
  if (!valid) return rejected();
  if (normalizedIssuer(String(claims.iss || "")) !== normalizedIssuer(expected.issuer)) return rejected();
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(expected.audience)) return rejected();
  if (claims.nonce !== expected.nonce) return rejected();
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= expected.now) return rejected();
  if (typeof claims.sub !== "string" || !claims.sub) return rejected();
  return { ok: true, claims };
}

function displayName(claims: Record<string, unknown>): string {
  const raw = typeof claims.name === "string" ? claims.name : "";
  const cleaned = raw.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 2) return "Directory user";
  return cleaned.slice(0, 60);
}

export async function completeDirectoryLogin(
  env: OidcEnv,
  input: { code: string; verifier: string; nonce: string; redirectUri: string },
  fetchImpl: typeof fetch,
  now: number,
): Promise<{ ok: true; sub: string; name: string; role: "director" | "captain" } | { ok: false; error: string }> {
  if (!oidcConfigured(env)) return { ok: false, error: "Directory sign-in is not configured." };
  const found = await discover(String(env.OIDC_ISSUER_URL), fetchImpl);
  if (!found.ok) return found;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: String(env.OIDC_CLIENT_ID),
    code_verifier: input.verifier,
  });
  const basic = Buffer.from(`${String(env.OIDC_CLIENT_ID)}:${String(env.OIDC_CLIENT_SECRET)}`).toString("base64");
  let tokenResponse: Response;
  try {
    tokenResponse = await fetchImpl(found.doc.token_endpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
  } catch {
    return { ok: false, error: "The directory is not reachable." };
  }
  if (!tokenResponse.ok) return rejected();
  const tokenBody = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenBody.id_token) return rejected();
  let jwksResponse: Response;
  try {
    jwksResponse = await fetchImpl(found.doc.jwks_uri);
  } catch {
    return { ok: false, error: "The directory is not reachable." };
  }
  if (!jwksResponse.ok) return rejected();
  const jwks = (await jwksResponse.json()) as Jwks;
  const verified = verifyIdToken(tokenBody.id_token, jwks, {
    issuer: normalizedIssuer(String(env.OIDC_ISSUER_URL)),
    audience: String(env.OIDC_CLIENT_ID),
    nonce: input.nonce,
    now,
  });
  if (!verified.ok) return verified;
  const role = roleFromGroups(verified.claims[String(env.OIDC_GROUP_CLAIM)], String(env.OIDC_DIRECTOR_GROUP));
  if (!role.ok) return role;
  return { ok: true, sub: String(verified.claims.sub), name: displayName(verified.claims), role: role.role };
}

export function directoryCode(error: string): string {
  if (error === "The directory is not reachable.") return "unreachable";
  if (error === "The directory did not send a group list.") return "groups";
  if (error === "The directory sign-in did not match this browser.") return "mismatch";
  if (error === "The directory sign-in expired.") return "expired";
  return "rejected";
}
