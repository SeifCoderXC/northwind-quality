const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** A desk reachable off this machine cannot keep the seeded password. */
export function bindAllowed(host, password) {
  const normalized = String(host || "").replace(/^\[|\]$/g, "");
  if (LOOPBACK.has(normalized)) return { ok: true };
  if (!password || password === "northwind-local") {
    return { ok: false, error: "Refusing a public bind while QUALITY_DEMO_PASSWORD is the local default." };
  }
  return { ok: true };
}
