import { Recorder, listMics, canCaptureTab } from './audio.js';
import { Speakers } from './speakers.js';
import * as store from './store.js';
import { build, download, slug, clock } from './export.js';
import { transcribeBatch } from './cloud.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};

/* ---------------- impostazioni ---------------- */
const SKEY = 'transcriptor.settings';
try { if (!localStorage.getItem(SKEY) && localStorage.getItem('verbale.settings')) localStorage.setItem(SKEY, localStorage.getItem('verbale.settings')); } catch {}
const defaults = {
  model: 'gpu' in navigator ? 'small' : 'base',
  lang: 'it',
  mic: '',
  spk: true,
  thr: 0.5,
  max: 6,
  live: true,
  vad: 0.5,
  pause: 700,
  buf: 180,
  source: 'mic', // mic | tab | both
  engine: 'local', // local | groq
  groqKey: '',
  groqModel: 'whisper-large-v3',
  merge: true,
  mergeGap: 8,
};
let settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch {}
const saveSettings = () => { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch {} };

/* ---------------- stato ---------------- */
const speakers = new Speakers();
const S = {
  conv: null,
  segs: [],
  rec: 'idle', // idle | rec | pause
  model: { ready: false, loading: false, device: null, size: null, files: new Map(), key: null },
  queue: [],
  busy: null, // job in corso
  lastInterim: 0,
  live: null, // {start, text}
  user: null,
  archive: { items: [], last: null, more: false, loading: false },
  dirty: false,
};
let localSeq = 0;

function freshConv() {
  const now = new Date();
  const f = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return { id: null, saved: false, title: 'Trascrizione del ' + f.format(now), createdAt: now, durationMs: 0 };
}

/* ---------------- worker modelli ---------------- */
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'progress': {
      if (!m.file) break;
      S.model.files.set(m.stage + m.file, { loaded: m.loaded, total: m.total, done: m.status === 'done' });
      let l = 0, t = 0;
      for (const f of S.model.files.values()) { if (f.total) { t += f.total; l += f.done ? f.total : f.loaded; } }
      if (t) showProgress(l / t, `Scarico modelli ${Math.round((l / t) * 100)}% di ${mb(t)}`);
      break;
    }
    case 'stage': status(m.text); break;
    case 'notice': toast(m.text, 5000); break;
    case 'ready':
      S.model.ready = true;
      S.model.loading = false;
      S.model.device = m.device;
      S.model.size = m.size;
      hideProgress();
      deviceInfo();
      updateStatus();
      if (S.model.key !== modelKey()) ensureModels();
      else pump();
      break;
    case 'result': onResult(m); break;
    case 'error':
      if (m.kind) {
        S.busy = null;
        if (m.kind === 'embed') {
          const j = S.queue.find((x) => x.id === m.id);
          if (j) { j.embDone = true; j.embBusy = false; }
        }
        if (m.kind === 'final') {
          const seg = S.segs.find((s) => s.id === m.id);
          if (seg) markLost(seg, 'Errore di trascrizione: ' + m.text);
        }
        pump();
      } else {
        S.model.loading = false;
        hideProgress();
        status('Modelli non caricati: ' + m.text);
        toast('Impossibile caricare i modelli. Controlla la connessione e riprova.', 6000);
        setRecButton();
      }
      break;
  }
};

const mb = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');

function modelKey() { return `${cloudMode() ? 'none' : settings.model}|${settings.spk}`; }

function ensureModels() {
  if (S.model.loading) return;
  if (S.model.ready && S.model.key === modelKey()) return;
  S.model.ready = false;
  S.model.loading = true;
  S.model.key = modelKey();
  S.model.files.clear();
  status('Preparo i modelli');
  showProgress(0);
  worker.postMessage({ type: 'load', size: cloudMode() ? 'none' : settings.model, language: settings.lang, speakers: settings.spk });
}

/* ---------------- registratore ---------------- */
const rec = new Recorder({
  onSegment: onSegment,
  onSpeechStart: () => { S.live = { text: '' }; renderLive(); },
  onLevel: (e, p) => {
    const w = Math.min(100, Math.sqrt(e) * 260);
    const b = $('levelBar');
    b.style.width = w + '%';
    b.classList.toggle('speech', p > rec.opt.pos);
  },
  onMisfire: () => { S.live = null; renderLive(); },
  onSourceEnded: () => {
    if (S.rec === 'idle') return;
    toast('Condivisione audio interrotta: registrazione terminata.', 5000);
    stopRec();
  },
});
applyRecOptions();

function applyRecOptions() {
  rec.setOptions({ pos: settings.vad, neg: Math.max(0.1, settings.vad - 0.15), redemptionMs: settings.pause });
  speakers.threshold = settings.thr;
  speakers.max = settings.max;
}

async function startRec() {
  if (!window.isSecureContext) { toast('Il microfono richiede HTTPS.'); return; }
  if (cloudMode() && !settings.groqKey) {
    toast('Per la trascrizione nel cloud serve una chiave Groq.', 5000);
    openSettings();
    $('optGroqKey').focus();
    return;
  }
  setRecButton('loading');
  try {
    try {
      await rec.start(settings.mic, S.conv.durationMs || 0, source());
    } catch (e) {
      if (!settings.mic || !['OverconstrainedError', 'NotFoundError'].includes(e && e.name)) throw e;
      settings.mic = '';
      saveSettings();
      await rec.start('', S.conv.durationMs || 0, source());
    }
  } catch (e) {
    setRecButton();
    const tabby = source() !== 'mic';
    const n = e && e.name;
    const msg = n === 'NoAudioError' || n === 'NotSupportedError'
      ? e.message
      : n === 'NotAllowedError'
        ? (tabby ? 'Condivisione annullata o non permessa.' : 'Permesso microfono negato. Abilitalo dalle impostazioni del browser.')
        : n === 'NotFoundError'
          ? 'Nessun microfono trovato.'
          : 'Audio non disponibile: ' + (e.message || e);
    toast(msg, 8000);
    return;
  }
  S.rec = 'rec';
  ensureModels();
  wakeLock(true);
  setRecButton();
  updateStatus();
  loop();
  refreshMics();
}

async function pauseRec() {
  await rec.pause();
  S.rec = 'pause';
  S.live = null;
  renderLive();
  wakeLock(false);
  setRecButton();
  updateStatus();
  saveMeta(true);
}

async function resumeRec() {
  await rec.resume();
  S.rec = 'rec';
  wakeLock(true);
  setRecButton();
  updateStatus();
  loop();
}

