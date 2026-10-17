import { chromium } from "playwright";

/** Prefer Playwright's browser. Fall back to the machine's Chrome. */
export async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

/**
 * Open the local checkout page, place an order, and record the result.
 * `launch` returns a Playwright browser.
 */
export async function runLiveCheck(pageUrl, launch) {
  const browser = await launch();
  const page = await browser.newPage();
  const started = Date.now();
  const result = {
    id: "live-order",
    title: "Live check: place order",
    status: "failed",
    durationMs: 0,
    error: null,
    classification: null,
    note: "",
  };
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.getByRole("button", { name: "Place order", exact: true }).click({ timeout: 8000 });
    await page.getByText("Order confirmed", { exact: false }).first().waitFor({
      state: "visible",
      timeout: 8000,
    });
    result.status = "passed";
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.durationMs = Date.now() - started;
    await browser.close();
  }
  return result;
}
