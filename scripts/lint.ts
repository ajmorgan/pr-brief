#!/usr/bin/env node
// lint.ts — verifies a brief against the skeleton extract wrote
// (spec §5, §15.6, §16.3). Prints one action line per problem and exits 1;
// on a clean brief strips the rb:revise notes in place and exits 0.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { FORMAT_VERSION, parseBrief, isToken, stripReviseNotes, labelOf, listOnNextLine } from "./brief-format.ts";

const STALE_PREFIX = "*(code changed since this note)*";
// Concise-style check (spec §10): phrases that restate the heading or pad the sentence.
const FILLER = [/^(this|the) (function|method|class|interface|file|module|arrow|constructor|field|change|unit)\b/i, /\b(in order to|it is worth noting|note that|essentially|basically|simply|as mentioned|as you can see|please note)\b/i, /\b(is responsible for|serves to|is used to|is designed to|the purpose of)\b/i];
function styleProblem(v: string): string | null {
  for (const re of FILLER) { const m = v.match(re); if (m) return `"${m[0]}"`; }
  return null;
}

function main(): void {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  // state lives under the repository's common git directory (.git, or .bare beside worktrees), one directory per brief key
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  const stateRoot = path.join(common.status === 0 ? common.stdout.trim() : path.resolve(root, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim()), "pr-brief");
  const unitsOf = (dir: string): any | null => { try { return JSON.parse(fs.readFileSync(path.join(dir, "units.json"), "utf8")); } catch { return null; } };
  // which brief: the path or key given, else the one extract wrote last
  const arg = process.argv[2];
  let stateDir: string | null = null;
  if (arg && unitsOf(path.join(stateRoot, arg))) stateDir = path.join(stateRoot, arg);
  else if (arg) {
    const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }; // /var vs /private/var: one file, two spellings
    const want = new Set([real(arg), real(path.resolve(root, arg))]);
    const dirs = fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(stateRoot, e.name)) : [];
    stateDir = dirs.find((d) => { const o = unitsOf(d)?.out; return typeof o === "string" && want.has(real(o)); }) ?? null;
    if (!stateDir) { process.stderr.write(`no extract state for ${arg} — run extract.ts first\n`); process.exit(1); }
  } else {
    const last = fs.existsSync(path.join(stateRoot, "last")) ? fs.readFileSync(path.join(stateRoot, "last"), "utf8").trim() : "";
    if (last && unitsOf(path.join(stateRoot, last))) stateDir = path.join(stateRoot, last);
  }
  if (!stateDir) { process.stderr.write("no extract state found — run extract.ts first\n"); process.exit(1); }
  const state = unitsOf(stateDir);
  const outAbs = path.resolve(root, state.out);
  if (!fs.existsSync(outAbs)) { process.stderr.write(`${outAbs} not found — run extract.ts first\n`); process.exit(1); }
  const text = fs.readFileSync(outAbs, "utf8");
  const brief = parseBrief(text);
  const problems: string[] = [];
  const P = (kind: string, where: string, msg: string) => problems.push(`${kind.padEnd(9)} ${where}  — ${msg}`);

  // front matter
  if (String(brief.front["pr-brief"] ?? brief.front["review-brief"]) !== String(FORMAT_VERSION)) P("STRUCTURE", "front matter", "missing or altered — restore the block extract wrote (re-run extract if lost)");

  // structure: headings + markers must match exactly, in order
  const exp: string[] = state.expected, got = brief.structure;
  const gotSet = new Set(got), expSet = new Set(exp);
  for (const e of exp) if (!gotSet.has(e)) P("STRUCTURE", e.length > 90 ? e.slice(0, 87) + "..." : e, "heading or marker missing — restore it exactly as extract wrote it");
  for (const g of got) if (!expSet.has(g)) P("STRUCTURE", g.length > 90 ? g.slice(0, 87) + "..." : g, "heading or marker not in the skeleton — remove it (only extract writes headings)");
  if (problems.length === 0 && exp.join("\n") !== got.join("\n")) P("STRUCTURE", "section order", "headings are out of order — restore the skeleton order");

  // empty slots
  for (const t of brief.tokens) P("EMPTY", `${t.token} (line ${t.line})`, "write it");

  // a list under the Overview after a blank line is outside the slot: the parser ignores it and the
  // next regeneration drops it. Catch it here rather than lose the bullets silently.
  {
    const lines = text.split("\n");
    let i = lines.findIndex((l) => l.startsWith("**Overview:**"));
    if (i >= 0) {
      while (i < lines.length && lines[i].trim() !== "") i++; // the slot: label line through the last non-blank line
      let j = i;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && /^\s*- /.test(lines[j]) && !lines[j].startsWith("---"))
        P("STRUCTURE", `**Overview:** (line ${j + 1})`, "a bullet list follows the Overview after a blank line, outside the slot — delete the blank line so the bullets sit directly under the lead sentence");
    }
  }

  // overview
  if (brief.overview === null) P("EMPTY", "**Overview:**", "the Overview line is missing — restore `**Overview:** …` under the summary block");
  else if (!isToken(brief.overview)) {
    if (state.overviewLocked && brief.overview !== state.overviewLocked) P("LOCKED", "**Overview:**", "differs from the previous brief although nothing changed — restore the previous text");
    if (!state.overviewLocked) { const st = styleProblem(brief.overview); if (st) P("STYLE", "**Overview:**", `${st} is filler — cut it`); }
  }

  const files = new Map(brief.files.map((f) => [f.path, f]));
  const units = new Map(brief.files.flatMap((f) => f.units.map((u) => [u.id, u] as const)));

  for (const s of state.slotIndex) {
    if (s.scope === "file") {
      const f = files.get(s.path);
      if (!f) continue; // structure error already reported
      const fileSlots = s.status === "A" ? ["purpose"] : ["purpose", "changes"];
      for (const key of fileSlots) {
        const v = f.slots[key];
        if (v === undefined) { P("EMPTY", `${labelOf(key)} ${s.path}`, "label line is missing — restore it and write the text"); continue; }
        if (isToken(v)) continue;
        // carried-over text is locked as it was: the style rule does not apply to it, or the agent could be
        // told both to change it and to restore it
        if (s.slots[key]?.locked && v !== s.slots[key].text) P("LOCKED", `${labelOf(key)} ${s.path}`, "carried-over text was changed — restore the previous text");
        if (!s.slots[key]?.locked) { const st = styleProblem(v); if (st) P("STYLE", `${labelOf(key)} ${s.path}`, `${st} is filler or restates the heading — cut it`); }
      }
      const ch = f.slots.changes;
      if (ch && !isToken(ch)) for (const n of s.unitNames) if (!ch.includes(n)) P("MISSING", `**Changes:** ${s.path}`, `does not name unit \`${n}\` — mention it`);
      checkReview(f.slots.review, s.slots.review, `**Review Observations:** ${s.path}`);
      if (s.notes && f.slots.notes !== s.notes) P("NOTES", `**Notes:** ${s.path}`, "reviewer notes were altered — restore them exactly");
      continue;
    }
    const u = units.get(s.id);
    if (!u) continue;
    const want = s.kind === "other" || s.kind === "file" ? ["other"] : s.status === "deleted" ? ["did"] : s.status === "new" ? ["does"] : ["does", "change"];
    for (const key of want) {
      const v = u.slots[key];
      const label = key === "other" ? `- … ${s.id}` : `${labelOf(key === "does" && s.status === "deleted" ? "did" : key, s.kind)} ${s.id}`;
      if (v === undefined || v === "") { P("EMPTY", label, key === "other" ? "text after the ` — ` is missing — write it" : "label line is missing — restore it and write the text"); continue; }
      if (isToken(v)) continue;
      if (s.slots[key]?.locked && v !== s.slots[key].text) P("LOCKED", label, "carried-over text was changed — restore the previous text");
      if (!s.slots[key]?.locked) { const st = styleProblem(v); if (st) P("STYLE", label, `${st} is filler or restates the heading — cut it`); }
    }
    checkReview(u.slots.review, s.slots.review, `**Review Observations:** ${s.id}`);
    if (s.notes) {
      const ok = u.slots.notes === s.notes || (s.notes.startsWith(STALE_PREFIX) && u.slots.notes === s.notes.slice(STALE_PREFIX.length).trim());
      if (!ok) P("NOTES", `**Notes:** ${s.id}`, "reviewer notes were altered — restore them exactly");
    }
  }

  // Review Observations is optional: the line may be deleted; if present it must be prose
  function checkReview(v: string | undefined, locked: { locked: boolean; text: string } | undefined, label: string) {
    if (v === undefined) { if (locked?.locked && locked.text) P("LOCKED", label, "carried-over observations were removed — restore them"); return; }
    if (v === "" ) { P("EMPTY", label, "either write an observation or delete the whole line"); return; }
    if (isToken(v)) return; // reported as EMPTY by the token scan
    if (/^\W*(none|n\/a|nothing( to (note|report|observe|say))?|no (observations?|issues?|concerns?|notes?)|nil)\b\W*$/i.test(v)) { P("EMPTY", label, "'none' is not an observation — delete the whole line"); return; }
    if (locked?.locked && locked.text && v !== locked.text) P("LOCKED", label, "carried-over text was changed — restore the previous text");
    if (!locked?.text) { const st = styleProblem(v); if (st) P("STYLE", label, `${st} is filler — cut it`); }
  }

  if (problems.length) {
    process.stdout.write(problems.join("\n") + `\n\n${problems.length} problem${problems.length === 1 ? "" : "s"}. Fix each line above, then run lint again.\n`);
    process.exit(1);
  }
  const cleaned = listOnNextLine(stripReviseNotes(text)).replace(/\n{3,}/g, "\n\n"); // a list value goes on the line after its label
  if (cleaned !== text) fs.writeFileSync(outAbs, cleaned);
  // archive the clean brief beside its state, and every (id@hash) → prose in the repository-wide cache,
  // so switching modes, briefing under another key, or reverting code never loses prose
  fs.writeFileSync(path.join(stateDir, "last.md"), cleaned);
  const cacheFile = path.join(stateRoot, "cache.json");
  const cache: Record<string, any> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  const keep = (slots: Record<string, string>) => Object.fromEntries(Object.entries(slots).filter(([k, v]) => k !== "notes" && v && !isToken(v)));
  // a commit is immutable: its overview and per-file Changes/Observations are keyed by the commit,
  // so briefing it again later costs nothing
  const commitKey = brief.front.mode === "commit" && brief.front.head ? String(brief.front.head) : null;
  if (commitKey && brief.overview && !isToken(brief.overview)) cache[`overview@commit@${commitKey}`] = { slots: { overview: brief.overview } };
  for (const f of brief.files) {
    if (f.slots.purpose && !isToken(f.slots.purpose)) cache[`${f.path}@${f.hash}`] = { slots: { purpose: f.slots.purpose } };
    if (commitKey) { const s = keep(f.slots); delete s.purpose; cache[`${f.path}@commit@${commitKey}`] = { slots: s }; }
    for (const u of f.units) { const s = keep(u.slots); if (Object.keys(s).length) cache[`${u.id}@${u.hash}`] = { slots: s }; }
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  process.stdout.write(`lint clean: ${brief.files.length} files, ${units.size} units. ${path.relative(root, outAbs)} is final.\n`);
}

main();
