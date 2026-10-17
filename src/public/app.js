const navEl = document.querySelector("#nav");
const topEl = document.querySelector("#top");
const pageEl = document.querySelector("#page");

let workspace = null;
let ui = { service: "all", status: "all", query: "" };

const words = {
  blocked: "Blocked",
  clear: "Clear",
  watch: "Watch",
  canary: "Canary",
  eligible: "Eligible",
  soak: "Soak",
  held: "Held",
  passed: "Passed",
  failed: "Failed",
  flaky: "Flaky",
  skipped: "Skipped",
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value != null && value !== false) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function compact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function duration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function when(ms) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}

async function takeJson(res) {
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    workspace = null;
    renderLogin(body.error || "", Boolean(body.directory));
    return null;
  }
  return body;
}

function route() {
  const parts = (location.hash || "#/").replace(/^#\/?/, "").split("/").filter(Boolean);
  return { page: parts[0] || "overview", id: parts[1] || null };
}

function serviceById(id) {
  return workspace.services.find((service) => service.id === id);
}

function state(name) {
  return el("span", { class: `state ${name}` }, [el("i"), words[name] || name]);
}

function table(headers, rows) {
  return el("div", { class: "sheet" }, [
    el("table", {}, [
      el("thead", {}, [el("tr", {}, headers.map((header) => el("th", { class: header.num ? "num" : "" }, [header.label])))]),
      el("tbody", {}, rows),
    ]),
  ]);
}

function journeyRow(journey, selected) {
  return el(
    "tr",
    {
      class: "hit",
      "aria-selected": selected ? "true" : "false",
      onclick: () => {
        location.hash = `#/release/${journey.id}`;
      },
    },
    [
      el("td", {}, [
        el("button", {
          type: "button",
          onclick: (event) => {
            event.stopPropagation();
            location.hash = `#/release/${journey.id}`;
          },
        }, [journey.title]),
      ]),
      el("td", {}, [serviceById(journey.serviceId)?.name || journey.serviceId]),
      el("td", {}, [journey.severity]),
      el("td", { class: "num" }, [compact(journey.weeklyUsers)]),
      el("td", {}, [state(journey.status)]),
      el("td", {}, [journey.owner]),
      el("td", {}, [journey.waiver?.status === "pending" ? "Pending director" : journey.waiver ? `Until ${when(journey.waiver.expiresAt)}` : ""]),
    ],
  );
}

function headline() {
  const { decision, impactUsers, reason } = workspace.evaluation;
  const name = workspace.release.id;
  if (decision === "blocked" && impactUsers > 0) {
    return `Release ${name} is blocked. ${compact(impactUsers)} weekly sessions are on paths that cannot promote.`;
  }
  if (decision === "blocked") return `Release ${name} is blocked. ${reason}`;
  return `Release ${name} can advance the us-east-1 canary. Stable traffic stays in soak.`;
}

function criticalPass(serviceId) {
  const roll = workspace.evaluation.services.find((row) => row.id === serviceId);
  if (roll?.criticalPass) return roll.criticalPass;
  return "—";
}

function serviceRows() {
  return workspace.services.map((service) => {
    const roll = workspace.evaluation.services.find((row) => row.id === service.id);
    return el("tr", { class: "hit", onclick: () => (location.hash = `#/services/${service.id}`) }, [
      el("td", {}, [el("button", { type: "button" }, [service.name])]),
      el("td", {}, [service.team]),
      el("td", {}, [service.owner]),
      el("td", { class: "num" }, [compact(service.weeklyUsers)]),
      el("td", { class: "num" }, [`${service.slo}%`]),
      el("td", { class: "num" }, [criticalPass(service.id)]),
      el("td", {}, [
        state(roll?.status || "clear"),
        (() => {
          const why = workspace.evaluation.blocking
            .filter((journey) => journey.serviceId === service.id)
            .map((journey) => journey.title)
            .join(" · ");
          return why ? el("div", { class: "why" }, [why]) : null;
        })(),
      ]),
    ]);
  });
}

function gateTable() {
  return table(
    [{ label: "Gate" }, { label: "Actual" }, { label: "Result" }],
    workspace.evaluation.gates.map((gate) =>
      el("tr", {}, [
        el("td", {}, [gate.label]),
        el("td", {}, [gate.detail]),
        el("td", {}, [state(gate.ok ? "clear" : "blocked")]),
      ]),
    ),
  );
}

function rolloutTable() {
  return table(
    [{ label: "Region" }, { label: "Stage" }, { label: "Traffic" }, { label: "Promote" }],
    workspace.evaluation.rollout.map((row) =>
      el("tr", {}, [
        el("td", {}, [row.region]),
        el("td", {}, [row.stage]),
        el("td", {}, [row.traffic]),
        el("td", {}, [state(row.state)]),
      ]),
    ),
  );
}

function renderOverview() {
  const blocking = workspace.evaluation.blocking;
  pageEl.append(
    el("h1", {}, ["Overview"]),
    el("p", { class: "lede" }, [headline()]),
    el("section", { class: "metrics", "aria-label": "Release snapshot" }, [
      el("div", {}, [el("span", {}, ["Blocked sessions"]), el("strong", {}, [compact(workspace.evaluation.impactUsers)])]),
      el("div", {}, [el("span", {}, ["Open blockers"]), el("strong", {}, [String(blocking.length)])]),
      el("div", {}, [
        el("span", {}, ["Flake"]),
        el("strong", {}, [workspace.evaluation.gates.find((gate) => gate.id === "flake")?.detail.split("·")[0].trim() || "—"]),
      ]),
      el("div", {}, [el("span", {}, ["Decision"]), el("strong", {}, [words[workspace.evaluation.decision] || workspace.evaluation.decision])]),
    ]),
    el("h2", {}, ["Services"]),
    table(
      [
        { label: "Service" },
        { label: "Team" },
        { label: "Owner" },
        { label: "Weekly sessions", num: true },
        { label: "SLO", num: true },
        { label: "Critical pass", num: true },
        { label: "Status" },
      ],
      serviceRows(),
    ),
    el("h2", {}, ["Rollout"]),
    rolloutTable(),
    el("details", { class: "brief" }, [
      el("summary", {}, ["Release brief"]),
      el("pre", { id: "brief" }, [workspace.brief || ""]),
    ]),
    el("h2", {}, ["Blocking promotion"]),
  );
  if (blocking.length === 0) {
    pageEl.append(el("p", { class: "empty" }, ["Nothing is blocking the canary."]));
    return;
  }
  pageEl.append(
    table(
      [{ label: "Journey" }, { label: "Service" }, { label: "Severity" }, { label: "Weekly sessions", num: true }, { label: "Owner" }],
      blocking.map((journey) =>
        el("tr", { class: "hit", onclick: () => (location.hash = `#/release/${journey.id}`) }, [
          el("td", {}, [el("button", { type: "button" }, [journey.title])]),
          el("td", {}, [serviceById(journey.serviceId)?.name]),
          el("td", {}, [journey.severity]),
          el("td", { class: "num" }, [compact(journey.weeklyUsers)]),
          el("td", {}, [journey.owner]),
        ]),
      ),
    ),
  );
}

function visibleJourneys() {
  return workspace.journeys.filter((journey) => {
    if (ui.service !== "all" && journey.serviceId !== ui.service) return false;
    if (ui.status !== "all" && journey.status !== ui.status) return false;
    if (ui.query && !`${journey.title} ${journey.owner}`.toLowerCase().includes(ui.query.toLowerCase())) return false;
    return true;
  });
}

function renderDetail(journey) {
  const box = el("section", { class: "detail", "aria-label": "Journey" });
  if (!journey) {
    box.append(el("p", { class: "empty" }, ["Select a journey to file a waiver."]));
    return box;
  }
  box.append(
    el("h2", {}, [journey.title]),
    el("p", { class: "meta" }, [
      `${serviceById(journey.serviceId)?.name} · ${journey.severity} · ${journey.owner} · ${duration(journey.durationMs)} · ${compact(journey.weeklyUsers)} weekly sessions`,
    ]),
  );
  if (journey.expected || journey.actual) {
    box.append(el("p", {}, [`Expected: ${journey.expected || "n/a"}`]), el("p", {}, [`Actual: ${journey.actual || "n/a"}`]));
  }
  if (journey.error) box.append(el("p", { class: "error" }, [journey.error]));
  if (journey.waiver?.status === "pending") {
    const alert = el("p", { class: "alert", role: "alert" });
    box.append(el("p", {}, [`Filed by ${journey.waiver.actor}. A different director has to approve it. ${journey.waiver.reason}`]));
    if (workspace.actor.role === "director") {
      const approve = el("button", { class: "primary", type: "button" }, ["Approve waiver"]);
      approve.onclick = async () => {
        const res = await fetch("/api/approvals", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ waiverId: journey.waiver.id }),
        });
        const body = await takeJson(res);
        if (!body) return;
        if (!res.ok) {
          alert.textContent = body.error || "The approval was rejected.";
          return;
        }
        workspace = body;
        draw();
      };
      box.append(el("div", { class: "actions" }, [approve]), alert);
    }
    return box;
  }
  if (journey.waiver) {
    box.append(el("p", {}, [`Approved by ${journey.waiver.approver || journey.waiver.actor} until ${when(journey.waiver.expiresAt)}. ${journey.waiver.reason}`]));
    return box;
  }
  if (journey.status !== "failed") {
    box.append(el("p", { class: "empty" }, ["This journey does not need a waiver."]));
    return box;
  }
  const reason = el("textarea", { id: "reason", maxlength: "500" });
  box.append(el("p", {}, [journey.waiverPrompt || ""]));
  const hours = el("select", { id: "hours", "aria-label": "Expiry" }, [
    el("option", { value: "4" }, ["4 hours"]),
    el("option", { value: "24" }, ["24 hours"]),
    journey.severity === "sev-1" || journey.weeklyUsers >= 1_000_000 ? null : el("option", { value: "72" }, ["72 hours"]),
  ]);
  const alert = el("p", { class: "alert", role: "alert" });
  const form = el("form", {}, [
    el("label", { for: "reason" }, ["Reason"]),
    reason,
    el("div", { class: "actions" }, [
      hours,
      el("button", { class: "primary", type: "submit" }, ["File waiver"]),
    ]),
    alert,
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const res = await fetch("/api/waivers", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journeyId: journey.id, reason: reason.value, hours: Number(hours.value) }),
    });
    const body = await takeJson(res);
    if (!body) return;
    if (!res.ok) {
      alert.textContent = body.error || "The waiver was rejected.";
      return;
    }
    workspace = body;
    draw();
  });
  box.append(form);
  return box;
}

