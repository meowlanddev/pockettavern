// Lorebooks / World Info: SillyTavern world-info JSON and V2 character_book support,
// keyword activation, secondary-key logic, recursion, inclusion groups and character filters.

export const POSITIONS = {
  0: 'Before character',
  1: 'After character',
  4: 'In chat @ depth',
  2: "Author's note (top)",
  3: "Author's note (bottom)",
  5: 'Examples (top)',
  6: 'Examples (bottom)',
  7: 'Outlet',
};
export const LOGIC = { 0: 'AND ANY', 1: 'NOT ALL', 2: 'NOT ANY', 3: 'AND ALL' };

const arr = (v) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean)
  : typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const first = (...vals) => vals.find((v) => v !== undefined && v !== null);

export function normalizeEntry(e, i = 0) {
  const ext = e.extensions || {};
  let position = first(ext.position, e.position, 0);
  if (position === 'before_char') position = 0;
  else if (position === 'after_char') position = 1;
  position = Number(position) || 0;
  const enabled = e.disable !== undefined ? !e.disable : e.enabled !== false;
  return {
    uid: first(e.uid, e.id, i),
    comment: String(first(e.comment, e.name, '')),
    keys: arr(first(e.key, e.keys)),
    secondary: arr(first(e.keysecondary, e.secondary_keys)),
    selective: first(e.selective, ext.selective, true) !== false,
    selectiveLogic: Number(first(e.selectiveLogic, ext.selectiveLogic, 0)) || 0,
    content: String(e.content || ''),
    constant: !!e.constant,
    enabled,
    order: Number(first(e.order, e.insertion_order, 100)),
    position,
    depth: Number(first(e.depth, ext.depth, 4)),
    role: Number(first(e.role, ext.role, 0)) || 0,
    probability: Number(first(e.probability, ext.probability, 100)),
    useProbability: first(e.useProbability, ext.useProbability, true) !== false,
    group: String(first(e.group, ext.group, '')),
    groupOverride: !!first(e.groupOverride, ext.group_override, false),
    groupWeight: Number(first(e.groupWeight, ext.group_weight, 100)),
    caseSensitive: first(e.caseSensitive, e.case_sensitive, ext.case_sensitive, null),
    matchWholeWords: first(e.matchWholeWords, ext.match_whole_words, null),
    scanDepth: first(e.scanDepth, ext.scan_depth, null),
    excludeRecursion: !!first(e.excludeRecursion, ext.exclude_recursion, false),
    preventRecursion: !!first(e.preventRecursion, ext.prevent_recursion, false),
    delayUntilRecursion: !!first(e.delayUntilRecursion, ext.delay_until_recursion, false),
    matchPersonaDescription: !!first(e.matchPersonaDescription, ext.match_persona_description, false),
    matchCharacterDescription: !!first(e.matchCharacterDescription, ext.match_character_description, false),
    matchCharacterPersonality: !!first(e.matchCharacterPersonality, ext.match_character_personality, false),
    matchScenario: !!first(e.matchScenario, ext.match_scenario, false),
    characterFilter: e.characterFilter && Array.isArray(e.characterFilter.names)
      ? { isExclude: !!e.characterFilter.isExclude, names: e.characterFilter.names.map(String), tags: e.characterFilter.tags || [] }
      : null,
    outletName: String(e.outletName || ''),
    sticky: Number(first(e.sticky, ext.sticky, 0)) || 0,
    cooldown: Number(first(e.cooldown, ext.cooldown, 0)) || 0,
    delay: Number(first(e.delay, ext.delay, 0)) || 0,
    ignoreBudget: !!first(e.ignoreBudget, ext.ignore_budget, false),
  };
}

/** Accepts ST world-info JSON ({entries:{...}}) or a character_book ({entries:[...]}). */
export function normalizeBook(json, fallbackName = 'Lorebook') {
  const src = json && json.entries ? json : (json && json.data && json.data.character_book) || null;
  if (!src || !src.entries) throw new Error('Not a lorebook (no entries)');
  const list = Array.isArray(src.entries) ? src.entries : Object.values(src.entries);
  const entries = list.map((e, i) => normalizeEntry(e, i));
  return {
    name: String(src.name || json.name || fallbackName),
    scanDepth: src.scan_depth ?? null,
    entries,
  };
}

