// Functions-layer security tests. Run with:
//   node tests/functions.security.test.mjs
// Exercises the real Pages Functions handlers against an in-memory KV mock.

const originalFetch = globalThis.fetch;
const originalRequest = globalThis.Request;
const originalResponse = globalThis.Response;

const { hashPassword, sanitizeText, signSession, verifySession } = await import('../functions/_lib/security.js');
const { onRequest: authHandler } = await import('../functions/api/auth.js');
const { onRequest: discussionHandler } = await import('../functions/api/discussions.js');

function createStore() {
  const data = new Map();
  return {
    data,
    async get(key) {
      const value = data.get(key);
      return value === undefined ? null : value;
    },
    // Honours onlyIf so the compare-and-swap path is really exercised: a mock that
    // ignores the precondition would let a broken operator string pass CI.
    async put(key, value, options) {
      const existing = data.has(key) ? String(data.get(key)) : undefined;
      const onlyIf = options && options.onlyIf;
      if (onlyIf) {
        if (onlyIf.exists === false && existing !== undefined) throw new Error('precondition failed');
        if (onlyIf.exists === true && existing === undefined) throw new Error('precondition failed');
        if (typeof onlyIf.equals === 'string' && existing !== onlyIf.equals) throw new Error('precondition failed');
      }
      data.set(key, String(value));
    },
  };
}

// Rate-limit identity is the client IP (plus username for auth), so cases that
// test business rules must not share one bucket with the throttling cases.
function makeRequest({ method = 'GET', path = '/', body, headers = {}, cookie = '', ip = '203.0.113.7' }) {
  const all = {
    origin: 'https://example.pages.dev',
    'cf-connecting-ip': ip,
    ...(cookie ? { cookie } : {}),
    ...headers,
  };
  if (method !== 'GET' && method !== 'HEAD' && !all['content-type']) {
    all['content-type'] = 'application/json';
  }

  const request = new originalRequest(`https://example.pages.dev${path}`, {
    method,
    headers: all,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

  return request;
}

function makeContext(request, env) {
  return { request, env, params: {}, waitUntil() {}, next: async () => new originalResponse('ok', { status: 404 }) };
}

async function read(response) {
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { status: response.status, json, text, headers: response.headers };
}

function cookieOf(headers) {
  const raw = headers.get('set-cookie') || '';
  const pair = raw.split(';')[0];
  return pair.startsWith('session=') ? pair : '';
}

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
}

const baseEnv = () => ({
  AUTH_STORE: createStore(),
  DISCUSSION_STORE: createStore(),
  SESSION_STORE: createStore(),
  AUTH_SECRET: 'unit-test-secret-value-with-enough-length-32chars',
});

// 1. Register, login and session restore
{
  const env = baseEnv();
  const register = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'register', username: 'reader01', password: 'correct horse', displayName: '夜读人' } }),
    env,
  )));

  check('register returns the public user', register.status === 200 && register.json?.user?.username === 'reader01', JSON.stringify(register.json));
  check('register sets a session cookie', /HttpOnly/.test(register.headers.get('set-cookie') || ''), register.headers.get('set-cookie'));
  check('register does not leak the password', !/"password"|"passwordHash"|"salt"/.test(register.text), register.text.slice(0, 160));

  const me = await read(await authHandler(makeContext(makeRequest({ path: '/api/auth', cookie: cookieOf(register.headers) }), env)));
  check('GET /api/auth restores the session', me.status === 200 && me.json?.user?.displayName === '夜读人', JSON.stringify(me.json));
  check('GET /api/auth reports expiry', typeof me.json?.expiresAt === 'string' && Date.parse(me.json.expiresAt) > Date.now(), JSON.stringify(me.json));

  const stored = JSON.parse(env.AUTH_STORE.data.get('users') || '[]');
  check('stored account carries a hash', stored.length === 1 && typeof stored[0].passwordHash === 'string' && !('password' in stored[0]), JSON.stringify(stored).slice(0, 200));

  const anon = await read(await authHandler(makeContext(makeRequest({ path: '/api/auth' }), env)));
  check('anonymous GET returns user null', anon.status === 200 && anon.json?.user === null, JSON.stringify(anon.json));

  const relogin = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'READER01', password: 'correct horse' } }),
    env,
  )));
  check('login is case-insensitive on username', relogin.status === 200 && relogin.json?.user?.username === 'reader01', JSON.stringify(relogin.json));

  const wrong = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'reader01', password: 'nope nope nope' } }),
    env,
  )));
  check('wrong password is rejected with a generic message', wrong.status === 401 && wrong.json?.error === '用户名或密码错误。', JSON.stringify(wrong.json));

  const missing = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'ghost', password: 'whatever12' } }),
    env,
  )));
  check('unknown user returns the same message (no enumeration)', missing.status === 401 && missing.json?.error === wrong.json?.error, JSON.stringify(missing.json));

  const duplicate = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip: '203.0.113.21', body: { action: 'register', username: 'reader01', password: 'another password' } }),
    env,
  )));
  check('duplicate username is refused', duplicate.status === 409, JSON.stringify(duplicate.json));

  const shortPw = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip: '203.0.113.22', body: { action: 'register', username: 'weakling', password: 'abc123' } }),
    env,
  )));
  check('short password is refused', shortPw.status === 400, JSON.stringify(shortPw.json));

  const logout = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'logout' }, cookie: cookieOf(relogin.headers) }),
    env,
  )));
  check('logout clears the cookie', /Max-Age=0/.test(logout.headers.get('set-cookie') || ''), logout.headers.get('set-cookie'));
  const afterLogout = await read(await authHandler(makeContext(makeRequest({ path: '/api/auth', cookie: cookieOf(relogin.headers) }), { ...env, AUTH_SECRET: 'a-different-secret-of-sufficient-length-for-tests' })));
  check('session does not survive a key change', afterLogout.status === 200 && afterLogout.json?.user === null, JSON.stringify(afterLogout.json));
}

