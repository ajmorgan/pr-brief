// Everything the app needs from npm, re-exported through one module.
// Built by build.mjs into vendor/editor.js.

export { EditorState, Compartment, EditorSelection, RangeSetBuilder } from '@codemirror/state';
export {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor,
  highlightActiveLine, placeholder, scrollPastEnd, Decoration, ViewPlugin,
} from '@codemirror/view';
export {
  defaultKeymap, history, historyKeymap, indentWithTab, toggleComment,
  undo, redo, selectAll,
} from '@codemirror/commands';
export {
  syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching,
  foldGutter, foldKeymap, LanguageDescription, LanguageSupport, StreamLanguage,
  indentUnit, foldAll, unfoldAll, foldService, foldEffect, unfoldEffect, foldedRanges,
} from '@codemirror/language';
export {
  searchKeymap, highlightSelectionMatches, openSearchPanel, replaceAll,
} from '@codemirror/search';
export {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
} from '@codemirror/autocomplete';
export { lintKeymap } from '@codemirror/lint';
export { tags, highlightCode, highlightTree, classHighlighter } from '@lezer/highlight';

export { vim, Vim, getCM } from '@replit/codemirror-vim';

export { marked } from 'marked';
export { default as DOMPurify } from 'dompurify';

// --- Languages -------------------------------------------------------------
import { LanguageDescription, StreamLanguage, LanguageSupport } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/lang-go';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { java } from '@codemirror/lang-java';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { c, csharp, kotlin, scala, objectiveC } from '@codemirror/legacy-modes/mode/clike';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { r } from '@codemirror/legacy-modes/mode/r';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';

// Wrapped in LanguageSupport so `desc.support.language` exists — the markdown
// parser reads it for fenced blocks, and a bare StreamLanguage has no `.language`.
const legacy = (mode) => new LanguageSupport(StreamLanguage.define(mode));

