import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPA_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null;

async function uploadAudioToSupabase(file) {
  if (!supabase) throw new Error(
    'Supabase not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to Vercel env vars.'
  );
  const ext = file.name.split('.').pop() || 'mp3';
  const path = `originals/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('songs').upload(path, file, { upsert: false });
  if (error) throw new Error(`Audio upload failed: ${error.message}`);
  const { data } = supabase.storage.from('songs').getPublicUrl(path);
  return data.publicUrl;
}

async function saveSongData(song) {
  if (!supabase) return;
  const path = `library/${song.id}.json`;
  const blob = new Blob([JSON.stringify(song)], { type: 'application/json' });
  const { error } = await supabase.storage
    .from('songs')
    .upload(path, blob, { upsert: true, contentType: 'application/json' });
  if (error) console.warn('Cloud save failed:', error.message);
}

async function loadLibrary() {
  if (!supabase) return [];
  try {
    const { data: files, error } = await supabase.storage.from('songs').list('library');
    if (error || !files?.length) return [];
    const songs = await Promise.all(
      files.filter(f => f.name.endsWith('.json')).map(async f => {
        const { data } = await supabase.storage.from('songs').download(`library/${f.name}`);
        if (!data) return null;
        try { return JSON.parse(await data.text()); } catch { return null; }
      })
    );
    return songs.filter(Boolean).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  } catch { return []; }
}

async function deleteSongData(songId) {
  if (!supabase) return;
  await supabase.storage.from('songs').remove([`library/${songId}.json`]);
}

// ── Replicate ─────────────────────────────────────────────────────────────────
const DEMUCS_VERSION  = '25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953';
const WHISPER_VERSION = '8099696689d249cf8b122d833c36ac3f75505c666a395ca40ef26f68e7d3d16e';

async function repCreate(version, input) {
  const r = await fetch('/api/replicate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', version, input }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); }
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.id;
}

async function repPoll(predId, onTick, cancelRef) {
  let elapsed = 0;
  while (!cancelRef.aborted) {
    await sleep(3500); elapsed += 3.5;
    const r = await fetch('/api/replicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'poll', id: predId }),
    });
    const d = await r.json();
    onTick?.(d.status, Math.round(elapsed));
    if (d.status === 'succeeded') return d.output;
    if (d.status === 'failed' || d.status === 'canceled') throw new Error(d.error || d.status);
  }
  throw new Error('cancelled');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function parseLRC(lrc) {
  if (!lrc) return [];
  return lrc.split('\n').flatMap(line => {
    const m = line.match(/^\[(\d{2}):(\d{2})\.(\d{1,3})\](.*)/);
    if (!m) return [];
    const t = +m[1] * 60 + +m[2] + +m[3].padEnd(3, '0') / 1000;
    const text = m[4].trim();
    return text ? [{ id: uid(), time: t, text, color: null, words: [] }] : [];
  }).sort((a, b) => a.time - b.time);
}

async function lrcSearch(artist, title) {
  try {
    const q = encodeURIComponent(`${artist ? artist + ' ' : ''}${title}`);
    const r = await fetch(`https://lrclib.net/api/search?q=${q}`);
    if (!r.ok) return null;
    const list = await r.json();
    if (!list?.length) return null;
    const hit = list.find(x => x.syncedLyrics) || list[0];
    return {
      synced: hit.syncedLyrics ? parseLRC(hit.syncedLyrics) : [],
      plain: hit.plainLyrics || '',
      foundTitle: hit.trackName,
      foundArtist: hit.artistName,
    };
  } catch { return null; }
}

function whisperToLines(out) {
  if (!out) return [];
  const segs = out.segments || [];
  if (segs.length > 0) {
    return segs.map(s => ({
      id: uid(),
      time: s.start,
      text: s.text.trim(),
      color: null,
      words: (s.words || []).map(w => ({
        word: w.word.replace(/^\s/, ''),
        start: w.start,
        end: w.end,
      })),
    })).filter(l => l.text);
  }
  const text = out.transcription || out.text || (typeof out === 'string' ? out : '');
  return text.split(/\n+/).filter(Boolean).map((t, i) => ({
    id: uid(), time: i * 3, text: t.trim(), color: null, words: [],
  }));
}

function getInstrumental(out) {
  if (!out) return null;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    return out.find(u => typeof u === 'string' && u.includes('no_vocals'))
      || out.find(u => typeof u === 'string' && !u.includes('vocals'))
      || out.find(u => typeof u === 'string') || null;
  }
  return out.no_vocals || out.accompaniment
    || Object.entries(out).find(([k, v]) => !k.includes('vocal') && typeof v === 'string')?.[1]
    || Object.values(out).find(v => typeof v === 'string') || null;
}

