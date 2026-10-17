import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, request } from "playwright";
import { DIRECTORY_PASSWORD, startLocalDirectory } from "../src/local-directory.ts";
import { directoryUsername, verifyIdToken } from "../src/oidc.ts";
import { openDb } from "../src/db.ts";

const secret = "local-test-secret-value";

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

function authorizeUrl(issuer, { redirect, nonce, challenge }) {
  const url = new URL("/authorize", issuer);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "desk");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", randomBytes(16).toString("hex"));
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

test("the local directory refuses a public bind and a weak client secret", async () => {
  await assert.rejects(
    () => startLocalDirectory({ host: "0.0.0.0", clientId: "desk", clientSecret: secret }),
    /loopback only/,
  );
  await assert.rejects(
    () => startLocalDirectory({ clientId: "desk", clientSecret: "directory-local" }),
    /client secret/,
  );
});

test("the local directory signs the desk in and keeps a bad token closed", async () => {
  assert.equal(DIRECTORY_PASSWORD, "directory-local");
  const directory = await startLocalDirectory({ clientId: "desk", clientSecret: secret });
  const previous = saveEnv([
    "QUALITY_DB",
    "QUALITY_DEMO_PASSWORD",
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_GROUP_CLAIM",
    "OIDC_DIRECTOR_GROUP",
  ]);
  const dbFile = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
  process.env.QUALITY_DB = dbFile;
  process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
  process.env.OIDC_ISSUER_URL = directory.issuer;
  process.env.OIDC_CLIENT_ID = "desk";
  process.env.OIDC_CLIENT_SECRET = secret;
  process.env.OIDC_GROUP_CLAIM = "groups";
  process.env.OIDC_DIRECTOR_GROUP = "northwind-directors";
  const { listen } = await import("../src/server.ts");
  const running = await listen(0);
  const desk = `http://127.0.0.1:${running.port}`;
  try {
    const direct = await request.newContext();
    const discovery = await (await direct.get(`${directory.issuer}/.well-known/openid-configuration`)).json();
    assert.equal(discovery.issuer, directory.issuer);
    assert.equal(new URL(discovery.authorization_endpoint).origin, directory.issuer);
    const evil = authorizeUrl(directory.issuer, {
      redirect: "https://evil.example/api/oidc/callback",
      nonce: randomBytes(16).toString("hex"),
      challenge: "a".repeat(43),
    });
    evil.searchParams.set("client_secret", secret);
    const refused = await direct.get(evil.toString(), { maxRedirects: 0 });
    assert.equal(refused.status(), 400);
    assert.equal(refused.headers().location, undefined);
    assert.equal((await refused.text()).includes(secret), false);

    const redirect = "http://127.0.0.1:9/api/oidc/callback";
    const verifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(16).toString("hex");
    const form = await direct.get(authorizeUrl(directory.issuer, {
      redirect,
      nonce,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString());
    assert.equal(form.status(), 200);
    assert.equal((await form.text()).includes(secret), false);
    const signed = await direct.post(`${directory.issuer}/session`, {
      form: { username: "mchen", password: DIRECTORY_PASSWORD },
      maxRedirects: 0,
    });
    assert.equal(signed.status(), 302);
    const code = new URL(signed.headers().location).searchParams.get("code");
    const basic = Buffer.from(`desk:${secret}`).toString("base64");
    const body = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: "desk",
      code_verifier: verifier,
    };
    const token = await direct.post(`${directory.issuer}/token`, {
      headers: { authorization: `Basic ${basic}` },
      form: body,
    });
    assert.equal(token.status(), 200);
    const jwks = await (await direct.get(`${directory.issuer}/jwks`)).json();
    const verified = verifyIdToken((await token.json()).id_token, jwks, {
      issuer: directory.issuer,
      audience: "desk",
      nonce,
      now: Date.now(),
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.claims.sub, "mchen");
    assert.equal(verified.claims.name, "Mina Chen");
    assert.deepEqual(verified.claims.groups, ["northwind-directors"]);
    assert.equal((await direct.post(`${directory.issuer}/token`, {
      headers: { authorization: `Basic ${basic}` },
      form: body,
    })).status(), 400);

    const second = randomBytes(32).toString("base64url");
    const secondNonce = randomBytes(16).toString("hex");
    assert.equal((await direct.get(authorizeUrl(directory.issuer, {
      redirect,
      nonce: secondNonce,
      challenge: createHash("sha256").update(second).digest("base64url"),
    }).toString())).status(), 200);
    const secondLogin = await direct.post(`${directory.issuer}/session`, {
      form: { username: "mchen", password: DIRECTORY_PASSWORD },
      maxRedirects: 0,
    });
    const secondCode = new URL(secondLogin.headers().location).searchParams.get("code");
    const burned = await direct.post(`${directory.issuer}/token`, {
      headers: { authorization: `Basic ${Buffer.from("desk:wrong-secret-value-here").toString("base64")}` },
      form: {
        grant_type: "authorization_code",
        code: secondCode,
        redirect_uri: redirect,
        client_id: "desk",
        code_verifier: second,
        client_secret: secret,
      },
    });
    assert.equal(burned.status(), 401);
    assert.equal((await direct.post(`${directory.issuer}/token`, {
      headers: { authorization: `Basic ${basic}` },
      form: {
        grant_type: "authorization_code",
        code: secondCode,
        redirect_uri: redirect,
        client_id: "desk",
        code_verifier: second,
      },
    })).status(), 400);
    await direct.dispose();

    const director = await signThrough(desk, "mchen", DIRECTORY_PASSWORD);
    assert.equal(director.workspace.actor.name, "Mina Chen");
    assert.equal(director.workspace.actor.role, "director");
    await director.api.dispose();
    const stored = openDb(dbFile, "northwind-local");
    const expectedName = directoryUsername(directory.issuer, "mchen");
    const row = stored.db.prepare("SELECT username, role FROM users WHERE username = ?").get(expectedName);
    assert.equal(row.username, expectedName);
    assert.equal(row.role, "director");
    assert.equal(stored.db.prepare("SELECT username FROM users WHERE username = ?").get(expectedName).username === "okonkwo", false);
    stored.db.close();

    const captain = await signThrough(desk, "lokoro", DIRECTORY_PASSWORD);
    assert.equal(captain.workspace.actor.name, "Leila Okoro");
    assert.equal(captain.workspace.actor.role, "captain");
    await captain.api.dispose();

    const missing = await signThrough(desk, "padebayo", DIRECTORY_PASSWORD);
    assert.equal(missing.callbackCode, "groups");
    assert.equal(missing.workspaceStatus, 401);
    await missing.api.dispose();

    const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(`${desk}/`);
      await page.getByRole("link", { name: "Sign in with your directory" }).click();
      await page.getByRole("heading", { name: "Directory" }).waitFor();
      assert.equal(await page.locator("details p").count(), 1);
      await page.getByLabel("Username").fill("mchen");
      await page.getByLabel("Password").fill(DIRECTORY_PASSWORD);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("heading", { name: "Overview" }).waitFor();
      await page.getByText("Mina Chen · director").waitFor();
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByRole("link", { name: "Sign in with your directory" }).waitFor();
    } finally {
      await browser.close();
    }

    const lockedClient = await request.newContext();
    const lockNonce = randomBytes(16).toString("hex");
    const lockVerifier = randomBytes(32).toString("base64url");
    assert.equal((await lockedClient.get(authorizeUrl(directory.issuer, {
      redirect,
      nonce: lockNonce,
      challenge: createHash("sha256").update(lockVerifier).digest("base64url"),
    }).toString())).status(), 200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await lockedClient.post(`${directory.issuer}/session`, {
        form: { username: "stranger", password: "not-the-password" },
        maxRedirects: 0,
      });
      assert.equal(wrong.status(), 401);
    }
    const locked = await lockedClient.post(`${directory.issuer}/session`, {
      form: { username: "stranger", password: DIRECTORY_PASSWORD },
      maxRedirects: 0,
    });
    assert.equal(locked.status(), 429);
    await lockedClient.dispose();
  } finally {
    await running.close();
    await directory.close();
    restoreEnv(previous);
  }
});

async function signThrough(desk, username, password) {
  const api = await request.newContext({ baseURL: desk });
  const start = await api.get("/api/oidc/start", { maxRedirects: 0 });
  assert.equal(start.status(), 302);
  assert.match(start.headers().location, /code_challenge=/);
  assert.doesNotMatch(start.headers().location, /client_secret/);
  const form = await api.get(start.headers().location);
  assert.equal(form.status(), 200);
  const posted = await api.post(`${new URL(start.headers().location).origin}/session`, {
    form: { username, password },
    maxRedirects: 0,
  });
  assert.equal(posted.status(), 302);
  const callback = await api.get(posted.headers().location, { maxRedirects: 0 });
  const callbackCode = new URL(callback.headers().location, desk).searchParams.get("directory");
  const workspaceResponse = await api.get("/api/workspace");
  return {
    api,
    callbackCode,
    workspaceStatus: workspaceResponse.status(),
    workspace: workspaceResponse.status() === 200 ? await workspaceResponse.json() : null,
  };
}
