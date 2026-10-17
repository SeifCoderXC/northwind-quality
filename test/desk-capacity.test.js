import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { request } from "playwright";

process.env.QUALITY_DB = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
process.env.QUALITY_LOGIN_WINDOW_MS = "5000";
process.env.QUALITY_IDLE_MS = String(30 * 60 * 1000);

describe("release desk capacity", { concurrency: 1 }, () => {
  let running;
  let api;

  before(async () => {
    const { listen } = await import("../src/server.ts");
    running = await listen(0);
    api = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
  });

  after(async () => {
    await api?.dispose();
    await running?.close();
  });

  test("the desk shell does not wait on a third-party font and static files revalidate", async () => {
    const home = await api.get("/");
    assert.equal(home.status(), 200);
    assert.equal(home.headers()["cache-control"], "no-store");
    assert.match(home.headers()["content-security-policy"], /default-src 'self'/);
    assert.equal(home.headers()["x-content-type-options"], "nosniff");
    assert.doesNotMatch(await home.text(), /fonts\.googleapis\.com/);
    const css = await api.get("/app.css");
    assert.equal(css.status(), 200);
    assert.equal(css.headers()["cache-control"], "no-cache");
    const etag = css.headers().etag;
    assert.ok(etag);
    const again = await api.get("/app.css", { headers: { "if-none-match": etag } });
    assert.equal(again.status(), 304);
    assert.equal(await again.text(), "");
  });

  test("a request body that is not JSON is rejected", async () => {
    const bad = await fetch(`http://127.0.0.1:${running.port}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not JSON/);
  });

  test("the workspace carries the newest audit page and older rows stay available", async () => {
    for (let i = 0; i < 45; i += 1) {
      const signed = await api.post("/api/login", { data: { username: "rahman", password: "northwind-local" } });
      assert.equal(signed.status(), 200);
    }
    const desk = await (await api.get("/api/workspace")).json();
    assert.equal(desk.audit.length, 40);
    assert.equal(desk.auditPage.limit, 40);
    assert.equal(desk.auditPage.hasMore, true);
    const ids = desk.audit.map((row) => row.id);
    assert.deepEqual(ids, [...ids].sort((left, right) => right - left));
    assert.equal(desk.auditPage.nextBefore, ids[ids.length - 1]);
    const older = await (await api.get(`/api/audit?before=${desk.auditPage.nextBefore}`)).json();
    const olderIds = older.audit.map((row) => row.id);
    assert.ok(olderIds.length > 0);
    assert.equal(olderIds.some((id) => ids.includes(id)), false);
    assert.equal(older.auditPage.hasMore, false);
    assert.equal(ids.length + olderIds.length, 45);
  });

  test("five rejected passwords lock the next attempt until the window passes", async () => {
    for (let i = 0; i < 5; i += 1) {
      const rejected = await api.post("/api/login", { data: { username: "rahman", password: "nope" } });
      assert.equal(rejected.status(), 401);
    }
    const locked = await api.post("/api/login", { data: { username: "rahman", password: "northwind-local" } });
    assert.equal(locked.status(), 429);
    assert.match((await locked.json()).error, /too many/i);
    await new Promise((resolve) => setTimeout(resolve, 5200));
    const opened = await api.post("/api/login", { data: { username: "rahman", password: "northwind-local" } });
    assert.equal(opened.status(), 200);
  });
});