async function toBlobUrl(url) {
  try { const r = await fetch(url); const b = await r.blob(); return URL.createObjectURL(b); }
  catch { return url; }
}

const sleep     = ms => new Promise(r => setTimeout(r, ms));
const fmt       = s  => (!s || isNaN(s)) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const parseTime = str => {
  if (!str) return 0;
  const parts = String(str).trim().split(':');
  if (parts.length === 2) return (+parts[0] || 0) * 60 + (+parts[1] || 0);
  return +str || 0;
};
const uid = () => Math.random().toString(36).slice(2, 9);

const AVATAR_COLORS = [
  { bg: '#1a2a4a', fg: '#45aaf2' }, { bg: '#1a3a2a', fg: '#20bf6b' },
  { bg: '#3a1a2a', fg: '#e8607a' }, { bg: '#3a2a0a', fg: '#f4a827' },
];
const songColor = s => AVATAR_COLORS[(s.title.charCodeAt(0) || 0) % AVATAR_COLORS.length];

const EDITOR_COLORS = [
  { hex: '#F4A827', name: 'Amber'  },
  { hex: '#E8607A', name: 'Rose'   },
  { hex: '#45AAF2', name: 'Sky'    },
  { hex: '#20BF6B', name: 'Green'  },
  { hex: '#A55EEA', name: 'Purple' },
  { hex: '#8D93A1', name: 'Grey'   },
  { hex: '#FC5C65', name: 'Coral'  },
  { hex: '#A3CB38', name: 'Lime'   },
  { hex: '#2BCBBA', name: 'Teal'   },
  { hex: '#F7B731', name: 'Gold'   },
];


// ── LIBRARY SCREEN ────────────────────────────────────────────────────────────

