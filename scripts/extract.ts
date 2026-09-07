#!/usr/bin/env node
// extract.ts — the deterministic half of review-brief (spec §4a–§9, §15).
// Computes changed files and units from git + ast-grep, carries prose over
// from the previous brief, and writes REVIEW_BRIEF.md as a skeleton with
// slot tokens for the agent to fill. Never calls a model.
//
// Exit codes: 0 ok · 1 usage/runtime error · 2 preflight failure (missing tool)

import { execFileSync, spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { FORMAT_VERSION, BUDGETS, SHORT_KINDS, CALLABLE_KINDS, parseBrief, isToken, labelOf } from "./brief-format.ts";
import type { ParsedBrief } from "./brief-format.ts";
import { SKILL_DIR, scanSymbols as scanSymbolsOrThrow, signatureOf, symKey, qualName, paramsOf, innermost, displayName } from "./symbols.ts";
import type { Sym } from "./symbols.ts";

const SG_MIN = [0, 30, 0];
const NODE_MIN = 22;
const CALLER_CAP = 20;
const TYPE_KINDS = new Set(["class", "interface", "enum", "record", "annotation", "type", "object"]);
const DEFAULT_OUT = "REVIEW_BRIEF.md";
const DEFAULT_BASE = "origin/main";
const DEFAULT_FULL_FN_MAX = 150; // full-body diff up to this many lines, or when a third of the body changed; 0 = always
const STATE_DIR = "review-brief"; // under .git/

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
  newLines: Set<number>; oldLines: Set<number>;
  hunk: string; callers: { total: number; sites: string[] } | null;
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
  out: string; list: boolean; fresh: boolean; check: boolean; section: string | null; scope: string; open: boolean; exclude: string[];
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
};
const CALLER_LANGS: Record<string, string[]> = {
  typescript: ["TypeScript", "Tsx"], tsx: ["TypeScript", "Tsx"], javascript: ["JavaScript"], java: ["Java"],
  python: ["Python"], kotlin: ["Kotlin"], go: ["Go"], lua: ["Lua"],
  bash: [], html: [], css: [], yaml: [], markdown: [], // no call syntax to search
};
function langOf(p: string): string | null {
  return LANG_BY_EXT[path.extname(p).toLowerCase()] ?? null;
}

// ---------------------------------------------------------------- args

function parseArgs(argv: string[]): Args {
  const a: Args = { mode: "wip", raw: [], base: DEFAULT_BASE, commit: "HEAD", fullFnMax: DEFAULT_FULL_FN_MAX, out: DEFAULT_OUT, list: false, fresh: false, check: false, section: null, scope: ".", open: false, exclude: [], untracked: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--") { a.mode = "raw"; a.raw = argv.slice(i + 1); break; }
    else if (x === "wip" || x === "branch" || x === "all") a.mode = x;
    else if (x === "commit") { a.mode = "commit"; if (argv[i + 1] && !argv[i + 1].startsWith("-")) a.commit = argv[++i]; }
    else if (x === "--base") a.base = argv[++i];
    else if (x === "--full-fn-max") a.fullFnMax = parseInt(argv[++i], 10);
    else if (x === "--out") a.out = argv[++i];
    else if (x === "--list") a.list = true;
    else if (x === "--fresh") a.fresh = true;
    else if (x === "--check") a.check = true;
    else if (x === "--section") a.section = argv[++i];
    else if (x === "--path") a.scope = argv[++i];
    else if (x === "--open") a.open = true;
    else if (x === "--exclude") a.exclude.push(argv[++i]);
    else if (x === "--no-untracked") a.untracked = false;
    else if (x === "-h" || x === "--help") { process.stdout.write(USAGE); process.exit(0); }
    else die(`unknown argument: ${x}\n${USAGE}`);
  }
  return a;
}
const USAGE = `usage: extract.ts [wip|branch|all|commit <ref>] [--base <ref>] [--full-fn-max N (default 150; 0 = always full body)] [--out PATH] [--list] [--fresh] [--check] [--section PATH] [--path DIR] [--exclude PATHSPEC]... [--no-untracked] [--open]
       extract.ts -- <git diff args>
`;

// ---------------------------------------------------------------- preflight (§4a)

