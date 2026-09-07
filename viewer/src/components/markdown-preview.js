// <markdown-preview>: renders markdown and reports scroll position in
// source-line terms so the editor and preview can stay aligned.
// Emits: preview-scroll {line, fraction}.

import { renderMarkdown } from '../lib/markdown.js';

export class MarkdownPreview extends HTMLElement {
  #article;
  #blocks = [];
  #raf = 0;

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
  }

  render(markdown) {
    const open = this.#openFolds();
    const fragment = renderMarkdown(markdown);
    this.#article.replaceChildren(fragment);
    this.#restoreFolds(open);
    this.#collectBlocks();
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
  }

  get html() { return this.#article.innerHTML; }

  #collectBlocks() {
    this.#blocks = [...this.#article.querySelectorAll('[data-line]')]
      .map((el) => ({ el, line: Number(el.dataset.line) }))
      .filter((b) => Number.isFinite(b.line));
  }

  #handleClick(e) {
    // In-document links: scroll the preview rather than navigating the app.
    const a = e.target.closest('a[href^="#"]');
    if (a) {
      e.preventDefault();
      const id = decodeURIComponent(a.getAttribute('href').slice(1));
      this.#article.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // Double-click a block to jump the editor to its source line.
    if (e.detail === 2) {
      const block = e.target.closest('[data-line]');
      if (block) this.dispatchEvent(new CustomEvent('goto-line', { detail: { line: Number(block.dataset.line) } }));
    }
  }

  /** Offset of a block relative to the scroll container's content. */
  #top(el) {
    return el.getBoundingClientRect().top - this.#article.getBoundingClientRect().top;
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
    const tops = blocks.map((b) => this.#top(b.el));
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
    const curTop = this.#top(cur.el);
    let target;
    // inside a file card the heading is sticky: leave room for it so the block is not hidden under it
    const sticky = cur.el.closest('section.rb-file')?.querySelector(':scope > h2');
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
  }

  scrollToBottom() { this.scrollTop = this.scrollHeight; }
}

customElements.define('markdown-preview', MarkdownPreview);
