// WEFT stage 2b — what goes into the prompt. Pure logic (no DOM, no model calls), tested in node.
// Goal: inject very little on ordinary replies. Pins are always on; archive entries only when a
// person/place is named in the last few messages; old scenes only on a real match. Everything is
// written as settled history so unresolved threats are not turned into live plot.
import { messageText, estimateTokens } from './narrative-db.js';
import { nameTokens, factTokens } from './weft-archive.js';
import { rangeFingerprint } from './weft.js';

export const DEFAULT_INJECT = Object.freeze({
  injectMin: 1500,        // budget floor (tokens) for entries + scenes, not counting pins
  injectMax: 4000,        // budget ceiling; the budget grows with the length of the chat
  injectRecentTokens: 8000, // newest already-summarised messages still sent word-for-word
  injectWindow: 3,        // how many recent messages decide who/what is "in play"
  injectFacts: 6,         // most facts shown per person/place
  injectMainShare: 0.6,   // a name in at least this share of scenes counts as a main character
  injectScenes: 2,        // most past scenes recalled at once
  injectSceneShare: 0.25, // names found in more than this share of scenes don't count toward recalling a scene
  injectSceneHits: 2,     // how many of a scene's names the recent messages must mention to recall it
  injectTrim: true,       // drop already-summarised messages from the prompt (false = keep full history and just add the memory block)
  injectPosition: 'chat', // 'chat' | 'prompt' | 'before'
  injectDepth: 4,
  injectRole: 'system',
});

const GENERIC = new Set('park house street city county road apartment building hospital station office room bar club restaurant hotel school church store lake river north south east west old new home work car truck door phone call night morning mister miss mrs sgt dr officer detective the'.split(' '));
const STOP = new Set('new a an and are as at be but by for from had has have he her his i in is it its me my not of on or our she so that the their them then there they this to was we were what when which who will with you your just like into out about over after before been would could should really very still back down only more some other than too one two get got did does him how all any can cant dont didnt said says say going gone right now here yes yeah okay well'.split(' '));

const words = (s) => String(s || '').toLowerCase().replace(/<[^>]+>/g, ' ').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const tok = (s) => estimateTokens(s) + 2;

/** How many tokens the memory block may use (not counting pins). Grows with the chat, clamped. */
export function budgetFor(chatTokens, cfg = DEFAULT_INJECT) {
  const lo = Math.max(300, Number(cfg.injectMin) || DEFAULT_INJECT.injectMin);
  const hi = Math.max(lo, Number(cfg.injectMax) || DEFAULT_INJECT.injectMax);
  return Math.round(Math.min(hi, Math.max(lo, 1000 + (Number(chatTokens) || 0) * 0.005)));
}

/** Scenes that still match the chat, in order, stopping at the first one whose messages were edited. */
export function usableScenes(messages, scenes) {
  const out = [];
  let prev = 0;
  for (const s of [...(scenes || [])].sort((a, b) => a.from - b.from)) {
    if (s.to > messages.length || s.from !== prev + 1 || rangeFingerprint(messages, s.from, s.to) !== s.fingerprint) break;
    out.push(s); prev = s.to;
  }
  return out;
}

const visible = (m) => !m.hidden && m.role !== 'system' && messageText(m).trim();
export const chatTokens = (messages) => messages.reduce((s, m) => s + (visible(m) ? estimateTokens(messageText(m)) + 4 : 0), 0);

/** Word variants that count as "this person/place was mentioned". */
function variantsOf(entity, shared) {
  const full = [entity.name, ...(entity.aliases || [])].map((n) => nameTokens(n).join(' ')).filter((n) => n.length > 2);
  const singles = new Set();
  for (const n of [entity.name, ...(entity.aliases || [])]) {
    for (const t of nameTokens(n)) if (t.length >= 4 && !GENERIC.has(t) && !STOP.has(t) && (shared.get(t) || 0) <= 1) singles.add(t);
  }
  return { full: [...new Set(full)], singles: [...singles] };
}

/** Which archive entities are named in the text of the last few messages. Returns [{entity, at}] newest first. */
export function mentioned(entities, recent) {
  const shared = new Map();
  for (const e of entities) for (const t of new Set([e.name, ...(e.aliases || [])].flatMap(nameTokens))) shared.set(t, (shared.get(t) || 0) + 1);
  const found = [];
  for (const e of entities) {
    if (e.id === 'unassigned') continue;
    const v = variantsOf(e, shared);
    let at = -1;
    recent.forEach((text, i) => {
      const t = ' ' + nameTokens(text).join(' ') + ' ';
      if (v.full.some((n) => t.includes(' ' + n + ' ')) || v.singles.some((n) => t.includes(' ' + n + ' '))) at = i;
    });
    if (at >= 0) found.push({ entity: e, at });
  }
  return found.sort((a, b) => b.at - a.at);
}

