// Run: node --experimental-default-type=module tests/weft-prompt.test.mjs
// Checks that buildPrompt trims covered messages and inserts the WEFT block.
import assert from 'node:assert/strict';
import { buildPrompt } from '../js/prompt.js';

const settings = { prompt: {}, preset: { context_size: 100000, max_tokens: 500 }, ext: { memory: { enabled: false } } };
const history = Array.from({ length: 20 }, (_, i) => ({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', swipes: [`line number ${i}`], swipeIdx: 0 }));
const run = (weft) => buildPrompt({ char: { name: 'Rae' }, persona: { name: 'Jo' }, settings, chat: { vars: {} }, history, lorebooks: [], regexScripts: [], embeddedEntries: [], weft });
const texts = (r) => r.messages.map((m) => m.content).join('\n');

const base = run(null);
assert.ok(texts(base).includes('line number 0') && texts(base).includes('line number 19'));

const withBlock = run({ text: '[Story memory: test block]', trimTo: 12, position: 'chat', depth: 2, role: 'system' });
const t = texts(withBlock);
assert.ok(!t.includes('line number 0') && !t.includes('line number 11'), 'covered messages leave the prompt');
assert.ok(t.includes('line number 12') && t.includes('line number 19'), 'the tail stays word-for-word');
const at = withBlock.messages.findIndex((m) => m.content.includes('test block'));
assert.ok(at > 0 && at < withBlock.messages.length - 1, 'block sits inside the chat, not at the end');
assert.equal(withBlock.messages.length - 1 - at, 2, 'two messages come after it (depth 2)');

// no trimming asked for: full history plus the block
const noTrim = run({ text: '[Story memory: test block]', trimTo: 0, position: 'before', depth: 0, role: 'system' });
assert.ok(texts(noTrim).includes('line number 0') && texts(noTrim).includes('test block'));
assert.ok(noTrim.messages[0].content.includes('test block'), 'before = first in the prompt');

// empty text but covered scenes still trims (nothing relevant to say, but the tail is all the chat needed)
const emptyBlock = run({ text: '', trimTo: 15, position: 'chat', depth: 0, role: 'system' });
assert.ok(!texts(emptyBlock).includes('line number 3\n') && texts(emptyBlock).includes('line number 15'));
console.log('weft-prompt tests passed');
