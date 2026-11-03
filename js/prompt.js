// Prompt assembly, modelled on SillyTavern's chat-completion prompt manager.
import { evaluateMacros, macros } from './macros.js';
import { activateWorldInfo } from './worldinfo.js';
import { applyRegex, PLACEMENT } from './regex.js';
import { simplePreset } from './preset.js';

export { macros };
export const estTokens = (s) => Math.ceil((s || '').length / 3.5);

const msgText = (m) => (m.swipes ? m.swipes[m.swipeIdx] || '' : m.text || '');
const ROLE_NUM = { 0: 'system', 1: 'user', 2: 'assistant' };

/** All lorebook entries that apply to this character + persona. */
export function collectLoreEntries({ char, persona, lorebooks }) {
  const books = new Map();
  const charIds = new Set(char.lorebooks || []);
  const personaIds = new Set((persona && persona.lorebooks) || []);
  const linkedName = char.extensions && typeof char.extensions.world === 'string' ? char.extensions.world.trim().toLowerCase() : '';
  for (const b of lorebooks || []) {
    if (b.global || charIds.has(b.id) || personaIds.has(b.id) || (linkedName && b.name.trim().toLowerCase() === linkedName)) books.set(b.id, b);
  }
  const entries = [];
  for (const b of books.values()) entries.push(...b.entries);
  if (char.character_book && char.character_book.entries && !char.disableEmbeddedBook) {
    entries.push(...(char._embeddedEntries || []));
  }
  return { entries, books: [...books.values()] };
}

function formatExamples(raw, heading) {
  const blocks = String(raw || '').split(/<START>/i).map((s) => s.trim()).filter(Boolean);
  if (!blocks.length) return '';
  return blocks.map((b) => (heading ? `${heading}\n${b}` : b)).join('\n\n');
}

/**
 * Build the message list for a generation.
 * history: messages before the one being generated (oldest first)
 * Returns { messages, stats, vars }
 */
