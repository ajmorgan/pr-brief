// Application entry: wires the components together, owns documents and
// settings, and handles keyboard shortcuts, vim ex-commands and PWA hooks.

import './src/components/editor-pane.js';
import './src/components/markdown-preview.js';
import './src/components/file-list.js';
import './src/components/command-palette.js';
import './src/components/status-bar.js';
import './src/components/app-toast.js';
import './src/components/help-dialog.js';
import './src/components/brief-outline.js';

import { schemes, applyScheme, getScheme, defaultDark, defaultLight, schemeCSS } from './src/lib/themes.js';
import { loadSettings, saveSettings, onExternalSettingsChange } from './src/lib/settings.js';
import * as store from './src/lib/store.js';
import * as files from './src/lib/files.js';
import { textStats, markdownToHTML, setBriefRendering } from './src/lib/markdown.js';
import * as briefs from './src/lib/brief.js';
import { debounce, modKey } from './src/lib/state.js';
import { languages, plainText } from './vendor/editor.js';
import { WELCOME, WELCOME_NAME } from './src/welcome.js';

const $ = (sel) => document.querySelector(sel);
const els = {
  app: $('#app'), editor: $('#editor'), preview: $('#preview'), files: $('#files'),
  palette: $('#palette'), status: $('#status'), toast: $('#toast'), help: $('#help'), outline: $('#outline'),
  workspace: $('#workspace'), name: $('#doc-name'), divider: $('#divider'),
  install: $('#btn-install'), sidebarToggle: $('#btn-sidebar'),
  dirty: $('#doc-dirty'), docActions: $('#doc-actions'), diffSwitch: $('#diff-switch'), more: $('#more'), moreBtn: $('#btn-more'), moreMenu: $('#more-menu'),
};

const settings = loadSettings();
const narrow = matchMedia('(max-width: 800px)');
// On phones the sidebar is an overlay that starts closed; that choice is
// session-only so it never leaks into the persisted desktop preference.
let sidebarOpen = narrow.matches ? false : settings.sidebar;
let docs = [];
let active = null;          // the active document record
let diskDirty = false;      // active doc differs from what is on disk
let activePane = 'editor';  // which pane the user is scrolling
let installPrompt = null;
let brief = null;           // parsed pr-brief model when the active doc is one
const briefFrom = () => (active?.remote ? new URL(active.remote).pathname : null); // the served brief's path, carried on its file links
const bootTime = Date.now();

// --- Theme -------------------------------------------------------------------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function currentSchemeId() {
  return settings.theme ?? (darkQuery.matches ? defaultDark : defaultLight);
}

function applyTheme() {
  const s = applyScheme(currentSchemeId());
  els.editor.setDark(s.dark);
  els.status.update({ theme: s.name });
}

darkQuery.addEventListener('change', () => { if (!settings.theme) applyTheme(); });

// --- Settings ----------------------------------------------------------------
function isMarkdown() {
  return els.editor.languageName === 'Markdown';
}

function effectiveView() {
  return isMarkdown() ? settings.view : 'editor';
}

function applySettings({ persist = true } = {}) {
  els.editor.applySettings(settings);
  setBriefRendering(!!brief, { split: settings.diffView === 'split', from: briefFrom() });
  els.app.dataset.view = effectiveView();
  // a hidden editor must not keep the keyboard: WebKit still routes typed text to a focused
  // contenteditable after it is display:none, so a stray key in preview view would edit the document
  if (effectiveView() === 'preview') els.editor.blur();
  els.app.classList.toggle('sidebar-hidden', !sidebarOpen);
  els.app.classList.toggle('zen', settings.zen);
  els.workspace.style.setProperty('--split', `${settings.split}%`);
  // a source file has no preview: Edit shows as the live selection, the other two say why they are off
  const md = isMarkdown();
  for (const btn of document.querySelectorAll('button[data-view]')) {
    const v = btn.dataset.view;
    btn.setAttribute('aria-pressed', String(v === effectiveView()));
    btn.disabled = !md && v !== 'editor';
    if (!btn.dataset.title) btn.dataset.title = btn.title;
    btn.title = btn.disabled ? `Preview applies to Markdown; ${els.editor.languageName} shows in the editor only` : btn.dataset.title;
  }
  // brief mode: the diff layout is the one option worth a control; New/Open/Save only apply to ordinary files
  els.diffSwitch.hidden = !brief;
  for (const btn of els.diffSwitch.querySelectorAll('button[data-diff]')) btn.setAttribute('aria-pressed', String(btn.dataset.diff === settings.diffView));
  els.docActions.hidden = !!(active?.remote || active?.readOnly);
  const checks = { vim: settings.vim, wrap: settings.lineWrap, numbers: settings.lineNumbers, sync: settings.scrollSync };
  for (const [k, v] of Object.entries(checks)) els.moreMenu.querySelector(`[data-menu="${k}"]`)?.setAttribute('aria-checked', String(!!v));
  els.moreMenu.querySelector('[data-menu="zen"]').textContent = settings.zen ? 'Leave zen mode' : 'Zen mode';
  els.sidebarToggle.setAttribute('aria-expanded', String(sidebarOpen));
  if (persist) saveSettings(settings);
  schedulePreview();
}

function update(patch) {
  Object.assign(settings, patch);
  applySettings();
}

function toggleSidebar(open = !sidebarOpen) {
  sidebarOpen = open;
  if (!narrow.matches) settings.sidebar = open;
  applySettings();
}

onExternalSettingsChange((fresh) => {
  Object.assign(settings, fresh);
  applyTheme();
  applySettings({ persist: false });
});

// --- Documents ---------------------------------------------------------------
async function refreshList() {
  docs = await store.listDocuments();
  // one document per served brief: a duplicate (two syncs racing, a copy left by an older build) is dropped, the active one kept
  const byRemote = new Map(); const extra = [];
  for (const d of docs) { if (!d.remote) continue; const k = byRemote.get(d.remote); if (!k) byRemote.set(d.remote, d); else if (d.id === active?.id) { extra.push(k); byRemote.set(d.remote, d); } else extra.push(d); }
  if (extra.length) { for (const d of extra) { await store.deleteDocument(d.id); els.editor.forgetDocument(d.id); positions.delete(d.id); } docs = await store.listDocuments(); }
  els.files.documents = docs;
  els.files.activeId = active?.id ?? null;
}

// Where each open document was last left (cursor line, preview scroll), so switching documents in the
// Open list — or closing one and landing on another — returns to that place instead of the top.
const positions = new Map();
function currentPosition() {
  // the preview's place is kept as a source line, not an offset: after a re-render the offsets of
  // cards the browser skips are estimates, while scrollToLine lays the target out and lands exactly
  const p = els.preview.lineAtScrollTop(els.preview.scrollTop);
  return { line: els.editor.cursorLine, previewLine: p.line, previewFraction: p.fraction || 0 };
}
function rememberPosition() {
  if (active) positions.set(active.id, currentPosition());
}
function applyPosition(pos) {
  if (!pos) return;
  if (pos.line > 1) { els.editor.revealLine(pos.line); els.editor.gotoLine(pos.line); }
  if (pos.previewLine > 1) requestAnimationFrame(() => els.preview.scrollToLine(pos.previewLine, pos.previewFraction));
}

async function openDocument(id) {
  const doc = docs.find((d) => d.id === id) ?? await store.getDocument(id);
  if (!doc) return false;
  autosave.flush();
  refreshBrief.cancel(); // a pending refresh holds the outgoing document's text
  rememberPosition();
  active = doc;
  diskDirty = !!doc.dirty && !doc.readOnly;
  els.editor.openDocument(doc.id, doc.content, doc.name);
  els.editor.setReadOnly(!!doc.readOnly);
  enterBriefMode(doc.content, { fold: true });
  startWatch();
  els.name.value = doc.name;
  document.title = `${doc.name} · xor`;
  els.files.activeId = doc.id;
  settings.lastDocId = doc.id;
  // the address bar names the active document, so a history entry never points at a file that was closed
  const url = doc.remote ? `?brief=${new URL(doc.remote).pathname}` : doc.source ? `?file=${encodeURIComponent(doc.source)}` : location.pathname;
  if (location.search !== (url.startsWith('?') ? url : '')) history.replaceState(history.state, '', url);
  saveSettings(settings);
  applySettings({ persist: false });
  updateSavedStatus();
  updateStats(doc.content);
  renderPreview.flush();
  // this page's memory first; else the place saved when a page left this brief for a file link
  applyPosition(positions.get(doc.id) ?? (doc.remote ? takeStoredPosition(doc.remote) : null));
  els.editor.focus();
  return true;
}

