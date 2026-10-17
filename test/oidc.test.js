import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, request } from "playwright";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { openDb } from "../src/db.ts";
import {
  beginDirectoryLogin,
  directoryUsername,
  oidcConfigured,
  roleFromGroups,
  verifyIdToken,
} from "../src/oidc.ts";

const secret = "local-test-secret-value";

test("directory sign-in stays off until the issuer is https and the secret is long", () => {
  assert.equal(oidcConfigured({}), false);
  assert.equal(
    oidcConfigured({
      OIDC_ISSUER_URL: "http://login.northwind-demo.example.com",
      OIDC_CLIENT_ID: "desk",
      OIDC_CLIENT_SECRET: secret,
      OIDC_GROUP_CLAIM: "groups",
      OIDC_DIRECTOR_GROUP: "northwind-directors",
    }),
    false,
  );
  assert.equal(
    oidcConfigured({
      OIDC_ISSUER_URL: "https://login.northwind-demo.example.com/",
      OIDC_CLIENT_ID: "desk",
      OIDC_CLIENT_SECRET: "short",
      OIDC_GROUP_CLAIM: "groups",
      OIDC_DIRECTOR_GROUP: "northwind-directors",
    }),
    false,
  );
  assert.equal(
    oidcConfigured({
      OIDC_ISSUER_URL: "https://login.northwind-demo.example.com/",
      OIDC_CLIENT_ID: "desk",
      OIDC_CLIENT_SECRET: secret,
      OIDC_GROUP_CLAIM: "groups",
      OIDC_DIRECTOR_GROUP: "northwind-directors",
    }),
    true,
  );
});

test("a directory user is not a local username and the director group sets the role", () => {
  const username = directoryUsername("https://login.northwind-demo.example.com", "person-1");
  assert.equal(username, directoryUsername("https://login.northwind-demo.example.com", "person-1"));
  assert.notEqual(username, "okonkwo");
  assert.match(username, /^d[a-f0-9]{20}$/);
  assert.equal(roleFromGroups(["northwind-directors"], "northwind-directors").role, "director");
  assert.equal(roleFromGroups(["northwind-captains"], "northwind-directors").role, "captain");
  assert.equal(roleFromGroups("northwind-directors", "northwind-directors").ok, false);
});

test("an ID token with a bad signature or the wrong nonce is refused", () => {
  const { publicKey, token } = signedToken({ nonce: "nonce-1", exp: 2_000 });
  const jwks = { keys: [publicKey.export({ format: "jwk" })] };
  jwks.keys[0].kid = "test-key";
  jwks.keys[0].alg = "RS256";
  const good = verifyIdToken(token, jwks, {
    issuer: "https://login.northwind-demo.example.com",
    audience: "desk",
    nonce: "nonce-1",
    now: 1_000,
  });
  assert.equal(good.ok, true);
  const wrongNonce = verifyIdToken(token, jwks, {
    issuer: "https://login.northwind-demo.example.com",
    audience: "desk",
    nonce: "other",
    now: 1_000,
  });
  assert.equal(wrongNonce.ok, false);
  const tampered = `${token.slice(0, -2)}aa`;
  assert.equal(
    verifyIdToken(tampered, jwks, {
      issuer: "https://login.northwind-demo.example.com",
      audience: "desk",
      nonce: "nonce-1",
      now: 1_000,
    }).ok,
    false,
  );
});

test("a directory state is single use and an expired one is refused", () => {
  const store = openDb(join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite"), "northwind-local");
  store.saveOidcState({ state: "once", nonce: "n", verifier: "v", expiresAt: 50 });
  assert.equal(store.takeOidcState("once", 40)?.nonce, "n");
  assert.equal(store.takeOidcState("once", 40), undefined);
  store.saveOidcState({ state: "old", nonce: "n", verifier: "v", expiresAt: 10 });
  assert.equal(store.takeOidcState("old", 10), undefined);
});

test("an unreachable directory does not start a sign-in", async () => {
  const result = await beginDirectoryLogin(
    {
      OIDC_ISSUER_URL: "http://127.0.0.1:9",
      OIDC_CLIENT_ID: "desk",
      OIDC_CLIENT_SECRET: secret,
      OIDC_GROUP_CLAIM: "groups",
      OIDC_DIRECTOR_GROUP: "northwind-directors",
    },
    "http://127.0.0.1:4321/api/oidc/callback",
    fetch,
    1_000,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "The directory is not reachable.");
});

function signedToken({ nonce, exp, groups = ["northwind-directors"], sub = "person-1" }) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "https://login.northwind-demo.example.com",
      aud: "desk",
      sub,
      nonce,
      exp,
      name: "Mina Chen",
      groups,
    }),
  ).toString("base64url");
  const data = `${header}.${body}`;
  const signature = createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url");
  return { publicKey, token: `${data}.${signature}` };
}

