// Mermaid, bundled on its own by build.mjs into vendor/mermaid.js. It is several
// megabytes, so src/lib/mermaid.js imports it lazily: the first ```mermaid fence in a
// document loads it, a document without one never does.

export { default as mermaid } from 'mermaid';
