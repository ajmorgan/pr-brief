// <command-palette>: a keyboard-driven picker built on the native <dialog>
// (book §9.4: native dialog handles focus trapping and Escape for free).
//
// open(items, options) resolves with the chosen item, or null when dismissed.
// Items: { id, label, hint?, keys?, group? }.

function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  // a real substring match always outranks a fuzzy one, whatever the fuzzy streaks add up to
  if (t.includes(q)) return 1000 - t.indexOf(q) + (t.startsWith(q) ? 500 : 0);
  let ti = 0; let score = 0; let streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return 0;
    streak = idx === ti ? streak + 1 : 0;
    score += 1 + streak * 2;
    ti = idx + 1;
  }
  return score;
}

export class CommandPalette extends HTMLElement {
  #dialog; #input; #list; #resolve; #items = []; #filtered = []; #index = 0; #previous;

  connectedCallback() {
    if (this.#dialog) return;
    this.innerHTML = `
      <dialog class="palette" aria-label="Command palette">
        <input class="palette-input" type="text" autocomplete="off" spellcheck="false" aria-label="Search">
        <ul class="palette-list" role="listbox"></ul>
        <p class="palette-empty" hidden>No matches</p>
      </dialog>`;
    this.#dialog = this.querySelector('dialog');
    this.#input = this.querySelector('input');
    this.#list = this.querySelector('ul');
    this.#input.addEventListener('input', () => this.#filter());
    this.#input.addEventListener('keydown', (e) => this.#onKey(e));
    this.#list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-index]');
      if (li) this.#choose(Number(li.dataset.index));
    });
    this.#list.addEventListener('mousemove', (e) => {
      const li = e.target.closest('li[data-index]');
      if (li && Number(li.dataset.index) !== this.#index) { this.#index = Number(li.dataset.index); this.#paint(); }
    });
    // A command that opens another picker (⌘K → Color scheme…) calls open() again before the queued close
    // event of the first close() fires; that stale event must not finish the new session.
    this.#dialog.addEventListener('close', () => { if (!this.#dialog.open) this.#finish(null); });
    this.#dialog.addEventListener('click', (e) => { if (e.target === this.#dialog) this.#dialog.close(); });
  }

  get isOpen() { return this.#dialog?.open ?? false; }

  open(items, { placeholder = 'Type a command…', value = '' } = {}) {
    if (this.isOpen) this.#finish(null);
    this.#previous = document.activeElement;
    this.#items = items;
    this.#input.placeholder = placeholder;
    this.#input.value = value;
    this.#index = 0;
    this.#filter();
    this.#dialog.showModal();
    this.#input.focus();
    return new Promise((resolve) => { this.#resolve = resolve; });
  }

  close() { if (this.isOpen) this.#dialog.close(); }

  #finish(item) {
    const resolve = this.#resolve;
    this.#resolve = null;
    if (this.#dialog.open) this.#dialog.close();
    resolve?.(item);
    this.#previous?.focus?.();
  }

  #choose(i) {
    const item = this.#filtered[i];
    if (item) this.#finish(item);
  }

  #onKey(e) {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); this.#move(1); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); this.#move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); this.#choose(this.#index); }
    else if (e.key === 'Escape') { e.preventDefault(); this.#finish(null); }
    else if (e.key === 'Tab') { e.preventDefault(); this.#move(e.shiftKey ? -1 : 1); }
  }

  #move(delta) {
    const n = this.#filtered.length;
    if (!n) return;
    this.#index = (this.#index + delta + n) % n;
    this.#paint();
  }

  #filter() {
    const q = this.#input.value.trim();
    this.#filtered = this.#items
      .map((item) => ({ item, score: fuzzyScore(q, `${item.label} ${item.hint ?? ''}`) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
    this.#index = 0;
    this.#paint();
  }

  #paint() {
    this.querySelector('.palette-empty').hidden = this.#filtered.length > 0;
    this.#list.replaceChildren(...this.#filtered.map((item, i) => {
      const li = document.createElement('li');
      li.dataset.index = String(i);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this.#index));
      li.className = i === this.#index ? 'active' : '';
      const label = document.createElement('span');
      label.className = 'palette-label';
      label.textContent = item.label;
      li.append(label);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'palette-hint';
        hint.textContent = item.hint;
        li.append(hint);
      }
      if (item.keys) {
        const keys = document.createElement('kbd');
        keys.textContent = item.keys;
        li.append(keys);
      }
      if (item.swatch) {
        const sw = document.createElement('span');
        sw.className = 'palette-swatch';
        sw.style.background = item.swatch.bg;
        sw.style.borderColor = item.swatch.accent;
        sw.style.color = item.swatch.fg;
        sw.textContent = 'Aa';
        li.prepend(sw);
      }
      return li;
    }));
    this.#list.children[this.#index]?.scrollIntoView({ block: 'nearest' });
  }
}

customElements.define('command-palette', CommandPalette);
