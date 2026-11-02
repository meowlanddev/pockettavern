// Prompt assembly: macros, world info (embedded lorebooks), context trimming.

export const estTokens = (s) => Math.ceil((s || '').length / 3.5);

export function macros(text, ctx) {
  if (!text) return '';
  return String(text)
    .replace(/\{\{char\}\}|<BOT>/gi, ctx.char)
    .replace(/\{\{user\}\}|<USER>/gi, ctx.user)
    .replace(/\{\{time\}\}/gi, () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
    .replace(/\{\{date\}\}/gi, () => new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }))
    .replace(/\{\{weekday\}\}/gi, () => new Date().toLocaleDateString([], { weekday: 'long' }))
    .replace(/\{\{random:([^}]*)\}\}/gi, (m, a) => {
      const opts = a.split(',');
      return opts[Math.floor(Math.random() * opts.length)].trim();
    })
    .replace(/\{\{roll:\s*(\d*)d(\d+)\}\}/gi, (m, n, s) => {
      let t = 0;
      for (let i = 0; i < (parseInt(n, 10) || 1); i++) t += 1 + Math.floor(Math.random() * parseInt(s, 10));
      return String(t);
    })
    .replace(/\{\{newline\}\}/gi, '\n')
    .replace(/\{\{trim\}\}/gi, '')
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, ''); // {{// comments}}
}

const msgText = (m) => (m.swipes ? m.swipes[m.swipeIdx] || '' : m.text || '');

function matchAny(keys, text, caseSensitive) {
  for (const k of keys || []) {
    if (!k || typeof k !== 'string') continue;
    const rx = k.match(/^\/(.+)\/([a-z]*)$/);
    if (rx) {
      try { if (new RegExp(rx[1], rx[2]).test(text)) return true; } catch { /* bad regex */ }
      continue;
    }
    if (caseSensitive ? text.includes(k) : text.toLowerCase().includes(k.toLowerCase())) return true;
  }
  return false;
}

/** Activate lorebook entries by keyword over the last N messages. */
export function activateWorldInfo(book, history, defaultDepth, ctx) {
  const res = { before: '', after: '', count: 0 };
  if (!book || !book.entries) return res;
  const entries = (Array.isArray(book.entries) ? book.entries : Object.values(book.entries))
    .filter((e) => e && e.enabled !== false && e.disable !== true && e.content);
  if (!entries.length) return res;
  const depth = book.scan_depth || defaultDepth || 4;
  const recent = history.slice(-depth).map(msgText).join('\n');
  const before = [];
  const after = [];
  for (const e of entries) {
    let hit = !!e.constant;
    if (!hit) {
      hit = matchAny(e.keys || e.key, recent, e.case_sensitive);
      const secondary = e.secondary_keys || e.keysecondary;
      if (hit && e.selective && secondary && secondary.length) hit = matchAny(secondary, recent, e.case_sensitive);
    }
    if (hit) ((e.position === 'after_char' || e.position === 1) ? after : before).push(e);
  }
  const order = (e) => e.insertion_order ?? e.order ?? 100;
  const join = (list) => list.sort((a, b) => order(a) - order(b)).map((e) => macros(e.content, ctx).trim()).join('\n');
  res.before = join(before);
  res.after = join(after);
  res.count = before.length + after.length;
  return res;
}

/**
 * Build a chat-completion style message list.
 * Returns { messages: [{role, content}], stats }
 */
export function buildPrompt({ char, persona, settings, history }) {
  const ctx = { char: char.name, user: (persona && persona.name) || 'User' };
  const m = (s) => macros(s, ctx).trim();
  const P = settings.prompt;
  const preset = settings.preset;

  let main = m(P.main);
  if (P.prefer_card_system && char.system_prompt && char.system_prompt.trim()) {
    main = m(char.system_prompt.replace(/\{\{original\}\}/gi, P.main || ''));
  }

  const wi = activateWorldInfo(char.character_book, history, P.wi_scan_depth, ctx);
  const parts = [main];
  if (wi.before) parts.push(wi.before);
  if (char.description) parts.push(m(char.description));
  if (char.personality && char.personality.trim()) parts.push(`${ctx.char}'s personality: ${m(char.personality)}`);
  if (char.scenario && char.scenario.trim()) parts.push(`Scenario: ${m(char.scenario)}`);
  if (wi.after) parts.push(wi.after);
  if (persona && persona.description && persona.description.trim()) parts.push(`About ${ctx.user}: ${m(persona.description)}`);
  if (char.mes_example && char.mes_example.trim()) {
    const blocks = m(char.mes_example).split(/<START>/i).map((s) => s.trim()).filter(Boolean);
    if (blocks.length) {
      parts.push('Example dialogue (style reference only, not part of the story):\n'
        + blocks.map((b) => `<example>\n${b}\n</example>`).join('\n'));
    }
  }
  const system = parts.filter((s) => s && s.trim()).join('\n\n');

  let post = P.post_history || '';
  if (P.prefer_card_post_history && char.post_history_instructions && char.post_history_instructions.trim()) {
    post = char.post_history_instructions.replace(/\{\{original\}\}/gi, P.post_history || '');
  }
  post = m(post);

  const budget = (preset.context_size || 8192) - (preset.max_tokens || 500) - estTokens(system) - estTokens(post) - 64;
  const out = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const text = m(msgText(history[i]));
    if (!text) continue;
    const t = estTokens(text) + 4;
    if (used + t > budget && out.length) break;
    used += t;
    out.unshift({ role: history[i].role === 'user' ? 'user' : 'assistant', content: text });
  }

  const messages = [{ role: 'system', content: system }, ...out];
  if (post) messages.push({ role: 'system', content: post });
  return {
    messages,
    stats: {
      system: estTokens(system),
      history: used,
      included: out.length,
      total: history.filter((h) => msgText(h)).length,
      worldInfo: wi.count,
    },
  };
}