/** Static list of languages. Each is bundled, so everything works offline. */
export const languages = [
  LanguageDescription.of({ name: 'JavaScript', alias: ['js', 'javascript', 'mjs', 'cjs'], extensions: ['js', 'mjs', 'cjs'], support: javascript() }),
  LanguageDescription.of({ name: 'JSX', alias: ['jsx'], extensions: ['jsx'], support: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'TypeScript', alias: ['ts', 'typescript'], extensions: ['ts', 'mts', 'cts'], support: javascript({ typescript: true }) }),
  LanguageDescription.of({ name: 'TSX', alias: ['tsx'], extensions: ['tsx'], support: javascript({ jsx: true, typescript: true }) }),
  LanguageDescription.of({ name: 'HTML', alias: ['html', 'htm', 'xhtml'], extensions: ['html', 'htm'], support: html() }),
  LanguageDescription.of({ name: 'CSS', alias: ['css'], extensions: ['css'], support: css() }),
  LanguageDescription.of({ name: 'JSON', alias: ['json', 'json5'], extensions: ['json', 'webmanifest', 'jsonc'], support: json() }),
  LanguageDescription.of({ name: 'Python', alias: ['py', 'python'], extensions: ['py', 'pyw'], support: python() }),
  LanguageDescription.of({ name: 'Rust', alias: ['rs', 'rust'], extensions: ['rs'], support: rust() }),
  LanguageDescription.of({ name: 'C++', alias: ['cpp', 'c++', 'cc', 'cxx', 'hpp'], extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh'], support: cpp() }),
  LanguageDescription.of({ name: 'C', alias: ['c', 'h'], extensions: ['c', 'h'], support: legacy(c) }),
  LanguageDescription.of({ name: 'C#', alias: ['cs', 'csharp', 'c#'], extensions: ['cs'], support: legacy(csharp) }),
  LanguageDescription.of({ name: 'Objective-C', alias: ['objc', 'objectivec'], extensions: ['m', 'mm'], support: legacy(objectiveC) }),
  LanguageDescription.of({ name: 'Kotlin', alias: ['kt', 'kotlin'], extensions: ['kt', 'kts'], support: legacy(kotlin) }),
  LanguageDescription.of({ name: 'Scala', alias: ['scala'], extensions: ['scala', 'sc'], support: legacy(scala) }),
  LanguageDescription.of({ name: 'Go', alias: ['go', 'golang'], extensions: ['go'], support: go() }),
  LanguageDescription.of({ name: 'Java', alias: ['java'], extensions: ['java'], support: java() }),
  LanguageDescription.of({ name: 'SQL', alias: ['sql', 'mysql', 'pgsql', 'sqlite'], extensions: ['sql'], support: sql() }),
  LanguageDescription.of({ name: 'YAML', alias: ['yaml', 'yml'], extensions: ['yaml', 'yml'], support: yaml() }),
  LanguageDescription.of({ name: 'XML', alias: ['xml', 'svg', 'plist'], extensions: ['xml', 'svg', 'plist', 'xsl'], support: xml() }),
  LanguageDescription.of({ name: 'Shell', alias: ['sh', 'bash', 'zsh', 'shell', 'console'], extensions: ['sh', 'bash', 'zsh'], support: legacy(shell) }),
  LanguageDescription.of({ name: 'Ruby', alias: ['rb', 'ruby'], extensions: ['rb', 'rake', 'gemspec'], support: legacy(ruby) }),
  LanguageDescription.of({ name: 'Lua', alias: ['lua'], extensions: ['lua'], support: legacy(lua) }),
  LanguageDescription.of({ name: 'TOML', alias: ['toml'], extensions: ['toml'], support: legacy(toml) }),
  LanguageDescription.of({ name: 'Swift', alias: ['swift'], extensions: ['swift'], support: legacy(swift) }),
  LanguageDescription.of({ name: 'Diff', alias: ['diff', 'patch'], extensions: ['diff', 'patch'], support: legacy(diff) }),
  LanguageDescription.of({ name: 'Dockerfile', alias: ['dockerfile', 'docker'], filename: /^Dockerfile$/i, support: legacy(dockerFile) }),
  LanguageDescription.of({ name: 'Haskell', alias: ['hs', 'haskell'], extensions: ['hs'], support: legacy(haskell) }),
  LanguageDescription.of({ name: 'Clojure', alias: ['clj', 'clojure', 'edn'], extensions: ['clj', 'cljs', 'edn'], support: legacy(clojure) }),
  LanguageDescription.of({ name: 'Erlang', alias: ['erl', 'erlang'], extensions: ['erl'], support: legacy(erlang) }),
  LanguageDescription.of({ name: 'Perl', alias: ['pl', 'perl'], extensions: ['pl', 'pm'], support: legacy(perl) }),
  LanguageDescription.of({ name: 'PowerShell', alias: ['ps1', 'powershell', 'pwsh'], extensions: ['ps1', 'psm1'], support: legacy(powerShell) }),
  LanguageDescription.of({ name: 'R', alias: ['r'], extensions: ['r', 'R'], support: legacy(r) }),
  LanguageDescription.of({ name: 'Properties', alias: ['ini', 'properties', 'cfg', 'conf'], extensions: ['ini', 'properties', 'cfg', 'conf', 'env'], support: legacy(properties) }),
  LanguageDescription.of({ name: 'Nginx', alias: ['nginx'], filename: /nginx.*\.conf$/i, support: legacy(nginx) }),
];

/** Markdown with fenced-code highlighting for every bundled language. */
export const markdownLanguageDescription = LanguageDescription.of({
  name: 'Markdown', alias: ['md', 'markdown', 'mkd'], extensions: ['md', 'markdown', 'mkd', 'mdx'],
  support: markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
});
languages.unshift(markdownLanguageDescription);

// Not a real LanguageDescription: it has no grammar. Consumers treat a null support as "no language".
export const plainText = { name: 'Plain text', alias: ['txt', 'text', 'plain'], extensions: ['txt', 'text', 'log'], support: null };