async function createDocument({ name, content = '', handle = null, remote = null, mtime = null, path = null, open = true } = {}) {
  const doc = store.createDocument({ name: name || uniqueName('Untitled.md'), content, handle, remote, mtime });
  if (path) doc.path = path;
  await store.putDocument(doc);
  await refreshList();
  if (open) await openDocument(doc.id);
  return doc;
}

function uniqueName(base) {
  const names = new Set(docs.map((d) => d.name));
  if (!names.has(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem} ${i}${ext}`;
    if (!names.has(candidate)) return candidate;
  }
}

async function deleteDocument(id) {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  await store.deleteDocument(id);
  els.editor.forgetDocument(id);
  positions.delete(id);
  await refreshList();
  els.toast.show(`Deleted ${doc.name}`, {
    action: 'Undo',
    onAction: async () => { await store.putDocument(doc); await refreshList(); if (!active) openDocument(doc.id); },
  });
  if (active?.id === id) {
    active = null;
    if (docs.length) await openDocument(docs[0].id);
    else await createDocument({});
  }
}

/** Drop a copy (remote brief, read-only source file) from the list; nothing on disk changes. */
async function closeDocumentById(id) {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  if (doc.remote) rememberClosed(doc.path ?? doc.remote, true); // a brief closed with × stays closed, across reloads and tabs
  if (active?.id === id) autosave.flush();
  await store.deleteDocument(id);
  els.editor.forgetDocument(id);
  positions.delete(id);
  await refreshList();
  if (active?.id === id) {
    active = null;
    if (docs.length) await openDocument(docs[0].id);
    else await createDocument({});
  }
  els.toast.show(`Closed ${doc.name}`);
}

async function closeDocument() {
  if (!active) return;
  autosave.flush();
  const id = active.id;
  const others = docs.filter((d) => d.id !== id);
  if (others.length) await openDocument(others[0].id);
  else await createDocument({});
}

async function renameDocument(name) {
  name = name.trim();
  if (!active || !name || name === active.name) { els.name.value = active?.name ?? ''; return; }
  active.name = name;
  active.updatedAt = Date.now();
  await store.putDocument(active);
  els.editor.setLanguageFromName(name);
  document.title = `${name} · xor`;
  updateStats(els.editor.getValue());
  await refreshList();
  applySettings({ persist: false });
}

// Autosave to IndexedDB: every keystroke is debounced, then persisted.
const autosave = debounce(async () => {
  if (!active) return;
  const content = els.editor.getValue();
  if (content === active.content) return;
  active.content = content;
  active.updatedAt = Date.now();
  try {
    await store.putDocument(active);
    els.files.documents = docs = [active, ...docs.filter((d) => d.id !== active.id)];
    els.files.activeId = active.id;
    updateSavedStatus();
  } catch (err) {
    els.toast.show(`Could not save: ${err.message}`, { kind: 'error' });
  }
}, 400);

function updateSavedStatus(text) {
  els.dirty.hidden = !(active && diskDirty && !active.readOnly);
  if (text) { els.status.update({ saved: text }); return; }
  if (!active) { els.status.update({ saved: '' }); return; }
  if (active.readOnly) {
    els.status.update({ saved: `Read-only · ${active.name} @ ${active.rev}` });
  } else if (active.handle || active.remote) {
    els.status.update({ saved: diskDirty ? `● Unsaved to disk (${modKey} S)` : `Saved to ${active.name}` });
  } else {
    els.status.update({ saved: 'Autosaved in browser' });
  }
}

function updateStats(content) {
  if (brief) { updateBriefStatus(els.editor.cursorLine); els.status.update({ lang: els.editor.languageName }); return; }
  if (isMarkdown()) {
    const { words, minutes } = textStats(content);
    els.status.update({ words: `${words.toLocaleString()} words · ${minutes} min read` });
  } else {
    els.status.update({ words: `${content.split('\n').length.toLocaleString()} lines` });
  }
  els.status.update({ lang: els.editor.languageName });
}

// --- Saving to disk ----------------------------------------------------------
async function save() {
  if (!active) return;
  if (active.readOnly) { els.toast.show(`${active.name} is read-only: it is ${active.source} as of ${active.rev}`, { kind: 'error' }); return; }
  autosave.flush();
  if (active.handle || active.remote) {
    try {
      // Refuse to clobber a file someone else wrote since we read it (an agent
      // regenerating a brief, another editor): the user reloads first.
      if (active.mtime != null && await changedOnDisk()) {
        els.toast.show(`${active.name} changed on disk since you opened it. Reload (:rel) before saving.`, { kind: 'error', duration: 8000, action: 'Reload', onAction: reload });
        return;
      }
      const content = els.editor.getValue();
      if (active.remote) {
        active.mtime = await files.putRemote(active.remote, content, active.mtime);
        active.dirty = false;
      } else {
        const ok = await files.writeToHandle(active.handle, content);
        if (!ok) { els.toast.show('Permission to write the file was denied', { kind: 'error' }); return; }
        active.mtime = (await active.handle.getFile()).lastModified;
        active.dirty = false;
      }
      await store.putDocument(active);
      diskDirty = false; updateSavedStatus(); els.toast.show(`Saved ${active.name}`);
    } catch (err) {
      els.toast.show(`Save failed: ${err.message}`, { kind: 'error' });
    }
  } else {
    await saveAs();
  }
}

async function changedOnDisk() {
  const now = active.remote ? await files.remoteMtime(active.remote) : (await active.handle.getFile()).lastModified;
  return Math.abs(now - active.mtime) > 1; // filesystems round mtimes
}

/** Re-read the active document from disk or the server, replacing the editor text. */
async function reload({ quiet = false } = {}) {
  if (!active || !(active.handle || active.remote)) { els.toast.show('This document is not linked to a file'); return; }
  try {
    const fresh = active.remote ? await files.fetchRemote(active.remote) : await files.readHandle(active.handle);
    const line = els.editor.cursorLine;
    const scrollTop = els.editor.view.scrollDOM.scrollTop;
    els.editor.setValue(fresh.content);
    active.content = fresh.content;
    active.mtime = fresh.mtime;
    active.dirty = false;
    active.updatedAt = Date.now();
    const switched = fresh.name && fresh.name !== active.name;
    if (switched) { active.name = fresh.name; els.name.value = fresh.name; document.title = `${fresh.name} · xor`; }
    await store.putDocument(active);
    diskDirty = false;
    // an explicit :rel (or a switch to another brief) re-folds the hunks; a background refresh keeps the reader's view
    enterBriefMode(fresh.content, { fold: !quiet || switched });
    if (quiet && !switched) { els.editor.gotoLine(line); els.editor.view.scrollDOM.scrollTop = scrollTop; }
    else els.editor.gotoLine(switched ? 1 : line);
    if (switched) await refreshList();
    updateSavedStatus();
    if (!quiet) els.toast.show(`Reloaded ${active.name}`);
  } catch (err) {
    if (!quiet) els.toast.show(`Reload failed: ${err.message}`, { kind: 'error' });
  }
}

// --- Watch linked files: pick up regenerations (an agent rewriting a brief)
// without a manual reload. Unsaved edits are never overwritten: then it only
// offers a reload, once per change. A brief served by the viewer is pushed to
// over server-sent events; a local file handle still has to be polled.
let watchTimer = null;
let watchSource = null;
let watchNotifiedFor = null;
let viewerBuild = null; // the served app's build id when this page loaded; a change means the viewer was rebuilt
let briefMeta = null;   // the last meta frame from the viewer server (path, mtime, viewer build, repo web URL)
function startWatch() {
  clearInterval(watchTimer);
  watchTimer = null;
  watchSource?.close();
  watchSource = null;
  if (!active || !(active.handle || active.remote) || active.mtime == null) return;
  if (active.remote && 'EventSource' in window) {
    // the server sends the current meta on connect and after every change; a dropped connection
    // reconnects by itself and gets the current meta again, so nothing is missed
    watchSource = new EventSource(new URL('/events', active.remote));
    watchSource.addEventListener('meta', (e) => { try { onWatchMeta(JSON.parse(e.data)); } catch { /* malformed frame */ } });
    return;
  }
  watchTimer = setInterval(() => { if (!document.hidden) onWatchMeta(null); }, 2000);
}

async function onWatchMeta(meta) {
  if (!active) return;
  try {
    if (active.remote) {
      meta ??= await files.remoteMeta(active.remote);
      // the frame describes every served brief: this document's own entry decides its mtime and repo (the top level is the current brief)
      const mine = Array.isArray(meta.briefs) ? meta.briefs.find((b) => new URL(b.url, active.remote).toString() === active.remote) ?? null : null;
      briefMeta = mine ? { ...meta, ...mine, viewer: meta.viewer } : meta;
      // the viewer's own code was rebuilt (build.mjs --stamp): this page is stale, reload it
      if (meta.viewer) {
        if (viewerBuild === null) viewerBuild = meta.viewer;
        else if (meta.viewer !== viewerBuild) {
          if (!diskDirty) { location.reload(); return; }
          if (watchNotifiedFor !== 'viewer') {
            watchNotifiedFor = 'viewer';
            els.toast.show('The viewer was updated. Save (:w) or reload to pick it up.', { duration: 10000, action: 'Reload', onAction: () => location.reload() });
          }
          return;
        }
      }
      await syncBriefs(meta, active.remote);
      if (await followCurrent(meta, active.remote)) return;
      if (typeof briefMeta.mtime !== 'number' || Math.abs(briefMeta.mtime - active.mtime) <= 1) return; // filesystems round mtimes
    } else if (!(await changedOnDisk())) return;
    if (diskDirty) {
      const now = active.remote ? briefMeta.mtime : (await active.handle.getFile()).lastModified;
      if (watchNotifiedFor === now) return;
      watchNotifiedFor = now;
      els.toast.show(`${active.name} changed on disk. Your unsaved edits are kept; reload to see the new version.`, { duration: 8000, action: 'Reload', onAction: reload });
      return;
    }
    await reload({ quiet: true });
  } catch { /* server gone or permission lost: the next event or tick tries again */ }
}

async function saveAs() {
  if (!active) return;
  autosave.flush();
  try {
    const result = await files.saveAs(active.name, els.editor.getValue());
    if (!result) return;
    if (result.handle) {
      active.handle = result.handle;
      active.remote = null;
      active.mtime = (await result.handle.getFile()).lastModified;
      active.dirty = false;
      active.name = result.name;
      els.name.value = result.name;
      await store.putDocument(active);
      els.editor.setLanguageFromName(result.name);
      await refreshList();
      diskDirty = false;
      startWatch(); // the file is linked now: watch it like any other
      updateSavedStatus();
      els.toast.show(`Saved to ${result.name}. ${modKey} S now writes to this file.`);
    } else {
      els.toast.show(`Downloaded ${result.name}`);
    }
  } catch (err) {
    els.toast.show(`Save failed: ${err.message}`, { kind: 'error' });
  }
}

async function importFiles(list) {
  if (!list.length) return;
  let last = null;
  for (const f of list) {
    // Re-opening a file already linked by handle just switches to it.
    let existing = null;
    if (f.handle) {
      for (const d of docs) {
        if (d.handle && await d.handle.isSameEntry?.(f.handle)) { existing = d; break; }
      }
    }
    if (existing) {
      if (existing.dirty && existing.content === f.content) { existing.dirty = false; await store.putDocument(existing); }
      if (existing.dirty) {
        // the browser copy carries edits not yet on disk: keep them, say if the disk moved on
        if ((f.mtime ?? null) !== existing.mtime) els.toast.show(`${existing.name} changed on disk. Your unsaved edits are kept; reload to see the new version.`, { duration: 8000 });
      } else {
        existing.content = f.content;
        existing.mtime = f.mtime ?? null;
        existing.updatedAt = Date.now();
        await store.putDocument(existing);
        els.editor.forgetDocument(existing.id);
      }
      last = existing;
    } else {
      last = await createDocument({ name: f.name, content: f.content, handle: f.handle, mtime: f.mtime ?? null, open: false });
    }
  }
  await refreshList();
  if (last) await openDocument(last.id);
  els.toast.show(list.length === 1 ? `Opened ${list[0].name}` : `Opened ${list.length} files`);
}

async function openFromDisk() {
  try {
    await importFiles(await files.openFiles());
  } catch (err) {
    els.toast.show(`Could not open: ${err.message}`, { kind: 'error' });
  }
}

function exportHTML() {
  if (!active) return;
  const body = markdownToHTML(els.editor.getValue());
  const css = previewCSS();
  const title = active.name.replace(/\.[^.]+$/, '');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${schemeCSS(currentSchemeId())}
:root{--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"JetBrains Mono","Fira Code",Menlo,Consolas,monospace}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans)}
.markdown-body{max-width:46rem;margin:0 auto;padding:3rem 1.5rem}
${css}</style></head>
<body><article class="markdown-body">${body}</article></body></html>`;
  files.download(`${title}.html`, html, 'text/html');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The preview typography and syntax rules from app.css, for standalone exports. */
function previewCSS() {
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch { continue; }
    for (const rule of list) {
      const sel = rule.selectorText ?? '';
      if (sel.includes('.markdown-body') || sel.startsWith('.tok-') || sel.startsWith('kbd')) rules.push(rule.cssText);
    }
  }
  return rules.join('\n');
}

// --- Preview -----------------------------------------------------------------
const renderPreview = debounce(() => {
  if (!active) return;
  if (isMarkdown() && effectiveView() !== 'editor') els.preview.render(els.editor.getValue());
  else els.preview.clear();
}, 120);

function schedulePreview() { renderPreview(); }

// --- Wiring: editor events ---------------------------------------------------
els.editor.addEventListener('doc-change', (e) => {
  if (active?.handle || active?.remote) { diskDirty = true; active.dirty = true; updateSavedStatus(); } // dirty is persisted by the autosave
  autosave();
  updateStats(e.detail.value);
  renderPreview();
  refreshBrief(e.detail.value);
});

els.editor.addEventListener('cursor-change', (e) => {
  els.status.update({ line: e.detail.line, col: e.detail.col, selected: e.detail.selected });
  if (outline) { els.outline.line = e.detail.line; updateBriefStatus(e.detail.line); }
});

els.editor.addEventListener('vim-mode', (e) => {
  els.status.update({ mode: settings.vim ? e.detail.mode : '' });
});

els.editor.addEventListener('editor-scroll', (e) => {
  if (!settings.scrollSync || activePane !== 'editor' || effectiveView() !== 'split') return;
  if (e.detail.atBottom) els.preview.scrollToBottom();
  else els.preview.scrollToLine(e.detail.line, e.detail.fraction);
});

els.preview.addEventListener('preview-scroll', (e) => {
  if (!settings.scrollSync || activePane !== 'preview' || effectiveView() !== 'split') return;
  if (e.detail.atBottom) els.editor.scrollToBottom();
  else els.editor.scrollToLine(e.detail.line, e.detail.fraction);
});

els.preview.addEventListener('preview-section', (e) => {
  // the outline follows what is being read: the preview when it is the only pane, or when it is the pane being scrolled
  if (!outline || !brief) return;
  if (effectiveView() === 'editor' || (effectiveView() === 'split' && activePane !== 'preview')) return;
  els.outline.line = e.detail.line;
  updateBriefStatus(e.detail.line);
});

els.preview.addEventListener('copy-unit', (e) => { if (brief) copyUnit(briefs.unitAt(brief, e.detail.line)); });

els.preview.addEventListener('goto-line', (e) => {
  if (effectiveView() === 'preview') update({ view: 'split' });
  els.editor.gotoLine(e.detail.line);
});

for (const [el, name] of [[els.editor, 'editor'], [els.preview, 'preview']]) {
  el.addEventListener('pointerenter', () => { activePane = name; });
  el.addEventListener('wheel', () => { activePane = name; }, { passive: true });
  el.addEventListener('touchstart', () => { activePane = name; }, { passive: true });
}
els.editor.addEventListener('keydown', () => { activePane = 'editor'; });

// --- Vim ex-commands ---------------------------------------------------------
els.editor.addEventListener('ex-command', async (e) => {
  const { name, args, argString } = e.detail;
  const arg = argString.trim();
  switch (name) {
    case 'write': await save(); break;
    case 'wq': await save(); await closeDocument(); break;
    case 'quit': await closeDocument(); break;
    case 'saveas': await saveAs(); break;
    case 'new': await createDocument({ name: arg || undefined }); break;
    case 'edit': {
      if (!arg) { await openFromDisk(); break; }
      const match = docs.find((d) => d.name === arg) ?? docs.find((d) => d.name.toLowerCase().startsWith(arg.toLowerCase()));
      if (match) await openDocument(match.id);
      else await createDocument({ name: arg });
      break;
    }
    case 'set': for (const opt of args) applyVimOption(opt); break;
    case 'colorscheme':
      if (!arg) { pickTheme(); break; }
      { const s = schemes.find((x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase() || x.id.replace(/-/g, '') === arg.toLowerCase());
        if (s) { update({ theme: s.id }); applyTheme(); } else els.toast.show(`Unknown scheme "${arg}". Try :colo to list them.`, { kind: 'error' }); }
      break;
    case 'preview': update({ view: settings.view === 'preview' ? 'editor' : 'preview' }); break;
    case 'split': update({ view: 'split' }); break;
    case 'zen': update({ zen: !settings.zen }); break;
    case 'help': els.help.toggle(); break;
    case 'files': toggleSidebar(); break;
    case 'language': arg ? setLanguage(arg) : pickLanguage(); break;
    case 'export': exportHTML(); break;
    case 'reload': await reload(); break;
    // pr-brief mode
    case 'unit': if (!requireOutline()) break; arg ? jumpToUnit(briefs.findUnit(outline, arg), arg) : pickUnit(); break;
    case 'file': if (!requireOutline()) break; { const f = arg ? briefs.findFile(outline, arg) : null; if (f) gotoBriefLine(f.line); else if (arg) els.toast.show(`No file matching "${arg}"`, { kind: 'error' }); else pickBriefFile(); } break;
    case 'unit-next': case 'unit-prev': if (!requireOutline()) break; jumpToUnit(briefs.stepUnit(outline, els.editor.cursorLine, name === 'unit-next' ? 1 : -1, els.outline.changedOnly)); break;
    case 'note': if (!requireBrief()) break; editNote(); break;
    case 'copy': if (!requireBrief()) break; copyUnit(briefs.unitAt(brief, els.editor.cursorLine)); break;
    case 'changed': if (!requireOutline()) break; els.outline.toggleChanged(); els.toast.show(els.outline.changedOnly ? (brief ? 'Showing units changed since the last brief' : 'Showing only symbols that are in the brief') : (brief ? 'Showing all units' : 'Showing all symbols')); break;
  }
});

// --- PR-brief mode -------------------------------------------------------
// A document whose front matter starts `pr-brief:` gets an outline, folded
// hunks, unit motions and a :note command. Everything else stays as it is.
function enterBriefMode(content, { fold = false } = {}) {
  const on = briefs.isBrief(content);
  if (on) brief = briefs.parseBrief(content);
  else brief = null;
  els.app.classList.toggle('brief', on);
  els.editor.setBrief(on);
  setBriefRendering(on, { split: settings.diffView === 'split', from: briefFrom() });
  if (on && fold) els.editor.foldHunks();
  setOutline();
  if (!outline) els.status.update({ words: undefined });
}

// --- Outline: the brief's files and units, or the active source file's symbols ---
let outline = null;

/** A brief-shaped model for a read-only source file, from the symbols the viewer server sent. */
function sourceOutline(doc) {
  if (!doc?.source || !Array.isArray(doc.symbols)) return null;
  const briefDoc = (doc.from && docs.find((d) => d.remote && new URL(d.remote).pathname === doc.from)) || docs.find((d) => d.remote && briefs.isBrief(d.content));
  const inBrief = new Set(briefDoc ? briefs.parseBrief(briefDoc.content).units.map((u) => u.id) : []);
  const file = { path: doc.source, status: doc.rev ?? '', line: 1, end: doc.content.split('\n').length, hash: '', units: [] };
  file.units = doc.symbols.map((s, index) => ({
    id: s.id, kind: s.kind, status: '', hash: '', line: s.line, end: s.end, heading: s.display,
    name: s.scope ? `${s.scope}.${s.name}` : s.name, touched: false, badge: inBrief.has(s.id) ? 'brief' : '', file, index,
  }));
  return { files: [file], units: file.units, overviewLine: null, lines: file.end };
}

function setOutline() {
  outline = brief ?? sourceOutline(active);
  els.app.classList.toggle('outline', !!outline);
  els.files.toggleAttribute('compact', !!outline);
  els.outline.mode = brief ? 'brief' : 'file';
  els.outline.brief = outline;
  if (outline) { els.outline.line = els.editor.cursorLine; updateBriefStatus(els.editor.cursorLine); }
}

function requireOutline() {
  if (outline) return true;
  els.toast.show('No outline for this document', { kind: 'error' });
  return false;
}

const refreshBrief = debounce((content) => {
  if (!brief && !briefs.isBrief(content)) return;
  const wasOn = !!brief;
  brief = briefs.isBrief(content) ? briefs.parseBrief(content) : null;
  if (!!brief !== wasOn) { enterBriefMode(content); return; }
  setOutline();
}, 300);

function updateBriefStatus(line) {
  if (!outline) return;
  const u = briefs.unitAt(outline, line);
  const noun = brief ? 'unit' : 'symbol';
  const changed = outline.units.filter((x) => x.touched || x.badge).length;
  els.status.update({ words: (u ? `${noun} ${u.index + 1}/${outline.units.length}` : `${outline.units.length} ${noun}s`) + (changed ? (brief ? ` · ${changed} changed` : ` · ${changed} in brief`) : '') });
}

function requireBrief() {
  if (brief) return true;
  els.toast.show('Not a PR brief (no `pr-brief:` front matter)', { kind: 'error' });
  return false;
}

function gotoBriefLine(line) {
  els.editor.revealLine(line);
  els.editor.gotoLine(line);
  // an explicit jump (outline click, :unit, ]u) moves the preview whenever it is visible, scroll-sync or not
  if (effectiveView() !== 'editor') els.preview.scrollToLine(line);
}

function jumpToUnit(unit, query) {
  if (!unit) { els.toast.show(query ? `No unit matching "${query}"` : 'No units', { kind: 'error' }); return; }
  gotoBriefLine(unit.line);
}

async function pickUnit() {
  const items = outline.units.map((u) => ({ id: u.index, label: `${u.file.path.split('/').pop()} › ${u.name}`, hint: [u.status, u.touched ? 'touched' : u.badge].filter(Boolean).join(' · ') }));
  const item = await els.palette.open(items, { placeholder: 'Go to unit…' });
  if (item) jumpToUnit(outline.units[item.id]);
}

async function pickBriefFile() {
  const items = outline.files.map((f) => ({ id: f.line, label: f.path, hint: `${f.status} · ${f.units.length}` }));
  const item = await els.palette.open(items, { placeholder: 'Go to file…' });
  if (item) gotoBriefLine(item.id);
}

/** A unit as a PR comment: the reviewer's Notes up front, the brief's Context and Changes as folded
 *  context (unfolded when there are no Notes), headed by the unit's location — a link to the lines on
 *  the repository's web UI when the briefed code is committed, plain text otherwise. */
function unitAsComment(unit) {
  const text = els.editor.getValue();
  const slots = briefs.unitSlots(text, unit);
  const loc = briefs.unitLocation(unit);
  const fm = (k) => text.match(new RegExp(`^${k}: (\\S+)$`, 'm'))?.[1] ?? null;
  const committed = fm('mode') === 'commit' || fm('worktree') === 'clean';
  const head = fm('head');
  const deleted = unit.status === 'deleted';
  let where = loc ? `\`${loc.path}:${loc.start}-${loc.end}\`` : `\`${unit.file?.path ?? unit.name}\``;
  if (deleted) where = `was ${where}`; // the old-side span: those lines hold something else at head, so no link
  if (loc && !deleted && committed && briefMeta?.repo && head) where = `[${where}](${briefMeta.repo}/blob/${head}/${loc.path}#L${loc.start}-L${loc.end})`;
  const sig = unit.heading.replace(/ — .*$/, '').trim(); // `sig` — status · `path:lines` → `sig`
  const status = unit.status === 'other' ? '' : ` — ${unit.status}`;
  const context = [slots.purpose && `**${slots.contextLabel ?? 'Context'}:** ${slots.purpose}`, slots.changes && `**Changes:** ${slots.changes}`].filter(Boolean).join('\n\n');
  const head3 = `**${where}** ${sig}${status}`;
  const md = slots.notes
    ? `${head3}\n\n${slots.notes}\n\n<details><summary>Context from the PR brief</summary>\n\n${context}\n\n</details>`
    : `${head3}\n\n${context}`;
  return { markdown: md.trim() + '\n', html: markdownToHTML(md) };
}

/** Write text and HTML together, so a rich editor (GitHub's comment box) keeps links and emphasis. */
async function copyRich({ markdown, html }) {
  if ('ClipboardItem' in window && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([markdown], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    })]);
  } else {
    await navigator.clipboard.writeText(markdown);
  }
}

