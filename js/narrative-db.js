// Narrative Database: independent, cumulative roleplay memory.
// Unlike layered memory, each pass receives the previous *complete* database and
// the next chronological segment of original messages. No LLM calls here.
export const DEFAULT_DATABASE_PROMPT = `# ROLEPLAY DATABASE UPDATE

Update the complete Narrative Database using the previous database and new roleplay messages. Output the entire updated database, not a patch. This is memory of **events and discoveries in this specific RP**, not a second character card or lorebook.

## NON-NEGOTIABLE RULES

- Preserve consequential facts and their exact supported details even when they are no longer relevant to the current scene. A death toll, secret, discovery, promise, relationship turning point, irreversible choice, deadline, or unresolved mystery does not expire because it is old.
- Distinguish what actually happened, what a character reported, what they believe or suspect, what remains unknown, and who knows each fact. Do not invent facts or silently promote conjecture to canon.
- Do not reproduce baseline lore: established personalities, voices, skills, affiliations, appearance, backstories, generic locations, and franchise/world rules belong to cards and lorebooks. **Exception:** record a pre-existing fact when its revelation, contradiction, or use has a consequential effect in this RP.
- Preserve user control of the player character, established POV/tense/formatting instructions, timeline distinctions, and unresolved continuity.
- Treat new explicitly established canon and corrections as authoritative when they contradict old database text. Do not invent a reconciliation.
- Retire temporary details (ordinary meals, positions, routine travel, minor inventory, incidental dialogue) when their scenes conclude unless their outcome or symbolism remains important.

## SINGLE SOURCE OF TRUTH / SECTION OWNERSHIP

**Each consequential fact should have one primary home.** Other sections may mention only the current implication, not retell the underlying event. Apply this rule to existing database text as well as new updates.

- **Chronicle owns history:** What happened, when, to whom, who revealed what, and lasting outcomes. Put death tolls, timeline branches, causes, decisive choices, and irreversible changes here once. Compress old scenes into outcomes, not play-by-play accounts. Never copy full history into other sections.
- **Dossiers own character state:** Only the changes a person carries into subsequent scenes—current condition, new knowledge/secrets, consequential personal choices, open goals, and a few key items. Do not retell their chronological history or restate events recorded in the Chronicle. One terse line may identify the resulting change.
- **The Web owns relationship state:** What is now different between people (trust, commitment, estrangement, hidden feelings, promises). Not an account of conversations, gifts, meals, or movements that produced that state.
- **World Mechanics owns persistent mechanics:** Novel RP-specific rules, unusual setting constraints, and operative technology. NOT the plot history in which they were discovered. A timeline's death toll and war progression belong in the Chronicle; mechanisms such as the Mother Box leak belong here.
- **The Ledger owns only unfinished business:** Unanswered questions, unresolved consequences, and active tasks with owners/deadlines where known. There is NO Resolved Threads section. When a thread closes, put its important outcome in the Chronicle, Web, Dossiers, or World Mechanics once; otherwise drop it. Remove old Resolved Threads headings and entries after moving any unique consequential facts to their proper home.
- **Active Theatre owns the next beat:** Short scene orientation only. No inventory, emotional retelling, or long recap.
- **Recent Log is a handoff:** Up to three new changes needed for the next RP reply, not a second history. Skip anything already clear from Active Theatre unless it prevents a continuity mistake. Zero entries is fine.

Before writing, notice repeated facts in the incoming database and consolidate them into their primary home. Move unique significant facts out of any inherited Resolved Threads before deleting that section. Never delete the **only** instance of a consequential fact. Avoid compensating for shorter dossiers by inflating the Chronicle, Ledger, or World Mechanics.

## WRITING & COMPRESSION RULES

- **Write like quick, clear notes, not polished prose.** Choose short common words: 'gave' not 'provided'; 'found' not 'discovered'; 'used' not 'utilized'; 'asked' not 'requested'; 'kept' not 'maintained'. Cut filler like 'in order to', 'proceeded to', 'was able to', and 'it is important to note'. Short words alone do not guarantee fewer tokens: remove needless ideas and clauses too.
- Prefer compact, natural sentences or fragments when clear. **Do not recount minor scene beats.** Record what changed, who knows, and why it matters. Never replace scene prose with equally long formal synonyms; measure the words actually saved. Avoid cryptic abbreviations or shorthand that could confuse the RP model.
- Preserve precise consequential numbers, names, identifiers, dates, and timelines. Never trade an exact established fact for vague phrasing merely to save space.
- Group related minor events by their lasting outcome; drop routine motion, meal details, clothing, repeated reactions, and minute-by-minute action once the scene ends. Preserve exact chronology only where order or timing changes the plot. Compress wording, **not** significant information.
- Refer to an event outside its primary section only when essential to the section's purpose; describe its result in a short phrase rather than restating its sequence.
- On every update, trim inherited bloat, including the old Chronicle. Existing prose is not sacred; established facts are. Summarize a resolved visit or conversation in one brief outcome statement, not five equal-length sentences. A past checkpoint's incidental detail is not automatically worth retaining.
- No fixed total token ceiling or historical-event count. Database growth should track meaningful new developments, not message count.

## REQUIRED OUTPUT

# NARRATIVE

## ACTIVE THEATRE

**Current Context:** One or two short sentences: time/place, participants, situation, next beat. No recap or filler.

**Writing Style:** Concisely preserve established POV, tense, formatting, and player-character control rules. Do not add new instructions.

**Story Tone:** A few words or one brief sentence. Do not recap the scene.

## ENTITY DOSSIERS

Only RP-specific changes and necessary live state for relevant characters, including absent characters with lasting developments. **Use short fragments when clear.** The Chronicle already stores how developments occurred; do not repeat those scenes here. Use only applicable fields; do not fill a template for every person.

**[Name]**
- **Current:** Where they are, condition, immediate goal, if important.
- **Developments:** Consequential things they did, learned, suffered, decided, confessed, or changed during this RP. Do not retell full events already recorded in the Chronicle.
- **Knowledge / Secrets:** What they know, suspect, or do not know; maintain private knowledge boundaries.
- **Open:** Unresolved personal objective or consequence, if any.
- **Key Items:** Only evidence, objects, or possessions with continuing plot relevance.

Omit unused fields. Do not restate standard lorebook biography, abilities, voice, personality, or exhaustive inventories. Give central characters enough detail to preserve their evolving story, but do not give each character equal space.

## THE WEB

Each significant RP-established relationship or **change to an existing relationship** once, **typically one short sentence**:
- **A ↔ B:** Compact statement of current trust, conflict, affection, promises, differing feelings, or knowledge, with major changes where necessary.

Skip static baseline relationships already covered by the lorebook. Preserve persistent relationship changes when characters are absent.

## WORLD MECHANICS

Only RP-established persistent mechanisms, unusual facts, discoveries, or deviations relevant to continuity—not a second timeline chronology. Use **Geography**, **Factions**, **Rules of Reality**, and **MacGuffins** subheadings where applicable. Distinguish confirmed mechanics from hypotheses. Do not recreate DC worldbuilding or duplicate inventories.

## THE LEDGER

### Unresolved Threads
Distinct unresolved mysteries, conflicts, and consequential uncertainties. Never delete one merely because it has not been mentioned recently.

### Active Tasks
Only unfinished plans, responsible people, deadlines, and status (proposed / agreed / underway) where relevant. Drop completed tasks after recording any lasting outcome in its primary section.

## THE CHRONICLE

### Historical Record
Cumulative record of **significant RP events**, earliest first. Preserve consequential outcomes, causality, revelations, timeline branches, exact stakes, and lasting character or relationship developments indefinitely. A devastating death toll or crucial revelation remains even if it does not affect the next scene.

Merge old scenes by meaningful result. One compact entry may cover a whole visit or conversation; include decisive words or exact times only if they affect later events. Give wars, major discoveries, and irreversible choices more room than routine scenes. Preserve cause and effect, protected numbers, dates, identities, and unknowns. Drop old play-by-play details, not major facts. No fixed entry count.

### Recent Log
Zero to three fresh **changes needed for the next reply**, newest first. Use short notes, not beat-by-beat actions or Chronicle duplicates. When an item becomes old, keep its lasting outcome in the proper section and drop the handoff note.

## SILENT VERIFICATION

Before output, check: each consequential fact has one primary home; no Resolved Threads heading; no redundant scene log; Ledger and World Mechanics are not substitute chronicles; correct timeline and ordering; no invented facts; exact numbers/identifiers kept; knowledge boundaries intact; past deaths, promises, mysteries, and relationship changes still recorded; open tasks not prematurely closed; Active Theatre short; no lorebook repetition; plain words and few clauses. If an old entry is verbose, rewrite it more tightly without deleting its consequential facts.

Output **only** the complete updated Markdown database.`;

