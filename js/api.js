// LLM backends: OpenRouter, any OpenAI-compatible endpoint, and Claude (Anthropic API).

export const PROVIDERS = {
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', kind: 'openai', needsUrl: false },
  openai: { label: 'OpenAI-compatible', base: 'https://api.openai.com/v1', kind: 'openai', needsUrl: true },
  anthropic: { label: 'Claude (Anthropic)', base: 'https://api.anthropic.com/v1', kind: 'anthropic', needsUrl: false },
  textcomp: { label: 'Text completion (KoboldCpp, Ollama, LM Studio, ooba…)', base: 'http://localhost:5001/v1', kind: 'text', needsUrl: true },
};

export const TEXT_SERVERS = [
  ['KoboldCpp', 'http://localhost:5001/v1', 'Tick "Remote Tunnel" in KoboldCpp to get an https address for your phone.'],
  ['Ollama', 'http://localhost:11434/v1', 'Start Ollama with OLLAMA_ORIGINS=* so browsers may connect.'],
  ['LM Studio', 'http://localhost:1234/v1', 'Developer tab → enable CORS and "Serve on local network".'],
  ['text-generation-webui (ooba)', 'http://localhost:5000/v1', 'Start with --api (and --listen for other devices).'],
  ['llama.cpp server', 'http://localhost:8080/v1', 'Run llama-server with --host 0.0.0.0.'],
  ['TabbyAPI', 'http://localhost:5000/v1', ''],
];

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
  } else if ((PROVIDERS[conn.provider] || {}).needsUrl) {
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
    messages: messages.map((m) => (Array.isArray(m.images) && m.images.length
      ? { role: m.role, content: [{ type: 'text', text: m.content || ' ' }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))] }
      : { role: m.role, content: m.content })),
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
  if (conn.provider === 'openrouter' && preset.show_thoughts) body.include_reasoning = true;
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
  const blocksOf = (m) => {
    const b = [];
    // Images are only allowed in user turns.
    if (Array.isArray(m.images) && m.role !== 'assistant') {
      for (const url of m.images) {
        const mm = String(url).match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
        if (mm) b.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
      }
    }
    if (m.content) b.push({ type: 'text', text: m.content });
    return b;
  };
  for (const m of messages) {
    if (m.role === 'system' && leading) { if (m.content) system.push(m.content); continue; }
    leading = false;
    const role = m.role === 'system' ? 'user' : m.role; // like SillyTavern: later system prompts become user turns
    const blocks = blocksOf(m);
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.blocks.push(...blocks);
    else out.push({ role, blocks });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', blocks: [{ type: 'text', text: '[Start of the chat]' }] });
  // Current Claude models don't allow assistant prefill, so the request must end on a user turn.
  if (out[out.length - 1].role === 'assistant') out.push({ role: 'user', blocks: [{ type: 'text', text: '[Continue]' }] });
  const finish = ({ role, blocks }) => {
    const merged = [];
    for (const b of blocks) {
      const prev = merged[merged.length - 1];
      if (b.type === 'text' && prev && prev.type === 'text') prev.text += '\n\n' + b.text;
      else merged.push({ ...b });
    }
    return { role, content: merged.every((b) => b.type === 'text') ? merged.map((b) => b.text).join('\n\n') : merged };
  };
  return { system: system.join('\n\n'), messages: out.map(finish) };
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
  // Summarized thinking so it can be shown (Claude 4.6+; older models need this off).
  if (preset.show_thoughts) body.thinking = { type: 'adaptive', display: 'summarized' };
  return body;
}

/** "<think>…</think>" at the start of a reply → reasoning (like SillyTavern's reasoning auto-parse). */
export function splitThink(raw, prefix, suffix) {
  const t = raw.replace(/^\s+/, '');
  if (!prefix) return null;
  if (t.length < prefix.length && prefix.startsWith(t)) return { reasoning: '', text: '' }; // prefix still arriving
  if (!t.startsWith(prefix)) return null;
  const end = suffix ? t.indexOf(suffix, prefix.length) : -1;
  if (end < 0) return { reasoning: t.slice(prefix.length).replace(/^\s+/, ''), text: '' };
  return { reasoning: t.slice(prefix.length, end).trim(), text: t.slice(end + suffix.length).replace(/^\s+/, '') };
}

