import * as db from './db.js';
import { parseCardFile, blobToAvatar, exportCardPng, toV2, isPng, normalizeCard } from './card.js';
import { buildPrompt, macros } from './prompt.js';
import { PROVIDERS, generate, listModels } from './api.js';
import { evaluateMacros } from './macros.js';
import { normalizeBook, normalizeEntry, exportBook, POSITIONS, LOGIC } from './worldinfo.js';
import { applyRegex, parseRegexFile, normalizeScript, PLACEMENT, PLACEMENT_LABELS } from './regex.js';
import { importSTPreset, exportSTPreset, isSTPreset, MARKER_LABELS, AUTO_SLOTS } from './preset.js';
import { formatMessage, renderInto } from './render.js';

const VERSION = '1.2.0';
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
      claude_sampling: false, claude_effort: '', show_thoughts: false,
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
  presets: [],
  lorebooks: [],
  regex: [],
  groups: [],
  group: null, // active group (group chats)
  members: new Map(), // id -> character, for the active group
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
const activePreset = () => S.presets.find((p) => p.id === S.settings.activePreset) || null;

const kvTimers = {};
function saveKv(key, now = false) {
  clearTimeout(kvTimers[key]);
  const doSave = () => db.put('kv', S[key], key);
  if (now) return doSave();
  kvTimers[key] = setTimeout(doSave, 400);
}
const savePresets = (now) => saveKv('presets', now);
const saveLorebooks = (now) => saveKv('lorebooks', now);
const saveRegex = (now) => saveKv('regex', now);
const saveGroups = (now) => saveKv('groups', now);

const cardScriptCache = new WeakMap();
function scriptsFor(char) {
  const list = [...S.regex];
  const raw = char && char.extensions && char.extensions.regex_scripts;
  if (char && char.runCardRegex !== false && Array.isArray(raw) && raw.length) {
    if (!cardScriptCache.has(raw)) {
      cardScriptCache.set(raw, raw.map((x) => { try { return normalizeScript(x); } catch { return null; } }).filter(Boolean));
    }
    list.push(...cardScriptCache.get(raw));
  }
  return list;
}

const embeddedCache = new WeakMap();
function embeddedEntries(char) {
  const book = char && char.character_book;
  if (!book || !book.entries) return [];
  if (!embeddedCache.has(book)) {
    let entries = [];
    try { entries = normalizeBook(book).entries; } catch { /* ignore */ }
    embeddedCache.set(book, entries);
  }
  return embeddedCache.get(book);
}

function promptFor(chat, char, history, opts = {}) {
  const conn = activeConn();
  const inGroup = S.group && chat.groupId === S.group.id;
  const group = inGroup ? {
    names: groupMembers().map((c) => c.name).join(', '),
    nameOf: (m) => (m.role === 'user' ? (activePersona().name || 'User') : ((S.members.get(m.charId) || {}).name || m.name || char.name)),
  } : null;
  return buildPrompt({
    char, persona: activePersona(), settings: S.settings, chat, history,
    preset: activePreset(), lorebooks: S.lorebooks, regexScripts: scriptsFor(char),
    model: conn && conn.model, embeddedEntries: char._embedded || embeddedEntries(char),
    mode: opts.mode || 'normal', group,
  });
}

// ---------- group helpers ----------
const groupMembers = () => (S.group ? S.group.members.map((id) => S.members.get(id)).filter(Boolean) : []);
const activeMembers = () => groupMembers().filter((c) => !(S.group.muted || []).includes(c.id));

/** The character who wrote an assistant message (or null for user messages). */
function speakerOf(msg) {
  if (msg.role === 'user') return null;
  if (S.group) return S.members.get(msg.charId) || { id: msg.charId, name: msg.name || '?', avatar: null };
  return S.char;
}

const ownMacros = (c, field) => String(c[field] || '').replace(/\{\{char\}\}|<BOT>/gi, c.name);

/** Card used to prompt a speaker. "Join" mode merges every member's definitions, like SillyTavern. */
function cardForSpeaker(speaker) {
  if (!S.group || S.group.mode !== 'join') return speaker;
  const ms = groupMembers();
  const join = (field, fmt) => ms.filter((c) => (c[field] || '').trim()).map((c) => fmt(c, ownMacros(c, field))).join('\n\n');
  return {
    ...speaker,
    description: join('description', (c, t) => `[${c.name}]\n${t}`),
    personality: join('personality', (c, t) => `${c.name}: ${t}`),
    scenario: (S.group.scenario || '').trim() || speaker.scenario,
    mes_example: join('mes_example', (c, t) => t),
    lorebooks: [...new Set(ms.flatMap((c) => c.lorebooks || []))],
    _embedded: ms.flatMap((c) => embeddedEntries(c)),
  };
}

