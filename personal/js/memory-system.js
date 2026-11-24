// One active memory system at a time. The legacy settings flags stay as they are
// (so saved settings keep working); this module just keeps them consistent.

export const MEMORY_SYSTEMS = ['off', 'summaryception', 'database', 'weft', 'summarize'];

// Which memory system the settings flags currently select.
export function memorySystemOf(ext) {
  if (ext?.summarize?.enabled) return 'summarize';
  if (ext?.memory?.enabled) return 'summaryception';
  if (ext?.database?.enabled) return 'database';
  if (ext?.weft?.enabled) return 'weft';
  return 'off';
}

// Select exactly one memory system, switching the others off. Returns false for unknown values.
export function setMemorySystem(ext, value) {
  if (!MEMORY_SYSTEMS.includes(value)) return false;
  ext.summarize.enabled = value === 'summarize';
  ext.memory.enabled = value === 'summaryception';
  ext.database.enabled = value === 'database';
  if (ext.weft) ext.weft.enabled = value === 'weft';
  return true;
}
