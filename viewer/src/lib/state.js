// Small helpers shared by the app and its components.

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
