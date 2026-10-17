import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 32);
  const prev = Buffer.from(hash, "hex");
  return next.length === prev.length && timingSafeEqual(next, prev);
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** Public signup is always a captain. A director is not self-assigned. */
export function validateAccount(input: { name?: string; username?: string; password?: string; role?: string }):
  | { ok: false; error: string }
  | { ok: true; name: string; username: string; password: string; role: "captain" } {
  const name = String(input?.name ?? "").trim().replace(/\s+/g, " ");
  const username = String(input?.username ?? "").trim().toLowerCase();
  const password = String(input?.password ?? "");
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Enter your name." };
  if (!/^[a-z][a-z0-9-]{2,23}$/.test(username)) {
    return { ok: false, error: "Username needs 3–24 letters, numbers, or hyphens, and must start with a letter." };
  }
  if (password.length < 8) return { ok: false, error: "Password needs at least 8 characters." };
  if (password.toLowerCase() === username) return { ok: false, error: "Password cannot match the username." };
  const requested = String(input?.role ?? "").trim().toLowerCase();
  if (requested && requested !== "captain") {
    return { ok: false, error: "Public signup cannot choose a role. A director account needs an invite." };
  }
  return { ok: true, name, username, password, role: "captain" };
}

export function hashInvite(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
