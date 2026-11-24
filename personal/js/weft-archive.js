// WEFT stage 2a — the archive: one entry per person / place / thing, assembled from the facts in the scene
// records (never rewritten by a model), plus a review state the user controls. Pure logic, no prompt effects yet.
import { stripInvisible } from './weft.js';

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'his', 'her', 'their', 'with', 'for', 'from', 'by', 'as', 'that', 'this', 'it', 'he', 'she', 'they', 'be', 'been']);

const fnv = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

// "Jordan "J.D." Daniels" -> {jordan, jd, daniels}. Parentheses are ignored: they hold roles or handles, "Marcus (Titans security)" -> {marcus}.
export function nameTokens(name) {
  let n = stripInvisible(name).toLowerCase().replace(/\([^)]*\)/g, ' ');
  n = n.replace(/["“”]/g, ' ').replace(/[.']/g, '').replace(/[^a-z0-9@_ ]+/g, ' ');
  return [...new Set(n.split(/\s+/).filter(Boolean))];
}
export const factTokens = text => new Set(stripInvisible(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)));
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };
const isSubset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };
const isPair = name => /\s(?:&|and)\s/i.test(name);
const sides = name => String(name).split(/\s(?:&|and)\s|,/i).map(x => x.trim()).filter(Boolean);

// Group name variants into entities: a name belongs to an entity if all its words appear in that entity's longest name.
function resolveNames(counts) {
  const items = [...counts.entries()].map(([name, c]) => ({ name, count: c.count, first: c.first, tokens: new Set(nameTokens(name)) })).filter(x => x.tokens.size);
  items.sort((a, b) => b.tokens.size - a.tokens.size || b.count - a.count);
  const reps = [];
  for (const it of items) {
    const hits = reps.filter(r => isSubset(it.tokens, r.tokens));
    if (hits.length === 1) hits[0].names.push(it);
    else reps.push({ tokens: it.tokens, names: [it] }); // no match, or ambiguous: keep separate rather than guess
  }
  const byName = new Map();
  const entities = reps.map(r => {
    const total = r.names.reduce((s, n) => s + n.count, 0);
    const best = [...r.names].sort((a, b) => (b.count * (1 + 0.15 * b.tokens.size)) - (a.count * (1 + 0.15 * a.tokens.size)))[0];
    const anchor = [...r.names].sort((a, b) => a.first - b.first)[0]; // earliest-seen variant keeps ids stable as scenes are added
    const e = { id: fnv(nameTokens(anchor.name).join(' ')), name: best.name.replace(/\s*\([^)]*\)\s*$/, '').trim() || best.name, aliases: [...new Set(r.names.map(n => n.name))].filter(n => n !== best.name), weight: total };
    for (const n of r.names) byName.set(n.name, e);
    return e;
  });
  return { entities, byName };
}

// Body parts / things whose "current state" is replaced by a newer note (injuries heal, cars get repaired).
const TOPICS = [['rib', /\bribs?\b/i], ['knee', /\bknees?\b/i], ['knuckle', /\bknuckles?\b/i], ['ankle', /\bankles?\b/i], ['wrist', /\bwrists?\b/i],
  ['cheek', /\bcheek(?:bone)?s?\b/i], ['temple', /\btemples?\b/i], ['ear', /\bears?\b|tinnitus/i], ['shoulder', /\bshoulders?\b/i], ['neck', /\bneck\b/i],
  ['head', /\bhead\b|concussion/i], ['hand', /\bhands?\b/i], ['civic', /\bcivic\b/i]];
const EVENT = /\b(lied|told|texted|called|asked|said|promised|agreed|gave|ordered|decided|plans?|scheduled|wrote|sent|offered)\b/i;
export const topicsOf = text => TOPICS.filter(([, re]) => re.test(String(text))).map(([k]) => k);

const normDur = d => (d === 'durable' || d === 'temporary' ? d : 'unknown');

