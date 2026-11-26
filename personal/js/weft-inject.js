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
  injectRelations: 4,     // most relationship notes per pair (the first one, in full, plus the newest ones, shortened)
  injectFacts: 6,         // most facts shown per person/place
  injectMainShare: 0.6,   // a name in at least this share of scenes counts as a main character
  injectStory: true,      // send the scenes the people in play share, in order, as the story so far
  injectStoryMax: 10000,  // most tokens the story so far may use (it grows with the chat; older scenes are shortened only past this)
  injectScenes: 3,        // most past scenes recalled at once
  injectByTopic: true,    // also recall scenes by topic (an intimate moment recalls earlier intimate scenes)
  injectSceneShare: 0.25, // names found in more than this share of scenes don't count toward recalling a scene
  injectSceneHits: 2,     // how many of a scene's names the recent messages must mention to recall it
  injectState: true,      // short "where things stand" list from the newest scene's temporary facts
  injectStateFacts: 6,    // most facts in that list
  injectTrim: true,       // drop already-summarised messages from the prompt (false = keep full history and just add the memory block)
  injectPosition: 'chat', // 'chat' | 'prompt' | 'before'
  injectDepth: 4,
  injectRole: 'system',
});

const GENERIC = new Set('avenue ave route highway interstate county township village town state canton columbus ohio park house street city county road apartment building hospital station office room bar club restaurant hotel school church store lake river north south east west old new home work car truck door phone call night morning mister miss mrs sgt dr officer detective the'.split(' '));
const STOP = new Set('new a an and are as at be but by for from had has have he her his i in is it its me my not of on or our she so that the their them then there they this to was we were what when which who will with you your just like into out about over after before been would could should really very still back down only more some other than too one two get got did does him how all any can cant dont didnt said says say going gone right now here yes yeah okay well'.split(' '));

const words = (s) => String(s || '').toLowerCase().replace(/<[^>]+>/g, ' ').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const shorten = (t, n) => { const x = clean(t); if (x.length <= n) return x; const cut = x.slice(0, n); return cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).replace(/[,;:\s]+$/, '') + '…'; };
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
  for (const r of e.relationships || []) for (const it of r.items) ids.add(`s${it.from}-${it.to}`);
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
  const cand = scenes.filter((s) => !(skipFrom != null && s.from > skipFrom));
  if (!cand.length || !max || scenes.length < 4) return []; // very few scenes: they are all near enough to be in the chat window anyway
  const { docs, df, N } = sceneDocs(scenes);
  const proper = properWords(queryText);
  const out = [];
  for (const d of docs) {
    if (!cand.includes(d.s)) continue;
    const found = [];
    for (const w of proper) {
      if (!d.nameWords.has(w) || GENERIC.has(w)) continue;
      if (df.get(w) / N > share) continue; // appears in many scenes: says nothing about which one
      found.push(w);
    }
    const single = found.some((w) => df.get(w) === 1);
    if (found.length >= hits || (single && found.length >= 1)) out.push({ scene: d.s, score: found.reduce((s2, w) => s2 + Math.log(1 + N / df.get(w)), 0), hits: found });
  }
  return out.sort((a, b2) => b2.score - a.score || b2.scene.from - a.scene.from).slice(0, max);
}


/** What a stretch of story is about. Used to recall scenes by topic when the people involved are in every scene. */
export const THEMES = {
  intimacy: [/\b(sex|sexual|sexually|kiss|kisses|kissed|kissing|bed|bedroom|naked|undress\w*|lovers?|intimate|intimacy|made love|moan\w*|arous\w*|desire|touch\w*|caress\w*|thighs?|bare|climax|condom|protection|virgin|straddl\w*|unbutton\w*|mouth|skin|hips?|waist|nails|pillows?|sheets|shirt)\b/gi, /\b(sex|sexual|sexually|lovers?|intimate|intimacy|made love|naked|undress\w*|condom|virgin|climax)\b/gi],
  injury: [/\b(ribs?|ankle|knee|concussion|stitches|fracture\w*|cracked|sprain\w*|bruis\w*|injur\w*|hospital|surgery|doctor|medic|bleed\w*|pain|tape|taped|brace|toradol|swelling|x-ray)\b/gi, /\b(concussion|fracture\w*|surgery|hospital|x-ray|stitches)\b/gi],
  danger: [/\b(attack\w*|stalk\w*|threat\w*|gun|knife|assault\w*|police|arrest\w*|restraining|protection order|harass\w*|fight\w*|punch\w*|danger\w*|scared|afraid|terrified|panic|safe|safety|lockup|deputy|sergeant|detective)\b/gi, /\b(attack\w*|stalk\w*|assault\w*|arrest\w*|restraining|protection order|gun|knife)\b/gi],
  money: [/\b(money|cash|\$\d[\d,]*|pay|paid|paying|payment|loans?|rent|bank|debt|salary|contract|envelope|onlyfans|income|afford)\b/gi, /\b(loans?|debt|salary|contract|envelope|onlyfans)\b/gi],
  family: [/\b(mother|father|parents?|sister|brother|sons?|daughters?|ex-wife|wife|husband|niece|nephew|family|divorc\w*|christmas|thanksgiving|grandm\w*|custody)\b/gi, /\b(divorc\w*|custody|ex-wife)\b/gi],
  feelings: [/\b(admit\w*|confess\w*|secret|lied|lie|lying|truth|never told|promise\w*|trust|feelings|love|loved|boyfriend|girlfriend|jealous\w*|possessive|attached|attachment|vulnerab\w*|cried|crying|apolog\w*)\b/gi, /\b(confess\w*|boyfriend|girlfriend|jealous\w*|possessive|vulnerab\w*)\b/gi],
};
const norm = (w) => w.replace(/s$/, '');
const hitsOf = (text, re) => new Set((String(text || '').toLowerCase().match(re) || []).map(norm));
const occurrences = (text, re) => (String(text || '').toLowerCase().match(re) || []).length;
// different topic words, plus the explicit ones counted every time they come up (up to 5)
const themeScore = (text, [all, strong]) => hitsOf(text, all).size + 2 * Math.min(5, occurrences(text, strong));
const sceneText = (sc) => [sc.summary, ...(sc.facts || []).map((f) => f.text), ...(sc.relationships || []).map((r) => r.text)].join(' ');

