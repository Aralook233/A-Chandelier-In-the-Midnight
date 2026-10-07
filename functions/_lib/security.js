// Shared security helpers for Cloudflare Pages Functions (KV layer).
// Files under functions/_lib are excluded from routing.

const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const invisibleChars = /[\u200B-\u200D\uFEFF\u2060]/g;
const embeddedBlocks = /<\s*(script|style|iframe|object|embed|template|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const tagLike = /<\/?[a-z!?][^>]{0,400}>/gi;
const dangerousScheme = /\b(?:javascript|vbscript|livescript|data|blob|file)\s*:/gi;

const encoder = new TextEncoder();
let ephemeralSecret = null;

// Anything beyond these bounds is truncated before the cleaners run, so an
// unauthenticated caller cannot make the worker regex-scan megabytes of input.
const MAX_RAW_INPUT = 4096;
const DEFAULT_ITERATIONS = 150000;
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 1000000;
const MAX_BODY_BYTES = 16 * 1024;

function toRawText(value) {
  if (typeof value === 'string') return value.slice(0, MAX_RAW_INPUT);
  if (value == null) return '';
  return String(value).slice(0, MAX_RAW_INPUT);
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function base64FromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function bytesFromBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64Url(value) {
  return base64FromBytes(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return bytesFromBase64(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Second-pass cleaning for anything that reaches KV storage: inert plain text,
 * no markup, no control characters, bounded length.
 */
export function sanitizeText(value, maxLength, fallback = '') {
  const raw = toRawText(value);
  const cleaned = raw
    .replace(controlChars, ' ')
    .replace(invisibleChars, '')
    .replace(embeddedBlocks, ' ')
    .replace(tagLike, ' ')
    .replace(dangerousScheme, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return fallback;
  return Array.from(cleaned).slice(0, maxLength).join('');
}

export function sanitizeIsoDate(value) {
  const time = Date.parse(typeof value === 'string' || typeof value === 'number' ? value : '');
  if (Number.isNaN(time)) return new Date().toISOString();
  const clamped = Math.min(Math.max(time, Date.UTC(2000, 0, 1)), Date.now() + 60000);
  return new Date(clamped).toISOString();
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function deriveHash(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return base64FromBytes(new Uint8Array(bits));
}

function newHashIterations(env) {
  return clampNumber(env && env.PBKDF2_ITERATIONS, DEFAULT_ITERATIONS, MIN_ITERATIONS, MAX_ITERATIONS);
}

export async function hashPassword(password, env) {
  const salt = randomBytes(16);
  const iterations = newHashIterations(env);
  const hash = await deriveHash(password, salt, iterations);
  return { passwordHash: hash, salt: base64FromBytes(salt), iterations };
}

export async function verifyPassword(password, record) {
  if (record && record.passwordHash && record.salt) {
    // The iteration count comes from the stored record, so it is clamped: a
    // tampered value could otherwise turn a login into unbounded CPU work.
    const iterations = clampNumber(record.iterations, DEFAULT_ITERATIONS, MIN_ITERATIONS, MAX_ITERATIONS);
    const hash = await deriveHash(password, bytesFromBase64(record.salt), iterations);
    return safeCompare(hash, record.passwordHash);
  }

  // Only the environment-provided bootstrap admin is compared as plain text;
  // it never reaches storage. Stored accounts must carry a hash.
  if (record && record.seed && typeof record.password === 'string' && record.password.length > 0) {
    return safeCompare(password.slice(0, MAX_RAW_INPUT), record.password.slice(0, MAX_RAW_INPUT));
  }

  return false;
}

const SECRET_KEY = 'session:secret';
const MAX_SESSION_TTL = 60 * 60 * 24 * 30;

/**
 * Session signing key. `AUTH_SECRET` wins when configured; otherwise the key is
 * generated once and kept in KV, because a per-isolate random key would invalidate
 * every login as soon as a new Worker isolate starts.
 */
async function getSessionSecret(env) {
  const configured = env && env.AUTH_SECRET;
  if (typeof configured === 'string' && configured.length >= 32) return toRawText(configured);

  const store = env && (env.SESSION_STORE || env.AUTH_STORE);
  if (store) {
    try {
      const stored = await store.get(SECRET_KEY);
      if (typeof stored === 'string' && stored.length >= 43) return stored.slice(0, MAX_RAW_INPUT);
      const generated = base64FromBytes(randomBytes(32));
      await store.put(SECRET_KEY, generated);
      return generated;
    } catch {
      // KV unavailable: fall back to the in-memory key for this isolate.
    }
  }

  if (!ephemeralSecret) ephemeralSecret = base64FromBytes(randomBytes(32));
  return ephemeralSecret;
}

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', encoder.encode(await getSessionSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signSession(env, payload, ttlSeconds = 86400) {
  const issuedAt = Date.now();
  const ttl = clampNumber(ttlSeconds, 86400, 60, MAX_SESSION_TTL);
  const tokenId = toBase64Url(randomBytes(12));
  const body = toBase64Url(encoder.encode(JSON.stringify({ ...payload, tokenId, issuedAt, expiresAt: issuedAt + ttl * 1000 })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySession(env, token) {
  if (typeof token !== 'string') return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(env),
      bytesFromBase64(signature.replace(/-/g, '+').replace(/_/g, '/')),
      encoder.encode(body),
    );
    if (!valid) return null;

    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    if (!parsed || typeof parsed.username !== 'string' || !parsed.username) return null;

    const now = Date.now();
    // The cookie's Max-Age is not enough: a stolen token must expire server-side.
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now) return null;
    if (typeof parsed.issuedAt === 'number' && parsed.issuedAt > now + 60000) return null;

    return {
      username: parsed.username.slice(0, 48),
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName.slice(0, 48) : parsed.username.slice(0, 48),
      tokenId: typeof parsed.tokenId === 'string' ? parsed.tokenId.slice(0, 48) : '',
      issuedAt: Number(parsed.issuedAt) || 0,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

/** Read a bounded JSON body; oversized or malformed payloads are rejected. */
export async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  // A simple cross-site form post arrives as urlencoded/text/plain. Parsing any
  // body that happens to look like JSON would hand the origin gate a bypass.
  if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
    return { error: '请求格式无效。' };
  }

  const declared = Number(request.headers.get('content-length') || '');
  if (Number.isFinite(declared) && declared > maxBytes) return { error: '请求体过大。' };

  let text;
  try {
    text = await request.text();
  } catch {
    return { error: '请求格式无效。' };
  }

  if (text.length > maxBytes) return { error: '请求体过大。' };

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: '请求格式无效。' };
    return { data: parsed };
  } catch {
    return { error: '请求格式无效。' };
  }
}

export function parseCookies(header) {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf('=');
        if (index === -1) return [item, ''];
        try {
          return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
        } catch {
          return [item.slice(0, index), ''];
        }
      }),
  );
}

export function sessionCookie(token, maxAgeSeconds) {
  return `session=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax; Priority=High`;
}

/** Same-origin gate for state-changing requests (CSRF defence in depth). */
export function isAllowedOrigin(request) {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) {
    // Real same-origin browser requests always carry Origin or Referer on POST.
    // Without any evidence the request is treated as untrusted instead of allowed.
    return false;
  }

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function clientIdentity(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * Fixed-window counter. Best effort: without a KV binding the caller degrades to
 * allowing the request instead of failing closed.
 */
/**
 * Bucket identifier for rate limiting. The raw identity is a client IP (plus the
 * attempted username), and those would otherwise sit in plain text inside KV
 * keys. HMAC-ing it with the session secret keeps per-client counting intact
 * while storing nothing readable: the digest cannot be reversed, and without the
 * secret an observer cannot test whether two buckets are the same machine.
 */
export async function bucketIdentity(env, value) {
  const key = await hmacKey(env);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(toRawText(value)));
  return toBase64Url(new Uint8Array(signature)).slice(0, 16);
}

export async function rateLimit(store, namespace, identity, limit, windowSeconds) {
  if (!store) return { allowed: true, retryAfter: 0 };

  const key = `rl:${namespace}:${identity}`;
  try {
    const now = Date.now();
    const raw = await store.get(key);
    const bucket = raw ? JSON.parse(raw) : null;

    if (!bucket || bucket.startedAt + windowSeconds * 1000 <= now) {
      await store.put(key, JSON.stringify({ startedAt: now, count: 1 }), { expirationTtl: windowSeconds });
      return { allowed: true, retryAfter: 0 };
    }

    if (bucket.count >= limit) {
      return { allowed: false, retryAfter: Math.ceil((bucket.startedAt + windowSeconds * 1000 - now) / 1000) };
    }

    await store.put(key, JSON.stringify({ startedAt: bucket.startedAt, count: bucket.count + 1 }), {
      expirationTtl: windowSeconds,
    });
    return { allowed: true, retryAfter: 0 };
  } catch {
    return { allowed: true, retryAfter: 0 };
  }
}

const apiCsp = [
  "default-src 'none'",
  "base-uri 'none'",
  'frame-ancestors none',
  'form-action none',
].join('; ');

export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-security-policy': apiCsp,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}
