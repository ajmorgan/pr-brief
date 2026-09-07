// A tiny observable state container (book ch. 13: reactivity without a
// framework). Components subscribe to keys and re-render on change.

export function createState(initial) {
  const target = new EventTarget();
  const data = { ...initial };
  return {
    get: (key) => data[key],
    snapshot: () => ({ ...data }),
    set(patch) {
      const changed = [];
      for (const [k, v] of Object.entries(patch)) {
        if (data[k] !== v) { data[k] = v; changed.push(k); }
      }
      if (changed.length) target.dispatchEvent(new CustomEvent('change', { detail: { changed, state: { ...data } } }));
    },
    /** Subscribe to some keys; callback receives the full state snapshot. */
    on(keys, callback) {
      const wanted = new Set([].concat(keys));
      const handler = (e) => { if (e.detail.changed.some((k) => wanted.has(k))) callback(e.detail.state, e.detail.changed); };
      target.addEventListener('change', handler);
      return () => target.removeEventListener('change', handler);
    },
  };
}

/** Debounce helper for autosave and preview rendering. */
export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