async function stopRec() {
  await rec.stop();
  S.conv.durationMs = Math.max(S.conv.durationMs || 0, rec.nowMs);
  S.rec = 'idle';
  S.live = null;
  renderLive();
  wakeLock(false);
  setRecButton();
  updateStatus();
  saveMeta(true);
  $('levelBar').style.width = '0';
}

const source = () => (canCaptureTab ? settings.source : 'mic');

function setRecButton(force) {
  const b = $('recBtn');
  const st = force || S.rec;
  b.dataset.state = st;
  b.setAttribute('aria-label', st === 'rec' ? 'Metti in pausa' : st === 'pause' ? 'Riprendi registrazione' : 'Avvia registrazione');
  b.title = b.getAttribute('aria-label');
  $('stopBtn').hidden = S.rec === 'idle';
  $('source').disabled = S.rec !== 'idle' || st === 'loading';
}

$('recBtn').addEventListener('click', () => {
  if ($('recBtn').dataset.state === 'loading') return;
  if (S.rec === 'idle') startRec();
  else if (S.rec === 'rec') pauseRec();
  else resumeRec();
});
$('stopBtn').addEventListener('click', stopRec);

if (!canCaptureTab) $('source').hidden = true;
$('source').value = source();
$('source').addEventListener('change', (e) => {
  settings.source = e.target.value;
  saveSettings();
  if (settings.source !== 'mic') toast(settings.source === 'both'
    ? 'Al via scegli la scheda (es. Meet) e attiva la condivisione audio. Usa le cuffie per evitare l\'eco.'
    : 'Al via scegli la scheda (es. YouTube) e attiva "Condividi anche l\'audio della scheda".', 6000);
});

/* ---------------- coda di trascrizione (solo RAM) ---------------- */
const cloudMode = () => settings.engine === 'groq';

function onSegment({ audio, startMs, endMs }) {
  const prev = lastSpeaker();
  const seg = {
    id: S.user ? store.newSegmentId(S.conv.id || ensureConvId()) : 'l' + Date.now().toString(36) + (localSeq++),
    start: Math.round(startMs),
    end: Math.round(endMs),
    speaker: prev,
    text: S.live && S.live.text ? S.live.text : '',
    status: 'pending',
  };
  S.segs.push(seg);
  S.live = rec.speaking ? { text: '' } : null;
  renderLine(seg);
  renderLive();
  $('empty').hidden = true;
  S.queue.push({ id: seg.id, audio, t: performance.now(), emb: null, embDone: !settings.spk, sec: audio.length / 16000 });
  enforceBuffer();
  pump();
  drawRibbon();
}

function queuedSec() {
  return S.queue.reduce((n, j) => n + j.audio.length, 0) / 16000;
}

function enforceBuffer() {
  while (S.queue.length > 1 && queuedSec() > settings.buf) {
    const j = S.queue.find((x) => !x.sending) ;
    if (!j) break;
    S.queue.splice(S.queue.indexOf(j), 1);
    const seg = S.segs.find((s) => s.id === j.id);
    if (seg) markLost(seg, cloudMode()
      ? 'Audio scartato: il servizio cloud non risponde. Controlla la connessione.'
      : 'Audio scartato: la trascrizione non tiene il passo. Scegli la qualità Veloce nelle impostazioni.');
  }
}

function pump() {
  if (cloudMode()) { pumpCloud(); return; }
  if (!S.model.ready || S.busy) { updateStatus(); return; }
  const j = S.queue.shift();
  if (j) {
    S.busy = { id: j.id, kind: 'final' };
    worker.postMessage({ type: 'job', id: j.id, kind: 'final', audio: j.audio, wantEmbed: settings.spk }, [j.audio.buffer]);
    updateStatus();
    return;
  }
  const liveOk = settings.live && S.rec === 'rec' && rec.speaking && (S.model.device === 'webgpu' || S.model.size === 'base');
  if (liveOk && performance.now() - S.lastInterim > 900) {
    const cur = rec.currentAudio();
    if (cur && cur.audio.length > 16000 * 0.8) {
      let a = cur.audio;
      if (a.length > 16000 * 28) a = a.slice(a.length - 16000 * 28);
      S.lastInterim = performance.now();
      S.busy = { id: 'live', kind: 'interim' };
      worker.postMessage({ type: 'job', id: 'live', kind: 'interim', audio: a, wantEmbed: false }, [a.buffer]);
    }
  }
  updateStatus();
}
setInterval(pump, 250);

/* ---------------- modalità cloud (Groq) ---------------- */
const C = { inflight: false, until: 0, stamps: [], paused: false };

function pumpCloud() {
  // 1. impronte vocali in locale, una alla volta
  if (settings.spk && S.model.ready && !S.busy) {
    const j = S.queue.find((x) => !x.embDone && !x.embBusy);
    if (j) {
      j.embBusy = true;
      S.busy = { id: j.id, kind: 'embed' };
      const copy = j.audio.slice();
      worker.postMessage({ type: 'job', id: j.id, kind: 'embed', audio: copy, wantEmbed: true }, [copy.buffer]);
    }
  }
  // 2. invio a Groq a gruppi (minimo fatturato 10 s, max 20 richieste/minuto)
  if (C.inflight || C.paused || !settings.groqKey) { updateStatus(); return; }
  const now = performance.now();
  if (now < C.until) { updateStatus(); return; }
  C.stamps = C.stamps.filter((t) => now - t < 60000);
  if (C.stamps.length >= 18) { updateStatus(); return; }
  const ready = [];
  let sec = 0;
  for (const j of S.queue) {
    if (j.sending) continue;
    if (!j.embDone) break;
    if (ready.length && sec + j.sec > 90) break;
    ready.push(j);
    sec += j.sec + 0.6;
  }
  if (!ready.length) { updateStatus(); return; }
  const waited = now - ready[0].t;
  const flushing = S.rec !== 'rec';
  const maxWait = rec.speaking ? 9000 : 6000; // se qualcuno sta parlando aspetto la sua frase
  if (sec < 10 && waited < maxWait && !flushing) { updateStatus(); return; }
  sendCloud(ready);
}

