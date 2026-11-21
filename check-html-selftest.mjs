// check-html-selftest.mjs — prove the nesting checker catches the bug that
// actually happened: a card header deleted while its list survived.
// Runs the checker's logic over an in-memory string; touches no files.
const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'col', 'embed', 'track', 'wbr']);
const BLOCK = new Set(['div', 'ul', 'li', 'p', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'span', 'b', 'h1', 'h2', 'pre', 'select', 'textarea', 'button', 'a', 'html', 'head', 'body', 'script']);

function problems(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  let n = 0;
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const closing = m[1] === '/', tag = m[2].toLowerCase(), selfClose = m[3] === '/';
    if (!BLOCK.has(tag) || VOID.has(tag) || selfClose) continue;
    if (!closing) stack.push(tag);
    else if (stack.pop() !== tag) n++;
  }
  return n + (stack.length ? 1 : 0);
}

const good = '<div class="card"><h2>T</h2><ul><li>a</li></ul></div>';
const broken = '<div class="card"><h2>T</h2><ul><li>a</li></ul></div><ul><li>orphan</li></ul></div>';

console.log('well-formed  ->', problems(good), 'problem(s) (expect 0)');
console.log('orphan list  ->', problems(broken), 'problem(s) (expect >0)');
process.exit(problems(good) === 0 && problems(broken) > 0 ? 0 : 1);
