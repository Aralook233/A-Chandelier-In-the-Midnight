import { findUser, isSessionRevoked, toPublicUser } from '../_lib/accounts.js';
import { discussionCacheUrls, purgeCdn } from '../_lib/purge.js';
import {
  bucketIdentity,
  clientIdentity,
  isAllowedOrigin,
  jsonResponse,
  parseCookies,
  rateLimit,
  readJsonBody,
  sanitizeIsoDate,
  sanitizeText,
  verifySession,
} from '../_lib/security.js';

const MAX_COMMENTS = 30;
const NAME_LENGTH = 24;
const MESSAGE_LENGTH = 220;
const ANONYMOUS_NAME = '匿名读者';

// Built per call: a module-scope `new Date()` would freeze at isolate start and
// serve ever-staler timestamps.
function defaultComments() {
  return [
    {
      id: 'site-welcome',
      name: '站内公开',
      message: '这里是公开留言区，欢迎留下对灯影、卷章和故事世界的想法。',
      createdAt: new Date().toISOString(),
      verified: true,
    },
    {
      id: 'site-echo',
      name: '灯影',
      message: '如果你愿意，可以在这里留下你眼中的时序、人物和夜色。',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      verified: true,
    },
  ];
}

function cleanComment(value) {
  if (!value || typeof value !== 'object') return null;

  const message = sanitizeText(value.message, MESSAGE_LENGTH);
  if (!message) return null;

  return {
    id: sanitizeText(value.id, 64, '') || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`),
    name: sanitizeText(value.name, NAME_LENGTH, ANONYMOUS_NAME),
    message,
    createdAt: sanitizeIsoDate(value.createdAt),
    verified: value.verified === true,
  };
}

function cleanList(items) {
  if (!Array.isArray(items)) return [];
  return items.map(cleanComment).filter(Boolean).slice(0, MAX_COMMENTS);
}

async function readStore(env) {
  if (!env || !env.DISCUSSION_STORE) {
    return defaultComments();
  }

  try {
    const raw = await env.DISCUSSION_STORE.get('comments');
    if (!raw) return defaultComments();
    const parsed = cleanList(JSON.parse(raw));
    return parsed.length > 0 ? parsed : defaultComments();
  } catch {
    return defaultComments();
  }
}

async function writeStoreCas(env, items, previousRaw) {
  const payload = JSON.stringify(cleanList(items));
  try {
    if (previousRaw === null) {
      await env.DISCUSSION_STORE.put('comments', payload, { onlyIf: { exists: false } });
    } else {
      await env.DISCUSSION_STORE.put('comments', payload, { onlyIf: { equals: previousRaw } });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-modify-write of the whole comment list under compare-and-swap, mirroring
 * `mutateUsers` in accounts.js. The list lives in a single KV key, so an
 * unguarded write from a publish and a write from a moderation delete would
 * overwrite whichever landed first — a deleted comment coming back is the worst
 * possible outcome for the delete path.
 *
 * `mutate` receives the list as it was read (the fallback seed when nothing is
 * stored yet) and returns the list to persist. Returns null when the store is
 * missing or every swap was lost.
 */
async function mutateStore(env, mutate) {
  if (!env || !env.DISCUSSION_STORE) {
    return { items: cleanList(mutate(defaultComments())), persisted: false };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let raw = null;
    let current = null;
    try {
      raw = await env.DISCUSSION_STORE.get('comments');
      current = raw === null ? null : cleanList(JSON.parse(raw));
    } catch {
      return null;
    }

    const next = cleanList(mutate(current ?? defaultComments()));
    if (await writeStoreCas(env, next, raw ?? null)) return { items: next, persisted: true };
  }

  return null;
}

/**
 * The displayed name is resolved from the verified session, never from the
 * request body: a client that sends `name: "admin"` must not be able to speak
 * as somebody else.
 */
async function resolveAuthor(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const session = await verifySession(env, cookies.session || '');
  if (!session) {
    return { name: ANONYMOUS_NAME, verified: false, admin: false, identity: clientIdentity(request), limit: 3 };
  }

  // Two independent KV reads, so they run concurrently like in auth.js.
  const [revoked, record] = await Promise.all([
    isSessionRevoked(env, session),
    findUser(env, session.username),
  ]);
  if (revoked || !record || String(record.username).toLowerCase() !== session.username.toLowerCase()) {
    return { name: ANONYMOUS_NAME, verified: false, admin: false, identity: clientIdentity(request), limit: 3 };
  }

  const publicUser = toPublicUser(record);
  return {
    name: publicUser.displayName || publicUser.username || ANONYMOUS_NAME,
    verified: true,
    admin: publicUser.role === 'admin',
    identity: `user:${publicUser.username.toLowerCase()}`,
    limit: 10,
  };
}

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  const method = request.method.toUpperCase();

  if (method === 'GET') {
    // The list is public and identical for every visitor, so it is the one
    // response worth caching: without this every page view costs a worker
    // invocation plus a KV read. New comments appear up to 20s late by design.
    return jsonResponse({ comments: await readStore(env) }, 200, {
      'cache-control': 'public, max-age=20, stale-while-revalidate=60',
    });
  }

  if (method !== 'POST' && method !== 'DELETE') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (!isAllowedOrigin(request)) {
    return jsonResponse({ error: '跨站请求已被拒绝。' }, 403);
  }

  const author = await resolveAuthor(request, env);

  if (method === 'DELETE') {
    return handleDelete(request, env, author, waitUntil);
  }

  // `author.identity` is a client IP or `user:<username>`; digest it so neither
  // lands in a KV key. Per-identity counting is unchanged.
  const limit = await rateLimit(
    env && env.DISCUSSION_STORE,
    'discussion',
    await bucketIdentity(env, author.identity),
    author.limit,
    60,
  );
  if (!limit.allowed) {
    return jsonResponse(
      { error: `发言过于频繁，请在 ${limit.retryAfter} 秒后重试。` },
      429,
      { 'Retry-After': String(limit.retryAfter) },
    );
  }

  const parsed = await readJsonBody(request);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);

  const message = sanitizeText(parsed.data?.message, MESSAGE_LENGTH);
  if (!message) {
    return jsonResponse({ error: '留言内容不能为空。' }, 400);
  }

  const incoming = cleanComment({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: author.name,
    message,
    createdAt: new Date().toISOString(),
    verified: author.verified,
  });

  const stored = await mutateStore(env, (items) => [incoming, ...items]);
  if (!stored) {
    return jsonResponse({ error: '留言服务暂时不可用，请稍后重试。' }, 503);
  }

  return jsonResponse({
    ok: true,
    comments: stored.items,
    author: { name: incoming.name, verified: incoming.verified },
    warning: stored.persisted ? undefined : '未配置 DISCUSSION_STORE，当前仅在本地回退模式下可提交。',
  });
}

/**
 * Moderation: verified admins only, and the displayed target is the stored
 * comment id, never a name or index a client could shuffle. The response body
 * already carries the new list, so the admin's page needs no extra refresh.
 */
async function handleDelete(request, env, author, waitUntil) {
  if (!author.admin) {
    return jsonResponse({ error: '删除留言需要管理员权限。' }, 403);
  }

  const limit = await rateLimit(
    env && env.DISCUSSION_STORE,
    'discussion-modera',
    await bucketIdentity(env, author.identity),
    30,
    60,
  );
  if (!limit.allowed) {
    return jsonResponse(
      { error: `操作过于频繁，请在 ${limit.retryAfter} 秒后重试。` },
      429,
      { 'Retry-After': String(limit.retryAfter) },
    );
  }

  const parsed = await readJsonBody(request);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);

  const id = sanitizeText(parsed.data?.id, 64, '');
  if (!id) return jsonResponse({ error: '缺少要删除的留言编号。' }, 400);

  let removed = 0;
  const stored = await mutateStore(env, (items) => {
    const next = items.filter((item) => item.id !== id);
    removed = items.length - next.length;
    return next;
  });
  if (!stored) {
    return jsonResponse({ error: '留言服务暂时不可用，请稍后重试。' }, 503);
  }
  if (removed === 0) {
    return jsonResponse({ error: '没有找到对应的留言。' }, 404);
  }

  // The delete is already durable at this point; invalidating the edge copy is
  // best effort and must never add latency or an error to the admin's request.
  const purge = purgeCdn(env, discussionCacheUrls(new URL(request.url).origin));
  if (typeof waitUntil === 'function') waitUntil(purge.catch(() => {}));

  return jsonResponse({ ok: true, removed, comments: stored.items, persisted: stored.persisted });
}
