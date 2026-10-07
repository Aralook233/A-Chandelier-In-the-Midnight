import {
  findUser,
  isPersistable,
  isSessionRevoked,
  mutateUsers,
  readUsers,
  revokeSession,
  toPublicUser,
  writeUsers,
  MAX_PERSISTED_USERS,
} from '../_lib/accounts.js';
import {
  bucketIdentity,
  clientIdentity,
  hashPassword,
  isAllowedOrigin,
  jsonResponse,
  parseCookies,
  rateLimit,
  readJsonBody,
  sanitizeText,
  sessionCookie,
  signSession,
  verifyPassword,
  verifySession,
} from '../_lib/security.js';

const SESSION_TTL = 60 * 60 * 24;
const REMEMBER_TTL = 60 * 60 * 24 * 30;
const USERNAME_LENGTH = 24;
const DISPLAY_LENGTH = 24;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const MAX_SIGNUPS_PER_IP = 5;
const SIGNUP_WINDOW_SECONDS = 60 * 60;

// Login and registration each run a PBKDF2 derivation in the worker, so request
// cost is set by the iteration count rather than by payload size. Rotating
// usernames opens a fresh per-username bucket every time; this per-client budget
// is what actually caps the CPU an attacker can buy.
const AUTH_WINDOW_SECONDS = 900;
const MAX_DERIVATIONS_PER_IP = 60;

async function sessionFromRequest(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const session = await verifySession(env, cookies.session || '');
  if (!session) return null;

  // Revocation and identity come from two independent KV reads; awaiting them in
  // series puts a second round trip in front of every authenticated request.
  const [revoked, record] = await Promise.all([
    isSessionRevoked(env, session),
    findUser(env, session.username),
  ]);
  if (revoked) return null;

  // Identity comes from storage, never from the cookie payload.
  if (!record) return null;
  if (String(record.username).toLowerCase() !== session.username.toLowerCase()) return null;

  return { session, record };
}

function tooMany(limit) {
  return jsonResponse(
    { error: `尝试次数过多，请在 ${limit.retryAfter} 秒后重试。` },
    429,
    { 'Retry-After': String(limit.retryAfter) },
  );
}