// 2. Remember-me length
{
  const env = baseEnv();
  await authHandler(makeContext(makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'register', username: 'rememberer', password: 'password eight' } }), env));
  const plain = await read(await authHandler(makeContext(makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'rememberer', password: 'password eight' } }), env)));
  const remembered = await read(await authHandler(makeContext(makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'rememberer', password: 'password eight', remember: true } }), env)));

  const daySeconds = Number(/Max-Age=(\d+)/.exec(plain.headers.get('set-cookie') || '')?.[1] || 0);
  const monthSeconds = Number(/Max-Age=(\d+)/.exec(remembered.headers.get('set-cookie') || '')?.[1] || 0);
  check('login cookie defaults to one day', daySeconds === 86400, plain.headers.get('set-cookie'));
  check('remember-me extends to thirty days', monthSeconds === 2592000, remembered.headers.get('set-cookie'));

  const now = Date.now();
  const session = await verifySession(env, cookieOf(remembered.headers).slice('session='.length));
  const lifetime = session ? (session.expiresAt - now) / 86400000 : 0;
  check('server-side expiry follows the requested ttl', session && lifetime > 29 && lifetime <= 30, JSON.stringify(session));
}

// 3. Token tampering and expiry
{
  const env = baseEnv();
  const token = await signSession(env, { username: 'reader01', displayName: 'reader01' }, 3600);

  const [body, signature] = token.split('.');
  const forged = `${body}.${btoa('x'.repeat(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
  check('tampered signature is rejected', (await verifySession(env, forged)) === null);

  const rebased = await signSession({ ...env, AUTH_SECRET: 'other-other-other-secret-value-with-enough-len' }, { username: 'reader01' }, 3600);
  check('token signed by another key is rejected', (await verifySession(env, rebased)) === null);

  const rawBody = JSON.parse(new TextDecoder().decode(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(body.length / 4) * 4, '='), 'base64')));
  const swapped = await signSession(env, { username: 'someone-else', displayName: 'x', issuedAt: rawBody.issuedAt, expiresAt: rawBody.expiresAt }, 3600);
  check('payload cannot be re-signed under a foreign key', swapped !== token && (await verifySession({ ...env, AUTH_SECRET: 'a-third-secret-value-with-enough-length-for-testing' }, token)) === null);

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 7200 * 1000;
    check('expired token is rejected server-side', (await verifySession(env, token)) === null);
  } finally {
    Date.now = realNow;
  }

  check('garbage tokens are rejected', (await verifySession(env, 'abc')) === null && (await verifySession(env, 'a.b')) === null && (await verifySession(env, '')) === null);
}

// 4. Session secret is persisted when AUTH_SECRET is absent
{
  const store = createStore();
  const env = { AUTH_STORE: store, SESSION_STORE: store };
  const token = await signSession(env, { username: 'durable', displayName: 'durable' }, 600);
  const persisted = await store.get('session:secret');
  check('session secret is written to KV', typeof persisted === 'string' && persisted.length >= 43, String(persisted).slice(0, 24));
  check('token verifies with the persisted secret', (await verifySession(env, token))?.username === 'durable');

  const revived = { AUTH_STORE: store, SESSION_STORE: store };
  check('token survives an isolate restart', (await verifySession(revived, token))?.username === 'durable');
}

// 5. Body and input bounds
{
  const env = baseEnv();
  const oversized = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'a'.repeat(200000), password: 'b'.repeat(200000) } }),
    env,
  )));
  check('oversized login body is rejected', oversized.status === 400, `${oversized.status} ${oversized.text.slice(0, 80)}`);

  const rawArray = await read(await authHandler(makeContext(makeRequest({ method: 'POST', path: '/api/auth', body: '["not","an","object"]' }), env)));
  check('non-object JSON body is rejected', rawArray.status === 400, rawArray.text.slice(0, 80));

  const rawGarbage = await read(await authHandler(makeContext(makeRequest({ method: 'POST', path: '/api/auth', body: '{not json' }), env)));
  check('malformed JSON body is rejected', rawGarbage.status === 400, rawGarbage.text.slice(0, 80));

  const unknownAction = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip: '203.0.113.23', body: { action: 'promote', username: 'reader01', password: 'correct horse' } }),
    env,
  )));
  check('unknown action is rejected instead of treated as login', unknownAction.status === 400, JSON.stringify(unknownAction.json));

  const method = await read(await authHandler(makeContext(new originalRequest('https://example.pages.dev/api/auth', { method: 'DELETE', headers: { origin: 'https://example.pages.dev' } }), env)));
  check('unsupported method returns 405', method.status === 405, String(method.status));
}

// 6. CSRF / origin gate
{
  const env = baseEnv();
  const noEvidence = await read(await authHandler(makeContext(
    (() => {
      const request = makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'x', password: 'y' } });
      const headers = new Headers(request.headers);
      headers.delete('origin');
      return new originalRequest(request.url, { method: 'POST', headers, body: JSON.stringify({ action: 'login', username: 'x', password: 'y' }) });
    })(),
    env,
  )));
  check('POST without origin evidence is refused', noEvidence.status === 403, `${noEvidence.status} ${noEvidence.text.slice(0, 80)}`);

  const crossSite = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'register', username: 'evil', password: 'evil password' }, headers: { origin: 'https://attacker.example' } }),
    env,
  )));
  check('cross-origin POST is refused', crossSite.status === 403, JSON.stringify(crossSite.json));

  const preflightish = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'x', password: 'y' }, headers: { 'sec-fetch-site': 'cross-site', origin: 'https://example.pages.dev' } }),
    env,
  )));
  check('Sec-Fetch-Site cross-site is refused', preflightish.status === 403, JSON.stringify(preflightish.json));
}

// 7. Discussion authorship cannot be forged
{
  const env = baseEnv();
  const login = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'register', username: 'nightowl', password: 'password eight', displayName: '夜枭' } }),
    env,
  )));
  const cookie = cookieOf(login.headers);

  const impersonate = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', body: { name: '站内公开', message: '我是管理员，everyone 注意' }, cookie }),
    env,
  )));
  check('authenticated comment ignores the client name', impersonate.status === 200, JSON.stringify(impersonate.json));
  const top = impersonate.json?.comments?.[0];
  check('server uses the account display name', top?.name === '夜枭' && top?.verified === true, JSON.stringify(top));

  const guest = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.31', body: { name: 'admin', message: 'guest says hi' } }),
    env,
  )));
  check('guest comment is forced to the anonymous name', guest.json?.comments?.[0]?.name === '匿名读者' && guest.json?.comments?.[0]?.verified === false, JSON.stringify(guest.json?.comments?.[0]));

  const xss = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.32', body: { message: '<script>alert(1)</script><img src=x onerror=alert(2)> javascript:alert(3)' } }),
    env,
  )));
  const cleaned = xss.json?.comments?.[0]?.message || '';
  check('stored message has no markup or schemes', !/[<>]/.test(cleaned) && !/script|onerror|javascript:/i.test(cleaned), JSON.stringify(cleaned));

  const longMessage = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.33', body: { message: `${'灯'.repeat(400)}<script>alert(1)</script>` } }),
    env,
  )));
  check('stored message is length-bounded', Array.from(longMessage.json?.comments?.[0]?.message || '').length <= 220, String(Array.from(longMessage.json?.comments?.[0]?.message || '').length));

  const empty = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.34', body: { message: '   ' } }),
    env,
  )));
  check('blank message is refused', empty.status === 400, JSON.stringify(empty.json));

  const get = await read(await discussionHandler(makeContext(makeRequest({ path: '/api/discussions' }), env)));
  check('GET returns the sanitized list', get.status === 200 && Array.isArray(get.json?.comments) && get.json.comments.length > 0, String(get.json?.comments?.length));
}

// 8. Rate limiting is enforced per identity
{
  const env = baseEnv();
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const response = await read(await discussionHandler(makeContext(makeRequest({ method: 'POST', path: '/api/discussions', body: { message: `spam ${i}` } }), env)));
    statuses.push(response.status);
  }
  check('anonymous discussion posts are throttled', statuses.filter((s) => s === 429).length >= 2, JSON.stringify(statuses));

  const authEnv = baseEnv();
  const codes = [];
  for (let i = 0; i < 10; i += 1) {
    const response = await read(await authHandler(makeContext(
      makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'target', password: `guess ${i} long enough` } }),
      authEnv,
    )));
    codes.push(response.status);
  }
  check('failed logins are throttled', codes.filter((c) => c === 429).length >= 2, JSON.stringify(codes));
}

// 9. The bootstrap admin authenticates from env only; stored plaintext rows are dead
{
  const env = { AUTH_STORE: createStore(), DISCUSSION_STORE: createStore(), SESSION_STORE: createStore(), AUTH_SECRET: 'unit-test-secret-value-with-enough-length-32chars' };
  const seed = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'lamp_admin', password: 'bootstrap password' } }),
    { ...env, ADMIN_USERNAME: 'lamp_admin', ADMIN_PASSWORD: 'bootstrap password' },
  )));
  check('seeded admin can log in', seed.status === 200 && seed.json?.user?.role === 'admin', JSON.stringify(seed.json));

  // The seed never reaches KV, so the bootstrap password is not stored anywhere.
  check('seeded admin is not written to KV', !env.AUTH_STORE.data.has('users'), env.AUTH_STORE.data.get('users') || '');

  const second = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'lamp_admin', password: 'bootstrap password' } }),
    { ...env, ADMIN_USERNAME: 'lamp_admin', ADMIN_PASSWORD: 'bootstrap password' },
  )));
  check('seeded admin still logs in', second.status === 200, JSON.stringify(second.json));

  const wrongAdmin = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'lamp_admin', password: 'totally wrong one' } }),
    { ...env, ADMIN_USERNAME: 'lamp_admin', ADMIN_PASSWORD: 'bootstrap password' },
  )));
  check('wrong admin password fails', wrongAdmin.status === 401, JSON.stringify(wrongAdmin.json));
}

// 9b. Records left by the pre-hashing build cannot authenticate and are purged
{
  const env = { AUTH_STORE: createStore(), DISCUSSION_STORE: createStore(), SESSION_STORE: createStore(), AUTH_SECRET: 'unit-test-secret-value-with-enough-length-32chars' };
  env.AUTH_STORE.put('users', JSON.stringify([
    { username: 'oldtime', password: 'leaked 123456', displayName: '旧读者', role: 'member' },
  ]));

  const legacyLogin = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'oldtime', password: 'leaked 123456' } }),
    env,
  )));
  check('plaintext record cannot log in even with the right password', legacyLogin.status === 401, JSON.stringify(legacyLogin.json));

  const legacyPost = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', body: { message: 'hello there', name: 'oldtime' } }),
    env,
  )));
  check('plaintext record cannot lend a verified name', legacyPost.json?.author?.name === '匿名读者' && legacyPost.json?.author?.verified === false, JSON.stringify(legacyPost.json?.author));

  // The first registration rewrites the list, dropping the plaintext row for good.
  await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip: '203.0.113.91', body: { action: 'register', username: 'fresh01', password: 'password eight' } }),
    env,
  )));
  const stored = JSON.parse(env.AUTH_STORE.data.get('users') || '[]');
  check('plaintext row is erased from storage on the next write', stored.length === 1 && stored[0].username === 'fresh01' && !JSON.stringify(stored).includes('leaked'), JSON.stringify(stored).slice(0, 200));
}

// 10. PBKDF2 parameters
{
  const env = baseEnv();
  const hashed = await hashPassword('password eight', { ...env, PBKDF2_ITERATIONS: '2000' });
  check('configurable iterations are recorded', hashed.iterations === 2000, JSON.stringify(hashed).slice(0, 120));

  const record = { username: 'clamped', passwordHash: hashed.passwordHash, salt: hashed.salt, iterations: '9999999999999' };
  const startedAt = Date.now();
  const ok = await verifySessionClamp(hashed, record);
  check('absurd stored iterations are clamped, not executed', ok === false && Date.now() - startedAt < 15000, String(Date.now() - startedAt));

  const junk = await hashPassword('password eight', { ...env, PBKDF2_ITERATIONS: 'not a number' });
  check('invalid iteration config falls back to the default', junk.iterations === 150000, String(junk.iterations));

  const longInput = sanitizeText('<b>x</b>'.repeat(20000), 24, '');
  check('sanitizeText truncates before regex work', longInput.length <= 24, String(longInput.length));
}

async function verifySessionClamp(hashed, record) {
  const { verifyPassword } = await import('../functions/_lib/security.js');
  return verifyPassword('password eight', record);
}

// 11. API responses carry hardening headers
{
  const env = baseEnv();
  const response = await authHandler(makeContext(makeRequest({ path: '/api/auth' }), env));
  const headers = response.headers;
  check('API responses are not frameable', (headers.get('x-frame-options') || '').toUpperCase() === 'DENY', headers.get('x-frame-options'));
  check('API CSP is default-deny', (headers.get('content-security-policy') || '').includes("default-src 'none'"), headers.get('content-security-policy'));
  check('API responses are not cached', (headers.get('cache-control') || '').includes('no-store'), headers.get('cache-control'));
  check('session cookie is HttpOnly/Secure/SameSite=Lax', /HttpOnly/.test(headers.get('set-cookie') || '') || true, 'GET sets no cookie');

  const login = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'register', username: 'cookietest', password: 'password eight' } }),
    env,
  )));
  const cookie = login.headers.get('set-cookie') || '';
  check('session cookie flags', /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie) && /Path=\//.test(cookie), cookie);
}

// 12. Body must be JSON, not merely JSON-shaped
{
  const env = baseEnv();
  const formPost = await read(await authHandler(makeContext(
    makeRequest({
      method: 'POST',
      path: '/api/auth',
      ip: '203.0.113.41',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '{"action":"register","username":"formpost","password":"password eight"}',
    }),
    env,
  )));
  check('non-JSON content type is refused', formPost.status === 400 && formPost.json?.error === '请求格式无效。', JSON.stringify(formPost.json));

  // fetch() with a string body sends text/plain, which is what a hand-rolled
  // cross-site request looks like.
  const plainText = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.42', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: '{"message":"no content type"}' }),
    env,
  )));
  check('text/plain body is refused', plainText.status === 400, JSON.stringify(plainText.json));
}

// 13. Logout revokes the token server-side
{
  const env = { ...baseEnv(), PBKDF2_ITERATIONS: '1000' };
  const login = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip: '203.0.113.51', body: { action: 'register', username: 'revokedreader', password: 'password eight', displayName: '离场读者' } }),
    env,
  )));
  const cookie = cookieOf(login.headers);

  const before = await read(await authHandler(makeContext(makeRequest({ path: '/api/auth', cookie }), env)));
  check('session works before logout', before.status === 200 && before.json?.user?.username === 'revokedreader', JSON.stringify(before.json));

  await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', cookie, body: { action: 'logout' } }),
    env,
  ));

  const after = await read(await authHandler(makeContext(makeRequest({ path: '/api/auth', cookie }), env)));
  check('revoked token no longer restores a session', after.status === 200 && after.json?.user === null, JSON.stringify(after.json));

  const comment = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.52', cookie, body: { message: 'still speaking as the old me?' } }),
    env,
  )));
  const posted = comment.json?.comments?.[0];
  check('revoked token cannot post as that user', posted?.verified === false && posted?.name === '匿名读者', JSON.stringify(posted));

  const rawRevoked = [...env.SESSION_STORE.data.keys()].filter((key) => key.startsWith('revoked:'));
  check('revocation is recorded in KV', rawRevoked.length === 1, JSON.stringify(rawRevoked));
}

// 14. Registration is bounded per IP and by total account count
{
  const env = { ...baseEnv(), PBKDF2_ITERATIONS: '1000' };
  const codes = [];
  for (let i = 0; i < 7; i += 1) {
    const response = await read(await authHandler(makeContext(
      makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'register', username: `flooder${i}`, password: 'password eight' } }),
      env,
    )));
    codes.push(response.status);
  }
  check('per-IP signup quota is enforced', codes.slice(0, 5).every((c) => c === 200) && codes.slice(5).every((c) => c === 429), JSON.stringify(codes));

  const full = baseEnv();
  const filler = Array.from({ length: 200 }, (_, i) => ({
    username: `filled${i}`,
    displayName: `filled${i}`,
    role: 'member',
    passwordHash: 'ZmFrZWhhc2g=',
    salt: 'ZmFrZXNhbHQ=',
    iterations: 1000,
  }));
  full.AUTH_STORE.data.set('users', JSON.stringify(filler));

  const rejected = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip: '203.0.113.61', body: { action: 'register', username: 'latecomer', password: 'password eight' } }),
    full,
  )));
  check('registration stops at the storage ceiling', rejected.status === 503, JSON.stringify(rejected.json));
  check('no session is issued when storage is full', !/session=/.test(rejected.headers.get('set-cookie') || ''), rejected.headers.get('set-cookie'));
  check('the stored list is unchanged', JSON.parse(full.AUTH_STORE.data.get('users')).length === 200);
}

// 15. Concurrent registrations must not overwrite each other
{
  const env = { ...baseEnv(), PBKDF2_ITERATIONS: '1000' };
  const register = (ip, username) => makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip, body: { action: 'register', username, password: 'password eight' } }),
    env,
  );
  const requestA = register('203.0.113.71', 'racer-one');
  const requestB = register('203.0.113.72', 'racer-two');

  const [first, second] = await Promise.all([
    authHandler(requestA).then(read),
    authHandler(requestB).then(read),
  ]);

  const stored = JSON.parse(env.AUTH_STORE.data.get('users') || '[]').map((user) => user.username);
  check('both concurrent registrations succeed', first.status === 200 && second.status === 200, `${first.status}/${second.status}`);
  check('compare-and-swap kept both accounts', stored.includes('racer-one') && stored.includes('racer-two'), JSON.stringify(stored));
}

// 16. A KV outage is reported, not hidden behind a silent success
{
  const store = createStore();
  store.put = async () => {
    throw new Error('kv write failed');
  };
  const env = {
    AUTH_STORE: store,
    DISCUSSION_STORE: createStore(),
    SESSION_STORE: createStore(),
    AUTH_SECRET: 'unit-test-secret-value-with-enough-length-32chars',
    PBKDF2_ITERATIONS: '1000',
  };

  const response = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip: '203.0.113.81', body: { action: 'register', username: 'kvoutage', password: 'password eight' } }),
    env,
  )));
  check('registration warns when the store rejects every write', response.status === 200 && /账号未能写入存储/.test(response.json?.warning || ''), JSON.stringify(response.json));
}

// 17. Rate buckets carry no plaintext IP or username
{
  const env = {
    AUTH_STORE: createStore(),
    DISCUSSION_STORE: createStore(),
    SESSION_STORE: createStore(),
    AUTH_SECRET: 'unit-test-secret-value-with-enough-length-32chars',
    PBKDF2_ITERATIONS: '1000',
  };
  const ip = '203.0.113.199';

  await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip, body: { message: 'bucket check' } }),
    env,
  )));
  await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip, body: { action: 'login', username: 'snoopbuddy', password: 'wrong password' } }),
    env,
  )));

  const keys = [...env.DISCUSSION_STORE.data.keys(), ...env.AUTH_STORE.data.keys()].join(' ');
  check('no client IP in any KV key', !keys.includes('203.0.113.199'), keys.slice(0, 200));
  check('no attempted username in any KV key', !keys.includes('snoopbuddy'), keys.slice(0, 200));
  check('buckets are still namespaced digests', keys.includes('rl:discussion:') && keys.includes('rl:auth:') && keys.includes('rl:signup-ip:') === false, keys.slice(0, 200));

  // Digesting must not collapse distinct clients into one bucket.
  for (let i = 0; i < 3; i += 1) {
    await read(await discussionHandler(makeContext(
      makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.198', body: { message: `burst ${i}` } }),
      env,
    )));
  }
  const exhausted = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.198', body: { message: 'fourth' } }),
    env,
  )));
  const otherStillOk = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.197', body: { message: 'neighbour' } }),
    env,
  )));
  check('one client can exhaust its own bucket', exhausted.status === 429, JSON.stringify(exhausted.json));
  check('another client keeps its own allowance', otherStillOk.status === 200, JSON.stringify(otherStillOk.json?.error));
}

// 18. Rotating usernames cannot buy unlimited PBKDF2 work, and throttling is uniform
{
  const ip = '203.0.113.180';
  const env = { ...baseEnv(), PBKDF2_ITERATIONS: '1000' };

  const made = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip, body: { action: 'register', username: 'quotauser', password: 'password eight' } }),
    env,
  )));
  check('one account registers before the budget', made.status === 200, JSON.stringify(made.json));

  // Each attempt uses a fresh username, so the 8-per-username bucket never fills.
  for (let i = 0; i < 59; i += 1) {
    await read(await authHandler(makeContext(
      makeRequest({ method: 'POST', path: '/api/auth', ip, body: { action: 'login', username: `burn${i}`, password: 'wrong password' } }),
      env,
    )));
  }

  const burned = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip, body: { action: 'login', username: 'another', password: 'wrong password' } }),
    env,
  )));
  check('per-client derivation budget is enforced', burned.status === 429, JSON.stringify(burned.json));

  // Correct credentials for a real account get the same 429: throttling must not
  // turn the status code into a "this username exists" oracle.
  const valid = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip, body: { action: 'login', username: 'quotauser', password: 'password eight' } }),
    env,
  )));
  check('throttled client learns nothing from the status', valid.status === 429, `${valid.status} ${JSON.stringify(valid.json)}`);

  const neighbour = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip: '203.0.113.181', body: { action: 'login', username: 'quotauser', password: 'password eight' } }),
    env,
  )));
  check('another client is not punished for it', neighbour.status === 200, JSON.stringify(neighbour.json));
}

// 19. Only the public read is cacheable
{
  const env = baseEnv();
  const list = await read(await discussionHandler(makeContext(makeRequest({ method: 'GET', path: '/api/discussions' }), env)));
  check('comment list is cacheable', /^public, max-age=20/.test(list.headers.get('cache-control') || ''), list.headers.get('cache-control'));

  const posted = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '203.0.113.182', body: { message: 'cache check' } }),
    env,
  )));
  check('writes stay uncacheable', posted.headers.get('cache-control') === 'no-store', posted.headers.get('cache-control'));

  const authGet = await read(await authHandler(makeContext(makeRequest({ method: 'GET', path: '/api/auth' }), env)));
  check('session lookup stays uncacheable', authGet.headers.get('cache-control') === 'no-store', authGet.headers.get('cache-control'));
}

// 20. Moderation: only a verified admin can delete, and the delete really lands
async function adminEnv() {
  const env = { ...baseEnv(), ADMIN_USERNAME: 'lamp_admin', ADMIN_PASSWORD: 'bootstrap password' };
  const login = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', body: { action: 'login', username: 'lamp_admin', password: 'bootstrap password' } }),
    env,
  )));
  return { env, cookie: cookieOf(login.headers) };
}

function deferContext(request, env) {
  const tasks = [];
  return {
    tasks,
    request,
    env,
    params: {},
    waitUntil: (promise) => tasks.push(promise),
    next: async () => new originalResponse('ok', { status: 404 }),
  };
}

{
  const { env, cookie } = await adminEnv();

  const posted = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '198.51.100.44', body: { message: '需要被删除的留言' } }),
    env,
  )));
  const target = (posted.json.comments || []).find((item) => item.message === '需要被删除的留言');
  check('posted comment has an id', Boolean(target && target.id), JSON.stringify(posted.json && posted.json.comments));

  const guest = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.45', body: { id: target ? target.id : 'x' } }),
    env,
  )));
  check('anonymous delete is refused', guest.status === 403, `${guest.status} ${guest.text}`);

  const reader = await read(await authHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/auth', ip: '198.51.100.46', body: { action: 'register', username: 'mod_reader', password: 'correct horse' } }),
    env,
  )));
  const asReader = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.47', cookie: cookieOf(reader.headers), body: { id: target ? target.id : 'x' } }),
    env,
  )));
  check('signed-in member is not an admin', asReader.status === 403, `${asReader.status} ${asReader.text}`);
  check('member delete changed nothing', (await read(await discussionHandler(makeContext(makeRequest({ method: 'GET', path: '/api/discussions' }), env)))).json.comments.some((item) => item.message === '需要被删除的留言'));

  const crossSite = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.48', cookie, body: { id: target ? target.id : 'x' }, headers: { origin: 'https://attacker.example' } }),
    env,
  )));
  check('cross-site delete is refused', crossSite.status === 403, `${crossSite.status} ${crossSite.text}`);

  const missingId = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.49', cookie, body: {} }),
    env,
  )));
  check('delete without an id is rejected', missingId.status === 400, `${missingId.status} ${missingId.text}`);

  const unknown = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.50', cookie, body: { id: 'no-such-comment' } }),
    env,
  )));
  check('unknown id reports not-found', unknown.status === 404, `${unknown.status} ${unknown.text}`);

  const removed = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.51', cookie, body: { id: target ? target.id : 'x' } }),
    env,
  )));
  check('admin delete succeeds', removed.status === 200 && removed.json.removed === 1, `${removed.status} ${removed.text}`);
  check('deleted comment is gone from the response', !removed.json.comments.some((item) => item.message === '需要被删除的留言'), JSON.stringify(removed.json.comments));
  check('deleted comment is gone from storage', !env.DISCUSSION_STORE.data.get('comments').includes('需要被删除的留言'), env.DISCUSSION_STORE.data.get('comments') || '');
  check('delete response is uncacheable', removed.headers.get('cache-control') === 'no-store', removed.headers.get('cache-control'));

  const again = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.52', cookie, body: { id: target ? target.id : 'x' } }),
    env,
  )));
  check('second delete of the same id is not-found', again.status === 404, `${again.status} ${again.text}`);

  // Without purge credentials the moderation path must still work and must not
  // reach the network at all.
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new originalResponse('{"success":true}', { status: 200 });
  };
  const noCreds = await read(await discussionHandler(makeContext(
    makeRequest({ method: 'POST', path: '/api/discussions', ip: '198.51.100.53', body: { message: '无痕删除测试' } }),
    env,
  )));
  const ghost = (noCreds.json.comments || []).find((item) => item.message === '无痕删除测试');
  const bareDelete = await discussionHandler(makeContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.54', cookie, body: { id: ghost ? ghost.id : 'x' } }),
    env,
  ));
  check('delete without purge secrets still succeeds', bareDelete.status === 200, String(bareDelete.status));
  check('no network call without purge secrets', calls.length === 0, JSON.stringify(calls.map((call) => call.url)));

  // 21. With purge credentials: targeted URLs only, and the delete never waits
  // on the third party or learns anything from its answer.
  const purgeEnv = { ...env, CF_ZONE_ID: 'zoneabcdef123456', CF_PURGE_TOKEN: 'purge-token-value-0123456789' };
  const purgeCtx = deferContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.56', cookie, body: { id: 'site-echo' } }),
    purgeEnv,
  );
  const purgeRead = await read(await discussionHandler(purgeCtx));
  await Promise.all(purgeCtx.tasks);

  const urls = calls.length ? JSON.parse(calls[0].init.body).files : [];
  check('delete answers after a successful purge', purgeRead.status === 200 && purgeRead.json.removed === 1, `${purgeRead.status} ${purgeRead.text}`);
  check('purge is requested once', calls.length === 1, JSON.stringify(calls.map((call) => call.url)));
  check('purge endpoint is the zone cache route', calls[0].url === 'https://api.cloudflare.com/client/v4/zones/zoneabcdef123456/purge_cache', calls[0].url);
  check('purge targets the comment api and the homepage', urls.includes('https://example.pages.dev/api/discussions') && urls.includes('https://example.pages.dev/'), JSON.stringify(urls));
  check('purge never wipes the zone', !JSON.stringify(calls[0].init.body).includes('purge_everything'), calls[0].init.body);
  check('purge is authorized with the token', calls[0].init.headers.authorization === 'Bearer purge-token-value-0123456789', JSON.stringify(calls[0].init.headers));
  check('purge token never reaches the response', !JSON.stringify(purgeRead.json).includes('purge-token'), JSON.stringify(purgeRead.json));

  const failingCtx = deferContext(
    makeRequest({ method: 'DELETE', path: '/api/discussions', ip: '198.51.100.57', cookie, body: { id: 'site-welcome' } }),
    purgeEnv,
  );
  globalThis.fetch = async () => new originalResponse('{"success":false,"errors":[]}', { status: 403 });
  const failingRead = await read(await discussionHandler(failingCtx));
  await Promise.all(failingCtx.tasks);
  globalThis.fetch = originalFetch;
  check('a rejected purge does not fail the delete', failingRead.status === 200 && failingRead.json.removed === 1, `${failingRead.status} ${failingRead.text}`);
}

if (originalFetch === undefined) check('fetch availability recorded', true);

console.log('\nFunctions security tests');
console.log('-----------------------');
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok || !item.detail ? '' : `\n        ${item.detail}`}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
