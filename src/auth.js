import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { id, loadDb, transact } from "./store.js";

// RazeKit DEV's own accounts.
//
// DEV used to trust a principal minted by the RazeKit marketplace
// (RAZEKIT_PRINCIPAL_SECRET), so the marketplace had to be up for anyone to
// reach DEV and a marketplace secret could impersonate any DEV tenant. Identity
// now lives here: an email, a scrypt password hash, and server-side sessions
// whose tokens are stored only as hashes.
//
// Two modes, chosen explicitly:
//
//   session  Production. Every identified request carries a session cookie (or
//            a bearer token) that resolves to a stored, unexpired session.
//   local    Local development and the test suite: identity comes from the
//            x-razekit-tenant-id / x-razekit-user-id headers, unauthenticated.
//            Refused when NODE_ENV=production, the same way the JSON store is.

const scrypt = promisify(scryptCallback);

export const ROLES = Object.freeze({ OWNER: "owner", ADMIN: "admin", MEMBER: "member" });
export const AUTH_MODES = Object.freeze({ SESSION: "session", LOCAL: "local" });
export const SESSION_COOKIE = "rk_session";

// N=2^15 costs ~50 ms and 32 MiB per hash: slow enough to make offline guessing
// expensive, cheap enough that a login is not a denial-of-service lever.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;

// Unknown emails still pay for one hash, so response time does not reveal
// whether an account exists.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86);

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function authMode() {
  const mode = process.env.RAZEKIT_AUTH_MODE
    || (process.env.NODE_ENV === "production" ? AUTH_MODES.SESSION : AUTH_MODES.LOCAL);
  if (!Object.values(AUTH_MODES).includes(mode)) {
    throw new Error("RAZEKIT_AUTH_MODE must be session or local, not " + mode);
  }
  return mode;
}

/** Called at startup: a deployment must never accept header-asserted identities. */
export function assertProductionAuth() {
  if (process.env.NODE_ENV === "production" && authMode() !== AUTH_MODES.SESSION) {
    throw new Error("Production requires RAZEKIT_AUTH_MODE=session; local mode trusts identity headers");
  }
}

function sessionTtlMs() {
  const hours = Number(process.env.RAZEKIT_SESSION_TTL_HOURS || 168);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) {
    throw new Error("RAZEKIT_SESSION_TTL_HOURS must be between 1 and 2160");
  }
  return hours * 60 * 60_000;
}

export function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AuthError(400, "A valid email address is required");
  }
  return value;
}

function assertPassword(password) {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN) throw new AuthError(400, "Password must be at least " + PASSWORD_MIN + " characters");
  if (value.length > PASSWORD_MAX) throw new AuthError(400, "Password must be at most " + PASSWORD_MAX + " characters");
  return value;
}

export async function hashPassword(password) {
  const value = assertPassword(password);
  const salt = randomBytes(16);
  const hash = await scrypt(value, salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), Buffer.from(hash).toString("base64url")].join("$");
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltText, hashText] = parts;
  const expected = Buffer.from(hashText, "base64url");
  const actual = Buffer.from(await scrypt(String(password ?? ""), Buffer.from(saltText, "base64url"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem
  }));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    tenantId: user.tenantId,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

function newTenant(tenantId, now) {
  return {
    id: tenantId,
    status: "active",
    limits: { maxActiveTasks: 5, commandsPerMinute: 30, toolCallsPerMinute: 120, spendPerHour: 100 },
    createdAt: now,
    updatedAt: now
  };
}

export async function countUsers() {
  const db = await loadDb();
  return db.users.length;
}

/**
 * Creates an account with the role asked for. The owner is created only by
 * bootstrapOwner, and only on an empty deployment.
 */
export async function createUser({ email, password, role = ROLES.MEMBER, tenantId = null, requireEmpty = false } = {}) {
  const normalized = normalizeEmail(email);
  const passwordHash = await hashPassword(password);
  if (!Object.values(ROLES).includes(role)) throw new AuthError(400, "Unknown role: " + role);
  return transact(db => {
    // Checked inside the transaction, so two simultaneous bootstraps cannot
    // both find the deployment empty.
    if (requireEmpty && db.users.length > 0) throw new AuthError(409, "This deployment already has an owner");
    // There is exactly one owner: the first account.
    if (role === ROLES.OWNER && db.users.length > 0) throw new AuthError(400, "This deployment already has an owner");
    if (db.users.some(user => user.email === normalized)) {
      throw new AuthError(409, "An account with that email already exists");
    }
    const now = new Date().toISOString();
    const user = {
      id: id("user"),
      email: normalized,
      passwordHash,
      role,
      tenantId: tenantId || id("tenant"),
      status: "active",
      createdAt: now,
      lastLoginAt: null
    };
    if (!db.tenants.some(tenant => tenant.id === user.tenantId)) db.tenants.push(newTenant(user.tenantId, now));
    db.users.push(user);
    return publicUser(user);
  });
}

// Failed sign-ins per email, in memory. A restart forgets them, which only
// lets an attacker try again at the same slow scrypt rate; it never lets
// anyone in.
const failures = new Map();
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_THRESHOLD = 10;

