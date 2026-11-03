// A practical subset of SillyTavern's STscript (slash commands), enough for typical Quick Replies.
// Commands are piped with |, and {{pipe}} holds the previous command's result.
//
// The host app passes an `api` object; see runSlash() in app.js for the implementation.

/** Split a script into commands on top-level | (respecting quotes, {{macros}} and {: closures :}). */
export function splitPipes(src) {
  const out = [];
  let cur = '';
  let quote = false;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === '\\' && i + 1 < src.length) { cur += src[i + 1] === '|' ? '|' : c + src[i + 1]; i++; continue; }
    if (!depth && c === '"') quote = !quote;
    if (!quote) {
      if (two === '{{' || two === '{:') { depth++; cur += two; i++; continue; }
      if ((two === '}}' || two === ':}') && depth) { depth--; cur += two; i++; continue; }
      if (c === '|' && !depth) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const unquote = (v) => (/^".*"$/s.test(v) ? v.slice(1, -1).replace(/\\"/g, '"') : v);

/** Parse "/name key=value key2="quoted value" unnamed text" */
export function parseCommand(seg) {
  const m = seg.match(/^\/([^\s|]+)\s*([\s\S]*)$/);
  if (!m) return { name: '', named: {}, unnamed: seg };
  const name = m[1].toLowerCase();
  let rest = m[2];
  const named = {};
  for (;;) {
    const a = rest.match(/^([a-zA-Z_][\w-]*)=("(?:[^"\\]|\\.)*"|\[[^\]]*\]|\{\{[\s\S]*?\}\}|\S+)\s*/);
    if (!a) break;
    named[a[1].toLowerCase()] = unquote(a[2]);
    rest = rest.slice(a[0].length);
  }
  return { name, named, unnamed: unquote(rest.trim()) };
}

const ALIASES = {
  regen: 'regenerate', wait: 'delay', sleep: 'delay', toast: 'echo', comment: 'noop', '#': 'noop',
  narrate: 'sys', nar: 'sys', sendas: 'sendas', setglobalvar: 'setglobalvar', cont: 'continue',
};

export const COMMANDS = [
  '/send text', '/sendas name=Char text', '/sys text', '/trigger [name]', '/gen prompt', '/genraw prompt',
  '/impersonate', '/continue', '/regenerate', '/setinput text', '/input prompt', '/popup text', '/echo text',
  '/setvar key=name value', '/getvar name', '/addvar key=name value', '/incvar name', '/decvar name', '/flushvar name',
  '/setglobalvar key=name value', '/getglobalvar name', '/pass text', '/delay ms', '/preset name', '/persona name', '/abort',
];

/**
 * Run a script. Returns the final pipe value.
 * api: { macro(text), vars(), globals(), send, sendAs, sys, trigger, gen, genraw, impersonate, cont, regen,
 *        setInput, input, popup, echo, preset, persona, save }
 */
export async function runScript(src, api) {
  let pipe = '';
  for (const seg of splitPipes(src)) {
    if (!seg.startsWith('/')) { pipe = api.macro(seg.replace(/\{\{pipe\}\}/gi, pipe)); continue; }
    const cmd = parseCommand(seg);
    const name = ALIASES[cmd.name] || cmd.name;
    const sub = (v) => api.macro(String(v ?? '').replace(/\{\{pipe\}\}/gi, pipe));
    const named = Object.fromEntries(Object.entries(cmd.named).map(([k, v]) => [k, sub(v)]));
    let arg = sub(cmd.unnamed);
    if (!arg && !['getvar', 'incvar', 'decvar', 'flushvar', 'getglobalvar'].includes(name)) arg = cmd.unnamed ? arg : pipe;
    const vars = api.vars();
    const globals = api.globals();
    const key = named.key || named.name;
    const num = (v) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : null);
    const add = (store, k, v) => {
      const a = num(store[k]);
      const b = num(v);
      store[k] = a !== null && b !== null ? String(a + b) : (store[k] ?? '') + v;
      return store[k];
    };
    switch (name) {
      case 'noop': break;
      case 'pass': pipe = arg; break;
      case 'echo': api.echo(arg); pipe = arg; break;
      case 'popup': await api.popup(arg); pipe = arg; break;
      case 'input': pipe = await api.input(arg, named.default || ''); break;
      case 'setinput': api.setInput(arg); pipe = arg; break;
      case 'send': await api.send(arg); pipe = arg; break;
      case 'sendas': await api.sendAs(named.name || named.char || '', arg); pipe = arg; break;
      case 'sys': await api.sys(arg); pipe = arg; break;
      case 'trigger': await api.trigger(arg && arg !== pipe ? arg : named.name || ''); break;
      case 'gen': pipe = await api.gen(arg); break;
      case 'genraw': pipe = await api.genraw(arg); break;
      case 'impersonate': await api.impersonate(); break;
      case 'continue': await api.cont(); break;
      case 'regenerate': await api.regen(); break;
      case 'setvar': vars[key] = arg; api.save(); pipe = arg; break;
      case 'getvar': pipe = vars[cmd.unnamed ? arg : key] ?? ''; break;
      case 'addvar': pipe = add(vars, key, arg); api.save(); break;
      case 'incvar': pipe = add(vars, cmd.unnamed ? arg : key, '1'); api.save(); break;
      case 'decvar': pipe = add(vars, cmd.unnamed ? arg : key, '-1'); api.save(); break;
      case 'flushvar': delete vars[cmd.unnamed ? arg : key]; api.save(); break;
      case 'setglobalvar': globals[key] = arg; api.save(); pipe = arg; break;
      case 'getglobalvar': pipe = globals[cmd.unnamed ? arg : key] ?? ''; break;
      case 'addglobalvar': pipe = add(globals, key, arg); api.save(); break;
      case 'delay': await new Promise((r) => setTimeout(r, Math.min(Number(arg) || 0, 60000))); break;
      case 'preset': api.preset(arg); break;
      case 'persona': api.persona(arg); break;
      case 'abort': return pipe;
      default: throw new Error(`/${cmd.name} isn't supported in PocketTavern yet.`);
    }
  }
  return pipe;
}
