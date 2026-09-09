#!/usr/bin/env node
// viewer.ts — serve the vendored editor (viewer/) on localhost and hand it the
// brief. Zero dependencies.
//
//   node scripts/viewer.ts [--out FILE (default: the brief extract wrote last)] [--port N (default 8790)] [--no-open] [--detach] [--verbose]
//   node scripts/viewer.ts --stop        ask the running viewer to exit
//
// Trust: the server answers to localhost only, and the writing routes trust two parties. A tab of the
// editor (a PUT with a same-origin Origin header), and this user's own processes, which prove themselves
// with the token the server writes to os.tmpdir()/pr-brief-viewer-<port>.token (mode 0600, removed on
// exit) and send as X-Viewer-Token. POST /switch and /stop require the token; PUT requires it when the
// request carries no Origin. Any other local process — another user on a shared host — gets 403.
//
// Several briefs can be served at once (a stack of PRs, the last few commits): each has a slug,
// and every brief under the repository's state directory (<common git dir>/pr-brief/<key>/) joins the list on start and on /switch.
//
// Routes:
//   GET  /            the editor (static files from viewer/)
//   GET  /briefs      [{ slug, url, path, name, mtime, repo, root }] — every served brief, in registration order
//   GET  /briefs/S    that brief's current content on disk
//   PUT  /briefs/S    replace it on disk (body = full text); refused unless the body still starts with
//                     pr-brief front matter, so a stray save cannot destroy the cache
//   GET  /briefs/S/meta  { slug, url, path, name, mtime, repo, root, viewer, current, briefs }
//   GET  /brief, /brief/meta, PUT /brief   the same for the current brief (the last one handed over)
//   GET  /events      server-sent events: `meta` (the current brief's meta plus `briefs`) on connect and
//                     whenever any served brief is rewritten, /switch changes the list or the current
//                     brief, or the viewer build changes — open tabs never poll
//   GET  /file?path=P[&brief=S]  { name, path, content, rev, symbols } — a repo file as brief S sees it
//                     (symbols: the same units extract would find, for the editor's outline): at the
//                     briefed commit in commit mode, else the working tree (falling back to head, then
//                     base, for deleted files). Read-only.
//   POST /switch      { path, root } — add a brief (or find it) and make it current (token required);
//                     a second `viewer.ts` uses this instead of starting a second server, so one tab
//                     at the fixed port shows every brief. `root` must be a git work tree whose common
//                     git dir or top level holds the brief; absent, the brief's own repository is used
//   POST /stop        exit (token required)
//
// The editor opens a brief through ?brief=/briefs/S (brief mode in the editor),
// and writes back through PUT. The files on disk stay the source of truth.

import { createServer } from "node:http";
import { readFile, writeFile, stat, rename } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { findAstGrep, scanSymbols, paramsOf, qualName, displayName } from "./symbols.ts";

const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VIEWER = path.join(SKILL_DIR, "viewer");