async function copyUnit(unit) {
  if (!unit) { els.toast.show('No unit here', { kind: 'error' }); return; }
  try {
    await copyRich(unitAsComment(unit));
    els.toast.show(`Copied ${unit.name} as a PR comment`);
  } catch (err) {
    els.toast.show(`Copy failed: ${err.message}`, { kind: 'error' });
  }
}

/** :note — put the cursor on the reviewer's Notes line for the current unit, creating it if needed, in insert mode. */
function editNote() {
  const lines = els.editor.getValue().split('\n');
  const target = briefs.notesTarget(brief, lines, els.editor.cursorLine);
  if (!target) { els.toast.show('Move the cursor into a file or unit first', { kind: 'error' }); return; }
  if (!target.exists) {
    els.editor.insertAtLine(target.line, target.insert + '\n');
    refreshBrief.flush(els.editor.getValue());
  }
  const line = target.line + (target.exists ? 0 : 1);
  els.editor.revealLine(line);
  if (settings.vim) { els.editor.gotoLine(line); els.editor.vimKeys('A'); } // append at the end, insert mode
  else els.editor.gotoLineEnd(line); // the caret after **Notes:** … , not before the label
}

els.outline.addEventListener('goto-line', (e) => gotoBriefLine(e.detail.line));
// a symbol that is a unit in the brief: open the brief at that unit
els.outline.addEventListener('open-brief', (e) => {
  const b = (active?.from && docs.find((d) => d.remote && new URL(d.remote).pathname === active.from)) || docs.find((d) => d.remote);
  const path = b ? new URL(b.remote).pathname : '/brief';
  location.href = `?brief=${encodeURIComponent(path)}&unit=${encodeURIComponent(e.detail.id)}`;
});

