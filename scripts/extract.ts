#!/usr/bin/env node
// extract.ts — the deterministic half of pr-brief (spec §4a–§9, §15).
// Computes changed files and units from git + ast-grep, carries prose over
// from the previous brief, and writes the brief (<git dir>/pr-brief/<key>/pr-brief-<key>.md,
// or --out) as a skeleton with slot tokens for the agent to fill. Never calls a model.
//
// Exit codes: 0 ok · 1 usage/runtime error · 2 preflight failure (missing tool)

import { execFileSync, spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { FORMAT_VERSION, CALLABLE_KINDS, parseBrief, isToken, labelOf, listOnNextLine } from "./brief-format.ts";
import type { ParsedBrief } from "./brief-format.ts";
import { SKILL_DIR, scanSymbols as scanSymbolsOrThrow, signatureOf, symKey, qualName, paramsOf, innermost, displayName } from "./symbols.ts";
import type { Sym } from "./symbols.ts";

const SG_MIN = [0, 30, 0];
const NODE_MIN = [22, 18]; // unflagged type stripping; an older node fails to load this .ts file before the check can run
const CALLER_CAP = 20;
const TYPE_KINDS = new Set(["class", "interface", "enum", "record", "annotation", "type", "object", "struct", "union", "trait", "delegate", "data"]);
const DEFAULT_BASE = "origin/main";
const DEFAULT_FULL_FN_MAX = 150; // full-body diff up to this many lines, or when a third of the body changed; 0 = always
const STATE_DIR = "pr-brief"; // under the repository's common git directory: .git, or .bare beside worktrees

// ---------------------------------------------------------------- types

interface Hunk {
  oldStart: number; oldLen: number; newStart: number; newLen: number;
  header: string; body: string[];
  plusLines: number[]; minusLines: number[]; // absolute line numbers of +/- lines
}
interface Unit {
  id: string; path: string; kind: string; name: string; scope: string;
  status: "new" | "modified" | "deleted";
  oldSpan: [number, number] | null; newSpan: [number, number] | null;
  signature: string; oldSignature: string | null; display: string;
  declLine?: number; // the declaration line on the new side (the span may start above it, on its comment)
  newLines: Set<number>; oldLines: Set<number>;
  hunk: string; callers: { total: number; sites: string[]; note?: string } | null;
  tags: string[]; hash: string; badge: string; renamedFrom: string | null; col: number;
  slots: Record<string, { locked: boolean; text: string }>;
  revise: string | null; notes: string | null;
}
interface FileEntry {
  path: string; status: "A" | "M" | "D" | "R"; renamedFrom: string | null; lang: string | null; binary: boolean;
  oldContent: string | null; newContent: string | null; hash: string;
  units: Unit[]; tags: string[]; hunksU0: Hunk[]; hunksU3: Hunk[]; hunksW: Hunk[];
  slots: Record<string, { locked: boolean; text: string }>; notes: string | null;
  commitsSinceLast: string[]; revise: string | null; purposeRevise?: string;
}
interface Args {
  mode: "wip" | "branch" | "all" | "commit" | "raw"; raw: string[]; base: string; commit: string; fullFnMax: number;
  out: string | null; key: string | null; list: boolean; fresh: boolean; check: boolean; section: string | null; scope: string; open: boolean; exclude: string[];
  untracked: boolean; // working-tree modes also brief untracked files (respecting .gitignore)
}

// ---------------------------------------------------------------- helpers

function die(msg: string, code = 1): never {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
}
function sha(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}
let ROOT = process.cwd();
let GIT_COMMON = ""; // the shared git directory: .git in a plain checkout, the main .git for a linked worktree, .bare beside worktrees
// git follows the gitdir pointer in a worktree's .git file and the commondir pointer inside it; the absolute form needs git >= 2.31
function gitCommonDir(): string {
  const abs = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" });
  if (abs.status === 0) return abs.stdout.trim();
  return path.resolve(ROOT, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" }).trim());
}
// The key names a brief everywhere: its directory and file under the state root, its URL in the viewer,
// the ref that keeps its snapshot alive. Safe as a path segment and as a ref name.
function keyOf(s: string): string {
  const k = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "").replace(/\.lock$/, "");
  return k || "brief";
}
let SCOPE = ".";
function git(args: string[], opts: { ok?: boolean; input?: string } = {}): string {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, input: opts.input });
  if (r.status !== 0 && !opts.ok) die(`git ${args.join(" ")} failed:\n${r.stderr}`);
  return r.status === 0 ? r.stdout : "";
}
function gitOk(args: string[]): string | null {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : null;
}
const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".java": "java",
  ".py": "python", ".pyi": "python",
  ".kt": "kotlin", ".kts": "kotlin",
  ".go": "go",
  ".lua": "lua",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".html": "html", ".htm": "html",
  ".css": "css",
  ".yml": "yaml", ".yaml": "yaml",
  ".md": "markdown", ".markdown": "markdown",
  // the same extensions ast-grep itself maps: a bare .h is C, .hxx is nothing
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".cs": "csharp",
  ".rs": "rust",
  ".hs": "haskell",
  ".json": "json",
};
const CALLER_LANGS: Record<string, string[]> = {
  typescript: ["TypeScript", "Tsx"], tsx: ["TypeScript", "Tsx"], javascript: ["JavaScript"], java: ["Java"],
  python: ["Python"], kotlin: ["Kotlin"], go: ["Go"], lua: ["Lua"],
  c: ["C"], cpp: ["Cpp"], csharp: ["CSharp"], rust: ["Rust"], haskell: ["Haskell"],
  bash: [], html: [], css: [], yaml: [], markdown: [], json: [], // no call syntax to search
};
function langOf(p: string): string | null {
  return LANG_BY_EXT[path.extname(p).toLowerCase()] ?? null;
}

// ---------------------------------------------------------------- args

function parseArgs(argv: string[]): Args {
  const a: Args = { mode: "wip", raw: [], base: DEFAULT_BASE, commit: "HEAD", fullFnMax: DEFAULT_FULL_FN_MAX, out: null, key: null, list: false, fresh: false, check: false, section: null, scope: ".", open: false, exclude: [], untracked: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    // an option's value must be there and must not be another option: a missing one is a usage error (exit 1), never a silent default
    const val = (): string => { const v = argv[++i]; if (v === undefined || (v.startsWith("-") && v !== "-")) die(`${x} needs a value\n${USAGE}`); return v; };
    if (x === "--") { a.mode = "raw"; a.raw = argv.slice(i + 1); break; }
    else if (x === "wip" || x === "branch" || x === "all") a.mode = x;
    else if (x === "commit") { a.mode = "commit"; if (argv[i + 1] && !argv[i + 1].startsWith("-")) a.commit = argv[++i]; }
    else if (x === "--base") a.base = val();
    else if (x === "--full-fn-max") { a.fullFnMax = parseInt(val(), 10); if (Number.isNaN(a.fullFnMax) || a.fullFnMax < 0) die(`--full-fn-max needs a non-negative number\n${USAGE}`); }
    else if (x === "--out") a.out = val();
    else if (x === "--key") a.key = val();
    else if (x === "--list") a.list = true;
    else if (x === "--fresh") a.fresh = true;
    else if (x === "--check") a.check = true;
    else if (x === "--section") a.section = val();
    else if (x === "--path") a.scope = val();
    else if (x === "--open") a.open = true;
    else if (x === "--exclude") a.exclude.push(val());
    else if (x === "--no-untracked") a.untracked = false;
    else if (x === "-h" || x === "--help") { process.stdout.write(USAGE); process.exit(0); }
    else die(`unknown argument: ${x}\n${USAGE}`);
  }
  return a;
}
const USAGE = `usage: extract.ts [wip|branch|all|commit <ref>] [--base <ref>] [--full-fn-max N (default 150; 0 = always full body)] [--out PATH] [--key NAME] [--list] [--fresh] [--check] [--section PATH] [--path DIR] [--exclude PATHSPEC]... [--no-untracked] [--open]
       extract.ts -- <git diff args>
`;

// ---------------------------------------------------------------- preflight (§4a)

function preflight(a: Args): { sg: string } {
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map((x) => parseInt(x, 10));
  if (nodeMajor < NODE_MIN[0] || (nodeMajor === NODE_MIN[0] && nodeMinor < NODE_MIN[1])) die(`pr-brief scripts need node >= ${NODE_MIN.join(".")} (found ${process.versions.node}).`, 2);

  let sg: string | null = null;
  let ver = "";
  for (const cand of ["ast-grep", "sg"]) {
    const r = spawnSync(cand, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /ast-grep/.test(r.stdout)) { sg = cand; ver = r.stdout.trim(); break; }
  }
  if (!sg) die(`pr-brief needs ast-grep, which is not installed.\nInstall: brew install ast-grep\n   (or: npm i -g @ast-grep/cli, cargo install ast-grep)`, 2);
  const vm = ver.match(/(\d+)\.(\d+)\.(\d+)/);
  if (vm) {
    const v = [+vm[1], +vm[2], +vm[3]];
    const tooOld = v[0] < SG_MIN[0] || (v[0] === SG_MIN[0] && (v[1] < SG_MIN[1] || (v[1] === SG_MIN[1] && v[2] < SG_MIN[2])));
    if (tooOld) die(`ast-grep ${vm[0]} is too old; need >= ${SG_MIN.join(".")}. Run: brew upgrade ast-grep`, 2);
  }

  const inTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inTree.status !== 0 || !/true/.test(inTree.stdout)) die(`pr-brief must be run inside a git repository.`, 2);
  ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  GIT_COMMON = gitCommonDir();

  if (a.mode === "branch" && gitOk(["rev-parse", "--verify", "--quiet", a.base]) === null)
    die(`${a.base} does not exist. Run git fetch, or pass --base <ref>.`, 2);
  if (a.mode === "commit" && gitOk(["rev-parse", "--verify", "--quiet", `${a.commit}^{commit}`]) === null)
    die(`${a.commit} is not a commit.`, 2);
  return { sg };
}

// ---------------------------------------------------------------- range (§4)

interface RangeInfo { diffArgs: string[]; base: string; head: string; newSide: "worktree" | "index" | string; label: string; commit?: { subject: string; body: string; author: string; date: string } }

function resolveRange(a: Args): RangeInfo {
  const head = git(["rev-parse", "HEAD"]).trim();
  if (a.mode === "wip") return { diffArgs: ["HEAD"], base: head, head, newSide: "worktree", label: "working tree vs HEAD" };
  if (a.mode === "all") {
    const empty = git(["hash-object", "-t", "tree", "/dev/null"]).trim(); // the empty tree
    return { diffArgs: [empty], base: empty, head, newSide: "worktree", label: "entire tree" };
  }
  if (a.mode === "commit") {
    // one commit: its parent (or the empty tree for a root commit) → the commit itself
    const c = git(["rev-parse", `${a.commit}^{commit}`]).trim();
    const parent = gitOk(["rev-parse", "--verify", "--quiet", `${c}^`])?.trim() || git(["hash-object", "-t", "tree", "/dev/null"]).trim();
    const [subject, author, date, ...bodyLines] = git(["log", "-1", "--format=%s%n%an%n%as%n%b", c]).split("\n");
    const body = bodyLines.filter((l) => !/^(Signed-off-by|Co-authored-by|Reviewed-by|Change-Id):/i.test(l)).join("\n").trim();
    return { diffArgs: [parent, c], base: parent, head: c, newSide: c, label: subject, commit: { subject, body, author, date } };
  }
  if (a.mode === "branch") {
    const base = git(["merge-base", a.base, "HEAD"]).trim();
    return { diffArgs: [base], base, head, newSide: "worktree", label: `branch vs ${a.base}` };
  }
  // raw: best-effort interpretation of user-supplied git diff args
  const raw = a.raw;
  if (raw.includes("--staged") || raw.includes("--cached")) return { diffArgs: raw, base: head, head, newSide: "index", label: "git diff " + raw.join(" ") };
  const rev = raw.find((x) => !x.startsWith("-"));
  if (!rev) return { diffArgs: raw, base: head, head, newSide: "worktree", label: "git diff " + raw.join(" ") };
  if (rev.includes("...")) {
    const [l, r] = rev.split("...");
    const b = git(["merge-base", l, r || "HEAD"]).trim();
    return { diffArgs: raw, base: b, head, newSide: git(["rev-parse", r || "HEAD"]).trim(), label: "git diff " + raw.join(" ") };
  }
  if (rev.includes("..")) {
    const [l, r] = rev.split("..");
    return { diffArgs: raw, base: git(["rev-parse", l]).trim(), head, newSide: git(["rev-parse", r || "HEAD"]).trim(), label: "git diff " + raw.join(" ") };
  }
  return { diffArgs: raw, base: git(["rev-parse", rev]).trim(), head, newSide: "worktree", label: "git diff " + raw.join(" ") };
}

