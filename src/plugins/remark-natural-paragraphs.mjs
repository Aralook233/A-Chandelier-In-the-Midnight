/**
 * The manuscript marks every natural paragraph with a hard line break (two
 * trailing spaces) instead of a blank line, so Remark collapses a whole chapter
 * into one <p> full of <br>. Indentation and paragraph spacing then apply only
 * to the first line, which is why 正文 renders as a wall of text.
 *
 * Splitting at each break restores one <p> per natural paragraph without
 * touching the .md sources.
 */
export default function remarkNaturalParagraphs() {
  return (tree) => {
    splitContainers(tree);
  };
}

function splitContainers(node) {
  if (!node || !Array.isArray(node.children)) return;

  node.children.forEach(splitContainers);

  const rebuilt = [];
  for (const child of node.children) {
    const parts = child.type === 'paragraph' ? splitParagraph(child) : null;
    if (parts === null) rebuilt.push(child);
    else rebuilt.push(...parts);
  }
  node.children = rebuilt;
}

function splitParagraph(node) {
  if (!node.children.some((child) => child.type === 'break')) return null;

  const groups = [[]];
  for (const child of node.children) {
    if (child.type === 'break') {
      groups.push([]);
      continue;
    }
    groups[groups.length - 1].push(child);
  }

  return groups.map(trimEdges).filter((children) => children.length > 0).map((children) => ({ type: 'paragraph', children }));
}

function trimEdges(children) {
  const kept = children.map((child) => (child.type === 'text' ? { ...child } : child));

  while (kept.length && kept[0].type === 'text' && !kept[0].value.trim()) kept.shift();
  while (kept.length && kept[kept.length - 1].type === 'text' && !kept[kept.length - 1].value.trim()) kept.pop();

  if (kept[0] && kept[0].type === 'text') kept[0].value = kept[0].value.replace(/^\s+/, '');
  const last = kept[kept.length - 1];
  if (last && last.type === 'text') last.value = last.value.replace(/\s+$/, '');

  return kept;
}
