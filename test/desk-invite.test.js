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

test("a director issues an invite from Account and the new person becomes a director", { timeout: 60_000 }, async () => {
  process.env.QUALITY_DB = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
  process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
  process.env.QUALITY_IDLE_MS = String(30 * 60 * 1000);
  const { listen } = await import("../src/server.ts");
  const running = await listen(0);
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  try {
    await page.goto(`http://127.0.0.1:${running.port}/`);
    await page.getByLabel("Username").fill("okonkwo");
    await page.getByLabel("Password").fill("northwind-local");
    await page.locator('form button[type="submit"]').click();
    await page.getByRole("heading", { name: "Overview" }).waitFor();
    await page.getByRole("link", { name: "Account" }).click();
    await page.getByRole("button", { name: "Issue a 24-hour director invite" }).click();
    const issued = page.getByText(/Invite code [0-9a-f]{64}/);
    await issued.waitFor();
    const code = (await issued.textContent()).match(/[0-9a-f]{64}/)[0];
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Nia Okonkwo");
    await page.getByLabel("Director invite").fill(code);
    await page.getByLabel("Username").fill("niaoko");
    await page.getByLabel("Password").fill("harbor-director-pass");
    await page.locator('form button[type="submit"]').click();
    await page.getByRole("heading", { name: "Overview" }).waitFor();
    await page.getByRole("link", { name: "Account" }).click();
    await page.getByText("Role: director").waitFor();
    assert.equal(await page.getByRole("button", { name: "Issue a 24-hour director invite" }).count(), 1);
  } finally {
    await browser.close();
    await running.close();
  }
});
