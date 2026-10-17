import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDotEnv, jiraConfigured, pushIssue } from "../src/jira.ts";

test("a local env file fills empty Jira settings and leaves a process value", () => {
  const env = { JIRA_PROJECT: "KEEP" };
  applyDotEnv(
    env,
    "# local only\nJIRA_BASE_URL=https://northwind.atlassian.net\nJIRA_EMAIL=qa@northwind.test\nJIRA_TOKEN=token\nJIRA_PROJECT=NQ\n",
  );
  assert.equal(jiraConfigured(env), true);
  assert.equal(env.JIRA_PROJECT, "KEEP");
  assert.equal(env.JIRA_TOKEN, "token");
});

test("Jira stays off until the four settings are present", () => {
  assert.equal(jiraConfigured({}), false);
  assert.equal(jiraConfigured({ JIRA_BASE_URL: "https://northwind.atlassian.net", JIRA_EMAIL: "qa@northwind.test" }), false);
});

test("a configured push posts a Bug and keeps the key", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return { ok: true, json: async () => ({ key: "NQ-18" }) };
  };
  const result = await pushIssue(
    {
      JIRA_BASE_URL: "https://northwind.atlassian.net",
      JIRA_EMAIL: "qa@northwind.test",
      JIRA_TOKEN: "token",
      JIRA_PROJECT: "NQ",
    },
    { summary: "sev-1: Guest cart total", body: "Expected: $48.00\nActual: $0.00" },
    fetchImpl,
  );
  assert.equal(result.ok, true);
  assert.equal(result.key, "NQ-18");
  assert.equal(seen[0].url, "https://northwind.atlassian.net/rest/api/3/issue");
  const payload = JSON.parse(seen[0].options.body);
  assert.equal(payload.fields.project.key, "NQ");
  assert.equal(payload.fields.issuetype.name, "Bug");
});
