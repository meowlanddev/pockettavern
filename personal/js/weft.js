// WEFT — scene-based memory. Stage 1: split a chat into scenes and keep one immutable,
// historical-only record per scene. Pure logic only (model calls are injected), so it can be
// tested in node. Nothing here touches the prompt yet.
import { messageText, estimateTokens } from './narrative-db.js';

export const BOUNDARY_PROMPT = `You split a roleplay transcript into scenes. Messages are numbered like [#12].
A scene is one continuous stretch in the same place and the same stretch of time, so it can be long. Start a NEW scene only when one of these clearly happens:
- the location changes (they leave the room, travel, arrive somewhere else);
- time jumps forward (overnight, the next day, hours or days later, a time-skip or chapter break);
- the main characters separate, or a different set of characters takes over the story.
Do NOT split because the mood, activity or topic changes inside the same place and time. A conversation, then intimacy, then aftercare, then a meal in the same room is ONE scene. Arguments, confessions, emotional shifts and phone calls made from the same room do not start a new scene.
Most passages contain few breaks, and many contain none. Reply with ONLY a JSON array of the message numbers where a new scene begins, in ascending order. Never include the first message. If the whole passage is one scene, reply [].`;

export const SCENE_PROMPT = `You write one permanent memory record for a roleplay scene, so the story can be recalled accurately later.
Rules:
- Past tense, third person, plain and factual. The input gives a maximum length; stay under it, in two or three short paragraphs. If a note says the scene continues past this passage, describe only this passage and do not conclude or wrap up the scene. If a note says this passage continues the previous one, do not re-introduce the setting or characters.
- Record only what actually happened or was stated in this scene: who was where, what was done, said, decided, learned, or changed. Keep exact names, places, injuries and anything the story depends on, as written. Leave out phone numbers, door or keypad codes, passwords, account handles and exact clock times unless the story turns on them.
- Do NOT invent, guess, or interpret motives. Do NOT add open threats, unresolved questions, predictions, or what might happen next. Describe the scene's end state only.
- Leave out physical choreography (who knelt, held a hand, moved across the room, sat on the bed). Say what happened and what it meant, not how people moved, unless a movement caused an injury or became a plot point.
- Do not narrate blow by blow and do not copy long passages of dialogue. For sex, violence or other intense moments, say in one plain sentence what happened and keep only what matters later (who, consent, protection, injuries, anything said that changed the relationship). No graphic or anatomical detail.
Reply in exactly this format:
SUMMARY: <the record>
NAMES: <comma-separated people, places and notable objects that appear>
FACTS: <at most 15 lines, formatted "- Name | durable or temporary | fact". Each line is ONE short statement about ONE thing (one injury, one address, one relationship); never join separate facts with commas, semicolons or "and". A list of facts already recorded may be given: do not repeat one unless this scene changed it. Only facts likely to matter many scenes later: identity, family, home and addresses, job, injuries and medical status, legal status, important possessions, secrets and who knows them, promises. Skip meals, clothing, times of day, weather, phone numbers, door or keypad codes, account handles, and moment-to-moment actions or gestures. Use the exact name as written in the story. "durable" = stays true long-term (home, job, family, history, rules of the world). "temporary" = will change (an injury, a plan, where someone is right now). Write "- none" if nothing.>
RELATIONSHIPS: <one per line, formatted "- A & B | what changed between them". Only if their relationship meaningfully changed (trust, closeness, conflict, a promise). Write "- none" if nothing.>`;

export const DEFAULT_WEFT_SETTINGS = Object.freeze({
  enabled: false,
  model: '',
  v: 6, // bump to replace saved prompts/sizes with new defaults on next load
  minSceneTokens: 4000,
  targetSceneTokens: 15000,
  maxSceneTokens: 30000,
  maxOutputTokens: 1600,
  callIntervalSec: 21, // 3 requests per minute = one call every 20s; 21 leaves a little slack
  boundaryPrompt: BOUNDARY_PROMPT,
  scenePrompt: SCENE_PROMPT,
});

// Some models append runs of zero-width characters (a hidden watermark); they waste tokens and clutter records.
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff\u202a-\u202e]/g;
export const stripInvisible = s => String(s ?? '').replace(INVISIBLE, '');
export function cleanScenes(scenes) {
  let changed = false;
  const fix = x => { const y = stripInvisible(x); if (y !== x) changed = true; return y.trim(); };
  const out = (scenes || []).map(sc => ({ ...sc,
    summary: fix(sc.summary), names: (sc.names || []).map(fix),
    facts: (sc.facts || []).map(f => ({ ...f, name: fix(f.name), text: fix(f.text) })),
    relationships: (sc.relationships || []).map(r => ({ ...r, who: fix(r.who), text: fix(r.text) })) }));
  return { scenes: out, changed };
}

