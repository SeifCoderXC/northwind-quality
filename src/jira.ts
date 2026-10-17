export type JiraEnv = {
  JIRA_BASE_URL?: string;
  JIRA_EMAIL?: string;
  JIRA_TOKEN?: string;
  JIRA_PROJECT?: string;
};

export type JiraIssue = { summary: string; body: string };

export function jiraConfigured(env: JiraEnv): boolean {
  return Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_TOKEN && env.JIRA_PROJECT);
}

export function jiraBrowseRoot(env: JiraEnv): string | null {
  if (!jiraConfigured(env)) return null;
  const base = String(env.JIRA_BASE_URL).replace(/\/$/, "");
  if (!/^https?:\/\//.test(base)) return null;
  return `${base}/browse`;
}

/** Fill empty keys from a KEY=value file. Existing process values stay. */
export function applyDotEnv(env: NodeJS.ProcessEnv, text: string): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (env[key]) continue;
    env[key] = trimmed.slice(eq + 1);
  }
}

/** Create one Bug. `fetchImpl` is injectable so tests never call Jira. */
export async function pushIssue(
  env: JiraEnv,
  issue: JiraIssue,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  if (!jiraConfigured(env)) return { ok: false, error: "Jira is not configured" };
  const url = `${String(env.JIRA_BASE_URL).replace(/\/$/, "")}/rest/api/3/issue`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`).toString("base64")}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: env.JIRA_PROJECT },
        summary: issue.summary.slice(0, 255),
        issuetype: { name: "Bug" },
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: issue.body.slice(0, 2000) }] }],
        },
      },
    }),
  });
  if (!response.ok) return { ok: false, error: `Jira responded ${response.status}` };
  const payload = (await response.json()) as { key?: string };
  if (!payload.key) return { ok: false, error: "Jira did not return a key" };
  return { ok: true, key: payload.key };
}
