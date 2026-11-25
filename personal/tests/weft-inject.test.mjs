// Run: node --experimental-default-type=module tests/weft-inject.test.mjs
import assert from 'node:assert/strict';
import { buildArchive, newReview, setFlag } from '../js/weft-archive.js';
import { rangeFingerprint } from '../js/weft.js';
import { storyScenes, storyBudgetFor, dominantTheme, matchThemes, budgetFor, usableScenes, mentioned, matchScenes, properWords, pinLines, pinTokens, buildInjection, DEFAULT_INJECT } from '../js/weft-inject.js';

const bi = (a) => buildInjection({ ...a, cfg: { injectState: false, injectStory: false, ...(a.cfg || {}) } }); // state card and story have their own tests below
const msg = (role, text) => ({ role, swipes: [text], swipeIdx: 0 });
const filler = 'The afternoon went on quietly while they talked about nothing in particular. ';

// budget grows with the chat and is clamped
assert.equal(budgetFor(0), 1500);
assert.equal(budgetFor(100000), 1500);
assert.equal(budgetFor(340000), 2700);
assert.equal(budgetFor(5000000), 4000);
assert.equal(budgetFor(340000, { injectMin: 1500, injectMax: 2000 }), 2000);

// properWords: capitalised words that never appear lower-case
const pw = properWords('Marek said the truck was ready. Then the Tuscarawas deputy came, and the door shut. Door.');
assert.ok(pw.has('marek') && pw.has('tuscarawas'));
assert.ok(!pw.has('door') && !pw.has('then'));

// --- a 6-scene chat of 60 messages (10 per scene)
const messages = [];
for (let i = 0; i < 60; i++) messages.push(msg(i % 2 ? 'assistant' : 'user', `Message ${i + 1}. ${filler.repeat(3)}`));
const mkScene = (n, over = {}) => {
  const from = (n - 1) * 10 + 1, to = n * 10;
  return { id: `s${from}-${to}`, from, to, tokens: 500, fingerprint: rangeFingerprint(messages, from, to), summary: `Summary of scene ${n}.`,
    names: [], facts: [], relationships: [], continues: false, ...over };
};
const scenes = [
  mkScene(1, { summary: 'Rachel met Marek at the Akron glass shop and learned the truck was an F-150.', names: ['Rachel', 'Marek', 'Akron glass shop'],
    facts: [{ name: 'Marek', durability: 'durable', text: 'Marek runs a tow and glass shop in Akron' }, { name: 'Rachel', durability: 'durable', text: 'Rachel drives a Civic' }] }),
  mkScene(2, { names: ['Rachel'], facts: [{ name: 'Rachel', durability: 'temporary', text: 'Rachel has a grade-two ankle sprain' }, { name: 'Sam', durability: 'durable', text: 'Sam is a nurse at the clinic' }] }),
  mkScene(3, { names: ['Rachel'], facts: [{ name: 'Rachel', durability: 'durable', text: 'Rachel lives in unit 1104' }] }),
  mkScene(4, { names: ['Rachel', 'Sam'], facts: [{ name: 'Sam', durability: 'durable', text: 'Sam grew up in Tuscarawas County' }] }),
  mkScene(5, { names: ['Rachel'], facts: [{ name: 'Rachel', durability: 'temporary', text: 'Rachel wears a brace on the left ankle' }] }),
  mkScene(6, { names: ['Rachel'], facts: [] }),
];
const review = newReview();
const archive = () => buildArchive(scenes, review);

// scenes stay usable until a message inside one is edited
assert.equal(usableScenes(messages, scenes).length, 6);
const edited = messages.map((m, i) => (i === 25 ? msg('assistant', 'changed') : m));
assert.equal(usableScenes(edited, scenes).length, 2); // scene 3 (messages 21-30) no longer matches; later ones are dropped too
assert.equal(usableScenes(messages.slice(0, 35), scenes).length, 3);

// nothing built: no block
assert.equal(bi({ messages, scenes: [], archive: archive() }).text, '');

// ordinary reply: nobody named -> no entries, no pins, nothing injected
const quiet = bi({ messages, scenes, archive: archive() });
assert.equal(quiet.text, '');
assert.equal(quiet.covered, 60);

// pins are always sent, even when nobody is named
const a0 = archive();
const marekFact = a0.entities.flatMap((e) => e.groups).find((g) => /Akron/.test(g.text));
setFlag(review, marekFact.key, { pin: 'yes' });
const pinned = bi({ messages, scenes, archive: archive() });
assert.match(pinned.text, /Always true:\n- Marek: Marek runs a tow and glass shop in Akron/);
assert.equal(pinned.items.length, 1);
assert.equal(pinned.items[0].kind, 'pin');
assert.equal(pinTokens(archive().entities), pinned.pins);
assert.match(pinned.text, /not instructions/);

// hidden / deleted / superseded facts are never sent, even if pinned
setFlag(review, marekFact.key, { hide: true });
assert.equal(pinLines(archive().entities).length, 0);
setFlag(review, marekFact.key, { hide: false });
assert.equal(pinLines(archive().entities).length, 1);

