#!/usr/bin/env node
// lint.ts — verifies REVIEW_BRIEF.md against the skeleton extract wrote
// (spec §5, §15.6, §16.3). Prints one action line per problem and exits 1;
// on a clean brief strips the rb:revise notes in place and exits 0.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FORMAT_VERSION, BUDGETS, SHORT_KINDS, parseBrief, isToken, wordCount, stripReviseNotes, labelOf } from "./brief-format.ts";

const STALE_PREFIX = "*(code changed since this note)*";
// Concise-style check (spec §10): phrases that restate the heading or pad the sentence.
const FILLER = [/^(this|the) (function|method|class|interface|file|module|arrow|constructor|field|change|unit)\b/i, /\b(in order to|it is worth noting|note that|essentially|basically|simply|as mentioned|as you can see|please note)\b/i, /\b(is responsible for|serves to|is used to|is designed to|the purpose of)\b/i];
function styleProblem(v: string): string | null {
  for (const re of FILLER) { const m = v.match(re); if (m) return `"${m[0]}"`; }
  return null;
}

function main(): void {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const stateFile = path.join(root, ".git", "review-brief", "units.json");
  if (!fs.existsSync(stateFile)) { process.stderr.write("no extract state found — run extract.ts first\n"); process.exit(1); }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const outAbs = path.resolve(root, process.argv[2] ?? state.out);
  if (!fs.existsSync(outAbs)) { process.stderr.write(`${state.out} not found — run extract.ts first\n`); process.exit(1); }
  const text = fs.readFileSync(outAbs, "utf8");
  const brief = parseBrief(text);
  const problems: string[] = [];
  const P = (kind: string, where: string, msg: string) => problems.push(`${kind.padEnd(9)} ${where}  — ${msg}`);

  // front matter
  if (String(brief.front["review-brief"]) !== String(FORMAT_VERSION)) P("STRUCTURE", "front matter", "missing or altered — restore the block extract wrote (re-run extract if lost)");

  // structure: headings + markers must match exactly, in order
  const exp: string[] = state.expected, got = brief.structure;
  const gotSet = new Set(got), expSet = new Set(exp);
  for (const e of exp) if (!gotSet.has(e)) P("STRUCTURE", e.length > 90 ? e.slice(0, 87) + "..." : e, "heading or marker missing — restore it exactly as extract wrote it");
  for (const g of got) if (!expSet.has(g)) P("STRUCTURE", g.length > 90 ? g.slice(0, 87) + "..." : g, "heading or marker not in the skeleton — remove it (only extract writes headings)");
  if (problems.length === 0 && exp.join("\n") !== got.join("\n")) P("STRUCTURE", "section order", "headings are out of order — restore the skeleton order");

  // empty slots
  for (const t of brief.tokens) P("EMPTY", `${t.token} (line ${t.line})`, "write it");

  // overview
  if (brief.overview === null) P("EMPTY", "**Overview:**", "the Overview line is missing — restore `**Overview:** …` under the summary block");
  else if (!isToken(brief.overview)) {
    if (state.overviewLocked && brief.overview !== state.overviewLocked) P("LOCKED", "**Overview:**", "differs from the previous brief although nothing changed — restore the previous text");
    if (wordCount(brief.overview) > BUDGETS.overview) P("BUDGET", "**Overview:**", `${wordCount(brief.overview)} words > ${BUDGETS.overview} — shorten`);
    if (!state.overviewLocked) { const st = styleProblem(brief.overview); if (st) P("STYLE", "**Overview:**", `${st} is filler — cut it`); }
  }

  const files = new Map(brief.files.map((f) => [f.path, f]));
  const units = new Map(brief.files.flatMap((f) => f.units.map((u) => [u.id, u] as const)));

  for (const s of state.slotIndex) {
    if (s.scope === "file") {
      const f = files.get(s.path);
      if (!f) continue; // structure error already reported
      const fileSlots: [string, number][] = s.status === "A" ? [["purpose", BUDGETS.purpose]] : [["purpose", BUDGETS.purpose], ["changes", BUDGETS.changes]];
      for (const [key, budget] of fileSlots) {
        const v = f.slots[key];
        if (v === undefined) { P("EMPTY", `${labelOf(key)} ${s.path}`, "label line is missing — restore it and write the text"); continue; }
        if (isToken(v)) continue;
        if (s.slots[key]?.locked && v !== s.slots[key].text) P("LOCKED", `**${key[0].toUpperCase() + key.slice(1)}:** ${s.path}`, "carried-over text was changed — restore the previous text");
        if (wordCount(v) > budget) P("BUDGET", `**${key[0].toUpperCase() + key.slice(1)}:** ${s.path}`, `${wordCount(v)} words > ${budget} — shorten`);
        if (!s.slots[key]?.locked) { const st = styleProblem(v); if (st) P("STYLE", `**${key[0].toUpperCase() + key.slice(1)}:** ${s.path}`, `${st} is filler or restates the heading — cut it`); }
      }
      const ch = f.slots.changes;
      if (ch && !isToken(ch)) for (const n of s.unitNames) if (!ch.includes(n)) P("MISSING", `**Changes:** ${s.path}`, `does not name unit \`${n}\` — mention it`);
      checkReview(f.slots.review, s.slots.review, `**Review Observations:** ${s.path}`);
      if (s.notes && f.slots.notes !== s.notes) P("NOTES", `**Notes:** ${s.path}`, "reviewer notes were altered — restore them exactly");
      continue;
    }
    const u = units.get(s.id);
    if (!u) continue;
    const want: [string, number][] = s.kind === "other" || s.kind === "file" ? [["other", BUDGETS.other]]
      : s.status === "deleted" ? [["did", BUDGETS.did]]
      : s.status === "new" ? [["does", SHORT_KINDS.has(s.kind) ? BUDGETS.short : BUDGETS.does]]
      : [["does", SHORT_KINDS.has(s.kind) ? BUDGETS.short : BUDGETS.does], ["change", BUDGETS.change]];
    for (const [key, budget] of want) {
      const v = u.slots[key];
      const label = key === "other" ? `- … ${s.id}` : `${labelOf(key === "does" && s.status === "deleted" ? "did" : key)} ${s.id}`;
      if (v === undefined || v === "") { P("EMPTY", label, key === "other" ? "text after the ` — ` is missing — write it" : "label line is missing — restore it and write the text"); continue; }
      if (isToken(v)) continue;
      if (s.slots[key]?.locked && v !== s.slots[key].text) P("LOCKED", label, "carried-over text was changed — restore the previous text");
      if (wordCount(v) > budget && !(key === "change" && v.trim() === "formatting only")) P("BUDGET", label, `${wordCount(v)} words > ${budget} — shorten`);
      if (!s.slots[key]?.locked) { const st = styleProblem(v); if (st) P("STYLE", label, `${st} is filler or restates the heading — cut it`); }
    }
    checkReview(u.slots.review, s.slots.review, `**Review Observations:** ${s.id}`);
    if (s.notes) {
      const ok = u.slots.notes === s.notes || (s.notes.startsWith(STALE_PREFIX) && u.slots.notes === s.notes.slice(STALE_PREFIX.length).trim());
      if (!ok) P("NOTES", `**Notes:** ${s.id}`, "reviewer notes were altered — restore them exactly");
    }
  }

  // Review Observations is optional: the line may be deleted; if present it must be prose within budget
  function checkReview(v: string | undefined, locked: { locked: boolean; text: string } | undefined, label: string) {
    if (v === undefined) { if (locked?.locked && locked.text) P("LOCKED", label, "carried-over observations were removed — restore them"); return; }
    if (v === "" ) { P("EMPTY", label, "either write an observation or delete the whole line"); return; }
    if (isToken(v)) return; // reported as EMPTY by the token scan
    if (locked?.locked && locked.text && v !== locked.text) P("LOCKED", label, "carried-over text was changed — restore the previous text");
    if (wordCount(v) > BUDGETS.review) P("BUDGET", label, `${wordCount(v)} words > ${BUDGETS.review} — shorten`);
    if (!locked?.text) { const st = styleProblem(v); if (st) P("STYLE", label, `${st} is filler — cut it`); }
  }

  if (problems.length) {
    process.stdout.write(problems.join("\n") + `\n\n${problems.length} problem${problems.length === 1 ? "" : "s"}. Fix each line above, then run lint again.\n`);
    process.exit(1);
  }
  const cleaned = stripReviseNotes(text).replace(/\n{3,}/g, "\n\n");
  if (cleaned !== text) fs.writeFileSync(outAbs, cleaned);
  // archive the clean brief per mode, and every (id@hash) → prose in a cache,
  // so switching modes or reverting code never loses prose
  const stateDir = path.join(root, ".git", "review-brief");
  fs.writeFileSync(path.join(stateDir, `last-${brief.front.mode ?? state.mode}.md`), cleaned);
  const cacheFile = path.join(stateDir, "cache.json");
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
