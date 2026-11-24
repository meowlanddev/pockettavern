// Run: node --experimental-default-type=module tests/memory-status.test.mjs
import assert from 'node:assert/strict';
import { probeFor, inPrompt, memoryStatus } from '../js/memory-status.js';

const dbText = '# NARRATIVE\n\n## ACTIVE THEATRE\n\n**Current Context:** Dec 21 night, J.D.\'s condo #1104.\n\n## THE LEDGER\nSomething else here.';
const sent = [{ role: 'system', content: `<narrative_database>\n${dbText}\n</narrative_database>` }, { role: 'user', content: 'hi' }];
const base = { messages: [{ role: 'user' }, { role: 'assistant' }], narrativeDb: { text: dbText, covered: 1 } };

// probe skips macro lines and markdown markers
assert.equal(probeFor('{{user}} does a thing here\n## Real heading line here'), 'Real heading line here');
assert.equal(probeFor('short\n\n'), '');
assert.equal(inPrompt(sent, dbText), true);
assert.equal(inPrompt([{ role: 'user', content: 'nothing' }], dbText), false);
assert.equal(inPrompt(sent, '{{x}}'), null);
// whitespace differences do not matter
assert.equal(inPrompt([{ role: 'system', content: dbText.replace(/\n/g, '   ') }], dbText), true);
// non-string content (e.g. multimodal arrays) is ignored, not a crash
assert.equal(inPrompt([{ role: 'user', content: [{ type: 'image' }] }], dbText), false);

// 1. DB off in settings, chat not manual-only: flagged as NOT sent
let rows = memoryStatus({ chat: { ...base }, dbEnabled: false, messages: [] });
assert.equal(rows.length, 1);
assert.equal(rows[0].ok, false);
assert.match(rows[0].detail, /NOT sent.*off in settings/);

// 2. Manual-only works even with the global setting off, and is reported as sent when present
rows = memoryStatus({ chat: { ...base, narrativeDbManualOnly: true }, dbEnabled: false, messages: sent });
assert.equal(rows[0].ok, true);
assert.match(rows[0].detail, /manual only/);
assert.match(rows[0].detail, /covers 1 of 2 messages/);

// 3. Stale and not manual-only: flagged
rows = memoryStatus({ chat: { ...base }, dbEnabled: true, messages: sent, stale: true });
assert.equal(rows[0].ok, false);
assert.match(rows[0].detail, /history changed/);

// 4. Stale but manual-only: still checked against the prompt
rows = memoryStatus({ chat: { ...base, narrativeDbManualOnly: true }, dbEnabled: true, messages: sent, stale: true });
assert.equal(rows[0].ok, true);

// 5. Expected but missing from the assembled prompt
rows = memoryStatus({ chat: { ...base }, dbEnabled: true, messages: [{ role: 'user', content: 'x' }] });
assert.equal(rows[0].ok, false);
assert.match(rows[0].detail, /not found in the prompt/);

// 6. Enabled with nothing saved yet; no rows at all when disabled and nothing saved
rows = memoryStatus({ chat: { messages: [] }, dbEnabled: true, messages: [] });
assert.equal(rows[0].ok, null);
assert.deepEqual(memoryStatus({ chat: { messages: [] }, dbEnabled: false, messages: [] }), []);

// 7. Running summary and Author's Note are checked too
const chat = { ...base, narrativeDbManualOnly: true, summary: { text: 'The long running summary text lives here.' }, authorsNote: { text: 'CANON: Andrej Novak is Czech.' } };
rows = memoryStatus({ chat, dbEnabled: false, messages: sent });
assert.equal(rows.find((r) => r.name === 'Running summary').ok, false);
assert.match(rows.find((r) => r.name === 'Running summary').detail, /Macro/);
assert.equal(rows.find((r) => r.name === "Author's Note").ok, false);
rows = memoryStatus({ chat, dbEnabled: false, messages: [...sent, { role: 'system', content: 'CANON: Andrej Novak is Czech.' }, { role: 'system', content: '[Summary: The long running summary text lives here.]' }] });
assert.equal(rows.find((r) => r.name === "Author's Note").ok, true);
assert.equal(rows.find((r) => r.name === 'Running summary').ok, true);

console.log('memory-status tests passed');
