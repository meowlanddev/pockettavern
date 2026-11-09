// Layered long-term memory + continuity auditor, inspired by the Summaryception extension
// (https://github.com/vadash/Extension-Summaryception). Independent implementation.
//
// Recent chat stays verbatim. Older chat is summarized into Layer 0 memories and those messages
// are "ghosted" (kept in the chat, no longer sent to the model). Crowded layers are merged into
// deeper layers. An optional auditor keeps a live continuity state (scene, bonds, agendas, notes).

export const estTokens = (s) => Math.ceil((s || '').length / 3.5);

export const MEMORY_MODES = {
  balanced: { label: 'Balanced', verbatim: 22000, queued: 6000 },
  prefix: { label: 'Prefix cache', verbatim: 20000, queued: 16000 },
  small: { label: 'Small context', verbatim: 8000, queued: 4000 },
  custom: { label: 'Custom' },
};

export const DEFAULT_L0_PROMPT = `You are a meticulous story archivist. Summarize the passage of roleplay below into one compact memory.

Rules:
- Past tense, third person, plain prose. No commentary, no headings, no lists.
- Keep what matters later: who did what to whom, promises, secrets revealed, injuries, possessions, locations, relationship shifts, unresolved threads.
- Use the characters' real names (the user's character is {{user}}). Never invent events.
- About {{target}} tokens.
- If the passage mentions an in-story date or time, end with a final line: current_date_time: <the latest one>.

Wrap the memory in <narrative></narrative> and output nothing else.`;

export const DEFAULT_MERGE_PROMPT = `You are a meticulous story archivist. Merge the consecutive memories below into one deeper memory that preserves every fact still likely to matter (names, promises, secrets, injuries, possessions, locations, relationship changes, open threads) while dropping repetition and moment-to-moment detail.

Rules:
- Past tense, third person, plain prose, chronological. No commentary or headings.
- About {{target}} tokens.
- Keep the latest current_date_time line if any memory has one, as the final line.

Wrap the result in <narrative></narrative> and output nothing else.`;

export const DEFAULT_AUDITOR_PROMPT = `You are a continuity auditor for a roleplay. You never write story prose. Read the prior continuity state and the latest exchange, then output the complete updated state as ONE JSON object, nothing else.

Schema:
{
  "bonds": { "<Character Name>↔User": { "positive_interaction": bool, "slight": bool, "insult": bool, "betrayal": bool, "apology": bool } },
  "agendas": { "<Character Name>": { "task": "current goal", "step": { "current": int, "max": int }, "status": "what they are doing / where they are" } },
  "gm_notes": ["[R] persistent rule or constraint", "[T] open thread, promise or deadline", "[S] secret: who knows, who doesn't"],
  "physics": { "location": "", "environment": "", "posture_and_position": "", "contact_points": "", "clothing_state": "" }
}

Rules:
- Rewrite the whole state (not a diff): keep prior entries that still hold, update what changed, drop what was resolved.
- Bonds: one entry per character who interacted with User in the latest exchange; judge only that exchange with the five booleans. Never output scores.
- Use canonical character names; "User" always means {{user}}.
- If a character wasn't present for an event, record it as an [S] secret saying who knows and who is ignorant.
- At most 12 gm_notes, most important first.`;

export const DEFAULT_MEMORY_SETTINGS = Object.freeze({
  enabled: false,
  mode: 'balanced',
  verbatim: 22000,
  queued: 6000,
  memoryBudget: 10000,
  minTurns: 3,
  maxTurns: 8,
  target: 280,
  perLayer: 24,
  perMerge: 3,
  position: 'before',
  depth: 0,
  role: 'system',
  template: '<memory>\nWhat happened earlier in this story (oldest first):\n{{memory}}\n</memory>',
  model: '',
  l0Prompt: DEFAULT_L0_PROMPT,
  mergePrompt: DEFAULT_MERGE_PROMPT,
  auditor: false,
  auditorModel: '',
  auditorPrompt: DEFAULT_AUDITOR_PROMPT,
});

export function budgets(cfg) {
  const m = MEMORY_MODES[cfg.mode];
  if (m && m.verbatim) return { verbatim: m.verbatim, queued: m.queued };
  return { verbatim: Number(cfg.verbatim) || 22000, queued: Number(cfg.queued) || 6000 };
}

const textOf = (m) => (m.swipes ? m.swipes[m.swipeIdx] || '' : '');