// Build the archive from scenes + the user's review state. Deterministic: same input, same output.
export function buildArchive(scenes, review = {}) {
  const rf = review.facts || {};
  const links = review.links || [];
  // 1. collect every name used in a fact or relationship
  const counts = new Map();
  const seen = (name, order) => { if (!name) return; const c = counts.get(name) || { count: 0, first: order }; c.count++; counts.set(name, c); };
  scenes.forEach((sc, i) => {
    for (const f of sc.facts || []) { if (isPair(f.name || '')) sides(f.name).forEach(n => seen(n, i)); else seen(f.name, i); }
    for (const r of sc.relationships || []) sides(r.who || '').forEach(n => seen(n, i));
  });
  const { entities, byName } = resolveNames(counts);
  const ent = new Map(entities.map(e => [e.id, { ...e, groups: [], rels: new Map() }]));
  const unassigned = { id: 'unassigned', name: '(no name)', aliases: [], weight: 0, groups: [], rels: new Map() };
  const entOf = name => (name && byName.get(name) ? ent.get(byName.get(name).id) : unassigned);
  // 2. relationship items per entity pair
  const addRel = (who, text, sc) => {
    const ss = sides(who).map(entOf);
    if (ss.length < 2) { const e = ss[0] || unassigned; if (!e.rels.has('(general)')) e.rels.set('(general)', []); e.rels.get('(general)').push({ from: sc.from, to: sc.to, text }); return; }
    for (let i = 0; i < ss.length; i++) {
      const others = ss.filter((_, j) => j !== i).map(o => o.name).join(' & ');
      if (!ss[i].rels.has(others)) ss[i].rels.set(others, []);
      ss[i].rels.get(others).push({ from: sc.from, to: sc.to, text });
    }
  };
  // 3. fact groups per entity (near-duplicate facts across scenes collapse into one group)
  for (const sc of scenes) {
    for (const f of sc.facts || []) {
      if (isPair(f.name || '')) { addRel(f.name, f.text, sc); continue; }
      const e = entOf(f.name);
      const toks = factTokens(f.text);
      let g = e.groups.find(x => jaccard(x.toks, toks) >= 0.6);
      if (!g) { g = { text: f.text, toks, scenes: [], durs: [] }; e.groups.push(g); }
      g.scenes.push({ id: sc.id, from: sc.from, to: sc.to });
      g.durs.push(normDur(f.durability));
    }
    for (const r of sc.relationships || []) addRel(r.who, r.text, sc);
  }
  // 4. keys, durability, review overrides, links
  const byKey = new Map();
  for (const e of ent.values()) {
    for (const g of e.groups) {
      g.key = fnv(`${e.id}|${[...g.toks].sort().join(' ')}`);
      byKey.set(g.key, { g, e });
    }
  }
  for (const l of links) { // "same" links merge two groups into one
    if (l.type !== 'same' || l.keys.length < 2) continue;
    const [first, ...rest] = l.keys.map(k => byKey.get(k)).filter(Boolean);
    if (!first) continue;
    for (const o of rest) {
      if (o.g === first.g || o.e !== first.e) continue;
      first.g.scenes.push(...o.g.scenes); first.g.durs.push(...o.g.durs);
      o.e.groups = o.e.groups.filter(x => x !== o.g);
      byKey.set(o.g.key, first);
    }
  }
  const supersededBy = new Map();
  for (const l of links) if (l.type === 'superseded' && !l.dismissed && l.keys.length === 2) supersededBy.set(l.keys[0], l.keys[1]);
  const out = [];
  const deleted = [];
  for (const e of ent.values()) {
    const groups = e.groups.map(g => {
      const o = rf[g.key] || {};
      const dur = g.durs.filter(d => d === 'durable').length, tmp = g.durs.filter(d => d === 'temporary').length;
      const auto = dur + tmp === 0 ? 'unknown' : dur >= tmp ? 'durable' : 'temporary';
      g.scenes.sort((a, b) => a.from - b.from);
      return { key: g.key, text: g.text, scenes: g.scenes, durability: o.d || auto, pin: o.pin || null, hidden: !!o.hide, deleted: !!o.del, auto: false,
        status: o.st === 'superseded' || supersededBy.has(g.key) ? 'superseded' : 'current', supersededBy: supersededBy.get(g.key) || null };
    }).sort((a, b) => a.scenes[0].from - b.scenes[0].from);
    for (const g of groups) if (g.deleted) deleted.push({ entity: e.name, key: g.key, text: g.text });
    const live = groups.filter(g => !g.deleted);
    // A temporary note is "older" when newer temporary notes cover every body part / topic it mentions. Never touches pinned or durable facts.
    const temp = live.filter(g => g.durability === 'temporary' && !g.hidden);
    for (const g of temp) g.topics = topicsOf(g.text);
    for (const g of temp) {
      if (g.status === 'superseded' || g.pin === 'yes' || !g.topics.length || EVENT.test(g.text)) continue; // events (told, lied, gave...) are not states
      const last = g.scenes[g.scenes.length - 1].from;
      if (g.topics.every(t => temp.some(h => h !== g && h.topics.includes(t) && h.scenes[h.scenes.length - 1].from > last))) { g.status = 'superseded'; g.auto = true; }
    }
    for (const g of temp) delete g.topics;
    groups.length = 0; groups.push(...live);
    const relationships = [...e.rels.entries()].map(([who, items]) => ({ with: who, items })).sort((a, b) => b.items.length - a.items.length);
    if (groups.length || relationships.length) out.push({ id: e.id, name: e.name, aliases: e.aliases, weight: e.weight, groups, relationships });
  }
  if (unassigned.groups.length || unassigned.rels.size) out.push({ id: 'unassigned', name: unassigned.name, aliases: [], weight: 0, groups: unassigned.groups.map(g => ({ key: fnv('u|' + [...g.toks].sort().join(' ')), text: g.text, scenes: g.scenes, durability: 'unknown', pin: null, hidden: false, deleted: false, auto: false, status: 'current', supersededBy: null })), relationships: [] });
  out.sort((a, b) => b.groups.length + b.relationships.length - (a.groups.length + a.relationships.length));
  const keyIndex = new Map();
  for (const e of out) for (const g of e.groups) keyIndex.set(g.key, { e, g });
  for (const [k, v] of byKey) if (!keyIndex.has(k)) { const m = keyIndex.get(v.g.key); if (m) keyIndex.set(k, m); }
  // 5. what needs the user's attention
  const suggestions = [];
  const proposed = new Set(review.proposals || []);
  for (const e of out) for (const g of e.groups) {
    const repeated = g.durability === 'durable' && g.scenes.length >= 2;
    if ((repeated || proposed.has(g.key)) && !g.pin && !g.hidden && g.status === 'current') suggestions.push({ entity: e.name, key: g.key, text: g.text, scenes: g.scenes, weight: e.groups.length, byModel: proposed.has(g.key) });
  }
  suggestions.sort((a, b) => (b.byModel - a.byModel) || b.scenes.length - a.scenes.length || b.weight - a.weight);
  const conflicts = links.filter(l => l.type === 'conflict' && !l.dismissed && !l.resolved).map(l => ({
    id: l.id, reason: l.reason || '', items: l.keys.map(k => keyIndex.get(k)).filter(Boolean).map(({ e, g }) => ({ entity: e.name, key: g.key, text: g.text, scenes: g.scenes })),
  })).filter(c => c.items.length === 2);
  return { entities: out, suggestions: suggestions.slice(0, 40), conflicts, deleted };
}

