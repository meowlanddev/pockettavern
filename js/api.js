// LLM backends: OpenRouter, any OpenAI-compatible endpoint, and Claude (Anthropic API).

export const PROVIDERS = {
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', kind: 'openai', needsUrl: false },
  openai: { label: 'OpenAI-compatible', base: 'https://api.openai.com/v1', kind: 'openai', needsUrl: true },
  anthropic: { label: 'Claude (Anthropic)', base: 'https://api.anthropic.com/v1', kind: 'anthropic', needsUrl: false },
};

const kindOf = (conn) => (PROVIDERS[conn.provider] || PROVIDERS.openai).kind;

export function baseUrl(conn) {
  const p = PROVIDERS[conn.provider] || PROVIDERS.openai;
  return ((p.needsUrl && conn.baseUrl) ? conn.baseUrl : p.base).trim().replace(/\/+$/, '');
}

function headers(conn, json = true) {
  const h = {};
  if (json) h['content-type'] = 'application/json';
  if (kindOf(conn) === 'anthropic') {
    h['x-api-key'] = conn.apiKey || '';
    h['anthropic-version'] = '2023-06-01';
    h['anthropic-dangerous-direct-browser-access'] = 'true';
    return h;
  }
  if (conn.apiKey) h.authorization = `Bearer ${conn.apiKey}`;
  if (conn.provider === 'openrouter') {
    h['HTTP-Referer'] = location.origin;
    h['X-Title'] = 'PocketTavern';
  }
  return h;
}

async function apiError(resp) {
  let msg = '';
  try {
    const text = await resp.text();
    try {
      const j = JSON.parse(text);
      msg = (j.error && (j.error.message || j.error)) || j.message || text;
      if (j.error && j.error.metadata && j.error.metadata.raw) msg += ` — ${j.error.metadata.raw}`;
    } catch { msg = text; }
  } catch { /* ignore */ }
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  return new Error(`HTTP ${resp.status}${msg ? ': ' + msg.slice(0, 500) : ''}`);
}

function networkError(e, conn) {
  if (e.name === 'AbortError') return e;
  let hint = 'Network error — could not reach the server.';
  const url = baseUrl(conn);
  if (url.startsWith('http://') && location.protocol === 'https:') {
    hint += ' This app runs on HTTPS, so iOS blocks plain http:// endpoints. Use an https:// URL (e.g. a tunnel).';
  } else if (conn.provider === 'openai') {
    hint += ' The server may not allow browser requests (CORS must be enabled on it).';
  }
  const err = new Error(hint);
  err.cause = e;
  return err;
}

async function doFetch(conn, url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    throw networkError(e, conn);
  }
}

export async function listModels(conn) {
  const anth = kindOf(conn) === 'anthropic';
  const url = baseUrl(conn) + '/models' + (anth ? '?limit=1000' : '');
  const resp = await doFetch(conn, url, { headers: headers(conn, false) });
  if (!resp.ok) throw await apiError(resp);
  const j = await resp.json();
  const arr = Array.isArray(j) ? j : (j.data || j.models || []);
  return arr.map((m) => {
    const id = m.id || m.name;
    let price = '';
    if (m.pricing && m.pricing.prompt != null) {
      const inp = parseFloat(m.pricing.prompt) * 1e6;
      const out = parseFloat(m.pricing.completion) * 1e6;
      price = (inp === 0 && out === 0) ? 'free' : `$${+inp.toFixed(2)}/$${+out.toFixed(2)} per M`;
    }
    return {
      id,
      name: m.name || m.display_name || id,
      ctx: m.context_length || m.max_input_tokens || null,
      price,
    };
  }).filter((m) => m.id);
}

