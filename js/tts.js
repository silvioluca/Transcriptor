// Sintesi vocale: voci Piper pronte o addestrate (nel browser) e voci clonate (server locale XTTS-v2).
import { download } from './export.js';

const $ = (id) => document.getElementById(id);

const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
// [id Piper, nome, lingua, MB da scaricare]
const PRESETS = [
  ['it_IT-paola-medium', 'Paola', 'Italiano', 64],
  ['it_IT-serena-medium', 'Serena', 'Italiano', 64],
  ['it_IT-riccardo-x_low', 'Riccardo, leggera', 'Italiano', 28],
  ['en_US-lessac-medium', 'Lessac', 'Inglese', 63],
  ['en_US-ryan-medium', 'Ryan', 'Inglese', 63],
  ['en_GB-alba-medium', 'Alba', 'Inglese britannico', 63],
  ['fr_FR-siwis-medium', 'Siwis', 'Francese', 63],
  ['es_ES-davefx-medium', 'Davefx', 'Spagnolo', 63],
  ['de_DE-thorsten-medium', 'Thorsten', 'Tedesco', 63],
  ['pt_BR-faber-medium', 'Faber', 'Portoghese', 63],
];
const presetUrl = (id) => {
  const [loc, name, q] = id.split('-');
  return `${HF}${loc.slice(0, 2)}/${loc}/${name}/${q}/${id}.onnx`;
};
const FIRST = 'preset:' + PRESETS[0][0];

const REF_SR = 24000; // campione per la clonazione: mono, 24 kHz
const REF_MIN = 5;
const REF_MAX = 30;
const AHEAD = 90; // secondi di audio generati in anticipo rispetto all'ascolto
const GAP = 0.3; // pausa tra una persona e la successiva

const TKEY = 'transcriptor.tts';
const T = { voice: FIRST, speed: 1, server: 'http://127.0.0.1:8020', lang: 'it' };
try { Object.assign(T, JSON.parse(localStorage.getItem(TKEY) || '{}')); } catch {}
const saveT = () => { try { localStorage.setItem(TKEY, JSON.stringify(T)); } catch {} };

let ui = null; // { el, toast, onDoc, onVoices, manageVoices }
let mine = []; // voci dell'utente: { id, kind: 'piper' | 'clone', name, ... }
const D = { voice: '' }; // testo aperto