export function buildPrompt({ char, persona, settings, chat, history, preset, lorebooks, regexScripts, model, embeddedEntries }) {
  const P = settings.prompt;
  const samplers = settings.preset;
  const pr = preset || simplePreset(P);
  const scripts = regexScripts || [];
  const charWithBook = { ...char, _embeddedEntries: embeddedEntries || [] };

  const texts = history.map(msgText);
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const lastChar = [...history].reverse().find((m) => m.role !== 'user');
  const env = {
    user: (persona && persona.name) || 'User',
    char: char.name,
    persona: (persona && persona.description) || '',
    description: char.description || '',
    personality: char.personality || '',
    scenario: char.scenario || '',
    mesExamplesRaw: char.mes_example || '',
    mesExamples: formatExamples(char.mes_example, pr.new_example_chat_prompt),
    charPrompt: char.system_prompt || '',
    charInstruction: char.post_history_instructions || '',
    charVersion: char.character_version || '',
    creatorNotes: char.creator_notes || '',
    lastMessage: texts[texts.length - 1] || '',
    lastUserMessage: lastUser ? msgText(lastUser) : '',
    lastCharMessage: lastChar ? msgText(lastChar) : '',
    lastMessageId: String(Math.max(0, history.length - 1)),
    model: model || '',
    maxPrompt: samplers.context_size,
    vars: { ...((chat && chat.vars) || {}) },
    globals: settings.globalVars || (settings.globalVars = {}),
    outlets: {},
  };
  const macro = (t) => evaluateMacros(t, env);

  // ---- lorebooks
  const { entries } = collectLoreEntries({ char: charWithBook, persona, lorebooks });
  const wi = activateWorldInfo({ entries, history: texts, char, persona, defaultDepth: P.wi_scan_depth || 4 });
  const wiText = (list) => list.map((e) => applyRegex(macro(e.content), scripts, { placement: PLACEMENT.WORLD_INFO, isPrompt: true, macro }).trim()).filter(Boolean).join('\n');
  for (const [name, list] of Object.entries(wi.outlets)) env.outlets[name] = wiText(list);
  const wrapWi = (s) => (s ? (pr.formats.wi_format || '{0}').replace('{0}', s) : '');

  // ---- walk the prompt order
  const byId = new Map(pr.prompts.map((p) => [p.identifier, p]));
  const blocks = []; // {role, content} | {history:true}
  const injections = []; // {depth, order, role, content}
  let hasHistory = false;

  const examplesText = () => {
    const parts = [wiText(wi.emTop), formatExamples(macro(char.mes_example || ''), pr.new_example_chat_prompt), wiText(wi.emBottom)].filter(Boolean);
    return parts.join('\n\n');
  };

  for (const item of pr.order) {
    if (!item.enabled) continue;
    const p = byId.get(item.identifier);
    if (!p) continue;
    const role = p.role || 'system';
    let content;
    switch (p.identifier) {
      case 'chatHistory': blocks.push({ history: true }); hasHistory = true; continue;
      case 'worldInfoBefore': content = wrapWi(wiText(wi.before)); break;
      case 'worldInfoAfter': content = wrapWi(wiText(wi.after)); break;
      case 'charDescription': content = macro(char.description || ''); break;
      case 'charPersonality': content = (char.personality || '').trim() ? macro(pr.formats.personality_format) : ''; break;
      case 'scenario': content = (char.scenario || '').trim() ? macro(pr.formats.scenario_format) : ''; break;
      case 'personaDescription': content = (persona && (persona.description || '').trim()) ? macro(pr.formats.persona_format) : ''; break;
      case 'dialogueExamples': content = examplesText(); break;
      case 'main': {
        let text = p.content || '';
        if (P.prefer_card_system && !p.forbid_overrides && (char.system_prompt || '').trim()) {
          env.original = macro(text);
          text = char.system_prompt;
        }
        content = macro(text);
        break;
      }
      case 'jailbreak': {
        let text = p.content || '';
        if (P.prefer_card_post_history && !p.forbid_overrides && (char.post_history_instructions || '').trim()) {
          env.original = macro(text);
          text = char.post_history_instructions;
        }
        content = macro(text);
        break;
      }
      default:
        if (p.injection_position === 1) {
          const c = macro(p.content || '');
          if (c.trim()) injections.push({ depth: p.injection_depth ?? 4, order: p.injection_order ?? 100, role, content: c });
          continue;
        }
        content = macro(p.content || '');
    }
    if (content && content.trim()) blocks.push({ role, content: content.trim() });
  }
  if (!hasHistory) blocks.push({ history: true });

  // lorebook entries placed in the chat
  for (const e of wi.depth) {
    const c = wiText([e]);
    if (c) injections.push({ depth: e.depth ?? 4, order: e.order, role: ROLE_NUM[e.role] || 'system', content: c });
  }
  const an = [wiText(wi.anTop), wiText(wi.anBottom)].filter(Boolean).join('\n');
  if (an) injections.push({ depth: 4, order: 100, role: 'system', content: an });

  // ---- chat history within the token budget
  const fixed = blocks.reduce((s, b) => s + (b.content ? estTokens(b.content) + 4 : 0), 0)
    + injections.reduce((s, i) => s + estTokens(i.content) + 4, 0)
    + estTokens(pr.new_chat_prompt);
  const budget = (samplers.context_size || 8192) - (samplers.max_tokens || 500) - fixed - 32;
  const hist = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const depth = history.length - 1 - i;
    let text = applyRegex(msgText(m), scripts, { placement: m.role === 'user' ? PLACEMENT.USER : PLACEMENT.AI, isPrompt: true, depth, macro });
    text = macro(text);
    if (!text.trim()) continue;
    const t = estTokens(text) + 4;
    if (used + t > budget && hist.length) break;
    used += t;
    hist.unshift({ role: m.role === 'user' ? 'user' : 'assistant', content: text });
  }
  // in-chat injections (depth 0 = after the last message)
  const byDepth = new Map();
  for (const inj of injections) {
    const d = Math.max(0, Math.min(hist.length, Number(inj.depth) || 0));
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(inj);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (const d of depths) {
    const list = byDepth.get(d).sort((a, b) => a.order - b.order).map((i) => ({ role: i.role, content: i.content }));
    hist.splice(hist.length - d, 0, ...list);
  }
  const newChat = pr.new_chat_prompt ? macro(pr.new_chat_prompt) : '';

  const messages = [];
  for (const b of blocks) {
    if (b.history) {
      if (newChat.trim()) messages.push({ role: 'system', content: newChat });
      messages.push(...hist);
    } else messages.push(b);
  }

  return {
    messages: messages.filter((m) => m.content && m.content.trim()),
    vars: env.vars,
    stats: {
      system: fixed,
      history: used,
      included: hist.length - injections.length,
      total: history.filter((h) => msgText(h)).length,
      worldInfo: wi.count,
      preset: pr.name,
    },
  };
}
