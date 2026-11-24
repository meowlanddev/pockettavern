// Run: node --experimental-default-type=module tests/memory-system.test.mjs
import assert from 'node:assert/strict';
import { MEMORY_SYSTEMS, memorySystemOf, setMemorySystem } from '../js/memory-system.js';

const mk = (s = false, m = false, d = false, w = false) => ({ summarize: { enabled: s }, memory: { enabled: m }, database: { enabled: d }, weft: { enabled: w } });

assert.equal(memorySystemOf(mk()), 'off');
assert.equal(memorySystemOf(mk(false, false, true)), 'database');
assert.equal(memorySystemOf(mk(false, true)), 'summaryception');
assert.equal(memorySystemOf(mk(false, false, false, true)), 'weft');
assert.equal(memorySystemOf(mk(false, false, true, true)), 'database');
assert.equal(memorySystemOf(mk(true)), 'summarize');
// legacy inconsistent data (several on) resolves in a fixed, predictable order
assert.equal(memorySystemOf(mk(true, true, true)), 'summarize');
assert.equal(memorySystemOf(mk(false, true, true)), 'summaryception');
assert.equal(memorySystemOf({}), 'off');

for (const v of MEMORY_SYSTEMS) {
  const ext = mk(true, true, true, true);
  assert.equal(setMemorySystem(ext, v), true);
  assert.equal(memorySystemOf(ext), v);
  assert.equal([ext.summarize.enabled, ext.memory.enabled, ext.database.enabled, ext.weft.enabled].filter(Boolean).length, v === 'off' ? 0 : 1);
}
const ext = mk(false, true, false);
assert.equal(setMemorySystem(ext, 'loom'), false); // unknown/unavailable: nothing changes
assert.equal(memorySystemOf(ext), 'summaryception');
// older saved settings without a weft block still work
const old = { summarize: { enabled: false }, memory: { enabled: false }, database: { enabled: true } };
assert.equal(setMemorySystem(old, 'off'), true);
assert.equal(memorySystemOf(old), 'off');
console.log('memory-system tests passed');
