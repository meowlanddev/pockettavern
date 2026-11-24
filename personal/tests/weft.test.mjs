// Run: node --experimental-default-type=module tests/weft.test.mjs
import assert from 'node:assert/strict';
import * as W from '../js/weft.js';

// ~100-token messages (350 chars) so token math is easy: each message ≈ 104 est. tokens.
const body = n => `m${n} ` + 'x'.repeat(350 - String(n).length - 2);
const mk = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: body(i + 1) }));
const speaker = m => (m.role === 'user' ? 'Rachel' : 'JD');
const opts = { minSceneTokens: 1000, maxSceneTokens: 3000, boundaryPrompt: 'b', scenePrompt: 's' };
const sceneReply = n => `SUMMARY: Scene text ${n}.\nNAMES: Rachel, JD\nFACTS:\n- Rachel | temporary | sprained her left ankle\n- J.D. | durable | lives in Scioto Lofts #1104\nRELATIONSHIPS:\n- Rachel & J.D. | she told him about her father`;

// --- parsers
assert.deepEqual(W.parseBoundaries('[12, 40]', 0, 100), [12, 40]);
assert.deepEqual(W.parseBoundaries('Sure! Here: [40,12,12, 500, 0]', 0, 100), [12, 40]);
assert.deepEqual(W.parseBoundaries('no idea', 0, 100), []);
assert.deepEqual(W.parseBoundaries('[1, 5]', 1, 100), [5]); // never the first message
const p = W.parseSceneOutput(sceneReply(1));
assert.equal(p.summary, 'Scene text 1.');
assert.deepEqual(p.names, ['Rachel', 'JD']);
assert.deepEqual(p.facts, [
  { name: 'Rachel', durability: 'temporary', text: 'sprained her left ankle' },
  { name: 'J.D.', durability: 'durable', text: 'lives in Scioto Lofts #1104' }]);
assert.deepEqual(p.relationships, [{ who: 'Rachel & J.D.', text: 'she told him about her father' }]);
// old format (CHANGED, no pipes) and "none" still parse
const old = W.parseSceneOutput('SUMMARY: Hi.\nNAMES: A\nCHANGED:\n- A broke a window\n- none');
assert.deepEqual(old.facts, [{ name: '', durability: 'unknown', text: 'A broke a window' }]);
assert.deepEqual(W.parseSceneOutput('SUMMARY: x\nFACTS:\n- none\nRELATIONSHIPS:\n- none').facts, []);
// a fact that itself contains a pipe keeps its text; bad durability becomes unknown
assert.deepEqual(W.parseFactLines('- Mara | maybe | a | b'), [{ name: 'Mara', durability: 'unknown', text: 'a | b' }]);
// edit + format round trip
assert.deepEqual(W.parseFactLines(W.formatFactLines(p.facts)), p.facts);
assert.deepEqual(W.parseRelationshipLines(W.formatRelationshipLines(p.relationships)), p.relationships);
const sc0 = W.makeScene(mk(4), 1, 4, p);
const ed = W.applyEdit(sc0, { summary: ' Fixed text. ', factsText: 'Rachel | temporary | ankle is sprained, not broken', relationshipsText: '' });
assert.equal(ed.summary, 'Fixed text.'); assert.equal(ed.edited, true); assert.equal(ed.facts[0].text, 'ankle is sprained, not broken');
assert.equal(ed.fingerprint, sc0.fingerprint); // editing the record does not count as the messages changing
assert.throws(() => W.applyEdit(sc0, { summary: '  ', factsText: '', relationshipsText: '' }), /needs a summary/);
assert.equal(W.parseSceneOutput('rambling without the format'), null);

// --- guardrails
const msgs = mk(60); // ~6.2k tokens total... actually ~104*60
const ask = list => async () => JSON.stringify(list);
// model proposes a too-early cut (#3 -> ~200 tokens) and a valid one (#15 -> ~1456 tokens): early one ignored
let cut = await W.findSceneEnd({ messages: msgs, start: 0, minTokens: 1000, maxTokens: 3000, speaker, askBoundary: ask([3, 15]) });
assert.equal(cut.end, 14); assert.equal(cut.forced, false);
// model never finds a boundary: force cut at max (3000 tokens ≈ 28 messages)
cut = await W.findSceneEnd({ messages: msgs, start: 0, minTokens: 1000, maxTokens: 3000, speaker, askBoundary: ask([]) });
assert.equal(cut.forced, true); assert.ok(cut.end >= 27 && cut.end <= 29, `forced end ${cut.end}`);
// over-splitting model: proposes many breaks; we take the valid one nearest the target size, not the first
cut = await W.findSceneEnd({ messages: msgs, start: 0, minTokens: 1000, maxTokens: 3000, targetTokens: 2000, speaker, askBoundary: ask([3, 8, 20, 26]) });
assert.equal(cut.end, 19); // #20 -> ~1976 tokens, closest to 2000; #3/#8 are under the minimum, #26 is further from target
// garbled reply behaves like "no boundary"
cut = await W.findSceneEnd({ messages: msgs, start: 0, minTokens: 1000, maxTokens: 3000, speaker, askBoundary: async () => 'lol idk' });
assert.equal(cut.forced, true);
// a thrown model error propagates (so a backfill stops instead of cutting everything by size)
await assert.rejects(() => W.findSceneEnd({ messages: msgs, start: 0, minTokens: 1000, maxTokens: 3000, speaker, askBoundary: async () => { throw new Error('net'); } }), /net/);
// not enough material yet: scene stays open, model not even asked
let asked = 0;
cut = await W.findSceneEnd({ messages: mk(5), start: 0, minTokens: 1000, maxTokens: 3000, speaker, askBoundary: async () => { asked++; return '[]'; } });
assert.equal(cut, null); assert.equal(asked, 0);
// whole remaining chat fits and no boundary: open, unless flushed
cut = await W.findSceneEnd({ messages: mk(15), start: 0, minTokens: 1000, maxTokens: 3000, speaker, askBoundary: ask([]) });
assert.equal(cut, null);
cut = await W.findSceneEnd({ messages: mk(15), start: 0, minTokens: 1000, maxTokens: 3000, speaker, askBoundary: ask([]), flush: true });
assert.equal(cut.end, 15);

