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

test("the desk states who must approve a waiver and what critical pass excludes", { timeout: 60_000 }, async () => {
  process.env.QUALITY_DB = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
  process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
  const { listen } = await import("../src/server.ts");
  const running = await listen(0);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${running.port}/`);
    await page.getByLabel("Username").fill("okonkwo");
    await page.getByLabel("Password").fill("northwind-local");
    await page.locator('form button[type="submit"]').click();
    await page.getByRole("heading", { name: "Overview" }).waitFor();
    await page.goto(`http://127.0.0.1:${running.port}/#/release`);
    await page.getByText("1 non-sev-1 failure over 1M sessions. 3 blocking journeys are over 1M sessions.").waitFor();
    await page.goto(`http://127.0.0.1:${running.port}/#/release/guest-cart-total`);
    await page.getByText("This waiver stays pending until a different director approves it.").waitFor();
    await page.goto(`http://127.0.0.1:${running.port}/#/services`);
    await page.getByText("100.0% · excludes Typo tolerance").waitFor();
    await page.getByRole("link", { name: "Waivers" }).click();
    await page.getByText("Sev-1 and million-session waivers cannot outlive 24 hours.").waitFor();
  } finally {
    await browser?.close();
    await running.close();
  }
});