// ---------------------------------------------------------------- diff parsing (§6.1)

// A path git printed C-quoted (`"src/quo\"te.ts"`): `"`, `\` and control characters are always
// escaped, whatever core.quotePath says; octal escapes are UTF-8 bytes.
function unquoteC(s: string): string {
  if (!s.startsWith('"')) return s;
  const esc: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };
  let out = "", bytes: number[] = [];
  const flush = () => { if (bytes.length) { out += Buffer.from(bytes).toString("utf8"); bytes = []; } };
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') break;
    if (c !== "\\") { flush(); out += c; continue; }
    const oct = s.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    flush(); out += esc[s[i + 1]] ?? s[i + 1]; i++;
  }
  flush();
  return out;
}
// The path a `--- `/`+++ ` header names under our forced a/ b/ prefix, plain or C-quoted; git ends a
// path containing a space with a tab. null for /dev/null and anything else.
function headerPath(rest: string, prefix: string): string | null {
  const s = rest.replace(/\t$/, "");
  if (s.startsWith(prefix)) return s.slice(prefix.length);
  if (s.startsWith('"' + prefix)) return unquoteC(s).slice(prefix.length);
  return null;
}

function parseUnified(text: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>();
  let cur: string | null = null;
  let hunk: Hunk | null = null;
  let o = 0, n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = null; hunk = null; continue; }
    // file headers come only between `diff --git` and the first `@@`: inside a hunk a line starting
    // `--- ` is a deleted `-- ` comment (Lua, SQL, Haskell) and `+++ ` an added `++ ` line
    if (hunk === null && line.startsWith("--- ")) { const p = headerPath(line.slice(4), "a/"); if (p !== null) cur = p; continue; }
    if (hunk === null && line.startsWith("+++ ")) { const p = headerPath(line.slice(4), "b/"); if (p !== null) cur = p; continue; }
    if (cur === null) continue;
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (m) {
      hunk = { oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4], header: line, body: [], plusLines: [], minusLines: [] };
      o = hunk.oldStart; n = hunk.newStart;
      if (!out.has(cur)) out.set(cur, []);
      out.get(cur)!.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue;
    hunk.body.push(line);
    if (line.startsWith("+")) { hunk.plusLines.push(n); n++; }
    else if (line.startsWith("-")) { hunk.minusLines.push(o); o++; }
    else { o++; n++; }
  }
  return out;
}

// The hunk git would print for a file that did not exist before: every line added.
function wholeFileHunk(content: string): Hunk {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  return { oldStart: 0, oldLen: 0, newStart: 1, newLen: lines.length, header: `@@ -0,0 +1,${lines.length} @@`, body: lines.map((l) => "+" + l), plusLines: lines.map((_, i) => i + 1), minusLines: [] };
}

// ---------------------------------------------------------------- symbols (§6.2)

// Line numbers (1-based) that belong to import / package / re-export statements, including the
// continuation lines of a multi-line `import {\n  a,\n  b,\n} from 'x'`.
function importLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!open && /^\s*(import\b|package\s|export\s+(\*|\{|type\s+\{))/.test(l)) {
      out.add(i + 1);
      const opens = (l.match(/[{(]/g) ?? []).length, closes = (l.match(/[})]/g) ?? []).length;
      open = opens > closes;
    } else if (open) {
      out.add(i + 1);
      if (/[})]/.test(l)) open = false;
    }
  }
  return out;
}

// ---------------------------------------------------------------- attribution (§6.3)

function attribute(f: FileEntry, oldSyms: Sym[], newSyms: Sym[]): void {
  // overloads: when either side has two symbols with the same scope, name and kind, every such
  // symbol (on both sides) is keyed and identified by its parameter list as well: Svc.save(Order o)
  const base = (s: Sym) => `${s.scope ? s.scope + "." : ""}${s.name}|${s.kind}`;
  const dup = new Set<string>();
  for (const side of [oldSyms, newSyms]) { const c = new Map<string, number>(); for (const s of side) c.set(base(s), (c.get(base(s)) ?? 0) + 1); for (const [k, n] of c) if (n > 1) dup.add(k); }
  // no parameter list to tell them apart (rules, consts, keys, sections, elements): the ordinal among
  // same-named siblings on that side does, and stays stable across sides while the order is unchanged
  for (const side of [oldSyms, newSyms]) {
    const keys = new Set<string>(), ord = new Map<string, number>();
    for (const s of side) {
      if (!dup.has(base(s))) continue;
      const n = (ord.get(base(s)) ?? 0) + 1;
      ord.set(base(s), n);
      s.disc = paramsOf(s.signature) || `#${n}`;
      while (keys.has(symKey(s))) s.disc += "#"; // identical parameter lists: still two symbols
      keys.add(symKey(s));
    }
  }
  const oldMap = new Map(oldSyms.map((s) => [symKey(s), s]));
  const newMap = new Map(newSyms.map((s) => [symKey(s), s]));
  if (oldMap.size !== oldSyms.length || newMap.size !== newSyms.length) die(`internal: symbol keys collide in ${f.path} — please report this`);
  const newLinesArr = (f.newContent ?? "").split("\n"), oldLinesArr = (f.oldContent ?? "").split("\n");
  // the hash covers the attributed span (comment lines above the declaration included), which is what the hunk shows
  const spanText = (s: Sym, lines: string[]) => lines.slice(s.start - 1, s.end).join("\n");
  const units = new Map<string, Unit>();
  const mk = (key: string, s: Sym, status: Unit["status"], old: Sym | null, nw: Sym | null): Unit => {
    let u = units.get(key);
    if (u) return u;
    u = {
      id: `${f.path}#${qualName(s)}`, path: f.path, kind: s.kind, name: s.name, scope: s.scope, status,
      oldSpan: old ? [old.start, old.end] : null, newSpan: nw ? [nw.start, nw.end] : null,
      signature: (nw ?? s).signature, oldSignature: old ? old.signature : null, display: displayName((nw ?? s).signature, s.name, s.kind),
      newLines: new Set(), oldLines: new Set(), hunk: "", callers: null, tags: [], hash: sha(nw ? spanText(nw, newLinesArr) : spanText(old ?? s, oldLinesArr)), badge: "", renamedFrom: null, col: (nw ?? s).col,
      declLine: nw?.declLine, slots: {}, revise: null, notes: null,
    };
    units.set(key, u);
    return u;
  };
  // symbols that contain other symbols (classes, describe blocks, factory-built consts…): a blank
  // line between their members is nobody's change
  const isContainer = (syms: Sym[]) => new Set(syms.filter((a) => syms.some((b) => b !== a && b.start >= a.start && b.end <= a.end)));
  const newContainers = isContainer(newSyms), oldContainers = isContainer(oldSyms);
  const newImports = importLines(newLinesArr), oldImports = importLines(oldLinesArr);
  for (const h of f.hunksU0) {
    const strayNew: number[] = [], strayOld: number[] = [];
    const blankNew: number[] = [], blankOld: number[] = []; // blank lines outside any symbol: a change only when nothing else is
    const preamble = /^\s*(#!|#\s|#$|\/\/|\/\*|\*|\*\/|package\s|import\s|export\s+\*|export\s+\{|from\s)/; // "# " is a YAML/Python/shell comment; Markdown headings never reach this test (they are inside a section)
    for (let ln = h.newStart; ln < h.newStart + h.newLen; ln++) {
      const s = innermost(newSyms, ln);
      const text = newLinesArr[ln - 1] ?? "";
      const blank = !text.trim();
      // in an added file the license header, package line, and imports are not a change to review
      if (!s) { if (blank) blankNew.push(ln); else if (!(f.status === "A" && (preamble.test(text) || newImports.has(ln)))) strayNew.push(ln); continue; }
      if (blank && newContainers.has(s)) continue; // nor is a blank line between members of a container
      const k = symKey(s);
      const old = oldMap.get(k) ?? null;
      mk(k, s, old ? "modified" : "new", old, s).newLines.add(ln);
    }
    for (let ln = h.oldStart; ln < h.oldStart + h.oldLen; ln++) {
      const s = innermost(oldSyms, ln);
      const blank = !(oldLinesArr[ln - 1] ?? "").trim();
      if (!s) { if (blank) blankOld.push(ln); else strayOld.push(ln); continue; }
      if (blank && oldContainers.has(s)) continue;
      const k = symKey(s);
      const nw = newMap.get(k) ?? null;
      mk(k, s, nw ? "modified" : "deleted", s, nw).oldLines.add(ln);
    }
    let whitespaceOnly = false;
    if (!strayNew.length && !strayOld.length && (blankNew.length || blankOld.length) && !h.plusLines.some((l) => newLinesArr[l - 1]?.trim() && !innermost(newSyms, l)) && h.body.every((l) => !l.slice(1).trim())) {
      // a hunk of nothing but blank lines between symbols: shown, so the file section never has slots over an empty diff
      strayNew.push(...blankNew); strayOld.push(...blankOld); whitespaceOnly = true;
    }
    if (strayNew.length || strayOld.length) {
      const anchor = h.newLen > 0 ? h.newStart : h.oldStart;
      // only the stray lines decide: a hunk that also adds a type next to an import is still an import change
      const isImports = strayNew.every((ln) => newImports.has(ln)) && strayOld.every((ln) => oldImports.has(ln));
      // all import hunks of a file form one bucket; other stray hunks stay separate
      const key = isImports ? "other:imports" : `other@${anchor}`;
      let u = units.get(key);
      if (!u) {
        u = {
          id: isImports ? `${f.path}#(imports)` : `${f.path}#(top-level)@${anchor}`, path: f.path, kind: "other", name: isImports ? "(imports)" : "(top-level)", scope: "", status: "modified",
          oldSpan: null, newSpan: null,
          signature: "", oldSignature: null, display: "", newLines: new Set(), oldLines: new Set(), hunk: "", callers: null, tags: [], hash: "", badge: "", renamedFrom: null, col: 0,
          slots: {}, revise: null, notes: null,
        };
        units.set(key, u);
      }
      if (whitespaceOnly && !u.tags.includes("whitespace-only")) u.tags.push("whitespace-only");
      for (const ln of strayNew) u.newLines.add(ln);
      for (const ln of strayOld) u.oldLines.add(ln);
      const nl = [...u.newLines], ol = [...u.oldLines];
      u.newSpan = nl.length ? [Math.min(...nl), Math.max(...nl)] : null;
      u.oldSpan = ol.length ? [Math.min(...ol), Math.max(...ol)] : null;
      // hash only the attributed lines: in a new file the hunk is the whole file, and a
      // function-body edit must not invalidate the prose of the imports/top-level bucket
      u.hash = sha(nl.map((l) => newLinesArr[l - 1]).join("\n") + "\n--\n" + ol.map((l) => oldLinesArr[l - 1]).join("\n"));
    }
  }
  // renames: pair a deleted unit with a new unit of the same kind whose body is at least 90% the same
  // lines (the name line differs); the pair becomes one modified unit, renamed from the old name
  const lineSet = (t: string) => new Set(t.split("\n").map((l) => l.trim()).filter(Boolean));
  const similar = (a: string, b: string) => { const A = lineSet(a), B = lineSet(b); let both = 0; for (const l of A) if (B.has(l)) both++; return both / Math.max(1, Math.max(A.size, B.size)); };
  // a body worth pairing has at least two lines that are not the signature and not a lone brace or
  // annotation; boilerplate (`return true;`, `TODO()`) is not evidence of a rename
  const bodyLines = (t: string, name: string) => { const ls = t.split("\n").map((l) => l.trim()).filter(Boolean); const i = ls.findIndex((l) => l.includes(name)); return ls.slice(i + 1).filter((l) => !/^[{}();]*$/.test(l) && !l.startsWith("@")); };
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [dk, d] of [...units]) {
    if (d.status !== "deleted" || d.kind === "other") continue;
    const dText = oldSyms.find((sy) => symKey(sy) === dk)?.text ?? "";
    if (bodyLines(dText, d.name).length < 2) continue;
    let best: [string, Unit, number] | null = null;
    for (const [nk, n] of units) {
      if (n.status !== "new" || n.kind !== d.kind) continue;
      const nText = newSyms.find((sy) => symKey(sy) === nk)?.text ?? "";
      const sim = similar(dText.replace(new RegExp(`\\b${escapeRe(d.name)}\\b`, "g"), n.name), nText);
      if (sim >= 0.9 && (!best || sim > best[2])) best = [nk, n, sim];
    }
    if (!best) continue;
    const n = best[1];
    n.status = "modified"; n.oldSpan = d.oldSpan; n.oldSignature = d.signature; n.oldLines = d.oldLines;
    n.renamedFrom = qualName(d);
    units.delete(dk);
  }

  // duplicate ids (overloads) get a line suffix
  const seen = new Map<string, number>();
  for (const u of units.values()) seen.set(u.id, (seen.get(u.id) ?? 0) + 1);
  for (const u of units.values()) if (seen.get(u.id)! > 1 && u.kind !== "other") u.id += `@${(u.newSpan ?? u.oldSpan)![0]}`;
  const seen2 = new Map<string, number>();
  for (const u of units.values()) seen2.set(u.id, (seen2.get(u.id) ?? 0) + 1);
  for (const u of units.values()) if (seen2.get(u.id)! > 1 && u.kind !== "other") u.id += `:${u.col}`;

  // tags
  const wNew = new Set<number>(), wOld = new Set<number>();
  for (const h of f.hunksW) { for (let l = h.newStart; l < h.newStart + h.newLen; l++) wNew.add(l); for (let l = h.oldStart; l < h.oldStart + h.oldLen; l++) wOld.add(l); }
  for (const u of units.values()) {
    if (u.status === "modified" && u.kind !== "other" && ![...u.newLines].some((l) => wNew.has(l)) && ![...u.oldLines].some((l) => wOld.has(l))) u.tags.push("whitespace-only");
    // a modified or new container (class, interface, describe block…) is "container-only" when its members are units of their own here: its hunk shows only its own lines
    const scopeName = (u.scope ? u.scope + "." : "") + u.name;
    if ((u.status === "modified" || u.status === "new") && u.kind !== "other" && [...units.values()].some((m) => m !== u && m.scope === scopeName)) {
      u.tags.push("container-only");
      // and its prose describes only those lines, so only they decide whether it is carried over
      const own = (ls: Set<number>, arr: string[]) => [...ls].sort((a, b) => a - b).map((l) => arr[l - 1]).join("\n");
      u.hash = sha(own(u.newLines, newLinesArr) + "\n--\n" + own(u.oldLines, oldLinesArr));
    }
  }
  f.units = [...units.values()].sort((x, y) => ((x.newSpan ?? x.oldSpan)![0]) - ((y.newSpan ?? y.oldSpan)![0]));
}

