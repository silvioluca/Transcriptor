// Worker modelli: Whisper (trascrizione) + WeSpeaker (impronta vocale).
// Audio ricevuto, elaborato, scartato. Nessun salvataggio.
import {
  pipeline,
  AutoFeatureExtractor,
  AutoModel,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

const ASR_MODELS = {
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
  turbo: 'onnx-community/whisper-large-v3-turbo',
};
const SPK_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

let asr = null;
let spkFx = null;
let spkModel = null;
let loaded = null; // chiave config caricata
let opts = { language: 'italian' };

const post = (m, t) => self.postMessage(m, t || []);

async function gpuInfo() {
  if (!('gpu' in navigator)) return { ok: false, f16: false };
  try {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { ok: false, f16: false };
    return { ok: true, f16: a.features.has('shader-f16') };
  } catch {
    return { ok: false, f16: false };
  }
}

function progress(stage) {
  return (p) => {
    if (p.status === 'progress' || p.status === 'done' || p.status === 'initiate') {
      post({ type: 'progress', stage, file: p.file, loaded: p.loaded || 0, total: p.total || 0, status: p.status });
    }
  };
}

async function loadASR(size, device, f16) {
  let dtype;
  if (device === 'webgpu') {
    dtype = {
      encoder_model: size === 'turbo' ? 'fp16' : 'fp32',
      decoder_model_merged: 'q4',
    };
  } else {
    dtype = { encoder_model: 'q8', decoder_model_merged: 'q8' };
  }
  const p = await pipeline('automatic-speech-recognition', ASR_MODELS[size], {
    device,
    dtype,
    progress_callback: progress('asr'),
  });
  // riscaldamento: compila shader / alloca memoria
  await p(new Float32Array(16000), { language: opts.language || null, task: 'transcribe' });
  return p;
}

async function load({ size, language, speakers }) {
  opts.language = language === 'auto' ? null : language;
  const key = `${size}|${speakers}`;
  if (loaded === key && asr) {
    post({ type: 'ready', device: self.__device, size: self.__size });
    return;
  }
  const g = await gpuInfo();
  let device = g.ok ? 'webgpu' : 'wasm';
  let realSize = size;
  if (size === 'turbo' && !(g.ok && g.f16)) {
    realSize = 'small';
    post({ type: 'notice', text: 'Modello grande richiede GPU con fp16. Uso modello medio.' });
  }

  if (asr) { try { await asr.dispose(); } catch {} asr = null; }

  if (size === 'none') {
    // trascrizione nel cloud: qui serve solo il modello voci
    device = 'cloud';
    realSize = 'none';
  } else {
    post({ type: 'stage', text: 'Scarico modello trascrizione' });
    try {
      asr = await loadASR(realSize, device, g.f16);
    } catch (e) {
      if (device === 'webgpu') {
        post({ type: 'notice', text: 'GPU non disponibile per il modello. Passo a CPU, più lento.' });
        device = 'wasm';
        if (realSize === 'turbo') realSize = 'small';
        asr = await loadASR(realSize, device, false);
      } else {
        throw e;
      }
    }
  }

  if (speakers && !spkModel) {
    post({ type: 'stage', text: 'Scarico modello voci' });
    spkFx = await AutoFeatureExtractor.from_pretrained(SPK_MODEL, { progress_callback: progress('spk') });
    spkModel = await AutoModel.from_pretrained(SPK_MODEL, {
      device: 'wasm',
      dtype: 'fp32',
      progress_callback: progress('spk'),
    });
  }

  loaded = key;
  self.__device = device;
  self.__size = realSize;
  post({ type: 'ready', device, size: realSize });
}

async function embed(audio) {
  if (!spkModel) return null;
  const inputs = await spkFx(audio);
  const out = await spkModel(inputs);
  const t = out.embeddings || out.embedding || out.last_hidden_state || Object.values(out)[0];
  const v = Float32Array.from(t.data);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

async function job({ id, kind, audio, wantEmbed }) {
  const t0 = performance.now();
  const sec = audio.length / 16000;
  if (kind === 'embed') {
    let emb = null;
    if (sec >= 0.6) { try { emb = await embed(audio); } catch (e) { console.warn('embed', e); } }
    post({ type: 'result', id, kind, emb, sec, ms: performance.now() - t0 }, emb ? [emb.buffer] : []);
    return;
  }
  const r = await asr(audio, {
    language: opts.language,
    task: 'transcribe',
    ...(sec > 29 ? { chunk_length_s: 30, stride_length_s: 5 } : {}),
  });
  let emb = null;
  if (wantEmbed && sec >= 0.6) {
    try { emb = await embed(audio); } catch (e) { console.warn('embed', e); }
  }
  const ms = performance.now() - t0;
  post({ type: 'result', id, kind, text: (r.text || '').trim(), emb, ms, sec }, emb ? [emb.buffer] : []);
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  chain = chain.then(async () => {
    try {
      if (m.type === 'load') await load(m);
      else if (m.type === 'job') await job(m);
      else if (m.type === 'lang') opts.language = m.language === 'auto' ? null : m.language;
    } catch (err) {
      post({ type: 'error', id: m.id, kind: m.kind, text: String(err && err.message || err) });
    }
  });
};
