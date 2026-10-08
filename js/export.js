export function clock(ms, withHours = false) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h || withHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function srtTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = Math.floor(ms % 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

// unisce turni consecutivi dello stesso interlocutore
function turns(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < 4000) {
      last.text += ' ' + s.text;
      last.end = s.end;
    } else out.push({ ...s });
  }
  return out;
}

export function build(format, conv, segs, name) {
  const done = segs.filter((s) => s.text);
  const title = conv.title || 'Trascrizione';
  switch (format) {
    case 'txt':
      return [title, '', ...turns(done).map((t) => `[${clock(t.start)}] ${name(t.speaker)}: ${t.text}`)].join('\n');
    case 'md':
      return [`# ${title}`, '', ...turns(done).map((t) => `**${name(t.speaker)}** · ${clock(t.start)}  \n${t.text}\n`)].join('\n');
    case 'srt':
      return done
        .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${name(s.speaker)}: ${s.text}\n`)
        .join('\n');
    case 'json':
      return JSON.stringify(
        {
          title,
          speakers: Object.fromEntries([...new Set(done.map((s) => s.speaker))].map((id) => [id, name(id)])),
          segments: done.map((s) => ({ start: s.start / 1000, end: s.end / 1000, speaker: name(s.speaker), text: s.text })),
        },
        null,
        2,
      );
  }
  return '';
}

export function download(text, filename, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function slug(s) {
  return (s || 'trascrizione')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 60) || 'trascrizione';
}
