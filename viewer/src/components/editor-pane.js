// <editor-pane>: wraps a CodeMirror 6 view.
//
// Emits: doc-change {value}, cursor-change {line, col, selected}, editor-scroll
// {line, fraction}, vim-mode {mode}, ex-command {name, args}.
// Keeps one EditorState per document id so undo history, selection and
// scroll position survive switching between documents.

import {
  EditorState, EditorSelection, Compartment, EditorView, keymap, lineNumbers, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor,
  highlightActiveLine, placeholder, scrollPastEnd, defaultKeymap, history, historyKeymap,
  indentWithTab, syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter,
  foldKeymap, LanguageDescription, indentUnit, searchKeymap, highlightSelectionMatches,
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, lintKeymap, tags as t,
  vim, Vim, getCM, languages, plainText, foldService, foldEffect, unfoldEffect,
  Decoration, ViewPlugin, RangeSetBuilder, highlightTree, foldedRanges, foldAll, unfoldAll,
} from '../../vendor/editor.js';

// --- Syntax colors come from CSS variables so every scheme shares one style.
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.character, t.regexp], color: 'var(--syn-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.literal, t.unit, t.color], color: 'var(--syn-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], color: 'var(--syn-fn)' },
  { tag: [t.propertyName, t.definition(t.variableName), t.labelName, t.self], color: 'var(--syn-variable)' },
  { tag: [t.typeName, t.className, t.namespace, t.annotation, t.standard(t.typeName)], color: 'var(--syn-type)' },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator, t.derefOperator, t.updateOperator], color: 'var(--syn-operator)' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: 'var(--syn-heading)', fontWeight: 'bold' },
  { tag: [t.link, t.url], color: 'var(--syn-link)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--syn-emphasis)' },
  { tag: t.strong, fontWeight: 'bold', color: 'var(--syn-emphasis)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: [t.punctuation, t.bracket, t.separator, t.paren, t.brace, t.squareBracket], color: 'var(--syn-punctuation)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-tag)' },
  { tag: [t.attributeName, t.attributeValue], color: 'var(--syn-attribute)' },
  { tag: [t.meta, t.processingInstruction, t.contentSeparator, t.escape], color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--syn-string)' },
  { tag: t.invalid, color: 'var(--syn-invalid)', textDecoration: 'underline wavy' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
]);

const themeSpec = {
  '&': { backgroundColor: 'var(--bg)', color: 'var(--fg)', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: 'var(--editor-font-size)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--cursor)', padding: '1rem 0 0', maxWidth: 'var(--editor-max-width, none)', margin: '0 auto' },
  '.cm-line': { padding: '0 1rem 0 0.5rem' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--cursor)' },
  '.cm-fat-cursor': { background: 'var(--cursor) !important', color: 'var(--bg) !important' },
  '&:not(.cm-focused) .cm-fat-cursor': { outline: 'solid 1px var(--cursor) !important', background: 'transparent !important', color: 'inherit !important' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-activeLine': { backgroundColor: 'var(--lineHighlight)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--lineHighlight)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--gutter)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.6rem 0 1rem', minWidth: '2.6rem' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--muted)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface2)', border: 'none', color: 'var(--muted)', padding: '0 0.4rem' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: 'var(--match)', outline: '1px solid var(--muted)' },
  '.cm-searchMatch': { backgroundColor: 'var(--match)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent)', color: 'var(--bg)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--match)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--fg)', fontFamily: 'var(--sans)', fontSize: '0.85rem' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel input, .cm-panel select': { background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.15rem 0.4rem', font: 'inherit' },
  '.cm-panel button': { background: 'var(--surface2)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.15rem 0.5rem', font: 'inherit', backgroundImage: 'none' },
  '.cm-panel label': { color: 'var(--muted)' },
  '.cm-vim-panel': { fontFamily: 'var(--mono)', padding: '0.2rem 0.75rem', color: 'var(--fg)' },
  '.cm-vim-panel input': { background: 'transparent', color: 'var(--fg)', border: 'none', fontFamily: 'var(--mono)', flex: '1' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg)', borderRadius: '6px', fontFamily: 'var(--mono)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--selection)', color: 'var(--fg)' },
  '.cm-tooltip .cm-completionIcon': { color: 'var(--muted)' },
  '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'italic' },
  '.cm-diff-add': { backgroundColor: 'color-mix(in srgb, var(--syn-string) 14%, transparent)' },
  '.cm-diff-del': { backgroundColor: 'color-mix(in srgb, var(--syn-invalid) 14%, transparent)' },
  '.cm-diff-hunk': { color: 'var(--muted)', fontStyle: 'italic' },
  '.cm-diff-add .cm-diff-marker': { color: 'var(--syn-string)' },
  '.cm-diff-del .cm-diff-marker': { color: 'var(--syn-invalid)' },
  '.cm-diff-marker': { color: 'var(--muted)' },
  '.cm-specialChar': { color: 'var(--syn-invalid)' },
};

