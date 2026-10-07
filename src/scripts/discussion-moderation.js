// 管理员留言删除的前端层。独立成文件（不掺进页面的那段脚本），页面只负责
// 引入它并给每条留言带上 data-id。
//
// 权限完全由服务端判定：这里只是决定按钮显不显示，真正的鉴权在
// functions/api/discussions.js 的 DELETE 分支里。所以就算有人把这段脚本改掉、
// 删掉，或者手动把按钮点出来，也拿不到任何删除能力。

const LIST_ID = 'discussionList';
const STATUS_ID = 'discussionStatus';
const CHIP_ID = 'accountChip';
const ADMIN_MARK = '管理员';
const LOCAL_DISCUSSION_KEY = 'chandelier-public-discussion-v1';

function setStatus(text) {
  const status = document.getElementById(STATUS_ID);
  if (status) status.textContent = text;
}

// 复用页面自己已经查过的登录态（那枚 chip 写着「· 管理员」），不再额外打一次
// /api/auth：每次浏览多一个 Worker 调用 + KV 读，对静态站是白扔的。
function chipIsAdmin(chip) {
  return Boolean(chip) && !chip.hidden && (chip.textContent || '').includes(ADMIN_MARK);
}

// 删掉之后把 localStorage 的副本也剪掉：否则接口不可用时页面会回退到本地缓存，
// 被删的留言又会在管理员自己眼前复活。
function pruneLocal(id) {
  try {
    const raw = localStorage.getItem(LOCAL_DISCUSSION_KEY);
    if (!raw) return;
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return;
    const kept = items.filter((item) => item && item.id !== id);
    if (kept.length === items.length) return;
    if (kept.length === 0) localStorage.removeItem(LOCAL_DISCUSSION_KEY);
    else localStorage.setItem(LOCAL_DISCUSSION_KEY, JSON.stringify(kept));
  } catch {
    // 本地存储不可用（隐私模式/配额）不影响服务端已经落地的删除。
  }
}

function makeButton(id, article) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'moderation-delete';
  button.textContent = '删除';
  button.dataset.commentId = id;

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    if (!window.confirm('确定删除这条留言？删除后无法恢复。')) return;

    button.disabled = true;
    button.textContent = '删除中';
    try {
      const response = await fetch('/api/discussions', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 403) {
        setStatus('删除留言需要管理员权限。');
        button.disabled = false;
        button.textContent = '删除';
        return;
      }
      if (!response.ok) {
        setStatus((payload && payload.error) || '删除失败，请稍后重试。');
        button.disabled = false;
        button.textContent = '删除';
        return;
      }

      article.remove();
      pruneLocal(id);
      setStatus('留言已删除，边缘缓存的清除请求已发出。');
    } catch {
      setStatus('网络异常，删除未完成。');
      button.disabled = false;
      button.textContent = '删除';
    }
  });

  return button;
}

function decorate(list) {
  const articles = list.querySelectorAll('article[data-id]');
  for (const article of articles) {
    if (article.querySelector('.moderation-delete')) continue;
    const id = article.getAttribute('data-id');
    if (!id) continue;

    const meta = article.querySelector('.discussion-meta') || article;
    meta.appendChild(document.createTextNode(' '));
    meta.appendChild(makeButton(id, article));
  }
}

function strip() {
  for (const button of document.querySelectorAll('.moderation-delete')) button.remove();
}

function init() {
  const list = document.getElementById(LIST_ID);
  const chip = document.getElementById(CHIP_ID);
  // 找不到 chip 就整个静默不动：页面结构改了宁可少一个按钮，也不要多发请求。
  if (!list || !chip) return;

  const sync = () => {
    if (chipIsAdmin(chip)) decorate(list);
    else strip();
  };

  sync();
  new MutationObserver(sync).observe(chip, { childList: true, characterData: true, subtree: true });
  // 留言列表是异步 fetch 后整体重写 innerHTML 的，所以还要盯着列表本身。
  new MutationObserver(() => {
    if (chipIsAdmin(chip)) decorate(list);
  }).observe(list, { childList: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// 接线（已完成，index.astro）：
// 1. frontmatter：import '../styles/moderation.css';
// 2. 页面 <script> 顶部：import '../scripts/discussion-moderation.js';
//    （不能写成 <script src="…">，那样 Astro 会把内容内联，CSP 不认）
// 3. renderDiscussion 模板：<article class="discussion-item" data-id="${escapeHtml(item.id)}">
