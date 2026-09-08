// Small user preferences live in localStorage (book §12.4.4): cheap to
// serialize, cheap to restore, and synced across tabs via the storage event.

const KEY = 'xor:settings';

export const defaults = Object.freeze({
  theme: 'github-dark',   // a scheme id; null → follow prefers-color-scheme
  vim: true,
  view: 'split',          // 'editor' | 'split' | 'preview'
  sidebar: true,
  fontSize: 14,
  fontFamily: '',         // '' → default stack from CSS
  lineWrap: true,
  lineNumbers: true,
  tabSize: 2,
  scrollSync: true,
  zen: false,
  diffView: 'unified',    // 'unified' | 'split' — how brief hunks render in the preview
  split: 50,              // editor width in split view, percent
  sidebarWidth: 240,      // sidebar width in pixels (drag its right edge, :set sidebar=N)
  lastDocId: null,
});

export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...defaults, ...validate(stored) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(settings) {
  const snapshot = {};
  for (const k of Object.keys(defaults)) snapshot[k] = settings[k];
  localStorage.setItem(KEY, JSON.stringify(snapshot));
  // storage events never fire in the writing tab, so notify it ourselves.
  window.dispatchEvent(new CustomEvent('settings-saved', { detail: snapshot }));
}

/** Restored data is untrusted input; keep only keys and types we know. */
function validate(obj) {
  const out = {};
  for (const [k, def] of Object.entries(defaults)) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (def === null ? (v === null || typeof v === 'string') : typeof v === typeof def) out[k] = v;
  }
  return out;
}

/** Subscribe to changes made in other tabs. */
export function onExternalSettingsChange(callback) {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY && event.newValue) {
      try { callback({ ...defaults, ...validate(JSON.parse(event.newValue)) }); } catch { /* ignore */ }
    }
  });
}
