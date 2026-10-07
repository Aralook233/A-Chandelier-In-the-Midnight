// Client-side output escaping. Every value that reaches HTML text position goes
// through escapeHtml; normalizePlainText handles structural junk first.

const htmlEscapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (char) => htmlEscapes[char]);
}

const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const invisibleChars = /[\u200B-\u200D\uFEFF\u2060]/g;
const embeddedBlocks = /<\s*(script|style|iframe|object|embed|template|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const tagLike = /<\/?[a-z!?][^>]{0,400}>/gi;
const dangerousScheme = /\b(?:javascript|vbscript|livescript|data|blob|file)\s*:/gi;

export function normalizePlainText(value: unknown, maxLength: number, fallback = ''): string {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
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

export function formatCommentTime(value: unknown): string {
  const time = Date.parse(typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  if (Number.isNaN(time) || time > Date.now() + 60000) return '刚刚';
  return new Date(time).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
