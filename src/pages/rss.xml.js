// 手工生成的 RSS 2.0 订阅源：/rss.xml
//
// 为什么不用 astro-i18n-rss / @astrojs/rss：静态站点的 43 个章节拼一个 XML 只需
// 要字符串模板，多一个依赖就多一次安装面和一条供应链。这里零依赖。
//
// 域名从构建环境变量取，按优先级：
//   PUBLIC_SITE_URL   —— 建议设置（Cloudflare Pages → Settings → Build &
//                        development → Environment variables，构建时可见）
//   CF_PAGES_URL / DEPLOY_URL —— Pages 构建时自带，退化为 *.pages.dev
//   本地开发 —— http://localhost:4321
// 订阅链接一旦发出就会被阅读器记住，所以正式域名应该固定，不要依赖部署哈希。
import { getCollection } from 'astro:content';
import { join } from 'node:path';

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

async function fileTime(filePath) {
  try {
    const fs = await import('node:fs/promises');
    // `filePath` from the glob loader is already relative to the project root
    // ("src/content/novels/…"), and the build runs from that root. Resolving it
    // against import.meta.url instead would look inside dist/.prerender, where
    // the markdown never is.
    const stat = await fs.stat(join(process.cwd(), String(filePath)));
    return stat.mtime;
  } catch {
    // 拿不到文件时间时退回构建时间：宁可由阅读器判定为一次正常更新，也不要
    // 输出一个 Invalid Date 让严格解析器整个拒收这个源。
    return new Date();
  }
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
    const link = `${site}/Novels/${slug}/`;
    const published = await fileTime(entry.filePath);
    const summary = plainSummary(entry.body) || `${entry.data.part} 第${entry.data.chapter}章`;

    items.push({
      link,
      title: `${entry.data.part} · 第${String(entry.data.chapter).padStart(2, '0')}章 ${entry.data.title}`,
      description: summary,
      published,
    });
  }

  // 倒序：订阅者要第一眼看到最新章节。按时间排而不是按卷章排，回改早期章节也会
  // 如实出现在最前面；同时间的条目保留卷章顺序（Array#sort 是稳定的）。
  items.sort((a, b) => b.published.getTime() - a.published.getTime());

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
      <pubDate>${item.published.toUTCString()}</pubDate>
      <description>${escapeXml(item.description)}</description>
    </item>`).join('\n')}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
}
