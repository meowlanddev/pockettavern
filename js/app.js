import * as db from './db.js';
import { parseCardFile, blobToAvatar, exportCardPng, toV2 } from './card.js';
import { buildPrompt, macros } from './prompt.js';
import { PROVIDERS, generate, listModels } from './api.js';

const VERSION = '1.0.0';
const DEFAULT_MAIN = "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}. Write one reply only, in an immersive roleplay style. Stay in character. Never write {{user}}'s dialogue or actions.";

function defaultSettings() {
  const pid = db.uid();
  return {
    connections: [],
    activeConnection: null,
    preset: {
      temperature: 0.9, top_p: 1, top_k: 0, min_p: 0,
      frequency_penalty: 0, presence_penalty: 0, repetition_penalty: 1,
      max_tokens: 600, context_size: 32000, stream: true,
      claude_sampling: false, claude_effort: '',
    },
    prompt: {
      main: DEFAULT_MAIN, post_history: '',
      prefer_card_system: true, prefer_card_post_history: true, wi_scan_depth: 4,
    },
    personas: [{ id: pid, name: 'User', description: '', avatar: null }],
    activePersona: pid,
    ui: { enterSends: false, fontSize: 16 },
  };
}

// ---------- state & helpers ----------
const S = {
  settings: null,
  char: null,
  chat: null,
  chats: [],
  generating: null, // chat id currently generating
  abort: null,
  editing: null, // message id being edited
  openActions: null, // message id with action row open
  draft: null, // character being edited
  models: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = (s) => { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.codePointAt(0)) % 360; return h; };
const isTouch = matchMedia('(pointer: coarse)').matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
$('#toast').addEventListener('click', () => $('#toast').classList.remove('show'));

let saveTimer;
function saveSettings(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => db.put('kv', S.settings, 'settings');
  if (now) return doSave();
  saveTimer = setTimeout(doSave, 400);
}

const activeConn = () => S.settings.connections.find((c) => c.id === S.settings.activeConnection) || null;
const activePersona = () => S.settings.personas.find((p) => p.id === S.settings.activePersona) || S.settings.personas[0];

// Avatars must be embedded raster images, never remote URLs or active SVG.
function safeAvatar(src) {
  return typeof src === 'string' && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(src) ? src : null;
}

function avatarHtml(src, name, cls = 'av') {
  src = safeAvatar(src);
  return src
    ? `<img class="${cls}" src="${esc(src)}" alt="">`
    : `<div class="${cls} av-fallback" style="--h:${hue(name)}">${esc((name || '?').trim()[0]?.toUpperCase() || '?')}</div>`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString();
}