/** Split the live (un-ghosted) messages into turns: a user message plus the replies after it. */
function turnsOf(live) {
  const turns = [];
  let cur = [];
  for (const m of live) {
    if (m.role === 'user' && cur.some((x) => x.role !== 'user')) { turns.push(cur); cur = []; }
    cur.push(m);
  }
  if (cur.length) turns.push(cur);
  return turns;
}

/**
 * Plan which old messages to compress.
 * mode 'auto': only when live chat exceeds verbatim+queued, then compress down to verbatim.
 * mode 'force': compress down to verbatim now.  mode 'slop': compress all but the last `keep` turns.
 * Returns an array of chunks (arrays of messages), oldest first. Never includes the last 2 turns.
 */
export function planChunks(messages, cfg, mode = 'auto', keep = 2) {
  const live = messages.filter((m) => !m.ghost && textOf(m).trim());
  const total = live.reduce((s, m) => s + estTokens(textOf(m)), 0);
  const { verbatim, queued } = budgets(cfg);
  if (mode === 'auto' && total <= verbatim + queued) return [];
  const turns = turnsOf(live);
  const eligible = turns.slice(0, Math.max(0, turns.length - keep));
  let excess = mode === 'slop' ? Infinity : total - verbatim;
  if (excess <= 0) return [];
  const chunks = [];
  let cur = [];
  const minT = Math.max(1, Number(cfg.minTurns) || 3);
  const maxT = Math.max(minT, Number(cfg.maxTurns) || 8);
  for (const t of eligible) {
    if (excess <= 0 && cur.length === 0) break;
    cur.push(t);
    excess -= t.reduce((s, m) => s + estTokens(textOf(m)), 0);
    const chunkTokens = cur.flat().reduce((s, m) => s + estTokens(textOf(m)), 0);
    if (cur.length >= maxT || (cur.length >= minT && (excess <= 0 || chunkTokens > 6000))) {
      chunks.push(cur.flat());
      cur = [];
    }
  }
  if (cur.length && (cur.length >= minT || mode !== 'auto')) chunks.push(cur.flat());
  return chunks;
}

export function passageText(msgs, nameOf) {
  return msgs.map((m) => `${nameOf(m)}: ${textOf(m).trim()}`).join('\n\n');
}

export function extractNarrative(out) {
  const s = String(out || '').trim();
  const m = s.match(/<narrative>([\s\S]*?)<\/narrative>/i);
  return (m ? m[1] : s.replace(/^```\w*\n?|```$/g, '')).trim();
}

/** Layers to merge: any layer over perLayer, then (if over budget) the busiest layer. */
export function nextPromotion(layers, cfg) {
  const perLayer = Math.max(2, Number(cfg.perLayer) || 24);
  const perMerge = Math.max(2, Number(cfg.perMerge) || 3);
  for (let k = 0; k < layers.length; k++) if ((layers[k] || []).length > perLayer) return { layer: k, count: perMerge };
  const total = layers.flat().reduce((s, x) => s + estTokens(x.text), 0);
  if (total > (Number(cfg.memoryBudget) || 10000)) {
    let best = -1;
    for (let k = 0; k < layers.length; k++) if ((layers[k] || []).length >= perMerge && (best < 0 || layers[k].length > layers[best].length)) best = k;
    if (best >= 0) return { layer: best, count: perMerge };
  }
  return null;
}

/** The memory text injected into prompts: deepest (oldest) layers first. */
export function assembleMemory(mem) {
  if (!mem || !mem.layers || !mem.layers.some((l) => l && l.length)) return '';
  const parts = [];
  for (let k = mem.layers.length - 1; k >= 0; k--) {
    const layer = mem.layers[k] || [];
    if (!layer.length) continue;
    parts.push(layer.map((x) => x.text.trim()).join('\n\n'));
  }
  return parts.join('\n\n');
}

// ---------- continuity auditor ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const GATES = [[12, 'intimacy'], [8, 'kiss'], [5, 'handhold'], [2, 'hug']];
export const gateFor = (bond) => (GATES.find(([min]) => bond >= min) || [null, null])[1];

