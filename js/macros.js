// SillyTavern-compatible macro engine.
// Macros are evaluated innermost-first, left to right, so nesting like
// {{setvar::x::{{random::a::b}}}} works, and setvar/getvar follow prompt order.

const TRIM = '\u0001TRIM\u0001';

function rollDice(spec) {
  const m = String(spec).replace(/\s+/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) {
    const n = parseInt(spec, 10);
    return Number.isFinite(n) && n > 0 ? String(1 + Math.floor(Math.random() * n)) : '';
  }
  let total = 0;
  const count = Math.min(parseInt(m[1] || '1', 10), 100);
  const sides = parseInt(m[2], 10);
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return String(total + (m[3] ? parseInt(m[3], 10) : 0));
}

const pickRandom = (opts) => (opts.length ? opts[Math.floor(Math.random() * opts.length)] : '');

function addVar(store, name, value) {
  const cur = store[name];
  const a = Number(cur);
  const b = Number(value);
  if (cur !== undefined && cur !== '' && !Number.isNaN(a) && !Number.isNaN(b)) store[name] = String(a + b);
  else store[name] = (cur ?? '') + value;
}

function evalOne(body, env) {
  const raw = body;
  const b = body.trim();
  if (b.startsWith('//')) return '';
  const lower = b.toLowerCase();
  const vars = env.vars || (env.vars = {});
  const globals = env.globals || (env.globals = {});

  if (b.includes('::')) {
    const parts = b.split('::');
    const name = parts[0].trim().toLowerCase();
    const arg = parts[1] !== undefined ? parts[1].trim() : '';
    const rest = parts.slice(2).join('::');
    switch (name) {
      case 'random': case 'pick': return pickRandom(parts.slice(1));
      case 'setvar': vars[arg] = rest; return '';
      case 'getvar': return vars[arg] ?? '';
      case 'addvar': addVar(vars, arg, rest); return '';
      case 'incvar': addVar(vars, arg, '1'); return vars[arg];
      case 'decvar': addVar(vars, arg, '-1'); return vars[arg];
      case 'setglobalvar': globals[arg] = rest; return '';
      case 'getglobalvar': return globals[arg] ?? '';
      case 'addglobalvar': addVar(globals, arg, rest); return '';
      case 'incglobalvar': addVar(globals, arg, '1'); return globals[arg];
      case 'decglobalvar': addVar(globals, arg, '-1'); return globals[arg];
      case 'outlet': return (env.outlets && env.outlets[arg]) || '';
      case 'roll': return rollDice(arg);
      default: return null;
    }
  }

  let m;
  if ((m = b.match(/^(?:random|pick)\s*:\s*([\s\S]*)$/i))) {
    const opts = m[1].replace(/\\,/g, '\u0003').split(',').map((s) => s.replace(/\u0003/g, ',').trim());
    return pickRandom(opts);
  }
  if ((m = b.match(/^roll[\s:]+(.+)$/i))) return rollDice(m[1]);
  if (/^banned\s/i.test(b)) return '';

  const now = new Date();
  switch (lower) {
    case 'user': return env.user ?? 'User';
    case 'char': case 'group': case 'charifnotgroup': case 'groupnotmuted': return env.char ?? '';
    case 'persona': return env.persona ?? '';
    case 'description': return env.description ?? '';
    case 'personality': return env.personality ?? '';
    case 'scenario': return env.scenario ?? '';
    case 'mesexamples': return env.mesExamples ?? '';
    case 'mesexamplesraw': return env.mesExamplesRaw ?? '';
    case 'charprompt': return env.charPrompt ?? '';
    case 'charjailbreak': case 'charinstruction': return env.charInstruction ?? '';
    case 'charversion': case 'char_version': return env.charVersion ?? '';
    case 'creatornotes': return env.creatorNotes ?? '';
    case 'lastmessage': case 'lastchatmessage': return env.lastMessage ?? '';
    case 'lastusermessage': return env.lastUserMessage ?? '';
    case 'lastcharmessage': return env.lastCharMessage ?? '';
    case 'lastmessageid': return env.lastMessageId ?? '';
    case 'input': return env.input ?? '';
    case 'model': return env.model ?? '';
    case 'original': return env.original ?? '';
    case 'summary': return env.summary ?? '';
    case 'maxprompt': return String(env.maxPrompt ?? '');
    case 'newline': return '\n';
    case 'trim': return TRIM;
    case 'noop': return '';
    case 'time': return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    case 'date': return now.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    case 'weekday': return now.toLocaleDateString([], { weekday: 'long' });
    case 'isotime': return now.toTimeString().slice(0, 5);
    case 'isodate': return now.toISOString().slice(0, 10);
    case 'idle_duration': return 'a moment';
    default: return raw === body ? null : null;
  }
}

/** Evaluate all macros in text. env.vars / env.globals are mutated by setvar & co. */
export function evaluateMacros(text, env = {}) {
  if (text == null || text === '') return '';
  let s = String(text)
    .replace(/<USER>/gi, '{{user}}')
    .replace(/<BOT>|<CHAR>/gi, '{{char}}');
  if (!s.includes('{{')) return s;
  const unknown = [];
  for (let pass = 0; pass < 40; pass++) {
    let changed = false;
    s = s.replace(/\{\{([^{}]*)\}\}/g, (m, body) => {
      changed = true;
      const r = evalOne(body, env);
      if (r === null || r === undefined) {
        unknown.push(m);
        return `\u0002${unknown.length - 1}\u0002`;
      }
      return String(r);
    });
    if (!changed) break;
  }
  s = s.replace(/\u0002(\d+)\u0002/g, (m, i) => unknown[+i]);
  s = s.replace(/(?:\r?\n)*\u0001TRIM\u0001(?:\r?\n)*/g, '');
  return s;
}

/** Light helper for UI display: {{char}}/{{user}} and friends, without touching chat variables. */
export function macros(text, ctx) {
  return evaluateMacros(text, { char: ctx.char, user: ctx.user, vars: { ...(ctx.vars || {}) } });
}