/** Lightweight roleplay formatter: *actions*, "speech", **bold**, `code`. Input is escaped first. */
function fmt(text) {
  const blocks = [];
  let h = esc(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (m, c) => {
    blocks.push(`<pre><code>${c}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  h = h
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/(&quot;|“)([^\n]*?)(&quot;|”)/g, '<span class="q">$1$2$3</span>')
    .replace(/\n/g, '<br>');
  return h.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[+i]);
}

async function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (isTouch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}

const safeName = (s) => String(s || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

function pickFile(id) {
  return new Promise((resolve) => {
    const input = $('#' + id);
    input.value = '';
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

// ---------- sheets (bottom modals) ----------
function openSheet(html, cls = '') {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="backdrop" data-action="close-sheet"></div><div class="sheet ${cls}"><button class="icon-btn sm sheet-close" data-action="close-sheet" aria-label="Close">${ICONS.close}</button><div class="sheet-body">${html}</div></div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  return wrap.querySelector('.sheet-body');
}
function closeSheet() {
  document.querySelectorAll('.sheet-wrap').forEach((w) => w.remove());
}

// ---------- viewport (iOS keyboard handling) ----------
function fitViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  const root = document.documentElement.style;
  root.setProperty('--app-h', `${h}px`);
  root.setProperty('--app-top', `${vv ? vv.offsetTop : 0}px`);
  document.body.classList.toggle('kb-open', !!vv && window.innerHeight - vv.height > 120);
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', fitViewport);
  visualViewport.addEventListener('scroll', fitViewport);
}
window.addEventListener('resize', fitViewport);

// ---------- routing ----------
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: parts[0] || 'home', a: parts[1], b: parts[2] };
}
const go = (hash) => { location.hash = hash; };

async function render() {
  const r = route();
  closeSheet();
  S.openActions = null;
  S.editing = null;
  document.documentElement.style.setProperty('--font', `${S.settings.ui.fontSize || 16}px`);
  try {
    if (r.name === 'chat' && r.a) await renderChatView(r.a, r.b);
    else if (r.name === 'edit' && r.a) await renderEditView(r.a);
    else if (r.name === 'settings') renderSettingsView(r.a);
    else await renderHome();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 5000);
    if (r.name !== 'home') go('#/');
  }
}
window.addEventListener('hashchange', render);

// ---------- HOME ----------
async function renderHome() {
  const chars = (await db.getAll('characters')).sort((a, b) => (b.lastChatAt || b.updatedAt || 0) - (a.lastChatAt || a.updatedAt || 0));
  const conn = activeConn();
  const q = S.homeQuery || '';
  const list = chars.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.tags || []).some((t) => t.toLowerCase().includes(q.toLowerCase())));
  app.innerHTML = `
    <header class="bar">
      <h1 class="title">PocketTavern</h1>
      <div class="spacer"></div>
      <button class="icon-btn" data-action="import-cards" aria-label="Import character">${ICONS.import}</button>
      <button class="icon-btn" data-action="go" data-to="#/edit/new" aria-label="New character">${ICONS.plus}</button>
      <button class="icon-btn" data-action="go" data-to="#/settings" aria-label="Settings">${ICONS.gear}</button>
    </header>
    <main class="scroll pad">
      ${isIOS && !isStandalone ? `<div class="banner">Install: tap <b>Share</b> ${ICONS.share} then <b>Add to Home Screen</b> for the full-screen app.</div>` : ''}
      ${!conn || !conn.model ? `<button class="banner warn" data-action="go" data-to="#/settings/connection">No API connection yet — tap to set up OpenRouter, Claude or another API.</button>` : ''}
      ${chars.length ? `<input class="search" type="search" placeholder="Search characters" value="${esc(q)}" data-input="home-search">` : ''}
      <div class="char-list">
        ${list.map((c) => `
          <button class="char-item" data-action="go" data-to="#/chat/${c.id}">
            ${avatarHtml(c.avatar, c.name, 'av lg')}
            <div class="ci-text">
              <div class="ci-name">${esc(c.name)}</div>
              <div class="ci-desc">${esc(macros(c.creator_notes || c.description, { char: c.name, user: activePersona().name }).replace(/\s+/g, ' ').slice(0, 140))}</div>
            </div>
            <div class="ci-time">${timeAgo(c.lastChatAt)}</div>
          </button>`).join('')}
      </div>
      ${!chars.length ? `
        <div class="empty">
          <p>No characters yet.</p>
          <p class="muted">Import SillyTavern / TavernAI cards (PNG or JSON), e.g. ones you downloaded from chub.ai, or create your own.</p>
          <div class="row center">
            <button class="btn primary" data-action="import-cards">Import card</button>
            <button class="btn" data-action="go" data-to="#/edit/new">Create character</button>
          </div>
        </div>` : ''}
    </main>`;
}

async function importCards() {
  const files = await pickFile('file-cards');
  let ok = 0;
  let lastId = null;
  for (const f of files) {
    try {
      const { card, avatarBlob } = await parseCardFile(f);
      const now = Date.now();
      const c = { id: db.uid(), ...card, avatar: avatarBlob ? await blobToAvatar(avatarBlob) : null, createdAt: now, updatedAt: now };
      await db.put('characters', c);
      ok++;
      lastId = c.id;
    } catch (e) {
      toast(e.message, 5000);
    }
  }
  if (ok) {
    toast(`Imported ${ok} character${ok > 1 ? 's' : ''}`);
    if (ok === 1) go(`#/chat/${lastId}`);
    else render();
  }
}

// ---------- CHAT ----------
function greetingMessage(char) {
  const swipes = [char.first_mes, ...(char.alternate_greetings || [])].filter((s) => s && s.trim());
  if (!swipes.length) return [];
  return [{ id: db.uid(), role: 'assistant', swipes, swipeIdx: 0, ts: Date.now(), greeting: true }];
}

async function createChat(char) {
  const now = Date.now();
  const chat = {
    id: db.uid(), charId: char.id,
    title: new Date(now).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    createdAt: now, updatedAt: now,
    messages: greetingMessage(char),
  };
  await db.put('chats', chat);
  return chat;
}

async function saveChat(chat) {
  chat.updatedAt = Date.now();
  await db.put('chats', chat);
  const c = await db.get('characters', chat.charId);
  if (c) {
    c.lastChatAt = chat.updatedAt;
    c.lastChatId = chat.id;
    await db.put('characters', c);
    if (S.char && S.char.id === c.id) { S.char.lastChatAt = c.lastChatAt; S.char.lastChatId = c.lastChatId; }
  }
}

async function renderChatView(charId, chatId) {
  const char = await db.get('characters', charId);
  if (!char) throw new Error('Character not found');
  S.char = char;
  S.chats = (await db.byIndex('chats', 'charId', charId)).sort((a, b) => b.updatedAt - a.updatedAt);
  let chat = chatId ? S.chats.find((c) => c.id === chatId) : (S.chats.find((c) => c.id === char.lastChatId) || S.chats[0]);
  if (!chat) {
    chat = await createChat(char);
    S.chats.unshift(chat);
  }
  // Keep the in-memory object if this chat is currently generating, so streaming continues to update it.
  if (S.chat && S.chat.id === chat.id && S.generating === chat.id) chat = S.chat;
  S.chat = chat;
  const conn = activeConn();
  app.innerHTML = `
    <header class="bar chat-bar">
      <button class="icon-btn" data-action="go" data-to="#/" aria-label="Back">${ICONS.back}</button>
      <button class="chat-title" data-action="chat-menu">
        ${avatarHtml(char.avatar, char.name, 'av sm')}
        <span class="ct-text"><span class="ct-name">${esc(char.name)}</span><span class="ct-sub">${esc(conn ? (conn.model || 'no model') : 'no connection')}</span></span>
      </button>
      <button class="icon-btn" data-action="chat-menu" aria-label="Chat menu">${ICONS.dots}</button>
    </header>
    <main class="scroll messages" id="msgs"></main>
    <footer class="composer">
      <textarea id="input" rows="1" placeholder="Message ${esc(char.name)}" enterkeyhint="${S.settings.ui.enterSends ? 'send' : 'enter'}"></textarea>
      <button class="send-btn" id="send" data-action="send" aria-label="Send">${ICONS.send}</button>
    </footer>`;
  const input = $('#input');
  input.value = S.chat.draftInput || '';
  autosize(input);
  input.addEventListener('input', () => { autosize(input); S.chat.draftInput = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (S.settings.ui.enterSends || !isTouch)) {
      e.preventDefault();
      sendMessage();
    }
  });
  renderMessages(true);
  updateSendButton();
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.35)) + 'px';
}

function ctxNames() {
  return { char: S.char.name, user: activePersona().name || 'User' };
}

function msgHtml(msg, isLast) {
  const isUser = msg.role === 'user';
  const persona = activePersona();
  const name = isUser ? persona.name : S.char.name;
  const avatar = isUser ? persona.avatar : S.char.avatar;
  const raw = msg.swipes[msg.swipeIdx] || '';
  const generatingThis = S.generating === S.chat.id && isLast && !isUser;
  const editing = S.editing === msg.id;
  const n = msg.swipes.length;
  let body;
  if (editing) {
    body = `<textarea class="edit-box" id="edit-box">${esc(raw)}</textarea>
      <div class="row end"><button class="btn sm" data-action="edit-cancel">Cancel</button><button class="btn sm primary" data-action="edit-save" data-id="${msg.id}">Save</button></div>`;
  } else {
    body = `<div class="text">${raw ? fmt(macros(raw, ctxNames())) : (generatingThis ? '<span class="typing"><i></i><i></i><i></i></span>' : '<span class="muted">(empty)</span>')}</div>`;
  }
  const swipes = (!isUser && isLast && !editing && (n > 1 || !msg.greeting))
    ? `<div class="swipes">
        <button class="sw-btn" data-action="swipe" data-dir="-1" ${msg.swipeIdx === 0 || generatingThis ? 'disabled' : ''} aria-label="Previous swipe">${ICONS.left}</button>
        <span>${msg.swipeIdx + 1}/${n}</span>
        <button class="sw-btn" data-action="swipe" data-dir="1" ${generatingThis ? 'disabled' : ''} aria-label="Next swipe">${ICONS.right}</button>
      </div>` : '';
  const actions = S.openActions === msg.id && !editing ? `
    <div class="msg-actions">
      <button data-action="msg-edit" data-id="${msg.id}">${ICONS.edit}<span>Edit</span></button>
      <button data-action="msg-copy" data-id="${msg.id}">${ICONS.copy}<span>Copy</span></button>
      ${!isUser && isLast ? `<button data-action="msg-regen" data-id="${msg.id}">${ICONS.refresh}<span>Redo</span></button>` : ''}
      <button data-action="msg-branch" data-id="${msg.id}">${ICONS.branch}<span>Branch</span></button>
      <button class="danger" data-action="msg-delete" data-id="${msg.id}">${ICONS.trash}<span>Delete</span></button>
    </div>` : '';
  return `<div class="msg ${isUser ? 'user' : 'char'}" data-id="${msg.id}">
      ${avatarHtml(avatar, name, 'av sm')}
      <div class="bubble" data-action="toggle-msg" data-id="${msg.id}">
        <div class="name">${esc(name)}</div>
        ${body}
        ${swipes}
      </div>
      ${actions}
    </div>`;
}