function earliestStop(text, stops) {
  let best = -1;
  for (const s of stops) {
    if (!s) continue;
    const i = text.indexOf(s);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/**
 * Generate a reply. onToken(fullTextSoFar, reasoningSoFar) is called while streaming.
 * stop: stopping strings (sent to the API where supported, and always enforced here).
 * think: { prefix, suffix } to move a leading <think> block into the reasoning.
 * Resolves to the final text.
 */
export async function generate(conn, preset, messages, { signal, onToken, stop = [], think = null, textFormat = null } = {}) {
  if (!conn) throw new Error('No API connection set up. Go to Settings → Connection.');
  const kind = kindOf(conn);
  if (!conn.model && kind !== 'text') throw new Error('No model selected. Go to Settings → Connection.');
  const anth = kind === 'anthropic';
  const text = kind === 'text';
  const url = baseUrl(conn) + (anth ? '/messages' : text ? '/completions' : '/chat/completions');
  stop = (stop || []).filter((x) => typeof x === 'string' && x.length);
  let body;
  if (text) {
    // Text completion: the chat is formatted into one prompt with the instruct template.
    const fmt = textFormat ? textFormat(messages) : { prompt: messages.map((m) => `${m.role}: ${m.content}`).join('\n') + '\nassistant:', stop: [] };
    stop = [...new Set([...stop, ...fmt.stop])];
    body = { ...openaiBody(conn, preset, []), prompt: fmt.prompt };
    delete body.messages;
    if (!conn.model) delete body.model;
    if (stop.length) body.stop = stop.slice(0, 16);
  } else body = anth ? anthropicBody(conn, preset, messages) : openaiBody(conn, preset, messages);
  if (stop.length && !text) {
    if (anth) { const seq = stop.filter((x) => x.trim()).slice(0, 8); if (seq.length) body.stop_sequences = seq; }
    else if (!/api\.openai\.com/.test(url)) body.stop = stop.slice(0, 4); // OpenAI's newer models reject `stop`
  }
  const resp = await doFetch(conn, url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body), signal });
  if (!resp.ok) throw await apiError(resp);

  let raw = '';
  let native = '';
  let stopped = false;
  const view = () => {
    let text = raw;
    let reasoning = native;
    const sp = think && think.prefix ? splitThink(raw, think.prefix, think.suffix || '') : null;
    if (sp) { text = sp.text; reasoning = [native, sp.reasoning].filter(Boolean).join('\n'); }
    const cut = stop.length ? earliestStop(text, stop) : -1;
    if (cut >= 0) { text = text.slice(0, cut); stopped = true; }
    return { text, reasoning };
  };
  const emit = () => { const v = view(); if (onToken) onToken(v.text, v.reasoning); return v; };

  if (!body.stream) {
    const j = await resp.json();
    if (anth) {
      raw = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      native = (j.content || []).filter((b) => b.type === 'thinking').map((b) => b.thinking || '').join('\n');
      if (!raw && j.stop_reason === 'refusal') throw new Error('Claude declined to respond (refusal).');
    } else {
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      raw = (j.choices && j.choices[0] && (j.choices[0].message?.content ?? j.choices[0].text)) || j.content || '';
      const m = j.choices && j.choices[0] && j.choices[0].message;
      native = (m && (m.reasoning || m.reasoning_content)) || '';
    }
    return emit().text;
  }

  let stopReason = null;
  try {
    for await (const data of sseLines(resp, signal)) {
      if (!data) continue;
      if (data === '[DONE]') break;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (anth) {
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'thinking_delta') {
          native += j.delta.thinking || '';
          emit();
        } else if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
          raw += j.delta.text;
          emit();
        } else if (j.type === 'message_delta' && j.delta) {
          stopReason = j.delta.stop_reason || stopReason;
        } else if (j.type === 'error') {
          throw new Error((j.error && j.error.message) || 'Stream error');
        }
      } else {
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        const choice = j.choices && j.choices[0];
        const rd = choice && choice.delta && (choice.delta.reasoning || choice.delta.reasoning_content);
        if (rd) { native += rd; emit(); }
        const delta = choice && ((choice.delta && choice.delta.content) || choice.text);
        if (delta) { raw += delta; emit(); }
      }
      if (stopped) break;
    }
  } catch (e) {
    if (e.name === 'AbortError') return view().text;
    if (e instanceof TypeError) throw networkError(e, conn);
    throw e;
  }
  if (stopped) { try { resp.body && resp.body.cancel(); } catch { /* already released */ } }
  const out = view();
  if (!out.text && !raw && stopReason === 'refusal') throw new Error('Claude declined to respond (refusal).');
  return out.text;
}