function renderRelease() {
  const current = route();
  const critical = workspace.journeys.filter((journey) => journey.critical || journey.severity === "sev-1").length;
  pageEl.append(
    el("h1", {}, [`Release ${workspace.release.id}`]),
    el("p", { class: "lede" }, [
      `${workspace.release.gateNote} ${critical} critical journeys are listed. A failure also blocks at sev-1 or at 1M weekly sessions. ${workspace.evaluation.reason}`,
    ]),
    el("h2", {}, ["Gates"]),
    gateTable(),
    el("h2", {}, ["Journeys"]),
  );
  const search = el("input", { type: "search", "aria-label": "Filter journeys", value: ui.query });
  const service = el(
    "select",
    { "aria-label": "Service" },
    [el("option", { value: "all" }, ["All services"])].concat(
      workspace.services.map((item) => el("option", { value: item.id, selected: ui.service === item.id }, [item.name])),
    ),
  );
  const status = el(
    "select",
    { "aria-label": "Result" },
    ["all", "failed", "flaky", "passed"].map((value) =>
      el("option", { value, selected: ui.status === value }, [value === "all" ? "All results" : words[value]]),
    ),
  );
  const body = el("tbody");
  const empty = el("p", { class: "empty", hidden: true }, ["No journeys match this filter."]);
  const fill = () => {
    const selected = route().id;
    const rows = visibleJourneys();
    body.replaceChildren(...rows.map((journey) => journeyRow(journey, journey.id === selected)));
    empty.hidden = rows.length > 0;
  };
  search.oninput = () => {
    ui.query = search.value;
    fill();
  };
  service.onchange = () => {
    ui.service = service.value;
    fill();
  };
  status.onchange = () => {
    ui.status = status.value;
    fill();
  };
  pageEl.append(el("div", { class: "filters" }, [search, service, status]), empty);
  const grid = table(
    [
      { label: "Journey" },
      { label: "Service" },
      { label: "Severity" },
      { label: "Sessions", num: true },
      { label: "Result" },
      { label: "Owner" },
      { label: "Waiver" },
    ],
    [],
  );
  grid.querySelector("tbody").replaceWith(body);
  pageEl.append(grid);
  fill();
  const selected = workspace.journeys.find((journey) => journey.id === current.id) || null;
  pageEl.append(renderDetail(selected));
}