/** Bond arithmetic is done here from the auditor's booleans (the model never does math). */
export function applyBondFlags(prev, flags, turn) {
  const n = { bond: clamp(prev && prev.bond, -5, 20), sparks: clamp(prev && prev.sparks, 0, 99), grudge: clamp(prev && prev.grudge, 0, 99) };
  const f = flags || {};
  if (f.positive_interaction === true) n.sparks += 1;
  if (f.slight === true) n.grudge += 1;
  if (f.insult === true) n.bond -= 1;
  if (f.betrayal === true) n.bond -= 2;
  if (f.apology === true) n.grudge = 0;
  if (turn % 5 === 0) {
    if (f.positive_interaction !== true) n.sparks = Math.max(0, n.sparks - 1);
    if (n.sparks >= 7) { n.bond += n.grudge >= 3 ? 0 : 1; n.sparks = 0; }
  }
  if (turn % 3 === 0) {
    if (n.grudge >= 5) { n.bond -= 1; n.grudge = 0; } else n.grudge = Math.max(0, n.grudge - 1);
  }
  return { bond: clamp(n.bond, -5, 20), sparks: clamp(n.sparks, 0, 99), grudge: clamp(n.grudge, 0, 99) };
}

function parseJson(out) {
  const s = String(out || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Auditor returned no JSON');
  const raw = s.slice(start, end + 1);
  try { return JSON.parse(raw); } catch {
    return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'));
  }
}

const pairKey = (k) => {
  const [a, b] = String(k).split(/\s*↔\s*/);
  if (b === 'User') return `${a.trim()}↔User`;
  if (a === 'User') return `${b.trim()}↔User`;
  return null;
};

/** Merge auditor output into the prior state. */
export function nextContinuityState(prev, output) {
  const out = parseJson(output);
  const turn = ((prev && prev.turn) || 0) + 1;
  const bonds = { ...((prev && prev.bonds) || {}) };
  for (const [k, flags] of Object.entries(out.bonds || {})) {
    const key = pairKey(k);
    if (key) bonds[key] = applyBondFlags(bonds[key], flags, turn);
  }
  const agendas = {};
  for (const [name, a] of Object.entries(out.agendas || {})) {
    const max = clamp(a && a.step && a.step.max, 1, 99) || 1;
    agendas[name] = { task: String((a && a.task) || 'None'), step: { current: clamp(a && a.step && a.step.current, 1, max) || 1, max }, status: String((a && a.status) || '') };
  }
  const notes = (Array.isArray(out.gm_notes) ? out.gm_notes : []).map(String).filter((x) => /^\[[RTS]\]/.test(x.trim())).slice(0, 12);
  const p = out.physics || {};
  const physics = {};
  for (const k of ['location', 'environment', 'posture_and_position', 'contact_points', 'clothing_state']) physics[k] = String(p[k] || '');
  return { turn, bonds, agendas, notes, physics };
}

export function renderContinuity(state, staleBy = 0) {
  if (!state) return '';
  const lines = [];
  const ph = state.physics || {};
  const scene = [['Location', ph.location], ['Environment', ph.environment], ['Physics', ph.posture_and_position], ['Contact', ph.contact_points], ['Clothing', ph.clothing_state]].filter(([, v]) => v && v.trim());
  if (scene.length) lines.push('[SCENE & POSITIONING]', ...scene.map(([k, v]) => `${k}: ${v}`), '');
  const bonds = Object.entries(state.bonds || {});
  if (bonds.length) {
    lines.push('[RELATIONSHIP GATES]');
    for (const [k, b] of bonds) {
      const g = gateFor(b.bond);
      lines.push(`${k.replace('↔User', ' & {{user}}')}: BOND ${b.bond >= 0 ? '+' : ''}${b.bond} (Sparks: ${b.sparks}, Grudge: ${b.grudge})${g ? `; Gate: ${g}` : ''}`);
    }
    lines.push('');
  }
  const secrets = (state.notes || []).filter((n) => n.trim().startsWith('[S]'));
  if (secrets.length) lines.push('[SECRETS & ASYMMETRIC KNOWLEDGE]', ...secrets, '');
  const agendas = Object.entries(state.agendas || {});
  const other = (state.notes || []).filter((n) => !n.trim().startsWith('[S]'));
  if (agendas.length || other.length) {
    lines.push('[ACTIVE AGENDAS & THREADS]');
    for (const [name, a] of agendas) lines.push(`- ${name}: ${a.task} (Step ${a.step.current}/${a.step.max}${a.status ? `: ${a.status}` : ''})`);
    lines.push(...other.map((n) => `- ${n}`));
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return '';
  const stale = staleBy > 0 ? `\n(State is from ${staleBy} exchange${staleBy === 1 ? '' : 's'} ago.)` : '';
  return `<active_continuity>\n${lines.join('\n')}${stale}\n</active_continuity>`;
}