// Position in the brief (cursor line, preview scroll) saved when the page navigates away — following a
// file link — and restored when the brief loads again, so browser back returns to the same place.
const posKey = (url) => `rb:pos:${url}`;
addEventListener('pagehide', () => {
  if (!active?.remote) return;
  try { sessionStorage.setItem(posKey(active.remote), JSON.stringify(currentPosition())); } catch { /* storage unavailable */ }
});
function takeStoredPosition(url) {
  try { const pos = JSON.parse(sessionStorage.getItem(posKey(url)) ?? 'null'); sessionStorage.removeItem(posKey(url)); return pos; } catch { return null; }
}

// The server may serve several briefs at once (the last few commits, a stack of PRs). Every brief it
// lists is kept in the Open list, so the sidebar shows the whole set; one closed with × stays closed for
// this page. A change of the server's current brief is extract --open handing a new one over: follow it.
// closed briefs are remembered across reloads and tabs, keyed by the brief's path on disk (a port gets reused for
// other repositories; a URL would hide their briefs too). An explicit request (?brief=, or extract --open handing
// the brief over) reopens one
const CLOSED_KEY = 'xor:closed-briefs';
const closedBriefs = new Set((() => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]'); } catch { return []; } })());
function rememberClosed(remote, closed) {
  if (closed) closedBriefs.add(remote); else closedBriefs.delete(remote);
  try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...closedBriefs])); } catch { /* storage unavailable */ }
}
let currentBrief = null;
let briefSync = Promise.resolve(); // one sync at a time: the page and the first event frame would otherwise add the same briefs twice
function syncBriefs(meta, baseUrl) { return (briefSync = briefSync.then(() => syncBriefsNow(meta, baseUrl)).catch(() => {})); }
async function syncBriefsNow(meta, baseUrl) {
  if (!Array.isArray(meta?.briefs)) return;
  let added = false;
  for (const b of meta.briefs) {
    const remote = new URL(b.url, baseUrl).toString();
    if (closedBriefs.has(b.path ?? remote) || docs.some((d) => d.remote === remote)) continue;
    try { const f = await files.fetchRemote(remote); await createDocument({ name: f.name, content: f.content, remote, mtime: f.mtime, path: b.path ?? null, open: false }); added = true; }
    catch { /* gone between the frame and the fetch */ }
  }
  if (added) await refreshList();
}
async function followCurrent(meta, baseUrl) {
  const was = currentBrief;
  currentBrief = meta?.current ?? currentBrief;
  if (!meta?.current || was === null || was === meta.current) return false;
  const remote = new URL(`/briefs/${meta.current}`, baseUrl).toString();
  let target = docs.find((d) => d.remote === remote);
  if (!target) {
    // closed earlier: a hand-off is an explicit request for it, so bring it back
    const p = meta.briefs?.find((b) => b.slug === meta.current)?.path ?? remote;
    rememberClosed(p, false);
    try { const f = await files.fetchRemote(remote); target = await createDocument({ name: f.name, content: f.content, remote, mtime: f.mtime, path: p === remote ? null : p, open: false }); } catch { return false; }
  }
  if (target.id === active?.id) return false;
  await openDocument(target.id);
  return true;
}