function preflight(a: Args): { sg: string } {
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < NODE_MIN) die(`review-brief scripts need node >= ${NODE_MIN} (found ${process.versions.node}).`, 2);

  let sg: string | null = null;
  let ver = "";
  for (const cand of ["ast-grep", "sg"]) {
    const r = spawnSync(cand, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /ast-grep/.test(r.stdout)) { sg = cand; ver = r.stdout.trim(); break; }
  }
  if (!sg) die(`review-brief needs ast-grep, which is not installed.\nInstall: brew install ast-grep\n   (or: npm i -g @ast-grep/cli, cargo install ast-grep)`, 2);
  const vm = ver.match(/(\d+)\.(\d+)\.(\d+)/);
  if (vm) {
    const v = [+vm[1], +vm[2], +vm[3]];
    const tooOld = v[0] < SG_MIN[0] || (v[0] === SG_MIN[0] && (v[1] < SG_MIN[1] || (v[1] === SG_MIN[1] && v[2] < SG_MIN[2])));
    if (tooOld) die(`ast-grep ${vm[0]} is too old; need >= ${SG_MIN.join(".")}. Run: brew upgrade ast-grep`, 2);
  }

  const inTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inTree.status !== 0 || !/true/.test(inTree.stdout)) die(`review-brief must be run inside a git repository.`, 2);
  ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

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
  if (a.mode === "wip") return { diffArgs: ["HEAD"], base: head, head, newSide: "worktree", label: "wip" };
  if (a.mode === "all") {
    const empty = git(["hash-object", "-t", "tree", "/dev/null"]).trim(); // the empty tree
    return { diffArgs: [empty], base: empty, head, newSide: "worktree", label: "all (entire tree)" };
  }
  if (a.mode === "commit") {
    // one commit: its parent (or the empty tree for a root commit) → the commit itself
    const c = git(["rev-parse", `${a.commit}^{commit}`]).trim();
    const parent = gitOk(["rev-parse", "--verify", "--quiet", `${c}^`])?.trim() || git(["hash-object", "-t", "tree", "/dev/null"]).trim();
    const [subject, author, date, ...bodyLines] = git(["log", "-1", "--format=%s%n%an%n%as%n%b", c]).split("\n");
    const body = bodyLines.filter((l) => !/^(Signed-off-by|Co-authored-by|Reviewed-by|Change-Id):/i.test(l)).join("\n").trim();
    return { diffArgs: [parent, c], base: parent, head: c, newSide: c, label: `commit ${c.slice(0, 7)} — ${subject}`, commit: { subject, body, author, date } };
  }
  if (a.mode === "branch") {
    const base = git(["merge-base", a.base, "HEAD"]).trim();
    return { diffArgs: [base], base, head, newSide: "worktree", label: `branch (merge-base of ${a.base})` };
  }
  // raw: best-effort interpretation of user-supplied git diff args
  const raw = a.raw;
  if (raw.includes("--staged") || raw.includes("--cached")) return { diffArgs: raw, base: head, head, newSide: "index", label: "raw " + raw.join(" ") };
  const rev = raw.find((x) => !x.startsWith("-"));
  if (!rev) return { diffArgs: raw, base: head, head, newSide: "worktree", label: "raw " + raw.join(" ") };
  if (rev.includes("...")) {
    const [l, r] = rev.split("...");
    const b = git(["merge-base", l, r || "HEAD"]).trim();
    return { diffArgs: raw, base: b, head, newSide: git(["rev-parse", r || "HEAD"]).trim(), label: "raw " + raw.join(" ") };
  }
  if (rev.includes("..")) {
    const [l, r] = rev.split("..");
    return { diffArgs: raw, base: git(["rev-parse", l]).trim(), head, newSide: git(["rev-parse", r || "HEAD"]).trim(), label: "raw " + raw.join(" ") };
  }
  return { diffArgs: raw, base: git(["rev-parse", rev]).trim(), head, newSide: "worktree", label: "raw " + raw.join(" ") };
}

// ---------------------------------------------------------------- diff parsing (§6.1)