function recentFailures(email, now) {
  const list = (failures.get(email) || []).filter(at => now - at < LOCKOUT_WINDOW_MS);
  failures.set(email, list);
  return list;
}

export function resetLoginFailures() {
  failures.clear();
}

export async function login({ email, password } = {}) {
  const normalized = normalizeEmail(email);
  const now = Date.now();
  if (recentFailures(normalized, now).length >= LOCKOUT_THRESHOLD) {
    throw new AuthError(429, "Too many failed sign-ins; try again in 15 minutes");
  }
  const db = await loadDb();
  const user = db.users.find(item => item.email === normalized);
  const ok = await verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) {
    recentFailures(normalized, now).push(now);
    throw new AuthError(401, "Email or password is incorrect");
  }
  if (user.status !== "active") throw new AuthError(403, "This account is disabled");
  failures.delete(normalized);
  return createSession(user.id);
}

/** Returns the raw token exactly once; only its hash is stored. */
export async function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const ttl = sessionTtlMs();
  const session = await transact(db => {
    const user = db.users.find(item => item.id === userId);
    if (!user) throw new AuthError(404, "User not found");
    const now = new Date();
    user.lastLoginAt = now.toISOString();
    const record = {
      id: id("session"),
      tokenHash: tokenHash(token),
      userId: user.id,
      tenantId: user.tenantId,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString()
    };
    // Expired sessions are pruned whenever a new one is written, so the
    // collection cannot grow without bound.
    db.sessions = db.sessions.filter(item => Date.parse(item.expiresAt) > now.getTime());
    db.sessions.push(record);
    return { record, user: publicUser(user) };
  });
  return { token, expiresAt: session.record.expiresAt, user: session.user };
}

export async function resolveSession(token) {
  if (!token) return null;
  const hash = tokenHash(token);
  const db = await loadDb();
  const session = db.sessions.find(item => item.tokenHash === hash);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
  const user = db.users.find(item => item.id === session.userId);
  if (!user || user.status !== "active") return null;
  return { sessionId: session.id, user: publicUser(user) };
}

export async function revokeSession(token) {
  if (!token) return false;
  const hash = tokenHash(token);
  return transact(db => {
    const before = db.sessions.length;
    db.sessions = db.sessions.filter(item => item.tokenHash !== hash);
    return db.sessions.length !== before;
  });
}

export async function revokeUserSessions(userId) {
  return transact(db => {
    const before = db.sessions.length;
    db.sessions = db.sessions.filter(item => item.userId !== userId);
    return before - db.sessions.length;
  });
}

export async function changePassword(userId, { currentPassword, newPassword } = {}) {
  const db = await loadDb();
  const user = db.users.find(item => item.id === userId);
  if (!user) throw new AuthError(404, "User not found");
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new AuthError(401, "Current password is incorrect");
  const passwordHash = await hashPassword(newPassword);
  await transact(next => {
    const target = next.users.find(item => item.id === userId);
    target.passwordHash = passwordHash;
    // A password change ends every other session for the account.
    next.sessions = next.sessions.filter(item => item.userId !== userId);
  });
  return createSession(userId);
}

export async function listUsers() {
  const db = await loadDb();
  return db.users.map(publicUser);
}

export async function setUserStatus(userId, status) {
  if (!["active", "disabled"].includes(status)) throw new AuthError(400, "status must be active or disabled");
  return transact(db => {
    const user = db.users.find(item => item.id === userId);
    if (!user) throw new AuthError(404, "User not found");
    if (user.role === ROLES.OWNER && status !== "active") throw new AuthError(400, "The owner account cannot be disabled");
    user.status = status;
    if (status !== "active") db.sessions = db.sessions.filter(item => item.userId !== userId);
    return publicUser(user);
  });
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

export function sessionTokenFromRequest(headers = {}) {
  const authorization = String(headers.authorization || "");
  if (/^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, "").trim() || null;
  return parseCookies(headers.cookie)[SESSION_COOKIE] || null;
}

function secureCookies() {
  return process.env.RAZEKIT_COOKIE_SECURE
    ? process.env.RAZEKIT_COOKIE_SECURE === "true"
    : process.env.NODE_ENV === "production";
}

export function sessionCookie(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return [
    SESSION_COOKIE + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + maxAge,
    secureCookies() ? "Secure" : null
  ].filter(Boolean).join("; ");
}

export function clearedSessionCookie() {
  return [SESSION_COOKIE + "=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", secureCookies() ? "Secure" : null]
    .filter(Boolean).join("; ");
}

/**
 * Bootstrap: creates the owner on an empty deployment, and only then. Requires
 * RAZEKIT_BOOTSTRAP_TOKEN, compared in constant time, so the first visitor to a
 * fresh deployment cannot claim it.
 */
export async function bootstrapOwner({ token, email, password } = {}) {
  const expected = process.env.RAZEKIT_BOOTSTRAP_TOKEN || "";
  const supplied = Buffer.from(String(token || ""));
  const wanted = Buffer.from(expected);
  if (expected.length < 24 || supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    throw new AuthError(403, "Bootstrap is not available");
  }
  return createUser({ email, password, role: ROLES.OWNER, requireEmpty: true });
}