/** ?brief=<url>: open (or refresh) the document served by a local pr-brief viewer. */
async function openRemoteBrief(url) {
  let fresh = await files.fetchRemote(url);
  // /brief is whichever brief is current: open it under its own /briefs/<slug> URL, so several can be open at once
  const canonical = fresh.meta?.current && new URL(url).pathname === '/brief' ? new URL(`/briefs/${fresh.meta.current}`, url).toString() : url;
  if (canonical !== url) {
    const legacy = docs.find((d) => d.remote === url);
    if (legacy && !docs.some((d) => d.remote === canonical)) { legacy.remote = canonical; await store.putDocument(legacy); }
    url = canonical; fresh = await files.fetchRemote(url);
  }
  currentBrief = fresh.meta?.current ?? currentBrief;
  rememberClosed(fresh.meta?.path ?? url, false); // asked for by URL: never treated as closed
  let doc = docs.find((d) => d.remote === url);
  if (doc && fresh.meta?.path && doc.path !== fresh.meta.path) { doc.path = fresh.meta.path; await store.putDocument(doc); }
  if (doc?.dirty && doc.content === fresh.content) { doc.dirty = false; await store.putDocument(doc); } // a stale flag: nothing is unsaved
  if (doc?.dirty) {
    // the browser copy carries edits not yet saved to disk (the reviewer's notes): a page load must not
    // discard them. Open that copy; if the file moved on, offer the reload the watch would offer.
    const moved = fresh.mtime !== doc.mtime;
    await openDocument(doc.id);
    diskDirty = true;
    updateSavedStatus();
    if (moved) els.toast.show(`${fresh.name} changed on disk. Your unsaved edits are kept; reload to see the new version.`, { duration: 8000, action: 'Reload', onAction: reload });
    else els.toast.show(`Opened ${fresh.name} with your unsaved edits`);
    await syncBriefs(fresh.meta, url);
    return;
  }
  if (doc) {
    doc.content = fresh.content; doc.mtime = fresh.mtime; doc.name = fresh.name; doc.updatedAt = Date.now();
    await store.putDocument(doc);
    els.editor.forgetDocument(doc.id);
    await refreshList();
    await openDocument(doc.id);
  } else {
    doc = await createDocument({ name: fresh.name, content: fresh.content, remote: url, mtime: fresh.mtime, path: fresh.meta?.path ?? null });
  }
  els.toast.show(`Opened ${fresh.name} from the pr-brief viewer`);
  await syncBriefs(fresh.meta, url);
}