async function sendCloud(items) {
  C.inflight = true;
  C.stamps.push(performance.now());
  items.forEach((j) => { j.sending = true; });
  updateStatus();
  const ctx = S.segs.filter((s) => s.status === 'done').slice(-4).map((s) => s.text).join(' ');
  try {
    const out = await transcribeBatch(items, {
      key: settings.groqKey,
      model: settings.groqModel,
      language: settings.lang,
      prompt: ctx,
    });
    for (const j of items) {
      S.queue.splice(S.queue.indexOf(j), 1);
      finalize(j.id, out.get(j.id) || '', j.emb, j.sec);
    }
  } catch (e) {
    items.forEach((j) => { j.sending = false; });
    if (e.kind === 'auth') {
      C.paused = true;
      toast('Chiave Groq non valida. Inseriscila nelle impostazioni.', 8000);
    } else if (e.kind === 'rate') {
      C.until = performance.now() + e.retryAfter * 1000;
      toast(`Limite gratuito Groq raggiunto. Riprovo tra ${Math.round(e.retryAfter)} s.`, 5000);
    } else if (e.kind === 'bad') {
      // richiesta rifiutata: scarto il gruppo per non bloccare la coda
      for (const j of items) {
        S.queue.splice(S.queue.indexOf(j), 1);
        const seg = S.segs.find((s) => s.id === j.id);
        if (seg) markLost(seg, e.message);
      }
    } else {
      C.until = performance.now() + 5000;
      if (e.kind === 'network') status('Connessione assente, riprovo…');
    }
  }
  C.inflight = false;
  pump();
}

const JUNK = [
  /sottotitoli\s+(creati|e\s+revisione|a\s+cura)[^!?\n]*?(amara\.org|qtss|$)[.!]?/gi,
  /amara\.org/gi,
  /\bqtss\b/gi,
  /grazie\s+(a\s+tutti\s+)?(per\s+(la\s+)?visione|per\s+aver\s+guardato)[.!]?/gi,
  /iscriviti\s+al\s+(mio\s+)?canale[^.!?]*[.!?]?/gi,
  /thanks?\s+(you\s+)?for\s+watching[.!]?/gi,
  /\[[^\]]{0,40}\]|\((musica|applausi|risate|music|applause|laughter)\)/gi,
  /^\s*(\.{2,}|…)\s*$/g,
];