/** The one topic the recent messages are clearly about (well ahead of the others), or null. */
export function dominantTheme(queryText, { minScore = 12, lead = 2 } = {}) {
  const scored = Object.entries(THEMES).map(([t, res]) => [t, themeScore(queryText, res)]).sort((a, b) => b[1] - a[1]);
  const [top, next] = scored;
  return top && top[1] >= minScore && top[1] >= lead * (next ? Math.max(next[1], 1) : 1) ? { theme: top[0], score: top[1] } : null;
}

/**
 * Scenes about the same kind of moment as the recent messages (an intimate moment recalls the earlier intimate
 * scenes), for when names cannot tell scenes apart because the same people are in all of them. Only fires when
 * the recent messages are clearly about one topic; recalls the scenes where that topic was strongest.
 */
export function matchThemes(scenes, queryText, { max, skipFrom, sceneMin = 8, minScore, lead }) {
  if (!max) return [];
  const dom = dominantTheme(queryText, { minScore, lead });
  if (!dom) return [];
  const res = THEMES[dom.theme];
  return scenes
    .filter((sc) => !(skipFrom != null && sc.from > skipFrom))
    .map((sc) => ({ scene: sc, theme: dom.theme, score: themeScore(sceneText(sc), res) }))
    .filter((x) => x.score >= sceneMin)
    .sort((a, b) => b.score - a.score || b.scene.from - a.scene.from)
    .slice(0, max);
}

/** Budget for the story-so-far block: 3,000 plus 25 per 1,000 chat tokens, up to `injectStoryMax`. Sized so a few dozen scenes are sent whole. */
export function storyBudgetFor(chatTok, cfg = DEFAULT_INJECT) {
  const hi = Math.max(3000, Number(cfg.injectStoryMax) || DEFAULT_INJECT.injectStoryMax);
  return Math.round(Math.min(hi, Math.max(3000, 3000 + (Number(chatTok) || 0) * 0.025)));
}

/** Scene ids each entity appears in (facts or relationship notes). */
const sceneIdsOf = (e) => {
  const ids = new Set();
  for (const g of e.groups) for (const x of g.scenes) ids.add(x.id);
  for (const r of e.relationships || []) for (const it of r.items) ids.add(`s${it.from}-${it.to}`);
  return ids;
};

/**
 * The scenes in which at least two of the people in play appear together, oldest first. Whole summaries when they
 * fit the budget; otherwise the newest stay whole and older ones are shortened, then dropped (the first is kept).
 * Returns [{scene, text, short}] and the pairs they came from.
 */