/** ?file=<path>&line=N: open a repository file served by the local pr-brief viewer, read-only, at a line. */
async function openSourceFile(path, line, from = null) {
  const slug = from?.match(/^\/briefs\/([^/]+)/)?.[1] ?? null; // which served brief the file is read for (its commit, its repository)
  const url = new URL(`/file?path=${encodeURIComponent(path)}${slug ? `&brief=${encodeURIComponent(slug)}` : ''}`, location.href).toString();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(await res.text());
  const src = await res.json();
  let doc = docs.find((d) => d.source === src.path);
  if (doc) {
    Object.assign(doc, { content: src.content, rev: src.rev, name: src.name, symbols: src.symbols ?? [], from: from ?? doc.from ?? null, updatedAt: Date.now() });
    await store.putDocument(doc);
    els.editor.forgetDocument(doc.id);
    await refreshList();
    await openDocument(doc.id);
  } else {
    doc = await createDocument({ name: src.name, content: src.content, open: false });
    Object.assign(doc, { source: src.path, rev: src.rev, readOnly: true, symbols: src.symbols ?? [], from });
    await store.putDocument(doc);
    await refreshList();
    await openDocument(doc.id);
  }
  if (line) { els.editor.revealLine(line); els.editor.gotoLine(line); }
  els.toast.show(`${src.path} @ ${src.rev} — read-only`);
}

function applyVimOption(opt) {
  const [key, value] = opt.split('=');
  switch (key) {
    case 'wrap': update({ lineWrap: true }); break;
    case 'nowrap': update({ lineWrap: false }); break;
    case 'nu': case 'number': update({ lineNumbers: true }); break;
    case 'nonu': case 'nonumber': update({ lineNumbers: false }); break;
    case 'ts': case 'tabstop': case 'sw': case 'shiftwidth': if (value) update({ tabSize: Math.max(1, Math.min(8, Number(value))) }); break;
    case 'scrollsync': update({ scrollSync: true }); break;
    case 'noscrollsync': update({ scrollSync: false }); break;
    case 'diff': if (value === 'split' || value === 'unified') update({ diffView: value }); else els.toast.show('Use :set diff=split or :set diff=unified', { kind: 'error' }); break;
    default: els.toast.show(`Unknown option "${opt}"`, { kind: 'error' });
  }
}

function setLanguage(name) {
  const desc = languages.find((l) => l.name.toLowerCase() === name.toLowerCase() || l.alias.includes(name.toLowerCase()))
    ?? (['text', 'txt', 'plain'].includes(name.toLowerCase()) ? plainText : null);
  if (!desc) { els.toast.show(`Unknown language "${name}"`, { kind: 'error' }); return; }
  els.editor.setLanguage(desc);
  updateStats(els.editor.getValue());
  applySettings({ persist: false });
}

// --- Command palette ---------------------------------------------------------
function commands() {
  const view = (v) => () => update({ view: v });
  return [
    { id: 'new', label: 'New document', keys: `${modKey} N`, run: () => createDocument({}) },
    { id: 'open', label: 'Open file from disk…', keys: `${modKey} O`, run: openFromDisk },
    { id: 'switch', label: 'Switch document…', keys: `${modKey} ⇧ F`, run: pickDocument },
    { id: 'save', label: 'Save', keys: `${modKey} S`, run: save },
    { id: 'saveas', label: 'Save as…', keys: `${modKey} ⇧ S`, run: saveAs },
    { id: 'rename', label: 'Rename document', run: () => { els.name.focus(); els.name.select(); } },
    { id: 'download', label: 'Download document', run: () => active && files.download(active.name, els.editor.getValue()) },
    { id: 'export', label: 'Export preview as HTML', run: exportHTML },
    { id: 'copyhtml', label: 'Copy preview HTML to clipboard', run: async () => { await navigator.clipboard.writeText(markdownToHTML(els.editor.getValue())); els.toast.show('HTML copied'); } },
    { id: 'print', label: 'Print preview', run: () => { if (effectiveView() === 'editor') update({ view: 'split' }); renderPreview.flush(); setTimeout(() => print(), 50); } },
    { id: 'delete', label: 'Delete document', run: () => active && deleteDocument(active.id) },
    { id: 'view-editor', label: 'View: editor only', run: view('editor') },
    { id: 'view-split', label: 'View: split', run: view('split') },
    { id: 'view-preview', label: 'View: preview only', run: view('preview') },
    { id: 'sidebar', label: `${sidebarOpen ? 'Hide' : 'Show'} file sidebar`, keys: `${modKey} B`, run: () => toggleSidebar() },
    { id: 'vim', label: `Turn vim mode ${settings.vim ? 'off' : 'on'}`, keys: `${modKey} ⇧ V`, run: () => update({ vim: !settings.vim }) },
    { id: 'theme', label: 'Color scheme…', run: pickTheme },
    { id: 'theme-system', label: 'Color scheme: follow system', run: () => { update({ theme: null }); applyTheme(); } },
    { id: 'language', label: 'Language mode…', hint: els.editor.languageName, run: pickLanguage },
    { id: 'wrap', label: `Turn line wrapping ${settings.lineWrap ? 'off' : 'on'}`, run: () => update({ lineWrap: !settings.lineWrap }) },
    { id: 'numbers', label: `${settings.lineNumbers ? 'Hide' : 'Show'} line numbers`, run: () => update({ lineNumbers: !settings.lineNumbers }) },
    { id: 'sync', label: `Turn scroll sync ${settings.scrollSync ? 'off' : 'on'}`, run: () => update({ scrollSync: !settings.scrollSync }) },
    { id: 'tab2', label: 'Indent with 2 spaces', run: () => update({ tabSize: 2 }) },
    { id: 'tab4', label: 'Indent with 4 spaces', run: () => update({ tabSize: 4 }) },
    { id: 'font+', label: 'Larger font', keys: `${modKey} =`, run: () => update({ fontSize: Math.min(32, settings.fontSize + 1) }) },
    { id: 'font-', label: 'Smaller font', keys: `${modKey} -`, run: () => update({ fontSize: Math.max(9, settings.fontSize - 1) }) },
    { id: 'font-reset', label: 'Reset font size', run: () => update({ fontSize: 14 }) },
    { id: 'zen', label: `${settings.zen ? 'Leave' : 'Enter'} zen mode`, keys: `${modKey} ⇧ Z`, run: () => update({ zen: !settings.zen }) },
    { id: 'goto', label: 'Go to line…', run: gotoLine },
    ...(outline ? [
      { id: 'unit', label: brief ? 'Brief: go to unit…' : 'Outline: go to symbol…', keys: ':unit', run: pickUnit },
      { id: 'changed', label: brief ? `Brief: ${els.outline.changedOnly ? 'show all units' : 'show changed units only'}` : `Outline: ${els.outline.changedOnly ? 'show all symbols' : 'show only symbols in the brief'}`, keys: ':changed', run: () => els.outline.toggleChanged() },
    ] : []),
    ...(brief ? [
      { id: 'bfile', label: 'Brief: go to file…', keys: ':file', run: pickBriefFile },
      { id: 'note', label: 'Brief: add or edit note for this unit', keys: ':note', run: editNote },
      { id: 'copy-unit', label: 'Brief: copy this unit as a PR comment', keys: ':copy', run: () => { if (requireBrief()) copyUnit(briefs.unitAt(brief, els.editor.cursorLine)); } },
      { id: 'foldhunks', label: 'Brief: fold all hunks', keys: 'zM', run: () => els.editor.foldHunks() },
      { id: 'diffview', label: `Brief: ${settings.diffView === 'split' ? 'unified' : 'side-by-side'} diffs in preview`, keys: ':set diff=', run: () => update({ diffView: settings.diffView === 'split' ? 'unified' : 'split' }) },
    ] : []),
    ...(active?.handle || active?.remote ? [{ id: 'reload', label: 'Reload from disk', keys: ':rel', run: reload }] : []),
    { id: 'bold', label: 'Markdown: bold', hint: '**text**', run: () => els.editor.wrapSelection('**') },
    { id: 'italic', label: 'Markdown: italic', hint: '_text_', run: () => els.editor.wrapSelection('_') },
    { id: 'code', label: 'Markdown: inline code', hint: '`code`', run: () => els.editor.wrapSelection('`', '`', 'code') },
    { id: 'strike', label: 'Markdown: strikethrough', hint: '~~text~~', run: () => els.editor.wrapSelection('~~') },
    { id: 'link', label: 'Markdown: link', hint: '[text](url)', run: () => els.editor.wrapSelection('[', '](https://)') },
    { id: 'h1', label: 'Markdown: heading 1', run: () => els.editor.prefixLines('# ') },
    { id: 'h2', label: 'Markdown: heading 2', run: () => els.editor.prefixLines('## ') },
    { id: 'h3', label: 'Markdown: heading 3', run: () => els.editor.prefixLines('### ') },
    { id: 'ul', label: 'Markdown: bullet list', run: () => els.editor.prefixLines('- ') },
    { id: 'ol', label: 'Markdown: numbered list', run: () => els.editor.prefixLines('1. ') },
    { id: 'task', label: 'Markdown: task list', run: () => els.editor.prefixLines('- [ ] ') },
    { id: 'quote', label: 'Markdown: quote', run: () => els.editor.prefixLines('> ') },
    { id: 'fence', label: 'Markdown: code block', run: () => els.editor.insertText('\n```js\n\n```\n') },
    { id: 'table', label: 'Markdown: table', run: () => els.editor.insertText('\n| Column | Column |\n| --- | --- |\n| cell | cell |\n') },
    { id: 'hr', label: 'Markdown: horizontal rule', run: () => els.editor.insertText('\n---\n') },
    { id: 'date', label: 'Insert today\'s date', run: () => els.editor.insertText(new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date())) },
    { id: 'help', label: 'Keyboard reference', keys: `${modKey} /`, run: () => els.help.toggle() },
    ...(installPrompt ? [{ id: 'install', label: 'Install as an app', run: promptInstall }] : []),
    { id: 'storage', label: 'Storage usage…', run: showStorage },
  ];
}

