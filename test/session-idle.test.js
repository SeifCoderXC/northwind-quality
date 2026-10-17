import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "playwright";
import { openDb } from "../src/db.ts";

const idle = 30 * 60 * 1000;

test("a session idle for more than 30 minutes is closed and a fresh one is kept", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite"), "northwind-local");
  const user = db.userByUsername("rahman");
  const now = Date.parse("2026-10-12T12:00:00Z");
  db.createSession(user.id, "fresh", now + 12 * 60 * 60 * 1000, now);
  db.createSession(user.id, "stale", now + 12 * 60 * 60 * 1000, now - idle - 1);
  assert.equal(db.takeSession("fresh", now, idle).status, "ok");
  assert.equal(db.takeSession("stale", now, idle).status, "idle");
  assert.equal(db.takeSession("stale", now, idle).status, "idle");
  db.deleteSession("stale");
  assert.equal(db.takeSession("stale", now, idle).status, "missing");
  db.createSession(user.id, "old", now - 1, now - 1);
  assert.equal(db.takeSession("old", now, idle).status, "expired");
  assert.equal(db.takeSession("old", now, idle).status, "expired");
  assert.equal(db.takeSession("fresh", now + 1000, idle).user.username, "rahman");
});

test("the API reports an idle session instead of a bad password", async () => {
  process.env.QUALITY_DB = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
  process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
  process.env.QUALITY_IDLE_MS = "400";
  const { listen } = await import("../src/server.ts");
  const running = await listen(0);
  const api = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
  try {
    const signed = await api.post("/api/login", { data: { username: "rahman", password: "northwind-local" } });
    assert.equal(signed.status(), 200);
    assert.equal((await api.get("/api/workspace")).status(), 200);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const idle = await api.get("/api/workspace");
    assert.equal(idle.status(), 401);
    assert.match((await idle.json()).error, /timed out/);
    const again = await api.get("/api/workspace");
    assert.equal(again.status(), 401);
    assert.match((await again.json()).error, /timed out/);
  } finally {
    await api.dispose();
    await running.close();
  }
});
