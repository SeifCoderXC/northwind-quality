/** Northwind's release train. The rows are the critical journeys a promote decision uses. */

export const actor = { name: "A. Rahman", role: "Release captain" };

export const org = { name: "Northwind", product: "Quality", weeklyCustomers: 4_200_000 };

export const services = [
  { id: "identity", name: "Identity", team: "Platform Identity", owner: "Mina Chen", weeklyUsers: 12_400_000, slo: 99.95 },
  { id: "checkout", name: "Checkout", team: "Commerce", owner: "Jonah Adeyemi", weeklyUsers: 2_400_000, slo: 99.9 },
  { id: "search", name: "Search", team: "Discovery", owner: "Priya Shah", weeklyUsers: 18_600_000, slo: 99.9 },
  { id: "payments", name: "Payments", team: "Payments", owner: "Luis Ortega", weeklyUsers: 2_100_000, slo: 99.99 },
];

export const release = {
  id: "2026.10.2",
  trainTests: 14203,
  opened: "2026-10-10",
};

/** Catalog size is a list length. It is not a count of executed tests. */
export function gateNote(releaseInfo, journeyRows) {
  const rows = Array.isArray(journeyRows) ? journeyRows : [];
  const scored = rows.filter((journey) => ["passed", "failed", "flaky"].includes(journey.status)).length;
  const catalogSize = Number(releaseInfo?.catalogSize ?? releaseInfo?.trainTests ?? 0);
  const listed = catalogSize.toLocaleString("en-US");
  return `${scored} journeys are scored for this gate. The catalog lists ${listed} cases. Those catalog cases were not executed for this decision.`;
}

function journey(id, serviceId, title, severity, status, critical, weeklyUsers, owner, durationMs, error = null, expected = null, actual = null) {
  return { id, serviceId, title, severity, status, critical, weeklyUsers, owner, durationMs, error, expected, actual };
}

export const journeys = [
  journey("password-sign-in", "identity", "Password sign-in", "sev-2", "passed", true, 12_400_000, "Mina Chen", 820),
  journey("mfa-challenge", "identity", "MFA challenge", "sev-2", "flaky", true, 3_100_000, "Mina Chen", 2400, "The first challenge timed out. The retry passed."),
  journey("session-refresh", "identity", "Session refresh", "sev-2", "passed", true, 12_400_000, "Mina Chen", 310),
  journey("account-recovery", "identity", "Account recovery email", "sev-2", "passed", true, 180_000, "Mina Chen", 990),
  journey("sso-callback", "identity", "SSO callback", "sev-1", "passed", true, 1_200_000, "Mina Chen", 1400),
  journey("reset-rate-limit", "identity", "Reset rate limit", "sev-3", "passed", false, 40_000, "Mina Chen", 220),

  journey("guest-cart-total", "checkout", "Guest cart total", "sev-1", "failed", true, 2_400_000, "Jonah Adeyemi", 1840, "Expected $48.00 but the total showed $0.00.", "$48.00", "$0.00"),
  journey("coupon", "checkout", "Coupon reduces the total", "sev-2", "passed", true, 640_000, "Jonah Adeyemi", 920),
  journey("address", "checkout", "Address validation", "sev-2", "passed", true, 2_100_000, "Jonah Adeyemi", 760),
  journey("shipping", "checkout", "Shipping method", "sev-2", "passed", true, 2_100_000, "Jonah Adeyemi", 680),
  journey("confirmation", "checkout", "Order confirmation number", "sev-1", "passed", true, 2_400_000, "Jonah Adeyemi", 1100),
  journey("quantity", "checkout", "Quantity updates the line", "sev-3", "passed", true, 900_000, "Jonah Adeyemi", 540),

  journey("known-sku", "search", "Search finds a known SKU", "sev-2", "passed", true, 18_600_000, "Priya Shah", 640),
  journey("empty-query", "search", "Empty search asks for a term", "sev-3", "passed", false, 1_200_000, "Priya Shah", 410),
  journey("typo-tolerance", "search", "Typo tolerance", "sev-3", "failed", false, 4_000_000, "Priya Shah", 1500, "Suggestions omitted the top SKU for a one-character typo.", "Top SKU appears in suggestions", "Top SKU omitted"),
  journey("filters", "search", "Facet filters stay in the URL", "sev-2", "passed", true, 6_200_000, "Priya Shah", 880),
  journey("typeahead", "search", "Typeahead returns in budget", "sev-2", "passed", true, 9_000_000, "Priya Shah", 510),

  journey("charge-answers", "payments", "Charge endpoint answers", "sev-1", "failed", true, 2_100_000, "Luis Ortega", 8004, "net::ERR_CONNECTION_TIMED_OUT at the charge endpoint.", "HTTP 200 from the charge endpoint", "Connection timed out"),
  journey("refund", "payments", "Refund lands on the order", "sev-2", "passed", true, 80_000, "Luis Ortega", 1200),
  journey("three-ds", "payments", "3-D Secure challenge", "sev-1", "passed", true, 700_000, "Luis Ortega", 2300),
  journey("wallet", "payments", "Wallet charge", "sev-2", "passed", true, 400_000, "Luis Ortega", 640),
  journey("idempotency", "payments", "Idempotency key is stable", "sev-1", "passed", true, 2_100_000, "Luis Ortega", 430),
  journey("timeout-retry", "payments", "Timeout retries once", "sev-2", "passed", true, 2_100_000, "Luis Ortega", 980),
];
