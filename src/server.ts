import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gateNote, org, release } from "./catalog.js";
import { bindAllowed } from "./bind.js";
import { checkPassword, hashInvite, hashPassword, newToken, validateAccount } from "./auth.ts";
import { openDb, type Journey, type Store, type User, type Waiver } from "./db.ts";
import { applyDotEnv, jiraBrowseRoot, jiraConfigured, pushIssue, type JiraEnv } from "./jira.ts";
import { launchBrowser, runLiveCheck } from "./live-check.js";
import { approveWaiver, evaluate, fileWaiver, releaseBrief, waiverPrompt } from "./policy.js";
import {
  beginDirectoryLogin,
  callbackUrl,
  completeDirectoryLogin,
  directoryCode,
  directoryUsername,
  normalizedIssuer,
  oidcConfigured,
} from "./oidc.ts";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const checkoutUrl = new URL("./public/checkout.html", import.meta.url).href;
let store: Store | undefined;

function db(): Store {
  if (!store) {
    const file = process.env.QUALITY_DB || join(root, "..", "data", "quality.sqlite");
    const demoPassword = process.env.QUALITY_DEMO_PASSWORD || "northwind-local";
    store = openDb(file, demoPassword);
  }
  return store;
}

const staticFiles: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/checkout.html": ["checkout.html", "text/html; charset=utf-8"],
};

const SESSION_MS = 12 * 60 * 60 * 1000;
const AUDIT_PAGE = 40;
const LOGIN_LIMIT = 5;
const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'",
};

function idleMs(): number {
  const raw = Number(process.env.QUALITY_IDLE_MS || 30 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

function loginWindowMs(): number {
  const raw = Number(process.env.QUALITY_LOGIN_WINDOW_MS || 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json", extra: Record<string, string> = {}) {
  const payload = Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...securityHeaders, ...extra });
  res.end(payload);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, file: [string, string]): void {
  const bytes = readFileSync(join(publicDir, file[0]));
  const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
  const cache = file[0].endsWith(".html") ? "no-store" : "no-cache";
  if (cache === "no-cache" && req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag, "cache-control": cache, ...securityHeaders });
    res.end();
    return;
  }
  send(res, 200, bytes, file[1], { etag, "cache-control": cache });
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sessionOutcome(req: IncomingMessage): { user?: User; error: string } {
  const token = cookies(req).nq_session;
  if (!token) return { error: "Sign in required" };
  const found = db().takeSession(token, Date.now(), idleMs());
  if (found.status === "ok") return { user: found.user, error: "" };
  if (found.status === "idle") return { error: "The session timed out." };
  return { error: "Sign in required" };
}

function sessionCookie(token: string): string {
  return `nq_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`;
}