export const DEFAULT_DATABASE_SETTINGS = Object.freeze({
  enabled: false, batchTokens: 8000, recentTokens: 15000,
  model: '', maxOutputTokens: 12000,
  role: 'system', position: 'before', depth: 0,
  template: '<narrative_database>\n{{database}}\n</narrative_database>',
  prompt: DEFAULT_DATABASE_PROMPT,
});

export const messageText = m => String((m.swipes && m.swipes[m.swipeIdx]) || m.text || '');
export const estimateTokens = s => Math.ceil(String(s || '').length / 3.5);

// Stable synchronous fingerprint for edit detection (not a cryptographic signature).
export function fingerprint(messages, count = messages.length) {
  let hash = 2166136261;
  const mix = s => { for (let i = 0; i < s.length; i++) { hash ^= s.charCodeAt(i); hash = Math.imul(hash, 16777619); } };
  for (let i = 0; i < count; i++) {
    const m = messages[i]; if (!m) return null;
    mix(String(m.id || i)); mix('|'); mix(m.role); mix('|'); mix(messageText(m)); mix('\n');
  }
  return (hash >>> 0).toString(16);
}

export const isStale = (messages, state) => !!(state && state.covered && fingerprint(messages, state.covered) !== state.signature);
export function pendingTokens(messages, covered = 0) {
  return messages.slice(covered).filter(m => !m.hidden && messageText(m).trim()).reduce((s, m) => s + estimateTokens(messageText(m)) + 4, 0);
}

