// Best-effort Cloudflare cache purge for Pages Functions.
//
// Two facts shape this file:
// 1. Nothing here is required for correctness. Every HTML page answers with
//    `max-age=0, must-revalidate`, so the edge cannot serve a stale document.
//    Purge only matters for a path you deliberately edge-cache with a Cache
//    Rule (e.g. /api/discussions); then this is how that entry gets invalidated
//    the moment a comment is deleted instead of up to its TTL later.
// 2. It is a network call to a third party from inside a request. So it is
//    always fired through `context.waitUntil(...)` and every failure path
//    returns false instead of throwing: a purge outage must not turn a
//    successful delete into an error the admin has to retry.
//
// Configuration (Cloudflare Pages → Settings → Environment variables, Secret
// type — never plain, never committed):
//   CF_ZONE_ID     the zone id of the domain in front of Pages
//   CF_PURGE_TOKEN an API token whose only permission is Zone.Cache Purge
// Both absent → purgeCdn() is an inert no-op.
//
// `purge_everything` is intentionally unreachable from this code: wiping the
// whole zone to remove one comment would take the site back to origin for every
// visitor.

const PURGE_LIMIT = 30;
const ZONE_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

function normalizeUrls(urls) {
  const out = [];
  for (const value of Array.isArray(urls) ? urls : []) {
    if (typeof value !== 'string') continue;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      continue;
    }
    // The purge API keys on the exact URL, scheme included; an http:// entry
    // would purge a different cache key than the one the CDN stores.
    if (parsed.protocol !== 'https:') continue;
    parsed.hash = '';
    const href = parsed.toString();
    if (!out.includes(href)) out.push(href);
    if (out.length >= PURGE_LIMIT) break;
  }
  return out;
}

export async function purgeCdn(env, urls) {
  const zoneId = env && env.CF_ZONE_ID;
  const token = env && env.CF_PURGE_TOKEN;
  if (typeof zoneId !== 'string' || !ZONE_ID_SHAPE.test(zoneId)) return { ok: false, reason: 'no-zone' };
  if (typeof token !== 'string' || token.length < 20) return { ok: false, reason: 'no-token' };

  const files = normalizeUrls(urls);
  if (files.length === 0) return { ok: false, reason: 'no-urls' };

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ files }),
    });
    // The body is parsed only to read `success`; its messages can name the token
    // or the zone, so nothing from it is returned to the caller.
    const payload = await response.json().catch(() => null);
    if (response.ok && payload && payload.success === true) return { ok: true, purged: files.length };
    return { ok: false, reason: 'rejected', status: response.status };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/**
 * Cache keys worth invalidating after a moderation change: the JSON the page
 * reads, and the documents that carry the list. Derived from the request's own
 * origin so a preview deployment cannot purge production.
 */
export function discussionCacheUrls(origin) {
  let base;
  try {
    base = new URL(origin);
  } catch {
    return [];
  }
  if (base.protocol !== 'https:') return [];

  return [`${base.origin}/api/discussions`, `${base.origin}/`, `${base.origin}/index.html`];
}