function clean(t) {
  let s = ' ' + (t || '') + ' ';
  for (const r of JUNK) s = s.replace(r, ' ');
  // anelli di ripetizione tipici di Whisper
  s = s.replace(/(\b[^.!?]{3,60}?[.!?,]?\s)(?:\1){2,}/gi, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  if (/^[\s.,!?…-]*$/.test(s)) return '';
  return s;
}

function onResult(m) {
  S.busy = null;
  if (m.kind === 'interim') {
    if (S.live && rec.speaking) { S.live.text = clean(m.text); renderLive(); }
    pump();
    return;
  }
  if (m.kind === 'embed') {
    const j = S.queue.find((x) => x.id === m.id);
    if (j) { j.emb = m.emb; j.embDone = true; j.embBusy = false; }
    pump();
    return;
  }
  finalize(m.id, m.text, m.emb, m.sec);
  pump();
}

// frase trascritta: assegna la persona, unisce se serve, salva
function finalize(id, rawText, emb, sec) {
  const seg = S.segs.find((s) => s.id === id);
  if (!seg) return;
  const text = clean(rawText);
  if (!text) { removeSeg(seg, false); return; }
  const idx = S.segs.indexOf(seg);
  const prev = idx > 0 ? S.segs.slice(0, idx).reverse().find((s) => s.status === 'done') : null;
  const before = speakers.list.length;
  if (settings.spk) {
    seg.speaker = speakers.assign(seg.id, emb, sec, prev?.speaker).id;
  } else {
    seg.speaker = (speakers.list[0] || speakers.create()).id;
  }
  seg.text = text;
  seg.status = 'done';
  if (canMerge(prev, seg) && S.segs[idx - 1] === prev) {
    mergeInto(prev, seg);
  } else {
    renderLine(seg);
    refreshCont(idx + 1);
    persistSeg(seg);
  }
  if (speakers.list.length !== before) renderPeople();
  else updatePeopleCounts();
  saveMeta();
  drawRibbon();
  updateBanner();
}

function canMerge(a, b) {
  return !!(settings.merge && a && b && a.status === 'done' && b.status === 'done'
    && a.speaker === b.speaker
    && b.start - a.end <= settings.mergeGap * 1000
    && a.text.length + b.text.length < 3000
    && document.activeElement !== a.el?._txt);
}

function mergeInto(a, b, persist = true) {
  const join = /[.!?…]$/.test(a.text) ? ' ' : (/^[a-zà-ù]/.test(b.text) ? ' ' : '. ');
  a.text = (a.text + join + b.text).replace(/\s+/g, ' ').trim();
  a.end = Math.max(a.end, b.end);
  speakers.absorb(a.id, b.id);
  const i = S.segs.indexOf(b);
  if (i >= 0) S.segs.splice(i, 1);
  b.el?.remove();
  renderLine(a);
  refreshCont(S.segs.indexOf(a) + 1);
  if (persist) persistSeg(a);
  if (persist && S.user && S.conv.saved && b.saved) store.deleteSegment(S.conv.id, b.id).catch(saveError);
}

// applica l'unione a tutta la trascrizione aperta
function mergeAllNow() {
  const changed = new Set();
  for (let i = 1; i < S.segs.length; i++) {
    const a = S.segs[i - 1];
    const b = S.segs[i];
    if (!canMerge(a, b)) continue;
    mergeInto(a, b, false);
    changed.add(a);
    if (S.user && S.conv.saved && b.saved) store.deleteSegment(S.conv.id, b.id).catch(saveError);
    changed.delete(b);
    i--;
  }
  changed.forEach(persistSeg);
  updatePeopleCounts();
  drawRibbon();
  saveMeta(true);
  return changed.size;
}

function markLost(seg, msg) {
  seg.status = 'lost';
  seg.text = msg;
  renderLine(seg);
  S.queue = S.queue.filter((j) => j.id !== seg.id);
}

function lastSpeaker() {
  for (let i = S.segs.length - 1; i >= 0; i--) if (S.segs[i].speaker) return S.segs[i].speaker;
  return null;
}

/* ---------------- archivio Firestore ---------------- */
function ensureConvId() {
  if (!S.conv.id && S.user) S.conv.id = store.newConversationId();
  return S.conv.id;
}

function convMeta() {
  const talk = {};
  for (const s of S.segs) if (s.status === 'done') talk[s.speaker] = (talk[s.speaker] || 0) + (s.end - s.start);
  const done = S.segs.filter((s) => s.status === 'done');
  return {
    title: S.conv.title,
    durationMs: Math.round(Math.max(S.conv.durationMs || 0, S.rec !== 'idle' ? rec.nowMs : 0)),
    speakers: speakers.toMap(),
    talk,
    segmentCount: done.length,
    preview: done.slice(0, 6).map((s) => s.text).join(' ').slice(0, 180),
    lang: settings.lang,
  };
}

function ensureConvSaved() {
  if (!S.user || S.conv.saved) return;
  ensureConvId();
  S.conv.saved = true;
  const meta = convMeta();
  store.createConversation(S.conv.id, meta).catch(saveError);
  upsertArchiveItem({ id: S.conv.id, ...meta, updatedAt: new Date() });
}

function persistSeg(seg) {
  if (!S.user || seg.status !== 'done') return;
  ensureConvSaved();
  seg.saved = true;
  store.saveSegment(S.conv.id, { id: seg.id, start: seg.start, end: seg.end, speaker: seg.speaker, text: seg.text }).catch(saveError);
}

let metaTimer = null;
function saveMeta(now = false) {
  if (!S.user || !S.conv.saved) return;
  clearTimeout(metaTimer);
  const go = () => {
    const meta = convMeta();
    store.updateConversation(S.conv.id, meta).catch(saveError);
    upsertArchiveItem({ id: S.conv.id, ...meta, updatedAt: new Date() });
  };
  if (now) go(); else metaTimer = setTimeout(go, 2500);
}

let lastSaveErr = 0;
function saveError(e) {
  console.error(e);
  if (Date.now() - lastSaveErr > 10000) {
    lastSaveErr = Date.now();
    toast(e.code === 'permission-denied'
      ? 'Salvataggio rifiutato: controlla le regole Firestore.'
      : 'Salvataggio non riuscito: ' + (e.message || e), 6000);
  }
}

// trascrizione fatta senza login: salvala tutta dopo l'accesso
function saveAllNow() {
  if (!S.user || S.conv.saved) return;
  const done = S.segs.filter((s) => s.status === 'done');
  if (!done.length) return;
  ensureConvSaved();
  done.forEach(persistSeg);
}

async function loadArchive(reset = true) {
  if (!S.user || S.archive.loading) return;
  S.archive.loading = true;
  try {
    const r = await store.listConversations(reset ? null : S.archive.last);
    S.archive.items = reset ? r.items : S.archive.items.concat(r.items);
    S.archive.last = r.last;
    S.archive.more = r.more;
  } catch (e) {
    saveError(e);
  }
  S.archive.loading = false;
  renderArchive();
}

function upsertArchiveItem(it) {
  const i = S.archive.items.findIndex((x) => x.id === it.id);
  if (i >= 0) S.archive.items[i] = { ...S.archive.items[i], ...it };
  else S.archive.items.unshift(it);
  S.archive.items.sort((a, b) => store.toDate(b.updatedAt) - store.toDate(a.updatedAt));
  renderArchive();
}

async function openConv(id) {
  if (S.rec !== 'idle') { toast('Termina la registrazione prima di aprire un\'altra trascrizione.'); return; }
  if (S.conv.id === id && S.conv.saved) { closeDrawer(); return; }
  closeDrawer();
  status('Apro la trascrizione');
  try {
    const { meta, segments } = await store.loadConversation(id);
    S.conv = { id, saved: true, title: meta.title, createdAt: store.toDate(meta.createdAt), durationMs: meta.durationMs || 0 };
    speakers.load(meta.speakers);
    S.segs = segments.map((s) => ({ ...s, status: 'done', saved: true }));
    S.queue = [];
    renderAll();
    $('transcript').scrollTop = 0;
  } catch (e) {
    toast('Impossibile aprire: ' + (e.message || e));
  }
  updateStatus();
}

function newConv() {
  if (S.rec !== 'idle') { toast('Termina la registrazione prima di iniziarne una nuova.'); return; }
  S.conv = freshConv();
  speakers.load(null);
  S.segs = [];
  S.queue = [];
  renderAll();
  closeDrawer();
  $('title').focus();
  $('title').select();
}

/* ---------------- rendering ---------------- */
const nameOf = (id) => speakers.get(id)?.name || 'Persona';
const colorOf = (id) => speakers.get(id)?.color || 'var(--faint)';

function renderAll() {
  $('title').value = S.conv.title;
  document.title = S.conv.title + ' · Transcriptor';
  $('lines').replaceChildren();
  for (const s of S.segs) renderLine(s);
  $('empty').hidden = S.segs.length > 0;
  renderPeople();
  renderMeta();
  renderArchive();
  drawRibbon();
  updateBanner();
}

function isCont(i) {
  const s = S.segs[i];
  const p = S.segs[i - 1];
  return !!(p && s && p.status !== 'lost' && s.speaker && p.speaker === s.speaker && s.start - p.end < 30000);
}

function renderLine(seg) {
  const i = S.segs.indexOf(seg);
  let li = seg.el;
  if (!li) {
    const who = el('button', { class: 'who-btn', type: 'button', onclick: (e) => openSpeakerMenu(e, seg) });
    const ts = el('span', { class: 'ts' });
    const txt = el('p', { class: 'text', spellcheck: 'false' });
    txt.addEventListener('focus', () => { txt.dataset.orig = txt.textContent; });
    txt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); txt.blur(); } if (e.key === 'Escape') { txt.textContent = txt.dataset.orig; txt.blur(); } });
    txt.addEventListener('blur', () => editText(seg, txt));
    li = el('li', { class: 'line' }, el('div', { class: 'who-col' }, who, ts), txt);
    li._who = who; li._ts = ts; li._txt = txt;
    seg.el = li;
    const next = S.segs.slice(i + 1).find((s) => s.el && s.el.isConnected);
    const live = $('lines').querySelector('.line.live');
    $('lines').insertBefore(li, next ? next.el : live);
  }
  li.className = 'line ' + seg.status + (isCont(i) && seg.status === 'done' ? ' cont' : '');
  li.style.setProperty('--c', seg.status === 'done' ? colorOf(seg.speaker) : 'var(--rule)');
  li._who.textContent = seg.status === 'done' ? nameOf(seg.speaker) : seg.status === 'lost' ? '' : '…';
  li._who.disabled = seg.status !== 'done';
  li._who.title = seg.status === 'done' ? 'Cambia persona' : '';
  li._ts.textContent = clock(seg.start);
  if (seg.status === 'done') {
    try { li._txt.contentEditable = 'plaintext-only'; } catch { li._txt.contentEditable = 'true'; }
  } else li._txt.contentEditable = 'false';
  if (document.activeElement !== li._txt) {
    li._txt.textContent = seg.text || '';
    li._txt.classList.toggle('dots', seg.status === 'pending');
  }
  autoScroll();
}

