// Text-completion formatting (SillyTavern "Advanced Formatting" → Instruct templates).
// Chat-style messages from the prompt builder are turned into one prompt string.

const T = (o) => ({
  input_sequence: '', output_sequence: '', system_sequence: '', first_output_sequence: '', last_output_sequence: '',
  input_suffix: '', output_suffix: '', system_suffix: '', stop_sequence: '', wrap: true, names_behavior: 'force',
  system_same_as_user: false, ...o,
});

export const INSTRUCT_TEMPLATES = {
  chatml: T({ name: 'ChatML', input_sequence: '<|im_start|>user', output_sequence: '<|im_start|>assistant', system_sequence: '<|im_start|>system', input_suffix: '<|im_end|>\n', output_suffix: '<|im_end|>\n', system_suffix: '<|im_end|>\n', stop_sequence: '<|im_end|>' }),
  llama3: T({ name: 'Llama 3 Instruct', input_sequence: '<|start_header_id|>user<|end_header_id|>\n\n', output_sequence: '<|start_header_id|>assistant<|end_header_id|>\n\n', system_sequence: '<|start_header_id|>system<|end_header_id|>\n\n', input_suffix: '<|eot_id|>', output_suffix: '<|eot_id|>', system_suffix: '<|eot_id|>', stop_sequence: '<|eot_id|>', wrap: false }),
  mistral: T({ name: 'Mistral V7-Tekken', input_sequence: '[INST]', output_sequence: '', system_sequence: '[SYSTEM_PROMPT]', input_suffix: '[/INST]', output_suffix: '</s>', system_suffix: '[/SYSTEM_PROMPT]', stop_sequence: '</s>', wrap: false }),
  gemma: T({ name: 'Gemma 2/3', input_sequence: '<start_of_turn>user', output_sequence: '<start_of_turn>model', system_sequence: '<start_of_turn>user', input_suffix: '<end_of_turn>\n', output_suffix: '<end_of_turn>\n', system_suffix: '<end_of_turn>\n', stop_sequence: '<end_of_turn>' }),
  alpaca: T({ name: 'Alpaca', input_sequence: '### Instruction:', output_sequence: '### Response:', system_sequence: '', input_suffix: '\n\n', output_suffix: '\n\n', system_suffix: '\n\n', stop_sequence: '', system_same_as_user: true }),
  metharme: T({ name: 'Metharme (Pygmalion)', input_sequence: '<|user|>', output_sequence: '<|model|>', system_sequence: '<|system|>', wrap: false, stop_sequence: '</s>' }),
  commandr: T({ name: 'Command R', input_sequence: '<|START_OF_TURN_TOKEN|><|USER_TOKEN|>', output_sequence: '<|START_OF_TURN_TOKEN|><|CHATBOT_TOKEN|>', system_sequence: '<|START_OF_TURN_TOKEN|><|SYSTEM_TOKEN|>', input_suffix: '<|END_OF_TURN_TOKEN|>', output_suffix: '<|END_OF_TURN_TOKEN|>', system_suffix: '<|END_OF_TURN_TOKEN|>', stop_sequence: '<|END_OF_TURN_TOKEN|>', wrap: false }),
  plain: T({ name: 'None (plain "Name: text")', names_behavior: 'always', wrap: false }),
};

export const INSTRUCT_FIELDS = [
  ['system_sequence', 'System prefix'], ['system_suffix', 'System suffix'],
  ['input_sequence', 'User prefix'], ['input_suffix', 'User suffix'],
  ['output_sequence', 'Assistant prefix'], ['output_suffix', 'Assistant suffix'],
  ['first_output_sequence', 'First assistant prefix'], ['last_output_sequence', 'Last assistant prefix'],
  ['stop_sequence', 'Stop sequence'],
];

