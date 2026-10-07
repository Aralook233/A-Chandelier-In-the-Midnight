/**
 * 中文标点按需求该占满整格，但引号和括号的那半格空档就成了"额外空隙"。
 * 实测霞鹜文楷的墨迹位置（canvas ink box，100px 字号）：
 *   「 墨迹 0.72–0.95em —— 左边空 0.72em
 *   」 墨迹 0.05–0.28em —— 右边空 0.72em
 *   『』（）〔〕【】《》 同构，空半边 0.67–0.70em
 *
 * 引擎自带的收标点能力覆盖不到这个场景：
 *   - text-spacing-trim 只管行首行尾，行中不动；
 *   - 相邻标点（：「、。」）浏览器本来就会压，实测 说：「你好。」走 里四个标点合计 0.895em；
 *   - font-feature-settings:"palt" 1 反而更糟 —— 它顶掉了浏览器默认的相邻压缩，
 *     「完全可行」 从 1.5em 涨回 2.0em（实测）。
 *
 * 所以只把"夹在正文中间"的前后引号括号单独包一层，用负外边距收掉空半边：
 * 前引号只在左侧是词字（汉字／假名／谚文／字母／数字）时收，后引号只看右侧。
 * 段首、跟在 ，。：？ 之后的那些交给引擎，不收也不重复收。
 */

const OPEN_MARKS = new Set(['「', '『', '（', '〔', '【', '《']);
const CLOSE_MARKS = new Set(['」', '』', '）', '〕', '】', '》']);

const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9]/u;

const OPEN_CLASS = 'punct-hug punct-hug--open';
const CLOSE_CLASS = 'punct-hug punct-hug--close';

export default function remarkCjkPunctHug() {
  return (tree) => {
    hugChildren(tree);
  };
}

function hugChildren(node) {
  if (!node || !Array.isArray(node.children)) return;

  const rebuilt = [];
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index];

    if (child.type !== 'text') {
      hugChildren(child);
      rebuilt.push(child);
      continue;
    }

    const previousChar = lastCharOf(rebuilt[rebuilt.length - 1]);
    const nextChar = firstCharOf(node.children[index + 1]);
    rebuilt.push(...splitText(child.value, previousChar, nextChar));
  }

  node.children = rebuilt;
}

function splitText(value, neighbourBefore, neighbourAfter) {
  const parts = [];
  let buffer = '';

  const charBefore = (index) => (index > 0 ? value[index - 1] : neighbourBefore);
  const charAfter = (index) => (index < value.length - 1 ? value[index + 1] : neighbourAfter);

  const flush = () => {
    if (!buffer) return;
    parts.push({ type: 'text', value: buffer });
    buffer = '';
  };

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const isOpen = OPEN_MARKS.has(character);
    const isClose = CLOSE_MARKS.has(character);
    if (!isOpen && !isClose) {
      buffer += character;
      continue;
    }

    const hugSideChar = isOpen ? charBefore(index) : charAfter(index);
    if (!hugSideChar || !WORD.test(hugSideChar)) {
      buffer += character;
      continue;
    }

    flush();
    parts.push(mark(character, isOpen ? OPEN_CLASS : CLOSE_CLASS));
  }

  flush();
  return parts;
}

function mark(character, className) {
  return {
    type: 'text',
    value: character,
    data: {
      hName: 'span',
      hProperties: { class: className },
      hChildren: [{ type: 'text', value: character }],
    },
  };
}

function firstCharOf(node) {
  if (!node) return null;
  if (node.type === 'text') return node.value ? node.value[0] : null;
  for (const child of node.children ?? []) {
    const found = firstCharOf(child);
    if (found) return found;
  }
  return null;
}

function lastCharOf(node) {
  if (!node) return null;
  if (node.type === 'text') return node.value ? node.value[node.value.length - 1] : null;
  const children = node.children ?? [];
  for (let index = children.length - 1; index >= 0; index--) {
    const found = lastCharOf(children[index]);
    if (found) return found;
  }
  return null;
}