// --- backfill, resume, stale detection
const all = mk(80);
const boundary = async text => { // model: new scene every time it sees message #21 or #51
  const nums = [...text.matchAll(/\[#(\d+)\]/g)].map(m => +m[1]);
  return JSON.stringify([21, 51].filter(n => nums.includes(n)));
};
let calls = 0;
const summarize = async () => { calls++; return sceneReply(calls); };
const base = { messages: all, opts, speaker, askBoundary: boundary, summarize };
const full = await W.runBackfill({ ...base, scenes: [] });
assert.ok(full.scenes.length >= 3);
for (let i = 1; i < full.scenes.length; i++) assert.equal(full.scenes[i].from, full.scenes[i - 1].to + 1); // contiguous, no gaps/overlaps
assert.equal(full.scenes[0].to, 20); assert.equal(full.scenes[1].to, 48); // #51 is beyond the max-size window, so scene 2 is force-cut
// stop after one scene, then resume: same scene boundaries as an uninterrupted run
let n = 0;
const part = await W.runBackfill({ ...base, scenes: [], shouldStop: () => n >= 1, onScene: () => { n++; } });
assert.equal(part.scenes.length, 1);
const resumed = await W.runBackfill({ ...base, scenes: part.scenes });
assert.deepEqual(resumed.scenes.map(s => [s.from, s.to]), full.scenes.map(s => [s.from, s.to]));
// existing scenes are never rewritten
assert.equal(resumed.scenes[0], part.scenes[0]);
// stale detection
assert.deepEqual(W.staleScenes(all, full.scenes), []);
const edited = structuredClone(all); edited[5].text = 'changed';
assert.deepEqual(W.staleScenes(edited, full.scenes), [full.scenes[0].id]);
assert.deepEqual(W.staleScenes(all.slice(0, 30), full.scenes).length > 0, true);
// unusable summary twice -> clear error, nothing partial saved
await assert.rejects(() => W.runBackfill({ ...base, scenes: [], summarize: async () => 'nope' }), /usable scene record/);

// --- pacer: spacing, rate-limit retry, stop
{
  let t = 0; const sleeps = []; const waits = [];
  const sleep = async ms => { sleeps.push(ms); t += ms; };
  const paced = W.makePacer({ intervalMs: 20000, backoffMs: 30000, sleep, now: () => t, onWait: (ms, why) => waits.push(why) });
  await paced(async () => 'a'); await paced(async () => 'b');
  assert.deepEqual(sleeps, [20000]);               // second call waits the full interval; first does not
  t += 5000; sleeps.length = 0; await paced(async () => 'c'); assert.deepEqual(sleeps, [15000]); // only the remainder
  let tries = 0; sleeps.length = 0;
  const v = await paced(async () => { if (++tries < 3) throw new Error('HTTP 429 Too Many Requests'); return 'ok'; });
  assert.equal(v, 'ok'); assert.equal(tries, 3); assert.ok(waits.includes('rate'));
  assert.ok(sleeps.includes(30000) && sleeps.includes(60000)); // growing backoff
  await assert.rejects(() => paced(async () => { throw new Error('HTTP 500 server error'); }), /500/); // not retried
  await assert.rejects(() => paced(async () => { throw new Error('429'); }), /429/); // gives up after the retry limit
  let stop = false;
  const paced2 = W.makePacer({ intervalMs: 20000, sleep: async () => { stop = true; }, now: () => 0, shouldStop: () => stop });
  await paced2(async () => 1);
  await assert.rejects(() => paced2(async () => 2), e => e.weftStopped === true);
  // a Stop pressed during a wait ends the backfill cleanly, keeping finished scenes
  let t2 = 0, stop2 = false;
  const p3 = W.makePacer({ intervalMs: 20000, sleep: async ms => { t2 += ms; stop2 = true; }, now: () => t2, shouldStop: () => stop2 });
  const r = await W.runBackfill({ messages: mk(80), scenes: [], opts, speaker, askBoundary: t => p3(() => boundary(t)), summarize: i => p3(() => summarize(i)), shouldStop: () => stop2 });
  assert.ok(r.scenes.length <= 1);
}

// --- estimate
const est = W.estimateBackfill(all, 0, { ...opts, callIntervalSec: 21 });
assert.equal(est.minutes, Math.ceil(est.calls * 21 / 60));
assert.ok(est.scenes >= 1 && est.calls === est.scenes * 2 && est.inputTokens > est.tokens);
assert.equal(W.estimateBackfill(mk(3), 0, opts).scenes, 0);
console.log('weft tests passed');
