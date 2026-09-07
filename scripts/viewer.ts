#!/usr/bin/env node
// viewer.ts — serve the vendored editor (viewer/) on localhost and hand it the
// brief. Zero dependencies.
//
//   node scripts/viewer.ts [--out REVIEW_BRIEF.md] [--port N (default 8790)] [--no-open] [--verbose]
//   node scripts/viewer.ts --stop        ask the running viewer to exit
//
// Routes:
//   GET  /            the editor (static files from viewer/)
//   GET  /brief       the brief's current content on disk
//   PUT  /brief       replace the brief on disk (body = full text); refused unless
//                     the body still starts with review-brief front matter, so a
//                     stray save cannot destroy the cache
//   GET  /brief/meta  { path, mtime, viewer } — lets the editor detect changes on disk, and a viewer rebuild
//   GET  /events      server-sent events: `meta` (same JSON) on connect and whenever the brief file, the
//                     served brief (/switch) or the viewer build changes — open tabs never poll
//   GET  /file?path=P { name, path, content, rev, symbols } — a repo file as the brief sees it (symbols:
//                     the same units extract would find, for the editor's outline):
//                     at the briefed commit in commit mode, else the working tree
//                     (falling back to head, then base, for deleted files). Read-only.
//   POST /switch      { path } — point the running viewer at another brief (localhost only);
//                     a second `viewer.ts` uses this instead of starting a second server,
//                     so one tab at the fixed port always shows the latest brief
//
// The editor opens the brief through ?brief=/brief (brief mode in the editor),
// and writes back through PUT. The file on disk stays the source of truth.

import { createServer } from "node:http";
import { readFile, writeFile, stat, rename } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
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
const verbose = args.includes("--verbose"); // log every request
const stop = args.includes("--stop"); // tell the running viewer to exit
if (stop) {
  // stopping a server has nothing to do with the current directory: no git, no brief
  const r = await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST" }).catch(() => null);
  process.stdout.write(r?.ok ? `review-brief viewer on port ${port} stopped\n` : `no review-brief viewer on port ${port}\n`);
  process.exit(0);
}
const rootProbe = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (rootProbe.status !== 0) { process.stderr.write("viewer.ts: not inside a git repository\n"); process.exit(1); }
let root = rootProbe.stdout.trim(); // follows the brief on /switch
let briefPath = path.resolve(root, opt("--out", "REVIEW_BRIEF.md")!);

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
let repo = repoWeb(root);

// Build id of the served app (the VERSION stamp in sw.js), re-read on every call so an open tab
// notices a `build.mjs --stamp` and reloads itself.
function viewerBuild(): string | null {
  try { return fs.readFileSync(path.join(VIEWER, "sw.js"), "utf8").match(/VERSION = '([^']+)'/)?.[1] ?? null; } catch { return null; }
}

