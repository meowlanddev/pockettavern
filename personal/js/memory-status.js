// Memory status for the prompt preview: for each saved memory piece, did its text
// actually reach the assembled prompt, and if not, why. Pure functions, no DOM.

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const tokens = (s) => Math.ceil(String(s || '').length / 3.5);

// A short macro-free snippet of the saved text that should appear unchanged in the prompt.
export function probeFor(text) {
  for (const line of String(text || '').split('\n')) {
    const t = squash(line).replace(/^[#>*\-\s]+/, '');
    if (t.length >= 12 && !t.includes('{{')) return t.slice(0, 48);
  }
  return '';
}

// true: found in the prompt, false: not found, null: could not check.
export function inPrompt(messages, text) {
  const probe = probeFor(text);
  if (!probe) return null;
  return (messages || []).some((m) => typeof m.content === 'string' && squash(m.content).includes(probe));
}

/**
 * rows: [{ name, ok, detail }] with ok = true (sent), false (saved but NOT sent), null (unknown/none).
 * chat: the chat object; dbEnabled: global Narrative Database setting; messages: assembled prompt
 * messages; stale: whether saved database no longer matches the chat history.
 */
export function memoryStatus({ chat, dbEnabled, messages, stale = false }) {
  const rows = [];
  const db = chat?.narrativeDb;
  const manual = !!chat?.narrativeDbManualOnly;
  const total = (chat?.messages || []).length;

  if (db?.text) {
    const mode = manual ? 'manual only' : (dbEnabled ? 'automatic updates' : 'off');
    if (!dbEnabled && !manual) {
      rows.push({ name: 'Narrative Database', ok: false, detail: 'saved but NOT sent: it is off in settings and this chat is not set to "Manual only".' });
    } else if (!manual && stale) {
      rows.push({ name: 'Narrative Database', ok: false, detail: 'saved but NOT sent: chat history changed since it was saved. Rebuild it, or set this chat to "Manual only".' });
    } else {
      const found = inPrompt(messages, db.text);
      const facts = `covers ${db.covered || 0} of ${total} messages, ≈${tokens(db.text)} tokens, ${mode}`;
      if (found === true) rows.push({ name: 'Narrative Database', ok: true, detail: `sent (${facts}).` });
      else if (found === false) rows.push({ name: 'Narrative Database', ok: false, detail: `should be sent (${facts}) but its text was not found in the prompt. Check the preset and regex scripts.` });
      else rows.push({ name: 'Narrative Database', ok: null, detail: `sent as far as settings go (${facts}), but its text could not be checked.` });
    }
  } else if (dbEnabled) {
    rows.push({ name: 'Narrative Database', ok: null, detail: 'on, but nothing is saved for this chat yet.' });
  }

  if (chat?.summary?.text) {
    const found = inPrompt(messages, chat.summary.text);
    rows.push({
      name: 'Running summary',
      ok: found,
      detail: found === true ? 'sent.' : found === false ? 'saved but not found in the prompt. If its position is "Macro", the preset must contain {{summary}}.' : 'saved, but its text could not be checked.',
    });
  }

  if (chat?.authorsNote?.text && chat.authorsNote.text.trim()) {
    const found = inPrompt(messages, chat.authorsNote.text);
    rows.push({
      name: "Author's Note",
      ok: found,
      detail: found === true ? 'sent.' : found === false ? 'saved but not found in the prompt.' : 'saved, but its text could not be checked.',
    });
  }
  return rows;
}
