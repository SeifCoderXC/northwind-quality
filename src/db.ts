import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { journeys, services } from "./catalog.js";
import { hashPassword } from "./auth.ts";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "sql", "schema.sql");

export type User = { id: string; username: string; name: string; role: string };
export type Journey = {
  id: string;
  serviceId: string;
  title: string;
  severity: string;
  status: string;
  critical: boolean;
  weeklyUsers: number;
  owner: string;
  durationMs: number;
  expected: string | null;
  actual: string | null;
  error: string | null;
};
export type Waiver = {
  id: string;
  journeyId: string;
  reason: string;
  hours: number;
  actor: string;
  filedAt: number;
  expiresAt: number;
  status: string;
  approver: string | null;
};

type Store = {
  db: DatabaseSync;
  userByUsername(username: string): (User & { passwordHash: string }) | undefined;
  createUser(user: { username: string; name: string; role: string; password: string }): User | undefined;
  createSession(userId: string, token: string, expiresAt: number, lastSeenAt?: number): void;
  userForToken(token: string, now: number, idleMs?: number): User | undefined;
  takeSession(
    token: string,
    now: number,
    idleMs: number,
  ): { status: "ok"; user: User } | { status: "idle" | "expired" | "missing" };
  deleteSession(token: string): void;
  services(): typeof services;
  journeys(): Journey[];
  waivers(): Waiver[];
  audit(): { at: number; actor: string; action: string; detail: string }[];
  auditPage(
    limit: number,
    beforeId?: number | null,
  ): {
    rows: { id: number; at: number; actor: string; action: string; detail: string }[];
    hasMore: boolean;
    nextBefore: number | null;
    limit: number;
  };
  failedLoginCount(username: string, now: number, windowMs: number): number;
  recordFailedLogin(username: string, now: number, windowMs: number): void;
  clearFailedLogins(username: string): void;
  saveWaiver(waiver: Omit<Waiver, "id"> & { id?: string }): Waiver;
  setWaiver(waiver: Waiver): void;
  addAudit(entry: { at: number; actor: string; action: string; detail: string }): void;
  saveProbe(journey: Journey): void;
  enqueueDefect(journey: Journey): void;
  queuedDefects(): { id: number; journeyId: string; summary: string; body: string }[];
  markDefect(id: number, status: string, jiraKey: string | null): void;
  defects(): { journeyId: string; summary: string; status: string; jiraKey: string | null }[];
  setPassword(userId: string, passwordHash: string): void;
  createInvite(invite: { codeHash: string; role: string; createdBy: string; expiresAt: number }): void;
  consumeInvite(codeHash: string, userId: string, now: number): string | undefined;
  deleteUser(id: string): void;
  saveOidcState(row: { state: string; nonce: string; verifier: string; expiresAt: number }): void;
  takeOidcState(state: string, now: number): { nonce: string; verifier: string } | undefined;
  setDirectoryProfile(id: string, name: string, role: string): void;
};

function mapJourney(row: Record<string, unknown>): Journey {
  return {
    id: String(row.id),
    serviceId: String(row.service_id),
    title: String(row.title),
    severity: String(row.severity),
    status: String(row.status),
    critical: Number(row.critical) === 1,
    weeklyUsers: Number(row.weekly_users),
    owner: String(row.owner),
    durationMs: Number(row.duration_ms),
    expected: row.expected == null ? null : String(row.expected),
    actual: row.actual == null ? null : String(row.actual),
    error: row.error == null ? null : String(row.error),
  };
}

function mapWaiver(row: Record<string, unknown>): Waiver {
  return {
    id: String(row.id),
    journeyId: String(row.journey_id),
    reason: String(row.reason),
    hours: Number(row.hours),
    actor: String(row.actor),
    filedAt: Number(row.filed_at),
    expiresAt: Number(row.expires_at),
    status: String(row.status),
    approver: row.approver == null ? null : String(row.approver),
  };
}

