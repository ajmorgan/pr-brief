// <markdown-preview>: renders markdown and reports scroll position in
// source-line terms so the editor and preview can stay aligned.
// Emits: preview-scroll {line, fraction}; preview-section {line} when the unit or file card under
// the top of the viewport changes (scroll-spy for the outline).

import { renderMarkdown } from '../lib/markdown.js';

export class MarkdownPreview extends HTMLElement {
  #article;
  #blocks = [];
  #raf = 0;
  #spy = null;          // IntersectionObserver over [data-spy-line] elements
  #spyOn = new Set();   // the ones currently crossing the band under the sticky heading
  #spyActive = null;
  #spyBand = '';        // offset:height the observer was built for; a width-only resize keeps it
  #resize = null;

  connectedCallback() {
    if (this.#article) return;
    this.#article = document.createElement('article');
    this.#article.className = 'markdown-body';
    this.append(this.#article);
    this.addEventListener('scroll', () => {
      cancelAnimationFrame(this.#raf);
      this.#raf = requestAnimationFrame(() => this.#emitScroll());
    }, { passive: true });
    this.addEventListener('click', (e) => this.#handleClick(e));
    this.#resize = new ResizeObserver(() => this.#observeSpy({ force: false })); // the band is sized from the viewport
    this.#resize.observe(this);
  }

  render(markdown) {
    const open = this.#openFolds();
    const fragment = renderMarkdown(markdown);
    this.#article.replaceChildren(fragment);
    this.#restoreFolds(open);
    this.#collectBlocks();
    this.#observeSpy();
  }

  // Re-rendering replaces the DOM, which would close every <details> the reader opened.
  // Remember open folds by source line and summary text, then re-open the nearest match:
  // exact on a settings change, nearest-by-line while the source is being edited.
  #openFolds() {
    return [...this.#article.querySelectorAll('details[open]')].map((d) => ({
      line: Number(d.closest('[data-line]')?.dataset.line) || 0,
      summary: d.querySelector(':scope > summary')?.textContent.trim() ?? '',
    }));
  }

  #restoreFolds(open) {
    if (!open.length) return;
    const candidates = [...this.#article.querySelectorAll('details')].map((el) => ({
      el,
      line: Number(el.closest('[data-line]')?.dataset.line) || 0,
      summary: el.querySelector(':scope > summary')?.textContent.trim() ?? '',
    }));
    for (const want of open) {
      let best = null;
      for (const c of candidates) {
        if (c.el.open || c.summary !== want.summary) continue;
        if (!best || Math.abs(c.line - want.line) < Math.abs(best.line - want.line)) best = c;
      }
      if (best) best.el.open = true;
    }
  }

  clear() {
    this.#article.replaceChildren();
    this.#blocks = [];
    this.#spy?.disconnect();
    this.#spyOn.clear();
    this.#spyActive = null;
  }

  get html() { return this.#article.innerHTML; }

  #collectBlocks() {
    this.#blocks = [...this.#article.querySelectorAll('[data-line]')]
      .map((el) => ({ el, line: Number(el.dataset.line), card: el.closest('section.rb-file') }))
      .filter((b) => Number.isFinite(b.line));
  }

  #handleClick(e) {
    // In-document links: scroll the preview rather than navigating the app.
    const a = e.target.closest('a[href^="#"]');
    if (a) {
      e.preventDefault();
      const id = decodeURIComponent(a.getAttribute('href').slice(1));
      const target = this.#article.querySelector(`[id="${CSS.escape(id)}"]`);
      if (target) this.#withLayout(target, () => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return;
    }
    // Double-click a block to jump the editor to its source line.
    if (e.detail === 2) {
      const block = e.target.closest('[data-line]');
      if (block) this.dispatchEvent(new CustomEvent('goto-line', { detail: { line: Number(block.dataset.line) } }));
    }
  }

  /** Offset of a block relative to the scroll container's content. A block inside a card the
   *  browser has skipped (content-visibility: auto) has no layout: its card's top stands in. */
  #top(el) {
    const card = el.closest('section.rb-file');
    return card && card !== el && !this.#rendered(card) ? this.#topOf(card) : this.#topOf(el);
  }

  #topOf(el) {
    return el.getBoundingClientRect().top - this.#article.getBoundingClientRect().top;
  }

  /** Whether a card's contents are laid out right now (false while content-visibility skips them). */
  #rendered(card) {
    const probe = card.firstElementChild;
    return !probe || typeof probe.checkVisibility !== 'function' || probe.checkVisibility({ contentVisibilityAuto: true });
  }

  /** Run fn with el laid out: a card the browser skipped (content-visibility: auto) is forced visible for
   *  the call, since scrollIntoView and geometry reads on skipped content do not lay it out first. */
  #withLayout(el, fn) {
    const card = el.closest('section.rb-file');
    const force = card && card !== el && !this.#rendered(card) ? card : null;
    if (force) force.style.contentVisibility = 'visible';
    fn();
    if (force) requestAnimationFrame(() => { force.style.contentVisibility = ''; });
  }

  /** Height of the sticky file heading, which covers the top of the viewport inside a card.
   *  Measured on a heading that is laid out: one in a skipped card reports 0. */
  #stickyOffset() {
    for (const h2 of this.#article.querySelectorAll('section.rb-file > h2')) if (h2.offsetHeight) return h2.offsetHeight;
    return 0;
  }

  // Scroll-spy. Units and file cards carry data-spy-line and tile the document, so the one crossing
  // a thin band just under the sticky heading is the one being read. IntersectionObserver reports
  // only the elements whose state changed, so the set of what is in the band stays exact at any
  // scroll speed, and nothing is measured on scroll.
  #observeSpy({ force = true } = {}) {
    const targets = this.#article.querySelectorAll('[data-spy-line]');
    const offset = this.#stickyOffset();
    const band = `${offset}:${this.clientHeight}`;
    if (!force && this.#spy && band === this.#spyBand) return;
    this.#spy?.disconnect();
    this.#spyOn.clear();
    this.#spyActive = null;
    this.#spyBand = band;
    if (!targets.length || !this.clientHeight) return;
    const below = Math.max(0, this.clientHeight - offset - 2);
    this.#spy = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) this.#spyOn.add(e.target); else this.#spyOn.delete(e.target); }
      let best = null; // innermost: a unit over the card that contains it
      for (const el of this.#spyOn) if (!best || (el.classList.contains('rb-unit') && !best.classList.contains('rb-unit'))) best = el;
      if (!best || best === this.#spyActive) return;
      this.#spyActive = best;
      this.dispatchEvent(new CustomEvent('preview-section', { detail: { line: Number(best.dataset.spyLine) } }));
    }, { root: this, rootMargin: `-${offset}px 0px -${below}px 0px`, threshold: 0 });
    for (const el of targets) this.#spy.observe(el);
  }

  #emitScroll() {
    if (!this.#blocks.length) return;
    const scrollTop = this.scrollTop;
    const { line, fraction } = this.lineAtScrollTop(scrollTop);
    const atBottom = scrollTop + this.clientHeight >= this.scrollHeight - 2;
    this.dispatchEvent(new CustomEvent('preview-scroll', { detail: { line, fraction, atBottom } }));
  }

  /** Map a scroll offset to a source line plus a fraction of the way to the next block. */
  lineAtScrollTop(scrollTop) {
    const blocks = this.#blocks;
    if (!blocks.length) return { line: 1, fraction: 0 };
    const cards = new Map(); // per card, once per call: laid out? and its top
    const tops = blocks.map((b) => {
      if (!b.card) return this.#topOf(b.el);
      let c = cards.get(b.card);
      if (!c) { c = { rendered: this.#rendered(b.card), top: this.#topOf(b.card) }; cards.set(b.card, c); }
      return c.rendered ? this.#topOf(b.el) : c.top;
    });
    let i = 0;
    while (i + 1 < blocks.length && tops[i + 1] <= scrollTop) i++;
    const cur = blocks[i];
    const next = blocks[i + 1];
    if (!next) {
      const span = Math.max(1, this.scrollHeight - tops[i]);
      return { line: cur.line, fraction: Math.min(1, Math.max(0, (scrollTop - tops[i]) / span)), lineSpan: 1 };
    }
    const ratio = Math.min(1, Math.max(0, (scrollTop - tops[i]) / Math.max(1, tops[i + 1] - tops[i])));
    const lineSpan = next.line - cur.line;
    return { line: cur.line + ratio * lineSpan, fraction: 0 };
  }

  /** Scroll so the block containing `line` (fractional allowed) is at the top. */
  scrollToLine(line, fraction = 0) {
    const blocks = this.#blocks;
    if (!blocks.length) return;
    let i = 0;
    while (i + 1 < blocks.length && blocks[i + 1].line <= line) i++;
    const cur = blocks[i];
    const next = blocks[i + 1];
    // the target may sit in a card the browser has skipped (content-visibility: auto): measure it laid out
    this.#withLayout(cur.el, () => {
      const curTop = this.#top(cur.el);
      let target;
      // inside a file card the heading is sticky: leave room for it so the block is not hidden under it
      const sticky = cur.card?.querySelector(':scope > h2');
      const offset = sticky && sticky !== cur.el ? sticky.offsetHeight : 0;
      if (line < cur.line) {
        target = 0;
      } else if (next) {
        const ratio = (line + fraction - cur.line) / Math.max(1, next.line - cur.line);
        target = curTop + Math.min(1, ratio) * (this.#top(next.el) - curTop);
      } else {
        target = curTop + fraction * cur.el.offsetHeight;
      }
      this.scrollTop = target - offset;
    });
  }

  scrollToBottom() { this.scrollTop = this.scrollHeight; }
}

customElements.define('markdown-preview', MarkdownPreview);