function renderServices() {
  const id = route().id;
  if (!id) {
    pageEl.append(el("h1", {}, ["Services"]), el("p", { class: "lede" }, [`${compact(workspace.org.weeklyCustomers)} weekly customers across four owned services.`]));
    pageEl.append(
      table(
        [
          { label: "Service" },
          { label: "Team" },
          { label: "Owner" },
          { label: "Weekly sessions", num: true },
          { label: "SLO", num: true },
          { label: "Critical pass", num: true },
          { label: "Status" },
        ],
        serviceRows(),
      ),
    );
    return;
  }
  const service = serviceById(id);
  if (!service) {
    pageEl.append(el("h1", {}, ["Unknown service"]));
    return;
  }
  const rows = workspace.journeys.filter((journey) => journey.serviceId === id);
  pageEl.append(
    el("h1", {}, [service.name]),
    el("p", { class: "lede" }, [
      `${service.team} · ${service.owner} · ${compact(service.weeklyUsers)} weekly sessions · SLO ${service.slo}% · critical pass ${criticalPass(id)}`,
    ]),
    table(
      [{ label: "Journey" }, { label: "Service" }, { label: "Severity" }, { label: "Sessions", num: true }, { label: "Result" }, { label: "Owner" }, { label: "Waiver" }],
      rows.map((journey) => journeyRow(journey, false)),
    ),
  );
}

