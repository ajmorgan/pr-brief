// <brief-outline>: the sidebar outline — a PR brief's files and units with
// since-last badges, or (mode "file") one source file's symbols with a badge on
// those that are units in the brief. Pure view: it renders the model it is given
// and emits goto-line {line}, filter {changedOnly}, and open-brief {id}.

export class BriefOutline extends HTMLElement {
  #brief = null;
  #mode = 'brief';
  #line = 1;
  #changedOnly = false;
  #list;
  #count;
  #filterBtn;

  connectedCallback() {
    if (this.#list) return;
    this.innerHTML = `
      <div class="file-list-head">
        <span class="file-list-title">Brief</span>
        <button type="button" class="tool-btn outline-filter" aria-pressed="false" title="Show only units changed since the last brief (:changed)">changed</button>
      </div>
      <p class="outline-count"></p>
      <ul class="outline-items" role="tree" aria-label="Brief outline"></ul>`;
    this.#list = this.querySelector('.outline-items');
    this.#count = this.querySelector('.outline-count');
    this.#filterBtn = this.querySelector('.outline-filter');
    this.#filterBtn.addEventListener('click', () => this.toggleChanged());
    this.#list.addEventListener('click', (e) => {
      const badge = e.target.closest('[data-brief-id]');
      if (badge) { e.stopPropagation(); this.dispatchEvent(new CustomEvent('open-brief', { detail: { id: badge.dataset.briefId }, bubbles: true })); return; }
      const el = e.target.closest('[data-line]');
      if (el) this.dispatchEvent(new CustomEvent('goto-line', { detail: { line: Number(el.dataset.line) }, bubbles: true }));
    });
  }

  set brief(model) { this.#brief = model; this.#render(); }
  /** 'brief' (files and units of a brief) or 'file' (symbols of one source file). */
  set mode(m) {
    this.#mode = m;
    if (!this.#list) return;
    this.querySelector('.file-list-title').textContent = m === 'file' ? 'Outline' : 'Brief';
    this.#filterBtn.textContent = m === 'file' ? 'in brief' : 'changed';
    this.#filterBtn.title = m === 'file' ? 'Show only symbols that are units in the brief' : 'Show only units changed since the last brief (:changed)';
  }
  get mode() { return this.#mode; }
  get brief() { return this.#brief; }
  get changedOnly() { return this.#changedOnly; }

  /** Current cursor line: highlights the containing unit and keeps it in view. */
  set line(n) {
    if (n === this.#line) return;
    this.#line = n;
    this.#highlight();
  }

  toggleChanged(force) {
    this.#changedOnly = force ?? !this.#changedOnly;
    this.#filterBtn.setAttribute('aria-pressed', String(this.#changedOnly));
    this.#render();
    this.dispatchEvent(new CustomEvent('filter', { detail: { changedOnly: this.#changedOnly }, bubbles: true }));
  }

  #render() {
    if (!this.#list) return;
    const b = this.#brief;
    if (!b) { this.#list.replaceChildren(); this.#count.textContent = ''; return; }
    const changed = b.units.filter((u) => u.touched || u.badge).length; // brief: touched units; source file: symbols in the brief
    this.#count.textContent = this.#mode === 'file'
      ? `${b.units.length} symbols` + (changed ? ` · ${changed} in brief` : '')
      : `${b.files.length} files · ${b.units.length} units` + (changed ? ` · ${changed} changed` : '');
    const items = [];
    for (const f of b.files) {
      const units = this.#changedOnly ? f.units.filter((u) => u.touched || u.badge) : f.units;
      if (this.#changedOnly && !units.length) continue;
      const li = document.createElement('li');
      li.className = 'outline-file';
      li.setAttribute('role', 'treeitem');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'outline-select';
      btn.dataset.line = String(f.line);
      btn.innerHTML = `<span class="outline-path"></span><span class="outline-meta"></span>`;
      btn.querySelector('.outline-path').textContent = f.path;
      btn.querySelector('.outline-meta').textContent = `${f.status} · ${f.units.length}`;
      li.append(btn);
      const ul = document.createElement('ul');
      ul.setAttribute('role', 'group');
      for (const u of units) {
        const uli = document.createElement('li');
        uli.className = 'outline-unit';
        uli.dataset.index = String(u.index);
        const ub = document.createElement('button');
        ub.type = 'button';
        ub.className = 'outline-select';
        ub.dataset.line = String(u.line);
        const name = document.createElement('span');
        name.className = 'outline-name';
        name.textContent = u.kind === 'other' || u.kind === 'file' ? u.heading || u.name : u.name.split('.').pop();
        name.title = u.heading || u.id;
        // one word per unit, its status; highlighted as a pill when the most recent set of changes touched it
        const meta = document.createElement('span');
        meta.className = 'outline-meta';
        meta.textContent = u.kind === 'other' ? 'other' : (u.status || u.kind);
        if (u.touched) { meta.classList.add('outline-meta-touched'); meta.title = 'Touched by the most recent set of changes'; }
        ub.append(name, meta);
        if (u.badge) {
          const badge = document.createElement('span');
          badge.className = `outline-badge outline-badge-${u.badge}`;
          badge.textContent = u.badge;
          if (u.badge === 'brief') { badge.dataset.briefId = u.id; badge.setAttribute('role', 'button'); badge.title = 'This symbol is a unit in the brief — open it there'; }
          ub.append(badge);
        }
        uli.append(ub);
        ul.append(uli);
      }
      li.append(ul);
      items.push(li);
    }
    this.#list.replaceChildren(...items);
    this.#highlight();
  }

  #highlight() {
    const b = this.#brief;
    if (!b) return;
    let unit = null; // innermost: a source outline nests (a class contains its methods)
    for (const u of b.units) if (this.#line >= u.line && this.#line <= u.end && (!unit || u.end - u.line < unit.end - unit.line)) unit = u;
    for (const li of this.#list.querySelectorAll('.outline-unit')) {
      const on = unit && Number(li.dataset.index) === unit.index;
      li.classList.toggle('active', !!on);
      if (on) li.scrollIntoView({ block: 'nearest' });
    }
  }
}

customElements.define('brief-outline', BriefOutline);
