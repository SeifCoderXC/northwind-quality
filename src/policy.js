const HOURS = new Set([4, 24, 72]);
const REACH = 1_000_000;

function overFlakeLimit(flaky, scored) {
  return scored > 0 && flaky * 100 > scored * 5;
}

function percentText(flaky, scored) {
  const scaled = Math.floor((flaky * 100000) / scored);
  const whole = Math.floor(scaled / 1000);
  const frac = String(scaled % 1000).padStart(3, "0");
  return `${whole}.${frac}`;
}

function flakeRelation(flaky, scored) {
  const left = flaky * 100;
  const right = scored * 5;
  if (left > right) return "above the 5% limit";
  if (left === right) return "at the 5% limit";
  return "within the 5% limit";
}

/** Three decimal places, truncated, plus the same integer comparison the gate uses. */
export function flakeDetail(flaky, scored) {
  if (!scored) return "0/0 · no scored critical journeys · limit 5%";
  return `${flaky}/${scored} · ${percentText(flaky, scored)}% · ${flakeRelation(flaky, scored)}`;
}

function activeWaiver(waivers, journeyId, now) {
  return waivers.find(
    (waiver) => waiver.journeyId === journeyId && waiver.expiresAt > now && waiver.status === "approved",
  );
}

function isBlocking(journey) {
  return (
    journey.status === "failed" &&
    (journey.critical || journey.severity === "sev-1" || journey.weeklyUsers >= REACH)
  );
}

