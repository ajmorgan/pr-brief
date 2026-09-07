// <help-dialog>: keyboard shortcuts and vim ex-commands reference.

import { modKey } from '../lib/state.js';

const shortcuts = [
  ['General', [
    [`${modKey} K`, 'Command palette (type to filter: "color" finds the scheme picker)'],
    [`${modKey} N`, 'New document'],
    [`${modKey} O`, 'Open file from disk'],
    [`${modKey} S`, 'Save (writes to disk when the document is linked to a file)'],
    [`${modKey} ⇧ S`, 'Save as…'],
    [`${modKey} B`, 'Toggle file sidebar'],
    [`${modKey} E`, 'Cycle view: editor → split → preview'],
    [`${modKey} ⇧ V`, 'Toggle vim mode'],
    [`${modKey} ⇧ Z`, 'Zen mode (hide everything but the text)'],
    [`${modKey} ⇧ F`, 'Switch document'],
    [`${modKey} =`, 'Larger font'],
    [`${modKey} -`, 'Smaller font'],
    [`${modKey} /`, 'This help (inside the editor it toggles a comment: use the palette or :h there)'],
    ['?', 'This help, when no text field has the focus'],
  ]],
  ['Editing', [
    [`${modKey} F`, 'Find / replace'],
    [`${modKey} Z`, 'Undo'],
    [`${modKey} ⇧ Z`, 'Redo'],
    ['Alt ↑ / ↓', 'Move line up / down'],
    [`${modKey} /`, 'Toggle line comment'],
    ['Tab', 'Indent (or accept completion)'],
    [`${modKey} Shift K`, 'Delete line'],
  ]],
  ['Vim ex-commands', [
    [':w', 'Save'],
    [':wq', 'Save and close document'],
    [':q', 'Close document'],
    [':e name', 'Open a stored document by name (no name → open from disk)'],
    [':new [name]', 'New document'],
    [':sav name', 'Save as a new file on disk'],
    [':colo name', 'Change color scheme (:colo with no name lists them)'],
    [':set wrap | nowrap | nu | nonu | ts=4', 'Editor options'],
    [':pre', 'Toggle preview / editor'],
    [':sp', 'Split view'],
    [':zen', 'Zen mode'],
    [':lang name', 'Set language'],
    [':export', 'Export the preview as an HTML file'],
    [':files', 'Toggle sidebar'],
    [':h', 'This help'],
  ]],
  ['PR brief (when a brief is open)', [
    [']u / [u', 'Next / previous unit (respects :changed)'],
    [':unit name', 'Jump to a unit by name (no name → pick from a list)'],
    [':file path', 'Jump to a file section'],
    [':note', 'Add or edit the reviewer note for the unit under the cursor'],
    [':copy', 'Copy the unit under the cursor as a PR comment (Markdown and HTML)'],
    [':changed', 'Toggle showing only units changed since the last brief'],
    [':rel', 'Reload the brief from disk (after the agent regenerated it)'],
    ['zR / zM', 'Unfold / fold all hunks'],
    [':set diff=split | unified', 'Side-by-side or stacked hunks in the preview'],
  ]],
];

export class HelpDialog extends HTMLElement {
  #dialog;

  connectedCallback() {
    if (this.#dialog) return;
    const sections = shortcuts.map(([title, rows]) => `
      <section>
        <h3>${title}</h3>
        <dl>${rows.map(([k, v]) => `<div><dt><kbd>${k}</kbd></dt><dd>${v}</dd></div>`).join('')}</dl>
      </section>`).join('');
    this.innerHTML = `
      <dialog class="help" aria-labelledby="help-title">
        <header><h2 id="help-title">Keyboard reference</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
        <div class="help-body">${sections}</div>
        <footer>Everything is stored in this browser (IndexedDB). Use Save as… or Export to keep a copy on disk.</footer>
      </dialog>`;
    this.#dialog = this.querySelector('dialog');
    this.querySelector('[data-close]').addEventListener('click', () => this.#dialog.close());
    this.#dialog.addEventListener('click', (e) => { if (e.target === this.#dialog) this.#dialog.close(); });
  }

  toggle() {
    if (this.#dialog.open) this.#dialog.close();
    else this.#dialog.showModal();
  }
}

customElements.define('help-dialog', HelpDialog);
