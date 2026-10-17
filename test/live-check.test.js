import assert from "node:assert/strict";
import { test } from "node:test";
import { launchBrowser, runLiveCheck } from "../src/live-check.js";

const pageUrl = new URL("../src/public/checkout.html", import.meta.url).href;
const launch = () => launchBrowser();

test("the live check places an order and records a pass", async () => {
  const result = await runLiveCheck(pageUrl, launch);
  assert.equal(result.status, "passed");
  assert.equal(result.title, "Live check: place order");
  assert.equal(result.error, null);
  assert.ok(result.durationMs >= 0);
});