const tok = m => (m.hidden || !messageText(m).trim() ? 0 : estimateTokens(messageText(m)) + 4);

// Fingerprint of one message range (1-based, inclusive). Used to detect edited history.
export function rangeFingerprint(messages, from, to) {
  let h = 2166136261;
  for (let i = from - 1; i < to && i < messages.length; i++) {
    const s = (messages[i].role || '') + '\u0001' + messageText(messages[i]) + '\u0002';
    for (let j = 0; j < s.length; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 16777619); }
  }
  return (h >>> 0).toString(36);
}

// Compact numbered transcript for boundary detection (excerpts keep it cheap).
export function numberedWindow(messages, start, end, speaker) {
  const lines = [];
  for (let i = start; i < end; i++) {
    const m = messages[i];
    const t = messageText(m).replace(/\s+/g, ' ').trim();
    if (!t || m.hidden) continue;
    const ex = t.length > 480 ? `${t.slice(0, 300)} … ${t.slice(-160)}` : t;
    lines.push(`[#${i + 1}] ${speaker(m)}: ${ex}`);
  }
  return lines.join('\n');
}

// Accepts "[12, 40]", prose around a JSON array, or garbage (returns []).
export function parseBoundaries(raw, minNum, maxNum) {
  const m = String(raw || '').match(/\[[^\[\]]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { arr = (m[0].match(/\d+/g) || []).map(Number); }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map(Number).filter(n => Number.isInteger(n) && n > minNum && n <= maxNum))].sort((a, b) => a - b);
}

// Decide where the scene starting at message index `start` ends.
// Returns { end } (exclusive index, so the scene is messages[start..end)) or null if the scene is still open.
// The model proposes cuts; size limits override it: no scene under min tokens, and a scene is force-cut at max.
export async function findSceneEnd({ messages, start, minTokens, maxTokens, targetTokens, speaker, askBoundary, flush = false }) {
  const target = Number(targetTokens) || (minTokens + maxTokens) / 2;
  let cum = 0, forcedEnd = -1, i = start;
  for (; i < messages.length; i++) {
    const n = tok(messages[i]);
    if (cum && cum + n > maxTokens) { forcedEnd = i; break; }
    cum += n;
  }
  const windowEnd = forcedEnd >= 0 ? forcedEnd : messages.length;
  const atEnd = forcedEnd < 0;
  if (atEnd && !flush && cum < minTokens) return null;
  const text = numberedWindow(messages, start, windowEnd, speaker);
  let proposed = [];
  if (text) proposed = parseBoundaries(await askBoundary(text), start + 1, windowEnd);
  // Of the proposed breaks that leave a big-enough scene, take the one closest to the target size,
  // so a model that over-splits cannot push us into many tiny scenes.
  let best = null;
  for (const num of proposed) {
    const end = num - 1; // message #num starts the next scene
    let t = 0;
    for (let k = start; k < end; k++) t += tok(messages[k]);
    if (end > start && t >= minTokens && (!best || Math.abs(t - target) < best.gap)) best = { end, gap: Math.abs(t - target) };
  }
  if (best) return { end: best.end, forced: false };
  if (!atEnd) return { end: forcedEnd, forced: true };
  if (flush) return { end: messages.length, forced: false };
  return null;
}

