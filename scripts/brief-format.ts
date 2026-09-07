// brief-format.ts — shared parsing of REVIEW_BRIEF.md for extract and lint.
// The brief is line-oriented Markdown. Structure comes from headings and
// `<!-- rb:… -->` markers; prose lives in labelled slots whose value is the
// paragraph starting at the label and ending at the first blank line.

export const FORMAT_VERSION = 1;

// Word budgets per slot (spec §10). `short` applies to non-function kinds.
export const BUDGETS: Record<string, number> = {
  overview: 200, // prose form; the list form is budgeted per line: overviewLead for the lead sentence, overviewBullet per bullet
  overviewLead: 40,
  overviewBullet: 60,
  purpose: 60,
  changes: 150,
  does: 40,
  did: 40,
  change: 60,
  other: 25,
  short: 25,
  review: 60,
};

export const SHORT_KINDS = new Set(["type", "interface", "enum", "field", "class", "record", "annotation", "object", "key", "item", "doc", "rule", "element", "script", "style", "block"]);
export const CALLABLE_KINDS = new Set(["function", "method", "constructor", "arrow"]);

// Slot labels. A file's description is "File Context:"; a unit's is "<Kind> Context:" for its kind
// (Function, Method, Class, Section, …), so the label itself tells the reader what they are looking at.
// Both levels also have "Changes:"; the parser tells file from unit by position. The old
// Purpose:/Does:/Did:/Change:/Delta: labels are still read so earlier briefs carry over.
export const KIND_WORD: Record<string, string> = {
  function: "Function", arrow: "Function", method: "Method", constructor: "Constructor",
  class: "Class", interface: "Interface", enum: "Enum", record: "Record", annotation: "Annotation", object: "Object", type: "Type",
  const: "Const", field: "Field",
  section: "Section", key: "Key", item: "Item", doc: "Document", rule: "Rule", element: "Element", script: "Script", style: "Style", block: "Block",
};
export const kindWord = (kind?: string): string => (kind && KIND_WORD[kind]) ?? (kind ? kind[0].toUpperCase() + kind.slice(1) : "Unit");
export const LABEL_OF: Record<string, string> = { overview: "Overview", purpose: "File Context", changes: "Changes", does: "Context", did: "Context", change: "Changes", review: "Review Observations", notes: "Notes" };
export const labelOf = (key: string, kind?: string): string => `**${key === "does" || key === "did" ? `${kindWord(kind)} Context` : LABEL_OF[key] ?? key[0].toUpperCase() + key.slice(1)}:**`;
const CONTEXT_LABEL = /^\*\*([A-Z][A-Za-z]*) Context:\*\*/;

const SLOT_LABELS: Record<string, string> = {
  "**Overview:**": "overview",
  "**Purpose:**": "purpose", // pre-Context label, still read
  "**Changes:**": "changes",
  "**Delta:**": "change", // short-lived label, read for carry-over
  "**Does:**": "does",
  "**Change:**": "change",
  "**Did:**": "did",
  "**Review Observations:**": "review",
  "**Notes:**": "notes",
};

/** The slot a line starts, with the label as written: fixed labels first, then any "<Word> Context:". */
function slotLabel(l: string): { key: string; label: string } | null {
  for (const [label, key] of Object.entries(SLOT_LABELS)) if (l.startsWith(label)) return { key, label };
  const m = l.match(CONTEXT_LABEL);
  return m ? { key: "purpose", label: m[0] } : null; // File Context: on a file, <Kind> Context: on a unit — position decides
}

export interface ParsedUnit {
  id: string;
  kind: string;
  status: string;
  hash: string;
  heading: string;
  slots: Record<string, string>;
  line: number;
}

export interface ParsedFile {
  path: string;
  hash: string;
  heading: string;
  slots: Record<string, string>;
  units: ParsedUnit[];
  line: number;
}

export interface ParsedBrief {
  front: Record<string, any>;
  overview: string | null;
  files: ParsedFile[];
  structure: string[];
  hasRevise: boolean;
  tokens: { token: string; line: number }[];
}

export function markerAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

export function parseFrontMatter(lines: string[]): { front: Record<string, any>; end: number } {
  const front: Record<string, any> = {};
  if (lines[0] !== "---") return { front, end: 0 };
  let i = 1;
  let nested: string | null = null;
  for (; i < lines.length && lines[i] !== "---"; i++) {
    const l = lines[i];
    if (/^\s{2}\w/.test(l) && nested) {
      const m = l.trim().match(/^([\w-]+):\s*(.*)$/);
      if (m) front[nested][m[1]] = m[2] === "null" || m[2] === "" ? null : m[2];
      continue;
    }
    const m = l.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    if (m[2] === "") {
      nested = m[1];
      front[nested] = {};
    } else {
      nested = null;
      front[m[1]] = m[2] === "null" ? null : m[2];
    }
  }
  return { front, end: i + 1 };
}

