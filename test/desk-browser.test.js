import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

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

test("an idle session returns to sign-in and an empty filter says so", { timeout: 60_000 }, async () => {
  process.env.QUALITY_DB = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
  process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
  process.env.QUALITY_IDLE_MS = "400";
  const { listen } = await import("../src/server.ts");
  const running = await listen(0);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${running.port}/`);
    await page.getByLabel("Username").fill("rahman");
    await page.getByLabel("Password").fill("northwind-local");
    await page.locator('form button[type="submit"]').click();
    await page.getByRole("heading", { name: "Overview" }).waitFor();
    await page.getByRole("link", { name: "Release" }).click();
    await page.getByLabel("Filter journeys").fill("zzzz-no-such-journey");
    await page.getByText("No journeys match this filter.").waitFor();
    await page.waitForTimeout(1000);
    const probeStatus = new Promise((resolve) => {
      page.on("response", async (res) => {
        if (!res.url().endsWith("/api/probe")) return;
        const body = await res.json().catch(() => ({}));
        resolve({ status: res.status(), error: body.error || "" });
      });
    });
    await page.getByRole("button", { name: "Run checkout probe" }).click();
    const status = await Promise.race([
      probeStatus,
      new Promise((resolve) => setTimeout(() => resolve({ status: "no-response", error: "" }), 5000)),
    ]);
    assert.equal(status.status, 401, JSON.stringify(status));
    assert.match(status.error, /timed out/);
    await page.getByText("The session timed out.").waitFor();
    await page.getByRole("heading", { name: "Northwind Quality" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Overview" }).count(), 0);
  } finally {
    await browser?.close();
    await running.close();
  }
});