// ---------------------------------------------------------------- hunk rendering (§6.4)

function noIndexDiff(oldText: string, newText: string): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-fn-"));
  const a = path.join(tmp, "a"), b = path.join(tmp, "b");
  fs.writeFileSync(a, oldText.endsWith("\n") ? oldText : oldText + "\n");
  fs.writeFileSync(b, newText.endsWith("\n") ? newText : newText + "\n");
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U100000", a, b], { encoding: "utf8" }); // a configured diff.external prints no @@ lines
  fs.rmSync(tmp, { recursive: true, force: true });
  const lines = r.stdout.split("\n");
  const at = lines.findIndex((l) => l.startsWith("@@"));
  return at < 0 ? newText.split("\n").map((l) => " " + l) : lines.slice(at + 1).filter((l) => l !== "" && !l.startsWith("\\"));
}
function slice(content: string | null, span: [number, number] | null): string {
  if (!content || !span) return "";
  return content.split("\n").slice(span[0] - 1, span[1]).join("\n");
}
// A -U0 hunk restricted to the lines attributed to `u`, with `ctx` lines of
// context taken from the file contents. Unlike -U3 output this never merges
// neighbouring changes that belong to other units.
function miniHunk(f: FileEntry, h: Hunk, u: Unit, ctx = 6): string[] {
  const newArr = (f.newContent ?? "").split("\n"), oldArr = (f.oldContent ?? "").split("\n");
  const body: string[] = [];
  let o = h.oldStart, n = h.newStart;
  for (const l of h.body) {
    if (l.startsWith("+")) { if (u.newLines.has(n)) body.push(l); n++; }
    else if (l.startsWith("-")) { if (u.oldLines.has(o)) body.push(l); o++; }
  }
  const src = f.newContent !== null ? newArr : oldArr;
  const beforeEnd = h.newLen === 0 ? h.newStart : h.newStart - 1;
  const afterStart = h.newLen === 0 ? h.newStart + 1 : h.newStart + h.newLen;
  const before = src.slice(Math.max(0, beforeEnd - ctx), Math.max(0, beforeEnd)).map((l) => " " + l);
  const after = src.slice(afterStart - 1, afterStart - 1 + ctx).map((l) => " " + l);
  return [h.header.replace(/ @@.*$/, " @@"), ...before, ...body, ...(afterStart - 1 < src.length ? after : [])];
}
function renderHunk(f: FileEntry, u: Unit, fullFnMax: number): string {
  if (u.kind === "file" && f.tags.includes("generated")) { const n = (f.newContent ?? f.oldContent ?? "").split("\n").length; return `(generated file, ${n} lines — diff omitted)`; }
  if (u.kind === "file") {
    const all = f.hunksU3.map((h) => [h.header, ...h.body].join("\n")).join("\n");
    if (u.status !== "new") return all;
    // a whole new file in a language without unit rules: show the head, the path is a link to the rest
    const lines = all.split("\n");
    return fullFnMax === 0 || lines.length <= fullFnMax + 1 ? all : [...lines.slice(0, fullFnMax + 1), `  … ${lines.length - fullFnMax - 1} more lines: open the file`].join("\n");
  }
  const attributed = f.hunksU0.filter((h) => h.plusLines.some((l) => u.newLines.has(l)) || h.minusLines.some((l) => u.oldLines.has(l)));
  if (u.kind === "other") return attributed.map((h) => miniHunk(f, h, u).join("\n")).join("\n");
  if (u.status === "new") {
    if (!u.tags.includes("container-only")) return slice(f.newContent, u.newSpan).split("\n").map((l) => "+" + l).join("\n");
    // a new container: its own lines only; each run of member lines collapses to one marker
    const out: string[] = []; let skipped = 0;
    const lines = (f.newContent ?? "").split("\n");
    for (let ln = u.newSpan![0]; ln <= u.newSpan![1]; ln++) {
      const text = lines[ln - 1] ?? "";
      if (u.newLines.has(ln) || !text.trim()) { if (skipped) { out.push(`  … ${skipped} lines: members listed separately`); skipped = 0; } out.push("+" + text); }
      else skipped++;
    }
    if (skipped) out.push(`  … ${skipped} lines: members listed separately`);
    return out.join("\n");
  }
  if (u.status === "deleted") return slice(f.oldContent, u.oldSpan).split("\n").map((l) => "-" + l).join("\n");
  // full body when the function is short enough, or when at least a third of it changed (a rewrite
  // reads as a whole); otherwise its changed lines with context, so a 3-line fix in a 1,000-line
  // function is not 1,000 lines of context. --full-fn-max 0 means always the full body.
  const len = u.newSpan![1] - u.newSpan![0] + 1;
  const oldLen = u.oldSpan ? u.oldSpan[1] - u.oldSpan[0] + 1 : 0;
  const changedThird = (u.newLines.size + u.oldLines.size) * 3 >= len + oldLen;
  const full = fullFnMax === 0 || len <= fullFnMax || changedThird;
  if (full && !u.tags.includes("container-only")) return noIndexDiff(slice(f.oldContent, u.oldSpan), slice(f.newContent, u.newSpan)).join("\n");
  return attributed.map((h) => miniHunk(f, h, u).join("\n")).join("\n");
}

// ---------------------------------------------------------------- callers (§6.5)

