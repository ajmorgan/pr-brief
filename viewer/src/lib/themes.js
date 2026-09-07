// Color schemes.
//
// One palette object drives everything: the app chrome (via CSS custom
// properties on <html>), the CodeMirror editor theme, and syntax colors in
// both the editor and the markdown preview. Switching schemes only swaps
// CSS variables, so it is instant and needs no editor reconfiguration.

const scheme = (id, name, dark, ui, syntax) => ({ id, name, dark, ui, syntax });

export const schemes = [
  scheme('one-dark', 'One Dark', true, {
    bg: '#282c34', fg: '#abb2bf', surface: '#21252b', surface2: '#2c313a', border: '#181a1f',
    muted: '#5c6370', accent: '#61afef', accent2: '#c678dd', selection: '#3e4451',
    lineHighlight: '#2c313c', cursor: '#528bff', gutter: '#4b5263', match: '#e5c07b40',
  }, {
    keyword: '#c678dd', string: '#98c379', comment: '#5c6370', number: '#d19a66', fn: '#61afef',
    variable: '#e06c75', type: '#e5c07b', operator: '#56b6c2', heading: '#e06c75', link: '#61afef',
    emphasis: '#c678dd', punctuation: '#abb2bf', tag: '#e06c75', attribute: '#d19a66', invalid: '#ff5370',
  }),
  scheme('github-light', 'GitHub Light', false, {
    bg: '#ffffff', fg: '#1f2328', surface: '#f6f8fa', surface2: '#eaeef2', border: '#d0d7de',
    muted: '#6e7781', accent: '#0969da', accent2: '#8250df', selection: '#ddf4ff',
    lineHighlight: '#f6f8fa', cursor: '#1f2328', gutter: '#8c959f', match: '#fff8c5',
  }, {
    keyword: '#cf222e', string: '#0a3069', comment: '#6e7781', number: '#0550ae', fn: '#8250df',
    variable: '#953800', type: '#953800', operator: '#0550ae', heading: '#0550ae', link: '#0969da',
    emphasis: '#8250df', punctuation: '#1f2328', tag: '#116329', attribute: '#0550ae', invalid: '#82071e',
  }),
  scheme('github-dark', 'GitHub Dark', true, {
    bg: '#0d1117', fg: '#e6edf3', surface: '#161b22', surface2: '#21262d', border: '#30363d',
    muted: '#8b949e', accent: '#58a6ff', accent2: '#bc8cff', selection: '#264f78',
    lineHighlight: '#161b22', cursor: '#e6edf3', gutter: '#6e7681', match: '#9e6a0340',
  }, {
    keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e', number: '#79c0ff', fn: '#d2a8ff',
    variable: '#ffa657', type: '#ffa657', operator: '#79c0ff', heading: '#79c0ff', link: '#58a6ff',
    emphasis: '#d2a8ff', punctuation: '#e6edf3', tag: '#7ee787', attribute: '#79c0ff', invalid: '#ffa198',
  }),
  scheme('dracula', 'Dracula', true, {
    bg: '#282a36', fg: '#f8f8f2', surface: '#21222c', surface2: '#343746', border: '#191a21',
    muted: '#6272a4', accent: '#bd93f9', accent2: '#ff79c6', selection: '#44475a',
    lineHighlight: '#2f313f', cursor: '#f8f8f2', gutter: '#6272a4', match: '#ffb86c40',
  }, {
    keyword: '#ff79c6', string: '#f1fa8c', comment: '#6272a4', number: '#bd93f9', fn: '#50fa7b',
    variable: '#f8f8f2', type: '#8be9fd', operator: '#ff79c6', heading: '#bd93f9', link: '#8be9fd',
    emphasis: '#ffb86c', punctuation: '#f8f8f2', tag: '#ff79c6', attribute: '#50fa7b', invalid: '#ff5555',
  }),
  scheme('nord', 'Nord', true, {
    bg: '#2e3440', fg: '#d8dee9', surface: '#3b4252', surface2: '#434c5e', border: '#242933',
    muted: '#4c566a', accent: '#88c0d0', accent2: '#b48ead', selection: '#434c5e',
    lineHighlight: '#3b4252', cursor: '#d8dee9', gutter: '#4c566a', match: '#ebcb8b40',
  }, {
    keyword: '#81a1c1', string: '#a3be8c', comment: '#616e88', number: '#b48ead', fn: '#88c0d0',
    variable: '#d8dee9', type: '#8fbcbb', operator: '#81a1c1', heading: '#88c0d0', link: '#5e81ac',
    emphasis: '#b48ead', punctuation: '#eceff4', tag: '#81a1c1', attribute: '#8fbcbb', invalid: '#bf616a',
  }),
  scheme('gruvbox-dark', 'Gruvbox Dark', true, {
    bg: '#282828', fg: '#ebdbb2', surface: '#1d2021', surface2: '#3c3836', border: '#1d2021',
    muted: '#928374', accent: '#fabd2f', accent2: '#d3869b', selection: '#504945',
    lineHighlight: '#32302f', cursor: '#ebdbb2', gutter: '#7c6f64', match: '#fabd2f40',
  }, {
    keyword: '#fb4934', string: '#b8bb26', comment: '#928374', number: '#d3869b', fn: '#fabd2f',
    variable: '#83a598', type: '#fabd2f', operator: '#fe8019', heading: '#fabd2f', link: '#83a598',
    emphasis: '#8ec07c', punctuation: '#ebdbb2', tag: '#8ec07c', attribute: '#fabd2f', invalid: '#fb4934',
  }),
  scheme('gruvbox-light', 'Gruvbox Light', false, {
    bg: '#fbf1c7', fg: '#3c3836', surface: '#f2e5bc', surface2: '#ebdbb2', border: '#d5c4a1',
    muted: '#928374', accent: '#b57614', accent2: '#8f3f71', selection: '#d5c4a1',
    lineHighlight: '#f2e5bc', cursor: '#3c3836', gutter: '#a89984', match: '#b5761440',
  }, {
    keyword: '#9d0006', string: '#79740e', comment: '#928374', number: '#8f3f71', fn: '#b57614',
    variable: '#076678', type: '#b57614', operator: '#af3a03', heading: '#b57614', link: '#076678',
    emphasis: '#427b58', punctuation: '#3c3836', tag: '#427b58', attribute: '#b57614', invalid: '#9d0006',
  }),
  scheme('solarized-dark', 'Solarized Dark', true, {
    bg: '#002b36', fg: '#839496', surface: '#073642', surface2: '#0a4050', border: '#00212b',
    muted: '#586e75', accent: '#268bd2', accent2: '#d33682', selection: '#073642',
    lineHighlight: '#073642', cursor: '#93a1a1', gutter: '#586e75', match: '#b5890040',
  }, {
    keyword: '#859900', string: '#2aa198', comment: '#586e75', number: '#d33682', fn: '#268bd2',
    variable: '#b58900', type: '#b58900', operator: '#859900', heading: '#cb4b16', link: '#268bd2',
    emphasis: '#6c71c4', punctuation: '#93a1a1', tag: '#268bd2', attribute: '#93a1a1', invalid: '#dc322f',
  }),
  scheme('solarized-light', 'Solarized Light', false, {
    bg: '#fdf6e3', fg: '#657b83', surface: '#eee8d5', surface2: '#e4ddc8', border: '#d3cbb7',
    muted: '#93a1a1', accent: '#268bd2', accent2: '#d33682', selection: '#eee8d5',
    lineHighlight: '#eee8d5', cursor: '#586e75', gutter: '#93a1a1', match: '#b5890040',
  }, {
    keyword: '#859900', string: '#2aa198', comment: '#93a1a1', number: '#d33682', fn: '#268bd2',
    variable: '#b58900', type: '#b58900', operator: '#859900', heading: '#cb4b16', link: '#268bd2',
    emphasis: '#6c71c4', punctuation: '#586e75', tag: '#268bd2', attribute: '#586e75', invalid: '#dc322f',
  }),
  scheme('catppuccin-mocha', 'Catppuccin Mocha', true, {
    bg: '#1e1e2e', fg: '#cdd6f4', surface: '#181825', surface2: '#313244', border: '#11111b',
    muted: '#6c7086', accent: '#89b4fa', accent2: '#f5c2e7', selection: '#45475a',
    lineHighlight: '#2a2b3c', cursor: '#f5e0dc', gutter: '#6c7086', match: '#f9e2af40',
  }, {
    keyword: '#cba6f7', string: '#a6e3a1', comment: '#6c7086', number: '#fab387', fn: '#89b4fa',
    variable: '#f38ba8', type: '#f9e2af', operator: '#89dceb', heading: '#f38ba8', link: '#89b4fa',
    emphasis: '#f5c2e7', punctuation: '#cdd6f4', tag: '#f38ba8', attribute: '#f9e2af', invalid: '#f38ba8',
  }),
  scheme('catppuccin-latte', 'Catppuccin Latte', false, {
    bg: '#eff1f5', fg: '#4c4f69', surface: '#e6e9ef', surface2: '#dce0e8', border: '#ccd0da',
    muted: '#9ca0b0', accent: '#1e66f5', accent2: '#ea76cb', selection: '#ccd0da',
    lineHighlight: '#e6e9ef', cursor: '#dc8a78', gutter: '#9ca0b0', match: '#df8e1d40',
  }, {
    keyword: '#8839ef', string: '#40a02b', comment: '#9ca0b0', number: '#fe640b', fn: '#1e66f5',
    variable: '#d20f39', type: '#df8e1d', operator: '#04a5e5', heading: '#d20f39', link: '#1e66f5',
    emphasis: '#ea76cb', punctuation: '#4c4f69', tag: '#d20f39', attribute: '#df8e1d', invalid: '#d20f39',
  }),
  scheme('tokyo-night', 'Tokyo Night', true, {
    bg: '#1a1b26', fg: '#a9b1d6', surface: '#16161e', surface2: '#24283b', border: '#101014',
    muted: '#565f89', accent: '#7aa2f7', accent2: '#bb9af7', selection: '#33467c',
    lineHighlight: '#1e2030', cursor: '#c0caf5', gutter: '#3b4261', match: '#e0af6840',
  }, {
    keyword: '#bb9af7', string: '#9ece6a', comment: '#565f89', number: '#ff9e64', fn: '#7aa2f7',
    variable: '#c0caf5', type: '#2ac3de', operator: '#89ddff', heading: '#7aa2f7', link: '#73daca',
    emphasis: '#bb9af7', punctuation: '#a9b1d6', tag: '#f7768e', attribute: '#bb9af7', invalid: '#f7768e',
  }),
  scheme('rose-pine-dawn', 'Rosé Pine Dawn', false, {
    bg: '#faf4ed', fg: '#575279', surface: '#fffaf3', surface2: '#f2e9e1', border: '#dfdad9',
    muted: '#9893a5', accent: '#286983', accent2: '#907aa9', selection: '#dfdad9',
    lineHighlight: '#f4ede8', cursor: '#575279', gutter: '#9893a5', match: '#ea9d3440',
  }, {
    keyword: '#286983', string: '#ea9d34', comment: '#9893a5', number: '#b4637a', fn: '#d7827e',
    variable: '#575279', type: '#56949f', operator: '#286983', heading: '#b4637a', link: '#907aa9',
    emphasis: '#907aa9', punctuation: '#797593', tag: '#286983', attribute: '#907aa9', invalid: '#b4637a',
  }),
  scheme('monokai', 'Monokai', true, {
    bg: '#272822', fg: '#f8f8f2', surface: '#1e1f1c', surface2: '#3e3d32', border: '#171814',
    muted: '#75715e', accent: '#a6e22e', accent2: '#f92672', selection: '#49483e',
    lineHighlight: '#3e3d32', cursor: '#f8f8f0', gutter: '#90908a', match: '#e6db7440',
  }, {
    keyword: '#f92672', string: '#e6db74', comment: '#75715e', number: '#ae81ff', fn: '#a6e22e',
    variable: '#f8f8f2', type: '#66d9ef', operator: '#f92672', heading: '#a6e22e', link: '#66d9ef',
    emphasis: '#fd971f', punctuation: '#f8f8f2', tag: '#f92672', attribute: '#a6e22e', invalid: '#f92672',
  }),
];

export const defaultDark = 'github-dark';
export const defaultLight = 'github-light';

export function getScheme(id) {
  return schemes.find((s) => s.id === id) ?? schemes[0];
}

/** Apply a scheme by writing CSS custom properties to the root element. */
export function applyScheme(id) {
  const s = getScheme(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(s.ui)) root.style.setProperty(`--${k}`, v);
  for (const [k, v] of Object.entries(s.syntax)) root.style.setProperty(`--syn-${k}`, v);
  root.dataset.theme = s.id;
  root.style.colorScheme = s.dark ? 'dark' : 'light';
  // Keep the OS/browser chrome in sync with the app (see book §3.3.4).
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', s.ui.surface);
  return s;
}

/** Inline CSS for exported HTML so a saved preview keeps its colors. */
export function schemeCSS(id) {
  const s = getScheme(id);
  const vars = [
    ...Object.entries(s.ui).map(([k, v]) => `--${k}:${v}`),
    ...Object.entries(s.syntax).map(([k, v]) => `--syn-${k}:${v}`),
  ];
  return `:root{${vars.join(';')};color-scheme:${s.dark ? 'dark' : 'light'}}`;
}
