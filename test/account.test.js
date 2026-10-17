import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAccount } from "../src/auth.ts";

test("an account needs a name, a username, and a password of 8 characters", () => {
  assert.equal(validateAccount({ name: "A", username: "ab", password: "short" }).ok, false);
  const account = validateAccount({ name: "  Sam Rivera ", username: "Sam-R", password: "northwind-local" });
  assert.equal(account.ok, true);
  assert.equal(account.username, "sam-r");
  assert.equal(account.name, "Sam Rivera");
});

test("the password cannot be the username", () => {
  assert.equal(validateAccount({ name: "Sam Rivera", username: "samrivera", password: "samrivera" }).ok, false);
});

test("signup cannot ask for the director role", () => {
  const account = validateAccount({ name: "Sam Rivera", username: "samr", password: "northwind-local", role: "director" });
  assert.equal(account.ok, false);
  assert.match(account.error, /invite/);
  const captain = validateAccount({ name: "Sam Rivera", username: "samr", password: "northwind-local" });
  assert.equal(captain.ok, true);
  assert.equal(captain.role, "captain");
});
