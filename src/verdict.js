const WAIVED = new Set(["test_bug", "environment", "flake"]);
const CLASSES = new Set(["product_bug", "test_bug", "environment", "flake"]);

function blocking(test) {
  return test.status !== "passed" && test.status !== "flaky" && test.status !== "skipped";
}

/** Decide ship or hold from classified test rows. */
export function decide(tests) {
  if (!Array.isArray(tests) || tests.length === 0) {
    return { decision: "hold", reason: "This run has no tests" };
  }
  const open = tests.filter(blocking);
  const unclassified = open.filter(
    (test) => test.classification !== "product_bug" && !WAIVED.has(test.classification),
  );
  if (unclassified.length > 0) {
    const count = unclassified.length;
    const noun = count === 1 ? "failure needs" : "failures need";
    return { decision: "hold", reason: `${count} ${noun} a class` };
  }
  const bugs = open.filter((test) => test.classification === "product_bug");
  if (bugs.length > 0) {
    const count = bugs.length;
    const noun = count === 1 ? "product bug is" : "product bugs are";
    return { decision: "hold", reason: `${count} ${noun} open` };
  }
  return { decision: "ship", reason: "Nothing is blocking the release" };
}

/** Overlay a saved class and note. Unknown classes are left unchanged. */
export function applyTriage(tests, saved = {}) {
  return tests.map((test) => {
    const patch = saved?.[test.id];
    if (!patch) return { ...test };
    const classification = CLASSES.has(patch.classification)
      ? patch.classification
      : (test.classification ?? null);
    const note = String(patch.note ?? "").trim();
    return { ...test, classification, note: note || test.note || "" };
  });
}