// ---------- image generation ----------
/** Returns an image as a data: URL (or an https URL for Pollinations when it can't be fetched). */
export async function generateImage(cfg, conn, prompt, { width = 1024, height = 1024, signal } = {}) {
  const full = [cfg.style, prompt].filter((x) => x && x.trim()).join(', ');
  if (cfg.provider === 'pollinations') {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(full)}?width=${width}&height=${height}&nologo=true&seed=${Math.floor(Math.random() * 1e9)}${cfg.negative ? `&negative=${encodeURIComponent(cfg.negative)}` : ''}`;
    try {
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await blobToDataUrl(await r.blob());
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return url; // displayed directly; can't be embedded in exports
    }
  }
  if (cfg.provider === 'openrouter') {
    const key = cfg.apiKey || (conn && conn.provider === 'openrouter' ? conn.apiKey : '');
    if (!key) throw new Error('Image generation needs an OpenRouter key (set it in Settings → Extensions → Image generation, or use an OpenRouter connection).');
    const body = {
      model: cfg.model || 'google/gemini-2.5-flash-image',
      messages: [{ role: 'user', content: `Generate an image: ${full}${cfg.negative ? `\nAvoid: ${cfg.negative}` : ''}` }],
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: cfg.aspect || '1:1' },
    };
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'HTTP-Referer': location.origin, 'X-Title': 'PocketTavern' },
      body: JSON.stringify(body),
    }).catch((e) => { throw networkError(e, { provider: 'openrouter' }); });
    if (!r.ok) throw await apiError(r);
    const j = await r.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    const img = msg && Array.isArray(msg.images) && msg.images[0];
    const url = img && ((img.image_url && img.image_url.url) || img.url);
    if (!url) throw new Error(`The model didn't return an image${msg && msg.content ? `: ${String(msg.content).slice(0, 200)}` : ''}. Pick an image model (e.g. google/gemini-2.5-flash-image).`);
    return url.startsWith('data:') ? url : blobToDataUrl(await (await fetch(url)).blob());
  }
  // OpenAI-compatible /images/generations
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const body = { model: cfg.model || 'gpt-image-1', prompt: full, n: 1, size: `${width}x${height}` };
  if (/dall-e/i.test(body.model)) body.response_format = 'b64_json';
  const r = await fetch(`${base}/images/generations`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` }, body: JSON.stringify(body),
  }).catch((e) => { throw networkError(e, { provider: 'openai', baseUrl: base }); });
  if (!r.ok) throw await apiError(r);
  const j = await r.json();
  const d = j.data && j.data[0];
  if (d && d.b64_json) return `data:image/png;base64,${d.b64_json}`;
  if (d && d.url) return blobToDataUrl(await (await fetch(d.url)).blob());
  throw new Error('No image in the response');
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// ---------- text to speech ----------
export async function ttsAudio(cfg, text, voice, signal) {
  if (cfg.provider === 'elevenlabs') {
    if (!voice) throw new Error('Pick an ElevenLabs voice first.');
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json', 'xi-api-key': cfg.apiKey },
      body: JSON.stringify({ text, model_id: cfg.model && /eleven/i.test(cfg.model) ? cfg.model : 'eleven_multilingual_v2' }),
    });
    if (!r.ok) throw await apiError(r);
    return r.blob();
  }
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const r = await fetch(`${base}/audio/speech`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model || 'gpt-4o-mini-tts', voice: voice || 'alloy', input: text, speed: Number(cfg.rate) || 1 }),
  });
  if (!r.ok) throw await apiError(r);
  return r.blob();
}

export async function listElevenVoices(apiKey) {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
  if (!r.ok) throw await apiError(r);
  const j = await r.json();
  return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name }));
}

// ---------- embeddings (chat recall) ----------
export async function embed(cfg, inputs) {
  const base = (cfg.embBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const r = await fetch(`${base}/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.embKey}` },
    body: JSON.stringify({ model: cfg.embModel || 'text-embedding-3-small', input: inputs }),
  });
  if (!r.ok) throw await apiError(r);
  const j = await r.json();
  return (j.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
