import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { chromium, request } from "playwright";

const token = "desk-test-token-value";
const dbPath = join(mkdtempSync(join(tmpdir(), "quality-")), "quality.sqlite");
process.env.QUALITY_DB = dbPath;
process.env.QUALITY_DEMO_PASSWORD = "northwind-local";
process.env.QUALITY_IDLE_MS = String(30 * 60 * 1000);
process.env.JIRA_BASE_URL = "http://127.0.0.1:9";
process.env.JIRA_EMAIL = "qa@northwind.test";
process.env.JIRA_TOKEN = token;
process.env.JIRA_PROJECT = "NQ";

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

test("a dead Jira host leaves the desk up and the defect key opens its browse url", { timeout: 60_000 }, async () => {
  const { listen } = await import("../src/server.ts");
  const running = await listen(0);
  const api = await request.newContext({ baseURL: `http://127.0.0.1:${running.port}` });
  let browser;
  try {
    const login = await api.post("/api/login", { data: { username: "okonkwo", password: "northwind-local" } });
    assert.equal(login.status(), 200);
    assert.equal((await api.get("/api/workspace")).status(), 200);
    const response = await api.get("/api/workspace");
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.equal(body.jira, true);
    assert.equal(body.jiraBrowse, "http://127.0.0.1:9/browse");
    assert.equal(JSON.stringify(body).includes(token), false);
    const guest = body.defects.find((row) => row.journeyId === "guest-cart-total");
    assert.equal(guest.status, "queued");
    assert.equal(guest.jiraKey, null);

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("UPDATE jira_outbox SET status = 'pushed', jira_key = 'NQ-1' WHERE journey_id = 'guest-cart-total'").run();
    db.close();

    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${running.port}/`);
    await page.getByLabel("Username").fill("okonkwo");
    await page.getByLabel("Password").fill("northwind-local");
    await page.locator('form button[type="submit"]').click();
    await page.getByRole("link", { name: "Defects" }).click();
    const link = page.getByRole("link", { name: "NQ-1" });
    await link.waitFor();
    assert.equal(await link.getAttribute("href"), "http://127.0.0.1:9/browse/NQ-1");
    assert.equal((await page.locator("body").innerText()).includes(token), false);
  } finally {
    await browser?.close();
    await api.dispose();
    await running.close();
  }
});