function countPhrase(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The high-reach row must not say a sev-1 failure is under 1M sessions. */
function reachDetail(blocking) {
  const outside = blocking.filter((journey) => !journey.critical && journey.severity !== "sev-1");
  const over = blocking.filter((journey) => Number(journey.weeklyUsers) >= REACH);
  const outsideText =
    outside.length === 0
      ? "No non-sev-1 failure over 1M sessions"
      : `${countPhrase(outside.length, "non-sev-1 failure", "non-sev-1 failures")} over 1M sessions`;
  if (over.length === 0) return outsideText;
  const overText = `${countPhrase(over.length, "blocking journey is", "blocking journeys are")} over 1M sessions`;
  return `${outsideText}. ${overText}.`;
}

export function criticalPassLabel(journeys, blocking) {
  const rows = (Array.isArray(journeys) ? journeys : []).filter((journey) => journey.critical || journey.severity === "sev-1");
  const percent = rows.length === 0 ? "—" : `${((100 * rows.filter((journey) => journey.status === "passed").length) / rows.length).toFixed(1)}%`;
  const outside = (Array.isArray(blocking) ? blocking : []).filter((journey) => !(journey.critical || journey.severity === "sev-1"));
  if (outside.length === 0) return percent;
  return `${percent} · excludes ${outside.map((journey) => journey.title).join(", ")}`;
}

function serviceRollup(journeys, blocking) {
  const ids = [...new Set(journeys.map((journey) => journey.serviceId))];
  return ids.map((id) => {
    const rows = journeys.filter((journey) => journey.serviceId === id);
    const failed = blocking.filter((journey) => journey.serviceId === id);
    const flaky = rows.some((journey) => journey.status === "flaky");
    const stray = rows.some((journey) => journey.status === "failed" && !isBlocking(journey));
    let status = "clear";
    if (failed.length > 0) status = "blocked";
    else if (flaky || stray) status = "watch";
    return {
      id,
      status,
      criticalPass: criticalPassLabel(rows, failed),
      criticalFailed: failed.length,
      criticalTotal: rows.filter((journey) => journey.critical || journey.severity === "sev-1").length,
    };
  });
}

function rollout(decision) {
  const canary = decision === "canary" ? "eligible" : "blocked";
  const stable = decision === "canary" ? "soak" : "held";
  return [
    { region: "us-east-1", stage: "canary", traffic: "5%", state: canary },
    { region: "us-east-1", stage: "stable", traffic: "100%", state: stable },
    { region: "eu-central-1", stage: "stable", traffic: "100%", state: "held" },
  ];
}

/** Promote policy for one release train. `now` is epoch ms. */
export function evaluate(journeys, waivers = [], now = Date.now()) {
  const rows = Array.isArray(journeys) ? journeys : [];
  const blocking = rows.filter((journey) => isBlocking(journey) && !activeWaiver(waivers, journey.id, now));
  const sev1 = blocking.filter((journey) => journey.severity === "sev-1");
  const reach = blocking.filter((journey) => !journey.critical && journey.severity !== "sev-1");
  const scored = rows.filter((journey) => ["passed", "failed", "flaky"].includes(journey.status) && (journey.critical || journey.severity === "sev-1"));
  const flaky = scored.filter((journey) => journey.status === "flaky").length;
  const flakeRate = scored.length === 0 ? 0 : flaky / scored.length;
  const gates = [
    {
      id: "critical",
      label: "Critical journeys",
      ok: blocking.filter((journey) => journey.critical || journey.severity === "sev-1").length === 0,
      detail:
        blocking.filter((journey) => journey.critical || journey.severity === "sev-1").length === 0
          ? "0 unwaived failures"
          : `${blocking.filter((journey) => journey.critical || journey.severity === "sev-1").length} unwaived`,
    },
    {
      id: "sev1",
      label: "Sev-1 defects",
      ok: sev1.length === 0,
      detail: sev1.length === 0 ? "None open" : `${sev1.length} open`,
    },
    {
      id: "reach",
      label: "High reach",
      ok: reach.length === 0,
      detail: reachDetail(blocking),
    },
    {
      id: "flake",
      label: "Flake rate",
      ok: !overFlakeLimit(flaky, scored.length),
      detail: flakeDetail(flaky, scored.length),
    },
  ];
  const criticalJourneys = rows.filter((journey) => journey.critical || journey.severity === "sev-1");
  let decision = "canary";
  let reason = "Critical journeys are clear. Canary may advance. Stable stays in soak.";
  if (blocking.length > 0) {
    decision = "blocked";
    const noun = blocking.length === 1 ? "journey is" : "journeys are";
    reason = `${blocking.length} ${noun} blocking promotion.`;
  } else if (criticalJourneys.length === 0) {
    decision = "blocked";
    reason = "This train has no critical journeys.";
  } else if (overFlakeLimit(flaky, scored.length)) {
    decision = "blocked";
    reason = "Flake rate is above 5%.";
  }
  return {
    decision,
    reason,
    blocking,
    impactUsers: blocking.reduce((sum, journey) => sum + journey.weeklyUsers, 0),
    flakeRate,
    gates,
    rollout: rollout(decision),
    services: serviceRollup(rows, blocking),
  };
}

export function needsDirector(journey) {
  return journey.severity === "sev-1" || Number(journey.weeklyUsers) >= REACH;
}

/** A waiver is time-boxed. Sev-1 and million-session failures need a director and cannot outlive 24 hours. */
export function fileWaiver(journey, input, now) {
  const reason = String(input?.reason ?? "").trim();
  const hours = Number(input?.hours);
  const director = needsDirector(journey);
  const min = director ? 40 : 12;
  const maxHours = director ? 24 : 72;
  if (reason.length < min) {
    return { ok: false, error: `A ${journey.severity} waiver needs ${min} characters.` };
  }
  if (!HOURS.has(hours) || hours > maxHours) {
    return {
      ok: false,
      error: director ? "This waiver expires within 24 hours and needs a director." : "Choose 4, 24, or 72 hours.",
    };
  }
  return {
    ok: true,
    waiver: {
      journeyId: journey.id,
      reason,
      hours,
      actor: String(input.actor || "Release captain"),
      filedAt: now,
      expiresAt: now + hours * 60 * 60 * 1000,
      status: director ? "pending" : "approved",
      approver: null,
    },
  };
}

/** Shown before the waiver is filed. Sev-1 and million-session failures stay pending. */
export function waiverPrompt(journey) {
  if (needsDirector(journey)) {
    return "This waiver stays pending until a different director approves it. It expires within 24 hours and does not change the test result.";
  }
  return "A captain can approve this waiver. It does not change the test result.";
}

/** A director waiver stays pending until someone other than the filer approves it. */
export function approveWaiver(waiver, approver, now) {
  if (!waiver || waiver.status !== "pending") {
    return { ok: false, error: "This waiver is not waiting for approval." };
  }
  if (!approver || approver === waiver.actor) {
    return { ok: false, error: "A different director has to approve this waiver." };
  }
  if (waiver.expiresAt <= now) return { ok: false, error: "This waiver has expired." };
  return { ok: true, waiver: { ...waiver, status: "approved", approver } };
}

/** Plain record of the promote decision. */
export function releaseBrief(input) {
  const blocking = Array.isArray(input?.blocking) ? input.blocking : [];
  const lines = [
    `Release ${input.releaseId}`,
    `Decision: ${input.decision}`,
    String(input.reason || ""),
    `Blocked weekly sessions: ${input.impactUsers}`,
  ];
  if (blocking.length === 0) lines.push("No journeys are blocking.");
  else {
    lines.push("Blocking:");
    for (const journey of blocking) {
      lines.push(`- ${journey.severity} ${journey.title} · ${journey.serviceId} · ${journey.weeklyUsers} sessions`);
    }
  }
  return lines.join("\n");
}