// ---- review state (what the user decided). Pure helpers so they can be tested.
export const newReview = () => ({ facts: {}, links: [], proposals: [] });
export function setFlag(review, key, patch) {
  const cur = { ...(review.facts[key] || {}), ...patch };
  for (const k of Object.keys(cur)) if (cur[k] === null || cur[k] === undefined || cur[k] === false) delete cur[k];
  if (Object.keys(cur).length) review.facts[key] = cur; else delete review.facts[key];
  return review;
}
export const linkId = (type, keys) => `${type}:${[...keys].sort().join('|')}`;
export function addLinks(review, links, now = Date.now()) {
  for (const l of links) {
    const id = linkId(l.type, l.keys);
    const i = review.links.findIndex(x => x.id === id);
    if (i >= 0) continue; // a decision already made about this pair stays made
    review.links.push({ id, type: l.type, keys: l.type === 'superseded' ? [...l.keys] : [...l.keys].sort(), reason: l.reason || '', at: now });
  }
  return review;
}
export function resolveConflict(review, id, keepKey) {
  const l = review.links.find(x => x.id === id);
  if (!l) return review;
  for (const k of l.keys) if (k !== keepKey) setFlag(review, k, { st: 'superseded' });
  l.resolved = true;
  return review;
}
// Delete every older (replaced) note of one entity. Pinned notes are kept. Returns how many were deleted.
export function deleteOlder(review, entity) {
  let n = 0;
  for (const g of entity.groups) if (g.status === 'superseded' && g.pin !== 'yes') { setFlag(review, g.key, { del: true }); n++; }
  return n;
}
export function dismissLink(review, id) { const l = review.links.find(x => x.id === id); if (l) l.dismissed = true; return review; }