// named in the last messages -> that entry is added, with its reason
const named = messages.slice();
named[58] = msg('user', 'Sam walked over to check the brace.');
const withSam = bi({ messages: named, scenes, archive: archive() });
assert.match(withSam.text, /Who and what is in play:\nSam: /);
assert.match(withSam.text, /Sam is a nurse at the clinic/);
assert.ok(withSam.items.some((i) => i.kind === 'entry' && i.label === 'Sam' && /named/.test(i.reason)));
assert.ok(!/Rachel:/.test(withSam.text.split('Who and what is in play:')[1] || ''));

// main character (in most scenes): only facts that match the recent text, not everything
const rach = named.slice();
rach[59] = msg('assistant', 'Rachel shifted her weight off the sprained left ankle in the brace.');
const withRachel = bi({ messages: rach, scenes, archive: archive() });
assert.match(withRachel.text, /Rachel: .*ankle/);
assert.ok(!/unit 1104/.test(withRachel.text)); // no overlap with the recent text: stays out
const plain = named.slice();
plain[59] = msg('assistant', 'Rachel laughed quietly.');
const rOnly = bi({ messages: plain, scenes, archive: archive() });
assert.ok(!rOnly.items.some((i) => i.label === 'Rachel'));
assert.ok(rOnly.skipped.some((s) => s.label === 'Rachel'));

// past scenes: only when the recent messages name several of its names (or one found in just that scene)
const hit = messages.slice();
hit[59] = msg('assistant', 'Marek called from the Akron glass shop about the truck.');
const small = { injectRecentTokens: 200 }; // keep only the last few messages word-for-word
const hitRes = bi({ messages: hit, scenes, archive: archive(), cfg: small });
assert.ok(hitRes.items.some((i) => i.kind === 'scene' && i.label === 'Scene 1-10'));
assert.match(hitRes.text, /Earlier scenes that connect to this moment:\n- \(messages 1-10\) Rachel met Marek/);
// a scene that is still word-for-word in the prompt is not repeated
const near = bi({ messages: hit, scenes, archive: archive(), cfg: { injectRecentTokens: 100000 } });
assert.ok(!near.items.some((i) => i.kind === 'scene'));
assert.equal(near.verbatimFrom, 0);
// matching a name every scene has (Rachel) never recalls a scene
const everywhere = messages.slice();
everywhere[59] = msg('assistant', 'Rachel Rachel Rachel.');
assert.ok(!bi({ messages: everywhere, scenes, archive: archive(), cfg: small }).items.some((i) => i.kind === 'scene'));

// matchScenes with too few scenes never fires
assert.deepEqual(matchScenes(scenes.slice(0, 2), 'Marek Akron', { max: 2, skipFrom: null }), []);

// budget: scenes drop first, then entries; pins stay
const longScenes = scenes.map((sc, i) => (i === 0 ? { ...sc, summary: sc.summary + ' ' + 'More detail about what happened. '.repeat(60) } : sc));
const tight = bi({ messages: hit, scenes: longScenes, archive: buildArchive(longScenes, review), cfg: { ...small, injectMin: 300, injectMax: 300 } });
assert.ok(tight.skipped.some((s) => s.reason === 'over budget'));
assert.ok(tight.items.some((i) => i.kind === 'pin'));
assert.ok(!tight.items.some((i) => i.kind === 'scene'));