/** Accepts an ST instruct template JSON, or an ST "master export" ({ instruct: … }). */
export function importInstruct(json, fallbackName) {
  const src = json && json.instruct && typeof json.instruct === 'object' ? json.instruct : json;
  if (!src || typeof src !== 'object' || !('input_sequence' in src) || !('output_sequence' in src)) return null;
  const pick = (k) => (typeof src[k] === 'string' ? src[k] : '');
  let names = src.names_behavior;
  if (!names) names = src.names === true ? 'always' : src.names_force_groups === false ? 'none' : 'force';
  return T({
    name: String(src.name || fallbackName || 'Imported'),
    input_sequence: pick('input_sequence'), output_sequence: pick('output_sequence'),
    system_sequence: pick('system_sequence'), first_output_sequence: pick('first_output_sequence'),
    last_output_sequence: pick('last_output_sequence'), input_suffix: pick('input_suffix'),
    output_suffix: pick('output_suffix') || (src.separator_sequence || ''), system_suffix: pick('system_suffix'),
    stop_sequence: pick('stop_sequence'), wrap: src.wrap !== false, names_behavior: names,
    system_same_as_user: !!src.system_same_as_user,
  });
}

export const isInstructFile = (json) => !!importInstruct(json, 'x');

const sub = (s, env) => String(s || '').replace(/\{\{user\}\}/gi, env.user).replace(/\{\{char\}\}/gi, env.char);

/**
 * messages: [{role, content, name?}] from the prompt builder.
 * mode: 'reply' | 'continue' | 'impersonate' | 'quiet'
 * Returns { prompt, stop }
 */
export function messagesToText(messages, tpl, { char, user, mode = 'reply', group = false, nameOf = null } = {}) {
  const env = { char: char || 'Assistant', user: user || 'User' };
  const t = { ...INSTRUCT_TEMPLATES.chatml, ...tpl };
  const nl = t.wrap ? '\n' : '';
  const names = t.names_behavior === 'always' || (t.names_behavior === 'force' && group);
  const sysSeq = t.system_same_as_user || !t.system_sequence ? t.input_sequence : t.system_sequence;
  const sysSuf = t.system_same_as_user || !t.system_sequence ? t.input_suffix : t.system_suffix;
  const parts = [];
  let firstOutput = true;
  const wrapTurn = (prefix, body, suffix) => `${sub(prefix, env)}${prefix ? nl : ''}${body}${suffix ? sub(suffix, env) : nl}`;
  // Leading system messages become one system block (the "story string").
  let i = 0;
  const lead = [];
  while (i < messages.length && messages[i].role === 'system') lead.push(messages[i++].content);
  if (lead.length) parts.push(wrapTurn(sysSeq, lead.join('\n\n'), sysSuf));
  const rest = messages.slice(i);
  rest.forEach((m, k) => {
    const isLast = k === rest.length - 1;
    const body = m.content || '';
    if (m.role === 'user') {
      parts.push(wrapTurn(t.input_sequence, names ? `${env.user}: ${body}` : body, t.input_suffix));
    } else if (m.role === 'assistant') {
      const prefix = firstOutput && t.first_output_sequence ? t.first_output_sequence : t.output_sequence;
      firstOutput = false;
      const who = (nameOf && nameOf(m)) || env.char;
      const text = names && !body.startsWith(`${who}:`) ? `${who}: ${body}` : body;
      if (mode === 'continue' && isLast) parts.push(`${sub(prefix, env)}${prefix ? nl : ''}${text}`);
      else parts.push(wrapTurn(prefix, text, t.output_suffix));
    } else {
      parts.push(wrapTurn(sysSeq, body, sysSuf));
    }
  });
  let prompt = parts.join('');
  if (mode === 'impersonate') {
    prompt += `${sub(t.input_sequence, env)}${t.input_sequence ? nl : ''}${names ? `${env.user}:` : ''}`;
  } else if (mode !== 'continue') {
    const prefix = t.last_output_sequence || (firstOutput && t.first_output_sequence) || t.output_sequence;
    prompt += `${sub(prefix, env)}${prefix ? nl : ''}${names || mode === 'reply' && !t.output_sequence ? `${env.char}:` : ''}`;
  }
  const stop = [t.stop_sequence, t.input_sequence && t.input_sequence.trim(), mode === 'impersonate' ? t.output_sequence && t.output_sequence.trim() : '']
    .map((x) => sub(x, env)).filter((x) => x && x.trim());
  return { prompt, stop: [...new Set(stop)] };
}
