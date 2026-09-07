#!/usr/bin/env node
// e2e.mjs — end-to-end browser test of the viewer (spec §18), the counterpart of selftest.sh:
// selftest.sh proves the extractor and lint; this proves the reviewer's surface.
//
//   node scripts/e2e.mjs [--headed] [--keep] [--port N (default 8791)]
//
// It builds a throwaway fixture repository, writes and fills a brief for each of two commits,
// serves them, and drives Google Chrome through what a reviewer does: the outline, unit motions,
// the ex commands, the three views, folds, scroll-spy, file links at each brief's own commit,
// switching briefs, the palette, notes and saving, copy-as-PR-comment, closing, and the server's
// contract. Exit 0 when every check passes, 1 otherwise.
//
// Playwright and Chrome are optional: without them this prints why and exits 0, so it can sit in
// a pipeline that only sometimes has a browser. Nothing here touches the user's repositories, and
// the port is its own, so a viewer already running on 8790 is left alone.

import { createRequire } from "node:module";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SKILL = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const headed = args.includes("--headed");
const keep = args.includes("--keep"); // leave the fixture on disk for inspection
const PORT = Number(args[args.indexOf("--port") + 1]) || 8791;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- optional dependencies

function loadPlaywright() {
  const dirs = [
    path.join(SKILL, "node_modules/playwright"),
    path.join(SKILL, "viewer/node_modules/playwright"),
    "/opt/homebrew/lib/node_modules/playwright",
    "/usr/local/lib/node_modules/playwright",
    "/usr/lib/node_modules/playwright",
  ];
  const npx = path.join(os.homedir(), ".npm/_npx"); // where `npx playwright` leaves it
  if (fs.existsSync(npx)) for (const d of fs.readdirSync(npx)) dirs.push(path.join(npx, d, "node_modules/playwright"));
  for (const d of dirs) {
    if (!fs.existsSync(path.join(d, "package.json"))) continue;
    try { return createRequire(path.join(d, "package.json"))(d); } catch { /* a broken copy: try the next */ }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) {
  process.stdout.write("e2e skipped: Playwright is not installed (npm i -D playwright, or npx playwright install chrome)\n");
  process.exit(0);
}

// ---------------------------------------------------------------- the fixture repository

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-e2e-"));
const FX = path.join(tmp, "fixture");
fs.mkdirSync(path.join(FX, "src"), { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: FX, encoding: "utf8" });
const node = (...a) => execFileSync(process.execPath, a, { cwd: FX, encoding: "utf8", maxBuffer: 1 << 26 });
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(FX, rel)), { recursive: true }); fs.writeFileSync(path.join(FX, rel), text); };

// A class with enough methods that the brief is longer than the viewport (the scroll-spy check
// needs something to scroll) and a second file so the outline has more than one card.
const svc = (n, body) => `    public int step${n}(Order o) {
        ${body}
    }
`;
const svcJava = (bodies) => `package orders;

import java.util.List;

public class Svc {
    private final Repo repo;

    public Svc(Repo repo) {
        this.repo = repo;
    }

${bodies.map((b, i) => svc(i + 1, b)).join("\n")}}
`;
const base = Array.from({ length: 14 }, (_, i) => `return repo.count() + ${i};`);
write("src/Svc.java", svcJava(base));
write("src/parse.ts", `import { readFileSync } from "fs";

export const DEFAULT_PATH = "config/app.yaml";

export function parseConfig(path: string): Config {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export const normalize = (c: Config): Config => ({ ...c, name: c.name.trim() });

export class Loader {
  load(p: string): Config {
    return normalize(parseConfig(p));
  }
}

export interface Config {
  name: string;
}
`);
write("config/app.yaml", "name: demo\nlevel: 1\n");
git("init", "-q", "-b", "main");
git("config", "user.email", "e2e@test");
git("config", "user.name", "e2e");
git("add", "-A");
git("commit", "-qm", "base");

