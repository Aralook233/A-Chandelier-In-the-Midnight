const defaultUsers = [
  {
    username: 'Aralook233',
    password: '123456',
    displayName: 'Aralook233',
    role: 'admin',
  },
];

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
};

function parseCookieHeader(header) {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const idx = item.indexOf('=');
        if (idx === -1) return [item, ''];
        return [item.slice(0, idx), decodeURIComponent(item.slice(idx + 1))];
      })
  );
}

async function readUsers(env) {
  if (env && env.AUTH_STORE) {
    try {
      const raw = await env.AUTH_STORE.get('users');
      if (!raw) return defaultUsers;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // fallback to default if the store is unavailable or malformed
    }
  }

  return defaultUsers;
}

async function writeUsers(env, users) {
  if (env && env.AUTH_STORE) {
    try {
      await env.AUTH_STORE.put('users', JSON.stringify(users.slice(0, 100)));
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function buildUserRecord(username, password, displayName) {
  return {
    username: String(username || '').trim(),
    password: String(password || '').trim(),
    displayName: String(displayName || username || '').trim() || username,
    role: 'member',
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  if (method === 'GET') {
    const cookies = parseCookieHeader(request.headers.get('Cookie') || '');
    const session = cookies.session ? JSON.parse(decodeURIComponent(cookies.session)) : null;
    const user = session && session.username ? { username: session.username, displayName: session.displayName || session.username, role: session.role || 'member' } : null;
    return new Response(JSON.stringify({ ok: true, user }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  if (method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  try {
    const body = await request.json();
    const action = String(body?.action || 'login').toLowerCase();

    if (action === 'logout') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          ...jsonHeaders,
          'Set-Cookie': 'session=; Path=/; Max-Age=0; SameSite=Lax',
        },
      });
    }

    const username = String(body?.username || '').trim();
    const password = String(body?.password || '').trim();

    if (!username || !password) {
      return new Response(JSON.stringify({ error: '用户名和密码不能为空。' }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const users = await readUsers(env);
    const normalizedUsername = username.toLowerCase();

    if (action === 'register') {
      const existing = users.find((user) => String(user.username).toLowerCase() === normalizedUsername);
      if (existing) {
        return new Response(JSON.stringify({ error: '该用户名已被注册。' }), {
          status: 409,
          headers: jsonHeaders,
        });
      }

      const user = buildUserRecord(username, password, body?.displayName || username);
      const nextUsers = [...users, user];
      const persisted = await writeUsers(env, nextUsers);

      const response = new Response(JSON.stringify({
        ok: true,
        user: { username: user.username, displayName: user.displayName, role: user.role },
        warning: persisted ? undefined : '未配置 AUTH_STORE，当前仅在本地回退模式下保存。',
      }), {
        status: 200,
        headers: {
          ...jsonHeaders,
          'Set-Cookie': `session=${encodeURIComponent(JSON.stringify({ username: user.username, displayName: user.displayName, role: user.role }))}; Path=/; Max-Age=86400; SameSite=Lax`,
        },
      });

      return response;
    }

    const user = users.find((candidate) => {
      const sameUser = String(candidate.username).toLowerCase() === normalizedUsername;
      const samePassword = String(candidate.password) === password;
      return sameUser && samePassword;
    });

    if (!user) {
      return new Response(JSON.stringify({ error: '用户名或密码错误。' }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      user: {
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role || 'member',
      },
    }), {
      status: 200,
      headers: {
        ...jsonHeaders,
        'Set-Cookie': `session=${encodeURIComponent(JSON.stringify({ username: user.username, displayName: user.displayName || user.username, role: user.role || 'member' }))}; Path=/; Max-Age=86400; SameSite=Lax`,
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: '请求格式无效。' }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
}