/** Who answers after a user message ("natural order" uses mentions + talkativeness, like ST). */
function pickSpeakers(text) {
  const ms = activeMembers();
  if (!ms.length) return [];
  const strategy = S.group.strategy || 'natural';
  if (strategy === 'manual') return [];
  if (strategy === 'list') return ms;
  const lower = String(text || '').toLowerCase();
  const out = [];
  for (const c of ms) {
    const names = [c.name, c.name.split(/\s+/)[0]].filter((n) => n && n.length > 1);
    if (names.some((n) => new RegExp(`(^|[^\\p{L}])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(lower))) out.push(c);
  }
  for (const c of ms.slice().sort(() => Math.random() - 0.5)) {
    if (out.includes(c)) continue;
    const t = Number(c.extensions && c.extensions.talkativeness);
    if (Math.random() < (Number.isFinite(t) ? t : 0.5)) out.push(c);
  }
  if (!out.length) out.push(ms[Math.floor(Math.random() * ms.length)]);
  return out;
}

async function runGroupTurn(text) {
  const speakers = pickSpeakers(text);
  if (!speakers.length) { toast('Manual mode: tap ✨ and choose who speaks.'); return; }
  S.stopGroup = false;
  for (const c of speakers) {
    if (S.stopGroup || S.chat.groupId !== S.group.id) break;
    await runGeneration('new', c.id);
  }
}

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
  if (r.name !== 'preset' && r.name !== 'lorebook') app.dataset.view = '';
  if (r.name !== 'group') S.groupDraft = null;
  try {
    if (r.name === 'chat' && r.a) await renderChatView(r.a, r.b);
    else if (r.name === 'edit' && r.a) await renderEditView(r.a);
    else if (r.name === 'preset' && r.a) renderPresetView(r.a);
    else if (r.name === 'group' && r.a) await renderGroupEditor(r.a);
    else if (r.name === 'lorebook' && r.a) renderLorebookView(r.a);
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
  const byId = new Map(chars.map((c) => [c.id, c]));
  const groups = S.groups.map((g) => ({ ...g, isGroup: true, membersList: g.members.map((id) => byId.get(id)).filter(Boolean) }));
  const list = [...chars, ...groups]
    .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.tags || []).some((t) => t.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (b.lastChatAt || b.updatedAt || 0) - (a.lastChatAt || a.updatedAt || 0));
  app.innerHTML = `
    <header class="bar">
      <h1 class="title">PocketTavern</h1>
      <div class="spacer"></div>
      <button class="icon-btn" data-action="import-files" aria-label="Import character">${ICONS.import}</button>
      <button class="icon-btn" data-action="new-menu" aria-label="New character or group">${ICONS.plus}</button>
      <button class="icon-btn" data-action="go" data-to="#/settings" aria-label="Settings">${ICONS.gear}</button>
    </header>
    <main class="scroll pad">
      ${isIOS && !isStandalone ? `<div class="banner">Install: tap <b>Share</b> ${ICONS.share} then <b>Add to Home Screen</b> for the full-screen app.</div>` : ''}
      ${!conn || !conn.model ? `<button class="banner warn" data-action="go" data-to="#/settings/connection">No API connection yet — tap to set up OpenRouter, Claude or another API.</button>` : ''}
      ${chars.length ? `<input class="search" type="search" placeholder="Search characters" value="${esc(q)}" data-input="home-search">` : ''}
      <div class="char-list">
        ${list.map((c) => `
          <button class="char-item" data-action="go" data-to="#/chat/${c.id}">
            ${c.isGroup ? groupAvatarHtml(c.membersList, 'lg') : avatarHtml(c.avatar, c.name, 'av lg')}
            <div class="ci-text">
              <div class="ci-name">${esc(c.name)}${c.isGroup ? ' <span class="badge">group</span>' : ''}</div>
              <div class="ci-desc">${esc(c.isGroup ? c.membersList.map((m) => m.name).join(', ') : macros(c.creator_notes || c.description, { char: c.name, user: activePersona().name }).replace(/\s+/g, ' ').slice(0, 140))}</div>
            </div>
            <div class="ci-time">${timeAgo(c.lastChatAt)}</div>
          </button>`).join('')}
      </div>
      ${!chars.length ? `
        <div class="empty">
          <p>No characters yet.</p>
          <p class="muted">Import SillyTavern / TavernAI cards (PNG or JSON), e.g. ones you downloaded from chub.ai, or create your own.</p>
          <div class="row center">
            <button class="btn primary" data-action="import-files">Import card</button>
            <button class="btn" data-action="go" data-to="#/edit/new">Create character</button>
          </div>
        </div>` : ''}
    </main>`;
}

const looksRegex = (j) => (Array.isArray(j) ? j.length && j.every((x) => x && typeof x.findRegex === 'string')
  : !!j && (typeof j.findRegex === 'string' || Array.isArray(j.regex_scripts)));

/** Import anything SillyTavern exports: character cards, presets, lorebooks, regex scripts. */
async function importFiles() {
  const files = await pickFile('file-cards');
  const done = { chars: 0, presets: 0, books: 0, regex: 0 };
  let lastChar = null;
  let lastPreset = null;
  let lastBook = null;
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const base = f.name.replace(/\.[^.]+$/, '');
      let card = null;
      let avatarBlob = null;
      if (isPng(buf)) {
        ({ card, avatarBlob } = await parseCardFile(f));
      } else {
        let json;
        try { json = JSON.parse(new TextDecoder().decode(buf)); } catch { throw new Error(`${f.name}: not a PNG or JSON file`); }
        if (isSTPreset(json)) {
          const p = importSTPreset(json, base, db.uid());
          S.presets.push(p);
          lastPreset = p;
          done.presets++;
          continue;
        }
        if (looksRegex(json)) {
          const list = parseRegexFile(json);
          S.regex.push(...list);
          done.regex += list.length;
          continue;
        }
        if (json.entries && !json.spec && !json.first_mes) {
          const b = normalizeBook(json, base);
          const book = { id: db.uid(), name: base || b.name, global: false, scanDepth: b.scanDepth, entries: b.entries };
          S.lorebooks.push(book);
          lastBook = book;
          done.books++;
          continue;
        }
        card = normalizeCard(json);
      }
      const now = Date.now();
      const c = { id: db.uid(), ...card, fileName: base, avatar: avatarBlob ? await blobToAvatar(avatarBlob) : null, createdAt: now, updatedAt: now };
      await db.put('characters', c);
      lastChar = c;
      done.chars++;
    } catch (e) {
      toast(e.message, 5000);
    }
  }
  if (done.presets) await savePresets(true);
  if (done.books) await saveLorebooks(true);
  if (done.regex) await saveRegex(true);
  const parts = [];
  if (done.chars) parts.push(`${done.chars} character${done.chars > 1 ? 's' : ''}`);
  if (done.presets) parts.push(`${done.presets} preset${done.presets > 1 ? 's' : ''}`);
  if (done.books) parts.push(`${done.books} lorebook${done.books > 1 ? 's' : ''}`);
  if (done.regex) parts.push(`${done.regex} regex script${done.regex > 1 ? 's' : ''}`);
  if (!parts.length) return;
  if (lastPreset && confirm(`Use preset "${lastPreset.name}" now?\n\nThis also applies its generation settings (max tokens, context size, temperature…).`)) {
    S.settings.activePreset = lastPreset.id;
    applyPresetSamplers(lastPreset);
    await saveSettings(true);
  }
  toast(`Imported ${parts.join(', ')}${lastBook ? '. Attach lorebooks to a persona or character, or make them global.' : ''}`, lastBook ? 6000 : 3000);
  if (done.chars === 1 && parts.length === 1) go(`#/chat/${lastChar.id}`);
  else render();
}

function applyPresetSamplers(p) {
  for (const [k, v] of Object.entries(p.samplers || {})) if (v !== undefined) S.settings.preset[k] = v;
  saveSettings();
}

function groupAvatarHtml(members, size = 'lg') {
  const ms = members.slice(0, 4);
  if (!ms.length) return `<div class="av ${size} av-fallback" style="--h:260">G</div>`;
  return `<div class="av ${size} group-av n${ms.length}">${ms.map((c) => avatarHtml(c.avatar, c.name, 'gav')).join('')}</div>`;
}

const GROUP_STRATEGIES = { natural: 'Natural (mentions + talkativeness)', list: 'List (everyone, in order)', manual: 'Manual (you pick who speaks)' };

async function renderGroupEditor(id) {
  const chars = (await db.getAll('characters')).sort((a, b) => a.name.localeCompare(b.name));
  let g;
  if (S.groupDraft && (S.groupDraft.id === id || (id === 'new' && S.groupDraft.isNew))) g = S.groupDraft;
  else if (id === 'new') g = { id: db.uid(), name: '', members: [], muted: [], strategy: 'natural', mode: 'swap', scenario: '', isNew: true };
  else {
    const found = S.groups.find((x) => x.id === id);
    if (!found) throw new Error('Group not found');
    g = structuredClone(found);
  }
  S.groupDraft = g;
  const inGroup = new Set(g.members);
  const ordered = [...g.members.map((mid) => chars.find((c) => c.id === mid)).filter(Boolean), ...chars.filter((c) => !inGroup.has(c.id))];
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">${g.isNew ? 'New group' : 'Edit group'}</h1>
      <div class="spacer"></div>
      <button class="btn sm primary" data-action="group-save">Save</button>
    </header>
    <main class="scroll pad form">
      <label class="field"><span class="label">Group name</span><input id="g-name" value="${esc(g.name)}" placeholder="e.g. The Grim Jackals" autocomplete="off"></label>
      <div class="field"><span class="label">Members <span class="hint">(tick to add · ↑ to reorder · mute to skip their turns)</span></span>
        ${ordered.map((c) => {
          const on = inGroup.has(c.id);
          return `<div class="list-row">
            <label class="check grow"><input type="checkbox" data-g-member="${c.id}" ${on ? 'checked' : ''}> ${avatarHtml(c.avatar, c.name, 'av sm')} ${esc(c.name)}</label>
            ${on ? `<button class="btn sm" data-action="g-up" data-id="${c.id}" aria-label="Move up">↑</button>
              <label class="check small"><input type="checkbox" data-g-mute="${c.id}" ${(g.muted || []).includes(c.id) ? 'checked' : ''}> mute</label>` : ''}
          </div>`;
        }).join('') || '<p class="muted">Import some characters first.</p>'}
      </div>
      <label class="field"><span class="label">Who replies</span><select id="g-strategy">
        ${Object.entries(GROUP_STRATEGIES).map(([k, v]) => `<option value="${k}" ${g.strategy === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select><span class="hint">Talkativeness comes from each card (default 50%). You can always make anyone speak from the ✨ menu.</span></label>
      <label class="field"><span class="label">Character cards</span><select id="g-mode">
        <option value="swap" ${g.mode !== 'join' ? 'selected' : ''}>Swap: only the speaker's card is sent</option>
        <option value="join" ${g.mode === 'join' ? 'selected' : ''}>Join: every member's card is sent</option>
      </select></label>
      <label class="field"><span class="label">Group scenario <span class="hint">(optional, overrides cards' scenarios)</span></span><textarea id="g-scenario" rows="3">${esc(g.scenario || '')}</textarea></label>
      ${g.isNew ? '' : `<button class="btn danger block" data-action="group-delete">${ICONS.trash} Delete group</button>`}
      <div class="bottom-space"></div>
    </main>`;
}

function collectGroupDraft() {
  const g = S.groupDraft;
  g.name = $('#g-name').value.trim();
  g.strategy = $('#g-strategy').value;
  g.mode = $('#g-mode').value;
  g.scenario = $('#g-scenario').value;
  const checked = new Set([...document.querySelectorAll('[data-g-member]')].filter((x) => x.checked).map((x) => x.dataset.gMember));
  g.members = [...g.members.filter((id) => checked.has(id)), ...[...checked].filter((id) => !g.members.includes(id))];
  g.muted = [...document.querySelectorAll('[data-g-mute]')].filter((x) => x.checked).map((x) => x.dataset.gMute).filter((id) => checked.has(id));
  return g;
}

// ---------- CHAT ----------
function greetingMessage(char) {
  const swipes = [char.first_mes, ...(char.alternate_greetings || [])].filter((s) => s && s.trim());
  if (!swipes.length) return [];
  return [{ id: db.uid(), role: 'assistant', swipes, swipeIdx: 0, ts: Date.now(), greeting: true }];
}

async function createChat(char) {
  const now = Date.now();
  const group = S.groups.find((g) => g.id === char.id);
  let messages;
  if (group) {
    messages = group.members.map((id) => S.members.get(id)).filter(Boolean)
      .flatMap((c) => greetingMessage(c).map((m) => ({ ...m, charId: c.id, name: c.name })));
  } else messages = greetingMessage(char);
  const chat = {
    id: db.uid(), charId: char.id, ...(group ? { groupId: group.id } : {}),
    title: new Date(now).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    createdAt: now, updatedAt: now,
    messages,
  };
  await db.put('chats', chat);
  return chat;
}

async function saveChat(chat) {
  chat.updatedAt = Date.now();
  await db.put('chats', chat);
  const g = S.groups.find((x) => x.id === chat.charId);
  if (g) {
    g.lastChatAt = chat.updatedAt;
    g.lastChatId = chat.id;
    saveGroups();
    if (S.char && S.char.id === g.id) { S.char.lastChatAt = g.lastChatAt; S.char.lastChatId = g.lastChatId; }
    return;
  }
  const c = await db.get('characters', chat.charId);
  if (c) {
    c.lastChatAt = chat.updatedAt;
    c.lastChatId = chat.id;
    await db.put('characters', c);
    if (S.char && S.char.id === c.id) { S.char.lastChatAt = c.lastChatAt; S.char.lastChatId = c.lastChatId; }
  }
}

async function loadGroup(group) {
  S.group = group;
  S.members = new Map();
  for (const id of group.members) {
    const c = await db.get('characters', id);
    if (c) S.members.set(id, c);
  }
}

async function renderChatView(charId, chatId) {
  const group = S.groups.find((g) => g.id === charId);
  let char;
  if (group) {
    await loadGroup(group);
    const ms = groupMembers();
    char = { id: group.id, name: group.name, avatar: (ms[0] || {}).avatar || null, isGroup: true, lastChatId: group.lastChatId };
  } else {
    S.group = null;
    S.members = new Map();
    char = await db.get('characters', charId);
  }
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
        ${group ? groupAvatarHtml(groupMembers(), 'sm') : avatarHtml(char.avatar, char.name, 'av sm')}
        <span class="ct-text"><span class="ct-name">${esc(char.name)}</span><span class="ct-sub">${esc(group ? groupMembers().map((c) => c.name).join(', ') : (conn ? (conn.model || 'no model') : 'no connection'))}</span></span>
      </button>
      <button class="icon-btn" data-action="chat-menu" aria-label="Chat menu">${ICONS.dots}</button>
    </header>
    <main class="scroll messages" id="msgs"></main>
    <footer class="composer">
      <button class="qa-btn" data-action="quick-actions" aria-label="More actions">${ICONS.wand}</button>
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
  const speaker = speakerOf(msg);
  const name = isUser ? persona.name : speaker.name;
  const avatar = isUser ? persona.avatar : speaker.avatar;
  const raw = msg.swipes[msg.swipeIdx] || '';
  const generatingThis = S.generating === S.chat.id && isLast && !isUser;
  const reasoning = (msg.reasoning && msg.reasoning[msg.swipeIdx]) || '';
  const editing = S.editing === msg.id;
  const n = msg.swipes.length;
  let body;
  if (editing) {
    body = `<textarea class="edit-box" id="edit-box">${esc(raw)}</textarea>
      <div class="row end"><button class="btn sm" data-action="edit-cancel">Cancel</button><button class="btn sm primary" data-action="edit-save" data-id="${msg.id}">Save</button></div>`;
  } else {
    body = raw ? `<div class="text" data-mid="${msg.id}"></div>`
      : `<div class="text">${generatingThis ? '<span class="typing"><i></i><i></i><i></i></span>' : '<span class="muted">(empty)</span>'}</div>`;
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
        ${reasoning && !editing ? reasoningHtml(reasoning, generatingThis && !raw) : ''}
        ${body}
        ${swipes}
      </div>
      ${actions}
    </div>`;
}

function reasoningHtml(text, thinking) {
  return `<details class="reasoning" ${thinking ? 'open' : ''}><summary>${thinking ? 'Thinking…' : 'Thought process'}</summary><div class="r-body">${esc(text)}</div></details>`;
}

function displayHtml(msg) {
  const msgs = S.chat.messages;
  const depth = msgs.length - 1 - msgs.indexOf(msg);
  const who = speakerOf(msg) || S.char;
  const env = { char: who.name, user: activePersona().name || 'User', vars: { ...(S.chat.vars || {}) } };
  const macro = (t) => evaluateMacros(t, env);
  let text = macro(msg.swipes[msg.swipeIdx] || '');
  text = applyRegex(text, scriptsFor(S.members.get(msg.charId) || S.char), { placement: msg.role === 'user' ? PLACEMENT.USER : PLACEMENT.AI, isMarkdown: true, depth, macro });
  return formatMessage(text);
}

function hydrateMessages(box) {
  box.querySelectorAll('.text[data-mid]').forEach((el) => {
    const msg = findMsg(el.dataset.mid);
    if (msg) renderInto(el, displayHtml(msg));
  });
}

function renderMessages(scrollBottom = false) {
  const box = $('#msgs');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const msgs = S.chat.messages;
  box.innerHTML = msgs.length
    ? msgs.map((m, i) => msgHtml(m, i === msgs.length - 1)).join('')
    : `<div class="empty muted">Say hello to ${esc(S.char.name)}.</div>`;
  hydrateMessages(box);
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
    const r = (msg.reasoning && msg.reasoning[msg.swipeIdx]) || '';
    if (r) {
      let d = box.querySelector(`.msg[data-id="${msg.id}"] details.reasoning`);
      if (!d) {
        el.insertAdjacentHTML('beforebegin', reasoningHtml(r, true));
        d = box.querySelector(`.msg[data-id="${msg.id}"] details.reasoning`);
      }
      d.querySelector('.r-body').textContent = r;
      const hasText = !!(msg.swipes[msg.swipeIdx] || '').trim();
      d.querySelector('summary').textContent = hasText ? 'Thought process' : 'Thinking…';
      if (hasText && d.dataset.autoClosed !== '1') { d.open = false; d.dataset.autoClosed = '1'; }
    }
    if ((msg.swipes[msg.swipeIdx] || '').length) renderInto(el, displayHtml(msg) + '<span class="cursor"></span>');
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
    const env = { char: S.char.name, user: activePersona().name, vars: { ...(chat.vars || {}) } };
    const finalText = applyRegex(text, scriptsFor(S.char), { placement: PLACEMENT.USER, macro: (t) => evaluateMacros(t, env) });
    chat.messages.push({ id: db.uid(), role: 'user', swipes: [finalText], swipeIdx: 0, ts: Date.now() });
    input.value = '';
    chat.draftInput = '';
    autosize(input);
    await saveChat(chat);
    renderMessages(true);
  } else if (!chat.messages.length && !S.group) {
    return;
  }
  // Empty send with no pending user message: the character(s) just carry on (like SillyTavern).
  if (S.group && chat.groupId === S.group.id) await runGroupTurn(text);
  else await runGeneration('new');
}

/**
 * mode: 'new' (append a reply), 'swipe' (add an alternative to the last reply),
 *       'regen' (replace current swipe), 'continue' (extend the last reply)
 * speakerId: which group member speaks (group chats only)
 */
async function runGeneration(mode, speakerId) {
  const conn = activeConn();
  if (!conn || !conn.model) {
    toast('Set up an API connection first (Settings → Connection).', 4000);
    return;
  }
  const chat = S.chat;
  const last = chat.messages[chat.messages.length - 1];
  let speaker = S.char;
  if (S.group && chat.groupId === S.group.id) {
    const id = speakerId || (mode !== 'new' && last && last.charId) || (activeMembers()[0] || {}).id;
    speaker = S.members.get(id);
    if (!speaker) { toast('No group member to speak.'); return; }
  }
  const char = cardForSpeaker(speaker);
  let msg;
  if (mode === 'new') {
    msg = { id: db.uid(), role: 'assistant', swipes: [''], swipeIdx: 0, ts: Date.now() };
    if (S.group && chat.groupId === S.group.id) { msg.charId = speaker.id; msg.name = speaker.name; }
    chat.messages.push(msg);
  } else {
    msg = last;
    if (!msg || msg.role !== 'assistant') return;
    if (mode === 'swipe') {
      msg.swipes.push('');
      msg.swipeIdx = msg.swipes.length - 1;
    } else if (mode === 'regen') msg.swipes[msg.swipeIdx] = '';
    msg.greeting = false;
  }
  if (!msg.reasoning) msg.reasoning = [];
  const idx = msg.swipeIdx;
  const original = mode === 'continue' ? (msg.swipes[idx] || '') : '';
  const postfix = mode === 'continue' && original && !/\s$/.test(original) ? continuePostfix() : '';
  const history = mode === 'continue' ? chat.messages.slice() : chat.messages.slice(0, chat.messages.indexOf(msg));
  const { messages, vars } = promptFor(chat, char, history, { mode: mode === 'continue' ? 'continue' : 'normal' });
  chat.vars = vars;
  const prevReasoning = msg.reasoning[idx] || '';
  S.generating = chat.id;
  S.abort = new AbortController();
  S.openActions = null;
  renderMessages(true);
  updateSendButton();
  let failed = null;
  try {
    let produced = '';
    const text = await generate(conn, S.settings.preset, messages, {
      signal: S.abort.signal,
      onToken: (t, r) => {
        produced = t;
        msg.swipes[idx] = original + postfix + (original ? t : t.replace(/^\s+/, ''));
        if (r) msg.reasoning[idx] = r;
        updateStreamingMessage(msg);
      },
    });
    let out = (text || produced || '').replace(/^\s+/, '');
    // Group replies sometimes start with "Name:" — drop it.
    if (S.group && speaker.name) out = out.replace(new RegExp(`^${speaker.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`), '');
    msg.swipes[idx] = original ? original + (out ? postfix + out : '') : out;
    if (msg.swipes[idx] && out) {
      const env = { char: char.name, user: activePersona().name, vars: { ...(chat.vars || {}) } };
      msg.swipes[idx] = applyRegex(msg.swipes[idx], scriptsFor(char), { placement: PLACEMENT.AI, macro: (t) => evaluateMacros(t, env) });
    }
  } catch (e) {
    if (e.name !== 'AbortError') failed = e;
  } finally {
    S.generating = null;
    S.abort = null;
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
  if (mode === 'continue' && !(msg.reasoning[idx] || '').trim()) msg.reasoning[idx] = prevReasoning;
  if (!msg.swipes[idx].trim()) {
    // Nothing generated: roll back the empty message / swipe.
    if (mode === 'new') chat.messages.splice(chat.messages.indexOf(msg), 1);
    else if (mode === 'swipe') {
      msg.swipes.splice(idx, 1);
      msg.reasoning.splice(idx, 1);
      msg.swipeIdx = Math.max(0, msg.swipes.length - 1);
    }
  }
  msg.ts = Date.now();
  await saveChat(chat);
  if (S.chat === chat) { renderMessages(); updateSendButton(); }
  if (failed) {
    console.error(failed);
    toast(failed.message || String(failed), 8000);
    S.stopGroup = true;
  }
}

function continuePostfix() {
  const p = activePreset();
  const v = p ? (p.continue_postfix ?? (p.raw && p.raw.continue_postfix)) : undefined;
  return typeof v === 'string' ? v : ' ';
}

/** Write the user's next message with the AI, into the input box (ST "Impersonate"). */
async function runImpersonate() {
  if (S.generating) return;
  const conn = activeConn();
  if (!conn || !conn.model) { toast('Set up an API connection first (Settings → Connection).', 4000); return; }
  const chat = S.chat;
  let speaker = S.char;
  if (S.group && chat.groupId === S.group.id) {
    const lastChar = [...chat.messages].reverse().find((m) => m.role !== 'user');
    speaker = S.members.get(lastChar && lastChar.charId) || activeMembers()[0];
    if (!speaker) return;
  }
  const { messages } = promptFor({ ...chat, vars: { ...(chat.vars || {}) } }, cardForSpeaker(speaker), chat.messages.slice(), { mode: 'impersonate' });
  const input = $('#input');
  S.generating = chat.id;
  S.abort = new AbortController();
  updateSendButton();
  input.value = '';
  input.placeholder = 'Writing as you…';
  try {
    const text = await generate(conn, S.settings.preset, messages, {
      signal: S.abort.signal,
      onToken: (t) => { if (S.chat === chat) { input.value = t.replace(/^\s+/, ''); autosize(input); } },
    });
    const name = activePersona().name;
    const out = (text || input.value || '').replace(/^\s+/, '').replace(new RegExp(`^${(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`), '');
    if (S.chat === chat) { input.value = out; chat.draftInput = out; autosize(input); }
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || String(e), 8000);
  } finally {
    S.generating = null;
    S.abort = null;
    input.placeholder = `Message ${S.char.name}`;
    updateSendButton();
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
    return runGeneration('swipe', msg.charId);
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
      ${S.group ? groupAvatarHtml(groupMembers(), 'md') : avatarHtml(S.char.avatar, S.char.name, 'av md')}
      <div><div class="sh-title">${esc(S.char.name)}</div><div class="muted small">${chats.length} chat${chats.length === 1 ? '' : 's'}</div></div>
    </div>
    <div class="menu-grid">
      <button data-action="new-chat">${ICONS.plus}<span>New chat</span></button>
      <button data-action="go" data-to="#/${S.group ? 'group' : 'edit'}/${S.char.id}">${ICONS.edit}<span>Edit ${S.group ? 'group' : 'character'}</span></button>
      <button data-action="view-prompt">${ICONS.eye}<span>View prompt</span></button>
      ${activePreset() ? `<button data-action="go" data-to="#/preset/${activePreset().id}">${ICONS.sliders}<span>Prompt toggles</span></button>` : ''}
      <button data-action="export-chat">${ICONS.download}<span>Export chat</span></button>
      ${S.group ? '' : `<button data-action="import-chat">${ICONS.import}<span>Import ST chat</span></button>`}
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

function quickActions() {
  const presets = S.presets;
  const last = S.chat.messages[S.chat.messages.length - 1];
  const note = S.chat.authorsNote;
  openSheet(`
    <div class="menu-grid">
      <button data-action="qa-continue" ${!last || last.role === 'user' ? 'disabled' : ''}>${ICONS.forward}<span>Continue</span></button>
      <button data-action="qa-impersonate">${ICONS.user}<span>Impersonate</span></button>
      <button data-action="qa-regen" ${!last || last.role === 'user' ? 'disabled' : ''}>${ICONS.refresh}<span>Regenerate</span></button>
      <button data-action="qa-note">${ICONS.note}<span>Author's Note${note && note.text && note.text.trim() ? ' •' : ''}</span></button>
      <button data-action="view-prompt">${ICONS.eye}<span>View prompt</span></button>
      ${activePreset() ? `<button data-action="go" data-to="#/preset/${activePreset().id}">${ICONS.sliders}<span>Prompt toggles</span></button>` : ''}
    </div>
    ${S.group ? `
      <h3 class="sheet-sub">Make someone speak</h3>
      <div class="speak-row">
        ${groupMembers().map((c) => `<button data-action="speak" data-id="${c.id}">${avatarHtml(c.avatar, c.name, 'av md')}<span>${esc(c.name)}</span></button>`).join('')}
      </div>` : ''}
    <label class="field"><span class="label">Preset</span>
      <select data-change="select-preset">
        <option value="">Simple (built-in)</option>
        ${presets.map((x) => `<option value="${x.id}" ${S.settings.activePreset === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></label>
  `);
}

function authorsNoteSheet() {
  const n = S.chat.authorsNote || { text: '', depth: 4, role: 'system' };
  openSheet(`
    <div class="sheet-title">Author's Note</div>
    <p class="hint">Saved with this chat and inserted into the prompt every turn, ${'at'} the depth you choose (0 = after the last message). Macros work.</p>
    <label class="field"><textarea id="an-text" rows="6" placeholder="e.g. [Style: slow burn. {{char}} is hiding a secret.]">${esc(n.text)}</textarea></label>
    <div class="row wrap">
      <label class="field" style="width:110px"><span class="label">Depth</span><input id="an-depth" inputmode="numeric" value="${n.depth ?? 4}"></label>
      <label class="field grow"><span class="label">Role</span><select id="an-role">${['system', 'user', 'assistant'].map((r) => `<option ${n.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    </div>
    <button class="btn primary block" data-action="an-save">Save</button>
  `);
}

function viewPrompt() {
  const history = S.chat.messages;
  const { messages, stats } = promptFor({ ...S.chat, vars: { ...(S.chat.vars || {}) } }, S.char, history);
  openSheet(`
    <div class="sheet-title">Prompt preview</div>
    <p class="muted small">Preset: <b>${esc(stats.preset)}</b>. ≈${stats.system} tokens of prompts/character info, ≈${stats.history} tokens of chat history.
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
      name: isUser ? persona.name : (speakerOf(m) || S.char).name,
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
  const cardRx = Array.isArray(d.extensions && d.extensions.regex_scripts) ? d.extensions.regex_scripts.length : 0;
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
      <div class="field"><span class="label">Lorebooks</span>
        ${bookCount ? `<label class="check"><input type="checkbox" data-draft-flag="embedded" ${d.disableEmbeddedBook ? '' : 'checked'}> Embedded lorebook (${bookCount} entr${bookCount === 1 ? 'y' : 'ies'})</label>` : ''}
        ${S.lorebooks.map((b) => `<label class="check"><input type="checkbox" data-draft-book="${b.id}" ${(d.lorebooks || []).includes(b.id) ? 'checked' : ''}> ${esc(b.name)}${b.global ? ' <span class="hint">(global, always on)</span>' : ''}</label>`).join('')}
        ${!bookCount && !S.lorebooks.length ? '<span class="hint">No lorebooks yet. Import one from the home screen or Settings → Lorebooks.</span>' : ''}
      </div>
      ${cardRx ? `<div class="field"><span class="label">Regex</span><label class="check"><input type="checkbox" data-draft-flag="cardRegex" ${d.runCardRegex === false ? '' : 'checked'}> Run this card's ${cardRx} regex script${cardRx === 1 ? '' : 's'}</label></div>` : ''}
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
  const books = document.querySelectorAll('[data-draft-book]');
  if (books.length) d.lorebooks = [...books].filter((el) => el.checked).map((el) => el.dataset.draftBook);
  const emb = document.querySelector('[data-draft-flag="embedded"]');
  if (emb) d.disableEmbeddedBook = !emb.checked;
  const crx = document.querySelector('[data-draft-flag="cardRegex"]');
  if (crx) d.runCardRegex = crx.checked;
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
    ${settingsField('Request & show reasoning', 'preset.show_thoughts', 'checkbox', '', "Shows the model's thinking above replies (OpenRouter reasoning models; Claude 4.6 or newer)")}
    <h4 class="sub">Claude (direct API)</h4>
    ${settingsField('Send temperature to Claude', 'preset.claude_sampling', 'checkbox', '', 'Only for older Claude models — current ones reject sampling settings.')}
    <label class="field inline"><span class="label">Reasoning effort<span class="hint">Claude direct, and OpenRouter (low–high)</span></span>
      <select data-bind="preset.claude_effort">
        ${['', 'low', 'medium', 'high', 'xhigh', 'max'].map((e) => `<option value="${e}" ${p.claude_effort === e ? 'selected' : ''}>${e || 'model default'}</option>`).join('')}
      </select></label>
    <button class="btn sm" data-action="reset-preset">Reset to defaults</button>`;

  const preset = activePreset();
  const presetBody = `
    <label class="field"><span class="label">Active preset</span>
      <select data-change="select-preset">
        <option value="">Simple (built-in)</option>
        ${S.presets.map((x) => `<option value="${x.id}" ${preset && preset.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></label>
    ${preset ? `
      <p class="hint">${preset.order.filter((o) => o.enabled).length} of ${preset.order.length} prompts enabled.</p>
      <div class="row wrap">
        <button class="btn primary" data-action="go" data-to="#/preset/${preset.id}">${ICONS.sliders} Prompts & toggles</button>
        <button class="btn" data-action="preset-apply-samplers" data-id="${preset.id}">Apply its generation settings</button>
        <button class="btn" data-action="preset-export" data-id="${preset.id}">${ICONS.download} Export</button>
        <button class="btn danger" data-action="preset-delete" data-id="${preset.id}">${ICONS.trash} Delete</button>
      </div>` : '<p class="hint">Simple uses the main and post-history prompts from the Prompts section below. Import a SillyTavern chat-completion preset to use its full prompt manager.</p>'}
    <button class="btn" data-action="import-files">${ICONS.import} Import SillyTavern preset</button>`;

  const lorebookBody = `
    ${S.lorebooks.map((b) => {
      const where = [b.global ? 'global' : '', S.settings.personas.filter((x) => (x.lorebooks || []).includes(b.id)).map((x) => 'persona: ' + x.name).join(', ')].filter(Boolean).join(' · ');
      return `<div class="list-row">
        <button class="grow lr-btn" data-action="go" data-to="#/lorebook/${b.id}">
          <span class="lr-title">${esc(b.name)}</span>
          <span class="hint">${b.entries.length} entr${b.entries.length === 1 ? 'y' : 'ies'}${where ? ' · ' + esc(where) : ''}</span>
        </button>
        <span class="hint">Global</span>
        <label class="toggle mini"><input type="checkbox" data-lb-global="${b.id}" ${b.global ? 'checked' : ''}><i></i></label>
      </div>`;
    }).join('') || '<p class="muted">No lorebooks yet.</p>'}
    <p class="hint">Global lorebooks apply to every chat. You can also attach a lorebook to a persona (Persona section) or to a character (Edit character). Cards with embedded lorebooks work automatically.</p>
    <div class="row wrap">
      <button class="btn" data-action="import-files">${ICONS.import} Import</button>
      <button class="btn" data-action="lb-new">${ICONS.plus} New lorebook</button>
    </div>`;

  const regexBody = `
    ${S.regex.map((r, i) => `<div class="list-row">
      <label class="toggle mini"><input type="checkbox" data-rx-toggle="${i}" ${r.disabled ? '' : 'checked'}><i></i></label>
      <button class="grow lr-btn" data-action="rx-edit" data-i="${i}">
        <span class="lr-title">${esc(r.scriptName)}</span>
        <span class="hint">${r.placement.map((x) => PLACEMENT_LABELS[x] || x).join(', ')}${r.markdownOnly ? ' · display only' : ''}${r.promptOnly ? ' · prompt only' : ''}</span>
      </button>
    </div>`).join('') || '<p class="muted">No regex scripts yet.</p>'}
    <p class="hint">Scripts embedded in character cards run too (toggle per character in Edit character).</p>
    <div class="row wrap">
      <button class="btn" data-action="import-files">${ICONS.import} Import</button>
      <button class="btn" data-action="rx-new">${ICONS.plus} New script</button>
    </div>`;

  const promptBody = `
    <p class="hint">The main and post-history prompts are used by the Simple preset. The two “Use character’s…” switches and the scan depth apply to every preset.</p>
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
    <div class="field"><span class="label">Lorebooks for this persona</span>
      ${S.lorebooks.map((b) => `<label class="check"><input type="checkbox" data-persona-book="${b.id}" ${(persona.lorebooks || []).includes(b.id) ? 'checked' : ''}> ${esc(b.name)}</label>`).join('') || '<span class="hint">No lorebooks imported yet.</span>'}
    </div>
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
      ${sec('preset', 'Preset (prompt manager)', presetBody)}
      ${sec('generation', 'Generation', genBody)}
      ${sec('persona', 'Persona (you)', personaBody)}
      ${sec('lorebooks', 'Lorebooks', lorebookBody)}
      ${sec('regex', 'Regex scripts', regexBody)}
      ${sec('prompt', 'Prompts (Simple preset)', promptBody)}
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

// ---------- PRESET (prompt manager) ----------
function presetById(id) {
  const p = S.presets.find((x) => x.id === id);
  if (!p) throw new Error('Preset not found');
  return p;
}

function renderPresetView(id) {
  const p = presetById(id);
  S.pmId = id;
  const byId = new Map(p.prompts.map((x) => [x.identifier, x]));
  const q = (S.pmQuery || '').toLowerCase();
  const scroll = $('main.scroll')?.scrollTop || 0;
  const wasSame = app.dataset.view === 'preset:' + id;
  app.dataset.view = 'preset:' + id;
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">${esc(p.name)}</h1>
      <div class="spacer"></div>
      <button class="icon-btn" data-action="pm-add" aria-label="Add prompt">${ICONS.plus}</button>
    </header>
    <main class="scroll pad">
      ${S.settings.activePreset !== id ? `<button class="banner warn" data-action="preset-activate" data-id="${id}">This preset isn't active. Tap to use it.</button>` : ''}
      <p class="hint">Switch prompts on and off like SillyTavern's prompt manager. Tap a name to read or edit it.</p>
      <input class="search" type="search" placeholder="Search prompts" value="${esc(S.pmQuery || '')}" data-input="pm-search">
      <div class="pm-list">
        ${p.order.map((o, i) => {
          const x = byId.get(o.identifier);
          if (!x || (q && !x.name.toLowerCase().includes(q))) return '';
          const header = /^\s*[═─━—=]{2,}/.test(x.name);
          const badges = [
            AUTO_SLOTS.has(x.identifier) ? '<span class="badge slot">auto</span>' : '',
            x.role && x.role !== 'system' ? `<span class="badge">${x.role}</span>` : '',
            x.injection_position === 1 ? `<span class="badge">@${x.injection_depth}</span>` : '',
            !AUTO_SLOTS.has(x.identifier) && x.content ? `<span class="badge muted">${Math.ceil(x.content.length / 3.5)}t</span>` : '',
          ].join('');
          return `<div class="pm-row ${o.enabled ? '' : 'off'} ${header ? 'hdr' : ''}">
            <label class="toggle mini"><input type="checkbox" data-pm-toggle="${i}" ${o.enabled ? 'checked' : ''}><i></i></label>
            <button class="pm-name" data-action="pm-edit" data-i="${i}"><span class="pm-title">${esc(x.name)}</span>${badges}</button>
          </div>`;
        }).join('')}
      </div>
      <div class="row wrap">
        <button class="btn" data-action="pm-add">${ICONS.plus} Add prompt</button>
        <button class="btn" data-action="preset-export" data-id="${id}">${ICONS.download} Export</button>
      </div>
      <div class="bottom-space"></div>
    </main>`;
  if (wasSame) $('main.scroll').scrollTop = scroll;
}

function pmEdit(i) {
  const p = presetById(S.pmId);
  const o = p.order[i];
  const x = p.prompts.find((y) => y.identifier === o.identifier);
  const auto = AUTO_SLOTS.has(x.identifier);
  openSheet(`
    <div class="sheet-title">${esc(x.name)}</div>
    ${auto ? `<p class="hint">This slot is filled automatically with the ${esc(MARKER_LABELS[x.identifier] || x.identifier)}.</p>` : `
      <label class="field"><span class="label">Name</span><input id="pm-name" value="${esc(x.name)}"></label>
      <div class="row wrap">
        <label class="field grow"><span class="label">Role</span><select id="pm-role">
          ${['system', 'user', 'assistant'].map((r) => `<option ${x.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select></label>
        <label class="field grow"><span class="label">Position</span><select id="pm-pos">
          <option value="0" ${x.injection_position !== 1 ? 'selected' : ''}>In prompt order</option>
          <option value="1" ${x.injection_position === 1 ? 'selected' : ''}>In chat @ depth</option>
        </select></label>
        <label class="field" style="width:90px"><span class="label">Depth</span><input id="pm-depth" inputmode="numeric" value="${x.injection_depth ?? 4}"></label>
      </div>
      <label class="field"><span class="label">Content</span><textarea id="pm-content" rows="14">${esc(x.content)}</textarea>
        <span class="hint">Macros like {{char}}, {{user}}, {{setvar::name::value}}, {{getvar::name}}, {{random::a::b}}, {{trim}} work.</span></label>`}
    <div class="row wrap">
      <button class="btn sm" data-action="pm-move" data-i="${i}" data-dir="-1">Move up</button>
      <button class="btn sm" data-action="pm-move" data-i="${i}" data-dir="1">Move down</button>
      ${!auto ? `<button class="btn sm danger" data-action="pm-delete" data-i="${i}">${ICONS.trash} Delete</button>` : ''}
    </div>
    ${!auto ? `<button class="btn primary block" data-action="pm-save" data-i="${i}">Save</button>` : ''}
  `, 'tall');
}

// ---------- LOREBOOK editor ----------
function bookById(id) {
  const b = S.lorebooks.find((x) => x.id === id);
  if (!b) throw new Error('Lorebook not found');
  return b;
}

function entryTitle(e) {
  return e.comment || e.keys.join(', ') || '(untitled entry)';
}

function renderLorebookView(id) {
  const b = bookById(id);
  S.lbId = id;
  const q = (S.lbQuery || '').toLowerCase();
  const scroll = $('main.scroll')?.scrollTop || 0;
  const wasSame = app.dataset.view === 'lorebook:' + id;
  app.dataset.view = 'lorebook:' + id;
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">Lorebook</h1>
      <div class="spacer"></div>
      <button class="icon-btn" data-action="le-add" aria-label="Add entry">${ICONS.plus}</button>
    </header>
    <main class="scroll pad">
      <label class="field"><span class="label">Name</span><input data-lb-name value="${esc(b.name)}" autocomplete="off"></label>
      <label class="toggle"><span><span class="label">Global</span><span class="hint">Active in every chat</span></span>
        <input type="checkbox" data-lb-global="${b.id}" ${b.global ? 'checked' : ''}><i></i></label>
      <input class="search" type="search" placeholder="Search entries" value="${esc(S.lbQuery || '')}" data-input="lb-search">
      <div class="pm-list">
        ${b.entries.map((e, i) => {
          if (q && !(entryTitle(e) + ' ' + e.keys.join(' ') + ' ' + e.content).toLowerCase().includes(q)) return '';
          const meta = [
            e.constant ? '<span class="badge slot">always</span>' : (e.keys.length ? `<span class="badge">${esc(e.keys.slice(0, 3).join(', '))}${e.keys.length > 3 ? '…' : ''}</span>` : '<span class="badge muted">no keys</span>'),
            e.group ? `<span class="badge">group: ${esc(e.group)}${e.groupOverride ? ' ★' : ''}</span>` : '',
            e.characterFilter && e.characterFilter.names.length ? `<span class="badge">${e.characterFilter.isExclude ? 'not ' : ''}${e.characterFilter.names.length} char</span>` : '',
            e.position === 4 ? `<span class="badge">@${e.depth}</span>` : '',
          ].join('');
          return `<div class="pm-row ${e.enabled ? '' : 'off'}">
            <label class="toggle mini"><input type="checkbox" data-le-toggle="${i}" ${e.enabled ? 'checked' : ''}><i></i></label>
            <button class="pm-name" data-action="le-edit" data-i="${i}"><span class="pm-title">${esc(entryTitle(e))}</span>${meta}</button>
          </div>`;
        }).join('') || '<p class="muted">No entries.</p>'}
      </div>
      <div class="row wrap">
        <button class="btn" data-action="le-add">${ICONS.plus} Add entry</button>
        <button class="btn" data-action="lb-export">${ICONS.download} Export</button>
        <button class="btn danger" data-action="lb-delete">${ICONS.trash} Delete lorebook</button>
      </div>
      <div class="bottom-space"></div>
    </main>`;
  if (wasSame) $('main.scroll').scrollTop = scroll;
}

function leEdit(i) {
  const b = bookById(S.lbId);
  const e = b.entries[i];
  const f = e.characterFilter || { isExclude: false, names: [] };
  const chk = (id, on, label, hint = '') => `<label class="toggle"><span><span class="label">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;
  openSheet(`
    <div class="sheet-title">${esc(entryTitle(e))}</div>
    <label class="field"><span class="label">Title / memo</span><input id="le-comment" value="${esc(e.comment)}"></label>
    <label class="field"><span class="label">Content</span><textarea id="le-content" rows="8">${esc(e.content)}</textarea></label>
    ${chk('le-constant', e.constant, 'Always active', 'Ignore keywords; always insert (still subject to groups & filters)')}
    <label class="field"><span class="label">Keywords <span class="hint">(comma separated, /regex/ allowed)</span></span><input id="le-keys" value="${esc(e.keys.join(', '))}" autocapitalize="off"></label>
    <label class="field"><span class="label">Secondary keywords <span class="hint">(optional)</span></span><input id="le-secondary" value="${esc(e.secondary.join(', '))}" autocapitalize="off"></label>
    <div class="row wrap">
      <label class="field grow"><span class="label">Secondary logic</span><select id="le-logic">${Object.entries(LOGIC).map(([k, v]) => `<option value="${k}" ${e.selectiveLogic === +k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field" style="width:90px"><span class="label">Order</span><input id="le-order" inputmode="numeric" value="${e.order}"></label>
    </div>
    <div class="row wrap">
      <label class="field grow"><span class="label">Position</span><select id="le-position">${Object.entries(POSITIONS).map(([k, v]) => `<option value="${k}" ${e.position === +k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field" style="width:80px"><span class="label">Depth</span><input id="le-depth" inputmode="numeric" value="${e.depth}"></label>
      <label class="field" style="width:120px"><span class="label">Role</span><select id="le-role">${['system', 'user', 'assistant'].map((r, k) => `<option value="${k}" ${e.role === k ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    </div>
    <div class="row wrap">
      <label class="field grow"><span class="label">Inclusion group</span><input id="le-group" value="${esc(e.group)}" autocapitalize="off"></label>
      <label class="field" style="width:110px"><span class="label">Probability %</span><input id="le-prob" inputmode="numeric" value="${e.probability}"></label>
    </div>
    ${chk('le-override', e.groupOverride, 'Group priority', 'Wins its inclusion group over non-priority entries')}
    <label class="field"><span class="label">Only for characters <span class="hint">(comma separated names; empty = all)</span></span><input id="le-chars" value="${esc(f.names.join(', '))}"></label>
    ${chk('le-exclude', f.isExclude, 'Exclude those characters instead')}
    ${chk('le-whole', e.matchWholeWords, 'Match whole words only')}
    ${chk('le-case', e.caseSensitive, 'Case sensitive')}
    ${chk('le-persona', e.matchPersonaDescription, 'Also scan the persona description')}
    <div class="row wrap">
      <button class="btn danger" data-action="le-delete" data-i="${i}">${ICONS.trash} Delete entry</button>
    </div>
    <button class="btn primary block" data-action="le-save" data-i="${i}">Save</button>
  `, 'tall');
}

function regexEdit(i) {
  const r = i === -1 ? normalizeScript({ scriptName: 'New script', findRegex: '', placement: [2] }) : S.regex[i];
  const chk = (id, on, label, hint = '') => `<label class="toggle"><span><span class="label">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;
  openSheet(`
    <div class="sheet-title">${i === -1 ? 'New regex script' : esc(r.scriptName)}</div>
    <label class="field"><span class="label">Name</span><input id="rx-name" value="${esc(r.scriptName)}"></label>
    <label class="field"><span class="label">Find regex</span><input id="rx-find" value="${esc(r.findRegex)}" autocapitalize="off" spellcheck="false" placeholder="/pattern/g"></label>
    <label class="field"><span class="label">Replace with <span class="hint">($1, {{match}}, macros)</span></span><textarea id="rx-replace" rows="5" spellcheck="false">${esc(r.replaceString)}</textarea></label>
    <label class="field"><span class="label">Trim out <span class="hint">(one per line)</span></span><textarea id="rx-trim" rows="2">${esc(r.trimStrings.join('\n'))}</textarea></label>
    <div class="field"><span class="label">Affects</span>
      ${Object.entries(PLACEMENT_LABELS).map(([k, v]) => `<label class="check"><input type="checkbox" data-rx-place="${k}" ${r.placement.includes(+k) ? 'checked' : ''}> ${v}</label>`).join('')}
    </div>
    ${chk('rx-md', r.markdownOnly, 'Display only', 'Changes how messages look, not the saved text')}
    ${chk('rx-prompt', r.promptOnly, 'Prompt only', 'Changes what is sent to the AI, not the saved text')}
    ${chk('rx-edit', r.runOnEdit, 'Run on edit')}
    <div class="row wrap">
      <label class="field grow"><span class="label">Min depth</span><input id="rx-min" inputmode="numeric" value="${r.minDepth ?? ''}" placeholder="any"></label>
      <label class="field grow"><span class="label">Max depth</span><input id="rx-max" inputmode="numeric" value="${r.maxDepth ?? ''}" placeholder="any"></label>
    </div>
    <div class="row wrap">
      ${i !== -1 ? `<button class="btn" data-action="rx-export" data-i="${i}">${ICONS.download} Export</button><button class="btn danger" data-action="rx-delete" data-i="${i}">${ICONS.trash} Delete</button>` : ''}
    </div>
    <button class="btn primary block" data-action="rx-save" data-i="${i}">Save</button>
  `, 'tall');
}

const numOrNull = (v) => (String(v).trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
const splitList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

// ---------- backup ----------
async function exportBackup() {
  const withKeys = confirm('Include API keys in the backup?\n\nOK = include (for restoring on your own device)\nCancel = leave keys out (safe to share)');
  const settings = structuredClone(S.settings);
  if (!withKeys) settings.connections.forEach((c) => { c.apiKey = ''; });
  const data = {
    app: 'PocketTavern', version: 1, exportedAt: new Date().toISOString(),
    settings, characters: await db.getAll('characters'), chats: await db.getAll('chats'),
    presets: S.presets, lorebooks: S.lorebooks, regex: S.regex, groups: S.groups,
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
        if (['id', 'charId', 'lastChatId', 'activeConnection', 'activePersona', 'activePreset'].includes(key)
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
    const merge = (key, list) => {
      if (!Array.isArray(list)) return;
      const ids = new Map(S[key].map((x, i) => [x.id, i]));
      for (const x of list) { if (ids.has(x.id)) S[key][ids.get(x.id)] = x; else S[key].push(x); }
    };
    merge('presets', data.presets); merge('lorebooks', data.lorebooks); merge('regex', data.regex); merge('groups', data.groups);
    await savePresets(true); await saveLorebooks(true); await saveRegex(true); await saveGroups(true);
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
  'import-files': importFiles,

  send: sendMessage,
  stop: () => { S.stopGroup = true; if (S.abort) S.abort.abort(); },
  'toggle-msg': (el, e) => {
    if (S.editing) return;
    const inner = e && e.composedPath && e.composedPath()[0];
    if (inner && inner.closest && inner.closest('summary, a, button, input, label, select, details[open] *')) return;
    if (window.getSelection && String(window.getSelection()).length) return;
    S.openActions = S.openActions === el.dataset.id ? null : el.dataset.id;
    renderMessages();
  },
  swipe: (el) => swipe(+el.dataset.dir),
  'msg-edit': (el) => { S.editing = el.dataset.id; S.openActions = null; renderMessages(); },
  'edit-cancel': () => { S.editing = null; renderMessages(); },
  'edit-save': async (el) => {
    const msg = findMsg(el.dataset.id);
    if (msg) {
      const env = { char: S.char.name, user: activePersona().name, vars: { ...(S.chat.vars || {}) } };
      const scripts = scriptsFor(S.char).filter((x) => x.runOnEdit);
      msg.swipes[msg.swipeIdx] = applyRegex($('#edit-box').value, scripts, { placement: msg.role === 'user' ? PLACEMENT.USER : PLACEMENT.AI, macro: (t) => evaluateMacros(t, env) });
    }
    S.editing = null;
    await saveChat(S.chat);
    renderMessages();
  },
  'msg-copy': async (el) => {
    const msg = findMsg(el.dataset.id);
    try { await navigator.clipboard.writeText(macros(msg.swipes[msg.swipeIdx], ctxNames())); toast('Copied'); } catch { toast('Copy failed'); }
    S.openActions = null; renderMessages();
  },
  'msg-regen': (el) => { if (!S.generating) { const m = findMsg(el.dataset.id); runGeneration('swipe', m && m.charId); } },
  'quick-actions': quickActions,
  'qa-continue': () => {
    closeSheet();
    if (S.generating) return;
    const last = S.chat.messages[S.chat.messages.length - 1];
    if (last && last.role !== 'user') runGeneration('continue', last.charId);
  },
  'qa-impersonate': () => { closeSheet(); runImpersonate(); },
  'qa-regen': () => {
    closeSheet();
    if (S.generating) return;
    const last = S.chat.messages[S.chat.messages.length - 1];
    if (last && last.role !== 'user') runGeneration('swipe', last.charId);
  },
  'qa-note': authorsNoteSheet,
  'an-save': async () => {
    S.chat.authorsNote = { text: $('#an-text').value, depth: numOrNull($('#an-depth').value) ?? 4, role: $('#an-role').value };
    await saveChat(S.chat);
    closeSheet();
    toast(S.chat.authorsNote.text.trim() ? "Author's Note saved" : "Author's Note cleared");
  },
  speak: (el) => { closeSheet(); if (!S.generating) runGeneration('new', el.dataset.id); },
  'new-menu': () => openSheet(`
    <div class="sheet-title">Create</div>
    <div class="menu-grid two">
      <button data-action="go" data-to="#/edit/new">${ICONS.user}<span>New character</span></button>
      <button data-action="go" data-to="#/group/new">${ICONS.users}<span>New group chat</span></button>
    </div>`),
  'group-save': async () => {
    const g = collectGroupDraft();
    if (!g.name) return toast('Give the group a name.');
    if (g.members.length < 2) return toast('Pick at least two members.');
    const isNew = g.isNew;
    delete g.isNew;
    g.updatedAt = Date.now();
    if (isNew) { g.createdAt = g.updatedAt; S.groups.push(g); } else S.groups = S.groups.map((x) => (x.id === g.id ? g : x));
    await saveGroups(true);
    S.groupDraft = null;
    go(`#/chat/${g.id}`);
  },
  'group-delete': async () => {
    const g = S.groupDraft;
    if (!confirm(`Delete group "${g.name}" and its chats? (The characters stay.)`)) return;
    for (const c of await db.byIndex('chats', 'charId', g.id)) await db.del('chats', c.id);
    S.groups = S.groups.filter((x) => x.id !== g.id);
    await saveGroups(true);
    S.groupDraft = null;
    go('#/');
  },
  'g-up': (el) => {
    const g = collectGroupDraft();
    const i = g.members.indexOf(el.dataset.id);
    if (i > 0) [g.members[i - 1], g.members[i]] = [g.members[i], g.members[i - 1]];
    renderGroupEditor(g.isNew ? 'new' : g.id);
  },
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
      id: db.uid(), charId: S.char.id, ...(S.chat.groupId ? { groupId: S.chat.groupId } : {}), title: `Branch of ${S.chat.title}`.slice(0, 60), createdAt: now, updatedAt: now,
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

  'preset-activate': (el) => { S.settings.activePreset = el.dataset.id; saveSettings(); toast('Preset activated'); render(); },
  'preset-apply-samplers': (el) => {
    const p = presetById(el.dataset.id);
    applyPresetSamplers(p);
    toast(`Applied: max tokens ${S.settings.preset.max_tokens}, context ${S.settings.preset.context_size}, temp ${S.settings.preset.temperature}`, 4000);
    rerenderSettings();
  },
  'preset-export': async (el) => {
    const p = presetById(el.dataset.id);
    await saveFile(new Blob([JSON.stringify(exportSTPreset(p), null, 2)], { type: 'application/json' }), `${safeName(p.name)}.json`);
  },
  'preset-delete': (el) => {
    const p = presetById(el.dataset.id);
    if (!confirm(`Delete preset "${p.name}"?`)) return;
    S.presets = S.presets.filter((x) => x.id !== p.id);
    if (S.settings.activePreset === p.id) S.settings.activePreset = null;
    savePresets(); saveSettings(); rerenderSettings();
  },
  'pm-edit': (el) => pmEdit(+el.dataset.i),
  'pm-save': (el) => {
    const p = presetById(S.pmId);
    const o = p.order[+el.dataset.i];
    const x = p.prompts.find((y) => y.identifier === o.identifier);
    x.name = $('#pm-name').value.trim() || x.name;
    x.role = $('#pm-role').value;
    x.injection_position = +$('#pm-pos').value;
    x.injection_depth = numOrNull($('#pm-depth').value) ?? 4;
    x.content = $('#pm-content').value;
    savePresets(); closeSheet(); renderPresetView(p.id);
  },
  'pm-move': (el) => {
    const p = presetById(S.pmId);
    const i = +el.dataset.i;
    const j = i + +el.dataset.dir;
    if (j < 0 || j >= p.order.length) return;
    [p.order[i], p.order[j]] = [p.order[j], p.order[i]];
    savePresets(); renderPresetView(p.id); pmEdit(j);
  },
  'pm-delete': (el) => {
    const p = presetById(S.pmId);
    const o = p.order[+el.dataset.i];
    if (!confirm('Delete this prompt?')) return;
    p.order.splice(+el.dataset.i, 1);
    p.prompts = p.prompts.filter((y) => y.identifier !== o.identifier);
    savePresets(); closeSheet(); renderPresetView(p.id);
  },
  'pm-add': () => {
    const p = presetById(S.pmId);
    const x = { identifier: db.uid(), name: 'New prompt', role: 'system', content: '', marker: false, system_prompt: false, injection_position: 0, injection_depth: 4, injection_order: 100, forbid_overrides: false };
    p.prompts.push(x);
    const hist = p.order.findIndex((o) => o.identifier === 'chatHistory');
    const at = hist >= 0 ? hist : p.order.length;
    p.order.splice(at, 0, { identifier: x.identifier, enabled: true });
    savePresets(); renderPresetView(p.id); pmEdit(at);
  },

  'lb-new': () => {
    const b = { id: db.uid(), name: 'New lorebook', global: false, entries: [] };
    S.lorebooks.push(b); saveLorebooks(); go(`#/lorebook/${b.id}`);
  },
  'lb-export': async () => {
    const b = bookById(S.lbId);
    await saveFile(new Blob([JSON.stringify(exportBook(b), null, 2)], { type: 'application/json' }), `${safeName(b.name)}.json`);
  },
  'lb-delete': () => {
    const b = bookById(S.lbId);
    if (!confirm(`Delete lorebook "${b.name}"?`)) return;
    S.lorebooks = S.lorebooks.filter((x) => x.id !== b.id);
    saveLorebooks(); go('#/settings/lorebooks');
  },
  'le-edit': (el) => leEdit(+el.dataset.i),
  'le-add': () => {
    const b = bookById(S.lbId);
    b.entries.push(normalizeEntry({ comment: '', key: [], content: '' }, b.entries.length));
    saveLorebooks(); renderLorebookView(b.id); leEdit(b.entries.length - 1);
  },
  'le-delete': (el) => {
    const b = bookById(S.lbId);
    if (!confirm('Delete this entry?')) return;
    b.entries.splice(+el.dataset.i, 1);
    saveLorebooks(); closeSheet(); renderLorebookView(b.id);
  },
  'le-save': (el) => {
    const b = bookById(S.lbId);
    const e = b.entries[+el.dataset.i];
    const names = splitList($('#le-chars').value);
    Object.assign(e, {
      comment: $('#le-comment').value.trim(),
      content: $('#le-content').value,
      constant: $('#le-constant').checked,
      keys: splitList($('#le-keys').value),
      secondary: splitList($('#le-secondary').value),
      selectiveLogic: +$('#le-logic').value,
      order: numOrNull($('#le-order').value) ?? 100,
      position: +$('#le-position').value,
      depth: numOrNull($('#le-depth').value) ?? 4,
      role: +$('#le-role').value,
      group: $('#le-group').value.trim(),
      probability: numOrNull($('#le-prob').value) ?? 100,
      groupOverride: $('#le-override').checked,
      characterFilter: names.length ? { isExclude: $('#le-exclude').checked, names, tags: [] } : null,
      matchWholeWords: $('#le-whole').checked,
      caseSensitive: $('#le-case').checked,
      matchPersonaDescription: $('#le-persona').checked,
    });
    saveLorebooks(); closeSheet(); renderLorebookView(b.id);
  },

  'rx-new': () => regexEdit(-1),
  'rx-edit': (el) => regexEdit(+el.dataset.i),
  'rx-save': (el) => {
    const i = +el.dataset.i;
    const base = i === -1 ? normalizeScript({ findRegex: '' }) : S.regex[i];
    const r = normalizeScript({
      ...base,
      scriptName: $('#rx-name').value.trim() || 'Regex',
      findRegex: $('#rx-find').value,
      replaceString: $('#rx-replace').value,
      trimStrings: $('#rx-trim').value.split('\n').filter((x) => x !== ''),
      placement: [...document.querySelectorAll('[data-rx-place]')].filter((x) => x.checked).map((x) => +x.dataset.rxPlace),
      markdownOnly: $('#rx-md').checked,
      promptOnly: $('#rx-prompt').checked,
      runOnEdit: $('#rx-edit').checked,
      minDepth: numOrNull($('#rx-min').value),
      maxDepth: numOrNull($('#rx-max').value),
    });
    if (i === -1) S.regex.push(r); else S.regex[i] = r;
    saveRegex(); closeSheet(); rerenderSettings();
  },
  'rx-delete': (el) => {
    if (!confirm('Delete this regex script?')) return;
    S.regex.splice(+el.dataset.i, 1);
    saveRegex(); closeSheet(); rerenderSettings();
  },
  'rx-export': async (el) => {
    const r = S.regex[+el.dataset.i];
    await saveFile(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }), `regex-${safeName(r.scriptName)}.json`);
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
    S.presets = []; S.lorebooks = []; S.regex = []; S.groups = [];
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
  } else if (el.dataset.input === 'pm-search' || el.dataset.input === 'lb-search') {
    const key = el.dataset.input === 'pm-search' ? 'pmQuery' : 'lbQuery';
    S[key] = el.value;
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(() => {
      if (key === 'pmQuery') renderPresetView(S.pmId); else renderLorebookView(S.lbId);
      const sEl = $('.search');
      if (sEl) { sEl.focus(); sEl.setSelectionRange(sEl.value.length, sEl.value.length); }
    }, 200);
  } else if ('lbName' in el.dataset) {
    const b = bookById(S.lbId);
    b.name = el.value;
    saveLorebooks();
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
  if (el.dataset.gMember) {
    const g = collectGroupDraft();
    renderGroupEditor(g.isNew ? 'new' : g.id);
    return;
  }
  if (el.dataset.pmToggle !== undefined) {
    const p = presetById(S.pmId);
    p.order[+el.dataset.pmToggle].enabled = el.checked;
    el.closest('.pm-row').classList.toggle('off', !el.checked);
    savePresets();
    return;
  }
  if (el.dataset.leToggle !== undefined) {
    const b = bookById(S.lbId);
    b.entries[+el.dataset.leToggle].enabled = el.checked;
    el.closest('.pm-row').classList.toggle('off', !el.checked);
    saveLorebooks();
    return;
  }
  if (el.dataset.lbGlobal) {
    bookById(el.dataset.lbGlobal).global = el.checked;
    saveLorebooks();
    return;
  }
  if (el.dataset.rxToggle !== undefined) {
    S.regex[+el.dataset.rxToggle].disabled = !el.checked;
    saveRegex();
    return;
  }
  if (el.dataset.personaBook) {
    const per = activePersona();
    const set = new Set(per.lorebooks || []);
    if (el.checked) set.add(el.dataset.personaBook); else set.delete(el.dataset.personaBook);
    per.lorebooks = [...set];
    saveSettings();
    return;
  }
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
  } else if (c === 'select-preset') {
    S.settings.activePreset = el.value || null;
    // Like SillyTavern: picking a preset also loads its generation settings.
    const picked = activePreset();
    if (picked) applyPresetSamplers(picked);
    saveSettings();
    if (route().name === 'settings') rerenderSettings();
    else { closeSheet(); toast(`Preset: ${picked ? picked.name : 'Simple'}`); }
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
  wand: svg('<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>'),
  forward: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3.2-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2.3.7 4 2.4 4 5.2"/>'),
  note: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
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
  for (const key of ['presets', 'lorebooks', 'regex', 'groups']) {
    try { S[key] = (await db.get('kv', key)) || []; } catch { S[key] = []; }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

boot();
