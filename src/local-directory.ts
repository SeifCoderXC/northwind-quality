import { createHash, createSign, generateKeyPairSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPassword, hashPassword } from "./auth.ts";
import { applyDotEnv } from "./jira.ts";

export const DIRECTORY_PASSWORD = "directory-local";

export type DirectoryAccount = {
  username: string;
  name: string;
  /** Absent means the id token omits the groups claim and the desk must refuse it. */
  groups?: string[];
};

export const DIRECTORY_ACCOUNTS: DirectoryAccount[] = [
  { username: "mchen", name: "Mina Chen", groups: ["northwind-directors"] },
  { username: "lokoro", name: "Leila Okoro", groups: ["northwind-captains"] },
  { username: "padebayo", name: "Paul Adebayo" },
];

const PLACEHOLDERS = new Set(["change-me", "northwind-local", "harbor-local", DIRECTORY_PASSWORD]);
const CODE_MS = 2 * 60 * 1000;
const PENDING_MS = 10 * 60 * 1000;
const LOCK_MS = 60_000;
const LOCK_LIMIT = 5;
const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};

type Pending = {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  expiresAt: number;
};

type IssuedCode = Pending & { username: string };

export type LocalDirectory = {
  port: number;
  issuer: string;
  close: () => Promise<void>;
};