async function* sseLines(resp, signal) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal && signal.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith('data:')) yield buf.slice(5).trim();
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function openaiBody(conn, preset, messages) {
  const body = {
    model: conn.model,
    messages,
    max_tokens: preset.max_tokens,
    temperature: preset.temperature,
    top_p: preset.top_p,
    stream: !!preset.stream,
  };
  if (preset.frequency_penalty) body.frequency_penalty = preset.frequency_penalty;
  if (preset.presence_penalty) body.presence_penalty = preset.presence_penalty;
  // Extended samplers: only sent when changed from neutral, so strict APIs don't reject them.
  if (preset.top_k > 0) body.top_k = preset.top_k;
  if (preset.min_p > 0) body.min_p = preset.min_p;
  if (preset.repetition_penalty && preset.repetition_penalty !== 1) body.repetition_penalty = preset.repetition_penalty;
  if (conn.provider === 'openrouter' && ['low', 'medium', 'high'].includes(preset.claude_effort)) {
    body.reasoning = { effort: preset.claude_effort };
  }
  return body;
}

/** Convert generic messages to the Anthropic shape (top-level system, strict user/assistant alternation). */
export function toAnthropic(messages) {
  const system = [];
  const out = [];
  let leading = true;
  for (const m of messages) {
    if (m.role === 'system' && leading) { if (m.content) system.push(m.content); continue; }
    leading = false;
    let role = m.role;
    let content = m.content;
    if (!content) continue;
    if (role === 'system') role = 'user'; // like SillyTavern: later system prompts become user turns
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content;
    else out.push({ role, content });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: '[Start of the chat]' });
  // Current Claude models don't allow assistant prefill, so the request must end on a user turn.
  if (out[out.length - 1].role === 'assistant') out.push({ role: 'user', content: '[Continue]' });
  return { system: system.join('\n\n'), messages: out };
}

function anthropicBody(conn, preset, messages) {
  const { system, messages: msgs } = toAnthropic(messages);
  const body = {
    model: conn.model,
    max_tokens: preset.max_tokens,
    messages: msgs,
    stream: !!preset.stream,
  };
  if (system) body.system = system;
  // Newer Claude models reject sampling params, so they're opt-in (for older models).
  if (preset.claude_sampling) body.temperature = Math.min(1, Math.max(0, preset.temperature));
  if (preset.claude_effort) body.output_config = { effort: preset.claude_effort };
  return body;
}

/**
 * Generate a reply. onToken(fullTextSoFar) is called while streaming.
 * Resolves to the final text.
 */
export async function generate(conn, preset, messages, { signal, onToken } = {}) {
  if (!conn) throw new Error('No API connection set up. Go to Settings → Connection.');
  if (!conn.model) throw new Error('No model selected. Go to Settings → Connection.');
  const anth = kindOf(conn) === 'anthropic';
  const url = baseUrl(conn) + (anth ? '/messages' : '/chat/completions');
  const body = anth ? anthropicBody(conn, preset, messages) : openaiBody(conn, preset, messages);
  const resp = await doFetch(conn, url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body), signal });
  if (!resp.ok) throw await apiError(resp);

  let text = '';
  if (!body.stream) {
    const j = await resp.json();
    if (anth) {
      text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text && j.stop_reason === 'refusal') throw new Error('Claude declined to respond (refusal).');
    } else {
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      text = (j.choices && j.choices[0] && (j.choices[0].message?.content ?? j.choices[0].text)) || '';
    }
    onToken && onToken(text);
    return text;
  }

  let stopReason = null;
  try {
    for await (const data of sseLines(resp, signal)) {
      if (!data) continue;
      if (data === '[DONE]') break;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (anth) {
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
          text += j.delta.text;
          onToken && onToken(text);
        } else if (j.type === 'message_delta' && j.delta) {
          stopReason = j.delta.stop_reason || stopReason;
        } else if (j.type === 'error') {
          throw new Error((j.error && j.error.message) || 'Stream error');
        }
      } else {
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        const choice = j.choices && j.choices[0];
        const delta = choice && ((choice.delta && choice.delta.content) || choice.text);
        if (delta) {
          text += delta;
          onToken && onToken(text);
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return text;
    if (e instanceof TypeError) throw networkError(e, conn);
    throw e;
  }
  if (!text && stopReason === 'refusal') throw new Error('Claude declined to respond (refusal).');
  return text;
}