function renderWaivers() {
  const now = Date.now();
  const active = workspace.waivers.filter((waiver) => waiver.expiresAt > now);
  pageEl.append(el("h1", {}, ["Waivers"]), el("p", { class: "lede" }, ["A waiver expires on its own. Sev-1 and million-session waivers cannot outlive 24 hours."]));
  if (active.length === 0) {
    pageEl.append(el("p", { class: "empty" }, ["No active waivers."]));
    return;
  }
  pageEl.append(
    table(
      [{ label: "Journey" }, { label: "Status" }, { label: "Reason" }, { label: "By" }, { label: "Expires" }],
      active.map((waiver) => {
        const journey = workspace.journeys.find((row) => row.id === waiver.journeyId);
        return el("tr", {}, [
          el("td", {}, [journey?.title || waiver.journeyId]),
          el("td", {}, [waiver.status]),
          el("td", {}, [waiver.reason]),
          el("td", {}, [waiver.actor]),
          el("td", {}, [when(waiver.expiresAt)]),
        ]);
      }),
    ),
  );
}

function renderAudit() {
  pageEl.append(el("h1", {}, ["Audit"]), el("p", { class: "lede" }, ["Decisions on this control plane, newest first."]));
  const rows = workspace.audit.slice();
  let pageInfo = workspace.auditPage || { hasMore: false, nextBefore: null };
  const body = el("tbody");
  const empty = el("p", { class: "empty" }, ["No decisions yet."]);
  const older = el("button", { type: "button" }, ["Older decisions"]);
  const note = el("p", { class: "alert", role: "alert" });
  const paint = () => {
    empty.hidden = rows.length > 0;
    body.replaceChildren(
      ...rows.map((entry) =>
        el("tr", {}, [
          el("td", {}, [when(entry.at)]),
          el("td", {}, [entry.actor]),
          el("td", {}, [entry.action]),
          el("td", {}, [entry.detail]),
        ]),
      ),
    );
    older.hidden = !pageInfo.hasMore;
  };
  older.addEventListener("click", async () => {
    older.disabled = true;
    try {
      const res = await fetch(`/api/audit?before=${pageInfo.nextBefore}`, { credentials: "same-origin" });
      const payload = await takeJson(res);
      if (!payload) return;
      if (!res.ok) {
        note.textContent = payload.error || "Older decisions could not be loaded.";
        return;
      }
      rows.push(...payload.audit);
      pageInfo = payload.auditPage;
      paint();
    } finally {
      if (older.isConnected) older.disabled = false;
    }
  });
  const grid = table(
    [{ label: "When" }, { label: "Who" }, { label: "Action" }, { label: "Detail" }],
    [],
  );
  grid.querySelector("tbody").replaceWith(body);
  paint();
  pageEl.append(empty, grid, el("div", { class: "actions" }, [older]), note);
}

