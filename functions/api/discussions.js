const defaultComments = [
  {
    id: 'site-welcome',
    name: '站内公开',
    message: '这里是公开留言区，欢迎留下对灯影、卷章和故事世界的想法。',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'site-echo',
    name: '灯影',
    message: '如果你愿意，可以在这里留下你眼中的时序、人物和夜色。',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
];

async function readStore(env) {
  if (!env || !env.DISCUSSION_STORE) {
    return defaultComments;
  }

  try {
    const raw = await env.DISCUSSION_STORE.get('comments');
    if (!raw) return defaultComments;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultComments;
  } catch {
    return defaultComments;
  }
}

async function writeStore(env, items) {
  if (!env || !env.DISCUSSION_STORE) {
    return false;
  }

  try {
    await env.DISCUSSION_STORE.put('comments', JSON.stringify(items.slice(0, 30)));
    return true;
  } catch {
    return false;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();
  const headers = { 'content-type': 'application/json; charset=utf-8' };

  if (method === 'GET') {
    const comments = await readStore(env);
    return new Response(JSON.stringify({ comments }), {
      status: 200,
      headers,
    });
  }

  if (method === 'POST') {
    try {
      const payload = await request.json();
      const name = String(payload?.name || '匿名读者').trim().slice(0, 24) || '匿名读者';
      const message = String(payload?.message || '').trim();

      if (!message) {
        return new Response(JSON.stringify({ error: '留言内容不能为空。' }), {
          status: 400,
          headers,
        });
      }

      const incoming = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        message: message.slice(0, 220),
        createdAt: new Date().toISOString(),
      };

      const stored = await readStore(env);
      const next = [incoming, ...stored].slice(0, 30);
      const persistOk = await writeStore(env, next);

      return new Response(
        JSON.stringify({
          ok: true,
          comments: next,
          warning: persistOk ? undefined : '未配置 DISCUSSION_STORE，当前仅在本地回退模式下可提交。',
        }),
        { status: 200, headers }
      );
    } catch {
      return new Response(JSON.stringify({ error: '无效的留言内容。' }), {
        status: 400,
        headers,
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers,
  });
}