function findCallers(sg: string, files: FileEntry[], rev: string | null): void {
  const targets: { u: Unit; f: FileEntry; lang: string }[] = [];
  // a constructor is called by its class name; `new` exists in Java/TS/JS/C# (C++ has both forms, see callerPatterns)
  const ctorName = (u: Unit) => (u.name === "constructor" ? u.scope.split(".").pop() ?? u.name : u.name);
  const hasNew = (lang: string) => lang === "java" || lang === "typescript" || lang === "tsx" || lang === "javascript" || lang === "csharp";
  // a language with no call syntax to search (bash, html, css, yaml, markdown, json) gets no Callers line at all;
  // nor does a unit whose name is no identifier (a C++ destructor `~Svc`, an `operator+`): there is no pattern to search for it
  for (const f of files) for (const u of f.units) if (f.lang && CALLER_LANGS[f.lang]?.length && CALLABLE_KINDS.has(u.kind) && u.status !== "new" && /^[A-Za-z_$][\w$]*$/.test(u.kind === "constructor" ? ctorName(u) : u.name)) targets.push({ u, f, lang: f.lang });
  findTypeReferences(files, rev);
  if (rev) {
    // historical commit: the working tree may be far ahead, so search the commit's tree by name with git grep
    const exts = Object.keys(LANG_BY_EXT);
    for (const { u, f, lang } of targets) {
      // POSIX ERE (no \b): a name not preceded by an identifier character; a Haskell call has no parentheses
      const pat = lang === "haskell" ? `(^|[^A-Za-z0-9_'])${u.name}([^A-Za-z0-9_']|$)`
        : u.kind === "constructor" ? (hasNew(lang) ? `new[[:space:]]+${ctorName(u)}[[:space:]]*\\(` : `(^|[^A-Za-z0-9_$.])${ctorName(u)}[[:space:]]*\\(`) : `(^|[^A-Za-z0-9_$])${u.name}[[:space:]]*\\(`;
      const out = gitOk(["grep", "-n", "-E", pat, rev, "--", SCOPE]) ?? "";
      const sites = new Set<string>();
      for (const line of out.split("\n")) {
        const m = line.match(/^[^:]+:([^:]+):(\d+):/);
        if (!m || !exts.includes(path.extname(m[1]).toLowerCase())) continue;
        const ln = +m[2];
        if (m[1] === u.path && u.newSpan && ln >= u.newSpan[0] && ln <= u.newSpan[1]) continue; // self
        sites.add(`${m[1]}:${ln}`);
      }
      const r = restrictSites(u, f, lang, sites, rev);
      u.callers = { total: r.sites.length, sites: r.sites.slice(0, CALLER_CAP), note: r.note };
    }
    return;
  }
  const byLang = new Map<string, { u: Unit; rid: string }[]>();
  targets.forEach(({ u, lang }, i) => {
    for (const L of CALLER_LANGS[lang]) { if (!byLang.has(L)) byLang.set(L, []); byLang.get(L)!.push({ u, rid: `c${i}` }); }
    u.callers = { total: 0, sites: [] };
  });
  const sitesById = new Map<string, Set<string>>();
  for (const [L, list] of byLang) {
    const rules = list.map(({ u, rid }) => `id: ${rid}\nlanguage: ${L}\nrule:\n  any:\n${callerPatterns(L, u.kind === "constructor" ? ctorName(u) : u.name, u.kind === "constructor").map((p) => `    - ${p}`).join("\n")}`).join("\n---\n");
    const r = spawnSync(sg, ["scan", "--json=compact", "--inline-rules", rules, SCOPE], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0) continue;
    const ridToUnit = new Map(list.map(({ u, rid }) => [rid, u]));
    for (const m of r.stdout.trim() ? JSON.parse(r.stdout) : []) {
      const u = ridToUnit.get(m.ruleId)!;
      const file = m.file.replace(/^\.\//, "");
      const line = m.range.start.line + 1;
      if (file === u.path && u.newSpan && line >= u.newSpan[0] && line <= u.newSpan[1]) continue; // self
      if (!sitesById.has(u.id)) sitesById.set(u.id, new Set());
      sitesById.get(u.id)!.add(`${file}:${line}`);
    }
  }
  for (const { u, f, lang } of targets) {
    const r = restrictSites(u, f, lang, sitesById.get(u.id) ?? new Set<string>(), null);
    u.callers = { total: r.sites.length, sites: r.sites.slice(0, CALLER_CAP), note: r.note };
  }
}

// The ast-grep rules (YAML lines) that find calls of `name` in language L. A bare `f(x)` is not a
// statement of its own in C, C++ or C#, so those take the context form; C++ and Rust also call through
// `->` and `::`; a Haskell call is an application with no parentheses, so any use of the name counts
// except the name position of a declaration (a signature, an equation) — that is the declaration itself.
function callerPatterns(L: string, name: string, ctor: boolean): string[] {
  const withNew = L === "Java" || L === "TypeScript" || L === "Tsx" || L === "JavaScript"; // C# and C++ have their own forms below
  const ctx = (body: string, selector: string) => `pattern: { context: ${JSON.stringify(L === "CSharp" ? `class Q { void M() { ${body}; } }` : `void f() { ${body}; }`)}, selector: ${selector} }`;
  const plain = (p: string) => `pattern: ${JSON.stringify(p)}`;
  if (L === "Haskell") return [`kind: variable\n      regex: ${JSON.stringify(`^${name}$`)}\n      not: { inside: { any: [ { kind: function }, { kind: bind }, { kind: signature } ] } }`];
  if (L === "C" || L === "Cpp") {
    if (ctor) return L === "Cpp" ? [ctx(`new ${name}($$$)`, "new_expression"), ctx(`new $T::${name}($$$)`, "new_expression"), ctx(`${name}($$$)`, "call_expression"), ctx(`$T::${name}($$$)`, "call_expression")] : [ctx(`${name}($$$)`, "call_expression")];
    return [ctx(`${name}($$$)`, "call_expression"), ctx(`$OBJ.${name}($$$)`, "call_expression"), ctx(`$OBJ->${name}($$$)`, "call_expression"), ...(L === "Cpp" ? [ctx(`$T::${name}($$$)`, "call_expression")] : [])];
  }
  if (L === "CSharp") return ctor ? [ctx(`new ${name}($$$)`, "object_creation_expression")] : [ctx(`${name}($$$)`, "invocation_expression"), ctx(`$OBJ.${name}($$$)`, "invocation_expression")];
  if (ctor) return [plain(withNew ? `new ${name}($$$)` : `${name}($$$)`)];
  return [plain(`${name}($$$)`), plain(`$OBJ.${name}($$$)`), ...(L === "Rust" ? [plain(`$T::${name}($$$)`)] : [])];
}

// Name matching cannot tell which `main` a call binds to. Two cheap corrections make the common wrong
// cases honest: a declaration that other files cannot call (not exported in TS/JS, private in Java, Kotlin
// or TS, unexported in Go) keeps only the sites that could reach it; and a file that declares the same
// name itself is taken to be calling its own, so its sites are dropped. Both are said on the Callers line.
// A declaration must look like one, not like a call: a TS/JS method is an indented name whose parameter
// list is followed by `{` or a return type (`  foo(x);` is a call); a Java method has a type before its
// name (`if (foo(x)) {` and `return foo(x);` have none). A signature wrapped right after its `(` is not
// recognised: a bare `  foo(` line is also how a multi-line call starts, and dropping a real caller is the worse error.
const DECL_RE: Record<string, (n: string) => RegExp> = {
  typescript: (n) => new RegExp(`^\\s*(export\\s+(default\\s+)?)?(async\\s+)?function\\s*\\*?\\s*${n}\\s*[(<]|^\\s*(export\\s+)?(const|let|var)\\s+${n}\\b|^\\s+((public|private|protected|static|async|readonly|override|abstract|get|set)\\s+)*\\*?\\s*${n}\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*[:{]`, "m"), // one nesting level in the parameter list: `on(cb: () => void) {`, `f(x = g(1)) {`
  java: (n) => new RegExp(`^[^;(){}]*[\\w>\\]]\\s+${n}\\s*\\([^;{]*\\)\\s*(throws[^{;]*)?\\{`, "m"),
  kotlin: (n) => new RegExp(`\\bfun\\s+(<[^>]*>\\s*)?([\\w.]+\\.)?${n}\\s*\\(`),
  go: (n) => new RegExp(`^func\\s+(\\([^)]*\\)\\s*)?${n}\\s*[(\\[]`, "m"),
  python: (n) => new RegExp(`^\\s*(async\\s+)?def\\s+${n}\\s*\\(`, "m"),
  lua: (n) => new RegExp(`\\bfunction\\s+([\\w.:]+[.:])?${n}\\s*\\(|\\b${n}\\s*=\\s*function\\b`),
  // a type (or `*`, `&`, `>`) before the name, a parameter list, then `{` or `;` (a prototype): `return f(x);` and `ok = f(x);` have none
  c: (n) => new RegExp(`^(?!\\s*(return|else|do|case|goto)\\b)[^;(){}#=]*[\\w>*&\\]]\\s*\\**&?\\s*(\\w+::)*${n}\\s*\\([^;{]*\\)\\s*(const\\s*)?(override\\s*)?(noexcept\\s*)?[{;]`, "m"),
  csharp: (n) => new RegExp(`^(?!\\s*(return|else|await|yield)\\b)[^;(){}=]*[\\w>\\]]\\s+${n}\\s*\\([^;{]*\\)\\s*(=>|\\{|;|where\\b)`, "m"),
  rust: (n) => new RegExp(`\\bfn\\s+${n}\\s*[(<]`),
  haskell: (n) => new RegExp(`^${n}\\b[^\\n]*(::|=)`, "m"), // its type signature or an equation, at column 0
};
DECL_RE.tsx = DECL_RE.typescript; DECL_RE.javascript = DECL_RE.typescript; DECL_RE.cpp = DECL_RE.c;
const fileTextCache = new Map<string, string>();
function fileText(p: string, rev: string | null): string {
  const key = `${rev ?? "wt"}:${p}`;
  if (!fileTextCache.has(key)) {
    let s = "";
    if (rev) s = gitOk(["show", `${rev}:${p}`]) ?? "";
    else { try { s = fs.readFileSync(path.join(ROOT, p), "utf8"); } catch { s = ""; } }
    fileTextCache.set(key, s);
  }
  return fileTextCache.get(key)!;
}
function restrictSites(u: Unit, f: FileEntry, lang: string, raw: Set<string>, rev: string | null): { sites: string[]; note?: string } {
  const notes: string[] = [];
  let sites = [...raw];
  const fileOf = (s: string) => s.slice(0, s.lastIndexOf(":"));
  // the declaration's own line: the span starts above it when a comment precedes it, and `export`/`private` are not on the comment
  const decl = (f.newContent ?? "").split("\n")[(u.declLine ?? u.newSpan?.[0] ?? 1) - 1] ?? "";
  const topLevel = !u.scope;
  const jsLike = lang === "typescript" || lang === "tsx" || lang === "javascript";
  // 1. a declaration other files cannot call
  let reach: "file" | "dir" | null = null;
  if (jsLike && topLevel && !/^\s*export\b/.test(decl)) reach = "file";
  else if ((jsLike || lang === "java" || lang === "kotlin" || lang === "csharp") && /\bprivate\b/.test(decl)) reach = "file";
  else if ((lang === "c" || lang === "cpp") && u.kind === "function" && /^\s*static\b/.test(decl)) reach = "file"; // a static free function, at file or namespace level (a static member is a method)
  else if (lang === "go" && topLevel && /^[a-z]/.test(u.name)) reach = "dir";
  if (reach) {
    const before = sites.length;
    sites = sites.filter((s) => (reach === "file" ? fileOf(s) === u.path : path.dirname(fileOf(s)) === path.dirname(u.path)));
    if (sites.length < before) notes.push(reach === "file" ? "not reachable from other files, their calls dropped" : "unexported, calls outside the package dropped");
  }
  // 2. a file that declares the same name is calling its own
  const re = DECL_RE[lang]?.(u.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (re) {
    const others = new Set<string>();
    sites = sites.filter((s) => { const p = fileOf(s); if (p === u.path || !re.test(fileText(p, rev))) return true; others.add(path.basename(p)); return false; });
    if (others.size) notes.push(`${u.name} is also declared in ${[...others].join(", ")}, their calls dropped`);
  }
  sites.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { sites, note: notes.length ? notes.join("; ") : undefined };
}

// Class-like units (class, interface, enum, record, annotation, type) are not
// called; they are referenced — `X.class`, `@X`, `new X(`, a type position.
// git grep for the bare name across the repo (at the commit, or the working tree
// plus untracked files), skipping the declaring file and import lines.
function findTypeReferences(files: FileEntry[], rev: string | null): void {
  const exts = Object.keys(LANG_BY_EXT);
  for (const f of files) for (const u of f.units) {
    if (!f.lang || !TYPE_KINDS.has(u.kind) || u.status === "new") continue;
    const pat = `(^|[^A-Za-z0-9_$])${u.name}([^A-Za-z0-9_$]|$)`;
    const args = ["grep", "-n", "-E", pat];
    if (rev) args.push(rev); else args.push("--untracked");
    const out = gitOk([...args, "--", SCOPE]) ?? "";
    const sites = new Set<string>();
    for (const line of out.split("\n")) {
      const m = rev ? line.match(/^[^:]+:([^:]+):(\d+):(.*)$/) : line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m || !exts.includes(path.extname(m[1]).toLowerCase())) continue;
      if (/^\s*import\s/.test(m[3])) continue; // imports
      if (m[1] === u.path && u.newSpan && +m[2] >= u.newSpan[0] && +m[2] <= u.newSpan[1]) continue; // the declaration itself
      sites.add(`${m[1]}:${m[2]}`);
    }
    const sorted = [...sites].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    u.callers = { total: sorted.length, sites: sorted.slice(0, CALLER_CAP) };
  }
}

// A commit brief is keyed by the commit's short SHA; every other brief by the branch it is on (the
// short SHA of HEAD when detached). --key overrides both: one brief for a whole stack, or a name of your own.
// `shown` is the name before sanitising (the branch as git spells it), for the brief's title.
function briefKey(a: Args, R: RangeInfo): { key: string; shown: string } {
  if (a.key) return { key: keyOf(a.key), shown: a.key };
  if (a.mode === "commit") { const k = git(["rev-parse", "--short=7", R.head]).trim(); return { key: k, shown: k }; }
  const branch = gitOk(["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim();
  const shown = branch || git(["rev-parse", "--short=7", "HEAD"]).trim();
  return { key: keyOf(shown), shown };
}

// The observation instruction, shared by the file-level and unit-level slots (the level's prefix differs).
const REVIEW_TAIL = "something a careful reader should check — dead or redundant code, an unused leftover, a missing case, unexplained behaviour, a consequence the change accepts. Concrete and checkable only; delete this line if there is nothing.";

// ---------------------------------------------------------------- previous brief (§15)

// Sources of carry-over, in priority order: the brief on disk, then this key's last lint-clean
// brief (<key>/last.md, archived by lint), then the per-mode archives written before briefs had
// keys. wip and branch briefs of one branch share a key, so switching between them never loses
// prose: a unit is carried from whichever source has a matching hash.
function loadPrevious(outAbs: string, stateDir: string, stateRoot: string, mode: string, fresh: boolean): ParsedBrief[] {
  if (fresh) return [];
  const read = (c: string): ParsedBrief | null => {
    if (!fs.existsSync(c)) return null;
    const p = parseBrief(fs.readFileSync(c, "utf8"));
    return String(p.front["pr-brief"] ?? p.front["review-brief"]) === String(FORMAT_VERSION) ? p : null; // both keys: briefs written under the old name still carry over
  };
  const onDisk = read(outAbs);
  const last = read(path.join(stateDir, "last.md"));
  const legacy = [mode, ...["wip", "branch", "all", "commit", "raw"].filter((m) => m !== mode)].map((m) => read(path.join(stateRoot, `last-${m}.md`)));
  // the primary (first) source is the one the "since last" delta is measured
  // against: the brief on disk if it is the same mode, else the archive
  const ordered = onDisk && onDisk.front.mode !== mode ? [last, onDisk, ...legacy] : [onDisk, last, ...legacy];
  return ordered.filter((p): p is ParsedBrief => p !== null);
}

// One-time migrations, before any scan so a legacy brief is never briefed as a new file:
//  - the tool's old name (review-brief): its state directory is renamed, its snapshot ref dropped;
//  - briefs from before keys: PR_BRIEF.md / REVIEW_BRIEF.md at the repository root and
//    <state>/commits/<sha>/PR_BRIEF.md move to <state>/<key>/pr-brief-<key>.md (the root file's
//    line leaves info/exclude), and the shared state files every key now has its own copy of go.
// Nothing else changes: prose carries over from the moved file like any brief on disk.
function migrateState(stateRoot: string, key: string): void {
  const oldDir = path.join(path.dirname(stateRoot), "review-brief");
  if (!fs.existsSync(stateRoot) && fs.existsSync(oldDir)) fs.renameSync(oldDir, stateRoot);
  for (const ref of ["refs/review-brief/previous", "refs/pr-brief/previous"]) // one snapshot ref per key now
    if (git(["rev-parse", "-q", "--verify", ref], { ok: true }).trim()) git(["update-ref", "-d", ref]);
  const place = (from: string, k: string) => {
    const to = path.join(stateRoot, k, `pr-brief-${k}.md`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) { // both layouts have one: the newer is the brief, the other its previous version (never dropped: it may carry notes)
      const legacyNewer = fs.statSync(from).mtimeMs > fs.statSync(to).mtimeMs;
      fs.renameSync(legacyNewer ? to : from, path.join(stateRoot, k, "previous.md"));
      if (!legacyNewer) return;
    }
    fs.renameSync(from, to);
  };
  const excl = path.join(GIT_COMMON, "info", "exclude");
  for (const name of ["PR_BRIEF.md", "REVIEW_BRIEF.md"]) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p) || !/^---\r?\n(?:pr|review)-brief: \d+/.test(fs.readFileSync(p, "utf8").slice(0, 64))) continue;
    const front = parseBrief(fs.readFileSync(p, "utf8")).front;
    const k = front.mode === "commit" && typeof front.head === "string" ? gitOk(["rev-parse", "--short=7", front.head])?.trim() || key : key;
    place(p, k);
  }
  // the tool never writes those names into the tree any more: their exclude lines are stale whether or not a file was moved
  if (fs.existsSync(excl)) { const lines = fs.readFileSync(excl, "utf8").split("\n"); const kept = lines.filter((l) => l !== "PR_BRIEF.md" && l !== "REVIEW_BRIEF.md"); if (kept.length !== lines.length) fs.writeFileSync(excl, kept.join("\n")); }
  const commits = path.join(stateRoot, "commits");
  if (fs.existsSync(commits)) {
    for (const sha of fs.readdirSync(commits)) {
      const p = path.join(commits, sha, "PR_BRIEF.md");
      if (fs.existsSync(p)) place(p, keyOf(sha));
      try { fs.rmdirSync(path.join(commits, sha)); } catch { /* something else in it: leave it */ }
    }
    try { fs.rmdirSync(commits); } catch { /* not empty */ }
  }
  for (const f of ["units.json", "skeleton.md", "previous.md"]) { const p = path.join(stateRoot, f); if (fs.existsSync(p)) fs.rmSync(p); }
}

