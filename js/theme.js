// Appearance: color themes, chat styles and backgrounds.
// Chat style names follow the Moonlit Echoes theme (https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme);
// the layouts here are PocketTavern's own versions.

export const CHAT_STYLES = {
  bubble: { label: 'Bubble', hint: 'Chat bubbles (default)' },
  flat: { label: 'Flat', hint: 'Full-width rows, no bubbles' },
  document: { label: 'Document', hint: 'Like reading a book; no avatars' },
  echo: { label: 'Echo', hint: 'Cards with a large portrait banner' },
  whisper: { label: 'Whisper', hint: 'Portrait fading in from the corner' },
  hush: { label: 'Hush', hint: 'Minimal, tiny avatars by the names' },
  ripple: { label: 'Ripple', hint: 'Big round avatar beside the text' },
  tide: { label: 'Tide', hint: 'Portrait as a soft background' },
};
// SillyTavern / Moonlit "chat_display" numbers
const DISPLAY_NUM = ['flat', 'bubble', 'document', 'echo', 'whisper', 'hush', 'ripple', 'tide'];

export const AVATAR_SHAPES = { circle: 'Circle', rounded: 'Rounded square', square: 'Square', portrait: 'Portrait' };

const BASE = {
  bg: '#14121a', bg2: '#1c1924', bg3: '#26222f', line: '#332e3d', text: '#ece8f2', muted: '#9a93a8',
  accent: '#a78bfa', accentInk: '#1a1030', user: '#2b2540', char: '#1f1c27', em: '#c4b5d9', quote: '#f3c98b', underline: '#c4b5d9',
  scheme: 'dark',
};

export const THEMES = {
  midnight: { name: 'Midnight', ...BASE },
  moonlit: {
    name: 'Moonlit', ...BASE,
    bg: '#212121', bg2: '#2a2a2a', bg3: '#353535', line: 'rgba(255,255,255,0.09)', text: 'rgb(204,204,204)', muted: '#8f8f8f',
    accent: 'rgb(81,160,222)', accentInk: '#08131c', user: 'rgba(60,60,60,0.75)', char: 'rgba(48,48,48,0.85)',
    em: 'rgb(150,150,150)', quote: 'rgb(81,160,222)', underline: 'rgb(250,198,121)',
  },
  glimmer: {
    name: 'Glimmer', ...BASE,
    bg: '#1e1e1e', bg2: '#262626', bg3: '#303030', line: 'rgba(198,198,198,0.1)', text: 'rgb(198,198,198)', muted: '#858585',
    accent: 'rgb(81,160,222)', accentInk: '#08131c', user: 'rgba(255,255,255,0.04)', char: 'rgba(255,255,255,0.06)',
    em: 'rgb(118,118,118)', quote: 'rgb(81,160,222)', underline: 'rgb(223,223,223)',
  },
  rose: {
    name: 'Rose', ...BASE,
    bg: '#1a1216', bg2: '#24181e', bg3: '#2f2028', line: '#3d2a33', text: '#f1e6ea', muted: '#a88d98',
    accent: '#f08fb0', accentInk: '#2a0f1a', user: '#3a2230', char: '#22171d', em: '#d9b3c2', quote: '#ffc98b', underline: '#f08fb0',
  },
  daylight: {
    name: 'Daylight', ...BASE, scheme: 'light',
    bg: '#f6f4f8', bg2: '#ffffff', bg3: '#ebe7f0', line: '#ddd6e6', text: '#1f1b26', muted: '#6e6680',
    accent: '#7c5cd6', accentInk: '#ffffff', user: '#e9e2fb', char: '#ffffff', em: '#5e5672', quote: '#b4561f', underline: '#7c5cd6',
  },
};

export const COLOR_FIELDS = [
  ['accent', 'Accent'], ['text', 'Text'], ['em', 'Italics / actions'], ['quote', 'Quotes / speech'], ['underline', 'Underline'],
  ['bg', 'Background'], ['bg2', 'Panels'], ['user', 'Your messages'], ['char', 'Character messages'], ['line', 'Borders'],
];

export const DEFAULT_APPEARANCE = Object.freeze({
  theme: 'midnight',
  colors: {},
  chatStyle: 'bubble',
  avatarShape: 'circle',
  bgImage: null,
  bgDim: 0.55,
  bgBlur: 0,
  customCss: '',
  saved: [],
});

/** Full palette = theme + user overrides. */
export function paletteOf(app) {
  const saved = (app.saved || []).find((t) => t.id === app.theme);
  const base = saved ? { ...BASE, ...saved.colors } : (THEMES[app.theme] || THEMES.midnight);
  return { ...base, ...(app.colors || {}) };
}