function refreshCont(from) {
  for (let i = Math.max(0, from - 1); i <= Math.min(S.segs.length - 1, from + 1); i++) {
    const s = S.segs[i];
    if (s.el) s.el.classList.toggle('cont', isCont(i) && s.status === 'done');
  }
}

let liveEl = null;
function renderLive() {
  if (!S.live) { liveEl?.remove(); liveEl = null; return; }
  if (!liveEl) {
    liveEl = el('li', { class: 'line live' },
      el('div', { class: 'who-col' }, el('span', { class: 'who-btn' }, 'parla…')),
      el('p', { class: 'text' }));
    $('lines').append(liveEl);
    $('empty').hidden = true;
  }
  const txt = liveEl.querySelector('.text');
  txt.textContent = S.live.text || '';
  txt.classList.toggle('dots', !S.live.text);
  autoScroll();
}

function autoScroll() {
  const t = $('transcript');
  if (S.rec === 'idle') return;
  if (t.scrollHeight - t.scrollTop - t.clientHeight < 220) t.scrollTop = t.scrollHeight;
}

function editText(seg, txt) {
  if (seg.status !== 'done') return;
  const v = txt.textContent.replace(/\s+/g, ' ').trim();
  if (v === seg.text) return;
  if (!v) { removeSeg(seg, true); return; }
  seg.text = v;
  if (S.user && S.conv.saved) store.updateSegment(S.conv.id, seg.id, { text: v }).catch(saveError);
  saveMeta();
}

function removeSeg(seg, persisted) {
  const i = S.segs.indexOf(seg);
  if (i < 0) return;
  S.segs.splice(i, 1);
  seg.el?.remove();
  refreshCont(i);
  if (persisted && S.user && S.conv.saved) store.deleteSegment(S.conv.id, seg.id).catch(saveError);
  speakers.embs.delete(seg.id);
  updatePeopleCounts();
  drawRibbon();
  if (!S.segs.length && !S.live) $('empty').hidden = false;
}

function talkTime() {
  const t = {};
  for (const s of S.segs) if (s.status === 'done') t[s.speaker] = (t[s.speaker] || 0) + (s.end - s.start);
  return t;
}

function renderPeople() {
  const t = talkTime();
  const box = $('people');
  box.replaceChildren(...speakers.list.map((s) =>
    el('button', { class: 'person', type: 'button', style: `--c:${s.color}`, 'data-id': s.id, title: 'Rinomina o unisci', onclick: () => editSpeaker(s.id) },
      el('i'), s.name, el('small', {}, clock(t[s.id] || 0)))));
  renderMeta();
}

function updatePeopleCounts() {
  const t = talkTime();
  for (const b of $('people').children) {
    const s = speakers.get(b.dataset.id);
    if (!s) { renderPeople(); return; }
    b.childNodes[1].textContent = s.name;
    b.querySelector('small').textContent = clock(t[s.id] || 0);
  }
  renderMeta();
}

function renderMeta() {
  const n = speakers.list.length;
  const d = Math.max(S.conv.durationMs || 0, S.rec !== 'idle' ? rec.nowMs : 0);
  const f = new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
  const parts = [f.format(S.conv.createdAt || new Date())];
  if (d) parts.push(clock(d) + (d >= 3600000 ? '' : ' min'));
  if (n) parts.push(n === 1 ? '1 persona' : n + ' persone');
  if (S.user && S.conv.saved) parts.push('salvata');
  $('meta').textContent = parts.join(', ');
}

/* ---------------- nastro temporale ---------------- */
function drawRibbon() {
  const c = $('ribbon');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth;
  const H = c.clientHeight;
  if (!W) return;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement);
  const now = S.rec !== 'idle' ? rec.nowMs : 0;
  const total = Math.max(60000, S.conv.durationMs || 0, now) * (S.rec !== 'idle' ? 1.08 : 1);
  const x = (ms) => (ms / total) * W;

  // tacche ogni minuto (o 5/10/30)
  const step = [60e3, 300e3, 600e3, 1800e3, 3600e3].find((s) => total / s < 14) || 3600e3;
  g.fillStyle = cs.getPropertyValue('--rule');
  for (let t = step; t < total; t += step) g.fillRect(Math.round(x(t)), H - 6, 1, 6);

  const pad = 8;
  const n = Math.max(1, speakers.list.length);
  const laneH = Math.min(14, (H - pad * 2) / n);
  const top = (H - laneH * n) / 2;
  const lane = (id) => {
    const i = speakers.list.findIndex((s) => s.id === id);
    return i < 0 ? 0 : i;
  };
  for (const s of S.segs) {
    const w = Math.max(2, x(s.end) - x(s.start));
    if (s.status === 'done') {
      g.fillStyle = colorOf(s.speaker);
      g.fillRect(x(s.start), top + lane(s.speaker) * laneH + 1, w, laneH - 2);
    } else if (s.status === 'pending') {
      g.fillStyle = cs.getPropertyValue('--faint');
      g.globalAlpha = 0.5;
      g.fillRect(x(s.start), pad, w, H - pad * 2);
      g.globalAlpha = 1;
    }
  }
  if (S.rec !== 'idle') {
    if (rec.speaking) {
      const st = rec.currentAudio();
      if (st) {
        g.fillStyle = cs.getPropertyValue('--faint');
        g.globalAlpha = 0.35;
        g.fillRect(x(st.startMs), pad, Math.max(2, x(now) - x(st.startMs)), H - pad * 2);
        g.globalAlpha = 1;
      }
    }
    g.fillStyle = cs.getPropertyValue('--rec');
    g.fillRect(x(now), 3, 2, H - 6);
  }
}

$('ribbon').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const now = S.rec !== 'idle' ? rec.nowMs : 0;
  const total = Math.max(60000, S.conv.durationMs || 0, now) * (S.rec !== 'idle' ? 1.08 : 1);
  const t = ((e.clientX - r.left) / r.width) * total;
  let best = null;
  for (const s of S.segs) if (s.el && (!best || Math.abs(s.start - t) < Math.abs(best.start - t))) best = s;
  if (best) best.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
new ResizeObserver(() => drawRibbon()).observe($('ribbon'));