function renderMessages(scrollBottom = false) {
  const box = $('#msgs');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const msgs = S.chat.messages;
  box.innerHTML = msgs.length
    ? msgs.map((m, i) => msgHtml(m, i === msgs.length - 1)).join('')
    : `<div class="empty muted">Say hello to ${esc(S.char.name)}.</div>`;
  if (scrollBottom || nearBottom) box.scrollTop = box.scrollHeight;
  const eb = $('#edit-box');
  if (eb) { autosize(eb); eb.focus(); }
}

let streamRaf = 0;
function updateStreamingMessage(msg) {
  if (streamRaf) return;
  streamRaf = requestAnimationFrame(() => {
    streamRaf = 0;
    const box = $('#msgs');
    if (!box || !S.generating || !S.chat || !S.chat.messages.includes(msg)) return;
    const el = box.querySelector(`.msg[data-id="${msg.id}"] .text`);
    if (!el) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    el.innerHTML = fmt(macros(msg.swipes[msg.swipeIdx] || '', ctxNames())) + '<span class="cursor"></span>';
    if (nearBottom) box.scrollTop = box.scrollHeight;
  });
}

function updateSendButton() {
  const btn = $('#send');
  if (!btn) return;
  const busy = S.generating && S.chat && S.generating === S.chat.id;
  btn.innerHTML = busy ? ICONS.stop : ICONS.send;
  btn.classList.toggle('stop', !!busy);
  btn.dataset.action = busy ? 'stop' : 'send';
}

async function sendMessage() {
  if (S.generating) return toast('Wait for the current reply (or tap stop).');
  const input = $('#input');
  const text = input.value.trim();
  const chat = S.chat;
  if (text) {
    chat.messages.push({ id: db.uid(), role: 'user', swipes: [text], swipeIdx: 0, ts: Date.now() });
    input.value = '';
    chat.draftInput = '';
    autosize(input);
    await saveChat(chat);
    renderMessages(true);
  } else if (!chat.messages.length || chat.messages[chat.messages.length - 1].role !== 'user') {
    // Empty send with no pending user message: let the character continue anyway (like SillyTavern).
    if (!chat.messages.length) return;
  }
  await runGeneration('new');
}

/**
 * mode: 'new' (append a reply), 'swipe' (add an alternative to the last reply), 'regen' (replace current swipe)
 */
async function runGeneration(mode) {
  const conn = activeConn();
  if (!conn || !conn.model) {
    toast('Set up an API connection first (Settings → Connection).', 4000);
    return;
  }
  const chat = S.chat;
  const char = S.char;
  let msg;
  if (mode === 'new') {
    msg = { id: db.uid(), role: 'assistant', swipes: [''], swipeIdx: 0, ts: Date.now() };
    chat.messages.push(msg);
  } else {
    msg = chat.messages[chat.messages.length - 1];
    if (!msg || msg.role !== 'assistant') return;
    if (mode === 'swipe') { msg.swipes.push(''); msg.swipeIdx = msg.swipes.length - 1; } else msg.swipes[msg.swipeIdx] = '';
    msg.greeting = false;
  }
  const history = chat.messages.slice(0, chat.messages.indexOf(msg));
  const { messages } = buildPrompt({ char, persona: activePersona(), settings: S.settings, history });
  const idx = msg.swipeIdx;
  S.generating = chat.id;
  S.abort = new AbortController();
  S.openActions = null;
  renderMessages(true);
  updateSendButton();
  let failed = null;
  try {
    const text = await generate(conn, S.settings.preset, messages, {
      signal: S.abort.signal,
      onToken: (t) => { msg.swipes[idx] = t; updateStreamingMessage(msg); },
    });
    msg.swipes[idx] = (text || msg.swipes[idx] || '').replace(/^\s+/, '');
  } catch (e) {
    if (e.name !== 'AbortError') failed = e;
  } finally {
    S.generating = null;
    S.abort = null;
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
  if (!msg.swipes[idx].trim()) {
    // Nothing generated: roll back the empty message / swipe.
    if (mode === 'new') chat.messages.splice(chat.messages.indexOf(msg), 1);
    else if (mode === 'swipe') { msg.swipes.splice(idx, 1); msg.swipeIdx = Math.max(0, msg.swipes.length - 1); }
  }
  msg.ts = Date.now();
  await saveChat(chat);
  if (S.chat === chat) { renderMessages(); updateSendButton(); }
  if (failed) {
    console.error(failed);
    toast(failed.message || String(failed), 8000);
  }
}

function findMsg(id) {
  return S.chat.messages.find((m) => m.id === id);
}

async function swipe(dir) {
  if (S.generating) return;
  const msg = S.chat.messages[S.chat.messages.length - 1];
  if (!msg || msg.role !== 'assistant') return;
  if (dir < 0) {
    if (msg.swipeIdx > 0) msg.swipeIdx--;
  } else if (msg.swipeIdx < msg.swipes.length - 1) {
    msg.swipeIdx++;
  } else {
    // Swiping right past the last alternative generates a new one (greetings just cycle).
    if (msg.greeting) return;
    return runGeneration('swipe');
  }
  await saveChat(S.chat);
  renderMessages();
}

// Horizontal swipe gesture on the last character message.
let touchStart = null;
document.addEventListener('touchstart', (e) => {
  const bubble = e.target.closest('#msgs .msg.char:last-child .bubble');
  touchStart = bubble && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touchStart || S.editing) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 40) swipe(dx < 0 ? 1 : -1);
}, { passive: true });