export function applyAppearance(app) {
  const p = paletteOf(app);
  const r = document.documentElement.style;
  const set = (k, v) => r.setProperty(k, v);
  set('--bg', p.bg); set('--bg2', p.bg2); set('--bg3', p.bg3); set('--line', p.line);
  set('--text', p.text); set('--muted', p.muted || `color-mix(in srgb, ${p.text} 62%, transparent)`);
  set('--accent', p.accent); set('--accent-ink', p.accentInk || '#111');
  set('--user', p.user); set('--char', p.char); set('--em', p.em); set('--quote', p.quote); set('--underline', p.underline || p.accent);
  r.setProperty('color-scheme', p.scheme === 'light' ? 'light' : 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', p.bg);
  const b = document.body.classList;
  [...b].filter((c) => c.startsWith('chat-') || c.startsWith('av-')).forEach((c) => b.remove(c));
  b.add(`chat-${CHAT_STYLES[app.chatStyle] ? app.chatStyle : 'bubble'}`);
  b.add(`av-${AVATAR_SHAPES[app.avatarShape] ? app.avatarShape : 'circle'}`);
  // Only embedded raster images, so a shared backup can't inject CSS through this value.
  const img = typeof app.bgImage === 'string' && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(app.bgImage) ? app.bgImage : null;
  b.toggle('has-bg', !!img);
  set('--bg-img', img ? `url("${img}")` : 'none');
  set('--bg-dim', String(app.bgDim ?? 0.55));
  set('--bg-blur', `${Number(app.bgBlur) || 0}px`);
  let css = document.getElementById('custom-css');
  if (!css) { css = document.createElement('style'); css.id = 'custom-css'; document.head.appendChild(css); }
  css.textContent = app.customCss || '';
}

const asNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Import a SillyTavern UI theme or a Moonlit Echoes preset. Returns { name, colors, chatStyle?, avatarShape? } */
export function importThemeFile(json, fallbackName) {
  if (json && json.pocketTavern && json.pocketTavern.colors) {
    const { scheme, name: _n, ...colors } = json.pocketTavern.colors;
    return { name: json.name || fallbackName, colors: { ...colors, scheme }, chatStyle: json.pocketTavern.chatStyle, avatarShape: json.pocketTavern.avatarShape };
  }
  if (json && json.moonlitEchoesPreset && json.settings) {
    const s = json.settings;
    const colors = {};
    if (s.customThemeColor) { colors.accent = s.customThemeColor; colors.quote = s.customThemeColor; }
    if (s.sheldBackgroundColor) colors.bg2 = s.sheldBackgroundColor;
    if (s.customTopBarColor) colors.bg = s.customTopBarColor;
    if (s.customBgColor1) colors.char = s.customBgColor1;
    if (s.customBgColor2) colors.user = s.customBgColor2;
    return { name: json.presetName || fallbackName, colors };
  }
  if (json && ('main_text_color' in json || 'chat_display' in json || 'quote_text_color' in json)) {
    const colors = {};
    const map = { main_text_color: 'text', italics_text_color: 'em', quote_text_color: 'quote', underline_text_color: 'underline', user_mes_blur_tint_color: 'user', bot_mes_blur_tint_color: 'char' };
    for (const [k, v] of Object.entries(map)) if (json[k]) colors[v] = json[k];
    if (json.blur_tint_color) { colors.bg = solid(json.blur_tint_color); colors.bg2 = json.blur_tint_color; }
    if (json.border_color && !/,\s*0\)$/.test(json.border_color)) colors.line = json.border_color;
    if (json.quote_text_color) colors.accent = json.quote_text_color;
    const out = { name: json.name || fallbackName, colors };
    const d = asNum(json.chat_display);
    if (d !== null && DISPLAY_NUM[d]) out.chatStyle = DISPLAY_NUM[d];
    const a = asNum(json.avatar_style);
    if (a !== null) out.avatarShape = ['circle', 'portrait', 'square', 'rounded'][a] || 'circle';
    return out;
  }
  return null;
}

export const isThemeFile = (json) => !!importThemeFile(json, 'x');

/** rgba(…, a) → rgb(…) so the page background is never see-through. */
function solid(c) {
  const m = String(c).match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : c;
}

/** Export as a SillyTavern UI theme (so it can be imported on PC too). */
export function exportTheme(app, name) {
  const p = paletteOf(app);
  return {
    name,
    main_text_color: p.text,
    italics_text_color: p.em,
    underline_text_color: p.underline,
    quote_text_color: p.quote,
    blur_tint_color: p.bg2,
    user_mes_blur_tint_color: p.user,
    bot_mes_blur_tint_color: p.char,
    border_color: p.line,
    chat_display: Math.max(0, DISPLAY_NUM.indexOf(app.chatStyle)),
    avatar_style: Math.max(0, ['circle', 'portrait', 'square', 'rounded'].indexOf(app.avatarShape)),
    pocketTavern: { colors: p, chatStyle: app.chatStyle, avatarShape: app.avatarShape },
  };
}