// ---------------------------------------------------------------- main

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  const { sg } = preflight(a);
  if (a.check) { process.stdout.write(`preflight ok (ast-grep, git, node ${process.versions.node})\n`); return; }

  SCOPE = a.scope;
  const R = resolveRange(a);
  const { key, shown: keyShown } = briefKey(a, R);
  const stateRoot = path.join(GIT_COMMON, STATE_DIR);
  const stateDir = path.join(stateRoot, key); // this brief's own directory: the brief, its fact table, its archive
  const readOnly = a.list || a.section !== null; // --list and --section print and write nothing: no state, no brief, no ref
  if (!readOnly) migrateState(stateRoot, key);
  const outAbs = a.out ? path.resolve(ROOT, a.out) : path.join(stateDir, `pr-brief-${key}.md`);
  const outRel = path.relative(ROOT, outAbs);
  // a brief written into the working tree (--out) is kept out of the diff and of git status; under the git directory it is in neither
  const inTree = !outRel.startsWith("..") && !path.isAbsolute(outRel) && !(outAbs + path.sep).startsWith(GIT_COMMON + path.sep);
  // --path narrows, --exclude removes
  const excl = ["--", a.scope, ...(inTree ? [`:(exclude)${outRel}`] : []), ...a.exclude.map((e) => `:(exclude)${e}`)];

  // changed files
  const files: FileEntry[] = [];
  // -z: NUL-separated records, so a path holding `"` or `\` arrives unquoted. A rename or copy record
  // carries two paths (old, new); every other status one.
  const ns = git(["diff", "-z", "-M", "--name-status", ...R.diffArgs, ...excl]).split("\0");
  for (let i = 0; i < ns.length; i++) {
    const m = ns[i].match(/^([A-Z])\d*$/);
    if (!m) continue;
    const two = m[1] === "R" || m[1] === "C";
    const from = two ? ns[i + 1] : null, p = two ? ns[i + 2] : ns[i + 1];
    i += two ? 2 : 1;
    if (!p) continue;
    // T (a symlink became a regular file, or the reverse) and C (a copy) are a modification and an addition here
    const status = m[1] === "T" ? "M" : m[1] === "C" ? "A" : m[1];
    if (status !== "A" && status !== "M" && status !== "D" && status !== "R") continue; // U (unmerged), X: not a change to brief
    files.push({ path: p, status, renamedFrom: status === "R" ? from : null, lang: langOf(p), binary: false, oldContent: null, newContent: null, hash: "", units: [], tags: [], hunksU0: [], hunksU3: [], hunksW: [], slots: {}, notes: null, commitsSinceLast: [], revise: null });
  }
  // untracked files: git diff never lists them, but an agent's new files are the change being reviewed.
  // Working-tree modes only (an index or commit has no untracked files); .gitignore is respected.
  const untracked = new Set<string>();
  if (R.newSide === "worktree" && a.untracked) {
    const known = new Set(files.map((f) => f.path));
    for (const p of git(["ls-files", "-z", "--others", "--exclude-standard", ...excl]).split("\0")) {
      if (!p || known.has(p) || p.endsWith("/")) continue; // a trailing slash is a nested repository, not a file
      untracked.add(p);
      files.push({ path: p, status: "A", renamedFrom: null, lang: langOf(p), binary: false, oldContent: null, newContent: null, hash: "", units: [], tags: [], hunksU0: [], hunksU3: [], hunksW: [], slots: {}, notes: null, commitsSinceLast: [], revise: null });
    }
  }
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)); // byte order, same as git

  // generated files (gitattributes `linguist-generated`, or a minified/lock-file name) get one
  // unit and no hunk: nobody reviews a bundle line by line
  if (files.length) { // -z: path NUL attribute NUL value NUL, paths never quoted
    const z = git(["check-attr", "-z", "linguist-generated", "--", ...files.map((f) => f.path)]).split("\0");
    for (let i = 0; i + 2 < z.length; i += 3) if (z[i + 2] !== "unspecified" && z[i + 2] !== "false") { const f = files.find((f) => f.path === z[i]); if (f) f.tags.push("generated"); }
  }
  for (const f of files) if (!f.tags.includes("generated") && /(\.min\.(js|css)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$)/.test(f.path)) f.tags.push("generated");
  const PREFIX = ["--src-prefix=a/", "--dst-prefix=b/"]; // the parser keys hunks by these, whatever diff.noprefix/mnemonicPrefix say
  const u0 = parseUnified(git(["diff", "-U0", "-M", "--no-color", "--no-ext-diff", ...PREFIX, ...R.diffArgs, ...excl]));
  const u3 = parseUnified(git(["diff", "-U3", "-M", "--no-color", "--no-ext-diff", ...PREFIX, ...R.diffArgs, ...excl]));
  const uw = parseUnified(git(["diff", "-U0", "-w", "-M", "--no-color", "--no-ext-diff", ...PREFIX, ...R.diffArgs, ...excl]));
  // self-check: a text file git counts changed lines for must have produced hunks, or the parser missed it
  {
    const z = git(["diff", "--numstat", "-z", "-M", "--no-color", "--no-ext-diff", ...R.diffArgs, ...excl]).split("\0");
    for (let i = 0; i < z.length; i++) {
      const m = z[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (!m) continue;
      let p = m[3];
      if (p === "") { p = z[i + 2]; i += 2; } // a rename: the old and new paths follow as two records
      if (m[1] === "-" || +m[1] + +m[2] === 0 || !files.some((f) => f.path === p)) continue;
      if (!u0.get(p)?.length) die(`internal: git reports changed lines in ${p} but no hunk was parsed for it — please report this`);
    }
  }

  // contents
  const readNew = (p: string): string | null => {
    if (R.newSide === "worktree") {
      const abs = path.join(ROOT, p);
      let st: fs.Stats; try { st = fs.lstatSync(abs); } catch { return null; }
      if (st.isSymbolicLink()) return fs.readlinkSync(abs); // what git diffs: the link target
      if (st.isDirectory()) return null; // a submodule pointer: the diff hunk says what moved
      return fs.readFileSync(abs, "utf8");
    }
    if (R.newSide === "index") return gitOk(["show", `:${p}`]);
    return gitOk(["show", `${R.newSide}:${p}`]);
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-"));
  for (const f of files) {
    f.oldContent = f.status === "A" ? null : gitOk(["show", `${R.base}:${f.renamedFrom ?? f.path}`]);
    f.newContent = f.status === "D" ? null : readNew(f.path);
    if (untracked.has(f.path)) { const h = wholeFileHunk(f.newContent ?? ""); f.hunksU0 = [h]; f.hunksU3 = [h]; f.hunksW = [h]; }
    else { f.hunksU0 = u0.get(f.path) ?? []; f.hunksU3 = u3.get(f.path) ?? []; f.hunksW = uw.get(f.path) ?? []; }
    if ((f.newContent ?? f.oldContent ?? "").slice(0, 8000).includes("\0")) { f.binary = true; f.tags.push("binary"); f.oldContent = f.newContent = null; continue; }
    f.hash = sha(f.newContent ?? f.oldContent ?? "");
    if (f.tags.includes("generated")) { f.lang = null; continue; }
    if (!f.lang) { f.tags.push("unsupported-language"); continue; }
    for (const [side, c] of [["old", f.oldContent], ["new", f.newContent]] as const) {
      if (c === null) continue;
      const p = path.join(tmp, side, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c);
    }
  }
  const scan = (dir: string) => { try { return scanSymbolsOrThrow(sg, dir); } catch (e: any) { return die(e.message); } };
  const oldSyms = scan(path.join(tmp, "old"));
  const newSyms = scan(path.join(tmp, "new"));
  fs.rmSync(tmp, { recursive: true, force: true });

  for (const f of files) {
    if (f.binary) continue;
    if (!f.lang) {
      const gen = f.tags.includes("generated");
      const u: Unit = { id: `${f.path}#(file)`, path: f.path, kind: "file", name: "(file)", scope: "", status: f.status === "A" ? "new" : f.status === "D" ? "deleted" : "modified", oldSpan: null, newSpan: null, signature: "", oldSignature: null, display: "", newLines: new Set(), oldLines: new Set(), hunk: "", callers: null, tags: [gen ? "generated" : "unsupported-language"], hash: f.hash, badge: "", renamedFrom: null, col: 0, slots: {}, revise: null, notes: null };
      for (const h of f.hunksU0) { h.plusLines.forEach((l) => u.newLines.add(l)); h.minusLines.forEach((l) => u.oldLines.add(l)); }
      f.units = [u];
      continue;
    }
    attribute(f, oldSyms.get(f.path) ?? [], newSyms.get(f.path) ?? []);
  }
  findCallers(sg, files, R.newSide === "worktree" || R.newSide === "index" ? null : R.newSide);
  for (const f of files) for (const u of f.units) u.hunk = renderHunk(f, u, a.fullFnMax);

  if (a.list) {
    for (const f of files) for (const u of f.units)
      process.stdout.write([u.status.padEnd(8), u.kind.padEnd(11), u.id, u.newSpan ? `${u.newSpan[0]}-${u.newSpan[1]}` : "-", u.oldSpan ? `${u.oldSpan[0]}-${u.oldSpan[1]}` : "-", u.callers ? `callers=${u.callers.total}` : "", u.tags.join(",")].join("  ") + "\n");
    return;
  }

  // previous brief + carry-over (§15.3)
  const sources = loadPrevious(outAbs, stateDir, stateRoot, a.mode, a.fresh);
  // Prose and reviewer notes carry over from ANY earlier brief whose unit body matches (by hash).
  // The "since last" bookkeeping — badges, counts, revise notes, the header line — only makes
  // sense against a brief of the same work: the same commit in commit mode; otherwise the same
  // mode, provided none of that brief's work has been committed since. A rebase or an amend
  // rewrites history (the old base is no ancestor of the new one) and an unrelated commit moves
  // the base without touching the brief's files: both are still the same change set. A commit
  // that touches those files means the reviewed work landed, and the next brief starts clean.
  // the reference is the first source the reviewer could actually have read: a skeleton regenerated
  // before it was filled (every slot still a token) is not a previous brief, only a previous skeleton
  const filledBrief = (p: ParsedBrief) => (p.overview && !isToken(p.overview)) || p.files.some((pf) => [...Object.values(pf.slots), ...pf.units.flatMap((pu) => Object.values(pu.slots))].some((v) => typeof v === "string" && v && !isToken(v)));
  const primary = sources.find(filledBrief) ?? null;
  const committedSince = (p: ParsedBrief): boolean => {
    const pb = typeof p.front.base === "string" ? p.front.base : null;
    if (!pb || pb === R.base) return false;
    if (gitOk(["merge-base", "--is-ancestor", pb, R.base]) === null) return false; // history rewritten: same work
    const files = p.files.map((f) => f.path);
    return files.length > 0 && (gitOk(["diff", "--name-only", pb, R.base, "--", ...files]) ?? "").trim().length > 0;
  };
  const sameWork = (p: ParsedBrief) => (a.mode === "commit" ? p.front.mode === "commit" && p.front.head === R.head : p.front.mode === a.mode && !committedSince(p));
  const prev = primary && sameWork(primary) ? primary : null;
  const unitMaps = sources.map((s) => new Map(s.files.flatMap((pf) => pf.units.map((pu) => [pu.id, pu] as const))));
  const fileMaps = sources.map((s) => new Map(s.files.map((pf) => [pf.path, pf] as const)));
  // Prose cache written by lint on every clean run: (id@hash) → slots. Any unit
  // body ever described is recoverable, whatever mode or brief it was in.
  const cacheFile = path.join(stateRoot, "cache.json"); // shared by every brief of the repository
  const cache: Record<string, any> = !a.fresh && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  // per id: the first source whose hash matches wins; then the cache; else the first source that has it
  const pick = (maps: Map<string, any>[], key: string, hash: string): any => {
    let first: any = null;
    // an entry whose slots are still tokens (a skeleton regenerated before it was filled) carries nothing: skip it
    const filled = (x: any) => Object.values(x.slots ?? {}).some((v) => typeof v === "string" && v && !isToken(v));
    for (const m of maps) { const x = m.get(key); if (!x) continue; if (x.hash === hash && filled(x)) return x; if (filled(x)) first ??= x; }
    const c = cache[`${key}@${hash}`];
    if (c) return { ...c, hash, slots: { ...c.slots, notes: first?.slots?.notes } };
    return first;
  };
  const prevUnits: Map<string, any> = prev ? new Map(prev.files.flatMap((pf) => pf.units.map((pu) => [pu.id, pu] as const))) : new Map();
  const prevHead = prev?.front.head ?? null, prevSnap = prev?.front.snapshot ?? null;
  const snapOk = prevSnap && gitOk(["cat-file", "-e", `${prevSnap}^{commit}`]) !== null;
  const newCommits = prev && prevHead ? (gitOk(["log", "--reverse", "--format=%h %s", `${prevHead}..${R.head}`]) ?? "").trim().split("\n").filter(Boolean) : [];
  const sinceDiff = snapOk ? parseUnified(git(["diff", "-U3", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", prevSnap, ...(R.newSide === "worktree" ? [] : R.newSide === "index" ? ["--cached"] : [R.newSide]), ...excl], { ok: true })) : new Map<string, Hunk[]>();
  const counts = { changed: 0, removed: 0, unchanged: 0 };
  let carried = 0;
  const lock = (text: string | undefined): { locked: boolean; text: string } | null => (text && !isToken(text) ? { locked: true, text } : null);

  for (const f of files) {
    const pf = pick(fileMaps, f.path, f.hash);
    if (prev && prevHead) f.commitsSinceLast = (gitOk(["log", "--reverse", "--format=%h %s", `${prevHead}..${R.head}`, "--", f.path]) ?? "").trim().split("\n").filter(Boolean);
    let anyChanged = false;
    for (const u of f.units) {
      const pu = pick(unitMaps, u.id, u.hash);
      if (pu) {
        // reviewer notes are never dropped; prose is carried when the unit body is the same
        const pn: string | undefined = pu.slots.notes;
        if (pn) u.notes = pu.hash === u.hash ? pn : (pn.startsWith("*(code changed since this note)*") ? pn : `*(code changed since this note)* ${pn}`);
        if (pu.hash === u.hash) {
          let any = false;
          for (const k of ["does", "change", "did", "other", "review"]) { const l = lock(pu.slots[k]); if (l) { u.slots[k] = l; any = true; } }
          if (any) carried++;
          // reviewed before and the line was deleted: nothing to say, do not ask again. Only when the
          // previous brief was actually filled — a skeleton regenerated before filling still has tokens
          if (!pu.slots.review && !isToken(pu.slots.does ?? pu.slots.did ?? pu.slots.other ?? "<<rb:")) u.slots.review = { locked: true, text: "" };
        }
      }
      if (!prev) continue;
      // one badge, one meaning: this unit is not what the previous brief showed (absent then, or a different
      // body). Compared against the previous brief's own unit — not the prose pick, which may come from an
      // older brief or the cache when the previous brief's slot was still a token.
      const prevU = prevUnits.get(u.id);
      if (!prevU) { u.badge = "changed since last"; counts.changed++; anyChanged = true; continue; }
      if (prevU.hash === u.hash) counts.unchanged++;
      else {
        counts.changed++; anyChanged = true; u.badge = "changed since last";
        const prevText = (k: string): string | undefined => [prevU, pu].map((x) => x?.slots?.[k]).find((v) => typeof v === "string" && v && !isToken(v));
        const since = (sinceDiff.get(f.path) ?? []).filter((h) => h.plusLines.some((l) => u.newLines.has(l) || (u.newSpan && l >= u.newSpan[0] && l <= u.newSpan[1])) || h.minusLines.some((l) => u.oldLines.has(l)));
        u.revise = [
          ...["does", "change", "did", "other", "review"].filter((k) => prevText(k)).map((k) => `previous ${labelOf(k, u.kind).slice(2,-3)}: ${prevText(k)}`),
          `commits touching this file since last brief: ${f.commitsSinceLast.length ? f.commitsSinceLast.join("; ") : "none (uncommitted changes)"}`,
          "since-last hunk:",
          ...(since.length ? since.map((h) => [h.header, ...h.body].join("\n")) : ["(not available)"]),
          "Revise the previous text using the commits and hunk above. Lint removes this note.",
        ].join("\n");
      }
    }
    // Purpose is mode-independent and Notes are the reviewer's: take them from any source.
    // Changes and Review Observations depend on which units are in the range: same work only.
    if (pf) {
      const p = lock(pf.slots.purpose);
      if (p && pf.hash === f.hash) f.slots.purpose = p;
      else if (p) f.purposeRevise = `previous File Context: ${p.text}`; // the file changed: confirm or revise, do not start from scratch
      if (pf.slots.notes) f.notes = pf.slots.notes;
    }
    // the same commit briefed before, with no brief of it on disk: its file prose comes back from the cache
    const pfPrev = prev ? fileMaps[sources.indexOf(prev)].get(f.path) ?? null : (a.mode === "commit" && cache[`${f.path}@commit@${R.head}`] ? { slots: { purpose: f.slots.purpose?.text, ...cache[`${f.path}@commit@${R.head}`].slots } } : null);
    if (pfPrev) {
      const c = lock(pfPrev.slots.changes);
      if (!anyChanged) { if (c) f.slots.changes = c; const r = lock(pfPrev.slots.review); if (r) f.slots.review = r; else if (!pfPrev.slots.review && (c ?? lock(pfPrev.slots.purpose))) f.slots.review = { locked: true, text: "" }; }
      else if (c) f.revise = [`previous Changes: ${c.text}`, `commits touching this file since last brief: ${f.commitsSinceLast.length ? f.commitsSinceLast.join("; ") : "none (uncommitted changes)"}`, `units changed in this file: ${f.units.filter((u) => u.badge).map((u) => u.name + " (" + u.badge + ")").join(", ")}`, "Revise the previous text using the above. Lint removes this note."].join("\n");
    }
  }
  if (prev) for (const id of prevUnits.keys()) if (!files.some((f) => f.units.some((u) => u.id === id))) counts.removed++;
  const overviewLocked = prev && prev.overview && !isToken(prev.overview) && counts.changed + counts.removed === 0 ? prev.overview
    : !prev && a.mode === "commit" && cache[`overview@commit@${R.head}`] ? cache[`overview@commit@${R.head}`].slots.overview : null;
  // reviewer notes on units that left the range are never dropped: they come from the first filled
  // source whether or not it is the same work (after the noted work is committed, it is not)
  const primaryUnits: Map<string, any> = primary ? new Map(primary.files.flatMap((pf) => pf.units.map((pu) => [pu.id, pu] as const))) : new Map();
  const orphanNotes = [...primaryUnits.values()].filter((pu) => pu.slots.notes && !isToken(pu.slots.notes) && !files.some((f) => f.units.some((u) => u.id === pu.id))).map((pu) => `- \`${pu.id}\` — ${pu.slots.notes}`);

  // snapshot (§15.1)
  const dirty = git(["status", "--porcelain", "--untracked-files=no", ...excl]).trim() !== "" || untracked.size > 0;
  let snapshot = R.head;
  if (dirty && R.newSide === "worktree" && !readOnly) { const s = git(["stash", "create"], { ok: true }).trim(); if (s) snapshot = s; }
  if (!readOnly) git(["update-ref", `refs/pr-brief/${key}`, snapshot]); // keeps this brief's snapshot alive through gc

  // ---- render skeleton (§9)
  const nFiles = { A: 0, M: 0, D: 0, R: 0 }; for (const f of files) nFiles[f.status]++;
  const nUnits = { new: 0, modified: 0, deleted: 0, other: 0 };
  for (const f of files) for (const u of f.units) { if (u.kind === "other") nUnits.other++; else nUnits[u.status]++; }
  // a rename alone is not a signature change: compare the old signature with the old name swapped for the new one
  const sigChanged = (u: Unit) => u.status === "modified" && u.oldSignature !== null && u.oldSignature !== u.signature
    && !(u.renamedFrom && u.oldSignature.split(u.renamedFrom.split(".").pop()!).join(u.name) === u.signature);
  const unitPart = (id: string) => id.slice(id.indexOf("#") + 1);
  const sigChanges = files.flatMap((f) => f.units.filter(sigChanged).map((u) => `\`${unitPart(u.id)}\``));
  const renames = files.flatMap((f) => f.units.filter((u) => u.renamedFrom).map((u) => `\`${u.renamedFrom}\` → \`${unitPart(u.id)}\``));
  const L: string[] = [];
  L.push("---", `pr-brief: ${FORMAT_VERSION}`, `key: ${key}`, `root: ${ROOT}`, `mode: ${a.mode}`, `base: ${R.base}`, `head: ${R.head}`, `snapshot: ${snapshot}`, `worktree: ${dirty ? "dirty" : "clean"}`, `generated: ${new Date().toISOString()}`, "previous:", `  head: ${prevHead ?? "null"}`, `  snapshot: ${prevSnap ?? "null"}`, "---", "");
  L.push(`# PR Brief — ${keyShown} · ${R.label}`, ""); // the key names the brief; the label says what it covers
  // summary block: a blockquote of bullets (one fact per line renders as one line), long parts folded
  const q = (l: string) => "> " + l;
  L.push(q(`- **Base** \`${R.base.slice(0, 7)}\` → **Head** \`${R.head.slice(0, 7)}\`${R.newSide === "worktree" ? " + working tree" : R.newSide === "index" ? " + index" : ""}`));
  L.push(q(`- **Files** ${files.length} changed (${nFiles.A} added, ${nFiles.M} modified, ${nFiles.D} deleted${nFiles.R ? `, ${nFiles.R} renamed` : ""}${untracked.size ? `, ${untracked.size} untracked` : ""}) · **Units** ${nUnits.new + nUnits.modified + nUnits.deleted + nUnits.other} (${nUnits.new} new, ${nUnits.modified} modified, ${nUnits.deleted} deleted, ${nUnits.other} other)`));
  const body = R.commit ? R.commit.body.split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean) : [];
  if (R.commit) {
    L.push(q(`- **Commit** ${R.commit.subject} — ${R.commit.author}, ${R.commit.date}`));
    if (body.length && body.length <= 3) for (const b of body) L.push(q(`  - ${b}`));
  }
  L.push(q(`- **Signature changes** ${sigChanges.length ? sigChanges.join(", ") : "none"}`));
  if (renames.length) L.push(q(`- **Renamed** ${renames.join(", ")}`));
  if (prev) {
    const rangeChanged = prev.front.mode !== a.mode || prev.front.base !== R.base;
    L.push(q(`- **Since last brief** ${newCommits.length} commit${newCommits.length === 1 ? "" : "s"}${newCommits.length ? " (" + newCommits.slice(0, 5).join("; ") + (newCommits.length > 5 ? `; … ${newCommits.length - 5} more` : "") + ")" : ""}${dirty ? " + uncommitted changes" : ""} — ${counts.changed} changed, ${counts.removed} removed, ${counts.unchanged} unchanged${rangeChanged ? ` · range changed: ${prev.front.mode}/${String(prev.front.base).slice(0, 7)} → ${a.mode}/${R.base.slice(0, 7)}` : ""}`));
  }
  if (body.length > 3) L.push(q(""), q(`<details class="rb-meta"><summary>Commit message (${body.length} lines)</summary>`), q(""), ...body.map((b) => q(`- ${b}`)), q(""), q("</details>"));
  const atRev = R.newSide !== "worktree" && R.newSide !== "index" ? R.newSide.slice(0, 7) : null;
  L.push(q(""), q('<details class="rb-meta"><summary>Agent instructions</summary>'), q(""));
  L.push(q(`**Read these before filling any slot**${atRev ? ` — at commit \`${atRev}\`, with \`git show ${atRev}:<path>\`, not from the working tree` : ""}:`), q(""));
  const toRead = files.filter((f) => f.status !== "D").map((f) => `\`${f.path}\``);
  L.push(...(toRead.length ? toRead.map((p) => q(`- ${p}`)) : [q("- (none)")]), q(""));
  L.push(q(`**Style:** concise and plain. Declarative sentences; no preamble, hedging, or filler; never restate the heading ("This function…"). Build upward, and every slot names its step: step 1 the unit slots of a file, step 2 that file's Context, Changes and observations from its units, step 3 the Overview from every file.`), q(""), q("</details>"), "");
  L.push(`**Overview:** ${overviewLocked ?? "<<rb:overview | step 3, fill LAST, after every file section below is complete, from every file's Changes and the Context of added files: a concise summary of all the changes. A concise lead line on what the whole change set accomplishes, then, when it has more than one distinct part, a concise bullet per part naming the files that carry it (no blank line between lead and bullets); a single-part change set is a short paragraph instead, naming the files or groups of files that carry each piece.>>"}`, "");
  if (!overviewLocked && prev?.overview && !isToken(prev.overview)) {
    const changed = files.flatMap((f) => f.units.filter((u) => u.badge).map((u) => `${u.id} (${u.badge})`));
    const removed = prev ? [...prevUnits.keys()].filter((id) => !files.some((f) => f.units.some((u) => u.id === id))).map((id) => `${id} (removed)`) : [];
    L.push("<!-- rb:revise overview", `previous Overview: ${prev.overview}`, `commits since last brief: ${newCommits.length ? newCommits.join("; ") : "none (uncommitted changes)"}`, `units changed since last brief: ${[...changed, ...removed].join(", ") || "none"}`, "Revise the previous text using the above, after the file sections are done. Lint removes this note.", "-->", "");
  }

  const expected: string[] = [];
  const slotIndex: any[] = [];
  // relative Markdown links into the repo: GitHub resolves them, the viewer opens the file at the line
  // a destination with a space or parentheses is not a Markdown link unless wrapped in <…>
  const link = (label: string, file: string, line?: number) => { const dest = `${file}${line ? `#L${line}` : ""}`; return `[\`${label}\`](${/[\s()<>]/.test(dest) ? `<${dest}>` : dest})`; };
  const siteLink = (s: string) => { const i = s.lastIndexOf(":"); return link(s, s.slice(0, i), +s.slice(i + 1)); };
  // fence longer than any backtick run inside the hunk, so Markdown in a hunk cannot close it
  const fence = (s: string) => { const n = Math.max(3, ...[...s.matchAll(/^[ +-]? {0,3}(`+)/gm)].map((m) => m[1].length + 1)); const f = "`".repeat(n); return [f + "diff", ...s.split("\n"), f]; };
  for (const f of files) {
    const statusWord = f.status === "A" ? "added" : f.status === "D" ? "deleted" : f.status === "R" ? `renamed from \`${f.renamedFrom}\`` : "modified";
    const extra = f.tags.includes("binary") ? " · binary" : f.tags.includes("generated") ? " · generated" : f.tags.includes("unsupported-language") ? " · whole file" : "";
    const h = `## ${f.status === "D" ? `\`${f.path}\`` : link(f.path, f.path)} — ${statusWord}${extra}`;
    const marker = `<!-- rb:file path="${f.path}" hash="${f.hash}" -->`;
    L.push("---", "", h, marker, "");
    expected.push(h, marker);
    if (f.binary) { L.push(`Binary file; ${statusWord}. No units.`, ""); continue; }
    // Changes: must name every unit except tests (their titles are long and they are listed just below) and buckets
    const unitNames = f.units.filter((u) => u.kind !== "other" && u.kind !== "file" && u.kind !== "test").map((u) => u.name);
    L.push(`${labelOf("purpose")} ${f.slots.purpose?.text ?? `<<rb:purpose ${f.path} | step 2, after this file's unit slots: concise summary: what this file does and owns, as it now stands${f.status === "D" ? " (past tense: it was deleted)" : f.status === "A" ? " — the file is new; say what it is for and who is expected to use it" : ""}>>`}`, "");
    // an added file has no "before": Purpose only (its units are all new and get Purpose: only)
    if (f.status !== "A") L.push(`**Changes:** ${f.slots.changes?.text ?? `<<rb:changes ${f.path} | step 2, after every unit slot in this file, from the unit Changes below: a concise enumeration, in sentences or concise bullets (bullets directly under the label line, no blank line), of the unit updates and what they add up to; when the file has one unit, a concise summary of what it adds up to, not a restatement. Must name every unit below${unitNames.length ? ": " + unitNames.join(", ") : ""}>>`}`, "");
    if (f.slots.review?.text !== "") { const slot = f.slots.review?.text, id = f.path; L.push(`**Review Observations:** ${slot ?? `<<rb:review ${id} | step 2, optional, concise, file-wide only (anything about one unit goes under that unit): ${REVIEW_TAIL}>>`}`, ""); }
    if (f.revise || f.purposeRevise) L.push(`<!-- rb:revise ${f.path}`, [f.purposeRevise, f.revise].filter(Boolean).join("\n"), "-->", "");
    if (f.notes) L.push(`**Notes:** ${f.notes}`, "");
    slotIndex.push({ scope: "file", path: f.path, status: f.status, slots: f.slots, unitNames, notes: f.notes });

    const others = f.units.filter((u) => u.kind === "other" || u.kind === "file");
    if (others.length) {
      L.push("**Other changes:**");
      for (const u of others) {
        const marker = `<!-- rb:unit id="${u.id}" kind="${u.kind}" status="${u.status}" hash="${u.hash}" -->`;
        L.push(marker);
        expected.push(marker);
        const runs = (ls: Set<number>, span: [number, number]) => ls.size === span[1] - span[0] + 1;
        const spanText = (span: [number, number], ls: Set<number>) => runs(ls, span) ? `${span[0]}-${span[1]}` : `${span[0]} (${ls.size} lines)`;
        const loc = u.newSpan ? link(`${path.basename(f.path)}:${spanText(u.newSpan, u.newLines)}`, f.path, u.newSpan[0]) : u.oldSpan ? `\`was ${path.basename(f.path)}:${spanText(u.oldSpan, u.oldLines)}\`` : link(path.basename(f.path), f.path);
        const label = u.kind === "file" ? (f.tags.includes("generated") ? "(generated file; not shown)" : `(whole file; no unit rules for ${path.extname(f.path) || "this file type"})`) : u.name;
        // a whole new file with no unit rules has nothing to say beyond the file's Purpose: no slot
        const otherText = u.slots.other?.text ?? (u.kind === "file" && u.status === "new" ? "new file" : `<<rb:other ${u.id} | step 1: one concise line: what changed here>>`);
        L.push(`- ${loc} ${label}${u.badge ? ` · ${u.badge}` : ""} — ${otherText}`);
        if (u.revise) L.push(`<!-- rb:revise ${u.id}`, u.revise, "-->");
        L.push(...fence(u.hunk), "");
        if (u.notes) L.push(`**Notes:** ${u.notes}`, ""); // where the viewer puts a note on a bullet unit: after its fence
        slotIndex.push({ scope: "unit", id: u.id, kind: u.kind, slots: u.slots, notes: u.notes });
      }
    }
    for (const u of f.units) {
      if (u.kind === "other" || u.kind === "file") continue;
      // the verb a unit's slots ask about: a callable does, a document says, everything else (a type, field, key, rule, …) defines
      const verbs = u.kind === "section" || u.kind === "doc" ? { now: "says now", past: "used to say", change: "what it now says that it did not, or no longer says" }
        : CALLABLE_KINDS.has(u.kind) ? { now: "does now", past: "used to do", change: "what it now does that it did not, or no longer does" }
        : { now: "defines now", past: "used to define", change: "what it now defines that it did not, or no longer defines" };
      const loc = u.status === "deleted" ? `was \`${f.path}:${u.oldSpan![0]}-${u.oldSpan![1]}\`` : link(`${f.path}:${u.newSpan![0]}-${u.newSpan![1]}`, f.path, u.newSpan![0]);
      const tagStr = (u.renamedFrom ? ` · renamed from \`${u.renamedFrom}\`` : "") + u.tags.filter((t) => t !== "container-only").map((t) => ` · ${t}`).join("") + (u.tags.includes("container-only") ? " · container only (members listed separately)" : "");
      const kindLabel = u.kind === "const" ? (u.signature.match(/^(let|var)\b/)?.[1] ?? "const") : u.kind;
      const tick = "`".repeat(Math.max(1, ...[...u.display.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      const h = `### ${tick}${u.display}${tick} — ${u.status}${u.kind !== "function" && u.kind !== "method" ? ` ${kindLabel}` : ""} · ${loc}${tagStr}${u.badge ? ` · ${u.badge}` : ""}`;
      const marker = `<!-- rb:unit id="${u.id}" kind="${u.kind}" status="${u.status}" hash="${u.hash}" -->`;
      L.push(h, marker, "");
      expected.push(h, marker);
      if (u.callers) {
        const extra = [u.callers.total > CALLER_CAP ? `first ${CALLER_CAP} shown` : "", u.callers.note ?? ""].filter(Boolean).join("; ");
        L.push(`**${CALLABLE_KINDS.has(u.kind) ? "Callers" : "References"} (by name):** ${u.callers.total ? u.callers.sites.map(siteLink).join(", ") + ` (${u.callers.total}${extra ? "; " + extra : ""})` : `none found${extra ? " (" + extra + ")" : ""}`}`, "");
      }
      if (u.status === "deleted") {
        // a deleted unit keeps a Changes line: the deletion is the change, and the reader should not have to infer it from a missing label
        L.push(`${labelOf("did", u.kind)} ${u.slots.did?.text ?? `<<rb:did ${u.id} | step 1: concise summary, past tense: what this ${u.kind} ${verbs.past}>>`}`, "");
        L.push(`${labelOf("change")} ${u.slots.change?.text ?? `<<rb:change ${u.id} | step 1: one concise line, starting with the word Deleted: what its removal takes away, and what replaces it when you can see it${u.callers ? "; a caller listed above is now broken unless it was changed too" : ""}>>`}`, "");
      } else {
        L.push(`${labelOf("does", u.kind)} ${u.slots.does?.text ?? `<<rb:does ${u.id} | step 1: concise summary, present tense: what this ${u.kind} ${verbs.now}${u.callers ? "; may cite the callers line above" : ""}>>`}`, "");
        if (u.status === "modified") {
        const sigNote = u.renamedFrom ? ` Renamed from \`${u.renamedFrom}\` — say so, then describe any other difference.` : u.oldSignature !== null && u.oldSignature !== u.signature ? ` The signature changed — name it: was \`${u.oldSignature}\`.` : "";
          const ws = u.tags.includes("whitespace-only") ? ' If the change is formatting only, write exactly: "formatting only".' : "";
          L.push(`${labelOf("change")} ${u.slots.change?.text ?? `<<rb:change ${u.id} | step 1: a concise summary, or a concise bullet per change when there is more than one (bullets directly under the label line, no blank line): ${verbs.change} — stated first, checkable against the hunk below.${sigNote} A trailing clause on what the change is meant to accomplish is allowed after the description, never instead of it. If the code and its apparent intent disagree, describe the code and say so.${ws}>>`}`, "");
        }
      }
      if (u.slots.review?.text !== "") { const slot = u.slots.review?.text, id = u.id; L.push(`**Review Observations:** ${slot ?? `<<rb:review ${id} | step 1, optional, concise: ${REVIEW_TAIL}>>`}`, ""); }
      if (u.revise) L.push(`<!-- rb:revise ${u.id}`, u.revise, "-->", "");
      L.push(...fence(u.hunk), "");
      if (u.notes) L.push(`**Notes:** ${u.notes}`, "");
      slotIndex.push({ scope: "unit", id: u.id, kind: u.kind, status: u.status, slots: u.slots, notes: u.notes, name: u.name });
    }
  }
  if (orphanNotes.length) { expected.push("## Orphaned notes"); L.push("---", "", "## Orphaned notes", "", "Notes from the previous brief whose units no longer exist in this range.", "", ...orphanNotes, ""); }

  // slot instructions must not contain ">" so that `<<rb:… | …>>` is always delimited by the first ">>".
  // Applied outside code fences only — a hunk may legitimately contain that text (this file's own source does).
  let fenceLen = 0;
  const lines0 = L.map((l) => {
    const fm = l.match(/^(`{3,})/);
    if (fenceLen === 0 && fm) { fenceLen = fm[1].length; return l; }
    if (fenceLen > 0) { if (fm && fm[1].length >= fenceLen && l.trim() === fm[1]) fenceLen = 0; return l; }
    return l.replace(/<<rb:([^|\n]*)\| ([^\n]*?)>>/g, (_m, id, instr) => `<<rb:${id}| ${instr.replace(/>/g, "›")}>>`);
  });
  if (a.section) { // read-only: print one file's section exactly as it would be written, touch nothing on disk
    const heads = [`## \`${a.section}\``, `## [\`${a.section}\`](${a.section})`];
    const start = lines0.findIndex((l) => heads.some((h) => l === h || l.startsWith(h + " —")));
    if (start < 0) die(`no section for ${a.section}`);
    let end = lines0.indexOf("---", start); if (end < 0) end = lines0.length;
    process.stdout.write(listOnNextLine(lines0.slice(start, end).join("\n")) + "\n");
    return;
  }
  const text = listOnNextLine(lines0.join("\n")); // a carried-over value that is a list keeps its bullets on their own lines
  // state for lint (§14): lives under the git directory so it is never in the diff
  fs.mkdirSync(stateDir, { recursive: true });
  if (fs.existsSync(outAbs)) fs.copyFileSync(outAbs, path.join(stateDir, "previous.md")); // whatever is overwritten stays recoverable
  else if (fs.existsSync(path.join(stateDir, "previous.md"))) fs.rmSync(path.join(stateDir, "previous.md"));
  fs.writeFileSync(path.join(stateDir, "units.json"), JSON.stringify({
    out: outAbs, key, root: ROOT, mode: a.mode, generated: new Date().toISOString(), expected, overviewLocked, slotIndex,
    units: files.flatMap((f) => f.units.map((u) => ({ id: u.id, path: u.path, kind: u.kind, name: u.name, status: u.status, oldSpan: u.oldSpan, newSpan: u.newSpan, hash: u.hash, tags: u.tags, callers: u.callers, badge: u.badge }))),
  }, null, 2));
  fs.writeFileSync(path.join(stateDir, "skeleton.md"), text);
  fs.writeFileSync(path.join(stateRoot, "last"), key + "\n"); // the brief lint checks when not told which
  fs.mkdirSync(path.dirname(outAbs), { recursive: true }); // --out may name a folder that does not exist yet
  fs.writeFileSync(outAbs, text);

  // info/exclude offer (§9a) for a brief written into the tree: add automatically, it is local-only
  if (inTree) {
    const exclFile = path.join(GIT_COMMON, "info", "exclude");
    fs.mkdirSync(path.dirname(exclFile), { recursive: true });
    const exclText = fs.existsSync(exclFile) ? fs.readFileSync(exclFile, "utf8") : "";
    if (!exclText.split("\n").includes(outRel)) fs.appendFileSync(exclFile, (exclText.endsWith("\n") || exclText === "" ? "" : "\n") + outRel + "\n");
  }

  if (a.open) { // hand the brief to the vendored editor (scripts/viewer.ts); it outlives this process
    const child = spawn(process.execPath, [path.join(SKILL_DIR, "scripts", "viewer.ts"), "--out", outAbs], { cwd: ROOT, stdio: "ignore", detached: true });
    child.unref();
  }
  const emptySlots = parseBrief(text).tokens.length; // fence-aware: hunks may contain literal "<<rb:"
  process.stdout.write(`wrote ${outAbs}: ${files.length} files${untracked.size ? ` (${untracked.size} untracked)` : ""}, ${nUnits.new + nUnits.modified + nUnits.deleted + nUnits.other} units, ${emptySlots} slots to fill${carried ? ` (${carried} units carried over)` : ""}\n`);
}

main();