function chatMenu() {
  const chats = S.chats.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  openSheet(`
    <div class="sheet-head">
      ${avatarHtml(S.char.avatar, S.char.name, 'av md')}
      <div><div class="sh-title">${esc(S.char.name)}</div><div class="muted small">${chats.length} chat${chats.length === 1 ? '' : 's'}</div></div>
    </div>
    <div class="menu-grid">
      <button data-action="new-chat">${ICONS.plus}<span>New chat</span></button>
      <button data-action="go" data-to="#/edit/${S.char.id}">${ICONS.edit}<span>Edit character</span></button>
      <button data-action="view-prompt">${ICONS.eye}<span>View prompt</span></button>
      <button data-action="export-chat">${ICONS.download}<span>Export chat</span></button>
      <button data-action="import-chat">${ICONS.import}<span>Import ST chat</span></button>
      <button data-action="go" data-to="#/settings">${ICONS.gear}<span>Settings</span></button>
    </div>
    <h3 class="sheet-sub">Chats</h3>
    <div class="chat-list">
      ${chats.map((c) => {
        const last = c.messages[c.messages.length - 1];
        const preview = last ? macros(last.swipes[last.swipeIdx] || '', ctxNames()).replace(/\s+/g, ' ').slice(0, 90) : '';
        return `<div class="chat-row ${c.id === S.chat.id ? 'current' : ''}">
          <button class="chat-open" data-action="open-chat" data-id="${c.id}">
            <div class="cr-title">${esc(c.title)} <span class="muted small">· ${c.messages.length} msgs · ${timeAgo(c.updatedAt)}</span></div>
            <div class="cr-preview muted">${esc(preview)}</div>
          </button>
          <button class="icon-btn sm" data-action="rename-chat" data-id="${c.id}" aria-label="Rename">${ICONS.edit}</button>
          <button class="icon-btn sm danger" data-action="delete-chat" data-id="${c.id}" aria-label="Delete">${ICONS.trash}</button>
        </div>`;
      }).join('')}
    </div>`);
}

function viewPrompt() {
  const history = S.chat.messages;
  const { messages, stats } = buildPrompt({ char: S.char, persona: activePersona(), settings: S.settings, history });
  openSheet(`
    <div class="sheet-title">Prompt preview</div>
    <p class="muted small">≈${stats.system} tokens of character/system info, ≈${stats.history} tokens of chat history.
      ${stats.included}/${stats.total} messages fit in the ${S.settings.preset.context_size}-token context.
      ${stats.worldInfo ? `${stats.worldInfo} lorebook entr${stats.worldInfo === 1 ? 'y' : 'ies'} active.` : ''}</p>
    ${messages.map((m) => `<div class="pv"><div class="pv-role">${m.role}</div><pre>${esc(m.content)}</pre></div>`).join('')}
  `, 'tall');
}

function exportChat() {
  const persona = activePersona();
  const lines = [JSON.stringify({ user_name: persona.name, character_name: S.char.name, create_date: new Date(S.chat.createdAt).toISOString(), chat_metadata: {} })];
  for (const m of S.chat.messages) {
    const isUser = m.role === 'user';
    lines.push(JSON.stringify({
      name: isUser ? persona.name : S.char.name,
      is_user: isUser,
      is_system: false,
      send_date: new Date(m.ts || Date.now()).toISOString(),
      mes: m.swipes[m.swipeIdx] || '',
      ...(isUser ? {} : { swipes: m.swipes, swipe_id: m.swipeIdx }),
    }));
  }
  saveFile(new Blob([lines.join('\n')], { type: 'application/jsonl' }), `${safeName(S.char.name)} - ${safeName(S.chat.title)}.jsonl`);
}

async function importChat() {
  const [file] = await pickFile('file-chat');
  if (!file) return;
  try {
    const text = await file.text();
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const msgs = [];
    for (const r of rows) {
      if (r.mes === undefined || r.is_system) continue;
      const swipes = Array.isArray(r.swipes) && r.swipes.length ? r.swipes.map(String) : [String(r.mes)];
      let idx = Number.isInteger(r.swipe_id) ? r.swipe_id : swipes.indexOf(String(r.mes));
      if (idx < 0 || idx >= swipes.length) { swipes.push(String(r.mes)); idx = swipes.length - 1; }
      msgs.push({ id: db.uid(), role: r.is_user ? 'user' : 'assistant', swipes, swipeIdx: idx, ts: Date.parse(r.send_date) || Date.now() });
    }
    if (!msgs.length) throw new Error('No messages found in that file');
    const now = Date.now();
    const chat = { id: db.uid(), charId: S.char.id, title: file.name.replace(/\.jsonl?$/i, '').slice(0, 60), createdAt: now, updatedAt: now, messages: msgs };
    await saveChat(chat);
    toast(`Imported ${msgs.length} messages`);
    go(`#/chat/${S.char.id}/${chat.id}`);
  } catch (e) {
    toast('Import failed: ' + e.message, 5000);
  }
}

// ---------- CHARACTER EDITOR ----------
const EDIT_FIELDS = [
  ['name', 'Name', 'input'],
  ['description', 'Description', 'Who the character is: appearance, background, personality. Supports {{char}} and {{user}}.'],
  ['first_mes', 'First message', 'The greeting that starts every new chat.'],
  ['personality', 'Personality summary', ''],
  ['scenario', 'Scenario', 'The situation the chat starts in.'],
  ['mes_example', 'Example dialogue', 'Separate examples with <START>.'],
  ['system_prompt', 'System prompt override', 'Replaces the main prompt for this character. Use {{original}} to include the main prompt.'],
  ['post_history_instructions', 'Post-history instructions', 'Sent after the chat history (a.k.a. jailbreak / author’s note). {{original}} includes the global one.'],
  ['creator_notes', 'Creator notes', 'Not sent to the AI.'],
];