let looping = false;
function loop() {
  if (looping) return;
  looping = true;
  let last = 0;
  const tick = (t) => {
    if (S.rec === 'idle') { looping = false; drawRibbon(); renderMeta(); return; }
    if (t - last > 100) {
      last = t;
      $('timer').textContent = clock(rec.nowMs);
      drawRibbon();
      highlightTalker();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function highlightTalker() {
  const id = rec.speaking ? lastSpeaker() : null;
  for (const b of $('people').children) b.classList.toggle('talking', b.dataset.id === id);
}

/* ---------------- persone ---------------- */
const menu = $('speakerMenu');
function openSpeakerMenu(ev, seg) {
  ev.stopPropagation();
  const items = speakers.list.map((s) =>
    el('button', { role: 'menuitemradio', 'aria-checked': String(s.id === seg.speaker), style: `--c:${s.color}`, onclick: () => { closeMenus(); reassign(seg, s.id); } }, el('i'), s.name));
  items.push(el('hr'));
  items.push(el('button', { role: 'menuitem', onclick: () => { closeMenus(); const s = speakers.create(); reassign(seg, s.id); renderPeople(); } }, 'Nuova persona'));
  items.push(el('button', { role: 'menuitem', onclick: () => { closeMenus(); editSpeaker(seg.speaker); } }, 'Rinomina ' + nameOf(seg.speaker)));
  menu.replaceChildren(...items);
  placeMenu(menu, ev.currentTarget);
}

function reassign(seg, id) {
  if (seg.speaker === id) return;
  speakers.move(seg.id, id);
  seg.speaker = id;
  const i = S.segs.indexOf(seg);
  renderLine(seg);
  refreshCont(i + 1);
  refreshCont(i);
  updatePeopleCounts();
  drawRibbon();
  if (S.user && S.conv.saved) store.updateSegment(S.conv.id, seg.id, { speaker: id }).catch(saveError);
  saveMeta();
}

function editSpeaker(id) {
  const s = speakers.get(id);
  if (!s) return;
  const dlg = $('speakerDlg');
  $('spkName').value = s.name;
  $('spkMerge').replaceChildren(el('option', { value: '' }, 'Nessuno'),
    ...speakers.list.filter((x) => x.id !== id).map((x) => el('option', { value: x.id }, x.name)));
  dlg.returnValue = '';
  dlg.showModal();
  $('spkName').select();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'yes') return;
    const name = $('spkName').value.trim();
    const renamed = !!name && name !== s.name;
    if (name) s.name = name;
    const into = $('spkMerge').value;
    if (into) {
      // la persona unita prende il nome scritto qui; se non è stato cambiato,
      // vince il nome personalizzato rispetto a quello automatico "Persona N"
      const target = speakers.get(into);
      const auto = (n) => /^Persona \d+$/.test(n);
      if (target && (renamed || (auto(target.name) && !auto(s.name)))) target.name = s.name;
      speakers.merge(id, into);
      const moved = [];
      for (const seg of S.segs) if (seg.speaker === id) { seg.speaker = into; moved.push(seg.id); }
      if (S.user && S.conv.saved && moved.length) store.batchUpdateSegments(S.conv.id, moved, { speaker: into }).catch(saveError);
    }
    S.segs.forEach((seg) => seg.el && renderLine(seg));
    S.segs.forEach((_, i) => refreshCont(i));
    renderPeople();
    drawRibbon();
    saveMeta(true);
  };
}

/* ---------------- menu ---------------- */
function placeMenu(m, anchor) {
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = Math.max(8, left) + 'px';
  m.style.top = top + 'px';
  m.querySelector('button')?.focus();
}
function closeMenus() { $('exportMenu').hidden = true; menu.hidden = true; }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

$('exportBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('exportMenu');
  if (!m.hidden) { closeMenus(); return; }
  m.querySelector('[data-export="delete"]').hidden = !(S.user && S.conv.saved);
  m.querySelector('hr').hidden = !(S.user && S.conv.saved);
  placeMenu(m, e.currentTarget);
});

$('exportMenu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-export]');
  if (!b) return;
  closeMenus();
  const f = b.dataset.export;
  const segs = S.segs.filter((s) => s.status === 'done');
  if (f === 'delete') return confirmDelete(S.conv.id, S.conv.title);
  if (!segs.length) { toast('Niente da esportare: la trascrizione è vuota.'); return; }
  if (f === 'copy') {
    try { await navigator.clipboard.writeText(build('txt', S.conv, segs, nameOf)); toast('Testo copiato'); }
    catch { toast('Copia non riuscita'); }
    return;
  }
  const types = { txt: 'text/plain', md: 'text/markdown', srt: 'application/x-subrip', json: 'application/json' };
  download(build(f, S.conv, segs, nameOf), `${slug(S.conv.title)}.${f}`, types[f]);
});

function confirmDelete(id, title) {
  if (S.rec !== 'idle' && S.conv.id === id) { toast('Termina la registrazione prima di eliminarla.'); return; }
  const d = $('confirm');
  $('confirmTitle').textContent = 'Eliminare la trascrizione?';
  $('confirmText').textContent = `"${title}" verrà eliminata dall'archivio. L'operazione non si può annullare.`;
  d.returnValue = '';
  d.showModal();
  d.onclose = async () => {
    if (d.returnValue !== 'yes') return;
    try {
      await store.deleteConversation(id);
      S.archive.items = S.archive.items.filter((x) => x.id !== id);
      if (S.conv.id === id) { S.conv = freshConv(); speakers.load(null); S.segs = []; renderAll(); }
      else renderArchive();
      toast('Trascrizione eliminata');
    } catch (e) { saveError(e); }
  };
}

/* ---------------- archivio UI ---------------- */
function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const diff = Math.round((today - x) / 864e5);
  if (diff === 0) return 'Oggi';
  if (diff === 1) return 'Ieri';
  if (diff < 7) return 'Questa settimana';
  return new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(d).replace(/^./, (c) => c.toUpperCase());
}