function drawNav() {
  const current = route().page;
  const links = [
    ["overview", "Overview"],
    ["release", "Release"],
    ["services", "Services"],
    ["plan", "Plan"],
    ["defects", "Defects"],
    ["waivers", "Waivers"],
    ["audit", "Audit"],
    ["account", "Account"],
  ];
  navEl.replaceChildren(
    el("p", { class: "org" }, [workspace.org.name]),
    el("p", { class: "product" }, [workspace.org.product]),
    ...links.map(([id, label]) => el("a", { href: `#/${id === "overview" ? "" : id}`, "aria-current": current === id ? "page" : false }, [label])),
    el("p", { class: "note" }, ["A new account is a captain. Sev-1 and million-session failures need a director."]),
  );
}

function drawTop() {
  const probe = el("button", { id: "probe", type: "button" }, ["Run checkout probe"]);
  probe.onclick = async () => {
    if (probe.dataset.pending === "1") return;
    probe.dataset.pending = "1";
    const status = el("span", { class: "meta", role: "status" }, ["Running probe…"]);
    probe.after(status);
    try {
      const res = await fetch("/api/probe", { method: "POST", credentials: "same-origin" });
      const body = await takeJson(res);
      if (!body) return;
      if (!body.evaluation) {
        status.textContent = body.error || "The probe did not finish.";
        return;
      }
      workspace = body;
      location.hash = "#/release/checkout-probe";
      draw();
    } catch {
      if (status.isConnected) status.textContent = "The probe did not finish.";
    } finally {
      if (probe.isConnected) delete probe.dataset.pending;
    }
  };
  topEl.replaceChildren(
    el("span", { class: "release" }, [`${workspace.release.id} · us-east-1 canary`]),
    state(workspace.evaluation.decision),
    el("span", { class: "who" }, [`${workspace.actor.name} · ${workspace.actor.role}`]),
    probe,
    el("button", {
      type: "button",
      onclick: async () => {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
        workspace = null;
        await boot();
      },
    }, ["Sign out"]),
  );
}

function renderPlan() {
  pageEl.append(
    el("h1", {}, ["Test plan"]),
    el("p", { class: "lede" }, [`Release ${workspace.release.id}. Each case has a severity, an expected result, and an actual result.`]),
    table(
      [
        { label: "Case" },
        { label: "Service" },
        { label: "Severity" },
        { label: "Expected" },
        { label: "Actual" },
        { label: "Result" },
      ],
      workspace.journeys.map((journey) =>
        el("tr", {}, [
          el("td", {}, [journey.title]),
          el("td", {}, [serviceById(journey.serviceId)?.name || journey.serviceId]),
          el("td", {}, [journey.severity]),
          el("td", {}, [journey.expected || ""]),
          el("td", {}, [journey.actual || ""]),
          el("td", {}, [state(journey.status)]),
        ]),
      ),
    ),
  );
}

