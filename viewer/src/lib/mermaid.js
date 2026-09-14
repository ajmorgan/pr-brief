// ```mermaid fences → inline SVG. The markdown renderer emits a placeholder that shows the
// diagram source as a code block; this module swaps the SVG in once mermaid has drawn it.
//
// - Loaded lazily: vendor/mermaid.js is imported on the first diagram, never before.
// - Drawn in the color scheme: the scheme's UI colors become mermaid theme variables, and a
//   scheme change redraws every diagram on the page.
// - Cached by (scheme, source): a preview re-render on every keystroke, or a theme switched
//   back, reuses the SVG synchronously, so diagrams do not flash. The cache also makes the
//   synchronous HTML export include any diagram the preview has already drawn.
// - Sanitized: mermaid runs at securityLevel "strict" (label text escaped, click handlers off)
//   and the SVG still goes through DOMPurify before it reaches the page: no scripts or forms, and
//   the HTML mermaid puts in a <foreignObject> for a label may only style what a label needs.
//   Mermaid scopes its <style> to the diagram's own id.

import { DOMPurify } from '../../vendor/editor.js';
import { getScheme } from './themes.js';

const cache = new Map(); // `${scheme.id}\0${source}` → sanitized SVG markup
let loading = null;      // the vendor bundle, once asked for
let queue = Promise.resolve(); // renders run one at a time, each after its own initialize()
let seq = 0;

function load() {
  return (loading ??= import('../../vendor/mermaid.js').then((m) => m.mermaid));
}

function currentScheme() {
  return getScheme(document.documentElement.dataset.theme);
}

/** Mermaid's "base" theme, fed from the scheme so a diagram looks like the page around it. */
function themeVariables(s) {
  const ui = s.ui;
  const font = getComputedStyle(document.documentElement).getPropertyValue('--sans').trim() || 'system-ui, sans-serif';
  return {
    darkMode: s.dark,
    background: ui.bg,
    fontFamily: font,
    fontSize: '14px',
    primaryColor: ui.surface2,
    primaryTextColor: ui.fg,
    primaryBorderColor: ui.accent,
    secondaryColor: ui.surface,
    secondaryTextColor: ui.fg,
    secondaryBorderColor: ui.border,
    tertiaryColor: ui.bg,
    tertiaryTextColor: ui.fg,
    tertiaryBorderColor: ui.border,
    lineColor: ui.fg,
    textColor: ui.fg,
    mainBkg: ui.surface2,
    nodeBorder: ui.accent,
    clusterBkg: ui.surface,
    clusterBorder: ui.border,
    titleColor: ui.fg,
    edgeLabelBackground: ui.bg,
    noteBkgColor: ui.surface,
    noteTextColor: ui.fg,
    noteBorderColor: ui.border,
    actorBkg: ui.surface2,
    actorBorder: ui.accent,
    actorTextColor: ui.fg,
    signalColor: ui.fg,
    signalTextColor: ui.fg,
    labelBoxBkgColor: ui.surface,
    labelBoxBorderColor: ui.border,
    labelTextColor: ui.fg,
    loopTextColor: ui.fg,
    activationBkgColor: ui.surface,
    activationBorderColor: ui.accent,
    sequenceNumberColor: ui.bg,
    pie1: ui.accent, pie2: ui.accent2, pie3: ui.muted, pie4: ui.surface2,
    pieTitleTextColor: ui.fg, pieSectionTextColor: ui.fg, pieLegendTextColor: ui.fg, pieStrokeColor: ui.bg,
    git0: ui.accent, git1: ui.accent2, git2: ui.muted, gitBranchLabel0: ui.bg, gitBranchLabel1: ui.bg, commitLabelColor: ui.fg, commitLabelBackground: ui.surface,
    taskBkgColor: ui.surface2, taskBorderColor: ui.accent, taskTextColor: ui.fg, taskTextLightColor: ui.fg, taskTextDarkColor: ui.fg,
    activeTaskBkgColor: ui.accent, activeTaskBorderColor: ui.accent, doneTaskBkgColor: ui.surface, doneTaskBorderColor: ui.border,
    gridColor: ui.border, todayLineColor: ui.accent2, sectionBkgColor: ui.surface, sectionBkgColor2: ui.bg, altSectionBkgColor: ui.bg,
    excludeBkgColor: ui.surface, critBkgColor: ui.accent2, critBorderColor: ui.accent2,
    attributeBackgroundColorOdd: ui.surface, attributeBackgroundColorEven: ui.bg,
    // the categorical scale (mindmap sections, timeline, sankey…) and xychart plots: mermaid's own dark-mode
    // derivation lands near black, so rotate the scheme's accents instead
    ...Object.fromEntries([ui.accent, ui.accent2, ui.muted, ui.surface2].flatMap((c, i) => [[`cScale${i}`, c], [`cScaleLabel${i}`, i < 3 ? ui.bg : ui.fg], [`cScalePeer${i}`, ui.border]])),
    xyChart: { backgroundColor: ui.bg, titleColor: ui.fg, xAxisLabelColor: ui.fg, xAxisTitleColor: ui.fg, xAxisTickColor: ui.muted, xAxisLineColor: ui.muted,
      yAxisLabelColor: ui.fg, yAxisTitleColor: ui.fg, yAxisTickColor: ui.muted, yAxisLineColor: ui.muted, plotColorPalette: `${ui.accent}, ${ui.accent2}, ${ui.muted}` },
  };
}

const purifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  // node labels are HTML in a <foreignObject>: allowed as the one place HTML may sit inside SVG, and
  // stripStyles() below limits what that HTML may style
  ADD_TAGS: ['foreignobject'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  FORBID_TAGS: ['script', 'form', 'button', 'input', 'textarea', 'select', 'iframe', 'object', 'embed', 'audio', 'video', 'link', 'meta', 'base'],
};

// the style properties mermaid puts on HTML inside a foreignObject; anything else (position, z-index…) is dropped
const HTML_STYLE_PROPS = new Set(['color', 'background-color', 'display', 'white-space', 'line-height', 'text-align', 'vertical-align',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'margin', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration']);

function stripStyles(root) {
  for (const el of root.querySelectorAll('foreignObject *[style]')) {
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    const keep = [];
    for (let i = 0; i < el.style.length; i++) {
      const p = el.style[i];
      if (HTML_STYLE_PROPS.has(p)) keep.push(`${p}:${el.style.getPropertyValue(p)}`);
    }
    if (keep.length) el.setAttribute('style', keep.join(';')); else el.removeAttribute('style');
  }
}

function sanitize(svg) {
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(svg, purifyConfig);
  stripStyles(template.content);
  const el = template.content.querySelector('svg');
  if (!el) throw new Error('mermaid produced no SVG');
  el.setAttribute('role', 'img');
  return el.outerHTML;
}

function draw(src, scheme) {
  const run = async () => {
    const mermaid = await load();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      secure: ['themeCSS'], // a diagram's %%{init}%% directive may restyle itself through themeVariables, not through raw CSS
      theme: 'base',
      themeVariables: themeVariables(scheme),
    });
    const { svg } = await mermaid.render(`mermaid-${++seq}`, src);
    return sanitize(svg);
  };
  // one at a time: initialize() sets global config, and a render reads it when it runs, not when it is queued
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
}

function show(el, html) {
  el.innerHTML = html;
  el.dataset.mermaid = 'done';
}

function fail(el, err) {
  const msg = String(err?.message ?? err).split('\n')[0].slice(0, 200);
  const p = document.createElement('p');
  p.className = 'mermaid-error';
  p.textContent = `Mermaid: ${msg}`;
  el.querySelector('.mermaid-error')?.remove();
  el.prepend(p);
  el.dataset.mermaid = 'error';
}

function paint(el) {
  const src = el.mermaidSrc;
  const scheme = currentScheme();
  const key = `${scheme.id}\0${src}`;
  const hit = cache.get(key);
  if (hit) { show(el, hit); return; }
  const job = (el.mermaidJob = (el.mermaidJob ?? 0) + 1);
  draw(src, scheme).then(
    (html) => { cache.set(key, html); if (el.mermaidJob === job) show(el, html); },
    (err) => { if (el.mermaidJob === job) fail(el, err); },
  );
}

/**
 * Take over a placeholder from the markdown renderer: `<div class="mermaid" data-mermaid="pending">`
 * holding the source in a `<pre><code>`. The source is kept on the element so a scheme change can redraw it.
 */
export function mountMermaid(el) {
  const code = el.querySelector('pre > code');
  if (!code) return;
  el.mermaidSrc = code.textContent;
  paint(el);
}

/** Redraw the diagrams on the page for the scheme now applied (a cache hit when it was seen before). */
export function rethemeMermaid() {
  // a drawn diagram keeps its old SVG until the new one is ready: nothing flashes back to source
  for (const el of document.querySelectorAll('.mermaid[data-mermaid]')) if (typeof el.mermaidSrc === 'string') paint(el);
}

// applyScheme() writes the scheme id to <html data-theme>; follow it
new MutationObserver((records) => {
  if (records.some((r) => r.oldValue !== document.documentElement.dataset.theme)) rethemeMermaid();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'], attributeOldValue: true });