/* ---------------- archivio voci (IndexedDB, solo in questo browser) ---------------- */
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('transcriptor-tts', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('voices', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbRun(mode, fn) {
  const d = await openDb();
  return new Promise((res, rej) => {
    const tx = d.transaction('voices', mode);
    const rq = fn(tx.objectStore('voices'));
    tx.oncomplete = () => { d.close(); res(rq.result); };
    tx.onerror = tx.onabort = () => { d.close(); rej(tx.error); };
  });
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------------- voci ---------------- */
function findVoice(key) {
  if (!key) return null;
  if (key.startsWith('preset:')) {
    const p = PRESETS.find((x) => x[0] === key.slice(7));
    return p ? { key, kind: 'preset', name: p[1], url: presetUrl(p[0]), mb: p[3] } : null;
  }
  const v = mine.find((x) => x.id === key);
  return v ? { ...v, key: v.id } : null;
}
// chiave salvata -> voce; se non c'è più (o non è di questo browser) vale quella predefinita
const voiceOf = (key) => findVoice(key) || findVoice(T.voice) || findVoice(FIRST);

// riempie un menu a tendina con tutte le voci; defaultLabel aggiunge la scelta "predefinita"
export function fillVoices(select, value, defaultLabel) {
  const { el } = ui;
  const group = (label, items) => (items.length ? el('optgroup', { label }, ...items) : null);
  select.replaceChildren(...[
    defaultLabel ? el('option', { value: '' }, `${defaultLabel} (${voiceOf(T.voice).name})`) : null,
    group('Voci pronte', PRESETS.map((p) => el('option', { value: 'preset:' + p[0] }, `${p[1]} (${p[2]})`))),
    group('Voci Piper addestrate', mine.filter((v) => v.kind === 'piper').map((v) => el('option', { value: v.id }, v.name))),
    group('Voci clonate', mine.filter((v) => v.kind === 'clone').map((v) => el('option', { value: v.id }, v.name))),
  ].filter(Boolean));
  select.value = findVoice(value) ? value : defaultLabel ? '' : voiceOf(value).key;
}

function renderVoices() {
  const { el } = ui;
  fillVoices($('ttsVoice'), D.voice || T.voice);
  const v = voiceOf($('ttsVoice').value);
  $('ttsVoiceInfo').textContent = v.kind === 'preset'
    ? `Si scarica una volta (${v.mb} MB), poi resta in questo browser. La voce si genera sul dispositivo.`
    : v.kind === 'piper'
      ? 'Voce importata: si genera sul dispositivo, anche senza rete.'
      : 'Voce clonata: serve il server di clonazione acceso.';
  $('ttsLangBox').hidden = v.kind !== 'clone';

  $('ttsMineBox').hidden = !mine.length;
  $('ttsMine').replaceChildren(...mine.map((m) => el('li', {},
    el('span', {}, el('b', {}, m.name), el('small', {}, m.kind === 'piper' ? `Piper, ${Math.round(m.size / 1e6)} MB` : `Clonata, campione di ${Math.round(m.sec)} s`)),
    el('button', { class: 'btn small', type: 'button', onclick: () => removeVoice(m) }, 'Elimina'))));
  ui.onVoices?.();
}

async function addVoice(v) {
  await dbRun('readwrite', (s) => s.put(v));
  mine.push(v);
  renderVoices();
}

async function removeVoice(v) {
  try { await dbRun('readwrite', (s) => s.delete(v.id)); } catch (e) { ui.toast('Eliminazione non riuscita: ' + (e.message || e)); return; }
  mine = mine.filter((x) => x.id !== v.id);
  if (T.voice === v.id) { T.voice = FIRST; saveT(); }
  renderVoices();
}

/* ---------------- Piper nel browser ---------------- */
let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./tts-worker.js', import.meta.url));
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      const p = m.total ? Math.min(1, m.loaded / m.total) : 0;
      R.h?.progress(p, `Scarico ${m.label === 'fonemi' ? 'il dizionario dei fonemi' : 'la voce'}${m.total ? ' ' + Math.round(p * 100) + '%' : ''}`);
    } else if (m.type === 'stage') {
      R.h?.progress(null);
      R.h?.status(m.text);
    } else {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'audio') p.res({ pcm: m.pcm, rate: m.rate });
      else p.rej(new Error(m.text));
    }
  };
  // script del motore non caricato (rete assente): si riprova alla prossima lettura
  worker.onerror = (e) => {
    e.preventDefault?.();
    worker.terminate();
    worker = null;
    for (const p of pending.values()) p.rej(new Error('Motore vocale non caricato. Controlla la connessione e riprova.'));
    pending.clear();
  };
  return worker;
}

function piperChunk(v, text) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    const voice = v.kind === 'preset' ? { key: v.key, url: v.url } : { key: v.key, onnx: v.onnx, config: v.config };
    getWorker().postMessage({ type: 'speak', id, text, voice, speed: T.speed });
  });
}

/* ---------------- voce clonata: server locale ---------------- */
const serverUrl = () => (T.server || '').trim().replace(/\/+$/, '');

async function serverFetch(path, body) {
  try {
    return await fetch(serverUrl() + path, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {});
  } catch {
    throw new Error(`Server di clonazione non raggiungibile su ${serverUrl() || '(indirizzo mancante)'}. Avvialo e riprova.`);
  }
}

const toBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

async function cloneChunk(v, text, lang) {
  const body = { text, language: lang || T.lang, speed: T.speed, voice: v.sha };
  let r = await serverFetch('/tts', body);
  if (r.status === 428) { // il server non conosce ancora questa voce: mando il campione
    body.ref_wav_b64 = await toBase64(v.ref);
    r = await serverFetch('/tts', body);
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `Il server di clonazione ha risposto ${r.status}.`);
  }
  return parseWav(await r.arrayBuffer());
}