function renderArchive() {
  const box = $('convList');
  if (!store.configured) {
    box.replaceChildren(el('p', { class: 'archive-note' }, 'Archivio non configurato. Inserisci i dati Firebase in js/config.js per salvare le trascrizioni. Intanto puoi trascrivere ed esportare.'));
    $('moreConv').hidden = true;
    return;
  }
  if (!S.user) {
    box.replaceChildren(el('p', { class: 'archive-note' }, 'Accedi per salvare le trascrizioni e ritrovarle qui, su qualsiasi dispositivo.'));
    $('moreConv').hidden = true;
    return;
  }
  const q = $('search').value.trim().toLowerCase();
  const items = S.archive.items.filter((it) => !q || (it.title || '').toLowerCase().includes(q) || (it.preview || '').toLowerCase().includes(q));
  if (!items.length) {
    box.replaceChildren(el('p', { class: 'archive-note' }, q ? 'Nessun risultato.' : S.archive.loading ? 'Carico…' : 'Le trascrizioni salvate compariranno qui.'));
  } else {
    const out = [];
    let grp = null;
    for (const it of items) {
      const d = store.toDate(it.updatedAt);
      const g = dayLabel(d);
      if (g !== grp) { out.push(el('p', { class: 'conv-group' }, g)); grp = g; }
      const sp = it.speakers || {};
      const talk = it.talk || {};
      const tot = Object.values(talk).reduce((a, b) => a + b, 0) || 1;
      const bar = el('span', { class: 'bar' }, ...Object.entries(talk).map(([id, v]) => el('i', { style: `width:${(v / tot) * 100}%;background:${sp[id]?.color || 'var(--faint)'}` })));
      const sub = [clock(it.durationMs || 0), Object.keys(sp).length ? Object.keys(sp).length + (Object.keys(sp).length === 1 ? ' persona' : ' persone') : null].filter(Boolean).join(', ');
      out.push(el('div', { class: 'conv-item' },
        el('button', { class: 'conv', type: 'button', 'aria-current': String(it.id === S.conv.id), onclick: () => openConv(it.id) },
          el('strong', {}, it.title || 'Senza titolo'), el('span', {}, sub), it.preview ? el('span', {}, it.preview) : null, tot > 1 ? bar : null),
        el('button', {
          class: 'icon-btn conv-del', type: 'button', title: 'Elimina', 'aria-label': 'Elimina ' + (it.title || 'trascrizione'),
          onclick: (e) => { e.stopPropagation(); confirmDelete(it.id, it.title || 'Senza titolo'); },
        }, svg('M5 7h14M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3'))));
    }
    box.replaceChildren(...out);
  }
  $('moreConv').hidden = !S.archive.more || !!q;
}

$('search').addEventListener('input', renderArchive);
$('moreConv').addEventListener('click', () => loadArchive(false));
$('newConv').addEventListener('click', newConv);

function renderAccount() {
  const box = $('account');
  if (!store.configured) { box.replaceChildren(); box.hidden = true; return; }
  box.hidden = false;
  if (!S.user) {
    box.replaceChildren(el('div', { class: 'login-card' },
      el('button', { class: 'btn google', type: 'button', onclick: login }, googleIcon(), 'Accedi con Google')));
    return;
  }
  const u = S.user;
  box.replaceChildren(
    u.photoURL ? el('img', { src: u.photoURL, alt: '', referrerpolicy: 'no-referrer' }) : null,
    el('div', { class: 'who' }, el('b', {}, u.displayName || 'Account'), el('small', {}, u.email || '')),
    el('button', { class: 'icon-btn', type: 'button', title: 'Esci', 'aria-label': 'Esci', onclick: logout },
      svg('M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10')));
}

function svg(d) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
}
function googleIcon() {
  const w = document.createElement('span');
  w.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  return w.firstChild;
}

async function login() {
  try { await store.signIn(); }
  catch (e) {
    const m = e.code === 'auth/unauthorized-domain'
      ? 'Dominio non autorizzato: aggiungilo in Firebase → Authentication → Impostazioni → Domini autorizzati.'
      : 'Accesso non riuscito: ' + (e.message || e);
    toast(m, 8000);
  }
}
async function logout() {
  if (S.rec !== 'idle') { toast('Termina la registrazione prima di uscire.'); return; }
  await store.signOut();
  S.conv = freshConv();
  speakers.load(null);
  S.segs = [];
  renderAll();
}

function updateBanner() {
  const b = $('banner');
  const show = store.configured && !S.user && S.segs.some((s) => s.status === 'done');
  b.hidden = !show;
  if (show && !b.firstChild) {
    b.append(el('span', {}, 'Non hai effettuato l\'accesso: questa trascrizione non verrà salvata.'),
      el('button', { class: 'btn small', type: 'button', onclick: login }, 'Accedi e salva'));
  }
}

/* ---------------- drawer mobile ---------------- */
function openDrawer() { $('archive').classList.add('open'); $('scrim').hidden = false; }
function closeDrawer() { $('archive').classList.remove('open'); $('scrim').hidden = true; }
$('openArchive').addEventListener('click', openDrawer);
$('closeArchive').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);