const args = process.argv.slice(2);
const opt = (name: string, dflt: string | null = null): string | null => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const port = Number(opt("--port", "8790")); // fixed by default: the browser keeps settings and documents per origin
const noOpen = args.includes("--no-open");
const detach = args.includes("--detach"); // when a server has to be started, start it in the background and return at once (SKILL.md's last step)
const verbose = args.includes("--verbose"); // log every request
const stop = args.includes("--stop"); // tell the running viewer to exit
// The per-server secret: written by the serving process (see onListen), read by the CLI paths that talk
// to a running viewer. Keyed by port, so `--stop --port N` and the hand-off in main() find the right one.
const tokenFile = (p: number): string => path.join(os.tmpdir(), `pr-brief-viewer-${p}.token`);
const readToken = (p: number): string | null => { try { return fs.readFileSync(tokenFile(p), "utf8").trim() || null; } catch { return null; } };
// Is a pr-brief viewer answering on the port? Its meta (path, root, viewer build), or null.
async function probeViewer(p: number): Promise<Record<string, any> | null> {
  const meta = await fetch(`http://127.0.0.1:${p}/brief/meta`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return meta && typeof meta.path === "string" && "viewer" in meta ? meta : null; // a pr-brief viewer, whatever state its brief is in
}
if (stop) {
  // stopping a server has nothing to do with the current directory: no git, no brief
  const meta = await probeViewer(port);
  if (!meta) {
    const busy = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" }).then(() => true).catch(() => false);
    process.stdout.write(busy ? `port ${port} is in use, but not by a pr-brief viewer — nothing stopped\n` : `no pr-brief viewer on port ${port}\n`);
    process.exit(0);
  }
  const token = readToken(port);
  const r = token ? await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { "X-Viewer-Token": token } }).catch(() => null) : null;
  if (r?.ok) process.stdout.write(`pr-brief viewer on port ${port} stopped (was serving ${meta.path} for ${meta.root})\n`);
  else if (!token) process.stdout.write(`pr-brief viewer on port ${port} (serving ${meta.path}) was not started by you: no token at ${tokenFile(port)}\n`);
  else process.stdout.write(`pr-brief viewer on port ${port} refused to stop (HTTP ${r?.status ?? "error"}); its token may have been rotated\n`);
  process.exit(r?.ok ? 0 : 1);
}
const rootProbe = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (rootProbe.status !== 0) { process.stderr.write("viewer.ts: not inside a git repository\n"); process.exit(1); }
const root = rootProbe.stdout.trim();
// The repository's state root: pr-brief/ under its common git directory (.git, the main .git of a linked
// worktree, or .bare beside worktrees). git resolves the pointers; the absolute form needs git >= 2.31.
function stateRootOf(dir: string): string {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8" });
  const common = r.status === 0 ? r.stdout.trim() : path.resolve(dir, spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim());
  return path.join(common, "pr-brief");
}
// without --out: the brief extract wrote last (extract records its key in <state>/last; the brief is <state>/<key>/pr-brief-<key>.md)
const lastKey = (dir: string): string | null => { try { return fs.readFileSync(path.join(stateRootOf(dir), "last"), "utf8").trim() || null; } catch { return null; } };
const outArg = opt("--out");
const lastBrief = (): string => { const k = lastKey(root); if (!k) { process.stderr.write(`no brief for this repository yet (${path.join(stateRootOf(root), "last")} missing) — run extract first\n`); process.exit(1); } return path.join(stateRootOf(root), k, `pr-brief-${k}.md`); };
const briefPath = outArg ? path.resolve(root, outArg) : lastBrief();
const shortPath = (p: string): string => { const r = path.relative(root, p); return r.startsWith("..") ? p : r; };

if (!fs.existsSync(path.join(VIEWER, "index.html"))) { process.stderr.write(`viewer not found at ${VIEWER}\n`); process.exit(1); }
if (!fs.existsSync(briefPath)) { process.stderr.write(`${briefPath} not found — run extract first\n`); process.exit(1); }

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};

// The repository's web URL (GitHub-style), from the origin remote, so the editor can link a copied
// unit to its lines. null when there is no origin or it is not an http(s)/ssh URL.
function repoWeb(dir: string): string | null {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) return null;
  let u = r.stdout.trim().replace(/\.git$/, "");
  // git@host:owner/repo and ssh://git@host[:port]/owner/repo → https://host/owner/repo
  const ssh = u.match(/^(?:ssh:\/\/)?git@([^:/@]+)(?::\d+)?[:/](.+)$/);
  if (ssh) u = `https://${ssh[1]}/${ssh[2].replace(/^\/+/, "")}`;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = ""; url.password = ""; // a PAT in the remote must never reach a tab or a PR comment
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch { return null; }
}