function parseUnified(text: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>();
  let cur: string | null = null;
  let hunk: Hunk | null = null;
  let o = 0, n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = null; hunk = null; continue; }
    // git ends the path with a tab when it contains a space; the a/ b/ prefixes are forced on every diff call
    if (line.startsWith("--- ")) { if (line.startsWith("--- a/")) cur = line.slice(6).replace(/\t$/, ""); continue; }
    if (line.startsWith("+++ ")) { if (line.startsWith("+++ b/")) cur = line.slice(6).replace(/\t$/, ""); continue; }
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
      slots: {}, revise: null, notes: null,
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
  // renames: pair a deleted unit with a new unit of the same kind whose body is ≥75% the same
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
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "-U100000", a, b], { encoding: "utf8" });
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
  const targets: { u: Unit; lang: string }[] = [];
  // a language with no call syntax to search (bash, html, css, yaml, markdown) gets no Callers line at all
  for (const f of files) for (const u of f.units) if (f.lang && CALLER_LANGS[f.lang]?.length && CALLABLE_KINDS.has(u.kind) && u.status !== "new") targets.push({ u, lang: f.lang });
  // a constructor is called by its class name; `new` exists in Java/TS/JS only
  const ctorName = (u: Unit) => (u.name === "constructor" ? u.scope.split(".").pop() ?? u.name : u.name);
  const hasNew = (lang: string) => lang === "java" || lang === "typescript" || lang === "tsx" || lang === "javascript";
  findTypeReferences(files, rev);
  if (rev) {
    // historical commit: the working tree may be far ahead, so search the commit's tree by name with git grep
    const exts = Object.keys(LANG_BY_EXT);
    for (const { u } of targets) {
      // POSIX ERE (no \b): a name not preceded by an identifier character
      const lang = targets.find((t) => t.u === u)!.lang;
      const pat = u.kind === "constructor" ? (hasNew(lang) ? `new[[:space:]]+${ctorName(u)}[[:space:]]*\\(` : `(^|[^A-Za-z0-9_$.])${ctorName(u)}[[:space:]]*\\(`) : `(^|[^A-Za-z0-9_$])${u.name}[[:space:]]*\\(`;
      const out = gitOk(["grep", "-n", "-E", pat, rev, "--", SCOPE]) ?? "";
      const sites = new Set<string>();
      for (const line of out.split("\n")) {
        const m = line.match(/^[^:]+:([^:]+):(\d+):/);
        if (!m || !exts.includes(path.extname(m[1]).toLowerCase())) continue;
        const ln = +m[2];
        if (m[1] === u.path && u.newSpan && ln >= u.newSpan[0] && ln <= u.newSpan[1]) continue; // self
        sites.add(`${m[1]}:${ln}`);
      }
      const sorted = [...sites].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      u.callers = { total: sorted.length, sites: sorted.slice(0, CALLER_CAP) };
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
    const rules = list.map(({ u, rid }) => {
      const pats = u.kind === "constructor" ? (hasNew(L) ? [`new ${ctorName(u)}($$$)`] : [`${ctorName(u)}($$$)`]) : [`${u.name}($$$)`, `$OBJ.${u.name}($$$)`];
      return `id: ${rid}\nlanguage: ${L}\nrule:\n  any:\n${pats.map((p) => `    - pattern: ${JSON.stringify(p)}`).join("\n")}`;
    }).join("\n---\n");
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
  for (const { u } of targets) {
    const sites = [...(sitesById.get(u.id) ?? [])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    u.callers = { total: sites.length, sites: sites.slice(0, CALLER_CAP) };
  }
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

// ---------------------------------------------------------------- previous brief (§15)

// Sources of carry-over, in priority order: the brief on disk, then the last
// lint-clean brief of the same mode, then of other modes (archived by lint under
// .git/review-brief/last-<mode>.md). Switching wip↔branch therefore never
// loses prose: a unit is carried from whichever source has a matching hash.
function loadPrevious(outAbs: string, stateDir: string, mode: string, fresh: boolean): ParsedBrief[] {
  if (fresh) return [];
  const read = (c: string): ParsedBrief | null => {
    if (!fs.existsSync(c)) return null;
    const p = parseBrief(fs.readFileSync(c, "utf8"));
    return String(p.front["review-brief"]) === String(FORMAT_VERSION) ? p : null;
  };
  const onDisk = read(outAbs);
  const sameMode = read(path.join(stateDir, `last-${mode}.md`));
  const others = ["wip", "branch", "all", "commit", "raw"].filter((m) => m !== mode).map((m) => read(path.join(stateDir, `last-${m}.md`)));
  // the primary (first) source is the one the "since last" delta is measured
  // against: the brief on disk if it is the same mode, else the same-mode archive
  const ordered = onDisk && onDisk.front.mode !== mode ? [sameMode, onDisk, ...others] : [onDisk, sameMode, ...others];
  return ordered.filter((p): p is ParsedBrief => p !== null);
}

// ---------------------------------------------------------------- main

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  const { sg } = preflight(a);
  if (a.check) { process.stdout.write(`preflight ok (ast-grep, git, node ${process.versions.node})\n`); return; }

  const outAbs = path.resolve(ROOT, a.out);
  const outRel = path.relative(ROOT, outAbs);
  // --path narrows, --exclude removes; the brief itself is excluded when it lives inside the repo
  const excl = ["--", a.scope, ...(outRel.startsWith("..") ? [] : [`:(exclude)${outRel}`]), ...a.exclude.map((e) => `:(exclude)${e}`)];
  SCOPE = a.scope;
  const R = resolveRange(a);

  // changed files
  const files: FileEntry[] = [];
  for (const line of git(["diff", "-M", "--name-status", ...R.diffArgs, ...excl]).split("\n")) {
    const m = line.match(/^([AMDR])\d*\t([^\t]+)(?:\t(.+))?$/);
    if (!m) continue;
    const renamed = m[1] === "R";
    const p = renamed ? m[3] : m[2];
    files.push({ path: p, status: m[1] as any, renamedFrom: renamed ? m[2] : null, lang: langOf(p), binary: false, oldContent: null, newContent: null, hash: "", units: [], tags: [], hunksU0: [], hunksU3: [], hunksW: [], slots: {}, notes: null, commitsSinceLast: [], revise: null });
  }
  // untracked files: git diff never lists them, but an agent's new files are the change being reviewed.
  // Working-tree modes only (an index or commit has no untracked files); .gitignore is respected.
  const untracked = new Set<string>();
  if (R.newSide === "worktree" && a.untracked) {
    const known = new Set(files.map((f) => f.path));
    for (const p of git(["ls-files", "--others", "--exclude-standard", ...excl]).split("\n")) {
      if (!p || known.has(p) || p.endsWith("/")) continue; // a trailing slash is a nested repository, not a file
      untracked.add(p);
      files.push({ path: p, status: "A", renamedFrom: null, lang: langOf(p), binary: false, oldContent: null, newContent: null, hash: "", units: [], tags: [], hunksU0: [], hunksU3: [], hunksW: [], slots: {}, notes: null, commitsSinceLast: [], revise: null });
    }
  }
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)); // byte order, same as git

  // generated files (gitattributes `linguist-generated`, or a minified/lock-file name) get one
  // unit and no hunk: nobody reviews a bundle line by line
  if (files.length) for (const line of git(["check-attr", "linguist-generated", "--", ...files.map((f) => f.path)]).split("\n")) {
    const m = line.match(/^(.+): linguist-generated: (.+)$/);
    if (m && m[2] !== "unspecified" && m[2] !== "false") { const f = files.find((f) => f.path === m[1]); if (f) f.tags.push("generated"); }
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
  const stateDir = path.join(ROOT, ".git", STATE_DIR);
  const sources = loadPrevious(outAbs, stateDir, a.mode, a.fresh);
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
  const cacheFile = path.join(stateDir, "cache.json");
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
  if (dirty && R.newSide === "worktree") { const s = git(["stash", "create"], { ok: true }).trim(); if (s) snapshot = s; }
  git(["update-ref", "refs/review-brief/previous", snapshot]);

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
  L.push("---", `review-brief: ${FORMAT_VERSION}`, `mode: ${a.mode}`, `base: ${R.base}`, `head: ${R.head}`, `snapshot: ${snapshot}`, `worktree: ${dirty ? "dirty" : "clean"}`, `generated: ${new Date().toISOString()}`, "previous:", `  head: ${prevHead ?? "null"}`, `  snapshot: ${prevSnap ?? "null"}`, "---", "");
  L.push(`# Review Brief — ${R.label}`, "");
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
  L.push(q(`**Style:** concise and plain. Declarative sentences; no preamble, hedging, or filler; never restate the heading ("This function…"). Word budgets are ceilings, not targets — most slots need one sentence.`), q(""), q("</details>"), "");
  L.push(`**Overview:** ${overviewLocked ?? "<<rb:overview | fill LAST, after every file section below is complete. one lead sentence on what the whole change set accomplishes, then, when it has more than one distinct part, a `- ` bullet per part naming the files that carry it (no blank line between lead and bullets); a single-part change set is 3–8 sentences instead, naming the files or groups of files that carry each piece.>>"}`, "");
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
    L.push(`${labelOf("purpose")} ${f.slots.purpose?.text ?? `<<rb:purpose ${f.path} | 1–2 sentences: what this file is responsible for, as it now stands${f.status === "D" ? " (past tense: it was deleted)" : f.status === "A" ? " — the file is new; say what it is for and who is expected to use it" : ""}>>`}`, "");
    // an added file has no "before": Purpose only (its units are all new and get Purpose: only)
    if (f.status !== "A") L.push(`**Changes:** ${f.slots.changes?.text ?? `<<rb:changes ${f.path} | 2–5 sentences or bullets: what the changes in this file are meant to accomplish. Must name every unit below${unitNames.length ? ": " + unitNames.join(", ") : ""}>>`}`, "");
    if (f.slots.review?.text !== "") { const slot = f.slots.review?.text, id = f.path; L.push(`**Review Observations:** ${slot ?? `<<rb:review ${id} | optional, ≤60 words: what a careful reader should check — unreachable or redundant code, unused leftovers, a missing case, behaviour the text above does not explain. Concrete and checkable only. Delete this whole line if there is nothing to say.>>`}`, ""); }
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
        const otherText = u.slots.other?.text ?? (u.kind === "file" && u.status === "new" ? "new file" : `<<rb:other ${u.id} | one line, ≤25 words: what changed here>>`);
        L.push(`- ${loc} ${label}${u.badge ? ` · ${u.badge}` : ""} — ${otherText}`);
        if (u.revise) L.push(`<!-- rb:revise ${u.id}`, u.revise, "-->");
        L.push(...fence(u.hunk), "");
        slotIndex.push({ scope: "unit", id: u.id, kind: u.kind, slots: u.slots, notes: u.notes });
      }
    }
    for (const u of f.units) {
      if (u.kind === "other" || u.kind === "file") continue;
      const loc = u.status === "deleted" ? `was \`${f.path}:${u.oldSpan![0]}-${u.oldSpan![1]}\`` : link(`${f.path}:${u.newSpan![0]}-${u.newSpan![1]}`, f.path, u.newSpan![0]);
      const tagStr = (u.renamedFrom ? ` · renamed from \`${u.renamedFrom}\`` : "") + u.tags.filter((t) => t !== "container-only").map((t) => ` · ${t}`).join("") + (u.tags.includes("container-only") ? " · container only (members listed separately)" : "");
      const kindLabel = u.kind === "const" ? (u.signature.match(/^(let|var)\b/)?.[1] ?? "const") : u.kind;
      const tick = "`".repeat(Math.max(1, ...[...u.display.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      const h = `### ${tick}${u.display}${tick} — ${u.status}${u.kind !== "function" && u.kind !== "method" ? ` ${kindLabel}` : ""} · ${loc}${tagStr}${u.badge ? ` · ${u.badge}` : ""}`;
      const marker = `<!-- rb:unit id="${u.id}" kind="${u.kind}" status="${u.status}" hash="${u.hash}" -->`;
      L.push(h, marker, "");
      expected.push(h, marker);
      if (u.callers) L.push(`**${CALLABLE_KINDS.has(u.kind) ? "Callers" : "References"} (by name):** ${u.callers.total ? u.callers.sites.map(siteLink).join(", ") + ` (${u.callers.total}${u.callers.total > CALLER_CAP ? ", first " + CALLER_CAP + " shown" : ""})` : "none found"}`, "");
      const short = SHORT_KINDS.has(u.kind);
      const doesBudget = short ? BUDGETS.short : BUDGETS.does;
      if (u.status === "deleted") {
        L.push(`${labelOf("did", u.kind)} ${u.slots.did?.text ?? `<<rb:did ${u.id} | ≤${BUDGETS.did} words, past tense: what this ${u.kind} used to do; if you can see what replaced it, name the replacement>>`}`, "");
      } else {
        L.push(`${labelOf("does", u.kind)} ${u.slots.does?.text ?? `<<rb:does ${u.id} | ≤${doesBudget} words, present tense: what this ${u.kind} does now${u.callers ? "; may cite the callers line above" : ""}>>`}`, "");
        if (u.status === "modified") {
          const sigNote = u.renamedFrom ? ` Renamed from \`${u.renamedFrom}\` — say so, then describe any other difference.` : u.oldSignature !== null && u.oldSignature !== u.signature ? ` The signature changed — name it: was \`${u.oldSignature}\`.` : "";
          const ws = u.tags.includes("whitespace-only") ? ' If the change is formatting only, write exactly: "formatting only".' : "";
          L.push(`${labelOf("change")} ${u.slots.change?.text ?? `<<rb:change ${u.id} | ≤${BUDGETS.change} words: what it now does that it did not, or no longer does — stated first, checkable against the hunk below.${sigNote} A trailing clause on what the change is meant to accomplish is allowed after the description, never instead of it.${ws}>>`}`, "");
        }
      }
      if (u.slots.review?.text !== "") { const slot = u.slots.review?.text, id = u.id; L.push(`**Review Observations:** ${slot ?? `<<rb:review ${id} | optional, ≤60 words: what a careful reader should check — unreachable or redundant code, unused leftovers, a missing case, behaviour the text above does not explain. Concrete and checkable only. Delete this whole line if there is nothing to say.>>`}`, ""); }
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
  const text = L.map((l) => {
    const fm = l.match(/^(`{3,})/);
    if (fenceLen === 0 && fm) { fenceLen = fm[1].length; return l; }
    if (fenceLen > 0) { if (fm && fm[1].length >= fenceLen && l.trim() === fm[1]) fenceLen = 0; return l; }
    return l.replace(/<<rb:([^|\n]*)\| ([^\n]*?)>>/g, (_m, id, instr) => `<<rb:${id}| ${instr.replace(/>/g, "›")}>>`);
  }).join("\n");
  // state for lint (§14): lives under .git so it is never in the diff
  fs.mkdirSync(stateDir, { recursive: true });
  if (fs.existsSync(outAbs)) fs.copyFileSync(outAbs, path.join(stateDir, "previous.md")); // whatever is overwritten stays recoverable
  else if (fs.existsSync(path.join(stateDir, "previous.md"))) fs.rmSync(path.join(stateDir, "previous.md"));
  fs.writeFileSync(path.join(stateDir, "units.json"), JSON.stringify({
    out: outRel, mode: a.mode, generated: new Date().toISOString(), expected, overviewLocked, slotIndex,
    units: files.flatMap((f) => f.units.map((u) => ({ id: u.id, path: u.path, kind: u.kind, name: u.name, status: u.status, oldSpan: u.oldSpan, newSpan: u.newSpan, hash: u.hash, tags: u.tags, callers: u.callers, badge: u.badge }))),
  }, null, 2));
  fs.writeFileSync(path.join(stateDir, "skeleton.md"), text);
  fs.writeFileSync(outAbs, text);

  // .git/info/exclude offer (§9a): add automatically, it is local-only
  const exclFile = path.join(ROOT, ".git", "info", "exclude");
  const exclText = fs.existsSync(exclFile) ? fs.readFileSync(exclFile, "utf8") : "";
  if (!outRel.startsWith("..") && !exclText.split("\n").includes(outRel)) fs.appendFileSync(exclFile, (exclText.endsWith("\n") || exclText === "" ? "" : "\n") + outRel + "\n");

  if (a.section) {
    const heads = [`## \`${a.section}\``, `## [\`${a.section}\`](${a.section})`];
    const start = L.findIndex((l) => heads.some((h) => l === h || l.startsWith(h + " —")));
    if (start < 0) die(`no section for ${a.section}`);
    let end = L.indexOf("---", start); if (end < 0) end = L.length;
    process.stdout.write(L.slice(start, end).join("\n") + "\n");
    return;
  }
  if (a.open) { // hand the brief to the vendored editor (scripts/viewer.ts); it outlives this process
    const child = spawn(process.execPath, [path.join(SKILL_DIR, "scripts", "viewer.ts"), "--out", outRel], { cwd: ROOT, stdio: "ignore", detached: true });
    child.unref();
  }
  const emptySlots = parseBrief(text).tokens.length; // fence-aware: hunks may contain literal "<<rb:"
  process.stdout.write(`wrote ${outRel.startsWith("..") ? outAbs : outRel}: ${files.length} files${untracked.size ? ` (${untracked.size} untracked)` : ""}, ${nUnits.new + nUnits.modified + nUnits.deleted + nUnits.other} units, ${emptySlots} slots to fill${carried ? ` (${carried} units carried over)` : ""}\n`);
}

main();