export function storyScenes(entities, scenes, playIds, { budget, skipFrom }) {
  const play = entities.filter((e) => playIds.has(e.id) && e.id !== 'unassigned').map((e) => ({ e, ids: sceneIdsOf(e) }));
  const pairs = [], keep = new Set();
  for (let i = 0; i < play.length; i++) for (let j = i + 1; j < play.length; j++) {
    const shared = scenes.filter((sc) => play[i].ids.has(sc.id) && play[j].ids.has(sc.id) && !(skipFrom != null && sc.from > skipFrom));
    if (!shared.length) continue;
    pairs.push({ a: play[i].e, b: play[j].e, count: shared.length });
    for (const sc of shared) keep.add(sc.id);
  }
  const chosen = scenes.filter((sc) => keep.has(sc.id));
  if (!chosen.length) return { items: [], pairs: [], complete: false };
  const full = (sc) => `(messages ${sc.from}-${sc.to}) ${clean(sc.summary)}`;
  const brief = (sc) => `(messages ${sc.from}-${sc.to}) ${shorten(sc.summary, 320)}`;
  const cost = (arr) => arr.reduce((t, x) => t + tok(x.text) + 1, 0);
  let items = chosen.map((sc) => ({ scene: sc, text: full(sc), short: false }));
  if (cost(items) > budget) {
    let k = items.length;
    const build = (n) => chosen.map((sc, i) => (i >= chosen.length - n ? { scene: sc, text: full(sc), short: false } : { scene: sc, text: brief(sc), short: true }));
    while (k > 0 && cost(build(k)) > budget) k--;
    items = build(k);
    for (let i = 1; cost(items) > budget && items.length > 2; ) items.splice(i, 1); // drop from the oldest after the first
  }
  return { items, pairs, complete: items.length === chosen.length && items.every((x) => !x.short) };
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

  // 2a. where things stand: temporary facts first recorded in the newest scene or the one before (injuries, locations, plans)
  const stateBlocks = [];
  if (c.injectState !== false && Number(c.injectStateFacts) !== 0) {
    const recentIds = new Set(ok.slice(-2).map((x) => x.id));
    const rows = [];
    for (const e of entities) {
      for (const g of e.groups) {
        if (!isLive(g) || g.pin === 'yes' || g.durability !== 'temporary') continue;
        const last = g.scenes[g.scenes.length - 1];
        if (recentIds.has(last.id)) rows.push({ e, g, at: last.from });
      }
    }
    rows.sort((a, b) => b.at - a.at);
    for (const r of rows.slice(0, Math.max(1, Number(c.injectStateFacts) || 6))) {
      const line = `- ${r.e.name}: ${clean(r.g.text)}`;
      stateBlocks.push({ key: r.g.key, label: r.e.name, line, tokens: tok(line) });
    }
  }
  const stateKeys = new Set(stateBlocks.map((b) => b.key));

  // 2. people/places named in the last few messages (main characters only when something specific matches)
  const total = ok.length;
  const entryBlocks = [];
  const pinned = new Set(pins.map((p) => p.key));
  const queryWords = new Set(words(query));
  for (const { entity: e, at } of mentioned(entities, recent)) {
    const facts = e.groups.filter((g) => isLive(g) && !pinned.has(g.key) && !stateKeys.has(g.key));
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

  // 2b-0. who is in play: named in the last messages, or a main character
  const namedIds = new Set(mentioned(entities, recent).map((m) => m.entity.id));
  const play = new Set(entities.filter((e) => e.id !== 'unassigned' && (namedIds.has(e.id) || (total >= 5 && sceneShare(e, total) >= (Number(c.injectMainShare) || 0.6)))).map((e) => e.id));
  // 2b-1. the story so far: every scene the people in play share, in order (this is what keeps shared history right)
  const story = c.injectStory === false ? { items: [], pairs: [], complete: false } : storyScenes(entities, ok, play, { budget: storyBudgetFor(chatTokens(messages), c), skipFrom: verbatimFrom });
  const storyIds = new Set(story.items.filter((x) => !x.short).map((x) => x.scene.id));
  // 2b. how the people in play stand with each other, in order. Always sent for two main characters,
  // otherwise only when both are named. This is what keeps "have they slept together", "who knows what" etc. alive.
  const relBlocks = [];
  const maxRel = Number.isFinite(Number(c.injectRelations)) ? Number(c.injectRelations) : 4;
  if (maxRel > 0) {
    const done = new Set();
    for (const e of entities) {
      if (!play.has(e.id)) continue;
      for (const r of e.relationships) {
        const other = entities.find((x) => x.name === r.with);
        if (!other || !play.has(other.id) || other.id === e.id) continue;
        const pair = [e.id, other.id].sort().join('|');
        if (done.has(pair) || (story.complete && story.pairs.some((p) => [p.a.id, p.b.id].sort().join('|') === pair))) continue; // the full scenes already say it
        done.add(pair);
        const items = r.items.length <= maxRel ? r.items : [r.items[0], ...r.items.slice(-(maxRel - 1))];
        const lines2 = items.map((it, i) => `- (messages ${it.from}-${it.to}) ${i === 0 ? clean(it.text) : shorten(it.text, 170)}`);
        relBlocks.push({ label: `${e.name} & ${other.name}`, head: `${e.name} and ${other.name}, in order:`, lines: lines2, tokens: tok(lines2.join('\n')) + 12, items });
      }
    }
  }

  // 3. past scenes that match what is happening now (not ones still visible word-for-word)
  const hits = matchScenes(ok, query, { max: Math.max(0, Number(c.injectScenes) || 0), skipFrom: verbatimFrom, share: Number(c.injectSceneShare) || 0.25, hits: Math.max(1, Number(c.injectSceneHits) || 2) });
  const maxScenes = Math.max(0, Number(c.injectScenes) || 0);
  const byTopic = c.injectByTopic === false ? [] : matchThemes(ok, query, { max: maxScenes, skipFrom: verbatimFrom });
  const THEME_WORDS = { intimacy: 'intimate moments', injury: 'injuries', danger: 'danger and threats', money: 'money', family: 'family', feelings: 'feelings and confessions' };
  const picked = new Map();
  for (const t of byTopic) picked.set(t.scene.id, { scene: t.scene, score: 100 + t.score, why: `the recent messages are about ${THEME_WORDS[t.theme] || t.theme}, and so was this scene` });
  for (const h of hits) if (!picked.has(h.scene.id)) picked.set(h.scene.id, { scene: h.scene, score: h.score, why: `names ${h.hits.slice(0, 4).map((x) => '“' + x + '”').join(', ')} came up again` });
  for (const id of storyIds) picked.delete(id);
  const sceneBlocks = [...picked.values()].sort((a, b) => b.score - a.score).slice(0, maxScenes).map((h) => {
    const line = `(messages ${h.scene.from}-${h.scene.to}) ${clean(h.scene.summary)}`;
    return { kind: 'scene', label: `Scene ${h.scene.from}-${h.scene.to}`, reason: h.why, line, tokens: tok(line), score: h.score };
  });

  // 4. fit the budget: scenes go first (weakest first), then entries (least recently named first). Pins stay.
  let spend = [...stateBlocks, ...relBlocks, ...entryBlocks, ...sceneBlocks].reduce((s, b) => s + b.tokens, 0);
  const drop = (arr, label) => { const b = arr.pop(); spend -= b.tokens; skipped.push({ label: b.label, reason: label }); };
  while (spend > budget && sceneBlocks.length) drop(sceneBlocks, 'over budget');
  while (spend > budget && entryBlocks.length > 1) drop(entryBlocks, 'over budget');
  if (spend > budget && entryBlocks.length === 1) { spend -= entryBlocks.pop().tokens; skipped.push({ label: 'entries', reason: 'over budget' }); }
  while (spend > budget && relBlocks.length) drop(relBlocks, 'over budget');
  while (spend > budget && stateBlocks.length > 2) drop(stateBlocks, 'over budget');

  let storyTok = 0;
  if (story.items.length) {
    lines.push(`The story so far, in order (the scenes ${story.pairs.length === 1 ? `${story.pairs[0].a.name} and ${story.pairs[0].b.name} share` : 'the people in play share'}):`);
    for (const x of story.items) { lines.push(`- ${x.text}`); storyTok += tok(x.text) + 1; }
    items.push({ kind: 'story', label: `Story so far (${story.items.length} scene${story.items.length === 1 ? '' : 's'})`, reason: `scenes the people in play share, in order${story.items.some((x) => x.short) ? '; older ones shortened to fit' : ''}`, tokens: storyTok });
  }
  if (stateBlocks.length) {
    lines.push(`Where things stood at the end of the last recorded scene (messages ${ok[ok.length - 1].from}-${covered}):`);
    for (const b of stateBlocks) lines.push(b.line);
    items.push({ kind: 'state', label: `${stateBlocks.length} recent status note${stateBlocks.length === 1 ? '' : 's'}`, reason: 'temporary facts from the newest scenes', tokens: stateBlocks.reduce((t, b) => t + b.tokens, 0) });
  }
  if (relBlocks.length) {
    lines.push('How people stand with each other (what has happened between them so far):');
    for (const b of relBlocks) { lines.push(b.head, ...b.lines); items.push({ kind: 'relation', label: b.label, reason: `${b.items.length} relationship note${b.items.length === 1 ? '' : 's'}, both in play`, tokens: b.tokens }); }
  }
  if (entryBlocks.length) { lines.push('Who and what is in play:'); for (const b of entryBlocks) { lines.push(b.line); items.push({ kind: 'entry', label: b.label, reason: b.reason, tokens: b.tokens }); } }
  if (sceneBlocks.length) { lines.push('Earlier scenes that connect to this moment:'); for (const b of sceneBlocks) { lines.push(`- ${b.line}`); items.push({ kind: 'scene', label: b.label, reason: b.reason, tokens: b.tokens }); } }

  if (!lines.length) return { text: '', covered, verbatimFrom, tokens: 0, pins: 0, budget, items: [], skipped };
  const text = [WRAP_OPEN, ...lines, WRAP_CLOSE].join('\n');
  return { text, covered, verbatimFrom, tokens: tok(text), pins: pinTok, budget, items, skipped };
}
