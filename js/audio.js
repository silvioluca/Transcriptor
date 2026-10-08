// Microfono + VAD Silero. Segmenti di parlato tenuti solo in RAM.
const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const SR = 16000;
const FRAME = 512; // campioni per frame (v5) = 32 ms
const FRAME_MS = (FRAME / SR) * 1000;

function concat(frames, from = 0, to = frames.length) {
  let n = 0;
  for (let i = from; i < to; i++) n += frames[i].length;
  const out = new Float32Array(n);
  let o = 0;
  for (let i = from; i < to; i++) { out.set(frames[i], o); o += frames[i].length; }
  return out;
}

function rms(f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / f.length);
}

export class Recorder {
  constructor(cb) {
    this.cb = cb; // { onSegment, onSpeechStart, onLevel, onState }
    this.vad = null;
    this.opt = {
      pos: 0.5,
      neg: 0.35,
      redemptionMs: 640,
      preMs: 320,
      minMs: 400,
      maxMs: 14000,
    };
    this.reset();
  }

  reset() {
    this.clock = 0; // frame elaborati da inizio sessione
    this.offsetMs = 0;
    this.speaking = false;
    this.frames = [];
    this.energy = [];
    this.pre = [];
    this.silence = 0;
    this.speechFrames = 0;
    this.startFrame = 0;
  }

  setOptions(o) { Object.assign(this.opt, o); }

  get nowMs() { return this.offsetMs + this.clock * FRAME_MS; }

  get bufferedSec() { return this.frames.length * FRAME / SR; }

  currentAudio() {
    if (!this.speaking || !this.frames.length) return null;
    return { audio: concat(this.frames), startMs: this.offsetMs + this.startFrame * FRAME_MS };
  }

  // source: 'mic' | 'tab' (audio di una scheda, finestra o schermo) | 'both' (scheda + microfono)
  async start(deviceId, offsetMs = 0, source = 'mic') {
    this.reset();
    this.offsetMs = offsetMs;
    if (!window.vad) throw new Error('Libreria VAD non caricata. Controlla la connessione.');
    this.src = await openSource(source, deviceId, () => this.cb.onSourceEnded?.());
    const src = this.src;
    const getStream = async () => src.stream;
    const opts = {
      getStream,
      // il microfono si spegne in pausa; la condivisione schermo resta aperta (riaprirla richiederebbe di nuovo il permesso)
      pauseStream: async () => { if (source === 'mic') await src.pauseMic(); },
      resumeStream: async () => { if (source === 'mic') await src.resumeMic(); return src.stream; },
    };
    try {
      this.vad = await this.create(opts, 'auto');
      await this.vad.start();
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) { src.close(); throw e; }
      // worklet non caricabile: ripiego su ScriptProcessor
      try { await this.vad?.destroy(); } catch {}
      this.vad = await this.create(opts, 'ScriptProcessor');
      await this.vad.start();
    }
    this.cb.onState?.('rec');
  }

  create(streamOpts, processorType) {
    return window.vad.MicVAD.new({
      processorType,
      model: 'v5',
      baseAssetPath: VAD_BASE,
      onnxWASMBasePath: ORT_BASE,
      ...streamOpts,
      positiveSpeechThreshold: this.opt.pos,
      negativeSpeechThreshold: this.opt.neg,
      startOnLoad: false,
      onFrameProcessed: (p, frame) => this.frame(p.isSpeech, frame),
      onSpeechEnd: () => {},
      onVADMisfire: () => {},
    });
  }

  async pause() {
    this.flush();
    if (this.vad) await this.vad.pause();
    this.cb.onState?.('pause');
  }

  async resume() {
    if (this.vad) await this.vad.start();
    this.cb.onState?.('rec');
  }

  async stop() {
    this.flush();
    if (this.vad) {
      try { await this.vad.destroy(); } catch {}
      this.vad = null;
    }
    this.src?.close();
    this.src = null;
    this.cb.onState?.('idle');
  }

  frame(p, f) {
    const frame = new Float32Array(f);
    const e = rms(frame);
    this.cb.onLevel?.(e, p);
    this.clock++;
    const preN = Math.round(this.opt.preMs / FRAME_MS);
    const redN = Math.round(this.opt.redemptionMs / FRAME_MS);
    const minN = Math.round(this.opt.minMs / FRAME_MS);
    const maxN = Math.round(this.opt.maxMs / FRAME_MS);

    if (!this.speaking) {
      this.pre.push([frame, e]);
      if (this.pre.length > preN) this.pre.shift();
      if (p > this.opt.pos) {
        this.speaking = true;
        this.frames = this.pre.map((x) => x[0]);
        this.energy = this.pre.map((x) => x[1]);
        this.startFrame = this.clock - this.frames.length;
        this.pre = [];
        this.silence = 0;
        this.speechFrames = 1;
        this.cb.onSpeechStart?.();
      }
      return;
    }

    this.frames.push(frame);
    this.energy.push(e);
    if (p > this.opt.pos) { this.silence = 0; this.speechFrames++; }
    else if (p < this.opt.neg) this.silence++;

    if (this.silence >= redN) {
      this.end(minN);
      return;
    }
    if (this.frames.length >= maxN) this.cut(minN);
  }

  segment(from, to) {
    return {
      audio: concat(this.frames, from, to),
      startMs: this.offsetMs + (this.startFrame + from) * FRAME_MS,
      endMs: this.offsetMs + (this.startFrame + to) * FRAME_MS,
    };
  }

  end(minN) {
    const keepTail = Math.min(this.silence, 6);
    const to = this.frames.length - this.silence + keepTail;
    const seg = this.speechFrames >= minN ? this.segment(0, to) : null;
    // coda di silenzio diventa pre-roll
    const preN = Math.round(this.opt.preMs / FRAME_MS);
    this.pre = this.frames.slice(-preN).map((fr, i, a) => [fr, this.energy[this.energy.length - a.length + i]]);
    this.frames = [];
    this.energy = [];
    this.speaking = false;
    this.silence = 0;
    this.speechFrames = 0;
    if (seg) this.cb.onSegment?.(seg);
    else this.cb.onMisfire?.();
  }

  // parlato lungo: taglio nel punto più silenzioso degli ultimi 2.5 s
  cut(minN) {
    const n = this.frames.length;
    const look = Math.min(n - minN, Math.round(2500 / FRAME_MS));
    let best = n - 1;
    let bestE = Infinity;
    for (let i = n - look; i < n; i++) {
      const w = (this.energy[i - 1] ?? 0) + this.energy[i] + (this.energy[i + 1] ?? 0);
      if (w < bestE) { bestE = w; best = i; }
    }
    const seg = this.segment(0, best);
    this.frames = this.frames.slice(best);
    this.energy = this.energy.slice(best);
    this.startFrame += best;
    this.speechFrames = this.frames.length;
    this.cb.onSegment?.(seg);
  }

  flush() {
    if (this.speaking && this.frames.length) {
      const minN = Math.round(this.opt.minMs / FRAME_MS);
      this.silence = 0;
      this.end(minN);
    }
  }
}

