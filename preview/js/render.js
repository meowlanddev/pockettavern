// Message rendering: roleplay-flavoured markdown + model/regex HTML, sanitized,
// and drawn inside a shadow root so message CSS can't leak into the app.
import DOMPurify from './vendor/purify.js';

const BLOCK_TAG = /^<\/?(div|p|section|article|aside|header|footer|nav|main|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|dl|dt|dd|details|summary|h[1-6]|style|center|blockquote|hr|br|pre|img|svg|hgroup|fieldset|legend|form|label|input|button|progress|meter)\b[^>]*>/i;
const BLOCK_TAG_END = /<\/?(div|p|section|article|aside|header|footer|nav|main|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|dl|dt|dd|details|summary|h[1-6]|style|center|blockquote|hr|br|pre|img|svg|hgroup|fieldset|legend|progress|meter)\b[^>]*>\s*$/i;

function inline(text) {
  // Split into tags and text so attributes are never touched.
  return text.split(/(<[^>]*>)/g).map((seg, i) => {
    if (i % 2 === 1) return seg;
    return seg
      .replace(/<(?![a-zA-Z/!])/g, '&lt;')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w\\])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/(^|[^\w\\])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/("[^"\n]*"|“[^”\n]*”)/g, '<q class="q">$1</q>');
  }).join('');
}

/** Convert message text (markdown-ish + HTML) to sanitized HTML. */
export function formatMessage(text) {
  if (!text) return '';
  const stash = [];
  const keep = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
  let src = String(text).replace(/\r\n?/g, '\n');
  src = src.replace(/```[\w-]*\n?([\s\S]*?)```/g, (m, c) => keep(`<pre><code>${c.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>`));
  src = src.replace(/<style[\s\S]*?<\/style>/gi, (m) => keep(m));
  src = src.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => keep(m));

  const lines = src.split('\n');
  const out = []; // {html, block}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    let m;
    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
      out.push({ html: `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`, block: true });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      out.push({ html: '<hr>', block: true });
    } else if (/^>/.test(t) && !/^>\s*</.test(t)) {
      const quote = [];
      while (i < lines.length && /^>/.test(lines[i].trim())) { quote.push(inline(lines[i].trim().replace(/^>\s?/, ''))); i++; }
      i--;
      out.push({ html: `<blockquote>${quote.join('<br>')}</blockquote>`, block: true });
    } else if (/^[-+]\s+\S/.test(t) || /^\*\s+\S/.test(t)) {
      const items = [];
      while (i < lines.length && (/^[-+]\s+\S/.test(lines[i].trim()) || /^\*\s+\S/.test(lines[i].trim()))) { items.push(`<li>${inline(lines[i].trim().replace(/^[-+*]\s+/, ''))}</li>`); i++; }
      i--;
      out.push({ html: `<ul>${items.join('')}</ul>`, block: true });
    } else if (/^\d+[.)]\s+\S/.test(t)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+\S/.test(lines[i].trim())) { items.push(`<li>${inline(lines[i].trim().replace(/^\d+[.)]\s+/, ''))}</li>`); i++; }
      i--;
      out.push({ html: `<ol>${items.join('')}</ol>`, block: true });
    } else {
      out.push({ html: inline(line), block: false, raw: t });
    }
  }
  // Join lines: <br> between prose lines, nothing next to block-level HTML.
  let html = '';
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    html += cur.html;
    const next = out[i + 1];
    if (!next) break;
    const curRaw = cur.raw ?? '';
    const nextRaw = next.raw ?? '';
    const blocky = cur.block || next.block || BLOCK_TAG_END.test(curRaw) || BLOCK_TAG.test(nextRaw)
      || /^\u0000\d+\u0000$/.test(curRaw) || /^\u0000\d+\u0000$/.test(nextRaw);
    html += blocky ? '\n' : '<br>';
  }
  html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
  // Keep model HTML from escaping its message box.
  html = html.replace(/position\s*:\s*fixed/gi, 'position:relative');
  const clean = DOMPurify.sanitize(html, {
    FORCE_BODY: true,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target', 'open'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'meta', 'link', 'base', 'frame', 'frameset'],
    FORBID_ATTR: ['ping', 'formaction'],
  });
  return allowExternal ? clean : blockExternal(clean);
}