const darkTheme = EditorView.theme(themeSpec, { dark: true });
const lightTheme = EditorView.theme(themeSpec, { dark: false });

// --- Ex commands are defined once, globally; they forward to the owning pane.
function defineEx(name, prefix) {
  Vim.defineEx(name, prefix, (cm, params) => {
    cm.cm6.dom.dispatchEvent(new CustomEvent('ex-command', {
      bubbles: true, composed: true,
      detail: { name, args: params.args ?? [], argString: params.argString ?? '' },
    }));
  });
}
for (const [name, prefix] of [
  ['write', 'w'], ['wq', 'wq'], ['quit', 'q'], ['edit', 'e'], ['new', 'new'], ['set', 'set'],
  ['colorscheme', 'colo'], ['preview', 'pre'], ['split', 'sp'], ['zen', 'zen'], ['help', 'h'],
  ['saveas', 'sav'], ['files', 'files'], ['language', 'lang'], ['export', 'export'],
  // review-brief mode
  ['unit', 'unit'], ['file', 'file'], ['note', 'note'], ['copy', 'copy'], ['changed', 'ch'], ['reload', 'rel'],
]) defineEx(name, prefix);

// ]u / [u step through brief units; delivered as ex-command events like the rest.
for (const [keys, name] of [[']u', 'unit-next'], ['[u', 'unit-prev']]) {
  Vim.defineAction(name, (cm) => {
    cm.cm6.dom.dispatchEvent(new CustomEvent('ex-command', { bubbles: true, composed: true, detail: { name, args: [], argString: '' } }));
  });
  Vim.mapCommand(keys, 'action', name, {}, { context: 'normal' });
}