// --- The served briefs -------------------------------------------------------------------------
// A brief is a file plus the worktree it describes (where /file reads from). A brief kept under the
// repository's state directory, <state>/<key>/pr-brief-<key>.md, is served at /briefs/<key>; any other
// file is served under its own name. The worktree is the one recorded in the brief's front matter
// (root:), so a brief made in one worktree reads its files from there wherever the viewer was started.
interface Served { slug: string; path: string; name: string; root: string; repo: string | null }
const briefs = new Map<string, Served>(); // registration order is the order the editor lists them in
let current = "";
const cur = (): Served => briefs.get(current)!;
const BRIEF_GATE = /^---\n(?:pr|review)-brief: \d+\n/; // the old key is still a brief
const isBriefFile = (p: string): boolean => { try { return BRIEF_GATE.test(fs.readFileSync(p, "utf8").slice(0, 64)); } catch { return false; } };
const storedKey = (p: string, rootDir: string): string | null => {
  const rel = path.relative(stateRootOf(rootDir), path.dirname(p));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(/[\\/]/).join("-") : null;
};
const briefRoot = (p: string): string | null => { // the worktree the brief was generated from
  try {
    const head = fs.readFileSync(p, "utf8").slice(0, 2048);
    const m = head.match(/^root: (.+)$/m);
    return m && fs.existsSync(m[1]) && fs.statSync(m[1]).isDirectory() ? m[1] : null;
  } catch { return null; }
};
function register(p: string, rootDir: string): Served {
  try { p = fs.realpathSync(p); } catch { /* keep the path as given */ } // one entry per file, however it was spelled
  const tree = briefRoot(p) ?? rootDir;
  for (const b of briefs.values()) if (b.path === p) { b.root = tree; b.repo = repoWeb(tree); return b; }
  const key = storedKey(p, rootDir);
  const base = (key ?? path.basename(p).replace(/\.md$/i, "").toLowerCase()).replace(/[^A-Za-z0-9._-]+/g, "-");
  let slug = base;
  for (let n = 2; briefs.has(slug); n++) slug = `${base}-${n}`;
  const b: Served = { slug, path: p, name: path.basename(p), root: tree, repo: repoWeb(tree) };
  briefs.set(slug, b);
  return b;
}
// every brief kept under the repository's state directory joins the list, so a stack generated together shows
// up together. Only the briefs themselves: a key's archive and skeleton copies carry the same front matter.
const STORED_NAME = /^(pr-brief-.+|PR_BRIEF|REVIEW_BRIEF)\.md$/;
function registerStored(rootDir: string): void {
  for (const [slug, b] of briefs) if (slug !== current && !fs.existsSync(b.path)) briefs.delete(slug); // moved or deleted since: no longer served
  const walk = (d: string, depth: number) => {
    let ents: fs.Dirent[]; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && STORED_NAME.test(e.name) && isBriefFile(p)) register(p, rootDir);
    }
  };
  walk(stateRootOf(rootDir), 0);
}
current = register(briefPath, root).slug;
registerStored(root);

// Build id of the served app (the VERSION stamp in sw.js), re-read on every call so an open tab
// notices a `build.mjs --stamp` and reloads itself.
function viewerBuild(): string | null {
  try { return fs.readFileSync(path.join(VIEWER, "sw.js"), "utf8").match(/VERSION = '([^']+)'/)?.[1] ?? null; } catch { return null; }
}

// Server-sent events. Every open tab holds one connection; it gets the current meta on connect and
// again whenever a served brief is rewritten (extract, lint, a fill, a save), /switch changes the
// list, or sw.js is re-stamped. fs.watch on each directory catches editors that write by rename.
const clients = new Set<import("node:http").ServerResponse>();
async function briefMeta(b: Served) {
  const s = await stat(b.path).catch(() => null);
  return { slug: b.slug, url: `/briefs/${b.slug}`, path: b.path, name: b.name, mtime: s?.mtimeMs ?? null, repo: b.repo, root: b.root };
}
async function metaJSON(of: Served = cur()): Promise<string> {
  const list = await Promise.all([...briefs.values()].map(briefMeta));
  const mine = list.find((b) => b.slug === of.slug)!;
  return JSON.stringify({ ...mine, viewer: viewerBuild(), current, briefs: list });
}
let broadcastTimer: NodeJS.Timeout | null = null;
function broadcastMeta(): void {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    if (!clients.size) return;
    const frame = `event: meta\ndata: ${await metaJSON()}\n\n`;
    for (const c of clients) c.write(frame);
  }, 80); // a rewrite is several fs events; one frame per change
}
let watchers: fs.FSWatcher[] = [];
let polled: string[] = []; // paths fs.watchFile polls where fs.watch is unavailable (inotify limits, odd mounts)
function watchBriefs(): void {
  for (const w of watchers) w.close(); watchers = [];
  for (const p of polled) fs.unwatchFile(p); polled = [];
  const byDir = new Map<string, Set<string>>();
  for (const b of briefs.values()) { const d = path.dirname(b.path); if (!byDir.has(d)) byDir.set(d, new Set()); byDir.get(d)!.add(path.basename(b.path)); }
  for (const [dir, names] of byDir) {
    try { watchers.push(fs.watch(dir, (_event, file) => { if (!file || names.has(String(file))) broadcastMeta(); })); }
    catch (e: any) {
      process.stderr.write(`cannot watch ${dir} (${e?.code ?? e}); polling every 2 s instead\n`);
      for (const n of names) { const p = path.join(dir, n); polled.push(p); fs.watchFile(p, { interval: 2000 }, () => broadcastMeta()); }
    }
  }
}
function startWatchers(): void {
  watchBriefs();
  try { fs.watch(VIEWER, (_event, file) => { if (file === "sw.js") broadcastMeta(); }); } catch { /* no rebuild detection */ }
  setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 25_000).unref(); // keeps proxies and browsers from dropping idle streams
}