// commit one: four methods change and the loader gains a method
const one = base.slice();
for (const i of [1, 4, 7, 11]) one[i] = `repo.touch(o); return repo.count() - ${i};`;
write("src/Svc.java", svcJava(one));
write("src/parse.ts", fs.readFileSync(path.join(FX, "src/parse.ts"), "utf8").replace("  load(p: string): Config {", "  size(): number {\n    return 0;\n  }\n\n  load(p: string): Config {"));
git("add", "-A");
git("commit", "-qm", "adjust steps and add Loader.size");
const shaOne = git("rev-parse", "--short=7", "HEAD").trim();

// commit two: eight other methods change, so the same file reads differently at each commit and
// the brief is long enough that the preview genuinely scrolls
const two = one.slice();
for (const i of [0, 2, 3, 5, 6, 8, 9, 12]) two[i] = `repo.mark(o); return repo.count() % ${i + 3};`;
write("src/Svc.java", svcJava(two));
write("config/app.yaml", "name: demo\nlevel: 2\n");
git("add", "-A");
git("commit", "-qm", "raise level and adjust eight more steps");
const shaTwo = git("rev-parse", "--short=7", "HEAD").trim();

// Write, fill and lint a brief per commit, in turn, as the skill would. A commit brief is keyed by its short
// SHA and lives with its own state under .git/pr-brief/<sha>/.
const briefPath = (sha) => path.join(FX, `.git/pr-brief/${sha}/pr-brief-${sha}.md`);
function makeBrief(sha) {
  node(path.join(SKILL, "scripts/extract.ts"), "commit", sha);
  const p = briefPath(sha);
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(/<<rb:changes [^|]*\| [^\n]*?Must name every unit below: ([^\n]*?)>>/g, (_m, names) => "Touches " + names.split(", ").map((n) => "`" + n + "`").join(", ") + ".");
  t = t.replace(/<<rb:[^\n]*?>>/g, "placeholder text.");
  fs.writeFileSync(p, t);
  node(path.join(SKILL, "scripts/lint.ts"), p);
  return p;
}
makeBrief(shaOne);
makeBrief(shaTwo);

// what the UI should show, read back from the briefs themselves rather than hard-coded
function shapeOf(sha) {
  const t = fs.readFileSync(briefPath(sha), "utf8");
  const units = [...t.matchAll(/^<!-- rb:unit id="([^"]+)" kind="(\w+)"/gm)].map((m) => ({ id: m[1], kind: m[2] }));
  return {
    files: (t.match(/^<!-- rb:file /gm) ?? []).length,
    units: units.length,
    named: units.find((u) => u.kind !== "other" && u.kind !== "file")?.id.split("#")[1] ?? "",
  };
}
const shape = { [shaOne]: shapeOf(shaOne), [shaTwo]: shapeOf(shaTwo) };
const slug = (sha) => sha; // a stored brief is served under its key

// ---------------------------------------------------------------- the viewer

spawnSync(process.execPath, [path.join(SKILL, "scripts/viewer.ts"), "--stop", "--port", String(PORT)], { encoding: "utf8" });
const server = spawn(process.execPath, [path.join(SKILL, "scripts/viewer.ts"), "--out", briefPath(shaTwo), "--port", String(PORT), "--no-open"], { cwd: FX, stdio: "ignore", detached: true });
server.unref();
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { const r = await fetch(`${BASE}/briefs`); up = r.ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
}
function cleanup() {
  spawnSync(process.execPath, [path.join(SKILL, "scripts/viewer.ts"), "--stop", "--port", String(PORT)], { encoding: "utf8" });
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  else process.stdout.write(`fixture kept at ${FX}\n`);
}
if (!up) { cleanup(); process.stderr.write(`e2e: the viewer did not come up on ${BASE}\n`); process.exit(1); }

// ---------------------------------------------------------------- checks

const results = [];
const consoleErrors = [];
const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { const d = await fn(); results.push([true, name]); process.stdout.write(`PASS  ${name}${d ? "  — " + d : ""}\n`); }
  catch (e) { results.push([false, name, String(e.message || e)]); process.stdout.write(`FAIL  ${name}  — ${String(e.message || e).slice(0, 240)}\n`); }
}

