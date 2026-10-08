// Riconoscimento interlocutori online: centroidi di impronte vocali, similarità coseno.
export const COLORS = ['#2D5BD7', '#C2491D', '#0F8A6C', '#8A3FD1', '#A87A07', '#C72D6B', '#3A7F9E', '#6B7A1F'];

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (v) => Math.sqrt(dot(v, v)) || 1;

export class Speakers {
  constructor() {
    this.threshold = 0.5;
    this.max = 6;
    this.list = []; // {id, name, color, sum:Float32Array|null, n}
    this.embs = new Map(); // segId -> {list:[emb], spk}, solo sessione corrente
  }

  load(map) {
    this.list = [];
    this.embs.clear();
    if (!map) return;
    for (const [id, s] of Object.entries(map).sort((a, b) => a[1].order - b[1].order)) {
      this.list.push({
        id,
        name: s.name,
        color: s.color,
        voice: s.voice || '',
        n: s.n || 0,
        sum: s.c ? Float32Array.from(s.c, (x) => x * (s.n || 1)) : null,
      });
    }
  }

  toMap() {
    const out = {};
    this.list.forEach((s, i) => {
      const c = s.sum && s.n ? Array.from(s.sum, (x) => Math.round((x / s.n) * 1e4) / 1e4) : null;
      out[s.id] = { name: s.name, color: s.color, order: i, n: s.n, ...(s.voice ? { voice: s.voice } : {}), ...(c ? { c } : {}) };
    });
    return out;
  }

  get(id) { return this.list.find((s) => s.id === id); }

  create() {
    let k = this.list.length + 1;
    while (this.get('s' + k)) k++;
    const s = {
      id: 's' + k,
      name: 'Persona ' + k,
      color: COLORS[(k - 1) % COLORS.length],
      sum: null,
      n: 0,
    };
    this.list.push(s);
    return s;
  }

  sim(s, emb) {
    if (!s.sum) return -1;
    return dot(s.sum, emb) / norm(s.sum);
  }

  // durata in secondi: clip corte non creano nuove persone e non aggiornano i centroidi
  assign(segId, emb, sec, lastId) {
    if (!emb) {
      const s = this.get(lastId) || this.list[0] || this.create();
      return { id: s.id, sim: null, created: false };
    }
    let best = null;
    let bestSim = -2;
    for (const s of this.list) {
      const v = this.sim(s, emb);
      if (v > bestSim) { bestSim = v; best = s; }
    }
    const reliable = sec >= 1.2;
    let created = false;
    let target = best;
    if (!best || !best.sum) {
      target = best && !best.sum ? best : this.create();
      created = !best;
    } else if (bestSim < this.threshold) {
      if (reliable && this.list.length < this.max) { target = this.create(); created = true; }
      else if (!reliable && lastId && this.get(lastId) && bestSim < this.threshold - 0.15) target = this.get(lastId);
    }
    if (reliable || !target.sum) this.add(target, emb);
    this.embs.set(segId, { list: [emb], spk: target.id });
    return { id: target.id, sim: bestSim, created };
  }

  add(s, emb, sign = 1) {
    if (!s.sum) s.sum = new Float32Array(emb.length);
    for (let i = 0; i < emb.length; i++) s.sum[i] += sign * emb[i];
    s.n += sign;
    if (s.n <= 0) { s.n = 0; s.sum = null; }
  }

  // correzione manuale: sposta impronta tra persone
  move(segId, toId) {
    const r = this.embs.get(segId);
    const to = this.get(toId);
    if (!r || !to) return;
    const from = this.get(r.spk);
    for (const e of r.list) {
      if (from && from.sum) this.add(from, e, -1);
      this.add(to, e);
    }
    r.spk = toId;
  }

  // frase unita alla precedente: le impronte passano al blocco che resta
  absorb(intoId, fromId) {
    const a = this.embs.get(fromId);
    if (!a) return;
    const b = this.embs.get(intoId);
    if (b) b.list.push(...a.list);
    else this.embs.set(intoId, a);
    this.embs.delete(fromId);
  }

  merge(fromId, toId) {
    const a = this.get(fromId);
    const b = this.get(toId);
    if (!a || !b || a === b) return;
    if (a.sum) {
      if (!b.sum) { b.sum = a.sum; b.n = a.n; }
      else { for (let i = 0; i < a.sum.length; i++) b.sum[i] += a.sum[i]; b.n += a.n; }
    }
    for (const r of this.embs.values()) if (r.spk === fromId) r.spk = toId;
    this.list = this.list.filter((s) => s !== a);
  }
}