// Read a slot value: rest of the label line plus following lines until a blank
// line or a structural line.
function readSlot(lines: string[], i: number, label: string): { value: string; next: number } {
  const parts: string[] = [lines[i].slice(label.length).trim()];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === "" || l.startsWith("<!--") || l.startsWith("```") || l.startsWith("**") || l.startsWith("#") || l === "---") break;
    parts.push(l);
  }
  return { value: parts.join("\n").trim(), next: j };
}

export function isToken(v: string | undefined): boolean {
  return !!v && v.startsWith("<<rb:");
}

// Backticked spans — paths, identifiers, signatures — are references the rules ask for, not prose;
// they do not count toward a budget.
export function wordCount(s: string): number {
  return s.replace(/`[^`\n]*`/g, " ").split(/\s+/).filter((w) => w.length > 0).length;
}

/** The Overview split into its lead sentence and `- ` bullets (bullets empty for the prose form). */
export function overviewParts(overview: string): { lead: string; bullets: string[] } {
  const lines = overview.split("\n");
  const first = lines.findIndex((l) => /^\s*- /.test(l));
  if (first < 0) return { lead: overview, bullets: [] };
  return { lead: lines.slice(0, first).join("\n"), bullets: lines.slice(first).join("\n").split(/\n(?=\s*- )/).map((b) => b.replace(/^\s*- /, "")) };
}

export function parseBrief(text: string): ParsedBrief {
  const lines = text.split("\n");
  const { front, end } = parseFrontMatter(lines);
  const brief: ParsedBrief = { front, overview: null, files: [], structure: [], hasRevise: false, tokens: [] };
  let file: ParsedFile | null = null;
  let unit: ParsedUnit | null = null;
  let fenceLen = 0; // >0 while inside a code fence; closes only on a fence at least this long
  let inRevise = false;
  let pendingOther: ParsedUnit | null = null;

  for (let i = end; i < lines.length; i++) {
    const l = lines[i];
    if (inRevise) {
      if (l.trim() === "-->") inRevise = false;
      continue;
    }
    if (l.startsWith("<!-- rb:revise")) {
      brief.hasRevise = true;
      inRevise = !l.trim().endsWith("-->");
      continue;
    }
    const fm = l.match(/^(`{3,})/);
    if (fenceLen === 0 && fm) { fenceLen = fm[1].length; continue; }
    if (fenceLen > 0) { if (fm && fm[1].length >= fenceLen && l.trim() === fm[1]) fenceLen = 0; continue; }

    // a real slot has the form `<<rb:kind id | instruction>>`; prose that merely mentions "<<rb:" is not one
    for (const m of l.matchAll(/<<rb:[a-z]+(?: [^|\n]*)? \|/g)) brief.tokens.push({ token: m[0].replace(/ \|$/, "").trim(), line: i + 1 });

    if (l.startsWith("## ")) {
      brief.structure.push(l);
      continue;
    }
    if (l.startsWith("### ")) {
      brief.structure.push(l);
      continue;
    }
    if (l.startsWith("<!-- rb:file ")) {
      brief.structure.push(l);
      const a = markerAttrs(l);
      file = { path: a.path, hash: a.hash, heading: lines[i - 1] ?? "", slots: {}, units: [], line: i + 1 };
      brief.files.push(file);
      unit = null;
      continue;
    }
    if (l.startsWith("<!-- rb:unit ")) {
      brief.structure.push(l);
      const a = markerAttrs(l);
      const bullet = a.kind === "other" || a.kind === "file";
      unit = { id: a.id, kind: a.kind, status: a.status, hash: a.hash, heading: bullet ? "" : lines[i - 1] ?? "", slots: {}, line: i + 1 };
      file?.units.push(unit);
      pendingOther = bullet ? unit : null;
      continue;
    }
    if (pendingOther && l.startsWith("- ")) {
      const idx = l.indexOf(" — ");
      pendingOther.slots.other = idx >= 0 ? l.slice(idx + 3).trim() : "";
      pendingOther.heading = idx >= 0 ? l.slice(0, idx) : l;
      pendingOther = null;
      continue;
    }
    const slot = slotLabel(l);
    if (slot) {
      const { value, next } = readSlot(lines, i, slot.label);
      if (slot.key === "overview") brief.overview = value;
      else if (unit) unit.slots[slot.key === "purpose" ? (unit.status === "deleted" ? "did" : "does") : slot.key === "changes" ? "change" : slot.key] = value;
      else if (file) file.slots[slot.key] = value;
      i = next - 1;
    }
  }
  return brief;
}

export function stripReviseNotes(text: string): string {
  return text.replace(/<!-- rb:revise[\s\S]*?-->\n?/g, "");
}
