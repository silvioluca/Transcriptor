// Worker sintesi vocale: Piper (VITS) su onnxruntime-web. Testo in ingresso, audio in uscita.
// Worker classico (non modulo): il fonemizzatore espeak-ng è distribuito come script.
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const PH_BASE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const CACHE = 'transcriptor-tts';

importScripts(ORT_BASE + 'ort.wasm.min.js', PH_BASE + '.js');
ort.env.wasm.wasmPaths = ORT_BASE;

const MAX_VOICES = 3; // una trascrizione alterna più voci: le tengo pronte invece di ricaricarle
const voices = new Map(); // key -> { key, session, config }, la più recente in fondo
let phWasm = null;
let phData = null;

const post = (m, t) => self.postMessage(m, t || []);

// scarica una volta, poi dalla cache del browser
async function fetchCached(url, label) {
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {}
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download non riuscito (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  const reader = r.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    post({ type: 'progress', label, loaded, total });
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  try { await cache?.put(url, new Response(buf.slice(), { headers: { 'content-type': 'application/octet-stream' } })); } catch {}
  return buf;
}

async function loadVoice(v) {
  const hit = voices.get(v.key);
  if (hit) { voices.delete(v.key); voices.set(v.key, hit); return hit; }
  let model;
  let config;
  if (v.url) {
    config = JSON.parse(new TextDecoder().decode(await fetchCached(v.url + '.json', 'voce')));
    model = await fetchCached(v.url, 'voce');
  } else {
    config = v.config;
    model = new Uint8Array(await v.onnx.arrayBuffer());
  }
  if (config.phoneme_type && config.phoneme_type !== 'espeak') throw new Error('Voce non supportata: servono fonemi espeak.');
  post({ type: 'stage', text: 'Preparo la voce' });
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  while (voices.size >= MAX_VOICES) {
    const [oldKey, old] = voices.entries().next().value;
    voices.delete(oldKey);
    try { await old.session.release(); } catch {}
  }
  const voice = { key: v.key, session, config };
  voices.set(v.key, voice);
  return voice;
}

// testo -> identificativi dei fonemi (espeak-ng compilato in WebAssembly)
async function phonemize(text, lang) {
  if (!phWasm) {
    phWasm = await fetchCached(PH_BASE + '.wasm', 'fonemi');
    phData = await fetchCached(PH_BASE + '.data', 'fonemi');
  }
  const lines = [];
  const errs = [];
  const mod = await createPiperPhonemize({
    wasmBinary: phWasm,
    getPreloadedPackage: () => phData.slice().buffer,
    print: (s) => lines.push(s),
    printErr: (s) => errs.push(s),
  });
  try {
    mod.callMain(['-l', lang, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  } catch {
    throw new Error(`Lingua "${lang}" non disponibile nel fonemizzatore.` + (errs.length ? ' ' + errs.join(' ') : ''));
  }
  const ids = [];
  for (const l of lines) { try { ids.push(...JSON.parse(l).phoneme_ids); } catch {} }
  return ids;
}

async function speak({ id, text, voice: spec, speed }) {
  const t0 = performance.now();
  const v = await loadVoice(spec);
  const ids = await phonemize(text, v.config.espeak?.voice || 'it');
  const rate = v.config.audio?.sample_rate || 22050;
  if (ids.length < 4) { post({ type: 'audio', id, pcm: new Float32Array(0), rate }); return; }
  const inf = v.config.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / (speed || 1), inf.noise_w ?? 0.8]), [3]),
  };
  if ((v.config.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const out = await v.session.run(feeds);
  const pcm = Float32Array.from((out.output || Object.values(out)[0]).data);
  post({ type: 'audio', id, pcm, rate, ms: performance.now() - t0 }, [pcm.buffer]);
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  chain = chain.then(async () => {
    try {
      if (m.type === 'speak') await speak(m);
    } catch (err) {
      post({ type: 'error', id: m.id, text: String(err && err.message || err) });
    }
  });
};
