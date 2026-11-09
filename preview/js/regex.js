// SillyTavern-compatible regex scripts.
export const PLACEMENT = { USER: 1, AI: 2, SLASH: 3, WORLD_INFO: 5, REASONING: 6 };
export const PLACEMENT_LABELS = { 1: 'User input', 2: 'AI output', 3: 'Slash commands', 5: 'World info', 6: 'Reasoning' };

export function regexFromString(str) {
  if (!str) return null;
  const m = String(str).match(/^\/([\s\S]+)\/([dgimsuyv]*)$/);
  try {
    return m ? new RegExp(m[1], m[2]) : new RegExp(str);
  } catch {
    return null;
  }
}

export function normalizeScript(s) {
  if (!s || typeof s !== 'object' || typeof s.findRegex !== 'string') throw new Error('Not a regex script');
  return {
    id: s.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    scriptName: String(s.scriptName || 'Regex'),
    findRegex: s.findRegex,
    replaceString: String(s.replaceString ?? ''),
    trimStrings: Array.isArray(s.trimStrings) ? s.trimStrings.map(String) : [],
    placement: Array.isArray(s.placement) ? s.placement.map(Number) : [2],
    disabled: !!s.disabled,
    markdownOnly: !!s.markdownOnly,
    promptOnly: !!s.promptOnly,
    runOnEdit: s.runOnEdit !== false,
    substituteRegex: Number(s.substituteRegex) || 0,
    minDepth: s.minDepth === '' || s.minDepth == null ? null : Number(s.minDepth),
    maxDepth: s.maxDepth === '' || s.maxDepth == null ? null : Number(s.maxDepth),
  };
}

export function runScript(script, text, macro = (s) => s) {
  if (!script.findRegex || !text) return text;
  let find = script.findRegex;
  if (script.substituteRegex === 1) find = macro(find);
  else if (script.substituteRegex === 2) find = find.replace(/\{\{[^{}]*\}\}/g, (m) => macro(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const rx = regexFromString(find);
  if (!rx) return text;
  const template = script.replaceString.replace(/\{\{match\}\}/gi, '$0');
  return text.replace(rx, (...args) => {
    const groups = typeof args[args.length - 1] === 'object' ? args[args.length - 1] : null;
    const replaced = template.replace(/\$(\d+)|\$<([^>]+)>/g, (m, num, name) => {
      let v = num !== undefined ? args[Number(num)] : groups && groups[name];
      if (typeof v !== 'string') return '';
      for (const t of script.trimStrings) { const tt = macro(t); if (tt) v = v.split(tt).join(''); }
      return v;
    });
    return macro(replaced);
  });
}

/**
 * Applies scripts like SillyTavern's getRegexedString:
 * - markdownOnly scripts only affect what's displayed
 * - promptOnly scripts only affect what's sent to the AI
 * - other scripts permanently edit the message when it's sent/received
 */
export function applyRegex(text, scripts, { placement, isMarkdown = false, isPrompt = false, depth = null, macro } = {}) {
  if (!text || !scripts || !scripts.length) return text;
  for (const s of scripts) {
    if (!s || s.disabled || !s.placement.includes(placement)) continue;
    // Like SillyTavern: "Alter chat display" and "Alter outgoing prompt" can both be on.
    const ok = (s.markdownOnly || s.promptOnly)
      ? (s.markdownOnly && isMarkdown) || (s.promptOnly && isPrompt)
      : (!isMarkdown && (!isPrompt || placement === PLACEMENT.WORLD_INFO));
    if (!ok) continue;
    if (depth !== null && depth !== undefined) {
      if (s.minDepth !== null && s.minDepth >= 0 && depth < s.minDepth) continue;
      if (s.maxDepth !== null && s.maxDepth >= 0 && depth > s.maxDepth) continue;
    }
    text = runScript(s, text, macro);
  }
  return text;
}

/** Parse an imported file: a single script, an array, or {regex_scripts:[...]} */
export function parseRegexFile(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json.regex_scripts) ? json.regex_scripts : [json];
  return list.map(normalizeScript);
}

export function exportScript(s) {
  const { ...copy } = s;
  return copy;
}
