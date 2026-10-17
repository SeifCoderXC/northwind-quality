import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "playwright";

test("a new captain can register and open the desk, and cannot become a director", async () => {
  process.env.QUALITY_DB = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
  process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
  const { listen } = await import("../src/server.ts");
  const running = await listen(0);
  const api = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
  try {
    const rejected = await api.post("/api/register", {
      data: { name: "Sam Rivera", username: "sam", password: "short", role: "director" },
    });
    assert.equal(rejected.status(), 400);

    const created = await api.post("/api/register", {
      data: { name: "Sam Rivera", username: "Sam-R", password: "northwind-local", role: "director" },
    });
    assert.equal(created.status(), 400);
    assert.match((await created.json()).error, /invite/);

    const captain = await api.post("/api/register", {
      data: { name: "Sam Rivera", username: "Sam-R", password: "northwind-local" },
    });
    assert.equal(captain.status(), 201);
    assert.equal((await captain.json()).role, "captain");

    const desk = await api.get("/api/workspace");
    assert.equal(desk.status(), 200);
    assert.equal((await desk.json()).actor.role, "captain");

    const taken = await api.post("/api/register", {
      data: { name: "Other Person", username: "sam-r", password: "another-pass" },
    });
    assert.equal(taken.status(), 409);

    const weak = await api.post("/api/password", { data: { current: "northwind-local", next: "short" } });
    assert.equal(weak.status(), 400);
    const changed = await api.post("/api/password", { data: { current: "northwind-local", next: "a-longer-secret" } });
    assert.equal(changed.status(), 200);
    await api.post("/api/logout");
    assert.equal((await api.post("/api/login", { data: { username: "sam-r", password: "northwind-local" } })).status(), 401);
    assert.equal((await api.post("/api/login", { data: { username: "sam-r", password: "a-longer-secret" } })).status(), 200);
    assert.equal((await api.post("/api/invites")).status(), 403);

    const director = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
    const signedIn = await director.post("/api/login", { data: { username: "okonkwo", password: "northwind-local" } });
    assert.equal(signedIn.status(), 200);
    const invite = await director.post("/api/invites");
    assert.equal(invite.status(), 201);
    const code = (await invite.json()).code;
    assert.equal(typeof code, "string");
    assert.ok(code.length >= 20);
    const appointed = await director.post("/api/register", {
      data: { name: "Nora Hale", username: "nora", password: "northwind-local", invite: code },
    });
    assert.equal(appointed.status(), 201);
    assert.equal((await appointed.json()).role, "director");
    const reused = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
    const again = await reused.post("/api/register", {
      data: { name: "Other Hale", username: "otherh", password: "northwind-local", invite: code },
    });
    assert.equal(again.status(), 400);
    await director.dispose();
    await reused.dispose();
  } finally {
    await api.dispose();
    await running.close();
  }
});