export async function listMics() {
  try {
    const d = await navigator.mediaDevices.enumerateDevices();
    return d.filter((x) => x.kind === 'audioinput');
  } catch {
    return [];
  }
}

export const canCaptureTab = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

function micConstraints(deviceId) {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
}

class SourceError extends Error {
  constructor(msg, name) { super(msg); this.name = name; }
}

async function openTab() {
  if (!canCaptureTab) throw new SourceError('Questo browser non può catturare l\'audio di altre schede. Usa Chrome o Edge su computer.', 'NotSupportedError');
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: true, // obbligatorio per Chrome; non viene usato
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    preferCurrentTab: false,
  });
  if (!s.getAudioTracks().length) {
    s.getTracks().forEach((t) => t.stop());
    throw new SourceError('Nessun audio condiviso. Scegli una scheda (YouTube, Meet…) e attiva "Condividi anche l\'audio della scheda". Per lo schermo intero attiva "Condividi audio di sistema".', 'NoAudioError');
  }
  s.getVideoTracks().forEach((t) => { t.enabled = false; });
  return s;
}

async function openSource(kind, deviceId, onEnded) {
  let mic = null;
  let tab = null;
  let ctx = null;
  let ended = false;
  const fireEnded = () => { if (!ended) { ended = true; onEnded(); } };
  const out = {
    stream: null,
    async pauseMic() { mic?.getTracks().forEach((t) => t.stop()); },
    async resumeMic() {
      mic = await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
      out.stream = mic;
    },
    close() {
      ended = true;
      mic?.getTracks().forEach((t) => t.stop());
      tab?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    },
  };
  if (kind === 'mic') {
    mic = await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
    out.stream = mic;
    return out;
  }
  tab = await openTab();
  tab.getTracks().forEach((t) => t.addEventListener('ended', fireEnded));
  if (kind === 'tab') {
    out.stream = new MediaStream(tab.getAudioTracks());
    return out;
  }
  // entrambi: mescolo scheda e microfono in un unico flusso
  try {
    mic = await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
  } catch (e) {
    tab.getTracks().forEach((t) => t.stop());
    throw e;
  }
  ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(new MediaStream(tab.getAudioTracks())).connect(dest);
  ctx.createMediaStreamSource(mic).connect(dest);
  if (ctx.state === 'suspended') await ctx.resume();
  out.stream = dest.stream;
  return out;
}