async function testServer() {
  const info = $('ttsServerInfo');
  info.textContent = 'Controllo…';
  try {
    const r = await serverFetch('/health');
    const j = await r.json();
    info.textContent = r.ok && j.ok
      ? `Server attivo: ${j.model} su ${j.device === 'cuda' ? 'scheda grafica' : 'processore (lento)'}.`
      : 'Il server risponde ma non è pronto.';
  } catch (e) {
    info.textContent = e instanceof SyntaxError ? 'A questo indirizzo non risponde il server di clonazione.' : e.message;
  }
}

/* ---------------- WAV ---------------- */
function toInt16(pcm) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function wavBytes(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const d = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); d.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  str(36, 'data'); d.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) d.setInt16(44 + i * 2, pcm[i], true);
  return buf;
}

// WAV PCM 16 bit mono, come lo produce il server
function parseWav(buf) {
  const d = new DataView(buf);
  const tag = (o) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Risposta del server non valida.');
  let rate = REF_SR;
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const size = d.getUint32(o + 4, true);
    if (tag(o) === 'fmt ') rate = d.getUint32(o + 12, true);
    if (tag(o) === 'data') {
      const n = Math.min(size, buf.byteLength - o - 8) >> 1;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = d.getInt16(o + 8 + i * 2, true) / 0x8000;
      return { pcm, rate };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('Risposta del server non valida.');
}

// voci diverse possono avere frequenze diverse: nel file finale ne serve una sola
function resample(pcm, from, to) {
  if (from === to) return pcm;
  const out = new Int16Array(Math.round(pcm.length * to / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const a = Math.floor(x);
    const p0 = pcm[a] ?? 0;
    out[i] = p0 + ((pcm[a + 1] ?? p0) - p0) * (x - a);
  }
  return out;
}

/* ---------------- testo -> parti ---------------- */
// una parte = poche frasi: l'audio parte presto e i modelli non ricevono testi troppo lunghi
export function splitText(text, max = 200) {
  const out = [];
  for (const para of text.split(/\n+/)) {
    let cur = '';
    for (let s of para.split(/(?<=[.!?…]["»”)]?)\s+/)) {
      s = s.trim();
      if (!s) continue;
      if (cur && cur.length + s.length + 1 > max) { out.push(cur); cur = ''; }
      while (s.length > max) { // frase lunghissima: taglio a una virgola o a uno spazio
        const comma = s.lastIndexOf(',', max);
        const space = s.lastIndexOf(' ', max);
        const cut = comma > max * 0.4 ? comma + 1 : space > 0 ? space : max;
        out.push(s.slice(0, cut));
        s = s.slice(cut).trim();
      }
      cur = cur ? cur + ' ' + s : s;
    }
    if (cur) out.push(cur);
  }
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/* ---------------- riproduzione ---------------- */
const P = { ctx: null, next: 0, nodes: new Set(), timers: new Set(), idle: null };

// accoda l'audio; restituisce tra quanti secondi inizierà a suonare
function enqueue(pcm, rate, gap = 0) {
  const buf = P.ctx.createBuffer(1, pcm.length, rate);
  buf.copyToChannel(pcm, 0);
  const n = P.ctx.createBufferSource();
  n.buffer = buf;
  n.connect(P.ctx.destination);
  const at = Math.max(P.ctx.currentTime + 0.06, P.next + gap);
  n.start(at);
  P.next = at + buf.duration;
  P.nodes.add(n);
  n.onended = () => { P.nodes.delete(n); if (!P.nodes.size) P.idle?.(); };
  return at - P.ctx.currentTime;
}

function later(sec, fn) {
  const t = setTimeout(() => { P.timers.delete(t); fn(); }, Math.max(0, sec * 1000));
  P.timers.add(t);
}

function stopAudio() {
  for (const n of P.nodes) { n.onended = null; try { n.stop(); } catch {} }
  P.nodes.clear();
  for (const t of P.timers) clearTimeout(t);
  P.timers.clear();
  P.next = 0;
  P.idle?.();
}

const drained = () => new Promise((res) => {
  P.idle = () => { P.idle = null; res(); };
  if (!P.nodes.size) P.idle();
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* ---------------- lettura ---------------- */
// una lettura alla volta in tutta l'app; h = comandi dell'interfaccia che l'ha avviata
const R = { token: 0, h: null, parts: [], complete: false };

// comandi per un gruppo di controlli con lo stesso prefisso (tts… oppure reader…)
function controls(prefix, onItem) {
  return {
    prefix,
    onItem,
    busy(on) { $(prefix + 'Play').hidden = on; $(prefix + 'Stop').hidden = !on; },
    ready(ok) { $(prefix + 'Save').disabled = !ok; },
    status(t) { $(prefix + 'Status').textContent = t; },
    progress(p, label) {
      $(prefix + 'Progress').hidden = p == null;
      if (p != null) $(prefix + 'ProgressBar').style.width = Math.round(p * 100) + '%';
      if (label) this.status(label);
    },
  };
}

function finish(h, text) {
  if (R.h === h) R.h = null;
  h.progress(null);
  h.busy(false);
  h.status(text);
  h.onItem?.(-1);
}

export function stopSpeaking() {
  const h = R.h;
  if (!h) return;
  R.token++;
  stopAudio();
  finish(h, 'Lettura interrotta.');
}

export const speakingIn = () => R.h?.prefix || null;

// items: [{ text, voice, lang }] letti in ordine, ognuno con la sua voce.
// prefix: quale gruppo di controlli mostra stato e pulsanti; onItem(i) segnala l'elemento che sta suonando (-1 = fine).
export async function speak(prefix, items, onItem) {
  stopSpeaking();
  const h = controls(prefix, onItem);
  const jobs = [];
  items.forEach((it, i) => {
    const voice = voiceOf(it.voice);
    for (const text of splitText(it.text)) jobs.push({ i, text, voice, lang: it.lang });
  });
  if (!jobs.length) { h.status('Niente da leggere.'); return; }
  const token = ++R.token;
  R.h = h;
  R.parts = [];
  R.complete = false;
  if (!P.ctx) P.ctx = new AudioContext();
  if (P.ctx.state === 'suspended') await P.ctx.resume();
  $('ttsSave').disabled = $('readerSave').disabled = true; // il file da scaricare è sempre l'ultima lettura
  h.busy(true);
  try {
    let shown = -1;
    for (let n = 0; n < jobs.length; n++) {
      while (P.next - P.ctx.currentTime > AHEAD) {
        h.status('Lettura in corso');
        await sleep(400);
        if (token !== R.token) return;
      }
      const j = jobs[n];
      h.status(jobs.length > 1 ? `Genero la parte ${n + 1} di ${jobs.length}` : 'Genero la voce');
      const a = j.voice.kind === 'clone' ? await cloneChunk(j.voice, j.text, j.lang) : await piperChunk(j.voice, j.text);
      if (token !== R.token) return;
      h.progress(null);
      if (!a.pcm.length) continue;
      const turn = j.i !== shown;
      const gap = turn && R.parts.length ? GAP : 0;
      if (gap) R.parts.push({ pcm: new Int16Array(Math.round(a.rate * gap)), rate: a.rate });
      R.parts.push({ pcm: toInt16(a.pcm), rate: a.rate });
      const wait = enqueue(a.pcm, a.rate, gap);
      if (turn) {
        shown = j.i;
        if (onItem) later(wait, () => onItem(j.i));
      }
    }
    R.complete = R.parts.length > 0;
    h.ready(R.complete);
    h.status(R.complete ? 'Lettura in corso' : 'Niente da leggere in questo testo.');
    await drained();
    if (token !== R.token) return;
    finish(h, R.complete ? '' : 'Niente da leggere in questo testo.');
  } catch (e) {
    if (token !== R.token) return;
    stopAudio();
    finish(h, e.message || String(e));
    ui.toast(e.message || String(e), 7000);
  }
}

// salva l'ultima lettura completata
function saveSpeech(name) {
  if (!R.complete) return;
  const rate = Math.max(...R.parts.map((p) => p.rate));
  const parts = R.parts.map((p) => resample(p.pcm, p.rate, rate));
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  download(wavBytes(all, rate), `${name || 'voce'}.wav`, 'audio/wav');
}

/* ---------------- testo aperto ---------------- */
export function setDoc({ text, voice }) {
  $('ttsText').value = text || '';
  D.voice = voice || '';
  $('ttsSave').disabled = true;
  $('ttsStatus').textContent = '';
  if (ui) renderVoices();
}

function playDoc() {
  if (!splitText($('ttsText').value).length) { ui.toast('Scrivi il testo da leggere.'); $('ttsText').focus(); return; }
  speak('tts', [{ text: $('ttsText').value, voice: $('ttsVoice').value }]);
}

/* ---------------- aggiunta voce Piper addestrata ---------------- */
async function addPiper() {
  const files = [...$('ttsPiperFiles').files];
  const onnx = files.find((f) => /\.onnx$/i.test(f.name));
  const json = files.find((f) => /\.json$/i.test(f.name));
  if (!onnx || !json) { ui.toast('Scegli entrambi i file: .onnx e .onnx.json.', 5000); return; }
  let config;
  try { config = JSON.parse(await json.text()); } catch { ui.toast('Il file .json non è leggibile.'); return; }
  if (!config.phoneme_id_map || !config.audio?.sample_rate || !config.espeak?.voice) {
    ui.toast('Il file .json non è la configurazione di una voce Piper.', 5000);
    return;
  }
  const name = $('ttsPiperName').value.trim() || onnx.name.replace(/\.onnx$/i, '');
  try {
    await addVoice({ id: 'piper:' + uid(), kind: 'piper', name, onnx: onnx.slice(0, onnx.size, 'application/octet-stream'), config, size: onnx.size });
  } catch (e) {
    ui.toast('Voce non salvata: ' + (e.message || e), 6000);
    return;
  }
  $('ttsPiperName').value = '';
  $('ttsPiperFiles').value = '';
  ui.toast(`Voce "${name}" aggiunta: la trovi nei menu delle voci.`, 5000);
}

/* ---------------- aggiunta voce clonata ---------------- */
let ref = null; // { wav: Blob, sec, sha }
let mic = null; // registrazione del campione in corso

// qualsiasi audio -> WAV mono 24 kHz, al massimo 30 s
async function toRef(blob) {
  const ctx = new OfflineAudioContext(1, 1, REF_SR);
  let src;
  try { src = await ctx.decodeAudioData(await blob.arrayBuffer()); } catch { throw new Error('Formato audio non leggibile da questo browser.'); }
  const n = Math.min(src.length, REF_SR * REF_MAX);
  if (n < REF_SR * REF_MIN) throw new Error(`Campione troppo corto: servono almeno ${REF_MIN} secondi.`);
  const mono = new Float32Array(n);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const d = src.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / src.numberOfChannels;
  }
  const bytes = wavBytes(toInt16(mono), REF_SR);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    wav: new Blob([bytes], { type: 'audio/wav' }),
    sec: n / REF_SR,
    sha: [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

async function setRef(blob) {
  const prev = $('ttsClonePreview');
  try {
    ref = await toRef(blob);
  } catch (e) {
    ref = null;
    prev.hidden = true;
    $('ttsCloneInfo').textContent = e.message;
    return;
  }
  if (prev.src) URL.revokeObjectURL(prev.src);
  prev.src = URL.createObjectURL(ref.wav);
  prev.hidden = false;
  $('ttsCloneInfo').textContent = `Campione pronto: ${Math.round(ref.sec)} s.`;
}

async function toggleMic() {
  const btn = $('ttsCloneRec');
  if (mic) { mic.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch {
    ui.toast('Microfono non disponibile o permesso negato.', 5000);
    return;
  }
  const parts = [];
  const t0 = Date.now();
  mic = new MediaRecorder(stream);
  const mr = mic;
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    btn.textContent = `Ferma (${s} s)`;
    if (s >= REF_MAX && mr.state === 'recording') mr.stop();
  }, 250);
  mr.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  mr.onstop = () => {
    clearInterval(tick);
    stream.getTracks().forEach((t) => t.stop());
    mic = null;
    btn.textContent = 'Registra dal microfono';
    $('ttsCloneFile').value = '';
    setRef(new Blob(parts, { type: mr.mimeType }));
  };
  btn.textContent = 'Ferma (0 s)';
  $('ttsCloneInfo').textContent = `Leggi un testo con voce naturale per ${REF_MIN}–${REF_MAX} secondi.`;
  mr.start();
}

async function addClone() {
  if (!ref) { ui.toast('Scegli o registra prima un campione audio.', 5000); return; }
  const name = $('ttsCloneName').value.trim() || 'Voce clonata';
  try {
    await addVoice({ id: 'clone:' + uid(), kind: 'clone', name, ref: ref.wav, sec: ref.sec, sha: ref.sha });
  } catch (e) {
    ui.toast('Voce non salvata: ' + (e.message || e), 6000);
    return;
  }
  ref = null;
  $('ttsCloneName').value = '';
  $('ttsCloneFile').value = '';
  $('ttsClonePreview').hidden = true;
  $('ttsCloneInfo').textContent = '';
  ui.toast(`Voce "${name}" aggiunta. Per usarla tieni acceso il server di clonazione.`, 6000);
}

/* ---------------- avvio ---------------- */
// i due cursori della velocità (testo e trascrizione) regolano lo stesso valore
function bindSpeed() {
  const ids = ['ttsSpeed', 'readerSpeed'];
  const show = () => ids.forEach((id) => { $(id).value = T.speed; $(id + 'Out').textContent = Number(T.speed).toFixed(2) + '×'; });
  ids.forEach((id) => $(id).addEventListener('input', (e) => { T.speed = Number(e.target.value); saveT(); show(); }));
  show();
}

export async function initTTS(hooks) {
  ui = hooks;
  bindSpeed();
  $('ttsLang').value = T.lang;
  $('ttsLang').addEventListener('change', (e) => { T.lang = e.target.value; saveT(); });
  $('ttsServer').value = T.server;
  $('ttsServer').addEventListener('change', (e) => { T.server = e.target.value.trim(); saveT(); $('ttsServerInfo').textContent = ''; });
  $('ttsVoice').addEventListener('change', (e) => {
    D.voice = T.voice = e.target.value; // l'ultima voce scelta diventa quella predefinita
    saveT();
    renderVoices();
    ui.onDoc();
  });
  $('ttsText').addEventListener('input', () => ui.onDoc());
  $('ttsPlay').addEventListener('click', playDoc);
  $('ttsStop').addEventListener('click', stopSpeaking);
  $('ttsSave').addEventListener('click', () => saveSpeech(ui.fileName()));
  $('readerSave').addEventListener('click', () => saveSpeech(ui.fileName()));
  $('readerStop').addEventListener('click', stopSpeaking);
  $('ttsManage').addEventListener('click', () => ui.manageVoices());
  $('readerManage').addEventListener('click', () => ui.manageVoices());
  $('ttsPiperAdd').addEventListener('click', addPiper);
  $('ttsServerTest').addEventListener('click', testServer);
  $('ttsCloneFile').addEventListener('change', (e) => { if (e.target.files[0]) setRef(e.target.files[0]); });
  $('ttsCloneRec').addEventListener('click', toggleMic);
  $('ttsCloneAdd').addEventListener('click', addClone);
  try {
    mine = await dbRun('readonly', (s) => s.getAll());
  } catch (e) {
    console.warn('voci salvate non disponibili', e);
  }
  renderVoices();
}

export const docState = () => ({ text: $('ttsText').value, voice: D.voice });
