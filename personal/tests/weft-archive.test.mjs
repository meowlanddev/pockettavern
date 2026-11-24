// Run: node --experimental-default-type=module tests/weft-archive.test.mjs
import assert from 'node:assert/strict';
import * as A from '../js/weft-archive.js';

const F = (name, durability, text) => ({ name, durability, text });
const scene = (from, to, facts, relationships = []) => ({ id: `s${from}-${to}`, from, to, facts, relationships });
const scenes = [
  scene(1, 40, [F('JD', 'durable', 'lives in Scioto Lofts unit 1104'), F('Jordan "J.D." Daniels', 'durable', '39-year-old goalie for the Titans'),
    F('JD', 'temporary', 'bruised right ribs from a slapshot in Ottawa'), F('Rachel (Rach4792)', 'durable', 'drives a red Honda Civic'),
    F('JD & Rachel', 'temporary', 'met in person for the first time'), F('Marcus (Titans security)', 'durable', 'handles team security')],
  [{ who: 'JD & Rachel', text: 'first night together' }]),
  scene(41, 80, [F('J.D. Daniels', 'durable', 'lives in Scioto Lofts unit 1104, eleventh floor'), F('JD', 'temporary', 'cracked ninth rib from Ottawa'),
    F('Rachel', 'durable', 'drives a red Honda Civic'), F('Marcus Carter', 'durable', 'former Columbus homicide detective'), F('Daniels', 'temporary', 'ambiguous bare surname'),
    F('Tyler Daniels', 'durable', 'eight years old')],
  [{ who: 'JD & Rachel', text: 'deepened after the threats' }, { who: 'JD & Marcus Carter', text: 'trust' }]),
];

// names
assert.deepEqual(A.nameTokens('Jordan "J.D." Daniels').sort(), ['daniels', 'jd', 'jordan']);
assert.deepEqual(A.nameTokens('Marcus (Titans security)'), ['marcus']);
assert.deepEqual(A.nameTokens('Rachel (Rach4792)'), ['rachel']);

const a = A.buildArchive(scenes, A.newReview());
const byName = n => a.entities.find(e => e.name === n || e.aliases.includes(n));
const jd = byName('JD') || byName('J.D. Daniels');
assert.ok(jd, 'JD entity');
assert.ok(jd.aliases.length >= 1);
assert.equal(a.entities.filter(e => /^(jd|j\.d\. daniels|jordan)/i.test(e.name)).length, 1); // all variants merged into one
assert.ok(byName('Marcus Carter').aliases.some(x => /Titans security/.test(x)));
const bare = a.entities.find(e => e.name === 'Daniels');
assert.ok(bare, 'ambiguous bare surname stays its own entity, not merged by guess');
// pair facts and relationships go to relationships, not fact lists
assert.ok(!jd.groups.some(g => /met in person/.test(g.text)));
const rel = jd.relationships.find(r => r.with === 'Rachel');
assert.equal(rel.items.length, 3);
// near-duplicate facts collapse and remember both scenes; different facts stay separate
const home = jd.groups.find(g => /Scioto/.test(g.text));
assert.deepEqual(home.scenes.map(s => s.from), [1, 41]);
assert.equal(jd.groups.filter(g => /rib/.test(g.text)).length, 2);
// the repeated durable fact is suggested for pinning
assert.ok(a.suggestions.some(s => /Scioto/.test(s.text)));

// keys are stable when a later scene is added
const key0 = home.key;
const more = A.buildArchive([...scenes, scene(81, 120, [F('JD', 'durable', 'has a crooked right pinky')])], A.newReview());
assert.ok(more.entities.flatMap(e => e.groups).some(g => g.key === key0));

// review overrides
const rv = A.newReview();
A.setFlag(rv, key0, { d: 'temporary', pin: 'yes' });
let b = A.buildArchive(scenes, rv);
let g = b.entities.flatMap(e => e.groups).find(x => x.key === key0);
assert.equal(g.durability, 'temporary'); assert.equal(g.pin, 'yes');
assert.ok(!b.suggestions.some(s => s.key === key0)); // pinned facts are no longer suggested
A.setFlag(rv, key0, { d: null, pin: null });
assert.deepEqual(rv.facts, {}); // clearing every flag removes the entry

