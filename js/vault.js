// Keeps API keys out of plain sight.
//
// On the device: keys are encrypted (AES-GCM) with a device key the browser
// generates and stores as *non-extractable* — the app can ask the browser to
// decrypt with it, but nobody (not even the app) can read the key itself, so
// a copy of the app's storage, a phone backup or a peek in dev tools shows
// only scrambled bytes. No passphrase needed.
//
// In backup files: keys are only included when protected with a passphrase
// (PBKDF2 → AES-GCM). Without it they're left out.

import * as db from './db.js';

const SECRET_FIELD = /(?:api|emb)Key$|secret|password|^token$/i;
export const isSecretField = (k) => SECRET_FIELD.test(k);
const subtle = globalThis.crypto && crypto.subtle;
export const vaultAvailable = !!subtle;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Pull every credential out of settings into { path: value }; blanks them in `s`. */
export function takeSecrets(s) {
  const out = {};
  for (const c of s.connections || []) {
    for (const k of Object.keys(c)) if (isSecretField(k) && typeof c[k] === 'string' && c[k]) { out[`conn:${c.id}:${k}`] = c[k]; c[k] = ''; }
  }
  for (const [g, obj] of Object.entries(s.ext || {})) {
    for (const k of Object.keys(obj || {})) if (isSecretField(k) && typeof obj[k] === 'string' && obj[k]) { out[`ext:${g}:${k}`] = obj[k]; obj[k] = ''; }
  }
  return out;
}

/** Put secrets back into settings (only into empty fields). */
export function putSecrets(s, secrets) {
  for (const [path, v] of Object.entries(secrets || {})) {
    const [kind, a, k] = path.split(':');
    if (kind === 'conn') {
      const c = (s.connections || []).find((x) => x.id === a);
      if (c && !c[k]) c[k] = v;
    } else if (kind === 'ext' && s.ext && s.ext[a] && !s.ext[a][k]) {
      s.ext[a][k] = v;
    }
  }
  return s;
}

// Read from storage each time (cheap), so "Delete all data" can't leave a
// cached key behind that no longer matches what's stored.
let making = null;
async function getDeviceKey() {
  const k = await db.get('kv', 'vault-key').catch(() => null);
  if (k) return k;
  // One generator at a time, so two quick saves can't create two keys.
  making = making || (async () => {
    const nk = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await db.put('kv', nk, 'vault-key');
    return nk;
  })().finally(() => { making = null; });
  return making;
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function unseal(key, box) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

/** Settings ready to store: a copy without keys, plus the keys written encrypted. */
export async function storeSettings(settings) {
  if (!vaultAvailable) return settings;
  const copy = structuredClone(settings);
  const secrets = takeSecrets(copy);
  await db.put('kv', await seal(await getDeviceKey(), secrets), 'vault');
  return copy;
}

/** Fill keys from the device vault into freshly loaded settings. */
export async function loadSecrets(settings) {
  if (!vaultAvailable) return settings;
  const box = await db.get('kv', 'vault').catch(() => null);
  if (!box) return settings;
  try { putSecrets(settings, await unseal(await getDeviceKey(), box)); } catch (e) { console.warn('Could not unlock saved keys', e); }
  return settings;
}

async function passKey(pass, salt) {
  const base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt secrets for a backup file with a passphrase. */
export async function lockForBackup(secrets, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { kdf: 'PBKDF2-SHA256', iterations: 310000, salt: b64(salt), ...(await seal(await passKey(pass, salt), secrets)) };
}

/** Decrypt a backup's secrets; throws on a wrong passphrase. */
export async function unlockBackup(box, pass) {
  return unseal(await passKey(pass, unb64(box.salt)), box);
}
