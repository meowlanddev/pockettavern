// Import a whole SillyTavern data folder from a .zip (characters, chats, group chats, personas,
// lorebooks, presets, regex, themes, quick replies). The zip is read entry-by-entry from the File,
// so large archives aren't loaded into memory at once.

const td = new TextDecoder();

async function bytes(file, start, end) {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

/** List the entries of a zip file. Supports stored/deflated entries and zip64. */
export async function openZip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = await bytes(file, file.size - tailLen, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file (or it is damaged)');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const locAt = eocd - 20;
    if (locAt >= 0 && tail.getUint32(locAt, true) === 0x07064b50) {
      const z64Off = Number(tail.getBigUint64(locAt + 8, true));
      const z = await bytes(file, z64Off, z64Off + 56);
      count = Number(z.getBigUint64(32, true));
      cdSize = Number(z.getBigUint64(40, true));
      cdOffset = Number(z.getBigUint64(48, true));
    }
  }
  const cd = await bytes(file, cdOffset, cdOffset + cdSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    const name = td.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // zip64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(cd.getBigUint64(q, true)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(cd.getBigUint64(q, true)); }
      }
      e += 4 + len;
    }
    if (!name.endsWith('/')) entries.push({ name: name.replace(/\\/g, '/'), method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readEntry(file, entry) {
  const lh = await bytes(file, entry.offset, entry.offset + 30);
  if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`Bad zip entry: ${entry.name}`);
  const start = entry.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const blob = file.slice(start, start + entry.compSize);
  if (entry.method === 0) return blob;
  if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip files (needs iOS 16.4+ or a recent Chrome).');
    return new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  }
  throw new Error(`Unsupported compression in ${entry.name}`);
}

export const readText = async (file, entry) => (await readEntry(file, entry)).text();
export const readJson = async (file, entry) => JSON.parse(await readText(file, entry));

const DIRS = ['characters', 'chats', 'groups', 'group chats', 'worlds', 'OpenAI Settings', 'themes', 'QuickReplies', 'User Avatars', 'instruct'];

/**
 * Sort zip entries into SillyTavern's folders, wherever the data folder sits inside the zip
 * (e.g. "default-user/characters/…" or "SillyTavern/data/default-user/characters/…").
 */
export function classify(entries) {
  const out = Object.fromEntries(DIRS.map((d) => [d, []]));
  out.settings = null;
  for (const e of entries) {
    const parts = e.name.split('/');
    if (parts.some((x) => x === '__MACOSX' || x.startsWith('._'))) continue;
    if (parts[parts.length - 1] === 'settings.json' && !out.settings && !parts.some((x) => DIRS.includes(x))) { out.settings = e; continue; }
    const i = parts.findIndex((x) => DIRS.includes(x));
    if (i < 0) continue;
    out[parts[i]].push({ ...e, rel: parts.slice(i + 1).join('/') });
  }
  return out;
}

export const baseName = (path) => path.split('/').pop().replace(/\.[^.]+$/, '');

function parseDate(v) {
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v || '').replace(/(\d)(am|pm)\b/i, '$1 $2'));
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * Convert a SillyTavern .jsonl chat into PocketTavern messages.
 * memberByName(name) → character id (group chats).
 */
export function parseStChat(text, { memberByName = null, uid } = {}) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let meta = {};
  const msgs = [];
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.mes === undefined) { if (r.chat_metadata || r.user_name) meta = r; continue; }
    if (r.name === 'SillyTavern System' || (r.extra && r.extra.isSmallSys)) continue;
    const narrator = r.extra && r.extra.type === 'narrator';
    const swipes = Array.isArray(r.swipes) && r.swipes.length ? r.swipes.map((x) => String(x ?? '')) : [String(r.mes)];
    let idx = Number.isInteger(r.swipe_id) ? r.swipe_id : swipes.indexOf(String(r.mes));
    if (idx < 0 || idx >= swipes.length) { swipes.push(String(r.mes)); idx = swipes.length - 1; }
    const role = narrator ? 'system' : r.is_user ? 'user' : 'assistant';
    const m = { id: uid(), role, swipes, swipeIdx: idx, ts: parseDate(r.send_date) };
    const reasoning = swipes.map((_, i) => (Array.isArray(r.swipe_info) && r.swipe_info[i] && r.swipe_info[i].extra && r.swipe_info[i].extra.reasoning) || '');
    if (r.extra && r.extra.reasoning) reasoning[idx] = r.extra.reasoning;
    if (reasoning.some(Boolean)) m.reasoning = reasoning;
    if (r.is_system && !narrator) m.hidden = true; // ST's /hide
    if (narrator) m.name = r.name || 'Narrator';
    if (memberByName && role === 'assistant') {
      const id = memberByName(r.name);
      if (id) m.charId = id;
      m.name = r.name;
    }
    msgs.push(m);
  }
  return { meta, messages: msgs };
}
