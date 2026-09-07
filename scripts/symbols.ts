// symbols.ts — the symbol scanner shared by extract.ts (units of a diff) and
// viewer.ts (outline of one file): ast-grep over the skill's rules, plus the
// signature/identity helpers that turn a match into a named, scoped symbol.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// ast-grep binary: `ast-grep` or the older `sg`, or null when neither runs.
export function findAstGrep(): string | null {
  for (const cand of ["ast-grep", "sg"]) {
    const r = spawnSync(cand, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /ast-grep/.test(r.stdout)) return cand;
  }
  return null;
}

export interface Sym {
  name: string; kind: string; scope: string; start: number; end: number;
  declLine: number; // the declaration's own first line: `start` may sit above it, on the comment the span includes
  signature: string; text: string;
  bs: number; be: number; // byte offsets of the declaration: nesting is decided on these, so same-line symbols nest correctly
  col: number; // start column, to tell two symbols on one line apart
  disc?: string; // "(params)" when siblings share name and kind (overloads), else absent
  clauses?: boolean; // one of several sibling nodes that make up a unit (a Haskell function's signature and equations)
}

export function scanSymbols(sg: string, dir: string): Map<string, Sym[]> {
  const out = new Map<string, Sym[]>();
  if (!fs.existsSync(dir)) return out;
  // --no-ignore hidden: .github/, .claude/ and other dot-directories hold real files (workflows, skills)
  const r = spawnSync(sg, ["scan", "-c", path.join(SKILL_DIR, "sgconfig.yml"), "--json=compact", "--no-ignore", "hidden", "."], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ast-grep scan failed in ${dir}:\n${r.stderr}`);
  const matches = r.stdout.trim() ? JSON.parse(r.stdout) : [];
  const byFile = new Map<string, any[]>();
  for (const m of matches) {
    const rel = m.file.replace(/^\.\//, "");
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push(m);
  }
  for (const [rel, ms] of byFile) {
    const content = fs.readFileSync(path.join(dir, rel), "utf8").split("\n");
    const syms: Sym[] = ms.map((m) => {
      let start = m.range.start.line + 1;
      // a node that ends at column 0 of a line (Markdown sections end where the next heading starts)
      // does not own that line
      const end = m.range.end.column === 0 && m.range.end.line > m.range.start.line ? m.range.end.line : m.range.end.line + 1;
      // rule id <lang>-<kind>[.<variant>]: the kind names the unit, the variant only selects a shape
      const [kind, variant] = m.ruleId.replace(/^[a-z]+-/, "").split(".");
      // Javadoc / comment lines directly above a declaration belong to it, not to the enclosing container;
      // so do a Rust outer attribute (#[test]) and a Haskell pragma or block comment ({-# INLINE f #-})
      while (start > 1 && /^\s*(\/\/|\/\*|\*|\*\/|#\[|\{-)/.test(content[start - 2] ?? "")) start--;
      let name = m.metaVariables?.single?.NAME?.text ?? fallbackName(kind, variant, m.text);
      name = name.replace(/\s+/g, " ").trim();
      if (kind === "test" || kind === "function") name = name.replace(/^[`'"]|[`'"]$/g, "");
      if (kind === "key" || kind === "item") name = name.replace(/^["']|["']$/g, "");
      let signature = signatureOf(m.text, kind);
      if (kind === "const") { const kw = (content[m.range.start.line] ?? "").match(/^\s*(?:export\s+)?(let|var)\b/)?.[1]; if (kw) signature = `${kw} ${signature}`; }
      const sym: Sym = { name, kind, scope: "", start, end, declLine: m.range.start.line + 1, bs: m.range.byteOffset.start, be: m.range.byteOffset.end, col: m.range.start.column, signature, text: m.text };
      // a rule may name the scope itself (a Go method's receiver type, a C++ `Svc::` qualifier) instead of relying on nesting
      const explicit = m.metaVariables?.single?.SCOPE?.text;
      if (explicit) sym.scope = explicit.replace(/^\*/, "").replace(/<[^<>]*>/g, "").replace(/::/g, ".").trim(); // `Box<T>::get` keys under Box, like its in-class declaration
      if (m.ruleId === "hs-function") sym.clauses = true;
      return sym;
    });
    syms.sort((x, y) => x.start - y.start || y.end - x.end);
    for (const s of syms) {
      const enclosing = syms.filter((e) => e !== s && e.bs <= s.bs && e.be >= s.be && !(e.bs === s.bs && e.be === s.be));
      enclosing.sort((x, y) => x.bs - y.bs || y.be - x.be);
      s.scope = [...enclosing.map((e) => e.name), ...(s.scope ? [s.scope] : [])].join(".");
    }
    mergeClauses(syms); // after scopes: an instance's last method and a same-named top-level function that follows it stay apart
    out.set(rel, syms);
  }
  return out;
}
// A Haskell function is one signature and one node per equation, all siblings carrying its name:
// merged into one symbol running from the first to the last, so `fact` is one unit, not three.
// Adjacent in file order, same name and scope, not nested: nothing can lie between two of them.
function mergeClauses(syms: Sym[]): void {
  for (let i = 1; i < syms.length; i++) {
    const a = syms[i - 1], b = syms[i];
    if (!a.clauses || !b.clauses || a.name !== b.name || a.kind !== b.kind || a.scope !== b.scope || b.bs < a.be) continue;
    a.end = b.end; a.be = b.be; a.text += "\n" + b.text;
    if (/::/.test(b.signature) && !/::/.test(a.signature)) a.signature = b.signature; // the type signature, wherever it sits
    syms.splice(i--, 1);
  }
}
// A name for a unit whose rule captures none: a heading's text, an at-rule's head, an impl block's
// head, an operator's symbol, or the kind itself.
function fallbackName(kind: string, variant: string | undefined, text: string): string {
  const first = text.split("\n")[0].trim();
  // `impl<T> fmt::Display for Box<T> {` → "fmt::Display for Box<T>"; `instance Runner Color where` → "Runner Color"
  if (kind === "impl" || kind === "instance") return first.replace(/^(impl|instance)\s*(<[^>]*>)?\s*/, "").replace(/\s*(\{.*|where\s*)$/, "").trim();
  if (variant === "operator" || variant === "conversion") { const m = first.match(/\boperator\s*([^\s(]+)/); if (m) return /^\w/.test(m[1]) ? `operator ${m[1]}` : `operator${m[1]}`; }
  // a section is named by its heading line, which need not be its first line (text before a setext
  // heading, or a setext heading itself, belongs to the enclosing ATX section)
  if (kind === "section") return (text.split("\n").find((l) => /^\s*#+\s/.test(l)) ?? first).trim().replace(/^#+\s*/, "").replace(/\s*#+$/, "");
  if (kind === "rule" && variant === "at") return first.replace(/\s*\{.*$/, "");
  return variant ?? kind;
}

// The declaration up to its body, on one line, without annotation-only lines
// (`@Bean`, `@Test`): parameters on continuation lines are part of it, so a
// changed parameter list is a signature change.
export function signatureOf(text: string, kind: string): string {
  // markup and data units: the first line is the whole signature
  if (kind === "element" || kind === "script" || kind === "style") { const l = text.split("\n")[0].trim(); const gt = l.indexOf(">"); return gt > 0 ? l.slice(0, gt + 1) : l; }
  if (kind === "key" || kind === "item" || kind === "section" || kind === "doc") return text.split("\n")[0].trim();
  if (kind === "rule" || kind === "block") return text.split("\n")[0].trim().replace(/\s*\{.*$/, "");
  let rest = text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/,? \)/g, ")").trim();
  // drop leading annotations / decorators, including multi-line ones with balanced parentheses
  for (;;) {
    const m = rest.match(/^@[\w.]+/);
    if (!m) break;
    let j = m[0].length, depth = 0;
    if (rest[j] === "(") { for (; j < rest.length; j++) { if (rest[j] === "(") depth++; else if (rest[j] === ")" && --depth === 0) { j++; break; } } }
    rest = rest.slice(j).trim();
  }
  if (kind === "test") return rest.slice(0, 120);
  if (kind === "field" || kind === "const") { const c = rest.search(/[=;]/); return (c > 0 ? rest.slice(0, c) : rest).trim(); }
  // stop at the body: the first `{`, `;` or `=>` outside parentheses/brackets (destructured params
  // contain `{`); a Python def/class header ends at its `:`, a Lua function's at its parameter list,
  // a Kotlin expression body starts at ` = `
  const py = /^(async\s+)?(def|class)\b/.test(rest), lua = /^(local\s+)?function\b/.test(rest);
  let depth = 0;
  for (let j = 0; j < rest.length; j++) {
    const ch = rest[j];
    if (ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === ">") { depth = Math.max(0, depth - 1); if (lua && ch === ")" && depth === 0) return rest.slice(0, j + 1).trim(); }
    else if (depth === 0 && (ch === "{" || ch === ";" || rest.startsWith("=>", j))) return rest.slice(0, j).trim();
    else if (depth === 0 && py && ch === ":") return rest.slice(0, j).trim();
    else if (depth === 0 && (kind === "function" || kind === "method") && rest.startsWith(" = ", j)) return rest.slice(0, j).trim();
  }
  return rest.replace(/\s+where$/, "").trim(); // a Haskell class/instance head: `class Runner a where`
}

export function symKey(s: Sym): string { return `${s.scope ? s.scope + "." : ""}${s.name}${s.disc ?? ""}|${s.kind}`; }
// an ordinal discriminator (#n, for same-named symbols with no parameter list) keys the symbol but is
// not part of its id: duplicate ids get a line suffix later, which is what the reader can find
export function qualName(s: { scope: string; name: string; disc?: string }): string { return `${s.scope ? s.scope + "." : ""}${s.name}${s.disc && !s.disc.startsWith("#") ? s.disc : ""}`; }
// the parameter list of a signature, whitespace-normalised: "(Order o, boolean force)"
export function paramsOf(sig: string): string {
  const i = sig.indexOf("("); if (i < 0) return "";
  let depth = 0;
  for (let j = i; j < sig.length; j++) { if (sig[j] === "(") depth++; else if (sig[j] === ")" && --depth === 0) return sig.slice(i, j + 1).replace(/\s+/g, " "); }
  return sig.slice(i).replace(/\s+/g, " ");
}
export function innermost(syms: Sym[], line: number): Sym | null {
  let best: Sym | null = null;
  for (const s of syms) if (s.start <= line && line <= s.end && (!best || s.be - s.bs < best.be - best.bs)) best = s;
  return best;
}
export function displayName(sig: string, name: string, kind = ""): string {
  if (kind === "test") return `"${name}"`;
  if (kind === "doc") return name;
  let d = sig.replace(/\s*\{\s*$/, "").replace(/;\s*$/, "").trim();
  d = d.replace(/^(?:(?:export|default|public|private|protected|static|async|abstract|final|override|readonly|declare|synchronized|native|function|const|let|var|def|fun|func|local|suspend|open|data|sealed|inline|internal|companion|object|val|type|fn|pub(?:\([^)]*\))?|unsafe|extern|constexpr|virtual|explicit|partial)\s+)+/, ""); // impl, instance, struct, enum, trait, class keep their keyword
  if (!d.includes(name)) return name;
  return d.length > 100 ? d.slice(0, 97) + "…" : d;
}
