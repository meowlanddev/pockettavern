// Built-in versions of SillyTavern's bundled extensions:
// image generation, TTS, translation, character expressions, chat recall (vector storage).
// Pure helpers live here; app.js wires them to the UI and the connection.

export const DEFAULT_EXT = Object.freeze({
  vision: { enabled: true, maxImages: 3 },
  image: {
    enabled: true, provider: 'openrouter', model: 'google/gemini-2.5-flash-image', baseUrl: 'https://api.openai.com/v1', apiKey: '',
    aspect: '1:1', style: '', negative: '', writePrompt: true,
  },
  tts: {
    enabled: false, provider: 'browser', auto: false, dialogueOnly: false, skipActions: true, rate: 1,
    baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini-tts', defaultVoice: '', narratorVoice: '',
  },
  translate: { enabled: false, target: 'English', auto: false, input: false, inputTarget: 'English', model: '' },
  expressions: { enabled: false, auto: true, model: '', collapsed: false },
  recall: {
    enabled: false, mode: 'keyword', topK: 3, depth: 2, skipRecent: 12, minScore: 0.25,
    template: '[Relevant earlier moments in this story:\n{{text}}]',
    embBase: 'https://api.openai.com/v1', embKey: '', embModel: 'text-embedding-3-small',
  },
});

// ---------- image generation ----------
export const IMAGE_MODES = {
  scene: 'The current scene',
  char: 'Portrait of {{char}}',
  user: 'Portrait of you ({{user}})',
  free: 'Custom prompt',
};

export function imagePromptInstruction(mode, extra = '') {
  const common = 'Write ONE image-generation prompt: a single paragraph of comma-separated visual descriptors (subjects, appearance, clothing, pose, setting, lighting, mood, art style). Describe only what is visible. No names-only references, no dialogue, no commentary. Output only the prompt.';
  switch (mode) {
    case 'char': return `[Pause the roleplay. ${common} Subject: a portrait of {{char}}, based on their description and how they look right now in the story.]`;
    case 'user': return `[Pause the roleplay. ${common} Subject: a portrait of {{user}}, based on their persona and how they look right now in the story.]`;
    case 'free': return `[Pause the roleplay. ${common} Subject: ${extra}]`;
    default: return `[Pause the roleplay. ${common} Subject: the scene in the latest message, with the characters present and what they are doing.]`;
  }
}

export const isSafeImageSrc = (src) => typeof src === 'string'
  && (/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(src) || /^https:\/\/image\.pollinations\.ai\/prompt\/[^"'<>\s]+$/.test(src));

const ASPECT_SIZE = { '1:1': [1024, 1024], '2:3': [832, 1248], '3:2': [1248, 832], '9:16': [768, 1344], '16:9': [1344, 768] };
export const aspectSize = (a) => ASPECT_SIZE[a] || ASPECT_SIZE['1:1'];

// ---------- TTS ----------
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

/** Plain text to speak: strips HTML/markdown; optionally only "dialogue" and no *actions*. */
export function speakableText(text, { dialogueOnly = false, skipActions = false } = {}) {
  let t = String(text || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');
  if (dialogueOnly) {
    const parts = t.match(/"[^"\n]+"|“[^”\n]+”/g);
    return parts ? parts.map((p) => p.slice(1, -1)).join(' … ') : '';
  }
  if (skipActions) t = t.replace(/\*[^*\n]+\*/g, ' ');
  return t.replace(/[*_~`#>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------- expressions ----------
export const EXPRESSIONS = ['admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring', 'confusion', 'curiosity', 'desire',
  'disappointment', 'disapproval', 'disgust', 'embarrassment', 'excitement', 'fear', 'gratitude', 'grief', 'joy', 'love', 'nervousness',
  'neutral', 'optimism', 'pride', 'realization', 'relief', 'remorse', 'sadness', 'surprise'];

export function pickExpression(answer, labels) {
  const a = String(answer || '').toLowerCase();
  const exact = labels.find((l) => new RegExp(`\\b${l}\\b`).test(a));
  return exact || (labels.includes('neutral') ? 'neutral' : labels[0] || null);
}

// ---------- recall (vector storage) ----------
const STOP = new Set('a an and are as at be but by for from had has have he her his i in is it its me my not of on or our she so that the their them then there they this to was we were what when which who will with you your'.split(' '));
export const tokenize = (s) => String(s || '').toLowerCase().replace(/<[^>]+>/g, ' ').split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 2 && !STOP.has(w));

/** BM25 keyword relevance: docs [{id, text}] → [{id, score}] (score normalised 0..1). */
export function bm25(query, docs, k1 = 1.4, b = 0.75) {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokenize(d.text));
  const avg = toks.reduce((s, t) => s + t.length, 0) / toks.length || 1;
  const df = new Map();
  toks.forEach((t) => new Set(t).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  const N = docs.length;
  const scores = toks.map((t, i) => {
    const tf = new Map();
    t.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    let s = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg)));
    }
    return { id: docs[i].id, score: s };
  });
  const max = Math.max(...scores.map((x) => x.score), 0) || 1;
  return scores.map((x) => ({ ...x, score: x.score / max })).filter((x) => x.score > 0).sort((a, c) => c.score - a.score);
}

export function cosine(a, b) {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

export function packVector(arr) {
  const f = new Float32Array(arr);
  let s = '';
  const u = new Uint8Array(f.buffer);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unpackVector(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Float32Array(u.buffer);
}
