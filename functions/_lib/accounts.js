// Account storage shared by the auth endpoint and the discussion endpoint.
// Files under functions/_lib are excluded from Pages Functions routing.

import { sanitizeText } from './security.js';

const USERNAME_LENGTH = 24;
const DISPLAY_LENGTH = 24;
const REVOCATION_TTL = 60 * 60 * 24 * 30;

// Single KV key holds the whole list, so the list has a hard ceiling. Registration
// refuses when it is full instead of writing a record that slice() would drop.
export const MAX_PERSISTED_USERS = 200;

export function toPublicUser(record) {
  if (!record) return null;
  return {
    username: sanitizeText(record.username, USERNAME_LENGTH, ''),
    displayName: sanitizeText(record.displayName || record.username, DISPLAY_LENGTH, '读者'),
    role: record.role === 'admin' ? 'admin' : 'member',
  };
}

/**
 * Bootstrap administrator, provided through environment variables only. It is
 * never written to KV, so no password is stored in plaintext anywhere.
 */
export function seedUser(env) {
  const username = env && env.ADMIN_USERNAME;
  const password = env && env.ADMIN_PASSWORD;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return null;

  return {
    username: sanitizeText(username, USERNAME_LENGTH, ''),
    displayName: sanitizeText(username, USERNAME_LENGTH, ''),
    role: 'admin',
    password,
    seed: true,
  };
}

/** Only hashed, non-seeded accounts belong in KV; the seed admin stays in env. */
export function isPersistable(record) {
  return Boolean(record && !record.seed && record.passwordHash && record.salt);
}

function parseUsers(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Rows written before hashing stored passwords in plaintext. They are
    // unreadable to the login path on purpose, and serializeUsers omits them,
    // so the first write erases them from storage.
    return parsed.filter((item) => item && item.username && item.passwordHash && item.salt);
  } catch {
    return [];
  }
}

function serializeUsers(users) {
  return users.filter(isPersistable).slice(0, MAX_PERSISTED_USERS).map((record) => ({
    username: sanitizeText(record.username, USERNAME_LENGTH, ''),
    displayName: sanitizeText(record.displayName || record.username, DISPLAY_LENGTH, '读者'),
    role: record.role === 'admin' ? 'admin' : 'member',
    passwordHash: record.passwordHash,
    salt: record.salt,
    iterations: record.iterations,
  }));
}

async function listStoredUsers(env) {
  if (!env || !env.AUTH_STORE) return [];

  try {
    return parseUsers(await env.AUTH_STORE.get('users'));
  } catch {
    return [];
  }
}

export async function readUsers(env) {
  const stored = await listStoredUsers(env);
  const admin = seedUser(env);

  if (admin && !stored.some((user) => String(user.username).toLowerCase() === admin.username.toLowerCase())) {
    return [admin, ...stored];
  }

  return stored;
}

export async function findUser(env, username) {
  if (!username) return null;
  const users = await readUsers(env);
  const normalized = String(username).toLowerCase();
  return users.find((user) => String(user.username).toLowerCase() === normalized) || null;
}

export async function writeUsers(env, users) {
  if (!env || !env.AUTH_STORE) return false;

  try {
    await env.AUTH_STORE.put('users', JSON.stringify(serializeUsers(users)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare-and-swap write for the users list: the put only lands if the stored
 * value is still `previousRaw`, so concurrent registrations fail instead of
 * silently clobbering each other.
 */
async function writeUsersCas(env, users, previousRaw) {
  if (!env || !env.AUTH_STORE) return false;

  const payload = JSON.stringify(serializeUsers(users));
  try {
    if (previousRaw === null) {
      await env.AUTH_STORE.put('users', payload, { onlyIf: { exists: false } });
    } else {
      // `equals` is the compare-and-swap operator. An unrecognized key here makes
      // every conditional put throw, which silently downgrades to a plain write.
      await env.AUTH_STORE.put('users', payload, { onlyIf: { equals: previousRaw } });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-modify-write with bounded CAS retries. The mutated list and the raw value
 * it was built from come from the same read, otherwise the swap compares against
 * a document the change was not based on.
 *
 * Returns the persisted list, or null when every swap was lost and the caller
 * must re-check its own assumptions.
 */
export async function mutateUsers(env, mutate) {
  if (!env || !env.AUTH_STORE) return null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await env.AUTH_STORE.get('users');
    const users = mutate(parseUsers(raw));
    if (await writeUsersCas(env, users, raw ?? null)) return users;
  }

  return null;
}

/**
 * Logout revocation: a signed token is valid until its expiry on its own, so a
 * logged-out (or rotated) session id is blacklisted in KV until it would age
 * out anyway. Without a store, logout still clears the cookie.
 */
export async function revokeSession(env, session) {
  const store = env && (env.SESSION_STORE || env.AUTH_STORE);
  if (!store || !session || typeof session.tokenId !== 'string' || !session.tokenId) return false;

  const ttl = Math.max(60, Math.min(REVOCATION_TTL, Math.ceil((session.expiresAt - Date.now()) / 1000)));
  try {
    await store.put(`revoked:${session.tokenId}`, '1', { expirationTtl: ttl });
    return true;
  } catch {
    return false;
  }
}

export async function isSessionRevoked(env, session) {
  const store = env && (env.SESSION_STORE || env.AUTH_STORE);
  if (!store || !session) return false;
  if (typeof session.tokenId !== 'string' || !session.tokenId) return false;

  try {
    return (await store.get(`revoked:${session.tokenId}`)) !== null;
  } catch {
    // Failing closed on a store error would lock users out of a healthy
    // session; the token itself already verified, so allow it.
    return false;
  }
}