export function openDb(file: string, demoPassword: string): Store {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(readFileSync(schemaPath, "utf8"));
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionColumns.some((column) => column.name === "last_seen_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER");
  }
  if (!sessionColumns.some((column) => column.name === "ended_reason")) {
    db.exec("ALTER TABLE sessions ADD COLUMN ended_reason TEXT");
  }
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (Number(users.n) === 0) seed(db, demoPassword);
  return {
    db,
    createUser(user) {
      const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(user.username);
      if (existing) return undefined;
      const id = randomUUID();
      db.prepare("INSERT INTO users (id, username, name, role, password_hash) VALUES (?, ?, ?, ?, ?)").run(
        id,
        user.username,
        user.name,
        user.role,
        hashPassword(user.password),
      );
      return { id, username: user.username, name: user.name, role: user.role };
    },
    userByUsername(username) {
      const row = db.prepare("SELECT id, username, name, role, password_hash AS passwordHash FROM users WHERE username = ?").get(username) as
        | (User & { passwordHash: string })
        | undefined;
      return row;
    },
    createSession(userId, token, expiresAt, lastSeenAt = Date.now()) {
      db.prepare("INSERT INTO sessions (token, user_id, expires_at, last_seen_at) VALUES (?, ?, ?, ?)").run(
        token,
        userId,
        expiresAt,
        lastSeenAt,
      );
    },
    takeSession(token, now, idleMs) {
      const row = db
        .prepare(
          `SELECT u.id, u.username, u.name, u.role, s.expires_at AS expiresAt, s.last_seen_at AS lastSeenAt,
                  s.ended_reason AS endedReason
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token = ?`,
        )
        .get(token) as (User & { expiresAt: number; lastSeenAt: number | null; endedReason: string | null }) | undefined;
      if (!row) return { status: "missing" as const };
      if (Number(row.expiresAt) <= now) {
        if (row.endedReason !== "expired") {
          db.prepare("UPDATE sessions SET ended_reason = 'expired' WHERE token = ?").run(token);
        }
        return { status: "expired" as const };
      }
      if (row.endedReason === "idle") return { status: "idle" as const };
      const seen = row.lastSeenAt == null ? now : Number(row.lastSeenAt);
      if (now - seen > idleMs) {
        db.prepare("UPDATE sessions SET ended_reason = 'idle' WHERE token = ?").run(token);
        return { status: "idle" as const };
      }
      db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token = ?").run(now, token);
      return { status: "ok" as const, user: { id: row.id, username: row.username, name: row.name, role: row.role } };
    },
    userForToken(token, now, idleMs = 30 * 60 * 1000) {
      const found = this.takeSession(token, now, idleMs);
      return found.status === "ok" ? found.user : undefined;
    },
    deleteSession(token) {
      db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    },
    services() {
      return db.prepare("SELECT id, name, team, owner, weekly_users AS weeklyUsers, slo FROM services ORDER BY rowid").all() as typeof services;
    },
    journeys() {
      return (db.prepare("SELECT * FROM journeys ORDER BY rowid").all() as Record<string, unknown>[]).map(mapJourney);
    },
    waivers() {
      return (db.prepare("SELECT * FROM waivers ORDER BY filed_at DESC").all() as Record<string, unknown>[]).map(mapWaiver);
    },
    audit() {
      return this.auditPage(100, null).rows;
    },
    auditPage(limit, beforeId = null) {
      const cap = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 40)));
      const rows = db
        .prepare(
          `SELECT id, at, actor, action, detail FROM audit
           WHERE (? IS NULL OR id < ?)
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(beforeId, beforeId, cap + 1) as {
        id: number;
        at: number;
        actor: string;
        action: string;
        detail: string;
      }[];
      const hasMore = rows.length > cap;
      const page = rows.slice(0, cap);
      return {
        rows: page,
        hasMore,
        nextBefore: page.length ? Number(page[page.length - 1].id) : null,
        limit: cap,
      };
    },
    failedLoginCount(username, now, windowMs) {
      const name = username.trim().toLowerCase();
      db.prepare("DELETE FROM login_attempts WHERE username = ? AND at <= ?").run(name, now - windowMs);
      const row = db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE username = ?").get(name) as { n: number };
      return Number(row.n);
    },
    recordFailedLogin(username, now, windowMs) {
      const name = username.trim().toLowerCase();
      db.prepare("DELETE FROM login_attempts WHERE username = ? AND at <= ?").run(name, now - windowMs);
      db.prepare("INSERT INTO login_attempts (username, at) VALUES (?, ?)").run(name, now);
    },
    clearFailedLogins(username) {
      db.prepare("DELETE FROM login_attempts WHERE username = ?").run(username.trim().toLowerCase());
    },
    saveWaiver(waiver) {
      db.prepare("DELETE FROM waivers WHERE journey_id = ? AND status = 'pending'").run(waiver.journeyId);
      const id = waiver.id || randomUUID();
      db.prepare(
        `INSERT INTO waivers (id, journey_id, reason, hours, actor, filed_at, expires_at, status, approver)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, waiver.journeyId, waiver.reason, waiver.hours, waiver.actor, waiver.filedAt, waiver.expiresAt, waiver.status, waiver.approver);
      return { ...waiver, id };
    },
    setWaiver(waiver) {
      db.prepare("UPDATE waivers SET status = ?, approver = ? WHERE id = ?").run(waiver.status, waiver.approver, waiver.id);
    },
    addAudit(entry) {
      db.prepare("INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)").run(entry.at, entry.actor, entry.action, entry.detail);
    },
    saveProbe(journey) {
      db.prepare(
        `INSERT INTO journeys (id, service_id, title, severity, status, critical, weekly_users, owner, duration_ms, expected, actual, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           duration_ms = excluded.duration_ms,
           error = excluded.error,
           actual = excluded.actual`,
      ).run(
        journey.id,
        journey.serviceId,
        journey.title,
        journey.severity,
        journey.status,
        journey.critical ? 1 : 0,
        journey.weeklyUsers,
        journey.owner,
        journey.durationMs,
        journey.expected,
        journey.actual,
        journey.error,
      );
    },
    enqueueDefect(journey) {
      db.prepare(
        `INSERT INTO jira_outbox (journey_id, summary, body, status)
         SELECT ?, ?, ?, 'queued'
         WHERE NOT EXISTS (
           SELECT 1 FROM jira_outbox WHERE journey_id = ? AND status IN ('queued', 'pushed')
         )`,
      ).run(
        journey.id,
        `${journey.severity}: ${journey.title}`,
        `Expected: ${journey.expected || "n/a"}\nActual: ${journey.actual || journey.error || "n/a"}`,
        journey.id,
      );
    },
    queuedDefects() {
      return db
        .prepare("SELECT id, journey_id AS journeyId, summary, body FROM jira_outbox WHERE status = 'queued' ORDER BY id")
        .all() as { id: number; journeyId: string; summary: string; body: string }[];
    },
    markDefect(id, status, jiraKey) {
      db.prepare("UPDATE jira_outbox SET status = ?, jira_key = ? WHERE id = ?").run(status, jiraKey, id);
    },
    defects() {
      return db
        .prepare("SELECT journey_id AS journeyId, summary, status, jira_key AS jiraKey FROM jira_outbox ORDER BY id")
        .all() as { journeyId: string; summary: string; status: string; jiraKey: string | null }[];
    },
    setPassword(userId, passwordHash) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
    },
    createInvite(invite) {
      db.prepare("INSERT INTO invites (code_hash, role, created_by, expires_at, used_by) VALUES (?, ?, ?, ?, NULL)").run(
        invite.codeHash,
        invite.role,
        invite.createdBy,
        invite.expiresAt,
      );
    },
    consumeInvite(codeHash, userId, now) {
      const updated = db
        .prepare("UPDATE invites SET used_by = ? WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?")
        .run(userId, codeHash, now);
      if (Number(updated.changes) !== 1) return undefined;
      const row = db.prepare("SELECT role FROM invites WHERE code_hash = ?").get(codeHash) as { role: string } | undefined;
      return row?.role;
    },
    deleteUser(id) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM users WHERE id = ?").run(id);
    },
    saveOidcState(row) {
      db.prepare("INSERT INTO oidc_states (state, nonce, verifier, expires_at) VALUES (?, ?, ?, ?)").run(
        row.state,
        row.nonce,
        row.verifier,
        row.expiresAt,
      );
    },
    takeOidcState(state, now) {
      const row = db.prepare("SELECT nonce, verifier, expires_at FROM oidc_states WHERE state = ?").get(state) as
        | { nonce: string; verifier: string; expires_at: number }
        | undefined;
      db.prepare("DELETE FROM oidc_states WHERE state = ?").run(state);
      if (!row || Number(row.expires_at) <= now) return undefined;
      return { nonce: row.nonce, verifier: row.verifier };
    },
    setDirectoryProfile(id, name, role) {
      db.prepare("UPDATE users SET name = ?, role = ? WHERE id = ?").run(name, role, id);
    },
  };
}

function seed(db: DatabaseSync, demoPassword: string): void {
  const password = hashPassword(demoPassword);
  const insertUser = db.prepare("INSERT INTO users (id, username, name, role, password_hash) VALUES (?, ?, ?, ?, ?)");
  insertUser.run("rahman", "rahman", "A. Rahman", "captain", password);
  insertUser.run("okonkwo", "okonkwo", "L. Okonkwo", "director", password);
  const insertService = db.prepare("INSERT INTO services (id, name, team, owner, weekly_users, slo) VALUES (?, ?, ?, ?, ?, ?)");
  for (const service of services) {
    insertService.run(service.id, service.name, service.team, service.owner, service.weeklyUsers, service.slo);
  }
  const insertJourney = db.prepare(
    `INSERT INTO journeys (id, service_id, title, severity, status, critical, weekly_users, owner, duration_ms, expected, actual, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const journey of journeys) {
    insertJourney.run(
      journey.id,
      journey.serviceId,
      journey.title,
      journey.severity,
      journey.status,
      journey.critical ? 1 : 0,
      journey.weeklyUsers,
      journey.owner,
      journey.durationMs,
      journey.expected,
      journey.actual,
      journey.error,
    );
  }
}