async function openPalette() {
  const item = await els.palette.open(commands(), { placeholder: 'Type a command…' });
  if (item) await item.run();
}

async function pickTheme() {
  const items = schemes.map((s) => ({
    id: s.id, label: s.name, hint: s.dark ? 'dark' : 'light',
    swatch: { bg: s.ui.bg, fg: s.syntax.keyword, accent: s.ui.accent },
  }));
  items.unshift({ id: null, label: 'Follow system preference', hint: 'auto' });
  const item = await els.palette.open(items, { placeholder: 'Color scheme…' });
  if (item !== null) { update({ theme: item.id }); applyTheme(); }
}

async function pickDocument() {
  const items = docs.map((d) => ({ id: d.id, label: d.name, hint: d.handle ? 'on disk' : '' }));
  const item = await els.palette.open(items, { placeholder: 'Switch to document…' });
  if (item) await openDocument(item.id);
}

async function pickLanguage() {
  const items = [plainText, ...languages].map((l) => ({ id: l.name, label: l.name, hint: l.alias.slice(0, 3).join(', ') }));
  const item = await els.palette.open(items, { placeholder: 'Language mode…' });
  if (item) setLanguage(item.id);
}

async function gotoLine() {
  const lines = els.editor.view.state.doc.lines;
  const items = [];
  for (let i = 1; i <= Math.min(lines, 5000); i++) items.push({ id: i, label: `Line ${i}` });
  const item = await els.palette.open(items, { placeholder: `Go to line (1–${lines})…` });
  if (item) els.editor.gotoLine(item.id);
}

async function showStorage() {
  if (!navigator.storage?.estimate) { els.toast.show('Storage estimate not available'); return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const mb = (n) => (n / 1048576).toFixed(1);
  const persisted = await navigator.storage.persisted?.();
  els.toast.show(`Using ${mb(usage)} MB of ${mb(quota)} MB · ${docs.length} documents · ${persisted ? 'persistent' : 'best-effort'} storage`, { duration: 6000 });
}

// --- Toolbar and sidebar -----------------------------------------------------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) update({ view: btn.dataset.view });
});
$('#btn-new').addEventListener('click', () => createDocument({}));
$('#btn-open').addEventListener('click', openFromDisk);
$('#btn-save').addEventListener('click', save);
$('#btn-palette').addEventListener('click', openPalette);
els.sidebarToggle.addEventListener('click', () => toggleSidebar());
els.diffSwitch.addEventListener('click', (e) => { const b = e.target.closest('button[data-diff]'); if (b) update({ diffView: b.dataset.diff }); });
// the ⋯ menu: preferences and app-level items; state lives in the status bar, so the toolbar stays quiet.
// It is a native popover (the button's popovertarget opens it; light-dismiss and Escape are built in);
// on open it is placed under the button, since the popover lives in the top layer, not in the toolbar.
els.moreMenu.addEventListener('toggle', (e) => {
  if (e.newState !== 'open') return;
  const r = els.moreBtn.getBoundingClientRect();
  els.moreMenu.style.top = `${r.bottom + 4}px`;
  els.moreMenu.style.right = `${Math.max(4, innerWidth - r.right)}px`;
  els.moreMenu.querySelector('button:not([hidden])')?.focus();
});
els.moreMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-menu]');
  if (!item) return;
  const keepOpen = item.getAttribute('role') === 'menuitemcheckbox';
  if (!keepOpen) els.moreMenu.hidePopover(); // close before acting: the action may open a modal dialog
  switch (item.dataset.menu) {
    case 'theme': pickTheme(); break;
    case 'vim': update({ vim: !settings.vim }); break;
    case 'wrap': update({ lineWrap: !settings.lineWrap }); break;
    case 'numbers': update({ lineNumbers: !settings.lineNumbers }); break;
    case 'sync': update({ scrollSync: !settings.scrollSync }); break;
    case 'zen': update({ zen: !settings.zen }); break;
    case 'install': promptInstall(); break;
    case 'help': els.help.toggle(); break;
    case 'storage': showStorage(); break;
  }
});
els.name.addEventListener('change', () => renameDocument(els.name.value));
els.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.name.blur(); els.editor.focus(); }
  if (e.key === 'Escape') { els.name.value = active?.name ?? ''; els.name.blur(); els.editor.focus(); }
});

els.files.addEventListener('select', async (e) => {
  await openDocument(e.detail.id);
  if (narrow.matches) toggleSidebar(false); // the sidebar is an overlay on phones
});
els.files.addEventListener('create', () => createDocument({}));
els.files.addEventListener('open', openFromDisk);
els.files.addEventListener('delete', (e) => deleteDocument(e.detail.id));
els.files.addEventListener('close', async (e) => {
  // a file from disk closes only when the disk has everything the editor has; otherwise ask
  const d = docs.find((x) => x.id === e.detail.id);
  if (d?.handle && !d.readOnly) {
    if (d.id === active?.id) autosave.flush(); // compare the editor's text, not a copy up to 400 ms old
    let same = false;
    try { same = (await files.readHandle(d.handle)).content === d.content; } catch { /* permission gone: treat as unsaved */ }
    if (!same) { els.toast.show(`${d.name} has edits not saved to disk`, { duration: 8000, action: 'Close anyway', onAction: () => closeDocumentById(d.id) }); return; }
  }
  closeDocumentById(e.detail.id);
});
// close the read-only source copies except the active one; the brief and browser documents stay
// ⊗ in the Open list: close every other document that has a copy elsewhere — read-only source files
// from the brief, and files opened from disk whose disk copy matches the editor's. The brief stays,
// browser-only documents stay (closing would delete their only copy), unsaved disk files stay.
els.files.addEventListener('close-others', async () => {
  let kept = 0;
  for (const d of docs.filter((d) => d.id !== active?.id && !d.remote)) {
    if (d.readOnly || d.source) { await closeDocumentById(d.id); continue; }
    if (d.handle) {
      try { if ((await files.readHandle(d.handle)).content === d.content) { await closeDocumentById(d.id); continue; } } catch { /* permission gone: keep it */ }
    }
    kept++;
  }
  if (kept) els.toast.show(`${kept} kept: browser-only or unsaved edits — close those with ×`);
});