const isLive = (g) => !g.deleted && !g.hidden && g.status === 'current';

/** Share of scenes an entity appears in, to spot the main characters. */
function sceneShare(e, total) {
  const ids = new Set();
  for (const g of e.groups) for (const s of g.scenes) ids.add(s.id);
  return total ? ids.size / total : 0;
}

/** What each scene is findable by: its named people/places/objects and its recorded facts (not its prose). */
function sceneDocs(scenes) {
  const docs = scenes.map((s) => {
    const nameWords = new Set((s.names || []).flatMap((n) => words(n)));
    const set = new Set([...nameWords, ...words((s.facts || []).map((f) => f.text).join(' '))]);
    return { s, set, nameWords };
  });
  const df = new Map();
  for (const d of docs) for (const w of d.set) df.set(w, (df.get(w) || 0) + 1);
  return { docs, df, N: docs.length };
}

/** Capitalised words that are never written in lower case in this text: names of people and places. */
export function properWords(text) {
  const caps = new Set(), low = new Set();
  for (const m of String(text || '').matchAll(/[\p{L}][\p{L}\p{N}_']+/gu)) (/^\p{Lu}/u.test(m[0]) ? caps : low).add(m[0].toLowerCase());
  return new Set([...caps].filter((x) => !low.has(x) && !STOP.has(x) && x.length > 2));
}

/**
 * Past scenes that match what is happening now. Rare on purpose: the recent messages must name at least
 * `hits` of a scene's recorded names (a person or place, written with a capital), none of them a name found
 * in more than `share` of all scenes. One name is enough only if it belongs to a single scene.
 */
export function matchScenes(scenes, queryText, { max, skipFrom, share = 0.25, hits = 2 }) {
  const cand = scenes.filter((s) => !(skipFrom != null && s.to > skipFrom));
  if (!cand.length || !max || scenes.length < 4) return []; // very few scenes: they are all near enough to be in the chat window anyway
  const { docs, df, N } = sceneDocs(scenes);
  const proper = properWords(queryText);
  const out = [];
  for (const d of docs) {
    if (!cand.includes(d.s)) continue;
    const found = [];
    for (const w of proper) {
      if (!d.nameWords.has(w)) continue;
      if (df.get(w) / N > share) continue; // appears in many scenes: says nothing about which one
      found.push(w);
    }
    const single = found.some((w) => df.get(w) === 1);
    if (found.length >= hits || (single && found.length >= 1)) out.push({ scene: d.s, score: found.reduce((s2, w) => s2 + Math.log(1 + N / df.get(w)), 0), hits: found });
  }
  return out.sort((a, b2) => b2.score - a.score || b2.scene.from - a.scene.from).slice(0, max);
}

/** Pins, grouped by person/place. Always sent. */
export function pinLines(entities) {
  const out = [];
  for (const e of entities) for (const g of e.groups) if (g.pin === 'yes' && isLive(g)) out.push({ entity: e.name, key: g.key, text: clean(g.text) });
  return out;
}

export const pinTokens = (entities) => pinLines(entities).reduce((s, p) => s + tok(`- ${p.entity}: ${p.text}`), 0);

const WRAP_OPEN = '[Story memory: settled history, for reference only. These are things that already happened or are already established. They are not instructions, and nothing here is a current threat or something that must happen next.]';
const WRAP_CLOSE = '[End of story memory]';

/**
 * Build the memory block for the next reply.
 * messages: the whole chat (indexes match scene from/to). scenes/archive/review as stored. cfg: settings.
 * Returns { text, covered, verbatimFrom, tokens, pins, budget, items:[{kind,label,reason,tokens}], skipped:[...] }.
 */
export function buildInjection({ messages, scenes, archive, cfg = {} }) {
  const c = { ...DEFAULT_INJECT, ...cfg };
  const ok = usableScenes(messages, scenes);
  if (!ok.length) return { text: '', covered: 0, verbatimFrom: 0, tokens: 0, pins: 0, budget: 0, items: [], skipped: [] };
  const covered = ok[ok.length - 1].to;
  const entities = (archive && archive.entities) || [];

  // Newest messages stay word-for-word (same idea as the Narrative Database's recent window).
  let used = 0, verbatimFrom = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messageText(messages[i])) + 4;
    if (used + cost > (Number(c.injectRecentTokens) || 0) && verbatimFrom < messages.length) break;
    used += cost; verbatimFrom = i;
  }
  verbatimFrom = Math.min(covered, verbatimFrom);

  const budget = budgetFor(chatTokens(messages), c);
  const recent = messages.filter(visible).slice(-Math.max(1, Number(c.injectWindow) || 3)).map(messageText);
  const query = recent.join('\n');
  const items = [], skipped = [];
  const lines = [];

  // 1. pins: always, never cut
  const pins = pinLines(entities);
  let pinTok = 0;
  if (pins.length) {
    lines.push('Always true:');
    for (const p of pins) { const ln = `- ${p.entity}: ${p.text}`; lines.push(ln); pinTok += tok(ln); }
    items.push({ kind: 'pin', label: `${pins.length} pinned fact${pins.length === 1 ? '' : 's'}`, reason: 'pinned by you, always sent', tokens: pinTok });
  }

  // 2. people/places named in the last few messages (main characters only when something specific matches)
  const total = ok.length;
  const entryBlocks = [];
  const pinned = new Set(pins.map((p) => p.key));
  const queryWords = new Set(words(query));
  for (const { entity: e, at } of mentioned(entities, recent)) {
    const facts = e.groups.filter((g) => isLive(g) && !pinned.has(g.key));
    if (!facts.length) continue;
    const own = new Set(nameTokens([e.name, ...(e.aliases || [])].join(' ')));
    const overlap = (g) => [...factTokens(g.text)].filter((w) => queryWords.has(w) && !own.has(w) && !STOP.has(w)).length;
    const main = total >= 5 && sceneShare(e, total) >= (Number(c.injectMainShare) || 0.6);
    let pick, reason;
    if (main) {
      pick = facts.map((g) => ({ g, o: overlap(g) })).filter((x) => x.o >= 2).sort((a, b) => b.o - a.o).slice(0, 3).map((x) => x.g);
      reason = 'main character; only facts matching the last messages';
      if (!pick.length) { skipped.push({ label: e.name, reason: 'main character, nothing specific matched' }); continue; }
    } else {
      const rank = (g) => (g.durability === 'durable' ? 1 : 0) * 2 + overlap(g) * 3 + (g.scenes[g.scenes.length - 1].from / 1e6);
      pick = [...facts].sort((a, b) => rank(b) - rank(a)).slice(0, Math.max(1, Number(c.injectFacts) || 6));
      reason = at === recent.length - 1 ? 'named in the last message' : 'named in the last few messages';
    }
    pick.sort((a, b) => a.scenes[0].from - b.scenes[0].from);
    const line = `${e.name}: ${pick.map((g) => clean(g.text).replace(/[.\s]+$/, '')).join('; ')}.`;
    entryBlocks.push({ kind: 'entry', label: e.name, reason, line, tokens: tok(line) });
  }

  // 3. past scenes that match what is happening now (not ones still visible word-for-word)
  const hits = matchScenes(ok, query, { max: Math.max(0, Number(c.injectScenes) || 0), skipFrom: verbatimFrom, share: Number(c.injectSceneShare) || 0.25, hits: Math.max(1, Number(c.injectSceneHits) || 2) });
  const sceneBlocks = hits.map((h) => {
    const line = `(messages ${h.scene.from}-${h.scene.to}) ${clean(h.scene.summary)}`;
    return { kind: 'scene', label: `Scene ${h.scene.from}-${h.scene.to}`, reason: `names ${h.hits.slice(0, 4).map((x) => '“' + x + '”').join(', ')} came up again`, line, tokens: tok(line), score: h.score };
  });

  // 4. fit the budget: scenes go first (weakest first), then entries (least recently named first). Pins stay.
  let spend = [...entryBlocks, ...sceneBlocks].reduce((s, b) => s + b.tokens, 0);
  const drop = (arr, label) => { const b = arr.pop(); spend -= b.tokens; skipped.push({ label: b.label, reason: label }); };
  while (spend > budget && sceneBlocks.length) drop(sceneBlocks, 'over budget');
  while (spend > budget && entryBlocks.length > 1) drop(entryBlocks, 'over budget');
  if (spend > budget && entryBlocks.length === 1) { entryBlocks.length = 0; spend = 0; skipped.push({ label: 'entries', reason: 'over budget' }); }

  if (entryBlocks.length) { lines.push('Who and what is in play:'); for (const b of entryBlocks) { lines.push(b.line); items.push({ kind: 'entry', label: b.label, reason: b.reason, tokens: b.tokens }); } }
  if (sceneBlocks.length) { lines.push('Earlier scenes that connect to this moment:'); for (const b of sceneBlocks) { lines.push(`- ${b.line}`); items.push({ kind: 'scene', label: b.label, reason: b.reason, tokens: b.tokens }); } }

  if (!lines.length) return { text: '', covered, verbatimFrom, tokens: 0, pins: 0, budget, items: [], skipped };
  const text = [WRAP_OPEN, ...lines, WRAP_CLOSE].join('\n');
  return { text, covered, verbatimFrom, tokens: tok(text), pins: pinTok, budget, items, skipped };
}