// Entire messages only, no overlap; protects the user's prose from splitting mid-message.
export function nextBatch(messages, start, targetTokens = 8000, flush = false) {
  const limit = Math.max(1000, Number(targetTokens) || 8000);
  let tokens = 0, end = start;
  while (end < messages.length) {
    const m = messages[end];
    const n = m.hidden || !messageText(m).trim() ? 0 : estimateTokens(messageText(m)) + 4;
    if (tokens && tokens + n > limit) break;
    tokens += n; end++;
    if (tokens >= limit) break;
  }
  if (!flush && tokens < limit && end >= messages.length) return null;
  if (end === start) return null;
  return { start, end, tokens, messages: messages.slice(start, end).filter(m => !m.hidden && messageText(m).trim()) };
}

// Count actual whole-message batches, which can differ from tokens / target.
export function countBatches(messages, start = 0, targetTokens = 8000) {
  let count = 0, cursor = start;
  while (cursor < messages.length) {
    const batch = nextBatch(messages, cursor, targetTokens, true);
    if (!batch || batch.end <= cursor) break;
    cursor = batch.end;
    count++;
  }
  return count;
}

export function buildUpdateInput(previous, batch, speaker) {
  const entries = batch.messages.map(m => `<message role="${m.role}">\n${speaker(m)}: ${messageText(m)}\n</message>`).join('\n\n');
  return `<previous_database>\n${previous || '(No previous database. Create the first complete database from the supplied messages.)'}\n</previous_database>\n\n<new_roleplay_messages>\n${entries}\n</new_roleplay_messages>\n\nUpdate the complete database using only the prior database and new messages. Output the full replacement database.`;
}

export function checkedDatabase(text) {
  const result = String(text || '').trim().replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
  const required = ['ACTIVE THEATRE','ENTITY DOSSIERS','THE WEB','WORLD MECHANICS','THE LEDGER','Unresolved Threads','Active Tasks','THE CHRONICLE','Historical Record','Recent Log'];
  const missing = required.filter(x => !result.includes(x));
  if (!result || missing.length) throw new Error('Database response missing required sections: ' + (missing.length ? missing.join(', ') : 'empty response') + '. Previous version was retained.');
  if (/^#{2,4}\\s+Resolved Threads\\s*$/im.test(result)) throw new Error('Database response used old Resolved Threads section. Update the Narrative Database prompt to version 0.13 and retry. Previous version was retained.');
  return result;
}