function sameString(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function allowedRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === "http:"
      && (host === "127.0.0.1" || host === "localhost")
      && url.username === ""
      && url.password === ""
      && url.pathname === "/api/oidc/callback"
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function safeParam(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function readBody(req: IncomingMessage, limit = 8192): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function basicAuth(header: string | undefined): { id: string; secret: string } | undefined {
  const value = String(header || "");
  if (!value.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(value.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return undefined;
  return { id: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

function page(notice: string, username: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Northwind Directory</title>
<link rel="stylesheet" href="/directory.css">
</head>
<body>
<main class="gate">
<section class="story">
<p class="org">Northwind</p>
<h1>Directory</h1>
<p>This directory runs only on this machine. It returns a group list to the release desk. northwind-directors becomes a director. Any other group becomes a captain. A missing group list is refused.</p>
</section>
<section class="panel">
<form method="post" action="/session">
<h2>Sign in</h2>
<p class="lede">Use your directory account. The desk does not keep this password.</p>
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" required value="${escapeHtml(username)}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<p class="error" role="alert">${escapeHtml(notice)}</p>
<button type="submit">Continue</button>
<details>
<summary>Local accounts</summary>
<p>Mina Chen (mchen) is in northwind-directors. Leila Okoro (lokoro) is in northwind-captains. Paul Adebayo (padebayo) has no group list, and the desk refuses that sign-in. The password for these accounts is ${DIRECTORY_PASSWORD}.</p>
</details>
</form>
</section>
</main>
</body>
</html>`;
}

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string | number | string[]> = {}): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...securityHeaders, ...extra });
  res.end(body);
}

export function startLocalDirectory(options: {
  port?: number;
  host?: string;
  clientId: string;
  clientSecret: string;
  now?: () => number;
}): Promise<LocalDirectory> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") return Promise.reject(new Error("The local directory listens on loopback only."));
  const clientId = String(options.clientId || "").trim();
  const clientSecret = String(options.clientSecret || "");
  if (!clientId || clientSecret.length < 16 || PLACEHOLDERS.has(clientSecret)) {
    return Promise.reject(new Error("The local directory needs a real client id and client secret."));
  }
  const now = options.now ?? Date.now;
  const css = readFileSync(new URL("./directory.css", import.meta.url), "utf8");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey: KeyObject = pair.privateKey;
  const jwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey & { kid?: string; alg?: string; use?: string };
  jwk.kid = "northwind-directory-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const dummy = hashPassword(randomBytes(16).toString("hex"));
  const people = new Map(DIRECTORY_ACCOUNTS.map((account) => [account.username, { ...account, passwordHash: hashPassword(DIRECTORY_PASSWORD) }]));
  const pending = new Map<string, Pending>();
  const codes = new Map<string, IssuedCode>();
  const failures = new Map<string, number[]>();

  function prune(at: number): void {
    for (const [id, row] of pending) if (row.expiresAt <= at) pending.delete(id);
    for (const [id, row] of codes) if (row.expiresAt <= at) codes.delete(id);
  }

  function locked(username: string, at: number): boolean {
    const recent = (failures.get(username) || []).filter((stamp) => at - stamp < LOCK_MS);
    failures.set(username, recent);
    return recent.length >= LOCK_LIMIT;
  }

  function authorizeTarget(url: URL, at: number): { ok: true; row: Pending } | { ok: false } {
    if (url.searchParams.has("client_secret")) return { ok: false };
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const state = url.searchParams.get("state") || "";
    const nonce = url.searchParams.get("nonce") || "";
    const challenge = url.searchParams.get("code_challenge") || "";
    const scope = (url.searchParams.get("scope") || "").split(" ");
    if (url.searchParams.get("client_id") !== clientId) return { ok: false };
    if (url.searchParams.get("response_type") !== "code") return { ok: false };
    if (url.searchParams.get("code_challenge_method") !== "S256") return { ok: false };
    if (!scope.includes("openid")) return { ok: false };
    if (!allowedRedirect(redirectUri)) return { ok: false };
    if (!safeParam(state, 16, 200) || !safeParam(nonce, 16, 200) || !safeParam(challenge, 43, 128)) return { ok: false };
    return {
      ok: true,
      row: { clientId, redirectUri, state, nonce, challenge, expiresAt: at + PENDING_MS },
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, issuer: string): Promise<void> {
    const url = new URL(req.url || "/", issuer);
    const at = now();
    prune(at);
    if (req.method === "GET" && url.pathname === "/directory.css") {
      send(res, 200, css, "text/css; charset=utf-8", { "cache-control": "no-cache" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      send(res, 200, JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      }), "application/json");
      return;
    }
    if (req.method === "GET" && url.pathname === "/jwks") {
      send(res, 200, JSON.stringify({ keys: [jwk] }), "application/json");
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const target = authorizeTarget(url, at);
      if (!target.ok) {
        send(res, 400, page("This directory refused the sign-in request.", ""), "text/html; charset=utf-8");
        return;
      }
      const id = randomBytes(32).toString("hex");
      pending.set(id, target.row);
      send(res, 200, page("", ""), "text/html; charset=utf-8", {
        "set-cookie": `nd_pending=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/session") {
      const id = cookies(req).nd_pending || "";
      const row = pending.get(id);
      let form = new URLSearchParams();
      try {
        form = new URLSearchParams(await readBody(req));
      } catch {
        send(res, 400, page("This directory refused the sign-in request.", ""), "text/html; charset=utf-8");
        return;
      }
      const username = String(form.get("username") || "").trim().toLowerCase();
      const password = String(form.get("password") || "");
      if (!row || row.expiresAt <= at) {
        send(res, 400, page("This directory sign-in expired. Start again from the desk.", username), "text/html; charset=utf-8", {
          "set-cookie": "nd_pending=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        });
        return;
      }
      if (locked(username, at)) {
        send(res, 429, page("This directory locked that username for a minute.", username), "text/html; charset=utf-8");
        return;
      }
      const person = people.get(username);
      const matched = checkPassword(password, person ? person.passwordHash : dummy);
      if (!person || !matched) {
        failures.get(username)?.push(at);
        send(res, 401, page("That username or password is not in this directory.", username), "text/html; charset=utf-8");
        return;
      }
      pending.delete(id);
      const code = randomBytes(32).toString("hex");
      codes.set(code, { ...row, username, expiresAt: at + CODE_MS });
      const next = new URL(row.redirectUri);
      next.searchParams.set("code", code);
      next.searchParams.set("state", row.state);
      res.writeHead(302, {
        location: next.toString(),
        "cache-control": "no-store",
        ...securityHeaders,
        "set-cookie": "nd_pending=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      let form = new URLSearchParams();
      try {
        form = new URLSearchParams(await readBody(req));
      } catch {
        send(res, 400, JSON.stringify({ error: "invalid_request" }), "application/json");
        return;
      }
      const presented = basicAuth(req.headers.authorization);
      const code = form.get("code") || "";
      const issued = codes.get(code);
      if (issued) codes.delete(code);
      const verifier = form.get("code_verifier") || "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authed = presented && sameString(presented.id, clientId) && sameString(presented.secret, clientSecret);
      if (form.has("client_secret") || !authed || !issued || issued.expiresAt <= at) {
        send(res, authed ? 400 : 401, JSON.stringify({ error: "invalid_grant" }), "application/json", authed ? {} : { "www-authenticate": 'Basic realm="Northwind Directory"' });
        return;
      }
      if (form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== issued.redirectUri || form.get("client_id") !== clientId || !sameString(challenge, issued.challenge)) {
        send(res, 400, JSON.stringify({ error: "invalid_grant" }), "application/json");
        return;
      }
      const person = people.get(issued.username);
      if (!person) {
        send(res, 400, JSON.stringify({ error: "invalid_grant" }), "application/json");
        return;
      }
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
      const claims: Record<string, unknown> = {
        iss: issuer,
        aud: clientId,
        sub: person.username,
        nonce: issued.nonce,
        iat: Math.floor(at / 1000),
        exp: Math.floor(at / 1000) + 300,
        name: person.name,
      };
      if (person.groups) claims.groups = person.groups;
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const data = `${header}.${payload}`;
      const signature = createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url");
      send(res, 200, JSON.stringify({ id_token: `${data}.${signature}`, token_type: "Bearer", expires_in: 300 }), "application/json");
      return;
    }
    send(res, 404, JSON.stringify({ error: "not_found" }), "application/json");
  }

  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    handle(req, res, `http://127.0.0.1:${port}`).catch(() => {
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: "server_error" }), "application/json");
      else res.end();
    });
  });
  return new Promise((resolveListen, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveListen({
        port,
        issuer: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const startedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (startedAsMain) {
  const envFile = join(here, "..", ".env");
  if (existsSync(envFile)) applyDotEnv(process.env, readFileSync(envFile, "utf8"));
  const port = Number(process.env.LOCAL_DIRECTORY_PORT || 4391);
  startLocalDirectory({
    port,
    clientId: String(process.env.OIDC_CLIENT_ID || ""),
    clientSecret: String(process.env.OIDC_CLIENT_SECRET || ""),
  }).then(
    (running) => {
      const expected = String(process.env.OIDC_ISSUER_URL || "").replace(/\/$/, "");
      if (expected && expected !== running.issuer) {
        console.error(`OIDC_ISSUER_URL is ${expected}. This directory is ${running.issuer}.`);
        process.exit(1);
      }
      console.log(`Northwind Directory ${running.issuer}`);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
