// Narrative Database: independent, cumulative roleplay memory.
// Unlike layered memory, each pass receives the previous *complete* database and
// the next chronological segment of original messages. No LLM calls here.
export const DEFAULT_DATABASE_PROMPT = `# ROLEPLAY DATABASE UPDATE

Update the cumulative Narrative Database from the previous complete database and the next chronological RP messages. Output the COMPLETE replacement database, not a patch. Store what the story has established, not a retelling of how each scene was written. This is RP continuity memory, not a replacement for character cards or lorebooks.

## PRIORITIES

1. Correct consequential facts, identities, timelines, and knowledge.
2. Retain all consequential history, including old events no longer on screen.
3. Put each fact in its proper section, without copying it elsewhere.
4. Use the fewest clear words needed. A database is a retrieval aid, not an archive of scene narration. Never trade accuracy for length.

## HOW TO UPDATE (WORK THROUGH THESE DECISIONS BEFORE WRITING)

**1 — Identify facts and their status.** Read new messages against the previous database. Track WHO did/said/knew WHAT, to WHOM, WHEN, and in WHICH timeline. Separate established events, character reports, explicit claims, beliefs, theories, plans, and unknowns. A death need not happen on screen if characters or narration clearly establish it; do not present an outcome as independently witnessed if it was only reported. New explicit canon or corrections override old records; do not silently invent a reconciliation.

**2 — Decide what deserves memory.**
- KEEP: irreversible outcomes; casualties and significant numbers; timeline branches; reveals and secrets; promises and meaningful dialogue; significant choices, motives explicitly stated, relationship changes; ongoing injuries and needs; unusual story-specific rules, evidence, codes, deadlines; open problems and their owners.
- CURRENT SCENE ONLY: positions, clothing, food, gestures, physical reactions, momentary mood, and props needed to continue the very next turn. Put the minimum needed in Active Theatre; remove it as the scene moves on.
- DROP: ordinary meals, sensory description, sexual choreography, repetitive affection, scenic details, minor motions, and mundane objects once they cease to affect decisions or continuity. A vivid or intimate scene is not automatically important history. If an action illustrates a lasting emotional change, keep the CHANGE rather than the physical action. Example: store that two characters committed to caring for each other, not each bite of a sandwich or where leftovers were put.
- Importance does not expire with age. Give a war, pivotal revelation, or lasting relationship change more detail than routine domestic beats. Preserve meaningful details; do not make a fixed-size database or impose an arbitrary event cap.
- CHARACTER STATE IS NOT SCENE HISTORY: Do not file each conversation, injury examination, hug, gesture, thought, meal, weapon, or inferred reaction under Developments or Knowledge. Record only a lasting change or genuinely necessary present state. A long prior dossier is evidence to FILTER, not a template to extend.

**3 — Choose one home for each fact.** Chronicle = past consequential events and outcomes; Dossiers = current character-specific changes and knowledge; Web = present relationship state; Mechanics = persistent RP-specific rules, locations, and tech; Ledger = truly unresolved questions and unfinished tasks; Active Theatre = immediate next beat; Recent Log = only short handoff notes needed beyond Active Theatre. Condense duplicated facts inherited from the previous database, but NEVER remove the only record of a consequential fact. Do not move discarded scene detail from Chronicle into another section.

**4 — Write compactly, then remove duplicates.** Use short natural notes, direct verbs ('gave', not 'provided'), and clear fragments where helpful. Replace lengthy inherited sections instead of appending to them. Cut scene-by-scene narration, duplicate explanations, needless adjectives, and decorative transitions. Preserve exact significant names, quotes, dates, numbers, identifiers, and codes where necessary. Keep causes and consequences; do not replace specific facts with vague summaries.

**Proportional size guidance (soft, not caps):** Active Theatre should fit in ~2 short sentences; each central character's dossier normally needs 2–5 brief lines, supporting characters 0–2; each relationship normally one sentence; past routine encounters normally one Chronicle sentence per consequential outcome, not an entry for every stage. The Chronicle can be the largest section because it owns history. Dossiers should NEVER outweigh the Chronicle just because there were many character reactions. Exceed these guides only to protect specific, consequential facts.

## CONTINUITY SAFEGUARDS

- **People:** Never transfer a fight, confession, promise, decision, or secret to different people (e.g. Catrin snapped at Damian, not Tim). Do not turn romantic subtext into spoken dialogue. Record a motive only if explicitly established, and identify whose belief it is when inferred.
- **Timelines:** Keep distinct timelines and their versions of characters separate. Record which event belongs to which branch; don't blend the original strike with a later cancelled strike. Preserve what each participant knows in the current timeline.
- **Certainty:** Preserve explicitly established deaths even when reported after the fact; preserve real uncertainty when the RP leaves an outcome open. A character's guess is not objective proof. Do not invent additional uncertainty about events the story establishes.
- **Tasks:** Keep each plan's owner, state (proposed/agreed/underway), date, and deadline attached ONLY to that plan. Do not borrow a neighboring deadline or treat an intention as completed. If a character agreed to fetch a cat tomorrow, don't silently change it to 'later' because a newer message doesn't repeat the date.
- **Knowledge and evidence:** Keep revelations private until conveyed. Redacted or unknown destinations stay unknown; mark interpretations as interpretations. Use only RP-established information, not outside franchise lore.
- **Unresolved Threads:** Include only open questions raised in RP or retained as established open questions in the prior database. Never create speculative mysteries to populate a section. When resolved, move any lasting outcome to its proper section and drop the open item. No Resolved Threads section.
- **Baseline lore:** Do not repeat established voice, personality, skills, affiliations, backstories, or generic worldbuilding already in cards/lorebooks. Record only RP-specific changes or consequential uses/revelations.
- **Roleplay rules:** Preserve established POV, tense, formatting, and strict player-character control. Never invent additional writing rules.

## OUTPUT FORMAT (USE THESE EXACT HEADINGS)

# NARRATIVE

## ACTIVE THEATRE

**Current Context:** ONE or TWO short sentences: time/place, people, action and next beat. Mention at most the few objects/positions actually needed to continue the immediate exchange. Do not catalogue clothing, food portions, room layout, the contents of shelves, or every device's location.

**Writing Style:** Briefly retain established POV, tense, formatting, and user control. No invented instructions.

**Story Tone:** A brief description, not a scene recap.

## ENTITY DOSSIERS

Relevant people only; keep important absent characters with lasting new states. **This is a live-state index, NOT a mini-biography or scene transcript.** Central characters: usually 2–5 SHORT lines total, not paragraphs; others: one concise line or omit. Collapse alternate-timeline versions into brief timeline-labeled states when possible. Never include lists of everything said, carried, noticed, touched or worn. Include only fields that matter, not a full template for everyone.

**[Name]**
- **Current:** Significant current condition, location or immediate aim.
- **Developments:** Only enduring changes not adequately recorded in the Chronicle; normally one sentence, never a chronological recap.
- **Knowledge / Secrets:** Only consequential asymmetric or private knowledge; keep it brief and distinguish known from inferred. Do not restate every disclosure already in the Chronicle.
- **Open:** Actual outstanding personal consequence or aim, if any.
- **Key Items:** Only pivotal evidence or objects required to track who has them; no complete equipment list or locations of mundane props.

## THE WEB

ONE concise sentence per relationship changed by this RP. Preserve emotional stakes and commitments, not scene-level proofs (gifts, touches, meals, banter or sex choreography):
- **A ↔ B:** Current affection, conflict, trust, promise, or key asymmetry of knowledge. Attribute actions and words to the right people; do not recount the encounter. Omit static lorebook relationships.

## WORLD MECHANICS

Only persistent RP-specific rules, crucial locations, factions, discoveries and operative tech. Use Geography, Factions, Rules of Reality and MacGuffins subheadings only when useful. Keep ONE entry per system/object, not an exhaustive room tour or inventory. Retain exact codes and evidence identifiers only where they have continuing utility. Distinguish established mechanisms from hypotheses. No plot chronology.

## THE LEDGER

### Unresolved Threads
Only established, still-open consequential questions. Empty is allowed.

### Active Tasks
Only unfinished, grounded actions: owner, status, and task-specific deadline if known. Remove completed tasks after saving any lasting outcome elsewhere.

## THE CHRONICLE

### Historical Record
Earliest first. Preserve consequential events, distinct timelines, stakes, causal links, revelations, choices, major relationship turns and lasting outcomes. Combine connected older scenes into ONE entry about what changed. A kiss/first intimacy may be a lasting milestone; don't record sexual play-by-play, clothing, food, gestures, or which surface/room it occurred on. A visit may establish protection or an agreement; summarize that outcome, not the arrival, each sentence spoken, and the departure. Exact numbers/dates remain where consequential. No fixed event count.

### Recent Log
Zero to three NEW handoff facts needed for the next reply, newest first. Do not repeat Active Theatre or Chronicle just because an event is recent. Do not archive leftover food or other disposable scene props here.

## FINAL CHECK (SILENT)

Before output: Compare against the previous database and new messages. Did any significant old fact disappear? Did a character, timeline, explicit quote, motive, certainty level, plan owner or deadline change without source support? Did I mistake a claim for an observed event—or invent doubt about a clearly established one? Did I invent a mystery? Is a dossier longer than it needs to be because it repeats the Chronicle? Did I keep trivial physical details outside the immediate next beat? Are there redundant entries across sections? Fix those errors. Keep the established format and headings; omit Resolved Threads. THIS CHECK IS PRIVATE: do not output a 'FINAL CHECK' section, a completion note, or any other heading not shown in OUTPUT FORMAT.

Output only the complete updated Markdown database.`;

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
  if (/^#{2,4}\s+Resolved Threads\s*$/im.test(result)) throw new Error('Database response used old Resolved Threads section. Update the Narrative Database prompt to version 0.13 and retry. Previous version was retained.');
  return result;
}
