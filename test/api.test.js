import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "playwright";

const reason = "Processor timeout is outside this change. Holding the canary for 24 hours.";

test("the API requires a sign-in, then a director approves a sev-1 waiver", async () => {
  process.env.QUALITY_DB = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
  process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
  const { listen } = await import("../src/server.ts");
  const running = await listen(0);
  const api = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
  try {
    const health = await api.get("/api/health");
    assert.equal(health.status(), 200);
    assert.equal((await api.get("/api/workspace")).status(), 401);
    assert.equal((await api.post("/api/login", { data: { username: "rahman", password: "nope" } })).status(), 401);

    const captain = await api.post("/api/login", { data: { username: "rahman", password: "northwind-local" } });
    assert.equal(captain.status(), 200);
    const desk = await (await api.get("/api/workspace")).json();
    assert.match(desk.release.gateNote, /were not executed for this decision/);
    assert.equal(desk.release.catalogSize, 14203);
    assert.equal(desk.release.scoredJourneys, 23);
    assert.doesNotMatch(desk.release.gateNote, /tests ran/);
    assert.equal(desk.evaluation.decision, "blocked");
    assert.equal(desk.evaluation.impactUsers, 8_500_000);
    const reach = desk.evaluation.gates.find((gate) => gate.id === "reach");
    assert.match(reach.detail, /1 non-sev-1 failure over 1M sessions/);
    assert.match(reach.detail, /3 blocking journeys are over 1M sessions/);
    assert.equal(desk.evaluation.services.find((row) => row.id === "search").criticalPass, "100.0% · excludes Typo tolerance");
    assert.match(desk.journeys.find((row) => row.id === "guest-cart-total").waiverPrompt, /different director/);
    assert.match(desk.journeys.find((row) => row.id === "typo-tolerance").waiverPrompt, /different director/);
    assert.equal(desk.journeys.find((row) => row.id === "guest-cart-total").expected, "$48.00");
    assert.ok(desk.defects.length >= 3);
    assert.ok(desk.defects.every((row) => row.status === "queued"));
    assert.ok(desk.journeys.length >= 23);

    const rejected = await api.post("/api/waivers", { data: { journeyId: "guest-cart-total", reason: "too short", hours: 24 } });
    assert.equal(rejected.status(), 400);

    const filed = await api.post("/api/waivers", { data: { journeyId: "guest-cart-total", reason, hours: 24 } });
    assert.equal(filed.status(), 200);
    const pending = await filed.json();
    const waiver = pending.waivers.find((row) => row.journeyId === "guest-cart-total");
    assert.equal(waiver.status, "pending");
    assert.equal(pending.evaluation.blocking.some((row) => row.id === "guest-cart-total"), true);
    assert.equal((await api.post("/api/approvals", { data: { waiverId: waiver.id } })).status(), 403);

    const directorApi = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
    const director = await directorApi.post("/api/login", { data: { username: "okonkwo", password: "northwind-local" } });
    assert.equal(director.status(), 200);
    const approved = await directorApi.post("/api/approvals", { data: { waiverId: waiver.id } });
    assert.equal(approved.status(), 200);
    const after = await approved.json();
    assert.equal(after.evaluation.blocking.some((row) => row.id === "guest-cart-total"), false);
    assert.equal(after.audit.some((row) => row.action === "approval"), true);
    await directorApi.dispose();
  } finally {
    await api.dispose();
    await running.close();
  }
});
