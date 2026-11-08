// Run: node --experimental-default-type=module tests/narrative-db.test.mjs
import assert from 'node:assert/strict';
import * as DB from '../js/narrative-db.js';

const msgs = Array.from({ length: 80 }, (_, i) => ({
  id: `msg-${i}`, role: i % 2 ? 'assistant' : 'user',
  swipes: [`The scene continued ${i}. ` + 'word '.repeat(300)], swipeIdx: 0,
}));
const original = JSON.stringify(msgs);
let cursor = 0, passes = 0, prior = '';
while (true) {
  const batch = DB.nextBatch(msgs, cursor, 15000, true);
  if (!batch) break;
  assert(batch.end > cursor);
  const input = DB.buildUpdateInput(prior, batch, m => m.role);
  assert(input.includes('<previous_database>'));
  assert(input.includes('<new_roleplay_messages>'));
  assert(input.includes(`scene continued ${cursor}`));
  const text = `# NARRATIVE\n## ACTIVE THEATRE\n## ENTITY DOSSIERS\n## THE WEB\n## WORLD MECHANICS\n## THE LEDGER\n### Unresolved Threads\n### Active Tasks\n## THE CHRONICLE\n### Historical Record\n${passes}\n### Recent Log\n${batch.end}`;
  prior = DB.checkedDatabase(text);
  cursor = batch.end; passes++;
}
assert.equal(cursor, msgs.length, 'all messages covered exactly once');
assert(passes > 1, 'processed sequential batches');
assert.equal(JSON.stringify(msgs), original, 'source messages never modified');
const state = { covered: cursor, signature: DB.fingerprint(msgs, cursor) };
assert.equal(DB.isStale(msgs, state), false);
msgs[2].swipes[0] = 'edited past message';
assert.equal(DB.isStale(msgs, state), true);
assert.equal(DB.nextBatch(msgs, msgs.length, 15000, true), null);
assert.equal(DB.nextBatch(msgs, 0, 10000000, false), null, 'automatic waits below threshold');
assert(DB.DEFAULT_DATABASE_PROMPT.includes('### Recent Log'));
assert.throws(() => DB.checkedDatabase('A summary with no required sections'));
console.log(`PASS: ${passes} sequential batches, no source mutations, edit detection, schema checks`);

const mk = (dossiers, tasks, history = '') => DB.checkedDatabase(
  '# NARRATIVE\n## ACTIVE THEATRE\n## ENTITY DOSSIERS\n' + dossiers +
  '\n## THE WEB\n## WORLD MECHANICS\n## THE LEDGER\n### Unresolved Threads\n' +
  '### Active Tasks\n' + tasks + '\n## THE CHRONICLE\n### Historical Record\n' + history
);
const before = mk('**Jason Todd**\n- **Developments:** Knows the secret.\n**Catrin**\n- **Open:** Waiting.',
  '- Retrieve Leesie tomorrow.\n', '- **Erased timeline:** Leviathan deaths confirmed.\n');
const lost = mk('**Catrin**\n- **Open:** Waiting.', '- Retrieve Leesie later.\n', 'A new scene.\n');
const flags = DB.continuityWarnings(before, lost);
assert(flags.some(x => x.includes('Jason Todd')), 'missing dossier character is flagged');
assert(flags.some(x => x.includes('tomorrow')), 'drifting deadline is flagged');
assert(flags.some(x => x.includes('Erased timeline')), 'missing timeline branch is flagged');
assert.deepEqual(DB.continuityWarnings(before, before), [], 'unchanged facts pass');
const consolidated = mk('**Catrin**\n- **Open:** Waiting.', '- Retrieve Leesie tomorrow.\n',
  'Jason Todd knows the secret.\n- **Erased timeline:** Leviathan deaths confirmed.\n');
assert.deepEqual(DB.continuityWarnings(before, consolidated), [], 'moving a character fact to Chronicle is allowed');
assert.throws(() => DB.checkedDatabase('# NARRATIVE\n## ACTIVE THEATRE\n## ENTITY DOSSIERS'), /missing required sections/);
console.log('PASS: continuity checks for character loss, deadlines, timeline branches, and legitimate consolidation');