/** Export back to SillyTavern world-info JSON. */
export function exportBook(book) {
  const entries = {};
  book.entries.forEach((e, i) => {
    entries[i] = {
      uid: i, key: e.keys, keysecondary: e.secondary, comment: e.comment, content: e.content,
      constant: e.constant, selective: e.selective, selectiveLogic: e.selectiveLogic, order: e.order,
      position: e.position, disable: !e.enabled, depth: e.depth, role: e.role, probability: e.probability,
      useProbability: e.useProbability, group: e.group, groupOverride: e.groupOverride, groupWeight: e.groupWeight,
      caseSensitive: e.caseSensitive, matchWholeWords: e.matchWholeWords, scanDepth: e.scanDepth,
      excludeRecursion: e.excludeRecursion, preventRecursion: e.preventRecursion, delayUntilRecursion: e.delayUntilRecursion,
      matchPersonaDescription: e.matchPersonaDescription, matchCharacterDescription: e.matchCharacterDescription,
      matchCharacterPersonality: e.matchCharacterPersonality, matchScenario: e.matchScenario,
      characterFilter: e.characterFilter || { isExclude: false, names: [], tags: [] },
      outletName: e.outletName, displayIndex: i, addMemo: true, vectorized: false,
      sticky: e.sticky || 0, cooldown: e.cooldown || 0, delay: e.delay || 0, ignoreBudget: !!e.ignoreBudget,
    };
  });
  return { entries };
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keyMatches(key, text, e) {
  const rx = key.match(/^\/([\s\S]+)\/([a-z]*)$/);
  if (rx) {
    try { return new RegExp(rx[1], rx[2].replace('g', '')).test(text); } catch { return false; }
  }
  const cs = !!e.caseSensitive;
  const k = cs ? key.trim() : key.trim().toLowerCase();
  if (!k) return false;
  const t = cs ? text : text.toLowerCase();
  if (e.matchWholeWords && !/\s/.test(k)) {
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRx(k)}(?:$|[^\\p{L}\\p{N}_])`, 'u').test(t);
  }
  return t.includes(k);
}

function entryMatches(e, text) {
  if (!e.keys.some((k) => keyMatches(k, text, e))) return false;
  if (!e.selective || !e.secondary.length) return true;
  const hits = e.secondary.map((k) => keyMatches(k, text, e));
  switch (e.selectiveLogic) {
    case 1: return !hits.every(Boolean); // NOT ALL
    case 2: return !hits.some(Boolean); // NOT ANY
    case 3: return hits.every(Boolean); // AND ALL
    default: return hits.some(Boolean); // AND ANY
  }
}

const norm = (s) => String(s || '').trim().toLowerCase();

function filterPasses(e, charNames) {
  const f = e.characterFilter;
  if (!f || !f.names || !f.names.length) return true;
  const hit = f.names.some((n) => charNames.has(norm(n)));
  return f.isExclude ? !hit : hit;
}

/**
 * entries: normalized entries (from all active books)
 * history: array of message strings, oldest first
 * timed: per-chat state for sticky/cooldown (mutated), keyed by entry._key
 * Returns buckets of activated entries (contents NOT yet macro-processed).
 */
export function activateWorldInfo({ entries, history, char, persona, defaultDepth = 4, timed = null, chatLength = null, recursion = true, maxRecursion = 3, budget = 0 }) {
  const out = { before: [], after: [], depth: [], anTop: [], anBottom: [], emTop: [], emBottom: [], outlets: {}, count: 0 };
  if (!entries || !entries.length) return out;
  const charNames = new Set([norm(char && char.name), norm(char && char.fileName)].filter(Boolean));
  const candidates = entries.filter((e) => e.enabled && e.content && e.content.trim() && filterPasses(e, charNames));
  const roll = (e) => !e.useProbability || e.probability >= 100 || Math.random() * 100 < e.probability;

  const scanFor = (e) => {
    const depth = Number(e.scanDepth ?? defaultDepth) || 0;
    let text = depth > 0 ? history.slice(-depth).join('\n') : '';
    if (e.matchPersonaDescription && persona) text += '\n' + (persona.description || '');
    if (e.matchCharacterDescription && char) text += '\n' + (char.description || '');
    if (e.matchCharacterPersonality && char) text += '\n' + (char.personality || '');
    if (e.matchScenario && char) text += '\n' + (char.scenario || '');
    return text;
  };

  // Timed effects (SillyTavern): delay = needs N messages in the chat; sticky = stays on for N
  // more messages after triggering; cooldown = can't trigger for N messages afterwards.
  const now = chatLength ?? history.length;
  const stateOf = (e) => (timed && e._key ? timed[e._key] : null);
  const stickyNow = (e) => { const t = stateOf(e); return !!(t && t.sticky && now >= t.sticky.start && now <= t.sticky.end); };
  const coolingNow = (e) => { const t = stateOf(e); return !!(t && t.cooldown && now >= t.cooldown.from && now <= t.cooldown.to); };
  const viaSticky = new Set();

  const active = new Set();
  for (const e of candidates) {
    if (e.delay && now < e.delay) continue;
    if (stickyNow(e)) { active.add(e); viaSticky.add(e); continue; }
    if (coolingNow(e)) continue;
    if (e.constant) { if (roll(e)) active.add(e); continue; }
    if (e.delayUntilRecursion || !e.keys.length) continue;
    if (entryMatches(e, scanFor(e)) && roll(e)) active.add(e);
  }

  // Recursion: activated entries' contents can trigger other entries.
  let buffer = [...active].filter((e) => !e.preventRecursion).map((e) => e.content).join('\n');
  const passes = !recursion ? 0 : (Number(maxRecursion) > 0 ? Number(maxRecursion) : 10);
  for (let pass = 0; pass < passes && buffer; pass++) {
    const newly = [];
    for (const e of candidates) {
      if (active.has(e) || e.excludeRecursion || e.constant || !e.keys.length) continue;
      if ((e.delay && now < e.delay) || coolingNow(e)) continue;
      if (entryMatches(e, buffer) && roll(e)) newly.push(e);
    }
    if (!newly.length) break;
    newly.forEach((e) => active.add(e));
    buffer = newly.filter((e) => !e.preventRecursion).map((e) => e.content).join('\n');
  }

  // Inclusion groups: only one entry per group survives.
  const groups = new Map();
  for (const e of active) {
    for (const g of e.group.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
  }
  for (const members of groups.values()) {
    const alive = members.filter((e) => active.has(e));
    if (alive.length < 2) continue;
    let winner;
    const stuck = alive.filter((e) => viaSticky.has(e));
    const prioritized = stuck.length ? stuck : alive.filter((e) => e.groupOverride);
    if (prioritized.length) {
      winner = prioritized.reduce((a, b) => (b.order > a.order ? b : a));
    } else {
      const weights = alive.map((e) => Math.max(0, Number(e.groupWeight) || 0));
      const total = weights.reduce((a, b) => a + b, 0);
      winner = alive[alive.length - 1];
      if (!total) winner = alive[Math.floor(Math.random() * alive.length)];
      else {
        let r = Math.random() * total;
        for (let i = 0; i < alive.length; i++) { r -= weights[i]; if (r < 0) { winner = alive[i]; break; } }
      }
    }
    alive.forEach((e) => { if (e !== winner) active.delete(e); });
  }

  if (timed) {
    for (const e of active) {
      if (viaSticky.has(e) || !e._key || (!e.sticky && !e.cooldown)) continue;
      timed[e._key] = {
        sticky: e.sticky ? { start: now, end: now + e.sticky } : null,
        cooldown: e.cooldown ? { from: now + e.sticky + 1, to: now + e.sticky + e.cooldown } : null,
      };
    }
  }

  // Budget: highest-order entries win when the lorebook would take too much of the context.
  if (budget > 0) {
    let used = 0;
    for (const e of [...active].sort((a, b) => b.order - a.order)) {
      const t = Math.ceil(e.content.length / 3.5);
      if (!e.ignoreBudget && used + t > budget) { active.delete(e); out.droppedByBudget = (out.droppedByBudget || 0) + 1; continue; }
      used += t;
    }
  }

  const sorted = [...active].sort((a, b) => a.order - b.order);
  for (const e of sorted) {
    switch (e.position) {
      case 1: out.after.push(e); break;
      case 2: out.anTop.push(e); break;
      case 3: out.anBottom.push(e); break;
      case 4: out.depth.push(e); break;
      case 5: out.emTop.push(e); break;
      case 6: out.emBottom.push(e); break;
      case 7: (out.outlets[e.outletName] = out.outlets[e.outletName] || []).push(e); break;
      default: out.before.push(e);
    }
  }
  out.count = sorted.length;
  return out;
}
