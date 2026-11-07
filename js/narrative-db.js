// Narrative Database: independent, cumulative roleplay memory.
// Unlike layered memory, each pass receives the previous *complete* database and
// the next chronological segment of original messages. No LLM calls here.
export const DEFAULT_DATABASE_PROMPT = `# ROLEPLAY DATABASE UPDATE

Update the existing narrative database using the latest roleplay text. Preserve canon, continuity, character knowledge, relationships, and unresolved plot threads.

**Accuracy matters more than detail. Never invent facts to fill gaps. Keep each section at the level of detail its purpose requires.**

## CORE RULES

* Use the existing database, supplied roleplay, and explicit user corrections as sources. New explicit canon overrides older contradictions.
* Every claim must be supported. Do not invent lore, motives, diagnoses, equipment, abilities, affiliations, relationships, timelines, or outcomes.
* Separate established facts from character beliefs, suspicions, theories, and unknowns. Attribute uncertain claims to their source.
* Never turn a character's experience into an objective rule, a belief into a fact, or an inability demonstrated so far into proof of impossibility.
* Do not add exact durations or precision unless clearly supported and useful to continuity.
* Track who knows each fact or secret. Witnessing an event does not prove understanding its cause. Never assume a private conversation was shared.
* Distinguish plans from agreements, attempts, and completed actions. Distinguish temporary compliance from genuine consent.
* Keep every section consistent. Update current states to the latest scene while preserving relevant absent characters, history, secrets, and relationships.
* Be concise in summaries and reference sections, but do not compress narrative history until meaningful events or their progression are lost.
* Preserve established roleplay-writing instructions and character-control boundaries.

## REQUIRED STRUCTURE

# NARRATIVE

## ACTIVE THEATRE

**Current Context:** Briefly summarize the current location, present characters, immediate situation, active conflict, stakes, and latest consequential action. Aim for 2–4 sentences. Include only what is needed to understand the current scene.

**Writing Style:** Preserve established point of view, tense, formatting, character-control rules, and essential roleplay instructions. Keep concise without dropping instructions that govern how the story is written.

**Story Tone:** One brief sentence describing the established tone and current atmosphere. Avoid repeating the Current Context.

## ENTITY DOSSIERS

Maintain relevant dossiers for present and absent characters. This section's existing level of detail is intentional: preserve useful character-specific information rather than aggressively shortening it.

**[Name]**

* **Status:** Current location and confirmed condition.
* **Loadout:** Confirmed possessions and equipment.
* **Skillset:** Demonstrated abilities and confirmed limits.
* **Standing:** Established roles and affiliations.
* **Background:** Essential history.
* **Drive:** Supported motivations and priorities; attribute interpretations.
* **Objective:** Current goals and plans, distinguishing intention, inference, hope, and commitment.
* **Classified:** Secrets and knowledge boundaries.

Use only useful fields. Do not invent missing details or give characters knowledge they have not acquired. Preserve meaningful history, characterization, and distinctions between what a character knows, believes, feels, and intends. Update only what the new roleplay changes; do not rewrite or discard established information without reason.

## THE WEB

List each significant established relationship exactly once, including relationships between absent characters. Preserve the existing concise style and level of detail.

Format:

* **A ↔ B:** One brief sentence describing their current relationship.

Distinguish each person's feelings when they differ. Include meaningful changes in trust, conflict, loyalty, affection, or knowledge. Avoid scene recaps, unsupported interpretations, and numerical scores. Do not remove established relationships merely because the characters were absent from the latest scene.

## WORLD MECHANICS

Keep this section compact and reference-oriented.

**Geography:** Confirmed locations and essential differences between worlds.

**Factions:** Established groups and affiliations relevant to continuity.

**Rules of Reality:** Confirmed mechanics, abilities, and limitations. Attribute unverified explanations and beliefs to their source.

**MacGuffins:** Important objects, devices, evidence, and their known status.

Include only information useful for understanding the setting or continuing the story. Do not repeat character biographies, recap events, add franchise lore, or infer universal rules from isolated incidents. Preserve important uncertainty in a few precise words.

## THE LEDGER

Keep lists focused. Each item should capture a distinct open question, resolved plot thread, or actionable task—not retell the story.

### Unresolved Threads

List significant unanswered questions, mysteries, conflicts, and unsettled decisions. Merge overlapping questions only when no distinct unknown is lost. Preserve partially unresolved mysteries. Do not list matters that are genuinely settled.

### Resolved Threads

Include only previously meaningful questions, conflicts, or objectives that are now genuinely resolved. Ordinary events—rescue, treatment, waking, or learning a fact—are not automatically resolved threads. A character's belief does not resolve an objective question. If only part of a mystery is settled, keep the remainder unresolved.

### Active Tasks

List concrete actions, responsible characters, and actual status where known. Distinguish proposed, contested, agreed, ongoing, completed, and abandoned. Keep each task brief. Do not duplicate an unresolved question unless a distinct action is being taken to address it.

## THE CHRONICLE

This section is the cumulative narrative record. It must preserve the story's meaningful progression, not merely provide a skeletal list of plot milestones. Do not sacrifice its usefulness to make the database shorter.

### Historical Record

Record consequential events in chronological order, earliest first. Aim for roughly 10–15 entries when appropriate, but this is a guideline, not a limit. Use as many entries as necessary to preserve the important history.

Each entry should explain what happened and, where relevant, what it changed: a discovery, decision, relationship, shift in trust, change in character knowledge, new danger, or consequence. Include enough context for the event to remain understandable without rereading the roleplay.

Do not reduce complex sequences to vague summaries. Preserve causal links and meaningful intermediate steps. Merge events only when their order and significance remain clear. Compress wording rather than removing consequential details. Do not discard older events merely to meet a target count.

### Recent Log

List the five newest distinct events, newest first, when available. If fewer than five are established, list fewer. Each entry should summarize a meaningful beat in enough detail to preserve what happened and its immediate significance.

Verify event order against the supplied roleplay. Do not confuse the order in which events are mentioned with their chronological order. When several actions form one continuous scene or exchange, summarize them together if that better preserves their meaning. Do not split one event into artificial entries or repeat the same event in different wording.

The newest entry must reflect the latest consequential event. Check that the log agrees with the Historical Record, current context, character knowledge, and Ledger. Keep the Recent Log focused on recent events; do not use it as a replacement for the cumulative Historical Record.

## SILENT FINAL CHECK

Before responding, verify:

1. No unsupported facts, timelines, motives, or setting details were added.
2. Facts, beliefs, theories, and unknowns remain distinct.
3. Character knowledge and secrets are consistent across all sections.
4. Current context reflects the latest scene without unnecessary recap.
5. Entity Dossiers preserve meaningful character information and established detail.
6. Every significant established relationship is retained exactly once.
7. World Mechanics and Ledger are concise without losing important uncertainty or open threads.
8. Historical Record preserves consequential events, their causal links, and meaningful progression without arbitrary truncation.
9. Recent Log is genuinely newest-first, contains distinct events, and provides enough context to remain useful.
10. No exact claim is more precise or certain than the source supports.
11. No established canon was dropped merely because it was absent from the latest scene.
12. Roleplay-writing instructions and character-control boundaries remain intact.
13. No section contradicts another.

Do not output this checklist.

## OUTPUT

Output only the complete updated database. No preamble, commentary, change summary, or audit. Keep Active Theatre, World Mechanics, and Ledger compact; preserve the established detail of Entity Dossiers and The Web; and give the Chronicle enough space to accurately preserve narrative continuity. Accuracy and useful continuity take priority over arbitrary brevity.`;

export const DEFAULT_DATABASE_SETTINGS = Object.freeze({
  enabled: false, batchTokens: 15000, recentTokens: 15000,
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
export function nextBatch(messages, start, targetTokens = 15000, flush = false) {
  const limit = Math.max(1000, Number(targetTokens) || 15000);
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

export function buildUpdateInput(previous, batch, speaker) {
  const entries = batch.messages.map(m => `<message role="${m.role}">\n${speaker(m)}: ${messageText(m)}\n</message>`).join('\n\n');
  return `<previous_database>\n${previous || '(No previous database. Create the first complete database from the supplied messages.)'}\n</previous_database>\n\n<new_roleplay_messages>\n${entries}\n</new_roleplay_messages>\n\nUpdate the complete database using only the prior database and new messages. Output the full replacement database.`;
}

export function checkedDatabase(text) {
  const result = String(text || '').trim().replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
  if (!result || !['ACTIVE THEATRE','ENTITY DOSSIERS','THE WEB','WORLD MECHANICS','THE LEDGER','THE CHRONICLE','Recent Log'].every(x => result.includes(x))) throw new Error('Database response missing required sections; previous version was retained.');
  return result;
}
