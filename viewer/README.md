# xor

An offline-first Progressive Web App for editing Markdown and code, and for reading PR briefs. The name is the operation: `a XOR b` is what differs between two values, and a diff is the xor of two revisions. Vim mode, fourteen color schemes, live Markdown preview with two-way scroll sync, real files via the File System Access API, and no framework.

## Run it

The editor lives inside the pr-brief skill; this is its only copy. After changing app code or CSS run `node build.mjs --stamp` (re-stamps the service worker and import map; needs no dependencies). Only a change to `src/vendor-entry.js` or the npm dependencies needs the full `npm install && npm run build`, which requires `node_modules`.


```sh
npm install        # once
npm run build      # bundles CodeMirror into vendor/editor.js and stamps sw.js
npm run dev        # http://127.0.0.1:8787/
```

`npm run watch` rebuilds the vendor bundle and re-stamps the service worker on change. Deploy by copying the directory (minus `node_modules`) to any static host; the service worker needs HTTPS or localhost.

## Features

- **Vim mode** via `@replit/codemirror-vim`: normal, insert, visual, replace, registers, macros, `/` search, and an ex command line with app commands (`:w`, `:wq`, `:q`, `:e`, `:new`, `:sav`, `:colo`, `:set`, `:pre`, `:sp`, `:zen`, `:lang`, `:export`, `:files`, `:h`). Toggle it off with `⌘⇧V` for a conventional editor.
- **Color schemes**: One Dark, GitHub Light/Dark, Dracula, Nord, Gruvbox Dark/Light, Solarized Dark/Light, Catppuccin Mocha/Latte, Tokyo Night, Rosé Pine Dawn, Monokai. Each scheme is one object in `src/lib/themes.js` that drives the app chrome, the editor, and preview code blocks through CSS custom properties. "Follow system" tracks `prefers-color-scheme`.
- **Markdown preview**: GitHub-flavored Markdown (tables, task lists, fenced code highlighted with the editor's grammars), sanitized with DOMPurify, editor/split/preview layouts, proportional scroll sync, double-click a block to jump to its source, export to standalone HTML, print.
- **Code**: 36 languages detected from the file name (JS/TS/JSX/TSX, HTML, CSS, JSON, Python, Rust, C/C++, C#, Go, Java, Kotlin, Swift, SQL, YAML, TOML, Shell, Ruby, Lua, and more), bracket matching, autocompletion, code folding, multiple cursors, search and replace.
- **Documents**: autosaved to IndexedDB as you type; per-document undo history survives switching; open from disk, save back to the same file, drag and drop, OS "Open with" via manifest `file_handlers`.
- **PWA**: installable, works fully offline, update toast when a new version is cached, `?new=1` shortcut, window-controls overlay on desktop.
- **Keyboard first**: command palette (`⌘K`), fuzzy document switcher (`⌘⇧F`), zen mode (`⌘⇧Z`), help (`⌘/`).

## PR-brief mode

A document whose front matter starts `pr-brief:` (written by the `pr-brief` Claude Code skill) gets an outline of files and units in the sidebar, folded `diff` hunks, `]u`/`[u` unit motions, `:unit`, `:file`, `:note`, `:copy` (the unit as a PR comment on the clipboard), `:changed`, and `:rel` (reload from disk). Open one with `?brief=/briefs/<slug>` from the skill's local server (`:w` PUTs back; saves are refused if the file changed on disk since it was read) or from disk like any other file. The server serves several briefs at once; every one it lists appears in the Open list, and a file link opens the file at that brief's commit. See `src/lib/brief.js` and `src/components/brief-outline.js`.

## Layout

```
index.html              app shell (semantic HTML, custom elements)
app.js                  orchestration: documents, settings, shortcuts, PWA hooks
app.css                 chrome and preview typography, driven by CSS variables
sw.js                   service worker (asset list stamped by build.mjs)
manifest.webmanifest    installability, icons, file handlers
src/components/         web components: editor-pane, markdown-preview, file-list,
                        brief-outline, command-palette, status-bar, app-toast, help-dialog
src/lib/                themes, settings (localStorage), store (IndexedDB),
                        markdown (marked + DOMPurify + Lezer highlighting), files,
                        brief (pr-brief model)
src/vendor-entry.js     the npm imports; bundled by esbuild into vendor/editor.js
```

Only the third-party editor libraries are bundled. The application itself is plain ES modules loaded by the browser, built on the web platform directly: custom elements with light DOM, plain module state and DOM events instead of a framework (`src/lib/state.js` holds only `debounce`, `isMac` and `modKey`), `<dialog>` for modals, IndexedDB for records, localStorage for tiny preferences, and the File System Access API for user-owned documents.

## Design notes

What research on well-loved editors (VS Code, Zed, Obsidian, Typora, Dillinger, vim.md) kept pointing to: instant startup, keyboard-driven everything, a command palette, real vim rather than a subset, themes that apply consistently, a preview that matches GitHub and stays in sync, and never losing work. Each of those is a deliberate feature above.