function LibraryScreen({ songs, onPlay, onEdit, onDelete }) {
  const [q, setQ] = useState('');
  const filtered  = songs.filter(s =>
    s.title.toLowerCase().includes(q.toLowerCase()) ||
    s.artist.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="screen">
      <div className="page-header">
        <div>
          <div className="page-title">🎤 Karaoke</div>
          <div className="page-sub">{songs.length} song{songs.length !== 1 ? 's' : ''} in your box</div>
        </div>
      </div>
      <div className="search-wrap">
        <i className="ti ti-search search-icon" aria-hidden="true" />
        <input placeholder="Search songs…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div style={{ padding: '0 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {songs.length === 0 && (
          <div className="empty-state">
            <i className="ti ti-music" aria-hidden="true" />
            <h3>Your box is empty</h3>
            <p>Tap the + button below to add your first song.</p>
          </div>
        )}
        {filtered.length === 0 && songs.length > 0 && (
          <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '28px 0' }}>No results for "{q}"</p>
        )}
        {filtered.map(song => {
          const c = songColor(song);
          return (
            <div key={song.id} className="song-card" onClick={() => onPlay(song)}>
              <div className="song-avatar" style={{ background: c.bg, color: c.fg }}>{song.title[0]?.toUpperCase()}</div>
              <div className="song-info">
                <div className="song-title">{song.title}</div>
                <div className="song-artist">{song.artist || 'Unknown artist'}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                {song.hasAudio && <span className="badge badge-green">Ready</span>}
                {song.lyricsType === 'synced' && <span className="badge badge-blue">Synced</span>}
                <button className="btn btn-ghost" style={{ padding: 7 }}
                  onClick={e => { e.stopPropagation(); onEdit(song); }} aria-label="Edit lyrics">
                  <i className="ti ti-edit" style={{ fontSize: 18, color: 'var(--muted)' }} aria-hidden="true" />
                </button>
                <button className="btn btn-ghost" style={{ padding: 7 }}
                  onClick={e => { e.stopPropagation(); if (window.confirm(`Delete "${song.title}"?`)) onDelete(song.id); }}
                  aria-label="Delete song">
                  <i className="ti ti-trash" style={{ fontSize: 18, color: 'var(--muted)' }} aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ── EDITOR SCREEN ─────────────────────────────────────────────────────────────

function EditorScreen({ song, onSave, onBack }) {
  const [lines, setLines]     = useState(
    (song.lyrics || []).map(l => ({ id: uid(), color: null, words: [], ...l }))
  );
  const [activeIdx, setActiveIdx] = useState(null);
  const [saving, setSaving]   = useState(false);

  function updateLine(idx, field, value) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  }

  function deleteLine(idx, e) {
    e?.stopPropagation();
    setLines(prev => prev.filter((_, i) => i !== idx));
    setActiveIdx(prev => {
      if (prev === null || prev < idx) return prev;
      if (prev === idx) return null;
      return prev - 1;
    });
  }

  function addLine() {
    const lastTime = lines[lines.length - 1]?.time || 0;
    setLines(prev => [...prev, { id: uid(), time: lastTime + 3, text: '', color: null, words: [] }]);
    setActiveIdx(lines.length);
  }

  async function handleSave() {
    setSaving(true);
    const sorted = [...lines].sort((a, b) => a.time - b.time);
    await onSave({ ...song, lyrics: sorted, lyricsType: sorted.length > 0 ? 'synced' : 'none' });
    setSaving(false);
  }

  return (
    <div className="editor-shell">
      <div className="editor-header">
        <button className="btn btn-ghost" style={{ padding: 8, flexShrink: 0 }} onClick={onBack}>
          <i className="ti ti-arrow-left" style={{ fontSize: 20 }} aria-hidden="true" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 16, fontWeight: 800, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {song.title}
          </p>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
            {lines.length} lines · {song.artist} · click a row to edit
          </p>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ flexShrink: 0 }}>
          {saving ? <><i className="ti ti-loader spin" style={{ fontSize: 13 }} aria-hidden="true" /> Saving…</> : 'Save'}
        </button>
      </div>

      <div className="editor-list">
        {lines.map((line, idx) => {
          const isActive  = activeIdx === idx;
          const dotColor  = line.color || '#F4A827';

          if (isActive) {
            return (
              <div key={line.id} className="editor-row-active">
                <div className="editor-row-top">
                  <input
                    className="editor-ts-input"
                    defaultValue={fmt(line.time)}
                    onBlur={e => updateLine(idx, 'time', parseTime(e.target.value))}
                    onClick={e => e.stopPropagation()}
                    aria-label="Timestamp (m:ss)"
                  />
                  <input
                    className="editor-text-input"
                    type="text"
                    value={line.text}
                    onChange={e => updateLine(idx, 'text', e.target.value)}
                    autoFocus
                    placeholder="Lyric text…"
                    onClick={e => e.stopPropagation()}
                  />
                  <button className="btn btn-ghost editor-del-btn" onClick={e => deleteLine(idx, e)} aria-label="Delete line">
                    <i className="ti ti-trash" aria-hidden="true" />
                  </button>
                </div>
                <div className="editor-swatches">
                  {EDITOR_COLORS.map(c => {
                    const isSel = line.color === c.hex || (line.color === null && c.hex === '#F4A827');
                    return (
                      <div key={c.hex} className={`editor-swatch${isSel ? ' editor-swatch--sel' : ''}`}
                        style={{ background: c.hex, '--sw': c.hex }}
                        title={c.name}
                        onClick={e => { e.stopPropagation(); updateLine(idx, 'color', line.color === c.hex ? null : c.hex); }}
                      />
                    );
                  })}
                  <span className="editor-color-name">
                    {line.color ? (EDITOR_COLORS.find(c => c.hex === line.color)?.name || '') : 'Amber (default)'}
                  </span>
                </div>
              </div>
            );
          }

          return (
            <div key={line.id} className="editor-row" onClick={() => setActiveIdx(idx)}>
              <span className="editor-ts">{fmt(line.time)}</span>
              <div className="editor-dot" style={{ background: dotColor }} />
              <span className="editor-text" style={{ color: line.color || 'var(--text)' }}>
                {line.text || <em style={{ color: 'var(--muted)' }}>empty</em>}
              </span>
              <button className="btn btn-ghost editor-del-btn" onClick={e => deleteLine(idx, e)} aria-label="Delete line">
                <i className="ti ti-trash" aria-hidden="true" />
              </button>
            </div>
          );
        })}
        <button className="btn btn-secondary" onClick={addLine} style={{ marginTop: 10, alignSelf: 'flex-start' }}>
          <i className="ti ti-plus" aria-hidden="true" /> Add line
        </button>
      </div>
    </div>
  );
}


// ── ADD SONG SCREEN ───────────────────────────────────────────────────────────

function AddSongScreen({ onSave }) {
  const [title, setTitle]       = useState('');
  const [artist, setArtist]     = useState('');
  const [origFile, setOrigFile] = useState(null);
  const [instrFile, setInstrFile] = useState(null);
  const [lyricsText, setLyricsText] = useState('');
  const [mode, setMode]         = useState('auto');
  const [stage, setStage]       = useState('idle');
  const [demucsState, setDemucsState] = useState({ status: 'waiting', elapsed: 0 });
  const [whisperState, setWhisperState] = useState({ status: 'waiting', elapsed: 0 });
  const [result, setResult]     = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const cancelRef = useRef({ aborted: false });
  const timers    = useRef({});

  function startTick(key, setter) {
    let n = 0;
    timers.current[key] = setInterval(() => { n++; setter(p => ({ ...p, elapsed: n })); }, 1000);
  }
  function stopTick(key) { clearInterval(timers.current[key]); delete timers.current[key]; }
  useEffect(() => () => { cancelRef.current.aborted = true; Object.values(timers.current).forEach(clearInterval); }, []);

  async function handleProcess() {
    if (!origFile || !title.trim()) return;
    cancelRef.current = { aborted: false };
    setDemucsState({ status: 'waiting', elapsed: 0 });
    setWhisperState({ status: 'waiting', elapsed: 0 });
    setResult(null); setErrorMsg('');
    try {
      setStage('uploading');
      const audioUrl = await uploadAudioToSupabase(origFile);
      if (cancelRef.current.aborted) return;

      const lrcResult   = title.trim() ? await lrcSearch(artist, title) : null;
      const skipWhisper = lrcResult?.synced?.length > 0;

      setStage('processing');
      setDemucsState(p => ({ ...p, status: 'running' }));
      setWhisperState(p => ({ ...p, status: skipWhisper ? 'skipped_lrc' : 'running' }));
      startTick('demucs', setDemucsState);
      if (!skipWhisper) startTick('whisper', setWhisperState);

      const demucsId = await repCreate(DEMUCS_VERSION, {
        audio: audioUrl, model_name: 'htdemucs', stem: 'vocals',
        shifts: 1, overlap: 0.25, output_format: 'mp3',
      });
      await sleep(12000);
      const whisperPredId = skipWhisper ? null : await repCreate(WHISPER_VERSION, {
        audio: audioUrl, word_timestamps: true, temperature: 0,
      });
      if (cancelRef.current.aborted) return;

      let instrumentalUrl = null, lyrics = [], lyricsType = 'none';
      let demucsErr = null, whisperErr = null;

      await Promise.allSettled([
        repPoll(demucsId, (st, el) => {
          if (!cancelRef.current.aborted)
            setDemucsState({ status: st === 'succeeded' ? 'done' : st === 'failed' ? 'error' : 'running', elapsed: el });
        }, cancelRef.current).then(async out => {
          stopTick('demucs'); setDemucsState(p => ({ ...p, status: 'done' }));
          const raw = getInstrumental(out);
          if (raw) instrumentalUrl = await toBlobUrl(raw);
        }).catch(e => { stopTick('demucs'); demucsErr = e.message; setDemucsState(p => ({ ...p, status: 'error' })); }),

        whisperPredId
          ? repPoll(whisperPredId, (st, el) => {
              if (!cancelRef.current.aborted)
                setWhisperState({ status: st === 'succeeded' ? 'done' : st === 'failed' ? 'error' : 'running', elapsed: el });
            }, cancelRef.current).then(out => {
              stopTick('whisper'); setWhisperState(p => ({ ...p, status: 'done' }));
              lyrics = whisperToLines(out); lyricsType = 'synced';
            }).catch(e => { stopTick('whisper'); whisperErr = e.message; setWhisperState(p => ({ ...p, status: 'error' })); })
          : Promise.resolve().then(() => {
              lyrics = lrcResult.synced.length > 0 ? lrcResult.synced
                : lrcResult.plain.split('\n').filter(Boolean).map((t, i) => ({ id: uid(), time: i * 3, text: t, color: null, words: [] }));
              lyricsType = lrcResult.synced.length > 0 ? 'synced' : 'plain';
            }),
      ]);

      if (cancelRef.current.aborted) return;
      setResult({ instrumentalUrl, lyrics, lyricsType, demucsErr, whisperErr, skippedWhisper: skipWhisper });
      setStage('review');
    } catch (e) {
      Object.values(timers.current).forEach(clearInterval);
      setErrorMsg(e.message); setStage('error');
    }
  }

  function handleSave() {
    const r = result || {};
    const textLines = lyricsText.trim()
      ? parseLRC(lyricsText).length > 0 ? parseLRC(lyricsText)
        : lyricsText.split('\n').filter(Boolean).map((t, i) => ({ id: uid(), time: i * 3.5, text: t, color: null, words: [] }))
      : [];
    const finalLyrics = r.lyrics?.length > 0 ? r.lyrics : textLines;
    onSave({
      id: uid(), title: title.trim(), artist: artist.trim(),
      audioUrl: r.instrumentalUrl || (instrFile ? URL.createObjectURL(instrFile) : null),
      hasAudio: !!(r.instrumentalUrl || instrFile),
      lyrics: finalLyrics,
      lyricsType: r.lyrics?.length > 0 ? r.lyricsType : finalLyrics.length > 0 ? 'plain' : 'none',
      plainLyrics: lyricsText,
    });
  }

  if (stage === 'uploading') return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center', padding: '0 32px' }}>
      <i className="ti ti-cloud-upload spin" style={{ fontSize: 40, color: 'var(--muted)' }} aria-hidden="true" />
      <p style={{ fontWeight: 700, fontSize: 16 }}>Uploading "{title}"…</p>
      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>Saving to Supabase, then sending to Replicate.</p>
    </div>
  );

  if (stage === 'processing') {
    const steps = [
      { key: 'demucs',  icon: 'ti-scissors',        label: 'Removing vocals',  sub: 'Demucs — creates karaoke track', ...demucsState },
      { key: 'whisper', icon: 'ti-text-recognition', label: whisperState.status === 'skipped_lrc' ? 'Lyrics from LRClib' : 'Transcribing lyrics',
        sub: whisperState.status === 'skipped_lrc' ? 'Synced lyrics found — Whisper skipped ✓' : 'Whisper — word-level timestamps', ...whisperState },
    ];
    return (
      <div className="screen" style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontWeight: 700, fontSize: 17, marginBottom: 2 }}>Processing "{title}"…</p>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.6 }}>Running in parallel. Usually 2–5 minutes.</p>
        {steps.map(step => (
          <div key={step.key} className="step-row">
            <i className={`ti ${step.icon}${step.status === 'running' ? ' spin' : ''}`}
              style={{ color: step.status === 'done' || step.status === 'skipped_lrc' ? '#20bf6b' : step.status === 'error' ? 'var(--rose)' : 'var(--muted)' }}
              aria-hidden="true"
            />
            <div className="step-info"><div className="step-title">{step.label}</div><div className="step-sub">{step.sub}</div></div>
            <div className="step-status" style={{ color: step.status === 'done' || step.status === 'skipped_lrc' ? '#20bf6b' : step.status === 'error' ? 'var(--rose)' : 'var(--muted)' }}>
              {step.status === 'done' || step.status === 'skipped_lrc' ? '✓ Done' : step.status === 'error' ? 'Failed' : step.status === 'running' ? fmt(step.elapsed) : '…'}
            </div>
          </div>
        ))}
        <button className="btn btn-secondary" onClick={() => { cancelRef.current.aborted = true; setStage('idle'); }}>
          <i className="ti ti-x" aria-hidden="true" /> Cancel
        </button>
      </div>
    );
  }

  if (stage === 'review' && result) return (
    <div className="screen" style={{ padding: '16px 18px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontWeight: 700, fontSize: 17, margin: '6px 0 0' }}>Review & save</p>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <i className={`ti ${result.instrumentalUrl ? 'ti-check' : 'ti-alert-triangle'}`}
            style={{ fontSize: 20, color: result.instrumentalUrl ? '#20bf6b' : 'var(--amber)', flexShrink: 0 }} aria-hidden="true" />
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{result.instrumentalUrl ? 'Instrumental track ready' : 'Vocal separation failed'}</p>
            {result.demucsErr && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 0 0' }}>{result.demucsErr}</p>}
          </div>
        </div>
        <div className="divider" style={{ margin: 0 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <i className={`ti ${result.lyrics.length > 0 ? 'ti-check' : 'ti-alert-triangle'}`}
            style={{ fontSize: 20, color: result.lyrics.length > 0 ? '#20bf6b' : 'var(--amber)', flexShrink: 0 }} aria-hidden="true" />
          <p style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
            {result.lyrics.length > 0
              ? `${result.lyrics.length} lines${result.skippedWhisper ? ' (LRClib)' : ' (Whisper + word timing)'}`
              : 'No lyrics extracted'}
          </p>
        </div>
      </div>
      {result.lyrics.length > 0 && (
        <div className="card" style={{ padding: '12px 14px' }}>
          <span className="card-label">Lyrics preview</span>
          <div style={{ maxHeight: 170, overflowY: 'auto' }}>
            {result.lyrics.slice(0, 10).map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, borderBottom: '1px solid var(--border)', padding: '3px 0', fontSize: 13 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>{fmt(l.time)}</span>
                <span>{l.text}</span>
              </div>
            ))}
            {result.lyrics.length > 10 && <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>…and {result.lyrics.length - 10} more lines</p>}
          </div>
        </div>
      )}
      {!result.lyrics.length && (
        <div className="card">
          <span className="card-label">Paste lyrics manually</span>
          <textarea value={lyricsText} onChange={e => setLyricsText(e.target.value)} placeholder="Paste lyrics here…" rows={6} />
        </div>
      )}
      <p className="pin-note"><i className="ti ti-pin" aria-hidden="true" /> Use the ✏️ button on any song in the library to fix lyrics after saving</p>
      <button className="btn btn-process btn-full" onClick={handleSave}>
        <i className="ti ti-device-floppy" aria-hidden="true" /> Save "{title}" to library
      </button>
    </div>
  );

  if (stage === 'error') return (
    <div className="screen" style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="warn-box">
        <p style={{ fontWeight: 700, marginBottom: 6 }}><i className="ti ti-alert-triangle" aria-hidden="true" /> Processing failed</p>
        <p style={{ margin: 0, wordBreak: 'break-word' }}>{errorMsg}</p>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>Check REPLICATE_API_TOKEN in Vercel env vars and that your account has credits.</p>
      </div>
      <button className="btn btn-secondary btn-full" onClick={() => { setStage('idle'); setErrorMsg(''); }}>
        <i className="ti ti-refresh" aria-hidden="true" /> Try again
      </button>
    </div>
  );

  return (
    <div className="screen" style={{ padding: '8px 18px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="mode-tabs">
        {['auto', 'manual'].map(m => (
          <button key={m} className={`mode-tab${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
            <i className={`ti ${m === 'auto' ? 'ti-sparkles' : 'ti-upload'}`} aria-hidden="true" style={{ marginRight: 5, fontSize: 13 }} />
            {m === 'auto' ? 'Auto · Replicate' : 'Manual'}
          </button>
        ))}
      </div>
      <div className="card">
        <span className="card-label">Song details</span>
        <div className="field"><input placeholder="Song title *" value={title} onChange={e => setTitle(e.target.value)} /></div>
        <div className="field"><input placeholder="Artist name" value={artist} onChange={e => setArtist(e.target.value)} /></div>
      </div>
      {mode === 'auto' && (
        <>
          <div className="card">
            <span className="card-label">Upload original song</span>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
              Demucs removes vocals. Whisper transcribes with word-level timing for karaoke highlighting.
            </p>
            <label className={`upload-zone${origFile ? ' has-file' : ''}`}>
              <input type="file" accept="audio/*" onChange={e => setOrigFile(e.target.files[0])} />
              <i className={`ti ${origFile ? 'ti-check' : 'ti-file-music'}`} style={{ color: origFile ? '#20bf6b' : 'var(--muted)' }} aria-hidden="true" />
              {origFile ? <p className="filename">{origFile.name}</p>
                : <><p style={{ fontWeight: 700, color: 'var(--text)' }}>Drop audio file here</p><p>MP3, WAV, FLAC, M4A</p></>}
            </label>
          </div>
          <div className="info-box"><i className="ti ti-info-circle" aria-hidden="true" /> LRClib is checked first — if synced lyrics are found, Whisper is skipped to save credits.</div>
          <button className="btn btn-process btn-full" onClick={handleProcess} disabled={!origFile || !title.trim()}>
            <i className="ti ti-sparkles" aria-hidden="true" /> Process with Replicate
          </button>
        </>
      )}
      {mode === 'manual' && (
        <>
          <div className="card">
            <span className="card-label">Lyrics</span>
            <button className="btn btn-secondary btn-full" style={{ marginBottom: 12 }} onClick={async () => {
              if (!title.trim()) return;
              const res = await lrcSearch(artist, title);
              if (res?.plain) setLyricsText(res.plain);
              else alert('Not found on LRClib. Paste manually or use Auto mode.');
            }}><i className="ti ti-search" aria-hidden="true" /> Search LRClib</button>
            <textarea value={lyricsText} onChange={e => setLyricsText(e.target.value)}
              placeholder={"Paste lyrics here…\n\nOr use LRC timed format:\n[00:12.34]First line"} rows={7} />
          </div>
          <div className="card">
            <span className="card-label">Instrumental track</span>
            <label className={`upload-zone${instrFile ? ' has-file' : ''}`}>
              <input type="file" accept="audio/*" onChange={e => setInstrFile(e.target.files[0])} />
              <i className={`ti ${instrFile ? 'ti-check' : 'ti-music'}`} style={{ color: instrFile ? '#20bf6b' : 'var(--muted)' }} aria-hidden="true" />
              {instrFile ? <p className="filename">{instrFile.name}</p>
                : <><p style={{ fontWeight: 700, color: 'var(--text)' }}>Upload karaoke / instrumental</p><p>MP3, WAV, M4A</p></>}
            </label>
          </div>
          <button className="btn btn-primary btn-full" onClick={handleSave} disabled={!title.trim()}>
            <i className="ti ti-plus" aria-hidden="true" /> Add to library
          </button>
        </>
      )}
    </div>
  );
}


// ── PLAYER SCREEN ─────────────────────────────────────────────────────────────

function PlayerScreen({ song, onBack }) {
  const audioRef = useRef(null);
  const rafRef   = useRef(null);
  const [playing, setPlaying]       = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]     = useState(0);
  const [activeLine, setActiveLine] = useState(-1);
  const lyrics = song.lyrics || [];

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const onMeta = () => setDuration(a.duration);
    const onEnd  = () => { setPlaying(false); setActiveLine(-1); };
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnd);
    return () => { a.removeEventListener('loadedmetadata', onMeta); a.removeEventListener('ended', onEnd); cancelAnimationFrame(rafRef.current); };
  }, []);

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    if (playing) {
      a.play().catch(() => setPlaying(false));
      const tick = () => {
        const t = a.currentTime;
        setCurrentTime(t);
        if (lyrics.length > 0) {
          let idx = -1;
          for (let i = 0; i < lyrics.length; i++) { if (lyrics[i].time <= t) idx = i; else break; }
          setActiveLine(idx);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else {
      a.pause(); cancelAnimationFrame(rafRef.current);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  function seek(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const t    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * (duration || 0);
    if (audioRef.current) audioRef.current.currentTime = t;
    setCurrentTime(t);
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const c   = songColor(song);

  // Active line: word-level highlight if available, else plain text
  function renderActiveLine(line) {
    if (!line) return '\u00A0';
    if (line.words?.length > 0) {
      return (
        <span>
          {line.words.map((w, i) => (
            <span key={i} style={{
              color: currentTime >= w.start ? (line.color || 'var(--amber)') : 'rgba(237,233,224,0.25)',
              transition: 'color 0.06s',
            }}>
              {w.word}{i < line.words.length - 1 ? ' ' : ''}
            </span>
          ))}
        </span>
      );
    }
    return line.text;
  }

  const offsets  = [-2, -1, 0, 1, 2];
  const classMap = { '-2': 'past', '-1': 'past', '0': 'active', '1': 'next1', '2': 'next2' };

  return (
    <div className="player-screen">
      {song.audioUrl && <audio ref={audioRef} src={song.audioUrl} preload="metadata" />}
      <div className="player-header">
        <button className="player-back" onClick={onBack} aria-label="Back"><i className="ti ti-arrow-left" aria-hidden="true" /></button>
        <div className="song-avatar" style={{ background: c.bg, color: c.fg, width: 44, height: 44, fontSize: 18 }}>
          {song.title[0]?.toUpperCase()}
        </div>
        <div className="player-meta">
          <div className="player-title">{song.title}</div>
          <div className="player-artist">{song.artist || 'Unknown artist'}</div>
        </div>
        {!song.hasAudio && <span className="badge badge-amber">No audio</span>}
      </div>

      <div className="lyrics-area">
        {lyrics.length === 0 && !song.plainLyrics && (
          <p style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 15 }}>No lyrics added</p>
        )}
        {lyrics.length === 0 && song.plainLyrics && (
          <div style={{ overflowY: 'auto', maxHeight: 300, textAlign: 'center', fontSize: 14, lineHeight: 2.1, color: 'var(--muted)', width: '100%' }}>
            {song.plainLyrics.split('\n').map((ln, i) => (
              <div key={i} style={{ color: ln.trim() ? 'var(--text)' : 'transparent', minHeight: '1.5em' }}>{ln || '·'}</div>
            ))}
          </div>
        )}
        {lyrics.length > 0 && offsets.map(off => {
          const line      = lyrics[activeLine + off];
          const isCur     = off === 0;
          const lineColor = line?.color || 'var(--amber)';
          return (
            <div key={off}
              className={`lyric-line ${classMap[String(off)]}`}
              style={isCur ? { color: lineColor, textShadow: `0 0 28px ${lineColor}50` } : undefined}
            >
              {isCur ? renderActiveLine(line) : (line ? line.text : '\u00A0')}
            </div>
          );
        })}
      </div>

      <div className="progress-wrap">
        <div className="progress-track" onClick={seek}>
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="time-row"><span>{fmt(currentTime)}</span><span>{fmt(duration)}</span></div>
      </div>

      <div className="controls">
        <button className="ctrl-btn" onClick={() => { if (audioRef.current) { audioRef.current.currentTime = 0; setCurrentTime(0); setActiveLine(-1); } }} aria-label="Restart">
          <i className="ti ti-player-skip-back" aria-hidden="true" />
        </button>
        <button className="play-btn" onClick={() => setPlaying(p => !p)} disabled={!song.hasAudio} aria-label={playing ? 'Pause' : 'Play'}>
          <i className={`ti ${playing ? 'ti-player-pause' : 'ti-player-play'}`} aria-hidden="true" />
        </button>
        <button className="ctrl-btn" onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.min(duration, currentTime + 10); }} aria-label="Skip 10s">
          <i className="ti ti-player-skip-forward" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}


// ── SETTINGS ─────────────────────────────────────────────────────────────────

function SettingsScreen() {
  const hasSupabase = !!(SUPA_URL && SUPA_KEY);
  return (
    <div className="screen">
      <div className="page-header"><div><div className="page-title">Settings</div><div className="page-sub">App configuration</div></div></div>
      <div style={{ padding: '0 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className={hasSupabase ? 'success-box' : 'warn-box'}>
          <p style={{ fontWeight: 700, margin: '0 0 4px' }}>
            <i className={`ti ${hasSupabase ? 'ti-check' : 'ti-alert-triangle'}`} aria-hidden="true" />
            {' '}Supabase — {hasSupabase ? 'connected' : 'not configured'}
          </p>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            {hasSupabase ? 'Songs are saved to the cloud and persist across devices and reloads.'
              : 'Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to Vercel env vars.'}
          </p>
        </div>
        <div className="success-box">
          <p style={{ fontWeight: 700, margin: '0 0 4px' }}><i className="ti ti-check" aria-hidden="true" /> Replicate — server-side</p>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>Demucs (vocal removal) + Whisper (word-level transcription) via <code>/api/replicate</code>.</p>
        </div>
        <div className="card">
          <span className="card-label">Roadmap</span>
          <p className="pin-note" style={{ marginBottom: 8 }}><i className="ti ti-pin" aria-hidden="true" /> v1.3 — Background image gallery per song</p>
          <p className="pin-note" style={{ marginBottom: 8 }}><i className="ti ti-pin" aria-hidden="true" /> v1.4 — Pitch / key shift + mic reverb</p>
          <p className="pin-note"><i className="ti ti-pin" aria-hidden="true" /> v1.5 — Genius lyrics source</p>
        </div>
      </div>
    </div>
  );
}


// ── ROOT ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab]               = useState('library');
  const [songs, setSongs]           = useState([]);
  const [activeSong, setActiveSong] = useState(null);
  const [editingSong, setEditingSong] = useState(null);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    loadLibrary().then(loaded => { setSongs(loaded); setLoading(false); });
  }, []);

  async function handleAddSong(song) {
    const s = { ...song, addedAt: Date.now() };
    setSongs(prev => [s, ...prev]);
    setTab('library');
    await saveSongData(s);
  }

  async function handleSaveEdited(updatedSong) {
    setSongs(prev => prev.map(s => s.id === updatedSong.id ? updatedSong : s));
    setEditingSong(null);
    await saveSongData(updatedSong);
  }

  async function handleDeleteSong(songId) {
    setSongs(prev => prev.filter(s => s.id !== songId));
    await deleteSongData(songId);
  }

  if (editingSong) return (
    <div className="app-shell app-shell--wide">
      <EditorScreen song={editingSong} onSave={handleSaveEdited} onBack={() => setEditingSong(null)} />
    </div>
  );

  if (activeSong) return (
    <div className="app-shell">
      <PlayerScreen song={activeSong} onBack={() => setActiveSong(null)} />
    </div>
  );

  return (
    <div className="app-shell">
      {loading && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--muted)' }}>
          <i className="ti ti-loader spin" style={{ fontSize: 22 }} aria-hidden="true" /> Loading your library…
        </div>
      )}
      {!loading && (
        <>
          {tab === 'library'  && <LibraryScreen songs={songs} onPlay={setActiveSong} onEdit={setEditingSong} onDelete={handleDeleteSong} />}
          {tab === 'add'      && <AddSongScreen onSave={handleAddSong} />}
          {tab === 'settings' && <SettingsScreen />}
          <nav className="bottom-nav">
            <button className={`nav-btn${tab === 'library' ? ' active' : ''}`} onClick={() => setTab('library')}>
              <i className="ti ti-playlist" aria-hidden="true" /> Library
            </button>
            <button className="fab" onClick={() => setTab('add')} aria-label="Add song">
              <i className="ti ti-plus" aria-hidden="true" />
            </button>
            <button className={`nav-btn${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>
              <i className="ti ti-settings" aria-hidden="true" /> Settings
            </button>
          </nav>
        </>
      )}
    </div>
  );
}