function jiraLink(key) {
  if (!key) return "";
  const root = workspace.jiraBrowse;
  if (typeof root !== "string" || !/^https?:\/\//.test(root) || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return key;
  return el("a", { href: `${root}/${key}`, target: "_blank", rel: "noopener noreferrer" }, [key]);
}

function renderDefects() {
  const rows = workspace.defects || [];
  pageEl.append(
    el("h1", {}, ["Defects"]),
    el("p", { class: "lede" }, [
      workspace.jira
        ? "Blocking journeys are queued and sent to Jira."
        : "Blocking journeys are queued here. Jira is not configured, so nothing is sent.",
    ]),
  );
  if (rows.length === 0) {
    pageEl.append(el("p", { class: "empty" }, ["No defects queued."]));
    return;
  }
  pageEl.append(
    table(
      [{ label: "Summary" }, { label: "Status" }, { label: "Jira" }],
      rows.map((row) => el("tr", {}, [el("td", {}, [row.summary]), el("td", {}, [row.status]), el("td", {}, [jiraLink(row.jiraKey)])])),
    ),
  );
}

function renderAccount() {
  const error = el("p", { class: "alert", role: "alert" });
  const current = el("input", { id: "current-password", type: "password", autocomplete: "current-password" });
  const next = el("input", { id: "next-password", type: "password", autocomplete: "new-password" });
  const form = el("form", { class: "detail" }, [
    el("h1", {}, ["Account"]),
    el("p", { class: "lede" }, [`Signed in as ${workspace.actor.name}. Role: ${workspace.actor.role}.`]),
    el("label", { for: "current-password" }, ["Current password"]),
    current,
    el("label", { for: "next-password" }, ["New password"]),
    next,
    el("div", { class: "actions" }, [el("button", { class: "primary", type: "submit" }, ["Change password"])]),
    error,
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const res = await fetch("/api/password", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current: current.value, next: next.value }),
    });
    const body = await takeJson(res);
    if (!body) return;
    error.className = res.ok ? "meta" : "alert";
    if (!res.ok) {
      error.textContent = body.error || "The password was not changed.";
      return;
    }
    error.textContent = "Password changed.";
    current.value = "";
    next.value = "";
  });
  pageEl.append(form);
  if (workspace.actor.role !== "director") return;
  const issued = el("p", { class: "meta" });
  const button = el("button", { class: "primary", type: "button" }, ["Issue a 24-hour director invite"]);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const res = await fetch("/api/invites", { method: "POST", credentials: "same-origin" });
      const body = await takeJson(res);
      if (!body) return;
      issued.className = res.ok ? "meta" : "alert";
      issued.textContent = res.ok
        ? `Invite code ${body.code}. It works once and expires ${when(body.expiresAt)}.`
        : body.error || "The invite was not issued.";
    } finally {
      button.disabled = false;
    }
  });
  pageEl.append(
    el("section", { class: "detail" }, [
      el("h2", {}, ["Director invites"]),
      el("p", {}, ["The code is shown once. The new director enters it while creating an account. A captain cannot issue one."]),
      el("div", { class: "actions" }, [button]),
      issued,
    ]),
  );
}

function directoryMessage() {
  const code = new URLSearchParams(location.search).get("directory");
  const messages = {
    unreachable: "The directory is not reachable.",
    rejected: "The directory rejected the sign-in.",
    groups: "The directory did not send a group list.",
    mismatch: "The directory sign-in did not match this browser.",
    expired: "The directory sign-in expired.",
  };
  return messages[code] || "";
}