// Server-sent events. Every open tab holds one connection; it gets the current meta on connect and
// again whenever the brief file is rewritten (extract, lint, a fill, a save), /switch changes which
// brief is served, or sw.js is re-stamped. fs.watch on the directory catches editors that write by rename.
const clients = new Set<import("node:http").ServerResponse>();
async function metaJSON(): Promise<string> {
  const s = await stat(briefPath).catch(() => null);
  return JSON.stringify({ path: briefPath, name: path.basename(briefPath), mtime: s?.mtimeMs ?? null, viewer: viewerBuild(), repo });
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
let briefWatcher: fs.FSWatcher | null = null;
let polled: string | null = null; // the path fs.watchFile polls when fs.watch is unavailable (inotify limits, odd mounts)
function watchBrief(): void {
  briefWatcher?.close();
  if (polled) { fs.unwatchFile(polled); polled = null; }
  const dir = path.dirname(briefPath), name = path.basename(briefPath);
  try { briefWatcher = fs.watch(dir, (_event, file) => { if (!file || file === name) broadcastMeta(); }); }
  catch (e: any) {
    briefWatcher = null;
    process.stderr.write(`cannot watch ${dir} (${e?.code ?? e}); polling the brief every 2 s instead\n`);
    polled = briefPath;
    fs.watchFile(briefPath, { interval: 2000 }, () => broadcastMeta());
  }
}
function startWatchers(): void {
  watchBrief();
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
const server = createServer(async (req, res) => {
  // parsed against a fixed base: only the path and query are used, and a bad Host must not throw
  let url: URL;
  try { url = new URL(req.url ?? "/", "http://127.0.0.1"); } catch { res.writeHead(400); return res.end("bad request"); }
  // The untrusted party on a developer machine is the browser, and everything it sends comes from
  // 127.0.0.1. A Host that is not ours is a DNS-rebinding page; a POST or PUT with a foreign Origin is
  // a cross-site request. The CLI's own fetch sends no Origin.
  const host = req.headers.host ?? "";
  if (!OK_HOST.test(host)) { res.writeHead(421, { "Content-Type": types[".txt"] }); return res.end("misdirected request: this server answers to localhost only"); }
  const origin = req.headers.origin;
  if ((req.method === "POST" || req.method === "PUT") && typeof origin === "string" && origin !== `http://${host}`) { res.writeHead(403, { "Content-Type": types[".txt"] }); return res.end("cross-origin request refused"); }
  if (verbose) res.on("finish", () => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname}${url.search.slice(0, 120)} → ${res.statusCode}\n`));
  try {
    if (url.pathname === "/brief" && req.method === "GET") {
      const body = await readFile(briefPath, "utf8");
      res.writeHead(200, { "Content-Type": types[".md"], "Cache-Control": "no-store" });
      return res.end(body);
    }
    if (url.pathname === "/brief/meta" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
      return res.end(await metaJSON()); // mtime null while the file is missing: the server is still here
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
      const rel = url.searchParams.get("path") ?? "";
      const abs = path.resolve(root, rel);
      // containment on the real paths: a symlink inside the repository must not lead outside it
      let real = abs; try { real = fs.realpathSync(abs); } catch { /* not in the working tree: git show decides */ }
      const rootReal = fs.realpathSync(root);
      if (!rel || path.isAbsolute(rel) || rel.startsWith("-") || rel.split(/[\\/]/).includes("..") || !(abs + path.sep).startsWith(root + path.sep) || !(real + path.sep).startsWith(rootReal + path.sep)) { res.writeHead(422, { "Content-Type": types[".txt"] }); return res.end("path must be relative to the repository"); }
      const front = (await readFile(briefPath, "utf8")).split("\n---\n")[0];
      const fm = (k: string) => front.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1] ?? null;
      const mode = fm("mode"), head = fm("head"), base = fm("base");
      let content: string | null = null, rev = "working tree";
      const show = (r: string | null) => { if (!r || content !== null) return; const g = spawnSync("git", ["show", `${r}:${rel}`], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }); if (g.status === 0) { content = g.stdout; rev = r.slice(0, 7); } };
      if (mode !== "commit" && fs.existsSync(abs)) content = await readFile(abs, "utf8");
      show(head); show(base);
      if (content === null) { res.writeHead(404, { "Content-Type": types[".txt"] }); return res.end(`${rel} not found in the working tree, ${head?.slice(0, 7)} or ${base?.slice(0, 7)}`); }
      res.writeHead(200, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ name: path.basename(rel), path: rel, content, rev, mode, symbols: symbolsOf(rel, content) }));
    }
    if (url.pathname === "/stop" && req.method === "POST") {
      if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? "")) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { "Content-Type": types[".json"] });
      res.end(JSON.stringify({ ok: true }));
      process.stdout.write("stopping\n");
      setTimeout(() => process.exit(0), 50);
      return;
    }
    if (url.pathname === "/switch" && req.method === "POST") {
      if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? "")) { res.writeHead(403); return res.end(); }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const next = body.path;
      if (typeof next !== "string" || !path.isAbsolute(next) || !fs.existsSync(next) || !fs.statSync(next).isFile()) { res.writeHead(422); return res.end("path must be an existing absolute file"); }
      // only a brief can be served: the same front-matter gate PUT applies
      if (!/^---\nreview-brief: \d+\n/.test(fs.readFileSync(next, "utf8").slice(0, 64))) { res.writeHead(422); return res.end("refused: not a review brief"); }
      briefPath = next;
      // the brief's repository is where /file reads from: take it from the caller, else from the brief's directory
      const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: path.dirname(next), encoding: "utf8" });
      root = typeof body.root === "string" && fs.existsSync(body.root) && fs.statSync(body.root).isDirectory() ? body.root : r.status === 0 ? r.stdout.trim() : root;
      repo = repoWeb(root);
      process.stdout.write(`now serving ${briefPath} (repo ${root})\n`);
      watchBrief();
      broadcastMeta();
      res.writeHead(200, { "Content-Type": types[".json"] });
      return res.end(JSON.stringify({ ok: true, path: briefPath }));
    }
    if (url.pathname === "/brief" && req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      if (!/^---\nreview-brief: \d+\n/.test(body)) {
        res.writeHead(422, { "Content-Type": types[".txt"] });
        return res.end("refused: body does not start with review-brief front matter");
      }
      // the client says which version it read (X-Brief-Mtime); a file that moved on since is not overwritten
      const expect = Number(req.headers["x-brief-mtime"]);
      if (Number.isFinite(expect)) {
        const cur = await stat(briefPath).catch(() => null);
        if (cur && Math.abs(cur.mtimeMs - expect) > 1) { res.writeHead(412, { "Content-Type": types[".txt"] }); return res.end("the brief changed on disk since you read it — reload (:rel) and save again"); }
      }
      // write beside, then rename over: a reader never sees a truncated brief
      const tmpPath = `${briefPath}.${process.pid}.tmp`;
      await writeFile(tmpPath, body);
      await rename(tmpPath, briefPath);
      const s = await stat(briefPath);
      res.writeHead(200, { "Content-Type": types[".json"] });
      return res.end(JSON.stringify({ ok: true, mtime: s.mtimeMs }));
    }
    let file = path.normalize(path.join(VIEWER, decodeURIComponent(url.pathname)));
    if (!file.startsWith(VIEWER)) { res.writeHead(403); return res.end(); }
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "Service-Worker-Allowed": "/" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": types[".txt"] });
    res.end("Not found");
  }
});

// If a review-brief viewer is already running on the port, hand it this brief and
// exit: the open tab follows the switch by itself. Otherwise start serving.
async function main() {
  if (port !== 0) {
    try {
      const meta = await fetch(`http://127.0.0.1:${port}/brief/meta`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (meta && typeof meta.path === "string" && "viewer" in meta) { // a review-brief viewer, whatever state its brief is in
        const r = await fetch(`http://127.0.0.1:${port}/switch`, { method: "POST", body: JSON.stringify({ path: briefPath, root }) });
        if (r.ok) { process.stdout.write(`review-brief viewer already running: http://127.0.0.1:${port}/?brief=/brief now shows ${path.relative(root, briefPath)} (the open tab updates itself)\n`); return; }
      }
    } catch { /* nothing listening: start our own */ }
  }
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && port !== 0) { process.stderr.write(`port ${port} in use by something else — picking a free one\n`); server.listen(0, "127.0.0.1", onListen); }
    else { process.stderr.write(`${err.message}\n`); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", onListen);
}
main();
function onListen() {
  startWatchers();
  const addr = server.address();
  const p = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://127.0.0.1:${p}/?brief=/brief`;
  process.stdout.write(`review-brief viewer: ${url}\n  serving ${path.relative(root, briefPath)} — Ctrl-C to stop\n`);
  if (!noOpen) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  }
}