const SG = findAstGrep(); // null: outlines are empty but files still open

// The outline of one file: the symbols extract's rules find in it, with the same ids extract gives
// units (overloads carry their parameter list), so the editor can match them to the brief.
function symbolsOf(rel: string, content: string): object[] {
  if (!SG) return [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-view-"));
  try {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    const syms = scanSymbols(SG, tmp).get(rel) ?? [];
    const counts = new Map<string, number>();
    const base = (x: { scope: string; name: string; kind: string }) => `${x.scope}|${x.name}|${x.kind}`;
    for (const x of syms) counts.set(base(x), (counts.get(base(x)) ?? 0) + 1);
    for (const x of syms) if ((counts.get(base(x)) ?? 0) > 1) x.disc = paramsOf(x.signature);
    return syms.map((x) => ({ id: `${rel}#${qualName(x)}`, name: x.name, scope: x.scope, kind: x.kind, line: x.start, end: x.end, display: displayName(x.signature, x.name, x.kind) }));
  } catch { return []; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const OK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const LOCAL = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const TOKEN = randomBytes(24).toString("hex"); // this server's secret; written to tokenFile(port) once listening
const FILE_MAX = 1 << 26; // 64 MB: the most /file serves, from the working tree or from history
const server = createServer(async (req, res) => {
  // parsed against a fixed base: only the path and query are used, and a bad Host must not throw
  let url: URL;
  try { url = new URL(req.url ?? "/", "http://127.0.0.1"); } catch { res.writeHead(400); return res.end("bad request"); }
  // Everything reaching this server comes from 127.0.0.1, so the address says nothing about who sent it.
  // A Host that is not ours is a DNS-rebinding page; a POST or PUT with a foreign Origin is a cross-site
  // request. A same-origin Origin marks a tab of the editor (browsers always send one on POST/PUT);
  // the token marks this user's own processes (the CLI paths below, which send no Origin).
  const host = req.headers.host ?? "";
  if (!OK_HOST.test(host)) { res.writeHead(421, { "Content-Type": types[".txt"] }); return res.end("misdirected request: this server answers to localhost only"); }
  const origin = req.headers.origin;
  const writing = req.method === "POST" || req.method === "PUT";
  if (writing && typeof origin === "string" && origin !== `http://${host}`) { res.writeHead(403, { "Content-Type": types[".txt"] }); return res.end("cross-origin request refused"); }
  const fromTab = writing && typeof origin === "string"; // same-origin, per the check above
  const fromOwner = req.headers["x-viewer-token"] === TOKEN;
  if (verbose) res.on("finish", () => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname}${url.search.slice(0, 120)} → ${res.statusCode}\n`));
  const text = (code: number, body: string) => { res.writeHead(code, { "Content-Type": types[".txt"] }); res.end(body); };
  try {
    // /brief and /brief/meta are the current brief; /briefs/S and /briefs/S/meta name one
    const bm = url.pathname.match(/^\/briefs\/([^/]+)(\/meta)?$/);
    const served: Served | null = url.pathname === "/brief" || url.pathname === "/brief/meta" ? cur() : bm ? briefs.get(decodeURIComponent(bm[1])) ?? null : null;
    const wantMeta = url.pathname === "/brief/meta" || !!bm?.[2];
    if (url.pathname === "/briefs" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
      return res.end(JSON.stringify(await Promise.all([...briefs.values()].map(briefMeta))));
    }
    if ((bm || url.pathname === "/brief" || url.pathname === "/brief/meta") && !served) return text(404, "no such brief");
    if (served && wantMeta && req.method === "GET") {
      res.writeHead(200, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
      return res.end(await metaJSON(served)); // mtime null while the file is missing: the server is still here
    }
    if (served && !wantMeta && req.method === "GET") {
      const body = await readFile(served.path, "utf8");
      res.writeHead(200, { "Content-Type": types[".md"], "Cache-Control": "no-store" });
      return res.end(body);
    }
    if (served && !wantMeta && req.method === "PUT") {
      if (!fromTab && !fromOwner) return text(403, "refused: a save needs the editor's Origin or this viewer's X-Viewer-Token");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      if (!BRIEF_GATE.test(body)) return text(422, "refused: body does not start with pr-brief front matter");
      // the client says which version it read (X-Brief-Mtime); a file that moved on since is not overwritten
      const expect = Number(req.headers["x-brief-mtime"]);
      if (Number.isFinite(expect)) {
        const curStat = await stat(served.path).catch(() => null);
        if (curStat && Math.abs(curStat.mtimeMs - expect) > 1) return text(412, "the brief changed on disk since you read it — reload (:rel) and save again");
      }
      // write beside, then rename over: a reader never sees a truncated brief
      const tmpPath = `${served.path}.${process.pid}.tmp`;
      await writeFile(tmpPath, body);
      await rename(tmpPath, served.path);
      const s = await stat(served.path);
      res.writeHead(200, { "Content-Type": types[".json"] });
      return res.end(JSON.stringify({ ok: true, mtime: s.mtimeMs }));
    }
    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`event: meta\ndata: ${await metaJSON()}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      if (verbose) process.stdout.write(`${new Date().toISOString().slice(11, 19)} GET /events → stream open (${clients.size} connected)\n`); // finish never fires for a stream
      return;
    }
    if (url.pathname === "/file" && req.method === "GET") {
      const b = briefs.get(url.searchParams.get("brief") ?? "") ?? cur(); // the brief the file is read for decides the revision and the repository
      const rel = url.searchParams.get("path") ?? "";
      const abs = path.resolve(b.root, rel);
      // containment on the real paths: a symlink inside the repository must not lead outside it
      let real = abs; try { real = fs.realpathSync(abs); } catch { /* not in the working tree: git show decides */ }
      const rootReal = fs.realpathSync(b.root);
      if (!rel || path.isAbsolute(rel) || rel.startsWith("-") || rel.split(/[\\/]/).includes("..") || !(abs + path.sep).startsWith(b.root + path.sep) || !(real + path.sep).startsWith(rootReal + path.sep)) return text(422, "path must be relative to the repository");
      const front = (await readFile(b.path, "utf8")).split("\n---\n")[0];
      const fm = (k: string) => front.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1] ?? null;
      const mode = fm("mode"), head = fm("head"), base = fm("base");
      let bytes: Buffer | null = null, rev = "working tree", tooLarge = false;
      // a revision that has the file but past FILE_MAX is "too large", not "absent": git fails with ENOBUFS
      const show = (r: string | null): Buffer | null => {
        if (!r) return null;
        const g = spawnSync("git", ["show", `${r}:${rel}`], { cwd: b.root, maxBuffer: FILE_MAX });
        if (g.status === 0) { rev = r.slice(0, 7); return g.stdout; }
        if (g.error && (g.error as NodeJS.ErrnoException).code === "ENOBUFS") tooLarge = true;
        return null;
      };
      // the working tree is the version asked for: a file past the cap is 413 here, never a smaller version from history
      if (mode !== "commit" && fs.existsSync(abs)) { if (fs.statSync(abs).size > FILE_MAX) return text(413, `${rel} is larger than ${FILE_MAX >> 20} MB — too large to show`); bytes = await readFile(abs); }
      bytes ??= show(head); bytes ??= show(base);
      if (bytes === null) return tooLarge ? text(413, `${rel} is larger than ${FILE_MAX >> 20} MB — too large to show`) : text(404, `${rel} not found in the working tree, ${head?.slice(0, 7)} or ${base?.slice(0, 7)}`);
      if (bytes.subarray(0, 8192).includes(0)) return text(415, `${rel} is a binary file (${bytes.length} bytes) — nothing to show`); // a NUL in the first 8 KB: git's own heuristic
      const content = bytes.toString("utf8");
      res.writeHead(200, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ name: path.basename(rel), path: rel, content, rev, mode, symbols: symbolsOf(rel, content) }));
    }
    if (url.pathname === "/stop" && req.method === "POST") {
      if (!LOCAL.test(req.socket.remoteAddress ?? "") || !fromOwner) return text(403, "refused: /stop needs this viewer's X-Viewer-Token");
      res.writeHead(200, { "Content-Type": types[".json"] });
      res.end(JSON.stringify({ ok: true }));
      process.stdout.write("stopping\n");
      setTimeout(() => process.exit(0), 50);
      return;
    }
    if (url.pathname === "/switch" && req.method === "POST") {
      if (!LOCAL.test(req.socket.remoteAddress ?? "") || !fromOwner) return text(403, "refused: /switch needs this viewer's X-Viewer-Token");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const next = body.path;
      if (typeof next !== "string" || !path.isAbsolute(next) || !fs.existsSync(next) || !fs.statSync(next).isFile()) return text(422, "path must be an existing absolute file");
      // only a brief can be served: the same front-matter gate PUT applies
      if (!isBriefFile(next)) return text(422, "refused: not a PR brief");
      // the brief's repository is where /file reads from. The caller may name it, but only a git work tree
      // that holds the brief — under its common git dir (the state directory) or its top level — so a
      // brief-shaped file cannot turn an arbitrary directory into a served root. Else the brief's own repository.
      let rootDir: string;
      if (body.root !== undefined) {
        if (typeof body.root !== "string" || !fs.existsSync(body.root) || !fs.statSync(body.root).isDirectory()) return text(422, "root must be an existing directory");
        const out = (a: string[]) => { const g = spawnSync("git", ["-C", body.root, ...a], { encoding: "utf8" }); return g.status === 0 ? g.stdout.trim() : null; };
        const top = out(["rev-parse", "--show-toplevel"]);
        const common = top ? path.dirname(stateRootOf(top)) : null; // absolute on any git: stateRootOf keeps the pre-2.31 fallback
        const real = (p: string | null) => { try { return p ? fs.realpathSync(p) : null; } catch { return null; } };
        const brief = fs.realpathSync(next), holds = (d: string | null) => !!d && brief.startsWith(d + path.sep);
        if (!common || !top || !(holds(real(common)) || holds(real(top)))) return text(422, "root must be a git work tree that holds the brief");
        rootDir = top;
      } else {
        const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: path.dirname(next), encoding: "utf8" });
        rootDir = r.status === 0 ? r.stdout.trim() : cur().root;
      }
      const b = register(next, rootDir);
      current = b.slug;
      registerStored(rootDir);
      process.stdout.write(`now serving ${b.path} (repo ${b.root}; ${briefs.size} brief${briefs.size === 1 ? "" : "s"})\n`);
      watchBriefs();
      broadcastMeta();
      res.writeHead(200, { "Content-Type": types[".json"] });
      // tabs: open tabs hold one /events stream each; a caller with none to follow the switch opens a browser
      return res.end(JSON.stringify({ ok: true, path: b.path, slug: b.slug, url: `/briefs/${b.slug}`, tabs: clients.size }));
    }
    // static: decode first (the URL parser leaves %2f alone), refuse any `..` segment, then contain on a
    // whole path component so a sibling named viewer* is never served
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.split(/[\\/]/).includes("..")) { res.writeHead(403); return res.end(); }
    let file = path.normalize(path.join(VIEWER, decoded));
    if (file !== VIEWER && !file.startsWith(VIEWER + path.sep)) { res.writeHead(403); return res.end(); }
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "Service-Worker-Allowed": "/" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": types[".txt"] });
    res.end("Not found");
  }
});

