// 手工生成的 RSS 2.0 订阅源：/rss.xml
//
// 为什么不用 astro-i18n-rss / @astrojs/rss：静态站点的 43 个章节拼一个 XML 只需
// 要字符串模板，多一个依赖就多一次安装面和一条供应链。这里零依赖。
//
// 域名从构建环境变量取，按优先级：
//   PUBLIC_SITE_URL   —— 必须设置（Cloudflare Pages → Settings → Build &
//                        development → Environment variables，构建时可见；Secrets
//                        在这里读不到）
//   CF_PAGES_URL / DEPLOY_URL —— 兜底，是「本次部署专属」的 *.pages.dev 地址，
//                        每次部署都换，绝不能当作订阅地址
//   本地开发 —— http://localhost:4321
// 订阅链接一旦发出就会被阅读器记住，所以正式域名应该固定，不要依赖部署哈希。
//
// 日期只信 frontmatter 的 `published`，不信文件时间：git 检出不保存 mtime，
// Cloudflare 构建机上 41 个章节的 mtime 全等于那次 checkout 的时间，pubDate 会
// 每次部署都变，阅读器把它们全部当成新文章重推一遍。没有日期的条目不输出
// pubDate，按卷章倒序排在有日期的条目后面。
import { getCollection } from 'astro:content';

const PART_ORDER = ['第一卷', '第二卷', '第三卷', '第四卷', '第五卷', '第六卷'];
const CHANNEL = {
  title: '《吊灯》· Chandelier In the Midnight with an Idoit and a Cup',
  description: '《吊灯》更新订阅：按卷、章顺序发布，最新章节排在最前。',
  language: 'zh-CN',
};

function resolveSite() {
  const candidates = [
    import.meta.env.PUBLIC_SITE_URL,
    process.env.PUBLIC_SITE_URL,
    process.env.CF_PAGES_URL,
    process.env.DEPLOY_URL,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) return value.replace(/\/+$/, '');
  }
  return 'http://localhost:4321';
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function plainSummary(markdown) {
  const text = String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^[ \t]*([-*_]\s){2,}[ \t]*$/gm, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return Array.from(text).slice(0, 160).join('');
}

function declaredTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 卷章在稿件序列里的位置，用来在没有时间可比时决定先后。
function position(entry) {
  const partIndex = PART_ORDER.indexOf(entry.data.part);
  return (partIndex === -1 ? PART_ORDER.length : partIndex) * 100 + Number(entry.data.chapter);
}

export async function GET() {
  const site = resolveSite();
  const entries = (await getCollection('novels'))
    .filter((entry) => {
      const id = entry.id.replace(/\.md$/, '');
      return id.includes('/') && /第\d+章$/.test(id);
    })
    .sort((a, b) => {
      const partDiff = PART_ORDER.indexOf(a.data.part) - PART_ORDER.indexOf(b.data.part);
      if (partDiff !== 0) return partDiff;
      return a.data.chapter - b.data.chapter;
    });

  const items = [];
  for (const entry of entries) {
    const slug = entry.id.replace(/\.md$/, '');
    // Percent-encoded: RFC 3986 URIs are ASCII, and a raw 中文 path in <guid
    // isPermaLink="true"> makes strict readers/validators reject the entry.
    const link = `${site}/Novels/${encodeURI(slug)}/`;
    const summary = plainSummary(entry.body) || `${entry.data.part} 第${entry.data.chapter}章`;

    // Frontmatter still holds "第一卷第1章" placeholders; repeating them after
    // "第一卷 · 第01章" would only add noise to the reader's list.
    const heading = `${entry.data.part} · 第${String(entry.data.chapter).padStart(2, '0')}章`;
    const placeholder = new RegExp(`^${entry.data.part}\\s*第\\s*${entry.data.chapter}\\s*章$`).test(
      String(entry.data.title || '').trim(),
    );

    items.push({
      link,
      title: placeholder ? heading : `${heading} ${entry.data.title}`,
      description: summary,
      published: declaredTime(entry.data.published),
      position: position(entry),
    });
  }

  // 倒序：订阅者要第一眼看到最新章节。有 `published` 的排在前面并按时间倒序，
  // 回改早期章节也会如实出现在最前；剩下没标日期的按卷章倒序，两者都不依赖
  // 构建机上的文件时间，所以每次部署结果一致。
  items.sort((a, b) => {
    const left = a.published ? a.published.getTime() : null;
    const right = b.published ? b.published.getTime() : null;

    if (left !== null && right !== null && left !== right) return right - left;
    if (left !== null && right === null) return -1;
    if (left === null && right !== null) return 1;
    return b.position - a.position;
  });

  const buildTime = new Date().toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(CHANNEL.title)}</title>
    <link>${escapeXml(site)}/</link>
    <description>${escapeXml(CHANNEL.description)}</description>
    <language>${CHANNEL.language}</language>
    <generator>Astro + tools/rss</generator>
    <atom:link href="${escapeXml(site)}/rss.xml" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${buildTime}</lastBuildDate>
    <ttl>30</ttl>
${items.map((item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      ${item.published ? `<pubDate>${item.published.toUTCString()}</pubDate>\n      ` : ''}<description>${escapeXml(item.description)}</description>
    </item>`).join('\n')}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
}
