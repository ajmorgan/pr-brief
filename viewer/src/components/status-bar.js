// <status-bar>: vim mode, cursor position, word count, language, save
// state and connectivity. Clicking a field runs a related action.

export class StatusBar extends HTMLElement {
  #fields = {};

  connectedCallback() {
    if (this.querySelector('.status-left')) return;
    this.innerHTML = `
      <div class="status-left">
        <button type="button" class="status-item status-mode" data-action="toggle-vim" title="Toggle vim mode"></button>
        <span class="status-item status-saved" aria-live="polite"></span>
      </div>
      <div class="status-right">
        <span class="status-item status-words"></span>
        <button type="button" class="status-item status-pos" data-action="goto-line" title="Go to line"></button>
        <button type="button" class="status-item status-lang" data-action="pick-language" title="Change language"></button>
        <button type="button" class="status-item status-theme" data-action="pick-theme" title="Change color scheme"></button>
        <span class="status-item status-online" aria-live="polite"></span>
      </div>`;
    for (const key of ['mode', 'saved', 'words', 'pos', 'lang', 'theme', 'online']) {
      this.#fields[key] = this.querySelector(`.status-${key}`);
    }
    this.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn) this.dispatchEvent(new CustomEvent('status-action', { detail: { action: btn.dataset.action }, bubbles: true }));
    });
    this.#updateOnline();
    addEventListener('online', () => this.#updateOnline());
    addEventListener('offline', () => this.#updateOnline());
  }

  update({ mode, saved, words, line, col, selected, lang, theme } = {}) {
    if (mode !== undefined) {
      const f = this.#fields.mode;
      f.textContent = mode ? `-- ${mode.toUpperCase()} --` : 'VIM OFF';
      f.dataset.mode = mode || 'off';
    }
    if (saved !== undefined) {
      this.#fields.saved.textContent = saved;
    }
    if (words !== undefined) {
      this.#fields.words.textContent = words;
    }
    if (line !== undefined) {
      this.#fields.pos.textContent = `Ln ${line}, Col ${col}` + (selected ? ` (${selected} sel)` : '');
    }
    if (lang !== undefined) this.#fields.lang.textContent = lang;
    if (theme !== undefined) this.#fields.theme.textContent = theme;
  }

  #updateOnline() {
    const f = this.#fields.online;
    f.textContent = navigator.onLine ? 'online' : 'offline';
    f.classList.toggle('offline', !navigator.onLine);
  }
}

customElements.define('status-bar', StatusBar);
