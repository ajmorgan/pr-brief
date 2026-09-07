// Review-brief model. A brief is Markdown written by the review-brief skill:
// front matter starting `review-brief: N`, `## file` sections, `### unit`
// entries, each followed by an `<!-- rb:… -->` marker, then labelled slots
// (`**File Context:**` / `**<Kind> Context:**`, `**Changes:**`, `**Notes:**`, …) and a ```diff hunk. This module reads that
// structure into line-addressed files and units; it never changes the text.

const FENCE = /^(`{3,})/;

/** True when the document is a brief (cheap; used to gate brief mode). */
export function isBrief(text) {
  return /^---\r?\nreview-brief: \d+/.test(text);
}

function attrs(line) {
  const out = {};
  for (const m of line.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/**
 * @returns {{ files: File[], units: Unit[], overviewLine: number|null, lines: number }}
 * File: { path, status, line, end, hash, units: Unit[] }
 * Unit: { id, kind, status, hash, line, end, heading, name, touched, file, index }
 *   touched: the most recent set of changes touched this unit (the heading's `· changed since last`)
 * All line numbers are 1-based; `end` is the last line belonging to the entry.
 */
export function parseBrief(text) {
  const lines = text.split('\n');
  const files = [];
  const units = [];
  let overviewLine = null;
  let file = null;
  let fenceLen = 0;
  let pendingHeading = null; // { text, line } for the ### heading before a unit marker
  let pendingBullet = null;  // unit waiting for its bullet line (other/file kinds)

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1;
    const fm = l.match(FENCE);
    if (fenceLen === 0 && fm) { fenceLen = fm[1].length; continue; }
    if (fenceLen > 0) { if (fm && fm[1].length >= fenceLen && l.trim() === fm[1]) fenceLen = 0; continue; }

    if (l.startsWith('**Overview:**') && overviewLine === null) overviewLine = n;

    if (l.startsWith('## ')) {
      const m = unlink(l).match(/^## `([^`]+)` — (\w+)/);
      file = { path: m?.[1] ?? l.slice(3), status: m?.[2] ?? '', line: n, end: n, hash: '', units: [] };
      files.push(file);
      pendingHeading = null;
      continue;
    }
    if (l.startsWith('<!-- rb:file ')) { if (file) file.hash = attrs(l).hash ?? ''; continue; }
    if (l.startsWith('### ')) { pendingHeading = { text: unlink(l).slice(4), line: n }; continue; }
    if (l.startsWith('<!-- rb:unit ')) {
      const a = attrs(l);
      const bullet = a.kind === 'other' || a.kind === 'file';
      const unit = {
        id: a.id, kind: a.kind, status: a.status, hash: a.hash,
        line: bullet ? n + 1 : (pendingHeading?.line ?? n),
        end: n, heading: bullet ? '' : (pendingHeading?.text ?? ''),
        name: a.id.includes('#') ? a.id.slice(a.id.indexOf('#') + 1) : a.id,
        touched: false, file, index: units.length,
      };
      if (!bullet) unit.touched = touchedBy(pendingHeading?.text ?? '');
      units.push(unit);
      file?.units.push(unit);
      pendingBullet = bullet ? unit : null;
      pendingHeading = null;
      continue;
    }
    if (pendingBullet && l.startsWith('- ')) {
      const head = unlink(l).slice(2); // measure the cut on the same text that is sliced
      const cut = head.indexOf(' — ');
      pendingBullet.heading = cut > 0 ? head.slice(0, cut) : head;
      pendingBullet.touched = touchedBy(pendingBullet.heading);
      pendingBullet = null;
    }
  }

  // ends: a unit runs to the line before the next unit in the same file, else
  // to the file's end; a file runs to the line before the `---` that precedes
  // the next file (or the document end).
  for (let f = 0; f < files.length; f++) {
    const next = files[f + 1];
    let end = next ? next.line - 1 : lines.length;
    while (end > files[f].line && (lines[end - 1] === '---' || lines[end - 1].trim() === '')) end--;
    files[f].end = end;
    const us = files[f].units;
    for (let u = 0; u < us.length; u++) us[u].end = us[u + 1] ? us[u + 1].line - 1 : end;
  }
  return { files, units, overviewLine, lines: lines.length };
}