// Like SillyTavern's "Forbid external media": messages can't pull images,
// video or audio from other sites (a card or a prompt injection could use a
// remote image to leak chat text in its URL). The page's Content Security
// Policy enforces the same thing for CSS url(); this just shows a clear
// placeholder instead of a broken image.
let allowExternal = false;
export function setExternalMedia(on) { allowExternal = !!on; }
const REMOTE = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;
function blockExternal(html) {
  if (!/(?:src|poster)\s*=/i.test(html)) return html;
  const t = document.createElement('template');
  t.innerHTML = html;
  for (const el of t.content.querySelectorAll('img, video, audio, source, picture, track, input[type="image"]')) {
    const src = el.getAttribute('src') || el.getAttribute('poster') || '';
    const remote = REMOTE.test(src) || REMOTE.test(el.getAttribute('srcset') || '') || REMOTE.test(el.getAttribute('poster') || '');
    if (!remote) continue;
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
      const ph = document.createElement('span');
      ph.className = 'ext-blocked';
      ph.textContent = `${el.tagName === 'IMG' ? '🖼' : '🎞'} external ${el.tagName === 'IMG' ? 'image' : 'media'} blocked`;
      ph.title = 'Allow it in Settings → Interface → Allow external media';
      el.replaceWith(ph);
    } else {
      el.remove();
    }
  }
  return t.innerHTML;
}

const MESSAGE_CSS = `
:host { display: block; contain: layout; overflow-wrap: anywhere; overflow-x: auto; }
/* Model/preset HTML written for wide PC chats: never wider than the message. */
[style*="width"] { max-width: 100% !important; box-sizing: border-box; }
img, svg, video, canvas, iframe { max-width: 100% !important; height: auto; }
.ext-blocked { display: inline-block; font-size: 0.8em; opacity: 0.7; padding: 2px 8px; border: 1px dashed currentColor; border-radius: 6px; }
/* "Bleed off the edge" negative margins only make the message scroll sideways. */
[style*="margin-left:-"], [style*="margin-left: -"] { margin-left: 0 !important; }
[style*="margin-right:-"], [style*="margin-right: -"] { margin-right: 0 !important; }
/* In a narrow chat (phones, small iPad windows), stack floating pieces instead of squeezing the text beside them.
   The container is #chat (see app.css). */
@container chat (max-width: 640px) {
  [style*="float"] { float: none !important; display: block; clear: both; margin: 10px 0 !important; transform: none !important; }
  [style*="float"]:not([style*="50%"]) { width: auto !important; max-width: 100% !important; }
  [style*="float"][style*="50%"] { margin: 10px auto !important; }
  [style*="display:flex"], [style*="display: flex"] { flex-wrap: wrap; }
  [style*="display:flex"] > *, [style*="display: flex"] > * { min-width: 0; }
  table { display: block; overflow-x: auto; }
}
em { color: var(--em); }
.q { color: var(--quote); }
q { quotes: none; }
q::before, q::after { content: none; }
u { color: var(--underline); }
code { background: #0003; padding: 1px 5px; border-radius: 6px; font-size: .9em; }
pre { background: #0004; padding: 8px 10px; border-radius: 10px; overflow-x: auto; margin: 6px 0; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
blockquote { margin: 6px 0; padding: 2px 10px; border-left: 3px solid var(--line); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
h1, h2, h3, h4, h5, h6 { font-size: 1.05em; margin: .5em 0 .3em; line-height: 1.3; }
h1 { font-size: 1.15em; }
ul, ol { margin: .3em 0; padding-left: 1.4em; }
p { margin: .3em 0; }
img, video { max-width: 100%; height: auto; }
table { border-collapse: collapse; max-width: 100%; }
td, th { border: 1px solid var(--line); padding: 3px 6px; }
summary { cursor: pointer; }
a { color: var(--accent); }
.cursor { display: inline-block; width: 7px; height: 1em; background: var(--accent); vertical-align: -2px; margin-left: 2px; animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
`;

// Extra rules from an imported SillyTavern theme, rewritten to work inside message shadow roots.
let themeShadowCss = '';
let shared = null; // one stylesheet shared by every message (adoptedStyleSheets), when supported
const canAdopt = typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in Document.prototype;
export function setThemeShadowCss(css) {
  themeShadowCss = css || '';
  if (canAdopt) {
    try { shared = shared || new CSSStyleSheet(); shared.replaceSync(MESSAGE_CSS + themeShadowCss); } catch { shared = null; }
  }
}

/** Render sanitized HTML into a host element's shadow root. */
export function renderInto(host, html) {
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  if (canAdopt) {
    if (!shared) setThemeShadowCss(themeShadowCss);
    if (shared) {
      if (root.adoptedStyleSheets[0] !== shared) root.adoptedStyleSheets = [shared];
      root.innerHTML = html;
      return;
    }
  }
  root.innerHTML = `<style>${MESSAGE_CSS}${themeShadowCss}</style>${html}`;
}
