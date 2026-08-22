import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export interface PasswordRecord { passwordSalt?: string; passwordHash?: string; }
export async function hashPassword(password: string, salt?: string) { validatePassword(password); const passwordSalt = salt || randomBytes(16).toString("hex"); const derived = await scrypt(password, passwordSalt, 64) as Buffer; return { passwordSalt, passwordHash: derived.toString("hex") }; }
export async function verifyPassword(password: string, record: PasswordRecord) { if (!record.passwordSalt || !record.passwordHash) return false; const candidate = await scrypt(password, record.passwordSalt, 64) as Buffer; const expected = Buffer.from(record.passwordHash, "hex"); return candidate.length === expected.length && timingSafeEqual(candidate, expected); }
export function validatePassword(password: string) { if (password.length < 6) throw new Error("访问密码至少需要 6 个字符。"); }
export function createSessionKey() { return randomBytes(64).toString("hex"); }
const TTL = 30 * 24 * 60 * 60 * 1000;
export class PersistentSessionStore {
  private revoked = new Map<string, number>();
  constructor(private readonly record: () => PasswordRecord & { sessionKey?: string }) {}
  create() { const key = this.key(); if (!key) throw new Error("访问密码尚未设置。"); const payload = Buffer.from(JSON.stringify({ v: 1, e: Date.now() + TTL, n: randomBytes(16).toString("base64url") })).toString("base64url"); return `${payload}.${this.sign(payload, key)}`; }
  has(token?: string) { const decoded = this.decode(token); return Boolean(token && decoded && decoded.e > Date.now() && !this.revoked.has(token)); }
  delete(token?: string) { const decoded = this.decode(token); if (token && decoded && decoded.e > Date.now()) this.revoked.set(token, decoded.e); }
  private key() { const secret = this.record().sessionKey || this.record().passwordHash; return secret && /^[a-f0-9]{128}$/i.test(secret) ? Buffer.from(secret, "hex") : null; }
  private sign(payload: string, key: Buffer) { return createHmac("sha256", key).update(payload).digest("base64url"); }
  private decode(token?: string): { v: number; e: number; n: string } | null { if (!token || token.length > 1024) return null; const split = token.lastIndexOf("."); const key = this.key(); if (!key || split < 1) return null; const payload = token.slice(0, split); const given = Buffer.from(token.slice(split + 1)); const expected = Buffer.from(this.sign(payload, key)); if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null; try { const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return data?.v === 1 && Number.isSafeInteger(data.e) && typeof data.n === "string" ? data : null; } catch { return null; } }
}
export class LoginRateLimiter { private states = new Map<string, { failures: number[]; blockedUntil?: number }>(); canAttempt(key: string) { const now = Date.now(); const state = this.states.get(key); if (!state || !state.blockedUntil || state.blockedUntil <= now) return { allowed: true }; return { allowed: false, retryAfterSeconds: Math.ceil((state.blockedUntil - now) / 1000) }; } failure(key: string) { const now = Date.now(); const state = this.states.get(key) || { failures: [] }; state.failures = state.failures.filter((time) => now - time < 900000); state.failures.push(now); if (state.failures.length >= 5) state.blockedUntil = now + 900000; this.states.set(key, state); } success(key: string) { this.states.delete(key); } }