els.status.addEventListener('status-action', (e) => {
  switch (e.detail.action) {
    case 'toggle-vim': update({ vim: !settings.vim }); break;
    case 'goto-line': gotoLine(); break;
    case 'pick-language': pickLanguage(); break;
    case 'pick-theme': pickTheme(); break;
  }
});

// Split divider: drag to resize, double-click to reset.
els.divider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  els.divider.setPointerCapture(e.pointerId);
  const rect = els.workspace.getBoundingClientRect();
  const move = (ev) => {
    const pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
    settings.split = Math.round(pct);
    els.workspace.style.setProperty('--split', `${settings.split}%`);
  };
  const stop = () => {
    els.divider.removeEventListener('pointermove', move);
    els.divider.removeEventListener('pointerup', stop);
    saveSettings(settings);
  };
  els.divider.addEventListener('pointermove', move);
  els.divider.addEventListener('pointerup', stop);
});
els.divider.addEventListener('dblclick', () => update({ split: 50 }));
els.divider.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') update({ split: Math.max(20, settings.split - 5) });
  if (e.key === 'ArrowRight') update({ split: Math.min(80, settings.split + 5) });
});

// --- Keyboard shortcuts ------------------------------------------------------
const inEditor = () => !!document.activeElement?.closest('editor-pane');
const inTextField = () => !!document.activeElement?.closest('editor-pane, input, textarea, select, [contenteditable]');
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) {
    if (e.key === 'Escape' && settings.zen && !document.querySelector('dialog[open]')) update({ zen: false });
    else if (e.key === '?' && !e.altKey && !inTextField()) { e.preventDefault(); els.help.toggle(); }
    return;
  }
  const key = e.key.toLowerCase();
  const shift = e.shiftKey;
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  if (key === 'k' && !shift) { handled(); openPalette(); }
  else if (key === 'p' && shift) { handled(); openPalette(); }
  else if (key === 's' && !shift) { handled(); save(); }
  else if (key === 's' && shift) { handled(); saveAs(); }
  else if (key === 'n' && !shift) { handled(); createDocument({}); }
  else if (key === 'o' && !shift) { handled(); openFromDisk(); }
  else if (key === 'b' && !shift) { handled(); toggleSidebar(); }
  else if (key === 'e' && !shift) { handled(); if (isMarkdown()) update({ view: { editor: 'split', split: 'preview', preview: 'editor' }[settings.view] }); }
  else if (key === 'v' && shift) { handled(); update({ vim: !settings.vim }); }
  else if (key === 'z' && shift && !e.altKey && document.activeElement?.closest('editor-pane') === null) { handled(); update({ zen: !settings.zen }); }
  else if (key === 'f' && shift) { handled(); pickDocument(); }
  else if ((key === '=' || key === '+') && !shift) { handled(); update({ fontSize: Math.min(32, settings.fontSize + 1) }); }
  else if (key === '-' && !shift) { handled(); update({ fontSize: Math.max(9, settings.fontSize - 1) }); }
  // Help is ⌘/ (⌘? is the macOS Help-menu search and ⌘⇧T reopens a closed tab, so browsers keep those).
  // Inside the editor ⌘/ stays "toggle comment": there, use ⌘K, :h, or ? from the preview.
  else if (key === '/' && !shift && !inEditor()) { handled(); els.help.toggle(); }
  else if (key === '?' || (key === '/' && shift)) { handled(); els.help.toggle(); }
}, true);

// Zen with ⌘⇧Z inside the editor would shadow redo, so bind it separately there.
els.editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); update({ zen: !settings.zen }); }
});

// --- Drag & drop, OS file handling -------------------------------------------
addEventListener('dragover', (e) => { e.preventDefault(); els.app.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) els.app.classList.remove('dragging'); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  els.app.classList.remove('dragging');
  const items = [...(e.dataTransfer?.items ?? [])];
  const withHandles = await Promise.all(items.filter((i) => i.kind === 'file').map(async (i) => {
    const handle = i.getAsFileSystemHandle ? await i.getAsFileSystemHandle() : null;
    const file = i.getAsFile();
    if (!file) return null;
    return { name: file.name, content: await file.text(), handle: handle?.kind === 'file' ? handle : null };
  }));
  await importFiles(withHandles.filter(Boolean));
});
files.onLaunchFiles(importFiles);

// --- PWA: install prompt and service worker updates -------------------------
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  els.install.hidden = false;
});
async function promptInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  els.install.hidden = true;
}
els.install.addEventListener('click', promptInstall);
addEventListener('appinstalled', () => { els.install.hidden = true; els.toast.show('Installed. Launch it from your dock or home screen.'); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          // A new version found during startup means this page loaded stale
          // assets; reload now, before the user has done anything. Later
          // updates only offer a reload so typing is never interrupted.
          if (Date.now() - bootTime < 4000) { location.reload(); return; }
          els.toast.show('A new version is ready.', { action: 'Reload', onAction: () => location.reload() });
        }
      });
    });
  }).catch((err) => console.warn('Service worker registration failed', err));
}

addEventListener('beforeunload', () => autosave.flush());
addEventListener('visibilitychange', () => { if (document.hidden) autosave.flush(); });

// --- Boot --------------------------------------------------------------------
async function boot() {
  applyTheme();
  applySettings({ persist: false });
  await refreshList();
  const params = new URLSearchParams(location.search);
  // back/forward onto a file that has since been closed with ×: show the brief, not the closed file
  const traversal = performance.getEntriesByType('navigation')[0]?.type === 'back_forward';
  if (params.has('file') && traversal && !docs.some((d) => d.source === params.get('file'))) {
    const from = params.get('from');
    const b = (from && docs.find((d) => d.remote && new URL(d.remote).pathname === from)) || docs.find((d) => d.remote);
    if (b) { params.delete('file'); params.delete('line'); params.delete('from'); params.set('brief', new URL(b.remote).pathname); }
  }
  if (params.has('file')) {
    try { await openSourceFile(params.get('file'), Number(params.get('line')) || 0, params.get('from')); }
    catch (err) {
      els.toast.show(`Could not open ${params.get('file')}: ${err.message}`, { kind: 'error', duration: 10000 });
      if (!docs.length) await createDocument({ name: WELCOME_NAME, content: WELCOME });
      else await openDocument((docs.find((d) => d.id === settings.lastDocId) ?? docs[0]).id);
    }
  } else if (params.has('brief')) {
    const url = new URL(params.get('brief'), location.href).toString();
    try {
      if (params.has('unit')) takeStoredPosition(url); // an explicit landing beats a remembered place
      await openRemoteBrief(url);
      // ?unit=<id>: arrived from a source file's outline — land on that unit
      const unitId = params.get('unit');
      if (unitId && brief) { const u = brief.units.find((x) => x.id === unitId); if (u) jumpToUnit(u); history.replaceState(null, '', `?brief=${encodeURIComponent(params.get('brief'))}`); }
    }
    catch (err) {
      els.toast.show(`Could not load the brief from ${url}: ${err.message}`, { kind: 'error', duration: 10000 });
      if (!docs.length) await createDocument({ name: WELCOME_NAME, content: WELCOME });
      else await openDocument((docs.find((d) => d.id === settings.lastDocId) ?? docs[0]).id);
    }
  } else if (!docs.length) {
    await createDocument({ name: WELCOME_NAME, content: WELCOME });
  } else if (params.has('new')) {
    await createDocument({});
  } else {
    const target = docs.find((d) => d.id === settings.lastDocId) ?? docs[0];
    await openDocument(target.id);
  }
  if (params.has('new') || params.has('source')) history.replaceState(null, '', location.pathname);
  store.requestPersistence();
  els.app.classList.add('ready');
}

boot().catch((err) => {
  console.error(err);
  els.toast.show(`Startup failed: ${err.message}`, { kind: 'error', duration: 10000 });
});