// only scenes up to the last one that still matches the chat are used; the tail stays in the chat
const tailEdited = messages.map((m, i) => (i === 55 ? msg('assistant', 'edited later') : m));
assert.equal(bi({ messages: tailEdited, scenes, archive: archive() }).covered, 50);
// --- where things stand: temporary facts from the newest two scenes, once, with their own heading
const st = buildInjection({ messages, scenes, archive: archive() });
assert.match(st.text, /Where things stood at the end of the last recorded scene \(messages 51-60\):\n- Rachel: Rachel wears a brace on the left ankle/);
assert.ok(!/grade-two/.test(st.text)); // scene 2 is old news
assert.ok(!/unit 1104/.test(st.text)); // durable facts are not status notes
assert.ok(st.items.some((i) => i.kind === 'state'));
// the same fact is not repeated under the person's entry
const st2 = buildInjection({ messages: rach, scenes, archive: archive() });
assert.equal(st2.text.split('brace on the left ankle').length - 1, 1);
// can be switched off
assert.ok(!buildInjection({ messages, scenes, archive: archive(), cfg: { injectState: false } }).items.some((i) => i.kind === 'state'));
// relationship notes: two main characters always, first note in full, later ones shortened, newest kept
{
  const rel = (n, text) => ({ who: 'Rachel & Sam', text });
  const rs = scenes.map((sc, i) => ({ ...sc, names: [...sc.names, 'Sam'], facts: [], relationships: [rel(i, i === 0 ? 'became lovers on the first night' : 'note ' + i + ' ' + 'x '.repeat(150))] }));
  const ra = buildArchive(rs, newReview());
  const r = buildInjection({ messages, scenes: rs, archive: ra, cfg: { injectState: false, injectMainShare: 0.5 } });
  assert.match(r.text, /How people stand with each other/);
  assert.match(r.text, /\(messages 1-10\) became lovers on the first night/);
  assert.match(r.text, /\(messages 51-60\) note 5/); // newest kept
  assert.ok(!/\(messages 11-20\)/.test(r.text)); // middle ones dropped (4 max)
  assert.ok(/…/.test(r.text)); // shortened
  assert.ok(r.items.some((i) => i.kind === 'relation'));
  assert.ok(!buildInjection({ messages, scenes: rs, archive: ra, cfg: { injectState: false, injectMainShare: 0.5, injectRelations: 0 } }).items.some((i) => i.kind === 'relation'));
}
// topic recall: same people in every scene, so recall by what the moment is about
{
  const lover = 'They kissed, undressed, and had sex in bed; sexual and intimate, naked skin, her mouth on his shoulder.';
  const ts = scenes.map((sc, i) => ({ ...sc, summary: i === 1 ? lover + ' ' + lover : i === 3 ? lover : 'They talked about the schedule.' }));
  const tq = 'He kissed her mouth and unbuttoned her shirt; her hips against his, naked skin, the bed, sex, lovers, intimate, desire, thighs.';
  assert.equal(dominantTheme(tq).theme, 'intimacy');
  assert.equal(dominantTheme('They talked about the schedule and the weather for a while.'), null);
  assert.deepEqual(matchThemes(ts, tq, { max: 2, skipFrom: null }).map((x) => x.scene.from).sort((a, b) => a - b), [11, 31]);
  const tm = messages.slice(); tm[59] = msg('user', tq);
  const r = buildInjection({ messages: tm, scenes: ts, archive: buildArchive(ts, newReview()), cfg: { injectState: false, injectRecentTokens: 200 } });
  assert.ok(r.items.some((i) => i.kind === 'scene' && i.label === 'Scene 11-20' && /intimate moments/.test(i.reason)));
  assert.ok(!buildInjection({ messages: tm, scenes: ts, archive: buildArchive(ts, newReview()), cfg: { injectState: false, injectRecentTokens: 200, injectByTopic: false } }).items.some((i) => i.kind === 'scene'));
}
// story so far: scenes the people in play share, all of them, in order
{
  const ss = scenes.map((sc, i) => ({ ...sc, summary: `Scene ${i + 1}: ` + 'Rachel and Sam spent time together. '.repeat(3), names: ['Rachel', 'Sam'], facts: [{ name: 'Rachel', durability: 'durable', text: 'Rachel fact ' + i }, { name: 'Sam', durability: 'durable', text: 'Sam fact ' + i }],
    relationships: [{ who: 'Rachel & Sam', text: 'rel ' + i }] }));
  const sm = messages.slice(); sm[59] = msg('user', 'Sam looked at Rachel.');
  const r = buildInjection({ messages: sm, scenes: ss, archive: buildArchive(ss, newReview()), cfg: { injectState: false, injectRecentTokens: 200 } });
  assert.match(r.text, /The story so far, in order \(the scenes Rachel and Sam share\):/);
  const order = [...r.text.matchAll(/- \(messages (\d+)-/g)].map((m) => +m[1]);
  assert.deepEqual(order, [1, 11, 21, 31, 41]); // scene 6 (51-60) is still in the chat window; the rest all appear, oldest first
  assert.ok(!/rel 0/.test(r.text), 'relationship notes are skipped when the full scenes are already there');
  const it = r.items.find((x) => x.kind === 'story');
  assert.ok(it && it.tokens > 0);
  // a tight budget shortens older scenes but keeps the newest whole and the first one
  const big = ss.map((sc) => ({ ...sc, summary: sc.summary + ' More about what happened. '.repeat(80) }));
  const sc2 = storyScenes(buildArchive(big, newReview()).entities, big, new Set(buildArchive(big, newReview()).entities.map((e) => e.id)), { budget: 1500, skipFrom: null });
  assert.ok(sc2.items.length >= 2 && sc2.items[0].scene.from === 1 && sc2.items.at(-1).short === false && sc2.items.some((x) => x.short));
  assert.equal(sc2.complete, false);
  // off
  assert.ok(!buildInjection({ messages: sm, scenes: ss, archive: buildArchive(ss, newReview()), cfg: { injectState: false, injectStory: false, injectRecentTokens: 200 } }).items.some((x) => x.kind === 'story'));
  assert.equal(storyBudgetFor(0), 2000);
  assert.equal(storyBudgetFor(340000), 5580);
  assert.equal(storyBudgetFor(5000000), 6000);
}
assert.deepEqual(Object.keys(DEFAULT_INJECT).filter((k) => !k.startsWith('inject')), []);
console.log('weft-inject tests passed');