// links: conflict, resolve, supersede, same
const ribs = jd.groups.filter(g2 => /rib/.test(g2.text));
const [r1, r2] = ribs.map(x => x.key);
const rv2 = A.newReview();
A.addLinks(rv2, [{ type: 'conflict', keys: [r1, r2], reason: 'bruised vs cracked' }]);
b = A.buildArchive(scenes, rv2);
assert.equal(b.conflicts.length, 1); assert.equal(b.conflicts[0].items.length, 2);
const id = b.conflicts[0].id;
A.addLinks(rv2, [{ type: 'conflict', keys: [r2, r1], reason: 'again' }]); // same pair is not added twice
assert.equal(rv2.links.length, 1);
A.resolveConflict(rv2, id, r2);
b = A.buildArchive(scenes, rv2);
assert.equal(b.conflicts.length, 0);
assert.equal(b.entities.flatMap(e => e.groups).find(x => x.key === r1).status, 'superseded');
assert.equal(b.entities.flatMap(e => e.groups).find(x => x.key === r2).status, 'current');
const rv3 = A.newReview();
A.addLinks(rv3, [{ type: 'superseded', keys: [r1, r2] }]);
b = A.buildArchive(scenes, rv3);
assert.equal(b.entities.flatMap(e => e.groups).find(x => x.key === r1).supersededBy, r2);
const rv4 = A.newReview();
A.addLinks(rv4, [{ type: 'same', keys: [r1, r2] }]);
b = A.buildArchive(scenes, rv4);
assert.equal(b.entities.find(e => e.id === jd.id).groups.filter(x => /rib/.test(x.text)).length, 1); // merged into one
A.addLinks(rv4, [{ type: 'conflict', keys: [r1, r2] }]); A.dismissLink(rv4, rv4.links[1].id);
assert.equal(A.buildArchive(scenes, rv4).conflicts.length, 0);

// parse the model's number-only reply; anything out of range or malformed is ignored
const parsed = A.parseConsistency('SAME: 1, 3\nCONFLICT: 2, 4 | bruised vs cracked\nSUPERSEDED: 2 -> 5\nPIN: 1, 2, 3, 4, 5, 6, 7\nCONFLICT: 2, 99\nSAME: 1\nrandom prose', 5);
assert.deepEqual(parsed.map(p => p.type), ['same', 'conflict', 'superseded', 'pin']);
assert.equal(parsed[1].reason, 'bruised vs cracked');
assert.equal(parsed[3].idxs.length, 5); // 1-5 valid (6,7 are out of range)
assert.deepEqual(A.parseConsistency('NONE', 5), []);

// run with a mock model: only entities with 3+ facts are sent, and results are stored without altering any fact text
const big = [scene(1, 40, [1, 2, 3, 4].map(i => F('Rachel', 'durable', `fact number ${i} about rachel ${'x'.repeat(i)} unique${i}`)).concat([F('Sam', 'durable', 'only one fact')]))];
const arch = A.buildArchive(big, A.newReview());
assert.equal(A.checkable(arch).length, 1);
const prompts = [];
const review = A.newReview();
const res = await A.runConsistency({ archive: arch, askModel: async (sys, user) => { prompts.push(user); return 'CONFLICT: 1, 2 | differ\nPIN: 3'; }, onLinks: async links => { A.applyCheckResults(review, links); } });
assert.equal(res.calls, 1); assert.match(prompts[0], /Entity: Rachel/); assert.match(prompts[0], /\[4\]/);
assert.equal(review.links.length, 1); assert.equal(review.proposals.length, 1);
const after = A.buildArchive(big, review);
assert.equal(after.conflicts.length, 1);
assert.ok(after.suggestions.some(s => s.byModel));
assert.equal(after.entities.find(e => e.name === 'Rachel').groups.length, 4);
// stop request ends the run cleanly
const stopRes = await A.runConsistency({ archive: arch, askModel: async () => { throw Object.assign(new Error('Stopped'), { weftStopped: true }); } });
assert.equal(stopRes.calls, 0);
console.log('weft-archive tests passed');