// The default browser, at url. A missing opener (headless Linux, a container) is reported, never fatal.
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url]; // `start` is a cmd.exe builtin, not an executable
  const child = spawn(cmd, argv, { stdio: "ignore", detached: true });
  child.on("error", (e: NodeJS.ErrnoException) => process.stderr.write(`could not open a browser (${e.code ?? e.message}); open ${url} in your browser\n`));
  child.unref();
}

// If a pr-brief viewer is already running on the port, hand it this brief and exit: an open tab follows
// the switch by itself, and when no tab is connected a browser is opened on it, so the brief always
// comes up. Otherwise start serving.
async function main() {
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && port !== 0) { process.stderr.write(`port ${port} in use by something else — picking a free one\n`); server.listen(0, "127.0.0.1"); }
    else { process.stderr.write(`${err.message}\n`); process.exit(1); }
  });
  if (port !== 0) {
    try {
      const meta = await probeViewer(port);
      if (meta) {
        const token = readToken(port);
        const r = token ? await fetch(`http://127.0.0.1:${port}/switch`, { method: "POST", headers: { "X-Viewer-Token": token }, body: JSON.stringify({ path: briefPath, root }) }) : null;
        if (r?.ok) {
          const j = await r.json().catch(() => ({}));
          const url = `http://127.0.0.1:${port}/?brief=${j.url ?? "/brief"}`;
          const tabs = typeof j.tabs === "number" ? j.tabs : 1; // an older server says nothing: assume a tab, as before
          process.stdout.write(`pr-brief viewer already running: ${url} now shows ${shortPath(briefPath)} (${tabs ? `the open tab${tabs > 1 ? "s update themselves" : " updates itself"}` : noOpen ? "no tab is open; --no-open given" : "no tab was open: opening one"})\n`);
          if (!tabs && !noOpen) openBrowser(url);
          return;
        }
        // a viewer we cannot talk to (another user's, or a stale token): serve on a free port instead of failing
        process.stderr.write(`pr-brief viewer on port ${port} ${token ? `refused the hand-off (HTTP ${r?.status})` : `was not started by you (no token at ${tokenFile(port)})`} — picking a free port\n`);
        serve(0); return;
      }
    } catch { /* nothing listening: start our own */ }
  }
  serve(port);
}
// Serve on port p (0: a free one) — with --detach, from a copy of this process in the background, so the
// caller (an agent's shell) is not held by a server that outlives it.
function serve(p: number): void {
  if (!detach) { server.listen(p, "127.0.0.1"); return; }
  const rest = args.filter((a, i) => a !== "--detach" && a !== "--port" && args[i - 1] !== "--port");
  const child = spawn(process.execPath, [process.argv[1], ...rest, "--port", String(p)], { cwd: process.cwd(), stdio: "ignore", detached: true });
  child.unref();
  process.stdout.write(`pr-brief viewer starting in the background${p ? ` on http://127.0.0.1:${p}/` : " on a free port"} for ${shortPath(briefPath)}${noOpen ? "" : " — opening a browser"}\n`);
}
server.once("listening", onListen); // once, however many listen() attempts it takes
main();
let tokenPath: string | null = null;
function writeToken(p: number): void {
  tokenPath = tokenFile(p);
  try { fs.rmSync(tokenPath, { force: true }); fs.writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600, flag: "wx" }); } // wx: never write through a file someone else planted
  catch (e: any) { process.stderr.write(`cannot write ${tokenPath} (${e?.code ?? e}): --stop and the hand-off from a second viewer.ts will not reach this server\n`); tokenPath = null; }
}
const removeToken = () => { if (tokenPath) { try { if (fs.readFileSync(tokenPath, "utf8").trim() === TOKEN) fs.rmSync(tokenPath, { force: true }); } catch { /* already gone */ } tokenPath = null; } };
process.on("exit", removeToken);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0)); // so 'exit' runs on Ctrl-C too
function onListen() {
  startWatchers();
  const addr = server.address();
  const p = typeof addr === "object" && addr ? addr.port : port;
  writeToken(p);
  const url = `http://127.0.0.1:${p}/?brief=/briefs/${cur().slug}`;
  process.stdout.write(`pr-brief viewer: ${url}\n  serving ${shortPath(briefPath)}${briefs.size > 1 ? ` and ${briefs.size - 1} more brief${briefs.size > 2 ? "s" : ""} from ${shortPath(stateRootOf(root))}/` : ""} — Ctrl-C to stop\n`);
  if (!noOpen) openBrowser(url);
}