let browser;
try { browser = await pw.chromium.launch({ channel: "chrome", headless: !headed, slowMo: headed ? 80 : 0 }); }
catch {
  try { browser = await pw.chromium.launch({ headless: !headed, slowMo: headed ? 80 : 0 }); }
  catch (e) {
    cleanup();
    process.stdout.write(`e2e skipped: no browser to drive (${String(e.message).split("\n")[0]})\n`);
    process.exit(0);
  }
}
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

const wait = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => ({
  search: location.search,
  name: document.querySelector("#doc-name")?.value ?? "",
  view: document.querySelector("#app")?.dataset.view,
  open: [...document.querySelectorAll("#files .file-name")].map((e) => e.textContent.trim()),
  outlineFiles: document.querySelectorAll("#outline .outline-file").length,
  outlineUnits: document.querySelectorAll("#outline .outline-unit").length,
  outlineCount: document.querySelector("#outline .outline-count")?.textContent.trim() ?? "",
  activeUnit: document.querySelector("#outline .outline-unit.active .outline-name")?.textContent.trim() ?? "",
  status: document.querySelector("#status")?.textContent.replace(/\s+/g, " ").trim() ?? "",
  line: Number(document.querySelector("#status")?.textContent.match(/Ln (\d+)/)?.[1] ?? 0),
  toast: document.querySelector("#toast")?.textContent.replace(/\s+/g, " ").trim() ?? "",
  palette: !!document.querySelector("#palette dialog")?.open,
  help: !!document.querySelector("#help dialog")?.open,
  theme: document.documentElement.dataset.theme ?? "",
  briefMode: document.querySelector("#app")?.classList.contains("brief"),
  cards: document.querySelectorAll("markdown-preview section.rb-file").length,
  hunks: document.querySelectorAll("markdown-preview details.rb-hunk").length,
  hunksOpen: document.querySelectorAll("markdown-preview details.rb-hunk[open]").length,
  splitDiffs: document.querySelectorAll("markdown-preview code.diff-split").length,
}));
// focus without clicking: a click would move the cursor, which the unit motions read
const focusEditor = () => page.evaluate(() => document.querySelector("editor-pane").focus());
async function ex(cmd, settle = 500) { await focusEditor(); await page.keyboard.press("Escape"); await page.keyboard.type(cmd); await page.keyboard.press("Enter"); await wait(settle); }
async function keys(k, settle = 400) { await focusEditor(); await page.keyboard.press("Escape"); await page.keyboard.type(k); await wait(settle); }
const setView = async (v) => { await page.evaluate((v) => document.querySelector(`button[data-view="${v}"]`).click(), v); await wait(400); };
const openBrief = async (sha) => { await page.evaluate((s) => { const li = [...document.querySelectorAll("#files li")].find((l) => l.textContent.includes(s)); li?.querySelector(".file-select")?.click(); }, sha); await wait(900); };
const unitCount = async () => Number((await state()).status.match(/unit (\d+)\//)?.[1] ?? 0);

await page.goto(`${BASE}/?brief=/briefs/${slug(shaTwo)}`, { waitUntil: "load" });
await page.waitForSelector("#btn-more");
await wait(2500);

await check("boots into brief mode on the requested brief", async () => {
  const s = await state();
  assert(s.name === `pr-brief-${shaTwo}.md`, `name is ${s.name}`);
  assert(s.briefMode, "not in brief mode");
  return s.name;
});
await check("both served briefs appear once each in the Open list", async () => {
  const b = (await state()).open.filter((n) => n.startsWith("pr-brief-"));
  assert(b.length === 2, `${b.length} rows: ${b.join(",")}`);
  assert(new Set(b).size === b.length, `duplicates: ${b.join(",")}`);
  return b.join(" ");
});
await check("the outline matches the brief on disk", async () => {
  const s = await state();
  const want = shape[shaTwo];
  assert(s.outlineFiles === want.files, `${s.outlineFiles} files, expected ${want.files}`);
  assert(s.outlineUnits === want.units, `${s.outlineUnits} units, expected ${want.units}`);
  return s.outlineCount;
});
await check("the status bar reports the unit count", async () => {
  const s = await state();
  assert(new RegExp(`${shape[shaTwo].units} units`).test(s.status), s.status.slice(0, 90));
  return s.status.match(/\d+ units/)[0];
});
await check("clicking an outline unit jumps the editor there", async () => {
  await page.evaluate(() => document.querySelectorAll("#outline .outline-unit .outline-select")[1].click());
  await wait(500);
  const s = await state();
  assert(s.line > 1, `cursor at line ${s.line}`);
  assert(await unitCount() === 2, s.status.slice(0, 90));
  return `line ${s.line}`;
});
await check("]u steps to the next unit and [u back", async () => {
  const before = await unitCount();
  await keys("]u");
  const mid = await unitCount();
  assert(mid === before + 1, `${before} → ${mid}`);
  await keys("[u");
  const back = await unitCount();
  assert(back === before, `back to ${back}, expected ${before}`);
  return `${before} → ${mid} → ${back}`;
});
await check(":unit <name> jumps to a named unit", async () => {
  const name = shape[shaTwo].named;
  assert(name, "the brief has no named unit to jump to");
  await ex(`:unit ${name}`);
  const s = await state();
  assert(!/No unit matching/.test(s.toast), s.toast);
  assert(s.line > 1, `line ${s.line}`);
  return name;
});
await check(":file <path> jumps to a file section", async () => {
  await ex(":file Svc.java");
  const s = await state();
  assert(!/No file matching/.test(s.toast), s.toast);
  return `line ${s.line}`;
});
await check(":unit with no match says so", async () => {
  await ex(":unit zzzznotaunit");
  const t = (await state()).toast;
  assert(/No unit matching/.test(t), `toast: ${t}`);
  return t.slice(0, 60);
});
await check("the view switch cycles editor → split → preview", async () => {
  const seen = [];
  for (const v of ["editor", "split", "preview"]) { await setView(v); seen.push((await state()).view); }
  assert(seen.join(",") === "editor,split,preview", seen.join(","));
  return seen.join(" → ");
});
await check("the preview renders one card per file with the hunks folded", async () => {
  const s = await state();
  assert(s.cards === shape[shaTwo].files, `${s.cards} cards, expected ${shape[shaTwo].files}`);
  assert(s.hunks > 0, "no hunks rendered");
  assert(s.hunksOpen === 0, `${s.hunksOpen} hunks already open`);
  return `${s.cards} cards, ${s.hunks} folded hunks`;
});
await check("the side-by-side toggle re-renders the hunks in two columns", async () => {
  await page.evaluate(() => document.querySelector('#diff-switch button[data-diff="split"]').click());
  await wait(700);
  const split = (await state()).splitDiffs;
  assert(split > 0, "no side-by-side hunks");
  await page.evaluate(() => document.querySelector('#diff-switch button[data-diff="unified"]').click());
  await wait(700);
  assert((await state()).splitDiffs === 0, "still side-by-side after switching back");
  return `${split} side-by-side → 0 unified`;
});
await check("an open fold survives the diff toggle", async () => {
  await page.evaluate(() => { document.querySelector("markdown-preview details.rb-hunk").open = true; });
  await wait(300);
  await page.evaluate(() => document.querySelector('#diff-switch button[data-diff="split"]').click());
  await wait(800);
  const open = (await state()).hunksOpen;
  await page.evaluate(() => document.querySelector('#diff-switch button[data-diff="unified"]').click());
  await wait(700);
  assert(open >= 1, `${open} folds open after the toggle`);
  return `${open} kept open`;
});
await check("zR unfolds every hunk in the editor and zM folds them", async () => {
  await setView("split");
  await keys("zR", 600);
  const un = await page.evaluate(() => document.querySelectorAll("editor-pane .cm-foldPlaceholder").length);
  await keys("zM", 600);
  const fo = await page.evaluate(() => document.querySelectorAll("editor-pane .cm-foldPlaceholder").length);
  assert(fo > un, `${un} unfolded vs ${fo} folded placeholders`);
  return `${un} → ${fo}`;
});
await check("scrolling the preview moves the outline highlight", async () => {
  await setView("preview");
  const scrollable = await page.evaluate(() => { const p = document.querySelector("markdown-preview"); return p.scrollHeight > p.clientHeight + 200; });
  assert(scrollable, "the brief is too short to scroll — the fixture needs more units");
  const seen = [];
  for (const frac of [0, 0.15, 0.3, 0.45, 0.6, 0.75]) {
    await page.evaluate((f) => { const p = document.querySelector("markdown-preview"); p.scrollTop = (p.scrollHeight - p.clientHeight) * f; p.dispatchEvent(new Event("wheel")); }, frac);
    await wait(700);
    const u = (await state()).activeUnit;
    if (u && !seen.includes(u)) seen.push(u);
  }
  assert(seen.length >= 2, `the highlight only ever reached: ${seen.join(", ") || "(nothing)"}`);
  return seen.slice(0, 3).join(" → ");
});
await check("a file link opens the file read-only at this brief's commit", async () => {
  await setView("preview");
  const link = await page.$('markdown-preview a[href*="Svc.java"]');
  assert(link, "no Svc.java link in the preview");
  const href = await link.getAttribute("href");
  assert(href.includes(encodeURIComponent(`/briefs/${slug(shaTwo)}`)), `href lacks the brief: ${href}`);
  await link.click();
  await wait(2500);
  const s = await state();
  assert(/Svc\.java/.test(s.name), `opened ${s.name}`);
  assert(new RegExp(`Read-only .* @ ${shaTwo}`).test(s.status), s.status.slice(0, 90));
  return `@ ${shaTwo}`;
});
await check("a source file gets its own symbol outline", async () => {
  const s = await state();
  assert(s.outlineUnits > 5, `${s.outlineUnits} symbols`);
  assert(/symbols/.test(s.outlineCount), s.outlineCount);
  return s.outlineCount;
});
await check("browser back returns to the brief the file was opened from", async () => {
  await page.goBack();
  await wait(2200);
  const s = await state();
  assert(s.name === `pr-brief-${shaTwo}.md`, `landed on ${s.name}`);
  return s.name;
});
await check("the same file opens at a different commit from the other brief", async () => {
  await openBrief(shaOne);
  assert((await state()).name === `pr-brief-${shaOne}.md`, "did not switch brief");
  await setView("preview");
  const link = await page.$('markdown-preview a[href*="Svc.java"]');
  assert(link, "no Svc.java link in this brief");
  await link.click();
  await wait(2500);
  const s = await state();
  assert(new RegExp(`Read-only .* @ ${shaOne}`).test(s.status), s.status.slice(0, 90));
  return `@ ${shaOne}, not ${shaTwo}`;
});
await check("back from that file returns to the second brief, not the first", async () => {
  await page.goBack();
  await wait(2200);
  const s = await state();
  assert(s.name === `pr-brief-${shaOne}.md`, `landed on ${s.name}`);
  return s.name;
});
await check("each brief loads its own units when selected", async () => {
  const seen = [];
  for (const sha of [shaTwo, shaOne, shaTwo]) {
    await openBrief(sha);
    const s = await state();
    assert(s.name === `pr-brief-${sha}.md`, `expected ${sha}, got ${s.name}`);
    assert(s.outlineUnits === shape[sha].units, `${sha}: ${s.outlineUnits} units, expected ${shape[sha].units}`);
    seen.push(`${sha}:${s.outlineUnits}`);
  }
  return seen.join(" ");
});
await check("the address bar names the brief being read", async () => {
  const s = await state();
  assert(s.search === `?brief=/briefs/${slug(shaTwo)}`, s.search);
  return s.search;
});
await check("⌘K opens the palette and runs a command", async () => {
  await page.keyboard.press("Meta+KeyK");
  await wait(300);
  assert((await state()).palette, "the palette did not open");
  await page.keyboard.type("side-by-side");
  await wait(200);
  await page.keyboard.press("Enter");
  await wait(700);
  assert(!(await state()).palette, "the palette stayed open");
  await page.evaluate(() => document.querySelector('#diff-switch button[data-diff="unified"]').click());
  await wait(400);
  return "ran a brief command";
});
await check("⌘K → color → Enter opens the scheme picker (a picker from a picker)", async () => {
  await page.keyboard.press("Meta+KeyK");
  await wait(250);
  await page.keyboard.type("color");
  await page.keyboard.press("Enter");
  await wait(400);
  const placeholder = await page.evaluate(() => document.querySelector("#palette dialog input").placeholder);
  assert(/Color scheme/.test(placeholder), `placeholder is "${placeholder}"`);
  await page.keyboard.type("light");
  await page.keyboard.press("Enter");
  await wait(500);
  const t = (await state()).theme;
  assert(/light/.test(t), `theme is ${t}`);
  return t;
});
await check("the status-bar scheme name also opens the picker", async () => {
  await page.click('#status [data-action="pick-theme"]');
  await wait(400);
  assert((await state()).palette, "the picker did not open");
  await page.keyboard.type("one dark");
  await page.keyboard.press("Enter");
  await wait(500);
  assert((await state()).theme === "one-dark", `theme is ${(await state()).theme}`);
  return "one-dark";
});
await check("⌘/ opens the keyboard reference outside the editor", async () => {
  await setView("preview");
  await page.keyboard.press("Meta+Slash");
  await wait(400);
  assert((await state()).help, "help did not open");
  await page.keyboard.press("Escape");
  await wait(200);
  return "opened and closed";
});
await check("the ⋯ menu reaches the scheme picker", async () => {
  await page.click("#btn-more");
  await wait(200);
  await page.click('#more-menu [data-menu="theme"]');
  await wait(400);
  assert((await state()).palette, "the picker did not open from the menu");
  await page.keyboard.press("Escape");
  await wait(200);
  return "menu → picker";
});

const NOTE = "e2e note " + Date.now();
await check(":note writes a reviewer note and :w saves it to disk", async () => {
  await openBrief(shaOne);
  await setView("split");
  await ex(`:unit ${shape[shaOne].named}`);
  await ex(":note");
  await page.keyboard.type(NOTE);
  await page.keyboard.press("Escape");
  await wait(300);
  await ex(":w", 900);
  assert(fs.readFileSync(briefPath(shaOne), "utf8").includes(NOTE), "the note is not in the file on disk");
  return (await state()).toast.slice(0, 60);
});
await check("regenerating the brief keeps the reviewer note", async () => {
  node(path.join(SKILL, "scripts/extract.ts"), "commit", shaOne);
  assert(fs.readFileSync(briefPath(shaOne), "utf8").includes(NOTE), "regeneration dropped the note");
  return "carried over";
});
await check("the open tab picks the regenerated brief up by itself", async () => {
  await wait(2500);
  const s = await state();
  assert(s.name === `pr-brief-${shaOne}.md`, `showing ${s.name}`);
  const has = await page.evaluate((n) => document.body.textContent.includes(n), NOTE);
  assert(has, "the reloaded document lost the note");
  return "reloaded with the note";
});
await check("a save is refused when the file moved on since it was read", async () => {
  await setView("split");
  await focusEditor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("G");
  await page.keyboard.type("otouched in the editor");
  await page.keyboard.press("Escape");
  await wait(500);
  fs.appendFileSync(briefPath(shaOne), "\n<!-- e2e disk write -->\n");
  await wait(1500);
  await ex(":w", 1200);
  const t = (await state()).toast;
  assert(/changed on disk|Reload/i.test(t), `toast: ${t}`);
  return t.slice(0, 70);
});
await check("the copy button puts the unit on the clipboard as a PR comment", async () => {
  await openBrief(shaTwo);
  await setView("preview");
  await page.evaluate(() => { const b = document.querySelector("markdown-preview .rb-copy"); b.style.opacity = 1; b.click(); });
  await wait(900);
  const t = (await state()).toast;
  assert(/Copied/.test(t), `toast: ${t}`);
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  assert(text.length > 30 && /\*\*/.test(text), `clipboard: ${text.slice(0, 80)}`);
  return text.split("\n")[0].slice(0, 60);
});
await check("× closes a brief and it does not come back on the next change", async () => {
  const before = (await state()).open.filter((n) => n.startsWith("pr-brief-")).length;
  await page.evaluate((s) => { const li = [...document.querySelectorAll("#files li")].find((l) => l.textContent.includes(s)); li?.querySelector(".file-delete")?.click(); }, shaOne);
  await wait(900);
  const mid = (await state()).open.filter((n) => n.startsWith("pr-brief-")).length;
  assert(mid === before - 1, `${before} → ${mid}`);
  fs.utimesSync(briefPath(shaTwo), new Date(), new Date());
  await wait(2000);
  assert(!(await state()).open.some((n) => n.includes(shaOne)), "the closed brief came back");
  return `${before} → ${mid}, stayed closed`;
});
await check("a closed brief stays closed after a reload and in a second tab; asking for it by URL brings it back", async () => {
  await page.reload({ waitUntil: "load" });
  await wait(2500);
  assert(!(await state()).open.some((n) => n.includes(shaOne)), "the closed brief came back after a reload");
  const other = await ctx.newPage();
  await other.goto(page.url(), { waitUntil: "load" });
  await other.waitForTimeout(2500);
  const seen = await other.evaluate(() => [...document.querySelectorAll("#files .file-name")].map((e) => e.textContent.trim()));
  await other.close();
  assert(!seen.some((n) => n.includes(shaOne)), "the closed brief showed up in a second tab");
  await page.goto(`${BASE}/?brief=/briefs/${slug(shaOne)}`, { waitUntil: "load" });
  await wait(2500);
  assert((await state()).open.some((n) => n.includes(shaOne)), "?brief= did not reopen the closed brief");
  await page.goto(`${BASE}/?brief=/briefs/${slug(shaTwo)}`, { waitUntil: "load" });
  await wait(2500);
  return "stayed closed through a reload and a second tab; ?brief= reopened it";
});
await check("⊗ closes the opened source files and keeps the briefs", async () => {
  await setView("preview");
  const link = await page.$('markdown-preview a[href*="Svc.java"]');
  await link.click();
  await wait(2200);
  assert((await state()).open.some((n) => n.endsWith(".java")), "the source file did not open");
  await page.evaluate(() => document.querySelector("#files .file-close-others")?.click());
  await wait(900);
  const s = await state();
  assert(!s.open.some((n) => n.endsWith(".java") && n !== s.name), "a source file survived ⊗");
  assert(s.open.some((n) => n.startsWith("pr-brief-")), "the briefs were closed too");
  return "source files closed, briefs kept";
});
await check("GET /briefs lists every served brief with its repository", async () => {
  const list = await page.evaluate(async () => (await fetch("/briefs")).json());
  assert(list.length === 2, `${list.length} briefs`);
  assert(list.every((b) => b.root.endsWith("/fixture")), "a brief points at the wrong repository");
  return `${list.length} briefs`;
});
await check("PUT rejects a body that is not a brief", async () => {
  const code = await page.evaluate(async (u) => (await fetch(u, { method: "PUT", body: "not a brief" })).status, `/briefs/${slug(shaTwo)}`);
  assert(code === 422, `status ${code}`);
  return "422";
});
await check("an unknown brief is a 404, not a crash", async () => {
  const code = await page.evaluate(async () => (await fetch("/briefs/nope")).status);
  assert(code === 404, `status ${code}`);
  return "404";
});
await check("/file refuses to escape the repository", async () => {
  const code = await page.evaluate(async () => (await fetch("/file?path=../../../etc/passwd")).status);
  assert(code === 422, `status ${code}`);
  return "422";
});
await check("no unexpected console errors during the run", async () => {
  // the checks above deliberately provoke 404, 422 and 412; anything else is a real error
  const expected = /status of (404|422|412)/;
  const real = consoleErrors.filter((e) => !expected.test(e));
  assert(real.length === 0, real.slice(0, 3).join(" | "));
  return `${consoleErrors.length} deliberate only`;
});

await browser.close();
cleanup();

const failed = results.filter((r) => !r[0]);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.stdout.write("FAILURES:\n" + failed.map((f) => `  ${f[1]}: ${f[2]}`).join("\n") + "\n");
  process.exit(1);
}
process.stdout.write("e2e ok\n");
