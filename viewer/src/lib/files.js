// Real files belong to the user (book §12.4.7): use the File System Access
// API when available, and fall back to <input type=file> / downloads.

export const hasFileSystemAccess = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;

const TEXT_TYPES = [{
  description: 'Text and code files',
  accept: {
    'text/markdown': ['.md', '.markdown', '.mdx'],
    'text/plain': ['.txt', '.text', '.log', '.env', '.ini', '.cfg', '.conf', '.toml', '.yaml', '.yml', '.sh'],
    'text/javascript': ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
    'text/html': ['.html', '.htm'],
    'text/css': ['.css'],
    'application/json': ['.json', '.webmanifest'],
    'text/x-python': ['.py'],
    'text/x-rust': ['.rs'],
    'text/x-go': ['.go'],
    'text/x-c': ['.c', '.h', '.cpp', '.cc', '.hpp'],
  },
}];

/**
 * Let the user pick one or more files.
 * @returns {Promise<{name: string, content: string, handle: FileSystemFileHandle|null}[]>}
 */
export async function openFiles() {
  if (hasFileSystemAccess) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({ multiple: true, types: TEXT_TYPES, excludeAcceptAllOption: false });
    } catch (err) {
      if (err.name === 'AbortError') return [];
      throw err;
    }
    return Promise.all(handles.map(async (handle) => {
      const file = await handle.getFile();
      return { name: file.name, content: await file.text(), handle, mtime: file.lastModified };
    }));
  }
  // Fallback (Safari, Firefox): a real file input. It is attached to the
  // document because some browsers ignore click() on a detached input.
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT_EXTENSIONS;
    input.hidden = true;
    const done = async () => {
      const files = [...input.files];
      input.remove();
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text(), handle: null, mtime: f.lastModified }))));
    };
    input.addEventListener('change', done, { once: true });
    input.addEventListener('cancel', () => { input.remove(); resolve([]); }, { once: true });
    document.body.append(input);
    input.click();
  });
}

const ACCEPT_EXTENSIONS = Object.values(TEXT_TYPES[0].accept).flat().join(',');

/** Read dropped/launched File objects. */
export async function readFileObjects(files) {
  return Promise.all([...files].map(async (f) => ({ name: f.name, content: await f.text(), handle: null, mtime: f.lastModified })));
}

/** Re-read a linked file from disk. */
export async function readHandle(handle) {
  const file = await handle.getFile();
  return { content: await file.text(), mtime: file.lastModified };
}

// --- Remote documents: a local server (pr-brief's viewer.ts) exposes one
// file at a URL — GET reads it, PUT writes it, GET <url>/meta reports mtime.
export async function fetchRemote(url) {
  const [meta, res] = await Promise.all([fetch(`${url}/meta`, { cache: 'no-store' }), fetch(url, { cache: 'no-store' })]);
  if (!meta.ok || !res.ok) throw new Error(`server returned ${meta.ok ? res.status : meta.status}`);
  const m = await meta.json();
  return { name: m.name, content: await res.text(), mtime: m.mtime, remote: url, meta: m };
}

/** The server's metadata for a remote document: { name, mtime, viewer? } — `viewer` is the served app's build id. */
export async function remoteMeta(url) {
  const res = await fetch(`${url}/meta`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  return res.json();
}

export async function remoteMtime(url) {
  const res = await fetch(`${url}/meta`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  return (await res.json()).mtime;
}

export async function putRemote(url, content, mtime = null) {
  // X-Brief-Mtime: the version this tab read; the server refuses (412) to overwrite a newer file
  const headers = { 'Content-Type': 'text/markdown; charset=utf-8' };
  if (typeof mtime === 'number') headers['X-Brief-Mtime'] = String(mtime);
  const res = await fetch(url, { method: 'PUT', body: content, headers });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).mtime;
}

async function ensureWritePermission(handle) {
  if (!handle.queryPermission) return true;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

/**
 * Write to an existing handle. Returns false if permission was denied.
 */
export async function writeToHandle(handle, content) {
  if (!(await ensureWritePermission(handle))) return false;
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
  return true;
}

/**
 * "Save as": returns the new handle (or null when the platform only supports
 * downloads, in which case the file was downloaded instead).
 */
export async function saveAs(name, content) {
  if (hasFileSystemAccess) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: TEXT_TYPES });
      await writeToHandle(handle, content);
      return { handle, name: handle.name };
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }
  download(name, content, 'text/plain');
  return { handle: null, name };
}

export function download(name, content, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Files opened via the OS (manifest file_handlers) arrive through launchQueue. */
export function onLaunchFiles(callback) {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.files?.length) return;
    const docs = await Promise.all(launchParams.files.map(async (handle) => {
      const file = await handle.getFile();
      return { name: file.name, content: await file.text(), handle, mtime: file.lastModified };
    }));
    callback(docs);
  });
}