const HEAD = /^\s*(SUMMARY|NAMES|FACTS|CHANGED|RELATIONSHIPS)\s*:[ \t]*/gim;
function sections(text) {
  const out = {};
  const marks = [...text.matchAll(HEAD)];
  marks.forEach((m, i) => {
    const key = m[1].toUpperCase();
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    if (!(key in out)) out[key] = text.slice(m.index + m[0].length, end).trim();
  });
  return out;
}
const bullets = text => String(text || '').split('\n').map(l => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(l => l && !/^none\.?$/i.test(l));
const durability = d => (/^dur/i.test(d) ? 'durable' : /^temp/i.test(d) ? 'temporary' : 'unknown');

export function parseFactLines(text) {
  return bullets(text).map(line => {
    const p = line.split('|').map(x => x.trim());
    if (p.length >= 3) return { name: p[0], durability: durability(p[1]), text: p.slice(2).join(' | ') };
    if (p.length === 2) return { name: p[0], durability: 'unknown', text: p[1] };
    return { name: '', durability: 'unknown', text: line };
  }).filter(f => f.text);
}
// Phone numbers, door/keypad codes and passwords never matter for the story. The prompt asks the model to skip
// them, but models ignore that, so facts like these are also dropped in code. (A story codeword is kept.)
export const isNoiseFact = f => /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\b\d{3}-\d{4}\b|\b(?:door|gate|keypad|entry|access|condo|lock|alarm)\s+(?:codes?|pins?)\b|\bpass(?:word|code)s?\b|\bPIN\b|\b\d{4,6}#/i.test(String((f && f.text) || ''));

export const formatFactLines = facts => (facts || []).map(f => `${f.name || ''} | ${f.durability || 'unknown'} | ${f.text}`).join('\n');

export function parseRelationshipLines(text) {
  return bullets(text).map(line => {
    const k = line.indexOf('|');
    return k < 0 ? { who: '', text: line } : { who: line.slice(0, k).trim(), text: line.slice(k + 1).trim() };
  }).filter(r => r.text);
}
export const formatRelationshipLines = rels => (rels || []).map(r => `${r.who || ''} | ${r.text}`).join('\n');

export function parseSceneOutput(raw) {
  const sec = sections(stripInvisible(raw).replace(/\r/g, ''));
  const summary = (sec.SUMMARY || '').trim();
  if (!summary) return null;
  return {
    summary,
    names: (sec.NAMES || '').split('\n')[0].split(',').map(x => x.trim()).filter(Boolean),
    facts: parseFactLines(sec.FACTS ?? sec.CHANGED).filter(f => !isNoiseFact(f)),
    relationships: parseRelationshipLines(sec.RELATIONSHIPS),
  };
}

// Longer scenes get longer records: about 1 word per 60 tokens of scene, between 150 and 600 words.
export const recordWords = tokens => Math.min(600, Math.max(150, Math.round(tokens / 60 / 10) * 10));

export function buildSceneInput(messages, from, to, speaker, previousSummary = '', { continues = false, continued = false, tokens = 0, knownFacts = [] } = {}) {
  const body = [];
  for (let i = from - 1; i < to; i++) {
    const m = messages[i];
    if (m.hidden || !messageText(m).trim()) continue;
    body.push(`${speaker(m)}: ${stripInvisible(messageText(m))}`);
  }
  const notes = [`Keep the record under ${recordWords(tokens)} words.`];
  if (continued) notes.push('This passage continues the previous one: the same scene is still going.');
  if (continues) notes.push('The scene is still going after this passage ends: describe only this passage, do not conclude it.');
  const known = knownFacts.length ? `<facts_already_recorded>\n${knownFacts.map(f => `- ${f}`).join('\n')}\n</facts_already_recorded>\n\n` : '';
  return `${known}${previousSummary ? `<previous_scene_for_context_only>\n${previousSummary}\n</previous_scene_for_context_only>\n\n` : ''}<note>${notes.join(' ')}</note>\n\n<scene messages="${from}-${to}">\n${body.join('\n\n')}\n</scene>`;
}

export function makeScene(messages, from, to, parsed, now = Date.now(), extra = {}) {
  let tokens = 0;
  for (let i = from - 1; i < to; i++) tokens += tok(messages[i]);
  return { id: `s${from}-${to}`, from, to, tokens, fingerprint: rangeFingerprint(messages, from, to),
    summary: parsed.summary, names: parsed.names, facts: parsed.facts || [], relationships: parsed.relationships || [], continues: extra.continues === true, pv: extra.pv ?? null, edited: false, at: now };
}

export const nextStart = scenes => (scenes.length ? scenes[scenes.length - 1].to : 0);

// Scenes whose source messages changed since they were written.
export function staleScenes(messages, scenes) {
  return scenes.filter(s => s.to > messages.length || rangeFingerprint(messages, s.from, s.to) !== s.fingerprint).map(s => s.id);
}

// Rough cost of building scenes for everything after `start`. Approximate, for the confirm screen.
export function estimateBackfill(messages, start, opts) {
  let tokens = 0, count = 0;
  for (let i = start; i < messages.length; i++) { const n = tok(messages[i]); if (n) count++; tokens += n; }
  // Scenes land between "always cut at max size" (fewest) and "cut near the minimum" (most).
  const target = Number(opts.targetSceneTokens) || (opts.minSceneTokens + opts.maxSceneTokens) / 2;
  const none = tokens < opts.minSceneTokens;
  const scenesLow = none ? 0 : Math.max(1, Math.ceil(tokens / opts.maxSceneTokens));
  const scenes = none ? 0 : Math.max(scenesLow, Math.round(tokens / target));
  const scenesHigh = none ? 0 : Math.max(scenes, Math.round(tokens / (opts.minSceneTokens * 1.5)));
  const promptTokens = estimateTokens(opts.boundaryPrompt || '') + estimateTokens(opts.scenePrompt || '');
  return {
    messages: count, tokens, scenes, scenesLow, scenesHigh, calls: scenes * 2,
    inputTokens: Math.round(tokens * 1.45 + scenes * promptTokens),
    outputTokens: Math.round(tokens / 60 * 1.4) + scenes * 350,
    minutes: Math.ceil(scenes * 2 * (Number(opts.callIntervalSec) || 0) / 60),
  };
}

// Build scenes one at a time. Each finished scene is handed to onScene (so the app can save it),
// which makes the run resumable: call again later and it continues after the last saved scene.
// A failed model call throws; scenes already saved are kept.
export async function runBackfill({ messages, scenes, opts, speaker, askBoundary, summarize, onScene, shouldStop = () => false, flush = false }) {
  const out = [...scenes];
  let made = 0;
  for (;;) {
    if (shouldStop()) break;
    const start = nextStart(out);
    if (start >= messages.length) break;
    try {
      const cut = await findSceneEnd({ messages, start, minTokens: opts.minSceneTokens, maxTokens: opts.maxSceneTokens, targetTokens: opts.targetSceneTokens, speaker, askBoundary, flush });
      if (!cut) break;
      const from = start + 1, to = cut.end;
      const prev = out.length ? out[out.length - 1] : null;
      let sceneTokens = 0;
      for (let k = from - 1; k < to; k++) sceneTokens += tok(messages[k]);
      const input = buildSceneInput(messages, from, to, speaker, prev ? prev.summary : '', { continues: cut.forced, continued: !!(prev && prev.continues), tokens: sceneTokens, knownFacts: prev ? (prev.facts || []).slice(0, 25).map(f => (f.name ? `${f.name}: ` : '') + f.text) : [] });
      let parsed = parseSceneOutput(await summarize(input));
      if (!parsed) parsed = parseSceneOutput(await summarize(input)); // one retry on an unusable reply
      if (!parsed) throw new Error(`The model did not return a usable scene record for messages ${from}-${to}.`);
      const scene = makeScene(messages, from, to, parsed, Date.now(), { continues: cut.forced, pv: opts.v });
      out.push(scene);
      made++;
      if (onScene) await onScene(scene, out);
    } catch (e) {
      if (e && e.weftStopped) break; // the user pressed Stop while we were waiting on the rate limit
      throw e;
    }
  }
  return { scenes: out, made };
}

const RATE_LIMIT = /\b429\b|rate.?limit|too many requests|quota/i;

// Wraps model calls so they start at least intervalMs apart (e.g. a 3 requests/minute limit) and
// retries a rate-limit error after a growing pause instead of failing the whole run.
export function makePacer({ intervalMs = 0, retries = 4, backoffMs = 30000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, onWait = () => {}, shouldStop = () => false } = {}) {
  let last = -Infinity;
  const stopCheck = () => { if (shouldStop()) throw Object.assign(new Error('Stopped'), { weftStopped: true }); };
  return async function paced(fn) {
    for (let attempt = 0; ; attempt++) {
      stopCheck();
      const wait = last + intervalMs - now();
      if (wait > 0) { onWait(wait, 'pace'); await sleep(wait); stopCheck(); }
      last = now();
      try { return await fn(); } catch (e) {
        if (!RATE_LIMIT.test(String(e && e.message || e)) || attempt >= retries) throw e;
        const w = backoffMs * (attempt + 1);
        onWait(w, 'rate'); await sleep(w); stopCheck();
        last = now();
      }
    }
  };
}

// Hand edit of a scene record. Edited scenes are flagged so nothing regenerates over them.
export function applyEdit(scene, { summary, factsText, relationshipsText }) {
  const text = stripInvisible(summary).trim();
  if (!text) throw new Error('A scene needs a summary.');
  return { ...scene, summary: text, facts: parseFactLines(factsText), relationships: parseRelationshipLines(relationshipsText), edited: true, editedAt: Date.now() };
}