async function renderEditView(id) {
  if (!S.draft || S.draft._for !== id) {
    if (id === 'new') {
      S.draft = { _for: id, id: db.uid(), name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '', alternate_greetings: [], tags: [], creator: '', character_version: '', character_book: null, extensions: {}, avatar: null, isNew: true };
    } else {
      const c = await db.get('characters', id);
      if (!c) throw new Error('Character not found');
      S.draft = { ...structuredClone(c), _for: id };
    }
  }
  const d = S.draft;
  const book = d.character_book && d.character_book.entries;
  const bookCount = book ? (Array.isArray(book) ? book.length : Object.keys(book).length) : 0;
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="edit-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">${d.isNew ? 'New character' : 'Edit character'}</h1>
      <div class="spacer"></div>
      <button class="btn sm primary" data-action="char-save">Save</button>
    </header>
    <main class="scroll pad form">
      <div class="avatar-edit">
        <button class="avatar-pick" data-action="char-avatar" aria-label="Change avatar">${avatarHtml(d.avatar, d.name || '?', 'av xl')}<span class="small muted">Tap to change</span></button>
      </div>
      ${EDIT_FIELDS.map(([k, label, hint]) => `
        <label class="field">
          <span class="label">${label}</span>
          ${hint === 'input'
            ? `<input data-draft="${k}" value="${esc(d[k])}" autocomplete="off">`
            : `<textarea data-draft="${k}" rows="${k === 'description' || k === 'first_mes' ? 6 : 3}">${esc(d[k])}</textarea>`}
          ${hint && hint !== 'input' ? `<span class="hint">${esc(hint)}</span>` : ''}
        </label>`).join('')}
      <div class="field">
        <span class="label">Alternate greetings <span class="muted small">(swipe on the first message)</span></span>
        <div id="alt-greetings">
          ${(d.alternate_greetings || []).map((g, i) => `
            <div class="alt-row"><textarea data-alt="${i}" rows="3">${esc(g)}</textarea>
            <button class="icon-btn sm danger" data-action="alt-del" data-i="${i}" aria-label="Remove">${ICONS.trash}</button></div>`).join('')}
        </div>
        <button class="btn sm" data-action="alt-add">${ICONS.plus} Add greeting</button>
      </div>
      <label class="field"><span class="label">Tags <span class="muted small">(comma separated)</span></span>
        <input data-draft-tags value="${esc((d.tags || []).join(', '))}" autocomplete="off"></label>
      <label class="field"><span class="label">Creator</span><input data-draft="creator" value="${esc(d.creator)}" autocomplete="off"></label>
      <div class="field"><span class="label">Lorebook</span>
        <span class="hint">${bookCount ? `Embedded lorebook with ${bookCount} entr${bookCount === 1 ? 'y' : 'ies'} — activated automatically by keywords.` : 'No embedded lorebook.'}</span></div>
      ${d.isNew ? '' : `
      <div class="row wrap">
        <button class="btn" data-action="char-export-png">${ICONS.download} Export PNG card</button>
        <button class="btn" data-action="char-export-json">${ICONS.download} Export JSON</button>
        <button class="btn" data-action="char-duplicate">${ICONS.copy} Duplicate</button>
      </div>
      <button class="btn danger block" data-action="char-delete">${ICONS.trash} Delete character</button>`}
      <div class="bottom-space"></div>
    </main>`;
}

function collectDraft() {
  const d = S.draft;
  document.querySelectorAll('[data-draft]').forEach((el) => { d[el.dataset.draft] = el.value; });
  const tags = document.querySelector('[data-draft-tags]');
  if (tags) d.tags = tags.value.split(',').map((t) => t.trim()).filter(Boolean);
  const alts = [...document.querySelectorAll('[data-alt]')].map((el) => el.value);
  d.alternate_greetings = alts;
  return d;
}

async function saveDraft() {
  const d = collectDraft();
  d.name = (d.name || '').trim();
  if (!d.name) return toast('The character needs a name.');
  const { _for, isNew, ...c } = d;
  c.alternate_greetings = c.alternate_greetings.filter((g) => g.trim());
  c.updatedAt = Date.now();
  if (isNew) c.createdAt = c.updatedAt;
  await db.put('characters', c);
  S.draft = null;
  toast('Saved');
  go(`#/chat/${c.id}`);
}

