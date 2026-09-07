// The document shown on first launch. It doubles as a feature tour.

export const WELCOME_NAME = 'Welcome.md';

export const WELCOME = `# Welcome to xor

A small, fast, offline-first editor for **Markdown** and code. It runs entirely in your browser, installs as an app, and never sends your text anywhere.

## Getting around

| Do this | Press |
| --- | --- |
| Command palette | \`⌘K\` |
| New document | \`⌘N\` |
| Open a file from disk | \`⌘O\` |
| Save | \`⌘S\` |
| Cycle editor → split → preview | \`⌘E\` |
| Toggle vim mode | \`⌘⇧V\` |
| Pick a color scheme | \`⌘⇧T\` |
| Zen mode | \`⌘⇧Z\` |
| Keyboard reference | \`⌘/\` |

On Windows and Linux use \`Ctrl\` instead of \`⌘\`.

## Vim mode

Vim mode is on by default. The usual keys work — \`hjkl\`, \`ciw\`, \`dd\`, \`.\`, visual mode, \`/\` search, registers, macros — and the ex command line understands a few app commands too:

- \`:w\` saves, \`:wq\` saves and closes, \`:q\` closes
- \`:e notes.md\` opens a stored document, \`:e\` alone opens the file picker
- \`:colo nord\` switches the color scheme
- \`:set nowrap\`, \`:set nu\`, \`:set ts=4\`
- \`:pre\` toggles the preview, \`:sp\` shows both, \`:zen\` hides the chrome

Prefer normal editing? Turn vim off with \`⌘⇧V\` and everything behaves like a regular editor.

## Markdown preview

The pane on the right renders GitHub-flavored Markdown as you type, with scroll sync in both directions. Double-click any block in the preview to jump the cursor to its source.

- [x] Tables, task lists, footnote-free GFM
- [x] Fenced code with syntax highlighting
- [ ] Your next idea

\`\`\`js
// Code fences are highlighted with the same grammars as the editor.
export function greet(name = 'world') {
  return \`Hello, \${name}!\`;
}
\`\`\`

\`\`\`python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
\`\`\`

> Everything you write is stored in this browser's IndexedDB and autosaved as you type. Use **Save as…** to link a document to a real file on disk; after that, \`⌘S\` writes straight to it.

## Code, too

Name a document \`main.rs\`, \`app.ts\`, \`style.css\` or \`config.toml\` and the editor switches grammar automatically. The preview pane hides itself for non-Markdown files.

## Why "xor"?

\`a XOR b\` is the set of bits that differ between two values, and a diff is the xor of two revisions. This editor's other job is reading review briefs: the changed hunks between a base and a head, with the prose that explains them. The name is that operation.

Under the hood there is no framework: web components, CSS custom properties, IndexedDB, the File System Access API and a service worker. The only library is CodeMirror, bundled once so it works offline.

Delete this document whenever you like — \`⌘N\` starts a fresh one.
`;
