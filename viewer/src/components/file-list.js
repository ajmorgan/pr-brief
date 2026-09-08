// <file-list>: the document sidebar. Pure view: it renders what it is given
// and emits intents (select, create, delete, open) for the app to handle.

const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function relative(ts) {
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'just now';
  if (abs < 3600) return formatter.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return formatter.format(Math.round(diff / 3600), 'hour');
  return formatter.format(Math.round(diff / 86400), 'day');
}

export class FileList extends HTMLElement {
  #docs = [];
  #activeId = null;
  #list;
  #search;

  connectedCallback() {
    if (this.#list) return;
    this.innerHTML = `
      <div class="file-list-head">
        <span class="file-list-title" data-action="collapse">Files</span>
        <button type="button" class="icon-btn file-close-others" data-action="close-others" title="Close the other opened files — keeps the brief, browser-only documents, and files with unsaved edits" aria-label="Close other files">⊗</button>
        <button type="button" class="icon-btn" data-action="open" title="Open from disk (⌘O)" aria-label="Open file">⤒</button>
        <button type="button" class="icon-btn" data-action="create" title="New document (⌘N)" aria-label="New document">＋</button>
      </div>
      <input class="file-search" type="search" placeholder="Filter files…" aria-label="Filter files">
      <ul class="file-items" role="listbox" aria-label="Documents"></ul>
      <p class="file-empty" hidden>No documents yet.<br>Press <kbd>⌘N</kbd> to create one.</p>`;
    this.#list = this.querySelector('.file-items');
    this.#search = this.querySelector('.file-search');
    this.#search.addEventListener('input', () => this.#render());
    this.addEventListener('click', (e) => this.#onClick(e));
    this.#list.addEventListener('keydown', (e) => this.#onKey(e));
  }

  set documents(docs) { this.#docs = docs; this.#render(); }
  static get observedAttributes() { return ['compact']; }
  attributeChangedCallback() { if (this.#list) { this.querySelector('.file-list-title').textContent = this.hasAttribute('compact') ? 'Open' : 'Files'; if (!this.hasAttribute('compact')) this.classList.remove('collapsed'); } }
  get documents() { return this.#docs; }
  set activeId(id) { this.#activeId = id; this.#render(); }

  #onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const li = btn.closest('li[data-id]');
    const id = li?.dataset.id;
    switch (btn.dataset.action) {
      case 'create': this.#emit('create'); break;
      case 'open': this.#emit('open'); break;
      case 'select': this.#emit('select', { id }); break;
      case 'close-others': this.#emit('close-others'); break;
      case 'collapse': if (this.hasAttribute('compact')) this.classList.toggle('collapsed'); break;
      case 'close': this.#emit('close', { id }); break; // a copy of something that lives elsewhere: no confirmation
      case 'delete':
        if (btn.dataset.armed) { this.#emit('delete', { id }); }
        else {
          btn.dataset.armed = '1';
          btn.textContent = 'Delete?';
          btn.classList.add('danger');
          setTimeout(() => { delete btn.dataset.armed; btn.textContent = '×'; btn.classList.remove('danger'); }, 2500);
        }
        break;
    }
  }

  #onKey(e) {
    const items = [...this.#list.querySelectorAll('[data-action="select"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, i - 1)]?.focus(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const li = document.activeElement.closest('li[data-id]');
      // the same path as the row's ×: close for a copy, an armed "Delete?" for a browser-only document
      if (li && e.metaKey) { e.preventDefault(); li.querySelector('.file-delete')?.click(); }
    }
  }

  #emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  #render() {
    if (!this.#list) return;
    const q = this.#search.value.trim().toLowerCase();
    const docs = q ? this.#docs.filter((d) => d.name.toLowerCase().includes(q)) : this.#docs;
    this.querySelector('.file-empty').hidden = this.#docs.length > 0;
    this.#list.replaceChildren(...docs.map((doc) => {
      const li = document.createElement('li');
      li.dataset.id = doc.id;
      li.className = doc.id === this.#activeId ? 'active' : '';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'file-select';
      select.dataset.action = 'select';
      select.setAttribute('role', 'option');
      select.setAttribute('aria-selected', String(doc.id === this.#activeId));
      const name = document.createElement('span');
      name.className = 'file-name';
      const bdi = document.createElement('bdi'); // the row clips on the left, the name stays left-to-right
      bdi.textContent = doc.name;
      name.append(bdi);
      name.title = doc.readOnly && doc.source ? doc.source : doc.name;
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = doc.readOnly ? `${doc.source} @ ${doc.rev}` : (doc.handle ? '⛁ ' : doc.remote ? '⇄ ' : '') + relative(doc.updatedAt);
      meta.title = doc.readOnly ? `Read-only copy of ${doc.source} at ${doc.rev}` : doc.handle ? 'Linked to a file on disk' : doc.remote ? 'Served by a local server' : 'Stored in this browser';
      select.append(name, meta);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn file-delete';
      del.textContent = '×';
      // a document with a copy elsewhere — served by a local server, opened read-only from a repo, or
      // opened from a file on disk — is closed by ×. A browser-only document has no other copy: × arms
      // a "Delete?" confirmation first.
      const isCopy = !!doc.remote || !!doc.source || !!doc.readOnly || !!doc.handle;
      del.dataset.action = isCopy ? 'close' : 'delete';
      del.setAttribute('aria-label', `${isCopy ? 'Close' : 'Delete'} ${doc.name}`);
      del.title = isCopy ? 'Close (the file on disk is untouched)' : 'Delete from this browser';
      li.append(select, del);
      return li;
    }));
  }
}

customElements.define('file-list', FileList);
