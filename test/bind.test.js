import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindAllowed } from "../src/bind.js";

test("a public bind with the demo password is refused", () => {
  const refused = bindAllowed("0.0.0.0", "northwind-local");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /local default/);
  assert.equal(bindAllowed("127.0.0.1", "northwind-local").ok, true);
  assert.equal(bindAllowed("0.0.0.0", "a-real-desk-secret").ok, true);
  assert.equal(bindAllowed("::1", "").ok, true);
});

test("listen does not open a public port while the demo password is unchanged", async () => {
  process.env.QUALITY_DB = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
  process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
  const { listen } = await import("../src/server.ts");
  await assert.rejects(() => listen(0, "0.0.0.0"), /local default/);
});