function clearCookie(): string {
  return "nq_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

function oidcCookie(state: string): string {
  return `nq_oidc=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
}

function clearOidcCookie(): string {
  return "nq_oidc=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

function sameState(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function directoryRedirect(res: ServerResponse, code: string): void {
  res.writeHead(302, {
    location: `/?directory=${code}`,
    "cache-control": "no-store",
    ...securityHeaders,
    "set-cookie": clearOidcCookie(),
  });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function auditBody(limit: number, beforeId: number | null) {
  const page = db().auditPage(limit, beforeId);
  return {
    audit: page.rows,
    auditPage: { limit: page.limit, hasMore: page.hasMore, nextBefore: page.nextBefore },
  };
}

function currentWaiver(waivers: Waiver[], journeyId: string, now: number): Waiver | null {
  const rows = waivers.filter((waiver) => waiver.journeyId === journeyId && waiver.expiresAt > now);
  return rows.find((waiver) => waiver.status === "approved") || rows.find((waiver) => waiver.status === "pending") || null;
}

function workspace(user: User) {
  const now = Date.now();
  const rows = db().journeys();
  const waivers = db().waivers();
  const evaluation = evaluate(rows, waivers, now);
  for (const journey of evaluation.blocking) db().enqueueDefect(journey);
  const withWaiver = rows.map((journey) => ({
    ...journey,
    waiver: currentWaiver(waivers, journey.id, now),
    waiverPrompt: waiverPrompt(journey),
  }));
  return {
    org,
    actor: { name: user.name, role: user.role },
    services: db().services(),
    release: {
      id: release.id,
      opened: release.opened,
      catalogSize: release.trainTests,
      catalogOnly: true,
      scoredJourneys: rows.filter((journey) => ["passed", "failed", "flaky"].includes(journey.status)).length,
      gateNote: gateNote(release, rows),
    },
    journeys: withWaiver,
    waivers,
    ...auditBody(AUDIT_PAGE, null),
    defects: db().defects(),
    evaluation,
    brief: releaseBrief({
      releaseId: release.id,
      decision: evaluation.decision,
      reason: evaluation.reason,
      impactUsers: evaluation.impactUsers,
      blocking: evaluation.blocking,
    }),
    jira: jiraConfigured(process.env),
    jiraBrowse: jiraBrowseRoot(process.env),
  };
}

async function flushJira(env: JiraEnv): Promise<void> {
  if (!jiraConfigured(env)) return;
  for (const defect of db().queuedDefects()) {
    try {
      const pushed = await pushIssue(env, defect, fetch);
      if (pushed.ok) db().markDefect(defect.id, "pushed", pushed.key);
    } catch {
      return;
    }
  }
}

function requireUser(req: IncomingMessage, res: ServerResponse): User | undefined {
  const found = sessionOutcome(req);
  if (!found.user) {
    send(res, 401, { error: found.error, directory: oidcConfigured(process.env) });
    return undefined;
  }
  return found.user;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const file = staticFiles[url.pathname];
  if (req.method === "GET" && file) return serveStatic(req, res, file);
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, product: org.product });
  }
  if (req.method === "GET" && url.pathname === "/api/session") {
    const found = sessionOutcome(req);
    if (!found.user) return send(res, 401, { error: found.error, directory: oidcConfigured(process.env) });
    return send(res, 200, { user: { name: found.user.name, role: found.user.role } });
  }
  if (req.method === "GET" && url.pathname === "/api/oidc/start") {
    if (!oidcConfigured(process.env)) return send(res, 404, { error: "Directory sign-in is not configured." });
    const redirectUri = callbackUrl(String(req.headers.host || ""));
    if (!redirectUri) return directoryRedirect(res, "mismatch");
    const begun = await beginDirectoryLogin(process.env, redirectUri, fetch, Date.now());
    if (!begun.ok) return directoryRedirect(res, directoryCode(begun.error));
    db().saveOidcState({ state: begun.state, nonce: begun.nonce, verifier: begun.verifier, expiresAt: Date.now() + 10 * 60 * 1000 });
    res.writeHead(302, {
      location: begun.location,
      "cache-control": "no-store",
      ...securityHeaders,
      "set-cookie": oidcCookie(begun.state),
    });
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/oidc/callback") {
    if (!oidcConfigured(process.env)) return send(res, 404, { error: "Directory sign-in is not configured." });
    const redirectUri = callbackUrl(String(req.headers.host || ""));
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    if (!redirectUri || !code || !sameState(cookies(req).nq_oidc || "", state)) return directoryRedirect(res, "mismatch");
    const saved = db().takeOidcState(state, Date.now());
    if (!saved) return directoryRedirect(res, "expired");
    const done = await completeDirectoryLogin(
      process.env,
      { code, verifier: saved.verifier, nonce: saved.nonce, redirectUri },
      fetch,
      Date.now(),
    );
    if (!done.ok) return directoryRedirect(res, directoryCode(done.error));
    const username = directoryUsername(normalizedIssuer(String(process.env.OIDC_ISSUER_URL || "")), done.sub);
    const existing = db().userByUsername(username);
    const account = existing
      ? existing
      : db().createUser({ username, name: done.name, role: done.role, password: randomBytes(32).toString("hex") });
    if (!account) return directoryRedirect(res, "rejected");
    if (existing) db().setDirectoryProfile(existing.id, done.name, done.role);
    const profile = { ...account, name: done.name, role: done.role };
    const token = newToken();
    db().createSession(profile.id, token, Date.now() + SESSION_MS);
    db().addAudit({ at: Date.now(), actor: profile.name, action: "sign-in", detail: `${profile.role} signed in through the directory` });
    res.writeHead(302, {
      location: "/",
      "cache-control": "no-store",
      ...securityHeaders,
      "set-cookie": [sessionCookie(token), clearOidcCookie()],
    });
    res.end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "The request body is not JSON." });
    const username = String(body.username || "").trim().toLowerCase();
    const now = Date.now();
    const windowMs = loginWindowMs();
    if (db().failedLoginCount(username, now, windowMs) >= LOGIN_LIMIT) {
      return send(res, 429, { error: "Too many sign-in attempts. Wait and try again." });
    }
    const account = db().userByUsername(username);
    if (!account || !checkPassword(String(body.password || ""), account.passwordHash)) {
      db().recordFailedLogin(username, now, windowMs);
      return send(res, 401, { error: "Those credentials were rejected." });
    }
    db().clearFailedLogins(username);
    const token = newToken();
    db().createSession(account.id, token, Date.now() + SESSION_MS);
    db().addAudit({ at: Date.now(), actor: account.name, action: "sign-in", detail: `${account.role} signed in` });
    return send(res, 200, { name: account.name, role: account.role }, "application/json", { "set-cookie": sessionCookie(token) });
  }
  if (req.method === "POST" && url.pathname === "/api/register") {
    const body = (await readBody(req)) as { name?: string; username?: string; password?: string; role?: string; invite?: string } | undefined;
    if (!body) return send(res, 400, { error: "The request body is not JSON." });
    const invite = String(body.invite || "").trim();
    const checked = validateAccount({
      name: body.name,
      username: body.username,
      password: body.password,
      role: invite ? undefined : body.role,
    });
    if (!checked.ok) return send(res, 400, checked);
    if (db().userByUsername(checked.username)) return send(res, 409, { error: "That username is already taken." });
    const created = db().createUser({ ...checked, role: invite ? "director" : "captain" });
    if (!created) return send(res, 409, { error: "That username is already taken." });
    if (invite) {
      const role = db().consumeInvite(hashInvite(invite), created.id, Date.now());
      if (role !== "director") {
        db().deleteUser(created.id);
        return send(res, 400, { error: "This invite is invalid or expired." });
      }
    }
    const token = newToken();
    db().createSession(created.id, token, Date.now() + SESSION_MS);
    db().addAudit({
      at: Date.now(),
      actor: created.name,
      action: "register",
      detail: created.role === "director" ? "Director account created" : "Captain account created",
    });
    return send(res, 201, { name: created.name, role: created.role }, "application/json", { "set-cookie": sessionCookie(token) });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = cookies(req).nq_session;
    if (token) db().deleteSession(token);
    return send(res, 204, "", "text/plain", { "set-cookie": clearCookie() });
  }
  const user = requireUser(req, res);
  if (!user) return;
  if (req.method === "GET" && url.pathname === "/api/workspace") {
    await flushJira(process.env);
    return send(res, 200, workspace(user));
  }
  if (req.method === "GET" && url.pathname === "/api/audit") {
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : null;
    const limit = Number(url.searchParams.get("limit") || AUDIT_PAGE);
    return send(res, 200, auditBody(limit, before));
  }
  if (req.method === "POST" && url.pathname === "/api/invites") {
    if (user.role !== "director") return send(res, 403, { error: "A director has to issue a director invite." });
    const code = newToken();
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    db().createInvite({ codeHash: hashInvite(code), role: "director", createdBy: user.id, expiresAt });
    db().addAudit({ at: Date.now(), actor: user.name, action: "invite", detail: "Director invite issued for 24 hours" });
    return send(res, 201, { code, expiresAt, role: "director" });
  }
  if (req.method === "POST" && url.pathname === "/api/password") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "The request body is not JSON." });
    const account = db().userByUsername(user.username);
    if (!account || !checkPassword(String(body.current || ""), account.passwordHash)) {
      return send(res, 400, { error: "The current password is wrong." });
    }
    const checked = validateAccount({ name: user.name, username: user.username, password: String(body.next || "") });
    if (!checked.ok) return send(res, 400, checked);
    db().setPassword(user.id, hashPassword(checked.password));
    db().addAudit({ at: Date.now(), actor: user.name, action: "password", detail: "Password changed" });
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/waivers") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "The request body is not JSON." });
    const journey = db().journeys().find((row) => row.id === body.journeyId);
    if (!journey) return send(res, 400, { error: "Unknown journey" });
    if (journey.status !== "failed") return send(res, 400, { error: "Only a failing journey can be waived." });
    const filed = fileWaiver(journey, { ...body, actor: user.name }, Date.now());
    if (!filed.ok) return send(res, 400, filed);
    const saved = db().saveWaiver(filed.waiver);
    db().addAudit({
      at: saved.filedAt,
      actor: user.name,
      action: "waiver",
      detail: `${journey.title} filed for ${saved.hours}h (${saved.status})`,
    });
    return send(res, 200, workspace(user));
  }
  if (req.method === "POST" && url.pathname === "/api/approvals") {
    if (user.role !== "director") return send(res, 403, { error: "A director has to approve this waiver." });
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "The request body is not JSON." });
    const waiver = db().waivers().find((row) => row.id === body.waiverId);
    if (!waiver) return send(res, 404, { error: "Unknown waiver" });
    const approved = approveWaiver(waiver, user.name, Date.now());
    if (!approved.ok) return send(res, 400, approved);
    db().setWaiver(approved.waiver);
    const journey = db().journeys().find((row) => row.id === waiver.journeyId);
    db().addAudit({
      at: Date.now(),
      actor: user.name,
      action: "approval",
      detail: `${journey?.title || waiver.journeyId} approved`,
    });
    return send(res, 200, workspace(user));
  }
  if (req.method === "POST" && url.pathname === "/api/probe") {
    const result = await runLiveCheck(checkoutUrl, launchBrowser);
    const probe: Journey = {
      id: "checkout-probe",
      serviceId: "checkout",
      title: "Checkout probe: place order",
      severity: "sev-2",
      status: result.status === "passed" ? "passed" : "failed",
      critical: true,
      weeklyUsers: 2_400_000,
      owner: "Jonah Adeyemi",
      durationMs: result.durationMs,
      expected: "Order confirmed",
      actual: result.status === "passed" ? "Order confirmed" : result.error,
      error: result.error,
    };
    db().saveProbe(probe);
    db().addAudit({
      at: Date.now(),
      actor: user.name,
      action: "probe",
      detail: result.status === "passed" ? "Checkout probe passed" : "Checkout probe failed",
    });
    return send(res, result.status === "passed" ? 200 : 422, workspace(user));
  }
  return send(res, 404, { error: "not found" });
}

export function listen(port = 0, host = process.env.HOST || "127.0.0.1") {
  const password = process.env.QUALITY_DEMO_PASSWORD || "northwind-local";
  const allowed = bindAllowed(host, password);
  if (!allowed.ok) return Promise.reject(new Error(allowed.error));
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : "server error" });
    });
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolveListen) => {
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolveListen({
        port: bound,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const startedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (startedAsMain) {
  const envFile = join(root, "..", ".env");
  if (existsSync(envFile)) applyDotEnv(process.env, readFileSync(envFile, "utf8"));
  const port = Number(process.env.PORT || 4321);
  listen(port).then(
    (running) => {
      console.log(`Northwind Quality http://${hostLabel()}:${running.port}`);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}

function hostLabel(): string {
  return process.env.HOST || "127.0.0.1";
}

export type { Store };