function renderLogin(notice = "", directory = false) {
  document.title = "Northwind Quality";
  document.body.classList.add("auth");
  navEl.replaceChildren();
  topEl.replaceChildren();
  let mode = "signin";
  const error = el("p", { class: "alert", role: "alert" });
  const name = el("input", { id: "name", name: "name", autocomplete: "name" });
  const user = el("input", { id: "username", name: "username", autocomplete: "username" });
  const pass = el("input", { id: "password", name: "password", type: "password", autocomplete: "current-password" });
  const nameLabel = el("label", { for: "name" }, ["Name"]);
  const invite = el("input", { id: "invite", name: "invite", autocomplete: "off" });
  const inviteLabel = el("label", { for: "invite" }, ["Director invite"]);
  const submit = el("button", { class: "primary", type: "submit" }, ["Sign in"]);
  const signIn = el("button", { type: "button", "aria-pressed": "true" }, ["Sign in"]);
  const create = el("button", { type: "button", "aria-pressed": "false" }, ["Create account"]);
  const setMode = (next) => {
    mode = next;
    const registering = mode === "register";
    signIn.setAttribute("aria-pressed", registering ? "false" : "true");
    create.setAttribute("aria-pressed", registering ? "true" : "false");
    nameLabel.hidden = !registering;
    name.hidden = !registering;
    name.required = registering;
    inviteLabel.hidden = !registering;
    invite.hidden = !registering;
    submit.textContent = registering ? "Create account" : "Sign in";
    pass.setAttribute("autocomplete", registering ? "new-password" : "current-password");
    error.textContent = "";
  };
  signIn.onclick = () => setMode("signin");
  create.onclick = () => setMode("register");
  const form = el("form", {}, [
    el("div", { class: "modes", role: "group", "aria-label": "Account" }, [signIn, create]),
    el("h1", {}, ["Northwind Quality"]),
    el("p", { class: "lede" }, ["Create an account to open the release desk. A new account is a captain unless the form includes a director invite. Sev-1 approval stays with a director."]),
    nameLabel,
    name,
    inviteLabel,
    invite,
    el("label", { for: "username" }, ["Username"]),
    user,
    el("label", { for: "password" }, ["Password"]),
    pass,
    el("div", { class: "actions" }, [submit]),
    error,
    directory
      ? el("a", { class: "directory", href: "/api/oidc/start" }, ["Sign in with your directory"])
      : null,
    directory
      ? el("p", { class: "meta" }, ["The director group becomes a director. Anyone else the directory authenticates becomes a captain."])
      : null,
    el("details", {}, [
      el("summary", {}, ["Use a seeded account"]),
      el("p", {}, ["Captain rahman and director okonkwo share the local password northwind-local. Change it before anyone else can reach this machine. A session ends after 30 minutes without a request, and after 12 hours in any case."]),
    ]),
  ]);
  setMode("signin");
  if (notice && notice !== "Sign in required") error.textContent = notice;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const path = mode === "register" ? "/api/register" : "/api/login";
    const payload = { username: user.value, password: pass.value };
    if (mode === "register") {
      payload.name = name.value;
      if (invite.value.trim()) payload.invite = invite.value.trim();
    }
    try {
      const res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        error.textContent = body.error || (mode === "register" ? "The account was not created." : "Those credentials were rejected.");
        return;
      }
      await boot(true);
    } finally {
      submit.disabled = false;
    }
  });
  pageEl.replaceChildren(
    el("div", { class: "gate" }, [
      el("section", { class: "story" }, [
        el("p", { class: "kicker" }, ["Northwind"]),
        el("h1", {}, ["Ship the canary, or hold the train."]),
        el("p", {}, ["Quality is the release control plane. Critical failures, sev-1 defects, and any failure covering a million weekly sessions block promotion."]),
        el("ul", {}, [
          el("li", {}, ["Create your own captain account, or sign in with a seeded one."]),
          el("li", {}, ["A captain cannot approve their own sev-1 or million-session waiver."]),
          el("li", {}, ["Stable regions stay held until the canary is clear."]),
        ]),
      ]),
      el("section", { class: "panel" }, [form]),
    ]),
  );
}

async function boot(home = false) {
  const session = await fetch("/api/session", { credentials: "same-origin" });
  if (!session.ok) {
    const body = await session.json().catch(() => ({}));
    const fromDirectory = directoryMessage();
    const notice = fromDirectory || (body.error && body.error !== "Sign in required" ? body.error : "");
    return renderLogin(notice, Boolean(body.directory));
  }
  const res = await fetch("/api/workspace", { credentials: "same-origin" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const fromDirectory = directoryMessage();
    const notice = fromDirectory || (body.error && body.error !== "Sign in required" ? body.error : "");
    return renderLogin(notice, Boolean(body.directory));
  }
  workspace = await res.json();
  if (home && location.hash && location.hash !== "#/" && location.hash !== "#") {
    location.hash = "#/";
  }
  draw();
}

function draw() {
  document.body.classList.remove("auth");
  const current = route();
  drawNav();
  drawTop();
  pageEl.replaceChildren();
  if (current.page === "release") renderRelease();
  else if (current.page === "services") renderServices();
  else if (current.page === "plan") renderPlan();
  else if (current.page === "defects") renderDefects();
  else if (current.page === "account") renderAccount();
  else if (current.page === "waivers") renderWaivers();
  else if (current.page === "audit") renderAudit();
  else renderOverview();
  document.title = `Northwind Quality · ${current.page}`;
}

window.addEventListener("hashchange", () => {
  if (workspace) draw();
});
await boot();