// ---- consistency check: the model only returns fact numbers, it can never rewrite a fact.
export const CONSISTENCY_PROMPT = `You compare numbered facts about ONE character, place or thing from a long roleplay. Never rewrite or add facts; use only the numbers.
Reply with lines in exactly these forms, and nothing else:
SAME: 3, 9
CONFLICT: 4, 17 | short reason
SUPERSEDED: 5 -> 12
- SAME: facts that say the same thing in different words.
- CONFLICT: two facts that cannot both be true at the same time (different injuries, addresses, names, relationships, ages).
- SUPERSEDED: fact A was true earlier but fact B replaces it (an injury that healed, someone who moved, a changed plan). Use the scene numbers shown to tell which is later.
PIN: 2, 5 — optional, at most 6 per entity: facts that are hard, permanent canon the story must never contradict (identity, family, home address, job, legal status, standing medical conditions, key relationships). Never a temporary state.
If nothing applies, reply NONE.`;

export function consistencyInput(entity, groups) {
  return `Entity: ${entity}\n${groups.map((g, i) => `[${i + 1}] (scenes ${g.scenes.map(s => s.from).join(', ')}) ${g.text}`).join('\n')}`;
}
export function parseConsistency(raw, n) {
  const out = [];
  const ok = x => Number.isInteger(x) && x >= 1 && x <= n;
  for (const line of stripInvisible(raw).split('\n')) {
    let m;
    if ((m = line.match(/^\s*SAME\s*:\s*([\d,\s]+)/i))) { const ids = [...new Set(m[1].match(/\d+/g).map(Number))].filter(ok); if (ids.length >= 2) out.push({ type: 'same', idxs: ids }); }
    else if ((m = line.match(/^\s*CONFLICT\s*:\s*(\d+)\s*[, ]\s*(\d+)\s*(?:\|\s*(.*))?$/i))) { const a = +m[1], b = +m[2]; if (ok(a) && ok(b) && a !== b) out.push({ type: 'conflict', idxs: [a, b], reason: (m[3] || '').trim() }); }
    else if ((m = line.match(/^\s*PIN\s*:\s*([\d,\s]+)/i))) { const ids = [...new Set(m[1].match(/\d+/g).map(Number))].filter(ok).slice(0, 6); if (ids.length) out.push({ type: 'pin', idxs: ids }); }
    else if ((m = line.match(/^\s*SUPERSEDED\s*:\s*(\d+)\s*(?:->|→|=>)\s*(\d+)/i))) { const a = +m[1], b = +m[2]; if (ok(a) && ok(b) && a !== b) out.push({ type: 'superseded', idxs: [a, b] }); }
  }
  return out;
}

// Entities worth sending to the model: enough facts for a conflict to exist.
const liveGroups = e => e.groups.filter(g => !g.hidden && g.status === 'current');
export const checkable = archive => archive.entities.filter(e => e.id !== 'unassigned' && liveGroups(e).length >= 3);

// Run the check one entity at a time. askModel(system, user) is paced/injected by the caller.
export async function runConsistency({ archive, askModel, onLinks, shouldStop = () => false, maxPerCall = 80 }) {
  let calls = 0;
  for (const e of checkable(archive)) {
    if (shouldStop()) break;
    const groups = liveGroups(e).slice(-maxPerCall);
    let raw;
    try { raw = await askModel(CONSISTENCY_PROMPT, consistencyInput(e.name, groups)); } catch (err) { if (err && err.weftStopped) break; throw err; }
    calls++;
    const links = parseConsistency(raw, groups.length).map(p => ({ type: p.type, keys: p.idxs.map(i => groups[i - 1].key), reason: p.reason }));
    if (onLinks) await onLinks(links, e, calls);
  }
  return { calls };
}

// Store model results: pins become proposals (the user still approves each), the rest become links.
export function applyCheckResults(review, links, now = Date.now()) {
  review.proposals = review.proposals || [];
  const rest = [];
  for (const l of links) {
    if (l.type === 'pin') { for (const k of l.keys) if (!review.proposals.includes(k)) review.proposals.push(k); }
    else rest.push(l);
  }
  return addLinks(review, rest, now);
}
