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
  signature: string; text: string;
  bs: number; be: number; // byte offsets of the declaration: nesting is decided on these, so same-line symbols nest correctly
  col: number; // start column, to tell two symbols on one line apart
  disc?: string; // "(params)" when siblings share name and kind (overloads), else absent
}

export function scanSymbols(sg: string, dir: string): Map<string, Sym[]> {
  const out = new Map<string, Sym[]>();
  if (!fs.existsSync(dir)) return out;
  const r = spawnSync(sg, ["scan", "-c", path.join(SKILL_DIR, "sgconfig.yml"), "--json=compact", "."], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 });
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
      const end = m.range.end.line + 1;
      // rule id <lang>-<kind>[.<variant>]: the kind names the unit, the variant only selects a shape
      const [kind, variant] = m.ruleId.replace(/^[a-z]+-/, "").split(".");
      // Javadoc / comment lines directly above a declaration belong to it, not to the enclosing container
      while (start > 1 && /^\s*(\/\/|\/\*|\*|\*\/)/.test(content[start - 2] ?? "")) start--;
      let name = m.metaVariables?.single?.NAME?.text ?? fallbackName(kind, variant, m.text);
      name = name.replace(/\s+/g, " ").trim();
      if (kind === "test" || kind === "function") name = name.replace(/^[`'"]|[`'"]$/g, "");
      if (kind === "key") name = name.replace(/^["']|["']$/g, "");
      let signature = signatureOf(m.text, kind);
      if (kind === "const") { const kw = (content[m.range.start.line] ?? "").match(/^\s*(?:export\s+)?(let|var)\b/)?.[1]; if (kw) signature = `${kw} ${signature}`; }
      const sym: Sym = { name, kind, scope: "", start, end, bs: m.range.byteOffset.start, be: m.range.byteOffset.end, col: m.range.start.column, signature, text: m.text };
      // a rule may name the scope itself (a Go method's receiver type) instead of relying on nesting
      const explicit = m.metaVariables?.single?.SCOPE?.text;
      if (explicit) sym.scope = explicit.replace(/^\*/, "").trim();
      return sym;
    });
    syms.sort((x, y) => x.start - y.start || y.end - x.end);
    for (const s of syms) {
      const enclosing = syms.filter((e) => e !== s && e.bs <= s.bs && e.be >= s.be && !(e.bs === s.bs && e.be === s.be));
      enclosing.sort((x, y) => x.bs - y.bs || y.be - x.be);
      s.scope = [...enclosing.map((e) => e.name), ...(s.scope ? [s.scope] : [])].join(".");
    }
    out.set(rel, syms);
  }
  return out;
}
// A name for a unit whose rule captures none: a heading's text, an at-rule's head, or the kind itself.
function fallbackName(kind: string, variant: string | undefined, text: string): string {
  const first = text.split("\n")[0].trim();
  if (kind === "section") return first.replace(/^#+\s*/, "").replace(/\s*#+$/, "");
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
  return rest.trim();
}

export function symKey(s: Sym): string { return `${s.scope ? s.scope + "." : ""}${s.name}${s.disc ?? ""}|${s.kind}`; }
export function qualName(s: { scope: string; name: string; disc?: string }): string { return `${s.scope ? s.scope + "." : ""}${s.name}${s.disc ?? ""}`; }
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
  d = d.replace(/^(?:(?:export|default|public|private|protected|static|async|abstract|final|override|readonly|declare|synchronized|native|function|const|let|var|def|fun|func|local|suspend|open|data|sealed|inline|internal|companion|object|val|type)\s+)+/, "");
  if (!d.includes(name)) return name;
  return d.length > 100 ? d.slice(0, 97) + "…" : d;
}