test("the desk signs in a director through a local directory and refuses a bad token", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = keys.publicKey.export({ format: "jwk" });
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  let groups = ["northwind-directors"];
  let signWith = keys.privateKey;
  let codeNumber = 0;
  const codes = new Map();
  const idp = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/.well-known/openid-configuration") {
      const origin = `http://127.0.0.1:${idp.address().port}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
      }));
      return;
    }
    if (url.pathname === "/authorize") {
      const code = `code-${++codeNumber}`;
      codes.set(code, { nonce: url.searchParams.get("nonce"), redirect: url.searchParams.get("redirect_uri") });
      res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}` });
      res.end();
      return;
    }
    if (url.pathname === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === "/token") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        assert.equal(body.includes("client_secret"), false);
        const code = new URLSearchParams(body).get("code");
        const saved = codes.get(code);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({
          iss: `http://127.0.0.1:${idp.address().port}`,
          aud: "desk",
          sub: "person-1",
          nonce: saved.nonce,
          exp: Math.floor(Date.now() / 1000) + 300,
          name: "Mina Chen",
          groups,
        })).toString("base64url");
        const data = `${header}.${payload}`;
        const signature = createSign("RSA-SHA256").update(data).sign(signWith).toString("base64url");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id_token: `${data}.${signature}` }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${idp.address().port}`;
  const previous = saveEnv([
    "QUALITY_DB",
    "QUALITY_DEMO_PASSWORD",
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_GROUP_CLAIM",
    "OIDC_DIRECTOR_GROUP",
  ]);
  process.env.QUALITY_DB = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
  process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
  process.env.OIDC_ISSUER_URL = issuer;
  process.env.OIDC_CLIENT_ID = "desk";
  process.env.OIDC_CLIENT_SECRET = secret;
  process.env.OIDC_GROUP_CLAIM = "groups";
  process.env.OIDC_DIRECTOR_GROUP = "northwind-directors";
  const { listen } = await import("../src/server.ts");
  const running = await listen(0);
  const api = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
  try {
    const anon = await api.get("/api/session");
    assert.equal(anon.status(), 401);
    assert.equal((await anon.json()).directory, true);
    const start = await api.get("/api/oidc/start", { maxRedirects: 0 });
    assert.equal(start.status(), 302);
    const location = start.headers().location;
    assert.match(location, new RegExp(`^${issuer}/authorize`));
    assert.match(location, /code_challenge=/);
    assert.doesNotMatch(location, /client_secret/);
    const authorize = await api.get(location, { maxRedirects: 0 });
    const callback = await api.get(authorize.headers().location, { maxRedirects: 0 });
    assert.equal(callback.status(), 302);
    assert.equal(new URL(callback.headers().location, `http://127.0.0.1:${running.port}`).pathname, "/");
    const desk = await (await api.get("/api/workspace")).json();
    assert.equal(desk.actor.name, "Mina Chen");
    assert.equal(desk.actor.role, "director");
    const replay = await api.get(authorize.headers().location, { maxRedirects: 0 });
    assert.equal(new URL(replay.headers().location, `http://127.0.0.1:${running.port}`).searchParams.get("directory"), "mismatch");

    groups = ["northwind-captains"];
    const captainApi = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
    const captainStart = await captainApi.get("/api/oidc/start", { maxRedirects: 0 });
    const captainAuthorize = await captainApi.get(captainStart.headers().location, { maxRedirects: 0 });
    await captainApi.get(captainAuthorize.headers().location, { maxRedirects: 0 });
    const captain = await (await captainApi.get("/api/workspace")).json();
    assert.equal(captain.actor.role, "captain");
    await captainApi.dispose();

    signWith = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const badApi = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
    const badStart = await badApi.get("/api/oidc/start", { maxRedirects: 0 });
    const badAuthorize = await badApi.get(badStart.headers().location, { maxRedirects: 0 });
    const badCallback = await badApi.get(badAuthorize.headers().location, { maxRedirects: 0 });
    assert.equal(new URL(badCallback.headers().location, `http://127.0.0.1:${running.port}`).searchParams.get("directory"), "rejected");
    assert.equal((await badApi.get("/api/workspace")).status(), 401);
    await badApi.dispose();

    groups = ["northwind-directors"];
    signWith = keys.privateKey;
    const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(`http://127.0.0.1:${running.port}/`);
      await page.getByRole("link", { name: "Sign in with your directory" }).click();
      await page.getByRole("heading", { name: "Overview" }).waitFor();
      await page.getByText("Mina Chen · director").waitFor();
    } finally {
      await browser.close();
    }
  } finally {
    await api.dispose();
    await running.close();
    await new Promise((resolve) => idp.close(resolve));
    restoreEnv(previous);
  }
});

function chromiumExecutable() {
  const expected = chromium.executablePath();
  if (existsSync(expected)) return expected;
  const root = join(process.env.HOME || "", ".cache", "ms-playwright");
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith("chromium-")) continue;
    for (const relative of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const candidate = join(root, dir, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return expected;
}

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