// --- Brief hunks in the editor: syntax-highlight the code inside ```diff
// fences with the grammar of the file named in the heading above, and tint
// added/removed lines. Decorations only; the document is untouched.
const HEADING_PATH = /`([^`\s]+?)(?::\d+-\d+)?`/g;
const diffAdd = Decoration.line({ class: 'cm-diff-add' });
const diffDel = Decoration.line({ class: 'cm-diff-del' });
const diffHunk = Decoration.line({ class: 'cm-diff-hunk' });
const diffMarker = Decoration.mark({ class: 'cm-diff-marker' });

/** All ```diff blocks in the document with the grammar that applies to each. */
function scanDiffBlocks(doc) {
  const blocks = [];
  let lang = null;
  let open = null; // { fence, start }
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (open) {
      if (text.trim() === open.fence) { blocks.push({ start: open.start, end: n, lang }); open = null; }
      continue;
    }
    const fm = text.match(/^(`{3,})(\w*)/);
    if (fm) { if (fm[2] === 'diff') open = { fence: fm[1], start: n }; continue; }
    if (text.startsWith('## ') || text.startsWith('### ')) {
      const paths = [...text.matchAll(HEADING_PATH)].map((m) => m[1]).filter((p) => p.includes('.') && !p.includes('('));
      const path = paths[text.startsWith('## ') ? 0 : paths.length - 1];
      if (path) lang = languageForName(path).support?.language ?? null;
    }
  }
  return blocks;
}

const diffHighlighter = ViewPlugin.fromClass(class {
  constructor(view) { this.blocks = scanDiffBlocks(view.state.doc); this.decorations = this.build(view); }
  update(u) {
    if (u.docChanged) this.blocks = scanDiffBlocks(u.state.doc);
    if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
  }
  build(view) {
    const doc = view.state.doc;
    const out = [];
    for (const b of this.blocks) {
      const from = doc.line(b.start).to, to = doc.line(b.end).from;
      if (!view.visibleRanges.some((r) => r.from <= to && r.to >= from)) continue;
      const lines = [];
      const code = [];
      for (let n = b.start + 1; n < b.end; n++) {
        const line = doc.line(n);
        const m = line.text.startsWith('@@') ? '@' : line.text[0] === '+' || line.text[0] === '-' ? line.text[0] : ' ';
        out.push({ from: line.from, to: line.from, deco: m === '@' ? diffHunk : m === '+' ? diffAdd : m === '-' ? diffDel : null });
        if (m !== '@' && line.length > 0) out.push({ from: line.from, to: line.from + 1, deco: diffMarker });
        lines.push({ docFrom: line.from + (m === '@' ? 0 : 1), codeFrom: code.reduce((n, c) => n + c.length + 1, 0), text: m === '@' ? '' : line.text.slice(1) });
        code.push(m === '@' ? '' : line.text.slice(1));
      }
      if (b.lang && lines.length) {
        const text = code.join('\n');
        let tree;
        try { tree = b.lang.parser.parse(text); } catch { tree = null; }
        if (tree) {
          let li = 0;
          highlightTree(tree, highlightStyle, (cFrom, cTo, cls) => {
            // map code offsets back to document offsets, splitting at line boundaries
            while (li < lines.length - 1 && lines[li + 1].codeFrom <= cFrom) li++;
            for (let i = li; i < lines.length && lines[i].codeFrom < cTo; i++) {
              const ls = lines[i].codeFrom, le = ls + lines[i].text.length;
              const s = Math.max(cFrom, ls), e = Math.min(cTo, le);
              if (e > s) out.push({ from: lines[i].docFrom + (s - ls), to: lines[i].docFrom + (e - ls), deco: Decoration.mark({ class: cls }) });
            }
          });
        }
      }
    }
    const builder = new RangeSetBuilder();
    const sorted = out.filter((d) => d.deco).sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to);
    for (const d of sorted) builder.add(d.from, d.to, d.deco);
    return builder.finish();
  }
}, { decorations: (v) => v.decorations });

for (const [keys, name, fn] of [['zR', 'unfold-all', unfoldAll], ['zM', 'fold-all', foldAll]]) {
  Vim.defineAction(name, (cm) => { fn(cm.cm6); });
  Vim.mapCommand(keys, 'action', name, {}, { context: 'normal' });
}

// Fold ranges for ```diff fences: from the end of the opening fence line to the
// end of the closing one. Only installed in brief mode.
const hunkFolding = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const open = line.text.match(/^(`{3,})diff\b/);
  if (!open) return null;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (l.text.trim() === open[1]) return { from: line.to, to: l.to };
  }
  return null;
});

export function languageForName(name) {
  return LanguageDescription.matchFilename(languages, name) ?? plainText;
}

export function languageByName(name) {
  return LanguageDescription.matchLanguageName(languages, name, true) ?? plainText;
}

export class EditorPane extends HTMLElement {
  #view;
  #states = new Map();
  #docId = null;
  #language = plainText;
  #settings = {};
  #compartments = {
    language: new Compartment(), vim: new Compartment(), theme: new Compartment(),
    wrap: new Compartment(), gutter: new Compartment(), tab: new Compartment(), brief: new Compartment(), readOnly: new Compartment(),
  };
  #brief = false;

  connectedCallback() {
    if (this.#view) return;
    this.#view = new EditorView({
      state: this.#buildState('', plainText),
      parent: this,
    });
    this.#view.scrollDOM.addEventListener('scroll', () => this.#emitScroll(), { passive: true });
    this.#bindVimEvents();
  }

  disconnectedCallback() {
    this.#view?.destroy();
    this.#view = null;
  }

  get view() { return this.#view; }
  get language() { return this.#language; }
  get languageName() { return this.#language.name; }

  #buildState(content, language, existingSettings = this.#settings) {
    const c = this.#compartments;
    return EditorState.create({
      doc: content,
      extensions: [
        c.vim.of(existingSettings.vim === false ? [] : vim()),
        c.theme.of(document.documentElement.style.colorScheme === 'light' ? lightTheme : darkTheme),
        c.gutter.of(existingSettings.lineNumbers === false ? [] : [lineNumbers(), highlightActiveLineGutter(), foldGutter()]),
        c.wrap.of(existingSettings.lineWrap === false ? [] : EditorView.lineWrapping),
        c.tab.of([indentUnit.of(' '.repeat(existingSettings.tabSize ?? 2)), EditorState.tabSize.of(existingSettings.tabSize ?? 2)]),
        c.language.of(language.support ?? []),
        c.brief.of(this.#brief ? [hunkFolding, diffHighlighter] : []),
        c.readOnly.of([]),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(highlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        scrollPastEnd(),
        placeholder('Start typing… (⌘K for commands)'),
        keymap.of([
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap,
          ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            this.dispatchEvent(new CustomEvent('doc-change', { detail: { value: update.state.doc.toString() } }));
          }
          if (update.selectionSet || update.docChanged) this.#emitCursor(update.state);
        }),
      ],
    });
  }

  #emitCursor(state) {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const selected = state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
    this.dispatchEvent(new CustomEvent('cursor-change', {
      detail: { line: line.number, col: head - line.from + 1, selected, lines: state.doc.lines },
    }));
  }

  #emitScroll() {
    const view = this.#view;
    if (!view) return;
    const top = view.scrollDOM.scrollTop - view.documentPadding.top;
    const block = view.lineBlockAtHeight(Math.max(0, top));
    const line = view.state.doc.lineAt(block.from).number;
    const fraction = block.height ? Math.min(1, Math.max(0, (top - block.top) / block.height)) : 0;
    this.dispatchEvent(new CustomEvent('editor-scroll', { detail: { line, fraction, atBottom: this.#atBottom() } }));
  }

  #atBottom() {
    const s = this.#view.scrollDOM;
    return s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
  }

  #bindVimEvents() {
    // getCM is only available once the vim plugin is active for this state.
    queueMicrotask(() => {
      const cm = getCM(this.#view);
      if (!cm || cm.__bound) return;
      cm.__bound = true;
      cm.on('vim-mode-change', (e) => {
        const mode = e.subMode ? `${e.mode} ${e.subMode}` : e.mode;
        this.dispatchEvent(new CustomEvent('vim-mode', { detail: { mode } }));
      });
      this.dispatchEvent(new CustomEvent('vim-mode', { detail: { mode: 'normal' } }));
    });
  }

  /** Show a document; caches per-id editor state so switching is lossless. */
  openDocument(id, content, name) {
    const view = this.#view;
    if (this.#docId !== null) this.#states.set(this.#docId, view.state);
    this.#docId = id;
    this.#language = languageForName(name);
    const cached = this.#states.get(id);
    if (cached && cached.doc.toString() === content) {
      view.setState(cached);
      view.dispatch({ effects: this.#compartments.language.reconfigure(this.#language.support ?? []) });
    } else {
      view.setState(this.#buildState(content, this.#language));
    }
    this.#bindVimEvents();
    this.#emitCursor(view.state);
    this.dispatchEvent(new CustomEvent('vim-mode', { detail: { mode: this.#settings.vim === false ? '' : 'normal' } }));
  }

  forgetDocument(id) { this.#states.delete(id); }

  /** Read-only keeps navigation (vim motions, search, folding) and blocks edits. */
  setReadOnly(on) {
    this.#view.dispatch({ effects: this.#compartments.readOnly.reconfigure(on ? EditorState.readOnly.of(true) : []) });
  }

  /** Re-detect the language after a rename. */
  setLanguageFromName(name) {
    this.setLanguage(languageForName(name));
  }

  setLanguage(desc) {
    this.#language = desc;
    this.#view.dispatch({ effects: this.#compartments.language.reconfigure(desc.support ?? []) });
  }

  getValue() { return this.#view.state.doc.toString(); }

  setValue(content) {
    this.#view.dispatch({ changes: { from: 0, to: this.#view.state.doc.length, insert: content } });
  }

  focus() { this.#view.focus(); }

  applySettings(settings) {
    const prev = this.#settings;
    this.#settings = { ...settings };
    const c = this.#compartments;
    const effects = [];
    if (prev.vim !== settings.vim) effects.push(c.vim.reconfigure(settings.vim ? vim() : []));
    if (prev.lineNumbers !== settings.lineNumbers) effects.push(c.gutter.reconfigure(settings.lineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []));
    if (prev.lineWrap !== settings.lineWrap) effects.push(c.wrap.reconfigure(settings.lineWrap ? EditorView.lineWrapping : []));
    if (prev.tabSize !== settings.tabSize) effects.push(c.tab.reconfigure([indentUnit.of(' '.repeat(settings.tabSize)), EditorState.tabSize.of(settings.tabSize)]));
    if (effects.length) this.#view.dispatch({ effects });
    if (prev.vim !== settings.vim) {
      if (settings.vim) this.#bindVimEvents();
      else this.dispatchEvent(new CustomEvent('vim-mode', { detail: { mode: '' } }));
    }
    this.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
    if (settings.fontFamily) this.style.setProperty('--mono', settings.fontFamily);
    else this.style.removeProperty('--mono');
  }

  /** Called when the color scheme flips between light and dark. */
  setDark(dark) {
    this.#view.dispatch({ effects: this.#compartments.theme.reconfigure(dark ? darkTheme : lightTheme) });
  }

  /** Scroll so that `line` (1-based) plus a fraction of it sits at the top. */
  scrollToLine(line, fraction = 0) {
    const view = this.#view;
    const doc = view.state.doc;
    const n = Math.min(Math.max(1, Math.round(line)), doc.lines);
    const block = view.lineBlockAt(doc.line(n).from);
    view.scrollDOM.scrollTop = block.top + view.documentPadding.top + fraction * block.height;
  }

  scrollToBottom() {
    const s = this.#view.scrollDOM;
    s.scrollTop = s.scrollHeight;
  }

  /** Jump the cursor to a line and reveal it. */
  gotoLine(line) {
    const doc = this.#view.state.doc;
    const n = Math.min(Math.max(1, line), doc.lines);
    const pos = doc.line(n).from;
    this.#view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    this.focus();
  }

  /** Drop keyboard focus, so keys typed while the pane is hidden go nowhere. */
  blur() { this.#view.contentDOM.blur(); }

  /** Cursor at the end of a line (what vim's A does, for when vim is off). */
  gotoLineEnd(line) {
    const doc = this.#view.state.doc;
    const n = Math.min(Math.max(1, line), doc.lines);
    const pos = doc.line(n).to;
    this.#view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    this.focus();
  }

  /** Wrap the selection (or insert at cursor) — used by markdown formatting commands. */
  wrapSelection(before, after = before, placeholderText = 'text') {
    const view = this.#view;
    view.dispatch(view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to) || placeholderText;
      const insert = before + text + after;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(
          range.from + before.length,
          range.from + before.length + text.length,
        ),
      };
    }));
    this.focus();
  }

  /** Prefix every selected line (for headings, lists, quotes). */
  prefixLines(prefix) {
    const view = this.#view;
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc;
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    const changes = [];
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      const has = line.text.startsWith(prefix);
      changes.push(has ? { from: line.from, to: line.from + prefix.length, insert: '' } : { from: line.from, insert: prefix });
    }
    view.dispatch({ changes });
    this.focus();
  }

  insertText(text) {
    const view = this.#view;
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    this.focus();
  }

  /** Programmatic vim access (for :commands from the palette). */
  vimExec(command) {
    const cm = getCM(this.#view);
    if (cm) Vim.handleEx(cm, command);
  }

  /** Feed normal-mode keys to vim (e.g. 'A' to append at end of line). */
  vimKeys(keys) {
    const cm = getCM(this.#view);
    if (cm) Vim.handleKey(cm, keys);
  }

  // --- Review-brief mode ---------------------------------------------------
  /** Install (or remove) hunk folding; call foldHunks() to collapse them. */
  setBrief(on) {
    this.#brief = on;
    this.#view.dispatch({ effects: this.#compartments.brief.reconfigure(on ? [hunkFolding, diffHighlighter] : []) });
  }

  /** Fold every ```diff hunk in the document. */
  foldHunks() {
    const state = this.#view.state;
    const effects = [];
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      const open = line.text.match(/^(`{3,})diff\b/);
      if (!open) continue;
      for (let m = n + 1; m <= state.doc.lines; m++) {
        const l = state.doc.line(m);
        if (l.text.trim() === open[1]) { effects.push(foldEffect.of({ from: line.to, to: l.to })); n = m; break; }
      }
    }
    if (effects.length) this.#view.dispatch({ effects });
  }

  /** Current 1-based cursor line. */
  get cursorLine() {
    return this.#view.state.doc.lineAt(this.#view.state.selection.main.head).number;
  }

  /** Insert text at the start of a 1-based line (line may be doc.lines + 1 to append). */
  insertAtLine(line, text) {
    const doc = this.#view.state.doc;
    const pos = line > doc.lines ? doc.length : doc.line(line).from;
    this.#view.dispatch({ changes: { from: pos, insert: text } });
  }

  /** Unfold anything folded around a line, so a jump target is visible. */
  revealLine(line) {
    const state = this.#view.state;
    const n = Math.min(Math.max(1, line), state.doc.lines);
    const pos = state.doc.line(n).from;
    // unfoldEffect needs the exact folded range, so look them up
    const effects = [];
    foldedRanges(state).between(pos, pos, (from, to) => { effects.push(unfoldEffect.of({ from, to })); });
    if (effects.length) this.#view.dispatch({ effects });
  }

  unfoldAll() { unfoldAll(this.#view); }
}

customElements.define('editor-pane', EditorPane);
