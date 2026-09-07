// Markdown → sanitized DOM, with source-line annotations for scroll sync and
// syntax-highlighted fenced code using the same Lezer grammars as the editor.

import { marked, DOMPurify, highlightCode, classHighlighter, LanguageDescription, languages } from '../../vendor/editor.js';

marked.setOptions({ gfm: true, breaks: false });

// Heading ids so in-document links (#section) work in the preview.
const slugger = (text) => text.toLowerCase().trim().replace(/<[^>]+>/g, '')
  .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

let briefRendering = false;
let briefSplit = false;
let briefLang = null; // grammar of the file the current brief section is about
/** In brief mode, diff hunks render collapsed so the prose reads first; `split` lays them out side by side. */
export function setBriefRendering(on, { split = false } = {}) { briefRendering = on; briefSplit = split; }

/**
 * Side-by-side layout of a unified hunk. Context lines go to both columns; a run
 * of removed lines pairs row by row with the run of added lines that follows it;
 * leftovers get an empty cell. Each column is highlighted as one text so the
 * grammar keeps its context across lines.
 */
function highlightDiffSplit(text, langName) {
  const lines = text.split('\n');
  const rows = [];   // { kind: 'hunk', text } | { l: idx|null, r: idx|null }
  const left = [];   // code lines shown in the left column, in order
  const right = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('@@')) { rows.push({ kind: 'hunk', text: l }); continue; }
    const m = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
    if (m === ' ') { rows.push({ l: left.push(l.slice(1)) - 1, r: right.push(l.slice(1)) - 1, ctx: true }); continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i][0] === '-') dels.push(lines[i++].slice(1));
    while (i < lines.length && lines[i][0] === '+') adds.push(lines[i++].slice(1));
    i--;
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ l: k < dels.length ? left.push(dels[k]) - 1 : null, r: k < adds.length ? right.push(adds[k]) - 1 : null });
    }
  }
  const hl = (arr) => (langName ? highlight(arr.join('\n'), langName) : escapeHtml(arr.join('\n'))).split('\n');
  const L = hl(left), R = hl(right);
  const cell = (cls, marker, html) => `<span class="diff-cell ${cls}"><span class="diff-marker">${marker}</span>${html}\n</span>`;
  return rows.map((r) => {
    if (r.kind === 'hunk') return `<span class="diff-cell diff-hunk diff-span2">${escapeHtml(r.text)}\n</span>`;
    const lc = r.l === null ? '<span class="diff-cell diff-empty">\n</span>' : cell(r.ctx ? 'diff-ctx' : 'diff-del', r.ctx ? ' ' : '-', L[r.l] ?? '');
    const rc = r.r === null ? '<span class="diff-cell diff-empty">\n</span>' : cell(r.ctx ? 'diff-ctx' : 'diff-add', r.ctx ? ' ' : '+', R[r.r] ?? '');
    return lc + rc;
  }).join('');
}

/**
 * A brief's hunk: each line keeps its +/-/space marker, the code after it is
 * highlighted with the file's grammar (context preserved across lines), and
 * added/removed lines get a class for a background tint.
 */
function highlightDiff(text, langName) {
  const lines = text.split('\n');
  const markers = lines.map((l) => (l.startsWith('@@') ? '@' : l[0] === '+' || l[0] === '-' ? l[0] : ' '));
  const code = lines.map((l, i) => (markers[i] === '@' ? '' : l.slice(1))).join('\n');
  const highlighted = (langName ? highlight(code, langName) : escapeHtml(code)).split('\n');
  return lines.map((l, i) => {
    const m = markers[i];
    // the newline lives inside the block span: no text nodes between lines, so no stray line boxes
    if (m === '@') return `<span class="diff-line diff-hunk">${escapeHtml(l)}\n</span>`;
    const cls = m === '+' ? 'diff-add' : m === '-' ? 'diff-del' : 'diff-ctx';
    return `<span class="diff-line ${cls}"><span class="diff-marker">${m}</span>${highlighted[i] ?? ''}\n</span>`;
  }).join('');
}

marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      return `<h${depth} id="${slugger(text)}">${text}</h${depth}>\n`;
    },
    code({ text, lang }) {
      const name = (lang || '').trim().split(/\s+/)[0];
      const isBriefDiff = briefRendering && name === 'diff';
      const html = isBriefDiff ? (briefSplit ? highlightDiffSplit(text, briefLang) : highlightDiff(text, briefLang)) : highlight(text, name);
      const cls = name ? ` class="language-${escapeAttr(name)}${isBriefDiff && briefSplit ? ' diff-split' : ''}"` : '';
      const pre = `<pre><code${cls}>${html}</code></pre>\n`;
      if (isBriefDiff) {
        const n = text.split('\n').length;
        return `<details class="rb-hunk"><summary>diff · ${n} line${n === 1 ? '' : 's'}</summary>${pre}</details>\n`;
      }
      return pre;
    },
  },
});

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** Highlight a code string with a bundled grammar; falls back to plain text. */
export function highlight(code, langName) {
  const desc = langName ? LanguageDescription.matchLanguageName(languages, langName, true) : null;
  const language = desc?.support?.language;
  if (!language) return escapeHtml(code);
  let out = '';
  try {
    const tree = language.parser.parse(code);
    highlightCode(code, tree, classHighlighter,
      (text, classes) => { out += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text); },
      () => { out += '\n'; });
  } catch {
    return escapeHtml(code);
  }
  return out;
}

const purifyConfig = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['data-line', 'target'],
  FORBID_TAGS: ['style', 'script'],
};

/**
 * Render markdown into a DocumentFragment. Every top-level block carries a
 * `data-line` attribute with its 1-based source line, used for scroll sync.
 */
export function renderMarkdown(src) {
  // YAML front matter is metadata, not content: skip it (its lines still count for scroll sync)
  const fm = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  let line = 1;
  if (fm) { src = src.slice(fm[0].length); line += countLines(fm[0]); }
  const tokens = marked.lexer(src);
  const fragment = document.createDocumentFragment();
  briefLang = null;
  let section = null; // brief mode: the <section class="rb-file"> of the file being rendered
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lines = countLines(token.raw);
    if (briefRendering && token.type === 'hr') {
      // the `---` that precedes a file heading: the card gap replaces it
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === 'space') j++;
      if (tokens[j]?.type === 'heading' && tokens[j].depth === 2) { line += lines; continue; }
    }
    if (briefRendering && token.type === 'heading' && token.depth === 2) {
      section = document.createElement('section');
      section.className = 'rb-file';
      fragment.append(section);
    }
    if (briefRendering && token.type === 'heading') {
      // `## `path` — …` and `### `sig` — … · `path:lines`` name the file; keep its grammar for the hunks that follow
      const paths = [...token.text.matchAll(/`([^`\s]+?)(?::\d+-\d+)?`/g)].map((m) => m[1]).filter((p) => p.includes('.') && !p.includes('('));
      const path = paths[token.depth === 2 ? 0 : paths.length - 1];
      if (path) briefLang = LanguageDescription.matchFilename(languages, path)?.name ?? null;
    }
    if (token.type !== 'space') {
      const html = marked.parser([token]);
      const template = document.createElement('template');
      template.innerHTML = DOMPurify.sanitize(html, purifyConfig);
      const first = template.content.firstElementChild;
      if (first) first.dataset.line = String(line);
      (section ?? fragment).append(template.content);
    }
    line += lines;
  }
  // file heading: the status after the dash becomes a pill (added / modified / deleted / renamed from …)
  for (const h2 of fragment.querySelectorAll('section.rb-file > h2')) {
    const tn = [...h2.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.includes(' — '));
    if (!tn) continue;
    const idx = tn.nodeValue.indexOf(' — ');
    const rest = tn.splitText(idx);
    rest.nodeValue = rest.nodeValue.slice(3);
    const pill = document.createElement('span');
    pill.className = `rb-status rb-status-${rest.nodeValue.trim().split(/\s/)[0]}`;
    for (let n = rest; n; ) { const next = n.nextSibling; pill.append(n); n = next; }
    h2.append(pill);
  }
  for (const a of fragment.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^https?:\/\//i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    else if (briefRendering && !/^[#?/]|^[a-z]+:/i.test(href)) {
      // repo-relative link from a review brief: ?file=<path>&line=N opens it in this editor
      const [file, frag] = href.split('#');
      const line = frag?.match(/^L(\d+)/)?.[1];
      a.setAttribute('href', `?file=${encodeURIComponent(file)}${line ? `&line=${line}` : ''}`);
      a.title = `Open ${file}${line ? ` at line ${line}` : ''} (middle-click for a new tab)`;
    }
  }
  return fragment;
}

function countLines(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Render markdown to a sanitized HTML string (for export). */
export function markdownToHTML(src) {
  const div = document.createElement('div');
  div.append(renderMarkdown(src));
  return div.innerHTML;
}

/** Word count and reading time for the status bar. */
export function textStats(src) {
  const words = src.trim() ? src.trim().split(/\s+/).length : 0;
  return { words, chars: src.length, minutes: Math.max(1, Math.round(words / 220)) };
}