/** Distinguishes "no KV bound" from "KV refused the write". */
function warningFor(persisted, env) {
  if (persisted) return undefined;
  return env && env.AUTH_STORE
    ? '账号未能写入存储，下次登录可能失败。'
    : '未配置 AUTH_STORE，当前仅在本地回退模式下保存。';
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  if (method === 'GET') {
    const match = await sessionFromRequest(request, env);
    if (!match) return jsonResponse({ ok: true, user: null });

    return jsonResponse({
      ok: true,
      user: toPublicUser(match.record),
      expiresAt: new Date(match.session.expiresAt).toISOString(),
    });
  }

  if (method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (!isAllowedOrigin(request)) {
    return jsonResponse({ error: '跨站请求已被拒绝。' }, 403);
  }

  const parsed = await readJsonBody(request);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);
  const body = parsed.data;

  const action = String(body?.action || 'login').toLowerCase();
  if (action !== 'login' && action !== 'register' && action !== 'logout') {
    return jsonResponse({ error: '未知的操作类型。' }, 400);
  }

  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const currentSession = await verifySession(env, cookies.session || '');

  if (action === 'logout') {
    let limit = null;
    if (!currentSession) {
      // An anonymous client must not use the logout budget as a free pass: its
      // attempts are counted in the same `auth` namespace as login.
      limit = await rateLimit(env && env.AUTH_STORE, 'auth', await bucketIdentity(env, clientIdentity(request)), 8, AUTH_WINDOW_SECONDS);
    }
    const limited = Boolean(limit && !limit.allowed);

    // Revocation kills a stolen token server-side even though we can only
    // clear the cookie here; without a store it degrades to cookie clearing.
    if (currentSession) await revokeSession(env, currentSession);

    return jsonResponse(
      { ok: true, warning: limited ? '尝试次数过多。' : undefined },
      limited ? 429 : 200,
      {
        'Set-Cookie': sessionCookie('', 0),
        ...(limited ? { 'Retry-After': String(limit.retryAfter || 1) } : {}),
      },
    );
  }

  const username = sanitizeText(body?.username, USERNAME_LENGTH);
  const password = typeof body?.password === 'string' ? body.password.slice(0, MAX_PASSWORD) : '';

  if (!username || !password) {
    return jsonResponse({ error: '用户名和密码不能为空。' }, 400);
  }

  const normalizedUsername = username.toLowerCase();
  // Both identities are digested before they reach a KV key, so neither the
  // client IP nor the attempted username is ever stored in plain text.
  const ipBucket = await bucketIdentity(env, clientIdentity(request));
  const authBucket = await bucketIdentity(env, `${clientIdentity(request)}:${normalizedUsername}`);
  const limit = await rateLimit(env && env.AUTH_STORE, 'auth', authBucket, action === 'register' ? 3 : 8, AUTH_WINDOW_SECONDS);
  if (!limit.allowed) return tooMany(limit);

  // Checked before the username is looked up: a throttled client must get the
  // same answer whether or not the name it guessed exists.
  const derivationQuota = await rateLimit(env && env.AUTH_STORE, 'derive', ipBucket, MAX_DERIVATIONS_PER_IP, AUTH_WINDOW_SECONDS);
  if (!derivationQuota.allowed) return tooMany(derivationQuota);

  const users = await readUsers(env);

  if (action === 'register') {
    const signupQuota = await rateLimit(env && env.AUTH_STORE, 'signup-ip', ipBucket, MAX_SIGNUPS_PER_IP, SIGNUP_WINDOW_SECONDS);
    if (!signupQuota.allowed) return tooMany(signupQuota);

    if (users.some((user) => String(user.username).toLowerCase() === normalizedUsername)) {
      return jsonResponse({ error: '该用户名已被注册。' }, 409);
    }

    if (password.length < MIN_PASSWORD) {
      return jsonResponse({ error: `密码至少需要 ${MIN_PASSWORD} 位字符。` }, 400);
    }

    // writeUsers truncates to the storage ceiling, so accepting a registration
    // past it would hand out a session for an account that was never stored.
    const persistedCount = users.filter(isPersistable).length;
    if (env && env.AUTH_STORE && persistedCount >= MAX_PERSISTED_USERS) {
      return jsonResponse({ error: '注册用户数已达上限，暂时无法注册。' }, 503);
    }

    const record = {
      username,
      displayName: sanitizeText(body?.displayName || username, DISPLAY_LENGTH, username),
      role: 'member',
      ...(await hashPassword(password, env)),
    };

    // mutateUsers retries internally, re-checking the freshest stored list each
    // time, so a racing registration loses instead of overwriting the winner.
    let persisted = false;
    let duplicate = false;
    if (env && env.AUTH_STORE) {
      try {
        persisted = (await mutateUsers(env, (stored) => {
          if (stored.some((user) => String(user.username).toLowerCase() === normalizedUsername)) {
            throw new Error('duplicate username');
          }
          return [...stored, record];
        })) !== null;
      } catch {
        duplicate = true;
      }
    } else {
      persisted = await writeUsers(env, [...users, record]);
    }

    if (duplicate) {
      return jsonResponse({ error: '该用户名已被注册。' }, 409);
    }

    if (!persisted && env && env.AUTH_STORE) {
      const latest = await findUser(env, username);
      if (latest) return jsonResponse({ error: '该用户名已被注册。' }, 409);
      // Every conditional swap was lost: fall back to a best-effort plain write.
      persisted = await writeUsers(env, [...users, record]);
    }

    const ttl = body?.remember === true ? REMEMBER_TTL : SESSION_TTL;
    const token = await signSession(env, { username: record.username, displayName: record.displayName }, ttl);

    return jsonResponse(
      {
        ok: true,
        user: toPublicUser(record),
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        warning: warningFor(persisted, env),
      },
      200,
      { 'Set-Cookie': sessionCookie(token, ttl) },
    );
  }

  const match = users.find((user) => String(user.username).toLowerCase() === normalizedUsername);

  // A real derivation runs in both branches: answering instantly for an
  // unknown username would let response time confirm the account exists.
  const passwordOk = match ? await verifyPassword(password, match) : (await hashPassword(password, env), false);

  if (!match || !passwordOk) {
    // Same message for unknown user and wrong password: no account enumeration.
    return jsonResponse({ error: '用户名或密码错误。' }, 401);
  }

  const record = match;

  // Session rotation: any token issued before this login is invalidated, so a
  // pre-auth session id can never be reused after credentials are proved.
  if (currentSession) await revokeSession(env, currentSession);

  const ttl = body?.remember === true ? REMEMBER_TTL : SESSION_TTL;
  const token = await signSession(
    env,
    {
      username: sanitizeText(record.username, USERNAME_LENGTH, ''),
      displayName: sanitizeText(record.displayName || record.username, DISPLAY_LENGTH, '读者'),
    },
    ttl,
  );

  return jsonResponse({ ok: true, user: toPublicUser(record), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }, 200, {
    'Set-Cookie': sessionCookie(token, ttl),
  });
}
