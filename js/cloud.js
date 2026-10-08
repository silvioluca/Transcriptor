// Trascrizione cloud con Groq (Whisper large-v3, piano gratuito).
// Più frasi vengono unite in un solo file audio (Groq fattura minimo 10 s per richiesta),
// poi il testo viene ridistribuito alle frasi grazie ai tempi delle parole.
const URL_ASR = 'https://api.groq.com/openai/v1/audio/transcriptions';
const SR = 16000;
const GAP = 0.6; // secondi di silenzio tra le frasi nel file unito

function wav(samples) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export class CloudError extends Error {
  constructor(msg, kind, retryAfter = 0) { super(msg); this.kind = kind; this.retryAfter = retryAfter; }
}

// items: [{id, audio}]  ->  Map(id -> testo)
export async function transcribeBatch(items, { key, model, language, prompt }) {
  const gap = new Float32Array(Math.round(GAP * SR));
  const parts = [];
  const ranges = [];
  let t = 0;
  for (const it of items) {
    if (parts.length) { parts.push(gap); t += GAP; }
    const d = it.audio.length / SR;
    ranges.push({ id: it.id, a: t, b: t + d });
    parts.push(it.audio);
    t += d;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }

  const fd = new FormData();
  fd.append('file', wav(all), 'audio.wav');
  fd.append('model', model);
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');
  fd.append('temperature', '0');
  if (language && language !== 'auto') fd.append('language', language);
  if (prompt) fd.append('prompt', prompt.slice(-600));

  let res;
  try {
    res = await fetch(URL_ASR, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
  } catch (e) {
    throw new CloudError('Rete non disponibile', 'network');
  }
  if (res.status === 401 || res.status === 403) throw new CloudError('Chiave Groq non valida', 'auth');
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after')) || 20;
    throw new CloudError('Limite gratuito Groq raggiunto', 'rate', ra);
  }
  if (!res.ok) {
    let m = res.statusText;
    try { m = (await res.json()).error?.message || m; } catch {}
    throw new CloudError('Errore Groq: ' + m, res.status >= 500 ? 'server' : 'bad');
  }
  const j = await res.json();
  return distribute(j, ranges);
}

// assegna parole (o segmenti) alla frase che contiene il loro centro
function distribute(j, ranges) {
  const out = new Map(ranges.map((r) => [r.id, []]));
  const pick = (mid) => {
    let best = ranges[0];
    let bd = Infinity;
    for (const r of ranges) {
      if (mid >= r.a && mid <= r.b) return r;
      const d = Math.min(Math.abs(mid - r.a), Math.abs(mid - r.b));
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  };
  if (ranges.length === 1) {
    out.set(ranges[0].id, [j.text || '']);
  } else if (Array.isArray(j.words) && j.words.length) {
    for (const w of j.words) out.get(pick((w.start + w.end) / 2).id).push(w.word);
    // punteggiatura: i "words" di Whisper spesso la perdono, la recupero dal testo dei segmenti
    return withPunctuation(out, j);
  } else if (Array.isArray(j.segments) && j.segments.length) {
    for (const s of j.segments) out.get(pick((s.start + s.end) / 2).id).push(s.text);
  } else {
    out.set(ranges[0].id, [j.text || '']);
  }
  const m = new Map();
  for (const [id, a] of out) m.set(id, a.join(' ').replace(/\s+/g, ' ').trim());
  return m;
}

function withPunctuation(out, j) {
  const full = (j.text || '').trim();
  const m = new Map();
  if (!full) {
    for (const [id, a] of out) m.set(id, a.join(' ').trim());
    return m;
  }
  // scorre il testo completo e lo taglia nel punto dove finisce l'ultima parola di ogni frase
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '');
  const plain = () => {
    const r = new Map();
    for (const [id, a] of out) r.set(id, a.join(' ').replace(/\s+/g, ' ').trim());
    return r;
  };
  let pos = 0;
  let failed = false;
  const ids = [...out.keys()];
  const lastWithWords = ids.reduce((acc, id, k) => (out.get(id).some((w) => w.trim()) ? k : acc), -1);
  ids.forEach((id, k) => {
    if (failed) return;
    const words = out.get(id).map((w) => w.trim()).filter(Boolean);
    if (!words.length) { m.set(id, ''); return; }
    if (k === lastWithWords) { m.set(id, full.slice(pos).trim()); pos = full.length; return; }
    let p = pos;
    for (const w of words) {
      const target = norm(w);
      if (!target) continue;
      // cerca la parola nel testo a partire da p
      let i = p;
      let found = -1;
      while (i < full.length) {
        const sp = full.indexOf(' ', i + 1);
        const end = sp < 0 ? full.length : sp;
        if (norm(full.slice(i, end)).includes(target)) { found = end; break; }
        i = end;
        if (i - p > 200) break;
      }
      if (found < 0) { p = -1; break; }
      p = found;
    }
    if (p < 0) { failed = true; return; }
    m.set(id, full.slice(pos, p).trim());
    pos = p;
  });
  return failed ? plain() : m;
}