/* ---------------- titolo ---------------- */
$('title').addEventListener('change', () => {
  S.conv.title = $('title').value.trim() || 'Senza titolo';
  $('title').value = S.conv.title;
  document.title = S.conv.title + ' · Transcriptor';
  saveMeta(true);
});
$('title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.currentTarget.blur(); });

/* ---------------- impostazioni UI ---------------- */
const fmt = {
  thr: (v) => Number(v).toFixed(2),
  max: (v) => v,
  vad: (v) => Math.round(v * 100) + '%',
  pause: (v) => (v / 1000).toFixed(1) + ' s',
  buf: (v) => (v >= 60 ? Math.round(v / 60) + ' min' : v + ' s'),
  mergeGap: (v) => v + ' s',
};
function bindRange(id, key) {
  const i = $(id);
  const o = $(id + 'Out');
  i.value = settings[key];
  o.textContent = fmt[key](settings[key]);
  i.addEventListener('input', () => {
    settings[key] = Number(i.value);
    o.textContent = fmt[key](i.value);
    saveSettings();
    applyRecOptions();
  });
}
bindRange('optThr', 'thr');
bindRange('optMax', 'max');
bindRange('optVad', 'vad');
bindRange('optPause', 'pause');
bindRange('optBuf', 'buf');
bindRange('optMergeGap', 'mergeGap');

function syncEngineUI() {
  const cloud = cloudMode();
  for (const r of document.querySelectorAll('input[name="engine"]')) r.checked = r.value === settings.engine;
  $('groqBox').hidden = !cloud;
  $('localModelBox').hidden = cloud;
  $('optLive').closest('label').hidden = cloud;
  $('mergeGapBox').hidden = !settings.merge;
}
for (const r of document.querySelectorAll('input[name="engine"]')) {
  r.addEventListener('change', () => {
    settings.engine = r.value;
    saveSettings();
    syncEngineUI();
    C.paused = false;
    if (S.model.ready || S.model.loading || S.rec !== 'idle') ensureModels();
    if (cloudMode() && !settings.groqKey) $('optGroqKey').focus();
    deviceInfo();
  });
}
$('optGroqKey').value = settings.groqKey;
$('optGroqKey').addEventListener('change', (e) => { settings.groqKey = e.target.value.trim(); saveSettings(); C.paused = false; pump(); });
$('optGroqModel').value = settings.groqModel;
$('optGroqModel').addEventListener('change', (e) => { settings.groqModel = e.target.value; saveSettings(); });
$('optMerge').checked = settings.merge;
$('optMerge').addEventListener('change', (e) => { settings.merge = e.target.checked; saveSettings(); syncEngineUI(); });
$('mergeNow').addEventListener('click', () => {
  const before = settings.merge;
  settings.merge = true;
  const n = mergeAllNow();
  settings.merge = before;
  toast(n ? 'Frasi unite.' : 'Nessuna frase da unire.');
});
syncEngineUI();

$('optModel').value = settings.model;
$('optLang').value = settings.lang;
$('optSpk').checked = settings.spk;
$('optLive').checked = settings.live;
$('optModel').addEventListener('change', (e) => { settings.model = e.target.value; saveSettings(); if (S.model.ready || S.rec !== 'idle') ensureModels(); });
$('optSpk').addEventListener('change', (e) => { settings.spk = e.target.checked; saveSettings(); if (S.model.ready && settings.spk) ensureModels(); });
$('optLive').addEventListener('change', (e) => { settings.live = e.target.checked; saveSettings(); });
$('optLang').addEventListener('change', (e) => { settings.lang = e.target.value; saveSettings(); worker.postMessage({ type: 'lang', language: settings.lang }); });
$('optMic').addEventListener('change', async (e) => {
  settings.mic = e.target.value;
  saveSettings();
  if (S.rec !== 'idle') { await stopRec(); startRec(); }
});
function openSettings() {
  refreshMics();
  deviceInfo();
  closeDrawer();
  document.querySelector('.main').classList.add('settings-open');
  $('settingsView').hidden = false;
  $('settingsBtn').setAttribute('aria-pressed', 'true');
  $('settingsView').scrollTop = 0;
  if (location.hash !== '#impostazioni') history.pushState(null, '', '#impostazioni');
  $('closeSettings').focus();
}
function closeSettings(fromHistory = false) {
  if ($('settingsView').hidden) return;
  document.querySelector('.main').classList.remove('settings-open');
  $('settingsView').hidden = true;
  $('settingsBtn').setAttribute('aria-pressed', 'false');
  if (!fromHistory && location.hash === '#impostazioni') history.back();
  drawRibbon();
}
$('settingsBtn').addEventListener('click', () => ($('settingsView').hidden ? openSettings() : closeSettings()));
$('closeSettings').addEventListener('click', () => closeSettings());
window.addEventListener('popstate', () => { if (location.hash === '#impostazioni') openSettings(); else closeSettings(true); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settingsView').hidden && !document.querySelector('dialog[open]')) closeSettings(); });
if (location.hash === '#impostazioni') history.replaceState(null, '', location.pathname + location.search);

async function refreshMics() {
  const mics = await listMics();
  const sel = $('optMic');
  const opts = [el('option', { value: '' }, 'Predefinito di sistema'),
    ...mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m, i) => el('option', { value: m.deviceId }, m.label || 'Microfono ' + (i + 1)))];
  sel.replaceChildren(...opts);
  sel.value = settings.mic;
  if (sel.value !== settings.mic) sel.value = '';
}

function deviceInfo() {
  if (cloudMode()) {
    $('deviceInfo').textContent = settings.groqKey
      ? `Trascrizione nel cloud con ${settings.groqModel}. Riconoscimento voci in questo browser.`
      : 'Inserisci la chiave Groq per usare la trascrizione nel cloud.';
    return;
  }
  const gpu = 'gpu' in navigator;
  const d = S.model.device;
  $('deviceInfo').textContent = d
    ? d === 'cloud' ? 'Modello locale non ancora caricato.' : `Elaborazione su ${d === 'webgpu' ? 'scheda grafica (WebGPU)' : 'processore'}, modello ${({ base: 'veloce', small: 'accurato', turbo: 'massimo' })[S.model.size]}.`
    : gpu ? 'Il browser supporta WebGPU: la trascrizione userà la scheda grafica.' : 'WebGPU non disponibile: la trascrizione userà il processore. Scegli la qualità Veloce.';
}

/* ---------------- stato, progresso, toast ---------------- */
function status(t) { $('status').textContent = t; }
function updateStatus() {
  if (S.model.loading) return;
  const q = S.queue.length + (S.busy && S.busy.kind === 'final' ? 1 : 0);
  let t;
  if (S.rec === 'rec') t = q ? `In ascolto, ${q} ${q === 1 ? 'frase' : 'frasi'} da trascrivere` : 'In ascolto';
  else if (S.rec === 'pause') t = q ? `In pausa, trascrivo ${q} ${q === 1 ? 'frase' : 'frasi'}` : 'In pausa';
  else t = q ? `Trascrivo ${q} ${q === 1 ? 'frase' : 'frasi'}` : S.model.ready ? 'Pronto' : 'Pronto, i modelli si scaricano al primo avvio';
  const buf = queuedSec();
  if (buf > (cloudMode() ? 20 : 5)) t += `, ${Math.round(buf)} s di audio in memoria`;
  if (cloudMode() && !settings.groqKey) t = 'Manca la chiave Groq: aprila nelle impostazioni';
  status(t);
}
function showProgress(p, label) {
  $('progress').hidden = false;
  $('progressBar').style.width = Math.round(p * 100) + '%';
  if (label) status(label);
}
function hideProgress() { $('progress').hidden = true; }

let toastT = null;
function toast(text, ms = 3200) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------------- wake lock e uscita ---------------- */
let lock = null;
async function wakeLock(on) {
  try {
    if (on && 'wakeLock' in navigator && !lock) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } else if (!on && lock) { await lock.release(); lock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.rec === 'rec') wakeLock(true); });
window.addEventListener('beforeunload', (e) => {
  if (S.rec !== 'idle' || S.queue.length || S.busy?.kind === 'final' || (store.configured && !S.user && S.segs.length)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('recBtn').click(); }
});

/* ---------------- avvio ---------------- */
S.conv = freshConv();
renderAll();
renderAccount();
deviceInfo();
updateStatus();

store.init((u) => {
  const was = S.user;
  S.user = u;
  renderAccount();
  updateBanner();
  if (u) {
    loadArchive(true);
    saveAllNow();
  } else {
    S.archive = { items: [], last: null, more: false, loading: false };
    renderArchive();
  }
  if (!!was !== !!u) renderMeta();
}, (email) => {
  toast(`L'account ${email} non è autorizzato. Accedi con l'account del proprietario.`, 7000);
}).catch((e) => {
  console.error(e);
  toast('Firebase non raggiungibile: archivio non disponibile.', 6000);
});