/** Strip the link wrapper extract puts around paths: [`x`](x#L1) → `x`. */
function unlink(text) { return text.replace(/\[(`[^`]*`)\]\([^)]*\)/g, '$1'); }

/** A unit's prose slots as written in the brief: { purpose, changes, notes }, missing keys absent;
 *  contextLabel is the description's label as written ("Function Context", …; older briefs: "Purpose"). */
export function unitSlots(text, unit) {
  const lines = text.split('\n').slice(unit.line - 1, unit.end);
  const out = {};
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fm = l.match(FENCE);
    if (fenceLen === 0 && fm) { fenceLen = fm[1].length; continue; }
    if (fenceLen > 0) { if (fm && fm[1].length >= fenceLen && l.trim() === fm[1]) fenceLen = 0; continue; }
    const m = l.match(/^\*\*((?:[A-Z][A-Za-z]* )?Context|Purpose|Does|Did|Changes|Notes):\*\*\s*(.*)$/);
    if (!m) continue;
    const key = m[1] === 'Changes' ? 'changes' : m[1] === 'Notes' ? 'notes' : 'purpose';
    const parts = [m[2]];
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j];
      if (n.trim() === '' || n.startsWith('<!--') || n.startsWith('```') || n.startsWith('**') || n.startsWith('#')) break;
      parts.push(n);
    }
    const v = parts.join('\n').trim();
    if (v && !v.startsWith('<<rb:')) { out[key] = v; if (key === 'purpose') out.contextLabel = m[1]; }
  }
  return out;
}

/** The `path:start-end` a unit heading names, or null. */
export function unitLocation(unit) {
  const ms = [...unit.heading.matchAll(/`([^`\s]+?):(\d+)-(\d+)`/g)];
  const m = ms[ms.length - 1];
  return m ? { path: m[1], start: Number(m[2]), end: Number(m[3]) } : null;
}

/** Whether a heading or bullet says the most recent set of changes touched the unit. Older briefs
 *  wrote "new since last" / "updated since last"; the shared tail reads the same. */
function touchedBy(text) {
  return text.includes('since last');
}

/** The innermost unit whose range contains `line`, or null (source outlines nest: a class contains its methods). */
export function unitAt(brief, line) {
  let best = null;
  for (const u of brief.units) if (line >= u.line && line <= u.end && (!best || u.end - u.line < best.end - best.line)) best = u;
  return best;
}

/** The file whose range contains `line`, or null. */
export function fileAt(brief, line) {
  return brief.files.find((f) => line >= f.line && line <= f.end) ?? null;
}

/** Next (dir=1) or previous (dir=-1) unit from `line`; `changedOnly` skips untouched units. Wraps. */
export function stepUnit(brief, line, dir, changedOnly = false) {
  const list = changedOnly ? brief.units.filter((u) => u.touched) : brief.units;
  if (!list.length) return null;
  if (dir > 0) return list.find((u) => u.line > line) ?? list[0];
  const before = list.filter((u) => u.line < line);
  return before[before.length - 1] ?? list[list.length - 1];
}

/** Case-insensitive substring match on id or heading; first hit wins. */
export function findUnit(brief, query) {
  const q = query.toLowerCase();
  return brief.units.find((u) => u.id.toLowerCase().includes(q) || u.heading.toLowerCase().includes(q)) ?? null;
}

export function findFile(brief, query) {
  const q = query.toLowerCase();
  return brief.files.find((f) => f.path.toLowerCase().includes(q)) ?? null;
}

/**
 * Where the reviewer's `**Notes:**` line is, or where to put one.
 * For a unit: after its closing hunk fence. For a file (cursor above its
 * first unit): before `**Other changes:**` or the first unit heading.
 * @returns {{ line: number, exists: boolean, insert?: string }} 1-based
 */
export function notesTarget(brief, lines, line) {
  const unit = unitAt(brief, line);
  const file = fileAt(brief, line);
  if (!unit && !file) return null;
  const from = unit ? unit.line : file.line;
  const to = unit ? unit.end : (file.units[0]?.line ?? file.end + 1) - 1;
  for (let n = from; n <= to; n++) if (lines[n - 1].startsWith('**Notes:**')) return { line: n, exists: true };
  if (unit) {
    let close = -1;
    let fenceLen = 0;
    for (let n = from; n <= to; n++) {
      const fm = lines[n - 1].match(FENCE);
      if (fenceLen === 0 && fm) fenceLen = fm[1].length;
      else if (fenceLen > 0 && fm && fm[1].length >= fenceLen && lines[n - 1].trim() === fm[1]) { fenceLen = 0; close = n; }
    }
    const at = close > 0 ? close : to;
    return { line: at + 1, exists: false, insert: `\n**Notes:** ` };
  }
  let at = to;
  for (let n = from; n <= to; n++) if (lines[n - 1].startsWith('**Other changes:**')) { at = n - 1; break; }
  // step back over the blank line so the note sits after the last paragraph
  while (at > from && lines[at - 1].trim() === '') at--;
  return { line: at + 1, exists: false, insert: `\n**Notes:** ` };
}
