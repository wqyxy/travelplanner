import { describe, expect, it } from "vitest";
import { createSessionKey, hashPassword, PersistentSessionStore, validatePassword, verifyPassword } from "./auth.js";

describe("password policy", () => {
  it("accepts exactly six characters and has no maximum length", async () => {
    expect(() => validatePassword("123456")).not.toThrow();
    const password = "x".repeat(10000);
    const record = await hashPassword(password);
    await expect(verifyPassword(password, record)).resolves.toBe(true);
  });
  it("rejects fewer than six characters", () => expect(() => validatePassword("12345")).toThrow());
});

describe("password changes and sessions", () => {
  it("changes the password hash while preserving configured session keys", async () => {
    const original = await hashPassword("old-password"); const record = { ...original, sessionKey: createSessionKey() };
    const next = await hashPassword("new-password"); Object.assign(record, next);
    expect(record.passwordHash).not.toBe(original.passwordHash);
    await expect(verifyPassword("old-password", record)).resolves.toBe(false);
    await expect(verifyPassword("new-password", record)).resolves.toBe(true);
    expect(record.sessionKey).toHaveLength(128);
  });
  it("keeps legacy cookies valid after the first password change", async () => {
    const legacy = await hashPassword("old-password"); const record: { passwordSalt?: string; passwordHash?: string; sessionKey?: string } = { ...legacy };
    const sessions = new PersistentSessionStore(() => record); const token = sessions.create();
    const next = await hashPassword("new-password"); Object.assign(record, next, { sessionKey: legacy.passwordHash });
    expect(sessions.has(token)).toBe(true);
    expect(sessions.has(sessions.create())).toBe(true);
  });
});
