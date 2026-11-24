// Run: node --experimental-default-type=module tests/memory-system.test.mjs
import assert from 'node:assert/strict';
import { MEMORY_SYSTEMS, memorySystemOf, setMemorySystem } from '../js/memory-system.js';

const mk = (s = false, m = false, d = false) => ({ summarize: { enabled: s }, memory: { enabled: m }, database: { enabled: d } });

assert.equal(memorySystemOf(mk()), 'off');
assert.equal(memorySystemOf(mk(false, false, true)), 'database');
assert.equal(memorySystemOf(mk(false, true)), 'summaryception');
assert.equal(memorySystemOf(mk(true)), 'summarize');
// legacy inconsistent data (several on) resolves in a fixed, predictable order
assert.equal(memorySystemOf(mk(true, true, true)), 'summarize');
assert.equal(memorySystemOf(mk(false, true, true)), 'summaryception');
assert.equal(memorySystemOf({}), 'off');

for (const v of MEMORY_SYSTEMS) {
  const ext = mk(true, true, true);
  assert.equal(setMemorySystem(ext, v), true);
  assert.equal(memorySystemOf(ext), v);
  assert.equal([ext.summarize.enabled, ext.memory.enabled, ext.database.enabled].filter(Boolean).length, v === 'off' ? 0 : 1);
}
const ext = mk(false, true, false);
assert.equal(setMemorySystem(ext, 'loom'), false); // unknown/unavailable: nothing changes
assert.equal(memorySystemOf(ext), 'summaryception');
console.log('memory-system tests passed');