// ---------- SETTINGS ----------
function settingsField(label, path, type = 'number', attrs = '', hint = '') {
  const val = getPath(path);
  if (type === 'checkbox') {
    return `<label class="toggle"><span><span class="label">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span>
      <input type="checkbox" data-bind="${path}" ${val ? 'checked' : ''}><i></i></label>`;
  }
  if (type === 'textarea') {
    return `<label class="field"><span class="label">${label}</span><textarea data-bind="${path}" rows="5">${esc(val)}</textarea>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  }
  return `<label class="field ${type === 'number' ? 'inline' : ''}"><span class="label">${label}${hint ? `<span class="hint">${hint}</span>` : ''}</span>
    <input type="${type === 'number' ? 'text' : type}" ${type === 'number' ? 'inputmode="decimal" data-num' : ''} data-bind="${path}" value="${esc(val)}" ${attrs} autocomplete="off" autocapitalize="off" spellcheck="false"></label>`;
}

function getPath(path) {
  const [head, ...rest] = path.split('.');
  let obj = head === 'conn' ? activeConn() : head === 'persona' ? activePersona() : S.settings[head];
  for (const k of rest) obj = obj == null ? undefined : obj[k];
  return obj;
}
function setPath(path, value) {
  const [head, ...rest] = path.split('.');
  let obj = head === 'conn' ? activeConn() : head === 'persona' ? activePersona() : S.settings[head];
  if (!obj) return;
  for (const k of rest.slice(0, -1)) obj = obj[k];
  obj[rest[rest.length - 1]] = value;
}

function renderSettingsView(open) {
  const conn = activeConn();
  const persona = activePersona();
  const p = S.settings.preset;
  const sec = (id, title, body) => `<details class="section" data-sec="${id}" ${open === id ? 'open' : ''}><summary>${title}</summary><div class="sec-body">${body}</div></details>`;
  const connBody = `
    <label class="field"><span class="label">Profile</span>
      <select data-change="select-conn">
        ${S.settings.connections.map((c) => `<option value="${c.id}" ${conn && c.id === conn.id ? 'selected' : ''}>${esc(c.name || PROVIDERS[c.provider].label)}</option>`).join('')}
        <option value="__new">+ New connection…</option>
      </select></label>
    ${conn ? `
      ${settingsField('Name', 'conn.name', 'text')}
      <label class="field"><span class="label">Provider</span>
        <select data-change="conn-provider">
          ${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${conn.provider === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select></label>
      ${PROVIDERS[conn.provider].needsUrl ? settingsField('Base URL', 'conn.baseUrl', 'url', 'placeholder="https://api.example.com/v1"', 'The URL that ends in /v1 (we add /chat/completions). Must be https and allow browser (CORS) requests.') : ''}
      ${settingsField('API key', 'conn.apiKey', 'password', 'placeholder="sk-…"', conn.provider === 'openrouter' ? 'Get one at openrouter.ai/keys' : conn.provider === 'anthropic' ? 'Get one at console.anthropic.com' : '')}
      <div class="field"><span class="label">Model</span>
        <div class="row"><input data-bind="conn.model" value="${esc(conn.model)}" placeholder="${conn.provider === 'anthropic' ? 'claude-opus-5-5' : conn.provider === 'openrouter' ? 'anthropic/claude-opus-5.5' : 'model id'}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn" data-action="browse-models">Browse</button></div></div>
      <div class="row wrap">
        <button class="btn primary" data-action="test-conn">Test connection</button>
        <button class="btn danger" data-action="delete-conn">Delete profile</button>
      </div>
      <p class="hint">Keys are stored only on this device and sent only to the provider you choose.</p>` : '<p class="muted">Add a connection to start chatting.</p>'}`;

  const genBody = `
    ${settingsField('Max response tokens', 'preset.max_tokens')}
    ${settingsField('Context size (tokens)', 'preset.context_size', 'number', '', 'Older messages are dropped to fit')}
    ${settingsField('Stream replies', 'preset.stream', 'checkbox')}
    ${settingsField('Temperature', 'preset.temperature')}
    ${settingsField('Top P', 'preset.top_p')}
    ${settingsField('Top K', 'preset.top_k', 'number', '', '0 = off')}
    ${settingsField('Min P', 'preset.min_p', 'number', '', '0 = off')}
    ${settingsField('Frequency penalty', 'preset.frequency_penalty')}
    ${settingsField('Presence penalty', 'preset.presence_penalty')}
    ${settingsField('Repetition penalty', 'preset.repetition_penalty', 'number', '', '1 = off')}
    <h4 class="sub">Claude (direct API)</h4>
    ${settingsField('Send temperature to Claude', 'preset.claude_sampling', 'checkbox', '', 'Only for older Claude models — current ones reject sampling settings.')}
    <label class="field inline"><span class="label">Effort<span class="hint">How hard Claude thinks before replying</span></span>
      <select data-bind="preset.claude_effort">
        ${['', 'low', 'medium', 'high', 'xhigh', 'max'].map((e) => `<option value="${e}" ${p.claude_effort === e ? 'selected' : ''}>${e || 'model default'}</option>`).join('')}
      </select></label>
    <button class="btn sm" data-action="reset-preset">Reset to defaults</button>`;

  const promptBody = `
    ${settingsField('Main prompt', 'prompt.main', 'textarea', '', 'Sent first, before the character description.')}
    <button class="btn sm" data-action="reset-main">Reset main prompt</button>
    ${settingsField('Post-history instructions', 'prompt.post_history', 'textarea', '', 'Sent after the chat history, every turn (a.k.a. jailbreak / author’s note).')}
    ${settingsField('Use character’s system prompt', 'prompt.prefer_card_system', 'checkbox', '', 'If a card has one, it replaces the main prompt.')}
    ${settingsField('Use character’s post-history instructions', 'prompt.prefer_card_post_history', 'checkbox')}
    ${settingsField('Lorebook scan depth', 'prompt.wi_scan_depth', 'number', '', 'How many recent messages are scanned for keywords')}`;

  const personaBody = `
    <label class="field"><span class="label">Active persona</span>
      <select data-change="select-persona">
        ${S.settings.personas.map((x) => `<option value="${x.id}" ${x.id === persona.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        <option value="__new">+ New persona…</option>
      </select></label>
    <div class="row"><button class="avatar-pick" data-action="persona-avatar">${avatarHtml(persona.avatar, persona.name, 'av lg')}</button>
      <div class="grow">${settingsField('Your name', 'persona.name', 'text')}</div></div>
    ${settingsField('Description', 'persona.description', 'textarea', '', 'Who you are in the story. Sent to the AI.')}
    ${S.settings.personas.length > 1 ? '<button class="btn sm danger" data-action="delete-persona">Delete persona</button>' : ''}`;

  const uiBody = `
    ${settingsField('Enter key sends', 'ui.enterSends', 'checkbox', '', 'Off: use the send button on phones')}
    ${settingsField('Font size', 'ui.fontSize')}`;

  const dataBody = `
    <div class="row wrap">
      <button class="btn" data-action="backup-export">${ICONS.download} Export backup</button>
      <button class="btn" data-action="backup-import">${ICONS.import} Restore backup</button>
    </div>
    <p class="hint" id="storage-info">Everything is stored on this device only. Export a backup now and then.</p>
    <button class="btn danger sm" data-action="wipe">Delete all data</button>`;

  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">Settings</h1>
    </header>
    <main class="scroll pad">
      ${sec('connection', 'API connection', connBody)}
      ${sec('generation', 'Generation', genBody)}
      ${sec('prompt', 'Prompts', promptBody)}
      ${sec('persona', 'Persona (you)', personaBody)}
      ${sec('ui', 'Interface', uiBody)}
      ${sec('data', 'Data & backup', dataBody)}
      <p class="muted small center">PocketTavern ${VERSION}</p>
      <div class="bottom-space"></div>
    </main>`;
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(async (est) => {
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const el = $('#storage-info');
      if (el) el.textContent = `Stored on this device only: ${(est.usage / 1048576).toFixed(1)} MB used${persisted ? ', protected from automatic cleanup' : ''}. Export a backup now and then.`;
    }).catch(() => {});
  }
}

function rerenderSettings() {
  const open = [...document.querySelectorAll('details.section[open]')].map((d) => d.dataset.sec)[0];
  const scroll = $('main.scroll')?.scrollTop || 0;
  renderSettingsView(open);
  document.querySelectorAll('details.section').forEach((d) => { if (d.dataset.sec === open) d.open = true; });
  const m = $('main.scroll');
  if (m) m.scrollTop = scroll;
}

function newConnection() {
  const c = { id: db.uid(), name: 'OpenRouter', provider: 'openrouter', baseUrl: '', apiKey: '', model: '' };
  S.settings.connections.push(c);
  S.settings.activeConnection = c.id;
  saveSettings();
}

async function browseModels() {
  const conn = activeConn();
  if (!conn) return;
  const sheet = openSheet('<div class="sheet-title">Models</div><p class="muted">Loading…</p>', 'tall');
  try {
    const models = await listModels(conn);
    models.sort((a, b) => a.id.localeCompare(b.id));
    S.models = models;
    sheet.innerHTML = `
      <div class="sheet-title">Models <span class="muted small">(${models.length})</span></div>
      <input class="search" type="search" placeholder="Search models" data-input="model-search" autocomplete="off" autocapitalize="off">
      <div class="model-list" id="model-list"></div>`;
    renderModelList('');
  } catch (e) {
    sheet.innerHTML = `<div class="sheet-title">Models</div><p class="error">${esc(e.message)}</p><p class="muted">You can still type a model id manually.</p>`;
  }
}

function renderModelList(q) {
  const list = $('#model-list');
  if (!list) return;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const items = S.models.filter((m) => terms.every((t) => (m.id + ' ' + m.name).toLowerCase().includes(t))).slice(0, 300);
  const cur = activeConn()?.model;
  list.innerHTML = items.map((m) => `
    <button class="model-item ${m.id === cur ? 'current' : ''}" data-action="pick-model" data-id="${esc(m.id)}" data-ctx="${m.ctx || ''}">
      <span class="mi-name">${esc(m.name)}</span>
      <span class="mi-meta muted small">${esc(m.id)}${m.ctx ? ` · ${Math.round(m.ctx / 1000)}k ctx` : ''}${m.price ? ` · ${esc(m.price)}` : ''}</span>
    </button>`).join('') || '<p class="muted">No matches.</p>';
}

async function testConnection() {
  const conn = activeConn();
  if (!conn) return;
  toast('Testing…', 20000);
  try {
    const text = await generate(conn, { ...S.settings.preset, max_tokens: 200, stream: false }, [
      { role: 'system', content: 'You are a connection test.' },
      { role: 'user', content: 'Reply with just the word OK.' },
    ]);
    toast(`Connected ✓ ${text ? '— model said: ' + text.trim().slice(0, 60) : ''}`, 4000);
  } catch (e) {
    toast(e.message, 8000);
  }
}

// ---------- backup ----------
async function exportBackup() {
  const withKeys = confirm('Include API keys in the backup?\n\nOK = include (for restoring on your own device)\nCancel = leave keys out (safe to share)');
  const settings = structuredClone(S.settings);
  if (!withKeys) settings.connections.forEach((c) => { c.apiKey = ''; });
  const data = {
    app: 'PocketTavern', version: 1, exportedAt: new Date().toISOString(),
    settings, characters: await db.getAll('characters'), chats: await db.getAll('chats'),
  };
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `pockettavern-backup-${stamp}.json`);
}

async function importBackup() {
  const [file] = await pickFile('file-backup');
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'PocketTavern') throw new Error('Not a PocketTavern backup');
    if (!Array.isArray(data.characters) || !Array.isArray(data.chats)) throw new Error('Invalid backup lists');
    // IDs also appear in HTML attributes. Validate before writing any records.
    function validateRecord(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (['id', 'charId', 'lastChatId', 'activeConnection', 'activePersona'].includes(key)
            && item != null && (typeof item !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item))) {
          throw new Error('Invalid identifier in backup');
        }
        if (key === 'avatar') value[key] = safeAvatar(item);
        else if (item && typeof item === 'object') validateRecord(item);
      }
    }
    validateRecord(data);
    const replaceSettings = confirm(`Backup has ${data.characters.length} characters and ${data.chats.length} chats. They will be merged into this device.\n\nAlso replace your settings (connections, prompts, personas)?`);
    for (const c of data.characters) await db.put('characters', c);
    for (const c of data.chats) await db.put('chats', c);
    if (replaceSettings && data.settings) {
      const keep = new Map(S.settings.connections.map((c) => [c.id, c.apiKey]));
      S.settings = { ...defaultSettings(), ...data.settings };
      S.settings.connections.forEach((c) => { if (!c.apiKey && keep.get(c.id)) c.apiKey = keep.get(c.id); });
      await saveSettings(true);
    }
    toast('Backup restored');
    render();
  } catch (e) {
    toast('Restore failed: ' + e.message, 5000);
  }
}

// ---------- event wiring ----------
const actions = {
  go: (el) => go(el.dataset.to),
  'go-back': () => (history.length > 1 ? history.back() : go('#/')),
  'close-sheet': closeSheet,
  'import-cards': importCards,

  send: sendMessage,
  stop: () => { if (S.abort) S.abort.abort(); },
  'toggle-msg': (el) => {
    if (S.editing) return;
    if (window.getSelection && String(window.getSelection()).length) return;
    S.openActions = S.openActions === el.dataset.id ? null : el.dataset.id;
    renderMessages();
  },
  swipe: (el) => swipe(+el.dataset.dir),
  'msg-edit': (el) => { S.editing = el.dataset.id; S.openActions = null; renderMessages(); },
  'edit-cancel': () => { S.editing = null; renderMessages(); },
  'edit-save': async (el) => {
    const msg = findMsg(el.dataset.id);
    if (msg) msg.swipes[msg.swipeIdx] = $('#edit-box').value;
    S.editing = null;
    await saveChat(S.chat);
    renderMessages();
  },
  'msg-copy': async (el) => {
    const msg = findMsg(el.dataset.id);
    try { await navigator.clipboard.writeText(macros(msg.swipes[msg.swipeIdx], ctxNames())); toast('Copied'); } catch { toast('Copy failed'); }
    S.openActions = null; renderMessages();
  },
  'msg-regen': () => { if (!S.generating) runGeneration('swipe'); },
  'msg-delete': async (el) => {
    if (S.generating) return;
    const i = S.chat.messages.findIndex((m) => m.id === el.dataset.id);
    if (i < 0) return;
    const after = S.chat.messages.length - 1 - i;
    let count = 1;
    if (after > 0) {
      if (!confirm(`Delete this message?`)) return;
      if (confirm(`Also delete the ${after} message${after > 1 ? 's' : ''} after it?`)) count += after;
    } else if (!confirm('Delete this message?')) return;
    S.chat.messages.splice(i, count);
    S.openActions = null;
    await saveChat(S.chat);
    renderMessages();
  },
  'msg-branch': async (el) => {
    const i = S.chat.messages.findIndex((m) => m.id === el.dataset.id);
    const now = Date.now();
    const chat = {
      id: db.uid(), charId: S.char.id, title: `Branch of ${S.chat.title}`.slice(0, 60), createdAt: now, updatedAt: now,
      messages: structuredClone(S.chat.messages.slice(0, i + 1)).map((m) => ({ ...m, id: db.uid() })),
    };
    await saveChat(chat);
    toast('Branched into a new chat');
    go(`#/chat/${S.char.id}/${chat.id}`);
  },
  'chat-menu': chatMenu,
  'new-chat': async () => {
    const chat = await createChat(S.char);
    await saveChat(chat);
    go(`#/chat/${S.char.id}/${chat.id}`);
  },
  'open-chat': (el) => {
    if (el.dataset.id === S.chat.id) return closeSheet();
    go(`#/chat/${S.char.id}/${el.dataset.id}`);
  },
  'rename-chat': async (el) => {
    const c = S.chats.find((x) => x.id === el.dataset.id);
    const name = prompt('Chat name', c.title);
    if (name && name.trim()) {
      c.title = name.trim().slice(0, 80);
      if (S.chat.id === c.id) S.chat.title = c.title;
      await db.put('chats', c.id === S.chat.id ? S.chat : c);
      chatMenu();
    }
  },
  'delete-chat': async (el) => {
    if (!confirm('Delete this chat permanently?')) return;
    await db.del('chats', el.dataset.id);
    S.chats = S.chats.filter((c) => c.id !== el.dataset.id);
    if (el.dataset.id === S.chat.id) { closeSheet(); go(`#/chat/${S.char.id}/${S.chats[0] ? S.chats[0].id : ''}`); render(); } else chatMenu();
  },
  'view-prompt': viewPrompt,
  'export-chat': exportChat,
  'import-chat': importChat,

  'edit-back': () => {
    const d = S.draft;
    S.draft = null;
    go(d && !d.isNew ? `#/chat/${d.id}` : '#/');
  },
  'char-save': saveDraft,
  'char-avatar': async () => {
    const [f] = await pickFile('file-avatar');
    if (!f) return;
    collectDraft();
    try { S.draft.avatar = await blobToAvatar(f); renderEditView(S.draft._for); } catch (e) { toast(e.message); }
  },
  'alt-add': () => { collectDraft(); S.draft.alternate_greetings.push(''); renderEditView(S.draft._for); },
  'alt-del': (el) => { collectDraft(); S.draft.alternate_greetings.splice(+el.dataset.i, 1); renderEditView(S.draft._for); },
  'char-export-png': async () => { const c = collectDraft(); await saveFile(await exportCardPng(c), `${safeName(c.name)}.png`); },
  'char-export-json': async () => { const c = collectDraft(); await saveFile(new Blob([JSON.stringify(toV2(c), null, 2)], { type: 'application/json' }), `${safeName(c.name)}.json`); },
  'char-duplicate': async () => {
    const { _for, isNew, ...c } = structuredClone(collectDraft());
    const now = Date.now();
    Object.assign(c, { id: db.uid(), name: `${c.name} (copy)`, createdAt: now, updatedAt: now, lastChatAt: null, lastChatId: null });
    await db.put('characters', c);
    S.draft = null;
    toast('Duplicated');
    go(`#/edit/${c.id}`);
  },
  'char-delete': async () => {
    if (!confirm(`Delete ${S.draft.name} and all their chats?`)) return;
    const chats = await db.byIndex('chats', 'charId', S.draft.id);
    for (const c of chats) await db.del('chats', c.id);
    await db.del('characters', S.draft.id);
    S.draft = null;
    go('#/');
  },

  'browse-models': browseModels,
  'pick-model': (el) => {
    const conn = activeConn();
    conn.model = el.dataset.id;
    const ctx = +el.dataset.ctx;
    if (ctx && S.settings.preset.context_size > ctx) {
      S.settings.preset.context_size = ctx;
      toast(`Context size lowered to ${ctx} to fit this model`);
    }
    saveSettings();
    closeSheet();
    rerenderSettings();
  },
  'test-conn': testConnection,
  'delete-conn': () => {
    if (!confirm('Delete this connection profile?')) return;
    S.settings.connections = S.settings.connections.filter((c) => c.id !== S.settings.activeConnection);
    S.settings.activeConnection = S.settings.connections[0]?.id || null;
    saveSettings();
    rerenderSettings();
  },
  'reset-preset': () => {
    if (!confirm('Reset generation settings to defaults?')) return;
    S.settings.preset = defaultSettings().preset;
    saveSettings();
    rerenderSettings();
  },
  'reset-main': () => { S.settings.prompt.main = DEFAULT_MAIN; saveSettings(); rerenderSettings(); },
  'persona-avatar': async () => {
    const [f] = await pickFile('file-avatar');
    if (!f) return;
    activePersona().avatar = await blobToAvatar(f, 256);
    saveSettings();
    rerenderSettings();
  },
  'delete-persona': () => {
    if (!confirm('Delete this persona?')) return;
    S.settings.personas = S.settings.personas.filter((x) => x.id !== S.settings.activePersona);
    S.settings.activePersona = S.settings.personas[0].id;
    saveSettings();
    rerenderSettings();
  },
  'backup-export': exportBackup,
  'backup-import': importBackup,
  wipe: async () => {
    if (!confirm('Delete ALL characters, chats and settings on this device?')) return;
    if (!confirm('Really? This cannot be undone.')) return;
    await db.clear('characters'); await db.clear('chats'); await db.clear('kv');
    S.settings = defaultSettings();
    await saveSettings(true);
    go('#/');
  },
};

document.addEventListener('click', (e) => {
  if (e.target.closest('textarea, input, select, summary')) return;
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    Promise.resolve(fn(el, e)).catch((err) => { console.error(err); toast(err.message || String(err), 5000); });
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.bind && el.tagName !== 'SELECT' && el.type !== 'checkbox') {
    let v = el.value;
    if ('num' in el.dataset) {
      if (v.trim() === '' || Number.isNaN(Number(v))) return;
      v = Number(v);
    }
    setPath(el.dataset.bind, v);
    saveSettings();
    if (el.dataset.bind === 'conn.name') {
      const opt = document.querySelector('select[data-change="select-conn"] option:checked');
      if (opt) opt.textContent = v || 'Connection';
    }
  } else if (el.dataset.input === 'home-search') {
    S.homeQuery = el.value;
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(async () => {
      await renderHome();
      const s = $('.search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }, 200);
  } else if (el.dataset.input === 'model-search') {
    renderModelList(el.value);
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.bind && (el.type === 'checkbox' || el.tagName === 'SELECT')) {
    setPath(el.dataset.bind, el.type === 'checkbox' ? el.checked : el.value);
    saveSettings();
    if (el.dataset.bind === 'ui.fontSize') render();
    return;
  }
  if ('num' in el.dataset && el.dataset.bind) el.value = getPath(el.dataset.bind);
  const c = el.dataset.change;
  if (c === 'select-conn') {
    if (el.value === '__new') newConnection();
    else S.settings.activeConnection = el.value;
    saveSettings();
    rerenderSettings();
  } else if (c === 'conn-provider') {
    const conn = activeConn();
    const oldLabel = PROVIDERS[conn.provider].label;
    conn.provider = el.value;
    if (!conn.name || conn.name === oldLabel || conn.name === 'OpenRouter') conn.name = PROVIDERS[el.value].label;
    conn.model = '';
    saveSettings();
    rerenderSettings();
  } else if (c === 'select-persona') {
    if (el.value === '__new') {
      const p = { id: db.uid(), name: 'New persona', description: '', avatar: null };
      S.settings.personas.push(p);
      S.settings.activePersona = p.id;
    } else S.settings.activePersona = el.value;
    saveSettings();
    rerenderSettings();
  }
});

// ---------- icons (inline SVG) ----------
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICONS = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  import: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>'),
  share: svg('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4M12 2v13"/>', 'width="16" height="16" style="vertical-align:-3px"'),
  dots: svg('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
  send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  left: svg('<path d="M15 18l-6-6 6-6"/>', 'width="18" height="18"'),
  right: svg('<path d="M9 18l6-6-6-6"/>', 'width="18" height="18"'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', 'width="18" height="18"'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 'width="18" height="18"'),
  trash: svg('<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>', 'width="18" height="18"'),
  refresh: svg('<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>', 'width="18" height="18"'),
  branch: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7"/>', 'width="18" height="18"'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
};

// ---------- boot ----------
async function boot() {
  fitViewport();
  let settings = null;
  try { settings = await db.get('kv', 'settings'); } catch (e) { console.error(e); }
  const def = defaultSettings();
  S.settings = settings ? {
    ...def, ...settings,
    preset: { ...def.preset, ...settings.preset },
    prompt: { ...def.prompt, ...settings.prompt },
    ui: { ...def.ui, ...settings.ui },
  } : def;
  if (!S.settings.personas || !S.settings.personas.length) { S.settings.personas = def.personas; S.settings.activePersona = def.activePersona; }
  if (!settings) await saveSettings(true);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

boot();
