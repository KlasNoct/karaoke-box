import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPA_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null;

async function uploadAudioToSupabase(file) {
  if (!supabase) throw new Error('Supabase not configured.');
  const ext = file.name.split('.').pop() || 'mp3';
  const path = `originals/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('songs').upload(path, file, { upsert: false });
  if (error) throw new Error(`Audio upload failed: ${error.message}`);
  return supabase.storage.from('songs').getPublicUrl(path).data.publicUrl;
}

async function uploadProcessedToSupabase(replicateUrl, folder) {
  if (!supabase) throw new Error('Supabase not configured.');
  const resp = await fetch(replicateUrl);
  if (!resp.ok) throw new Error(`Could not download processed audio (${resp.status})`);
  const blob = await resp.blob();
  const path = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp3`;
  const { error } = await supabase.storage.from('songs').upload(path, blob, { contentType: 'audio/mpeg', upsert: false });
  if (error) throw new Error(`Failed to save to ${folder}: ${error.message}`);
  return supabase.storage.from('songs').getPublicUrl(path).data.publicUrl;
}

async function deleteSupabaseFile(publicUrl) {
  if (!supabase || !publicUrl) return;
  try {
    const match = publicUrl.match(/\/storage\/v1\/object\/public\/songs\/(.+)$/);
    if (match) await supabase.storage.from('songs').remove([decodeURIComponent(match[1])]);
  } catch (e) { console.warn('Could not delete file:', e.message); }
}

async function saveSongData(song) {
  if (!supabase) return;
  const blob = new Blob([JSON.stringify(song)], { type: 'application/json' });
  const { error } = await supabase.storage.from('songs')
    .upload(`library/${song.id}.json`, blob, { upsert: true, contentType: 'application/json' });
  if (error) console.warn('Cloud save failed:', error.message);
}

async function archiveDeletedSong(song) {
  if (!supabase) return;
  try {
    const { data } = await supabase.storage.from('songs').download(`library/${song.id}.json`);
    if (data) {
      const current = JSON.parse(await data.text());
      const archived = new Blob([JSON.stringify({ ...current, _deleted: true, _deletedAt: Date.now() })], { type: 'application/json' });
      await supabase.storage.from('songs').upload(`deleted/${song.id}.json`, archived, { upsert: true, contentType: 'application/json' });
    }
  } catch (e) { console.warn('Could not archive:', e.message); }
  await supabase.storage.from('songs').remove([`library/${song.id}.json`]);
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

// ── Settings ──────────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'karaoke_settings';
const loadSettings   = () => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } };
const persistSettings = s => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} };

// ── Replicate ─────────────────────────────────────────────────────────────────
const DEMUCS_VERSION   = '25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953';
// WhisperX: forced phoneme alignment. align_output MUST be true for word timestamps.
const WHISPERX_VERSION = '5d4424b04099904320e7f7c8343d09788c88f8bf8d0b3ba160dfb97112ebb6ba';

async function repCreate(version, input) {
  const r = await fetch('/api/replicate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'poll', id: predId }),
    });
    const d = await r.json();
    onTick?.(d.status, Math.round(elapsed));
    if (d.status === 'succeeded') return d.output;
    if (d.status === 'failed' || d.status === 'canceled') throw new Error(d.error || d.status);
  }
  throw new Error('cancelled');
}

// ── Claude correction ─────────────────────────────────────────────────────────
// Claude returns compact format [{id,t,w:[[start,end],...]}] to fit Vercel timeout.
// reconstructFromMinimal turns it back into full lyrics using lrcLines text.
function reconstructFromMinimal(minimal, lrcLines) {
  const lrcMap = Object.fromEntries(lrcLines.map(l => [l.id, l]));
  return minimal.map(item => {
    const lrc = lrcMap[item.id];
    if (!lrc) return null;
    const textWords = lrc.text.split(/\s+/).filter(Boolean);
    const words = (item.w || []).slice(0, textWords.length).map((pair, i) => ({
      word: textWords[i], start: pair[0], end: pair[1],
    }));
    return { ...lrc, time: item.t != null ? item.t : lrc.time, words };
  }).filter(Boolean);
}

async function callClaudeCorrection(whisperOut, lrcLines) {
  if (!whisperOut?.segments || !lrcLines?.length) return null;
  const whisperWords = whisperOut.segments.flatMap(s =>
    (s.words || []).map(w => ({ word: w.word.replace(/^\s+/, ''), start: w.start, end: w.end }))
  );
  if (!whisperWords.length) { console.warn('[KaraKlas] No WhisperX word data'); return null; }
  console.log(`[KaraKlas] Claude: ${whisperWords.length} words, ${lrcLines.length} lines`);
  try {
    const r = await fetch('/api/claude', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ whisperWords, lrcLines }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const text = data.content?.[0]?.text;
    if (!text) throw new Error('No content');
    const clean = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const minimal = JSON.parse(clean);
    if (!Array.isArray(minimal)) throw new Error('Not an array');
    const corrected = reconstructFromMinimal(minimal, lrcLines);
    console.log(`[KaraKlas] Claude done: ${corrected.length} lines, ${corrected.reduce((n,l)=>n+(l.words?.length||0),0)} words`);
    return corrected;
  } catch (e) {
    console.warn('[KaraKlas] Claude failed:', e.message);
    return null;
  }
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
    return { synced: hit.syncedLyrics ? parseLRC(hit.syncedLyrics) : [], plain: hit.plainLyrics || '', foundTitle: hit.trackName, foundArtist: hit.artistName };
  } catch { return null; }
}

// Split a word array into chunks of ≤MAX_WORDS_PER_LINE, breaking at the
// largest natural pause so line breaks feel like the singer intended them.
const MAX_WORDS_PER_LINE = 10;
function splitSegmentWords(words) {
  if (!words.length) return [];
  if (words.length <= MAX_WORDS_PER_LINE) return [words];
  let bestIdx = Math.ceil(words.length / 2), bestGap = -1;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > bestGap) { bestGap = gap; bestIdx = i; }
  }
  return [...splitSegmentWords(words.slice(0, bestIdx)), ...splitSegmentWords(words.slice(bestIdx))];
}

function whisperToLines(out) {
  if (!out) return [];
  const segs = out.segments || [];
  if (segs.length > 0) {
    const lines = [];
    for (const seg of segs) {
      const words = (seg.words || []).map(w => ({ word: w.word.replace(/^\s+/, ''), start: w.start, end: w.end }));
      if (words.length > 0) {
        // Split long segments at natural pauses so each line stays readable
        for (const chunk of splitSegmentWords(words)) {
          lines.push({ id: uid(), time: chunk[0].start, text: chunk.map(w => w.word).join(' '), color: null, words: chunk });
        }
      } else if (seg.text.trim()) {
        // No word-level data — keep as single line, can't split without timing
        lines.push({ id: uid(), time: seg.start, text: seg.text.trim(), color: null, words: [] });
      }
    }
    return lines;
  }
  const text = out.transcription || out.text || (typeof out === 'string' ? out : '');
  return text.split(/\n+/).filter(Boolean).map((t, i) => ({ id: uid(), time: i * 3, text: t.trim(), color: null, words: [] }));
}

function getInstrumental(out) {
  if (!out) return null;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.find(u => typeof u === 'string' && u.includes('no_vocals')) || out.find(u => typeof u === 'string' && !u.includes('vocals')) || out.find(u => typeof u === 'string') || null;
  return out.no_vocals || out.accompaniment || Object.entries(out).find(([k, v]) => !k.includes('vocal') && typeof v === 'string')?.[1] || Object.values(out).find(v => typeof v === 'string') || null;
}
function getVocals(out) {
  if (!out) return null;
  if (typeof out === 'string') return null;
  if (Array.isArray(out)) return out.find(u => typeof u === 'string' && u.includes('vocals') && !u.includes('no_vocals')) || null;
  return out.vocals || null;
}

// Merge LRClib line structure with WhisperX word timestamps (used as fallback if Claude fails)
function mergeWordsIntoLines(lrcLines, whisperOut) {
  if (!lrcLines?.length || !whisperOut) return lrcLines;
  const allWords = [];
  for (const seg of (whisperOut.segments || []))
    for (const w of (seg.words || []))
      allWords.push({ word: w.word.replace(/^\s+/, ''), start: w.start, end: w.end });
  if (!allWords.length) return lrcLines;
  return lrcLines.map((line, i) => {
    const lineStart = line.time;
    const lineEnd   = lrcLines[i + 1]?.time ?? Infinity;
    const words     = allWords.filter(w => w.start >= lineStart - 0.4 && w.start < lineEnd);
    return { ...line, words };
  });
}

function makePale(hex) {
  if (!hex || !hex.startsWith('#') || hex.length < 7) return 'rgba(255,255,255,0.38)';
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r * 0.25 + 191)},${Math.round(g * 0.25 + 191)},${Math.round(b * 0.25 + 191)})`;
}

function pickRandomSong(songs, excludeId) {
  const pool = songs.filter(s => s.id !== excludeId && s.hasAudio);
  if (!pool.length) return songs.find(s => s.id !== excludeId) || null;
  return pool[Math.floor(Math.random() * pool.length)];
}

const sleep     = ms => new Promise(r => setTimeout(r, ms));
const fmt       = s  => (!s || isNaN(s)) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const parseTime = str => { if (!str) return 0; const p = String(str).trim().split(':'); return p.length === 2 ? (+p[0] || 0) * 60 + (+p[1] || 0) : +str || 0; };
const uid = () => Math.random().toString(36).slice(2, 9);

const AVATAR_COLORS = [{ bg: '#1a2a4a', fg: '#45aaf2' }, { bg: '#1a3a2a', fg: '#20bf6b' }, { bg: '#3a1a2a', fg: '#e8607a' }, { bg: '#3a2a0a', fg: '#f4a827' }];
const songColor = s => AVATAR_COLORS[(s.title.charCodeAt(0) || 0) % AVATAR_COLORS.length];

const EDITOR_COLORS = [
  { hex: '#F4A827', name: 'Amber' }, { hex: '#E8607A', name: 'Rose' }, { hex: '#45AAF2', name: 'Sky' }, { hex: '#20BF6B', name: 'Green' },
  { hex: '#A55EEA', name: 'Purple' }, { hex: '#8D93A1', name: 'Grey' }, { hex: '#FC5C65', name: 'Coral' }, { hex: '#A3CB38', name: 'Lime' },
  { hex: '#2BCBBA', name: 'Teal' }, { hex: '#F7B731', name: 'Gold' },
];


// ── LIBRARY SCREEN ────────────────────────────────────────────────────────────
function LibraryScreen({ songs, onPlay, onEdit, onDelete, onStartRandom }) {
  const [q, setQ] = useState('');
  const filtered = songs.filter(s => s.title.toLowerCase().includes(q.toLowerCase()) || (s.artist || '').toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="screen">
      <div className="page-header"><div><div className="page-title">🎤 KaraKlas</div><div className="page-sub">{songs.length} song{songs.length !== 1 ? 's' : ''} in your box</div></div></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 18px 12px' }}>
        <div className="search-wrap" style={{ flex: 1, margin: 0, padding: 0 }}>
          <i className="ti ti-search search-icon" aria-hidden="true" />
          <input placeholder="Search songs…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <button className="shuffle-btn" onClick={onStartRandom} disabled={songs.filter(s => s.hasAudio || s.audioUrl).length < 2} aria-label="Shuffle play" title="Shuffle — play random songs">
          <i className="ti ti-arrows-shuffle" aria-hidden="true" />
        </button>
      </div>
      <div style={{ padding: '0 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {songs.length === 0 && (<div className="empty-state"><i className="ti ti-music" aria-hidden="true" /><h3>Your box is empty</h3><p>Tap the + button below to add your first song.</p></div>)}
        {filtered.length === 0 && songs.length > 0 && (<p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '28px 0' }}>No results for "{q}"</p>)}
        {filtered.map(song => {
          const activeLyrics = (song.lyricsSource === 'alt' && song.lyricsAlt?.length > 0) ? song.lyricsAlt : song.lyrics;
          const hasWords = activeLyrics?.some(l => l.words?.length > 0);
          return (
            <div key={song.id} className="song-card" style={{ gap: 0 }} onClick={() => onPlay(song)}>
              <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                <div className="song-title">{song.title}</div>
                <div className="song-artist">{song.artist || 'Unknown artist'}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                {(song.hasAudio || song.audioUrl) && <span className="badge badge-green badge-xs">Ready</span>}
                {song.lyricsType === 'synced' && <span className="badge badge-blue badge-xs">Synced</span>}
                {hasWords && <span className="badge badge-teal badge-xs">Words</span>}
              </div>
              <button className="btn btn-ghost" style={{ padding: 7 }} onClick={e => { e.stopPropagation(); onEdit(song); }} aria-label="Edit"><i className="ti ti-edit" style={{ fontSize: 17, color: 'var(--muted)' }} aria-hidden="true" /></button>
              <button className="btn btn-ghost" style={{ padding: 7 }} onClick={e => { e.stopPropagation(); if (window.confirm(`Delete "${song.title}"?`)) onDelete(song); }} aria-label="Delete"><i className="ti ti-trash" style={{ fontSize: 17, color: 'var(--muted)' }} aria-hidden="true" /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ── EDITOR SCREEN ─────────────────────────────────────────────────────────────
function EditorScreen({ song, onSave, onBack }) {
  const hasAlt = (song.lyricsAlt?.length ?? 0) > 0;
  const [editingAlt, setEditingAlt] = useState(false);
  const [localTitle, setLocalTitle]   = useState(song.title  || '');
  const [localArtist, setLocalArtist] = useState(song.artist || '');
  const [lines, setLines]             = useState(() => (song.lyrics || []).map(l => ({ id: uid(), color: null, words: [], ...l })));
  const [activeIdx, setActiveIdx]     = useState(null);
  const [saving, setSaving]           = useState(false);

  function getSourceLines(useAlt) {
    const src = useAlt ? (song.lyricsAlt || []) : (song.lyrics || []);
    return src.map(l => ({ id: uid(), color: null, words: [], ...l }));
  }

  function handleToggleSource(useAlt) {
    if (useAlt === editingAlt) return;
    if (lines.length > 0 && !window.confirm(`Switch to ${useAlt ? 'WhisperX' : 'AI-corrected'} source? Unsaved changes will be lost.`)) return;
    setEditingAlt(useAlt);
    setLines(getSourceLines(useAlt));
    setActiveIdx(null);
  }

  function updateLine(idx, field, value) { setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l)); }
  function deleteLine(idx, e) { e?.stopPropagation(); setLines(prev => prev.filter((_, i) => i !== idx)); setActiveIdx(prev => prev === null || prev < idx ? prev : prev === idx ? null : prev - 1); }
  function addLine() { const t = lines[lines.length - 1]?.time || 0; setLines(prev => [...prev, { id: uid(), time: t + 3, text: '', color: null, words: [] }]); setActiveIdx(lines.length); }

  async function handleSave() {
    setSaving(true);
    const sorted = [...lines].sort((a, b) => a.time - b.time);
    if (editingAlt) {
      // Saving WhisperX backup — mark this as the preferred source
      await onSave({ ...song, lyricsAlt: sorted, lyricsSource: 'alt' });
    } else {
      // Saving AI-corrected primary — mark as preferred source
      await onSave({ ...song, title: localTitle.trim() || song.title, artist: localArtist.trim(), lyrics: sorted, lyricsType: sorted.length > 0 ? 'synced' : 'none', lyricsSource: 'primary' });
    }
    setSaving(false);
  }

  const sourceLabel = editingAlt ? 'WhisperX (backup)' : 'AI-corrected (primary)';

  return (
    <div className="editor-shell">
      <div className="editor-header">
        <button className="btn btn-ghost" style={{ padding: 8, flexShrink: 0 }} onClick={onBack}><i className="ti ti-arrow-left" style={{ fontSize: 20 }} aria-hidden="true" /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 16, fontWeight: 800, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{localTitle || 'Edit song'}</p>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>{lines.length} lines · Editing: {sourceLabel}</p>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ flexShrink: 0 }}>{saving ? <><i className="ti ti-loader spin" style={{ fontSize: 13 }} aria-hidden="true" /> Saving…</> : 'Save'}</button>
      </div>

      <div className="editor-list">
        {/* Source toggle — only shown when both sources exist */}
        {hasAlt && (
          <div className="source-toggle">
            <button className={`source-tab${!editingAlt ? ' active' : ''}`} onClick={() => handleToggleSource(false)}>AI-corrected</button>
            <button className={`source-tab${editingAlt ? ' active' : ''}`} onClick={() => handleToggleSource(true)}>WhisperX</button>
          </div>
        )}

        {/* Song details — only editable in primary source */}
        {!editingAlt && (
          <div className="card" style={{ marginBottom: 8 }}>
            <span className="card-label">Song details</span>
            <div className="field"><input value={localTitle} onChange={e => setLocalTitle(e.target.value)} placeholder="Song title" /></div>
            <div className="field" style={{ marginBottom: 0 }}><input value={localArtist} onChange={e => setLocalArtist(e.target.value)} placeholder="Artist name" /></div>
          </div>
        )}

        {/* Lyric lines */}
        {lines.map((line, idx) => {
          const isActive = activeIdx === idx;
          if (isActive) return (
            <div key={line.id} className="editor-row-active">
              <div className="editor-row-top">
                <input className="editor-ts-input" defaultValue={fmt(line.time)} onBlur={e => updateLine(idx, 'time', parseTime(e.target.value))} onClick={e => e.stopPropagation()} aria-label="Timestamp" />
                <input className="editor-text-input" type="text" value={line.text} onChange={e => updateLine(idx, 'text', e.target.value)} autoFocus placeholder="Lyric text…" onClick={e => e.stopPropagation()} />
                <button className="btn btn-ghost editor-del-btn" onClick={e => deleteLine(idx, e)} aria-label="Delete line"><i className="ti ti-trash" aria-hidden="true" /></button>
              </div>
              <div className="editor-swatches">
                {EDITOR_COLORS.map(c => { const isSel = line.color === c.hex || (line.color === null && c.hex === '#F4A827'); return (<div key={c.hex} className={`editor-swatch${isSel ? ' editor-swatch--sel' : ''}`} style={{ background: c.hex, '--sw': c.hex }} title={c.name} onClick={e => { e.stopPropagation(); updateLine(idx, 'color', line.color === c.hex ? null : c.hex); }} />); })}
                <span className="editor-color-name">{line.color ? (EDITOR_COLORS.find(c => c.hex === line.color)?.name || '') : 'Amber (default)'}</span>
              </div>
            </div>
          );
          return (
            <div key={line.id} className="editor-row" onClick={() => setActiveIdx(idx)}>
              <span className="editor-ts">{fmt(line.time)}</span>
              <div className="editor-dot" style={{ background: line.color || '#F4A827' }} />
              <span className="editor-text" style={{ color: line.color || 'var(--text)' }}>{line.text || <em style={{ color: 'var(--muted)' }}>empty</em>}</span>
              <button className="btn btn-ghost editor-del-btn" onClick={e => deleteLine(idx, e)} aria-label="Delete line"><i className="ti ti-trash" aria-hidden="true" /></button>
            </div>
          );
        })}

        <button className="btn btn-secondary" onClick={addLine} style={{ marginTop: 10, alignSelf: 'flex-start' }}><i className="ti ti-plus" aria-hidden="true" /> Add line</button>
      </div>
    </div>
  );
}


// ── ADD SONG SCREEN ───────────────────────────────────────────────────────────
function AddSongScreen({ onSave }) {
  const [title, setTitle]         = useState('');
  const [artist, setArtist]       = useState('');
  const [origFile, setOrigFile]   = useState(null);
  const [instrFile, setInstrFile] = useState(null);
  const [lyricsText, setLyricsText] = useState('');
  const [mode, setMode]           = useState('auto');
  const [stage, setStage]         = useState('idle');
  const [demucsState, setDemucsState]   = useState({ status: 'waiting', elapsed: 0 });
  const [whisperState, setWhisperState] = useState({ status: 'waiting', elapsed: 0 });
  const [claudeState, setClaudeState]   = useState({ status: 'waiting', elapsed: 0 });
  const [lrcFound, setLrcFound]   = useState(false);
  const [result, setResult]       = useState(null);
  const [errorMsg, setErrorMsg]   = useState('');
  const cancelRef = useRef({ aborted: false });
  const timers = useRef({});

  function startTick(k, s) { let n = 0; timers.current[k] = setInterval(() => { n++; s(p => ({ ...p, elapsed: n })); }, 1000); }
  function stopTick(k) { clearInterval(timers.current[k]); delete timers.current[k]; }
  useEffect(() => () => { cancelRef.current.aborted = true; Object.values(timers.current).forEach(clearInterval); }, []);

  async function handleProcess() {
    if (!origFile || !title.trim()) return;
    cancelRef.current = { aborted: false };
    setDemucsState({ status: 'waiting', elapsed: 0 });
    setWhisperState({ status: 'waiting', elapsed: 0 });
    setClaudeState({ status: 'waiting', elapsed: 0 });
    setResult(null); setErrorMsg('');

    let originalUrl = null;
    let instrumentalUrl = null, vocalsUrl = null;
    let lyrics = [], lyricsAlt = [], lyricsType = 'none';
    let demucsErr = null, whisperErr = null, claudeApplied = false;

    try {
      // ── Upload ──────────────────────────────────────────────────────────────
      setStage('uploading');
      originalUrl = await uploadAudioToSupabase(origFile);
      if (cancelRef.current.aborted) return;

      const lrcResult = title.trim() ? await lrcSearch(artist, title) : null;
      const hadLrc = !!(lrcResult?.synced?.length > 0);
      setLrcFound(hadLrc);
      const whisperPrompt = lrcResult?.plain || null;

      setStage('processing');

      // ── Step 1: Demucs ───────────────────────────────────────────────────────
      setDemucsState({ status: 'running' });
      startTick('demucs', setDemucsState);
      const demucsId = await repCreate(DEMUCS_VERSION, {
        audio: originalUrl, model_name: 'htdemucs', stem: 'vocals',
        shifts: 1, overlap: 0.25, output_format: 'mp3',
      });

      try {
        const demucsOut = await repPoll(demucsId, (st, el) => {
          if (!cancelRef.current.aborted)
            setDemucsState({ status: st === 'succeeded' ? 'done' : st === 'failed' ? 'error' : 'running', elapsed: el });
        }, cancelRef.current);
        stopTick('demucs'); setDemucsState({ status: 'done' });

        const ir = getInstrumental(demucsOut); const vr = getVocals(demucsOut);
        if (ir) instrumentalUrl = await uploadProcessedToSupabase(ir, 'instrumentals');
        if (vr) vocalsUrl       = await uploadProcessedToSupabase(vr, 'vocals');
        if (originalUrl) await deleteSupabaseFile(originalUrl);
      } catch (e) {
        stopTick('demucs'); demucsErr = e.message; setDemucsState({ status: 'error' });
      }

      if (cancelRef.current.aborted) return;

      // ── Step 2: WhisperX on vocal stem (isolated vocals = better accuracy) ───
      // Uses vocalsUrl (clean vocals from Demucs) instead of original mixed audio.
      const whisperSource = vocalsUrl || originalUrl;
      setWhisperState({ status: 'running' });
      startTick('whisper', setWhisperState);

      let whisperOut = null;
      try {
        const whisperPredId = await repCreate(WHISPERX_VERSION, {
          audio_file: whisperSource,
          align_output: true,
          temperature: 0,
          ...(whisperPrompt ? { initial_prompt: whisperPrompt } : {}),
        });
        whisperOut = await repPoll(whisperPredId, (st, el) => {
          if (!cancelRef.current.aborted)
            setWhisperState({ status: st === 'succeeded' ? 'done' : st === 'failed' ? 'error' : 'running', elapsed: el });
        }, cancelRef.current);
        stopTick('whisper'); setWhisperState({ status: 'done' });

        console.log('[KaraKlas] WhisperX segments:', whisperOut?.segments?.length ?? 0);
        console.log('[KaraKlas] First segment words:', whisperOut?.segments?.[0]?.words ?? 'NONE');
        lyricsAlt = whisperToLines(whisperOut);
        console.log(`[KaraKlas] WhisperX lines: ${lyricsAlt.length}, words: ${lyricsAlt.reduce((n,l)=>n+(l.words?.length||0),0)}`);
      } catch (e) {
        stopTick('whisper'); whisperErr = e.message; setWhisperState({ status: 'error' });
      }

      if (cancelRef.current.aborted) return;

      // ── Step 3: Claude correction ────────────────────────────────────────────
      if (whisperOut && hadLrc && lrcResult?.synced?.length > 0) {
        setClaudeState({ status: 'running' });
        startTick('claude', setClaudeState);
        const corrected = await callClaudeCorrection(whisperOut, lrcResult.synced);
        stopTick('claude');

        if (corrected?.length > 0) {
          lyrics = corrected; lyricsType = 'synced'; claudeApplied = true;
          setClaudeState({ status: 'done' });
        } else {
          // Claude failed — mergeWordsIntoLines keeps LRC line structure
          lyrics = mergeWordsIntoLines(lrcResult.synced, whisperOut);
          lyricsType = 'synced';
          setClaudeState({ status: 'error' });
        }
      } else if (whisperOut) {
        lyrics = lyricsAlt; lyricsType = lyricsAlt.length > 0 ? 'synced' : 'none';
        setClaudeState({ status: 'skipped' });
      } else if (hadLrc) {
        // WhisperX failed entirely — fall back to LRClib
        lyrics = lrcResult.synced.length > 0 ? lrcResult.synced
               : lrcResult.plain.split('\n').filter(Boolean).map((t, i) => ({ id: uid(), time: i * 3, text: t, color: null, words: [] }));
        lyricsType = lrcResult.synced.length > 0 ? 'synced' : 'plain';
        setClaudeState({ status: 'skipped' });
      }

      setResult({ instrumentalUrl, vocalsUrl, lyrics, lyricsAlt, lyricsType, demucsErr, whisperErr, claudeApplied, hadLrc });
      setStage('review');
    } catch (e) {
      Object.values(timers.current).forEach(clearInterval);
      setErrorMsg(e.message); setStage('error');
    }
  }
  if (stage === 'uploading') return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center', padding: '0 32px' }}>
      <i className="ti ti-cloud-upload spin" style={{ fontSize: 40, color: 'var(--muted)' }} aria-hidden="true" />
      <p style={{ fontWeight: 700, fontSize: 16 }}>Uploading "{title}"…</p>
    </div>
  );

  if (stage === 'processing') {
    const claudeSub = lrcFound
      ? 'Claude maps correct lyrics text to WhisperX timestamps'
      : 'Skipped — no LRClib reference available';
    const steps = [
      { key: 'demucs',  icon: 'ti-scissors',        label: 'Separating vocals',      sub: 'Demucs — saves instrumental + vocal stem', ...demucsState },
      { key: 'whisper', icon: 'ti-text-recognition', label: 'Word timing via WhisperX', sub: 'WhisperX on isolated vocal stem — per-word timestamps', ...whisperState },
      { key: 'claude',  icon: 'ti-sparkles',         label: 'AI lyrics correction',   sub: claudeSub, ...claudeState },
    ];
    const statusColour = s => s === 'done' ? '#20bf6b' : s === 'error' ? 'var(--rose)' : s === 'skipped' ? 'var(--muted)' : 'var(--muted)';
    const statusText   = s => s === 'done' ? '✓ Done' : s === 'error' ? 'Failed' : s === 'skipped' ? 'Skipped' : s === 'running' ? '…' : '…';
    return (
      <div className="screen" style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontWeight: 700, fontSize: 17, marginBottom: 2 }}>Processing "{title}"…</p>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.6 }}>Steps run in sequence. WhisperX uses the isolated vocal track for better accuracy.</p>
        {steps.map(step => (
          <div key={step.key} className="step-row">
            <i className={`ti ${step.icon}${step.status === 'running' ? ' spin' : ''}`} style={{ color: statusColour(step.status) }} aria-hidden="true" />
            <div className="step-info"><div className="step-title">{step.label}</div><div className="step-sub">{step.sub}</div></div>
            <div className="step-status" style={{ color: statusColour(step.status) }}>
              {step.status === 'running' ? fmt(step.elapsed) : statusText(step.status)}
            </div>
          </div>
        ))}
        <button className="btn btn-secondary" onClick={() => { cancelRef.current.aborted = true; setStage('idle'); }}><i className="ti ti-x" aria-hidden="true" /> Cancel</button>
      </div>
    );
  }

  if (stage === 'review' && result) {
    const primaryWordCount = result.lyrics.reduce((n, l) => n + (l.words?.length || 0), 0);
    const altWordCount     = result.lyricsAlt.reduce((n, l) => n + (l.words?.length || 0), 0);
    return (
      <div className="screen" style={{ padding: '16px 18px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontWeight: 700, fontSize: 17, margin: '6px 0 0' }}>Review & save</p>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <i className={`ti ${result.instrumentalUrl ? 'ti-check' : 'ti-alert-triangle'}`} style={{ fontSize: 20, color: result.instrumentalUrl ? '#20bf6b' : 'var(--amber)', flexShrink: 0 }} aria-hidden="true" />
            <div><p style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{result.instrumentalUrl ? 'Karaoke track saved' : 'Vocal separation failed'}</p>{result.vocalsUrl && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 0 0' }}>Vocal stem saved</p>}</div>
          </div>
          <div className="divider" style={{ margin: 0 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <i className={`ti ${primaryWordCount > 0 ? 'ti-check' : result.lyrics.length > 0 ? 'ti-alert-triangle' : 'ti-x'}`} style={{ fontSize: 20, color: primaryWordCount > 0 ? '#20bf6b' : result.lyrics.length > 0 ? 'var(--amber)' : 'var(--rose)', flexShrink: 0 }} aria-hidden="true" />
            <div>
              <p style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
                {result.claudeApplied ? 'AI-corrected lyrics' : result.hadLrc ? 'LRClib fallback (Claude failed)' : 'WhisperX transcription'}
                {' — '}{result.lyrics.length} lines{primaryWordCount > 0 ? `, ${primaryWordCount} words` : ''}
              </p>
              {altWordCount > 0 && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 0 0' }}>WhisperX backup also saved ({altWordCount} words) — toggle in editor</p>}
            </div>
          </div>
        </div>
        {result.lyrics.length > 0 && (
          <div className="card" style={{ padding: '12px 14px' }}>
            <span className="card-label">Preview (primary source)</span>
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
        <p className="pin-note"><i className="ti ti-pin" aria-hidden="true" /> Use ✏️ to edit lyrics. If AI-corrected looks wrong, toggle to WhisperX in the editor.</p>
        <button className="btn btn-process btn-full" onClick={handleSave}><i className="ti ti-device-floppy" aria-hidden="true" /> Save "{title}" to library</button>
      </div>
    );
  }

  if (stage === 'error') return (
    <div className="screen" style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="warn-box"><p style={{ fontWeight: 700, marginBottom: 6 }}><i className="ti ti-alert-triangle" aria-hidden="true" /> Processing failed</p><p style={{ margin: 0, wordBreak: 'break-word' }}>{errorMsg}</p></div>
      <button className="btn btn-secondary btn-full" onClick={() => { setStage('idle'); setErrorMsg(''); }}><i className="ti ti-refresh" aria-hidden="true" /> Try again</button>
    </div>
  );

  return (
    <div className="screen" style={{ padding: '8px 18px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="mode-tabs">{['auto', 'manual'].map(m => (<button key={m} className={`mode-tab${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}><i className={`ti ${m === 'auto' ? 'ti-sparkles' : 'ti-upload'}`} aria-hidden="true" style={{ marginRight: 5, fontSize: 13 }} />{m === 'auto' ? 'Auto · Replicate' : 'Manual'}</button>))}</div>
      <div className="card"><span className="card-label">Song details</span><div className="field"><input placeholder="Song title *" value={title} onChange={e => setTitle(e.target.value)} /></div><div className="field"><input placeholder="Artist name" value={artist} onChange={e => setArtist(e.target.value)} /></div></div>
      {mode === 'auto' && (<><div className="card"><span className="card-label">Upload original song</span><p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>Demucs separates vocals. WhisperX aligns word timestamps. Claude corrects text using LRClib. Original deleted after.</p><label className={`upload-zone${origFile ? ' has-file' : ''}`}><input type="file" accept="audio/*" onChange={e => setOrigFile(e.target.files[0])} /><i className={`ti ${origFile ? 'ti-check' : 'ti-file-music'}`} style={{ color: origFile ? '#20bf6b' : 'var(--muted)' }} aria-hidden="true" />{origFile ? <p className="filename">{origFile.name}</p> : <><p style={{ fontWeight: 700, color: 'var(--text)' }}>Drop audio file here</p><p>MP3, WAV, FLAC, M4A</p></>}</label></div><div className="info-box"><i className="ti ti-info-circle" aria-hidden="true" /> LRClib checked first for correct lyrics text. WhisperX provides timing. Claude combines both.</div><button className="btn btn-process btn-full" onClick={handleProcess} disabled={!origFile || !title.trim()}><i className="ti ti-sparkles" aria-hidden="true" /> Process with Replicate + AI</button></>)}
      {mode === 'manual' && (<><div className="card"><span className="card-label">Lyrics</span><button className="btn btn-secondary btn-full" style={{ marginBottom: 12 }} onClick={async () => { if (!title.trim()) return; const res = await lrcSearch(artist, title); if (res?.plain) setLyricsText(res.plain); else alert('Not found on LRClib.'); }}><i className="ti ti-search" aria-hidden="true" /> Search LRClib</button><textarea value={lyricsText} onChange={e => setLyricsText(e.target.value)} placeholder={"Paste lyrics here…\n\nOr LRC format:\n[00:12.34]First line"} rows={7} /></div><div className="card"><span className="card-label">Instrumental track</span><label className={`upload-zone${instrFile ? ' has-file' : ''}`}><input type="file" accept="audio/*" onChange={e => setInstrFile(e.target.files[0])} /><i className={`ti ${instrFile ? 'ti-check' : 'ti-music'}`} style={{ color: instrFile ? '#20bf6b' : 'var(--muted)' }} aria-hidden="true" />{instrFile ? <p className="filename">{instrFile.name}</p> : <><p style={{ fontWeight: 700, color: 'var(--text)' }}>Upload karaoke / instrumental</p><p>MP3, WAV, M4A</p></>}</label></div><button className="btn btn-primary btn-full" onClick={handleSave} disabled={!title.trim()}><i className="ti ti-plus" aria-hidden="true" /> Add to library</button></>)}
    </div>
  );
}


// ── PLAYER SCREEN ─────────────────────────────────────────────────────────────
function PlayerScreen({ song, settings, autoPlay, randomMode, nextUpSong, onBack, onSongEnd, onStartRandom, onStopRandom, onSkipRandom, onGoToPrevious }) {
  const audioRef  = useRef(null);
  const guideRef  = useRef(null);
  const rafRef    = useRef(null);
  const stateRef  = useRef({});

  const [playing, setPlaying]             = useState(false);
  const [currentTime, setCurrentTime]     = useState(0);
  const [duration, setDuration]           = useState(0);
  const [activeLine, setActiveLine]       = useState(-1);
  const [guideVolume, setGuideVolume]     = useState(settings?.defaultGuideVolume ?? 0);
  const [guideExpanded, setGuideExpanded] = useState(false);
  const [playError, setPlayError]         = useState(null);

  const [isCinematic, setIsCinematic] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);
  useEffect(() => { const check = () => setIsCinematic(window.innerWidth >= 768); window.addEventListener('resize', check); return () => window.removeEventListener('resize', check); }, []);

  stateRef.current = { playing, currentTime, duration, randomMode, guideVolume };

  useEffect(() => {
    setPlaying(false); setCurrentTime(0); setDuration(0); setActiveLine(-1);
    setGuideExpanded(false); setGuideVolume(settings?.defaultGuideVolume ?? 0); setPlayError(null);
    if (autoPlay) { const t = setTimeout(() => setPlaying(true), 150); return () => clearTimeout(t); }
  }, [song.id]);

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const onMeta = () => setDuration(a.duration);
    const onEnd  = () => { setPlaying(false); setActiveLine(-1); onSongEnd?.(); };
    a.addEventListener('loadedmetadata', onMeta); a.addEventListener('ended', onEnd);
    return () => { a.removeEventListener('loadedmetadata', onMeta); a.removeEventListener('ended', onEnd); };
  }, [song.id]);

  useEffect(() => {
    const main = audioRef.current; const guide = guideRef.current; if (!main) return;
    if (playing) {
      main.play().catch(err => { console.error('Playback failed:', err.message); if (song.audioUrl?.startsWith('blob:')) console.warn('Expired blob URL — re-add this song'); setPlaying(false); setPlayError(song.audioUrl?.startsWith('blob:') ? 'Audio expired — re-add this song to fix.' : `Could not play. (${err.message})`); });
      if (guide && guideVolume > 0) { guide.currentTime = main.currentTime; guide.play().catch(() => {}); }
      const tick = () => {
        const t = main.currentTime; setCurrentTime(t);
        if (song.lyrics?.length > 0) { let idx = -1; for (let i = 0; i < song.lyrics.length; i++) { if (song.lyrics[i].time <= t) idx = i; else break; } setActiveLine(idx); }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else { main.pause(); guide?.pause(); cancelAnimationFrame(rafRef.current); }
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  useEffect(() => {
    const guide = guideRef.current; if (!guide) return;
    guide.volume = guideVolume;
    if (playing && guideVolume > 0) { guide.currentTime = audioRef.current?.currentTime || 0; guide.play().catch(() => {}); }
    else if (guideVolume === 0) guide.pause();
  }, [guideVolume]);

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const { playing, currentTime, duration, randomMode, guideVolume } = stateRef.current;
      switch (e.key) {
        case ' ': e.preventDefault(); setPlaying(p => !p); break;
        case 'Escape': e.preventDefault(); onBack?.(); break;
        case 'ArrowRight': e.preventDefault(); if (randomMode) { onSkipRandom?.(); } else if (audioRef.current) { const t = Math.min(duration, currentTime + 10); audioRef.current.currentTime = t; if (guideRef.current) guideRef.current.currentTime = t; setCurrentTime(t); } break;
        case 'ArrowLeft': e.preventDefault(); if (currentTime <= 2) { onGoToPrevious?.(); } else { if (audioRef.current) { audioRef.current.currentTime = 0; setCurrentTime(0); setActiveLine(-1); } if (guideRef.current) guideRef.current.currentTime = 0; } break;
        case 'm': case 'M': setGuideVolume(v => v > 0 ? 0 : 0.3); break;
        case 'r': case 'R': if (randomMode) onStopRandom?.(); else onStartRandom?.(); break;
        case 'f': case 'F': if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch?.(() => {}); else document.exitFullscreen?.().catch?.(() => {}); break;
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function seek(e) { const r = e.currentTarget.getBoundingClientRect(); const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (duration || 0); if (audioRef.current) audioRef.current.currentTime = t; if (guideRef.current) guideRef.current.currentTime = t; setCurrentTime(t); }
  function handleRestart() { if (audioRef.current) { audioRef.current.currentTime = 0; setCurrentTime(0); setActiveLine(-1); } if (guideRef.current) guideRef.current.currentTime = 0; }
  function handleSkip() { if (randomMode) { onSkipRandom?.(); return; } if (audioRef.current) { const t = Math.min(duration, currentTime + 10); audioRef.current.currentTime = t; if (guideRef.current) guideRef.current.currentTime = t; setCurrentTime(t); } }

  // Respect the source preference saved from the editor
  const lyrics   = (song.lyricsSource === 'alt' && song.lyricsAlt?.length > 0)
    ? song.lyricsAlt
    : (song.lyrics || []);
  const hasWords = lyrics.some(l => l.words?.length > 0);
  const pct      = duration > 0 ? (currentTime / duration) * 100 : 0;
  const c        = songColor(song);
  const showNextUp = !!nextUpSong && duration > 0 && (duration - currentTime) <= 20 && (duration - currentTime) > 0;

  function renderActiveLine(line) {
    if (!line) return '\u00A0';
    const lineColor = line.color || 'var(--amber)';
    if (line.words?.length > 0) {
      return (<span>{line.words.map((w, i) => { let color; if (currentTime >= w.end) color = 'rgba(237,233,224,0.18)'; else if (currentTime >= w.start) color = makePale(line.color || '#F4A827'); else color = lineColor; return <span key={i} style={{ color, transition: 'color 0.1s' }}>{w.word}{i < line.words.length - 1 ? ' ' : ''}</span>; })}</span>);
    }
    return line.text;
  }

  const audioEls = (<>{song.audioUrl && <audio ref={audioRef} src={song.audioUrl} preload="metadata" />}{song.vocalsUrl && <audio ref={guideRef} src={song.vocalsUrl} preload="metadata" />}</>);

  const randomBand = randomMode && (<div className="random-band"><div className="random-band-label"><i className="ti ti-arrows-shuffle" style={{ fontSize: 14 }} aria-hidden="true" /> Random mode</div><button className="random-stop-btn" onClick={onStopRandom} aria-label="Stop random mode"><i className="ti ti-x" style={{ fontSize: 11 }} aria-hidden="true" /> Stop</button></div>);

  const lyricsArea = (
    <div className="lyrics-area">
      {lyrics.length === 0 && !song.plainLyrics && (<p style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 15 }}>No lyrics added</p>)}
      {lyrics.length === 0 && song.plainLyrics && (<div style={{ overflowY: 'auto', maxHeight: 300, textAlign: 'center', fontSize: 14, lineHeight: 2.1, color: 'var(--muted)', width: '100%' }}>{song.plainLyrics.split('\n').map((ln, i) => (<div key={i} style={{ color: ln.trim() ? 'var(--text)' : 'transparent', minHeight: '1.5em' }}>{ln || '·'}</div>))}</div>)}
      {lyrics.length > 0 && (() => {
        const currentLine   = lyrics[activeLine];
        const nextLine      = lyrics[activeLine + 1];
        const timeToNext    = nextLine ? nextLine.time - currentTime : null;
        const lastWordEnd   = currentLine?.words?.length > 0 ? currentLine.words[currentLine.words.length - 1].end : null;
        const singEnd       = lastWordEnd ?? currentLine?.time ?? 0;
        const totalBreak    = nextLine ? nextLine.time - singEnd : 0;
        const pastSinging   = lastWordEnd ? currentTime >= lastWordEnd : (currentTime - (currentLine?.time ?? 0)) >= 2;
        const inBreak       = activeLine >= 0 && nextLine !== undefined && totalBreak >= 20 && pastSinging && timeToNext !== null && timeToNext > 0;
        const breakDuration = inBreak ? Math.round(totalBreak) : 0;
        const classMap      = { '-2':'past','-1':'past','0':'active','1':'next1','2':'next2' };
        return (
          <>
            {[-2,-1,0].map(off => {
              const line      = lyrics[activeLine + off];
              const isCur     = off === 0;
              const lineColor = line?.color || 'var(--amber)';
              const cls       = (isCur && inBreak) ? 'past' : classMap[String(off)];
              return (<div key={off} className={`lyric-line ${cls}`} style={(isCur && !inBreak) ? { color: lineColor, textShadow: `0 0 28px ${lineColor}50` } : undefined}>{isCur ? renderActiveLine(line) : (line ? line.text : '\u00A0')}</div>);
            })}
            {inBreak && <div className="lyric-break-info">Musical break — {breakDuration}s</div>}
            {[1,2].map(off => { const line = lyrics[activeLine + off]; return (<div key={off} className={`lyric-line ${classMap[String(off)]}`}>{line ? line.text : '\u00A0'}</div>); })}
          </>
        );
      })()}
    </div>
  );

  const nextUpCard = showNextUp && (() => { const nc = songColor(nextUpSong); return (<div className="next-up-card" onClick={() => onSkipRandom?.()}><div className="song-avatar" style={{ background: nc.bg, color: nc.fg, width: 36, height: 36, fontSize: 15, flexShrink: 0 }}>{nextUpSong.title[0]?.toUpperCase()}</div><div style={{ flex: 1, minWidth: 0 }}><p className="next-up-label">Up next</p><p className="next-up-title">{nextUpSong.title}</p><p className="next-up-artist">{nextUpSong.artist}</p></div><i className="ti ti-chevron-right" style={{ fontSize: 16, color: 'var(--muted)', flexShrink: 0 }} aria-hidden="true" /></div>); })();

  const playBtn = (<button className="play-btn" onClick={() => setPlaying(p => !p)} disabled={!song.audioUrl} aria-label={playing ? 'Pause' : 'Play'}><i className={`ti ${playing ? 'ti-player-pause' : 'ti-player-play'}`} aria-hidden="true" /></button>);

  const hintLine = <p style={{ textAlign: 'center', fontSize: 10, color: 'rgba(91,98,128,0.4)', padding: '0 0 8px', margin: 0 }}>Space · Esc · ← → · M · R · F</p>;

  if (isCinematic) return (
    <div className="player-screen" style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      {audioEls}{randomBand}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 28px', borderBottom: '0.5px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <button className="player-back" onClick={onBack} aria-label="Back"><i className="ti ti-arrow-left" aria-hidden="true" /></button>
        <p style={{ flex: 1, fontSize: 14, color: 'rgba(200,205,230,0.65)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{song.title}{song.artist ? ` — ${song.artist}` : ''}</p>
        {!song.audioUrl && <span className="badge badge-amber">No audio</span>}
        {hasWords && <span className="badge badge-teal badge-xs" style={{ flexShrink: 0 }}>⚡ Words</span>}
      </div>
      {playError && (<div style={{ margin: '0 28px 8px', padding: '10px 14px', background: 'rgba(232,96,122,0.12)', border: '1px solid rgba(232,96,122,0.25)', borderRadius: 'var(--radius)', fontSize: 13, color: '#E8607A', lineHeight: 1.5 }}>{playError}</div>)}
      {lyricsArea}{nextUpCard}
      {guideExpanded && (<div className="cinematic-guide-panel"><i className="ti ti-microphone" style={{ fontSize: 18, color: guideVolume > 0 ? 'var(--amber)' : 'var(--muted)', flexShrink: 0 }} aria-hidden="true" /><input type="range" min="0" max="1" step="0.02" value={guideVolume} onChange={e => setGuideVolume(parseFloat(e.target.value))} className="guide-slider" aria-label="Guide vocals volume" /><span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 36, textAlign: 'right', flexShrink: 0 }}>{guideVolume === 0 ? 'Off' : `${Math.round(guideVolume * 100)}%`}</span></div>)}
      <div className="cinematic-bar">
        <button className="ctrl-btn" onClick={handleRestart} aria-label="Restart"><i className="ti ti-player-skip-back" aria-hidden="true" /></button>
        {playBtn}
        <button className="ctrl-btn" onClick={handleSkip} aria-label={randomMode ? 'Next random' : 'Skip 10s'}><i className="ti ti-player-skip-forward" aria-hidden="true" /></button>
        <div className="cinematic-progress" onClick={seek}><div className="cinematic-fill" style={{ width: `${pct}%` }} /></div>
        <span className="cinematic-time">{fmt(currentTime)} / {fmt(duration)}</span>
        <button className={`guide-toggle-btn${guideVolume > 0 ? ' active' : ''}`} onClick={() => setGuideExpanded(p => !p)} aria-label="Guide vocals"><i className="ti ti-microphone" style={{ fontSize: 19 }} aria-hidden="true" />{guideVolume > 0 && !guideExpanded && <span style={{ fontSize: 11 }}>{Math.round(guideVolume * 100)}%</span>}</button>
      </div>
      {hintLine}
    </div>
  );

  return (
    <div className="player-screen">
      {audioEls}{randomBand}
      <div className="player-header">
        <button className="player-back" onClick={onBack} aria-label="Back"><i className="ti ti-arrow-left" aria-hidden="true" /></button>
        <div className="song-avatar" style={{ background: c.bg, color: c.fg, width: 44, height: 44, fontSize: 18 }}>{song.title[0]?.toUpperCase()}</div>
        <div className="player-meta"><div className="player-title">{song.title}</div><div className="player-artist">{song.artist || 'Unknown artist'}</div></div>
        {!song.audioUrl && <span className="badge badge-amber">No audio</span>}
        {hasWords && <span className="badge badge-teal badge-xs">⚡ Words</span>}
      </div>
      {playError && (<div style={{ margin: '0 20px 6px', padding: '10px 14px', background: 'rgba(232,96,122,0.12)', border: '1px solid rgba(232,96,122,0.25)', borderRadius: 'var(--radius)', fontSize: 13, color: '#E8607A', lineHeight: 1.5 }}>{playError}</div>)}
      {lyricsArea}{nextUpCard}
      <div className="progress-wrap"><div className="progress-track" onClick={seek}><div className="progress-fill" style={{ width: `${pct}%` }} /></div><div className="time-row"><span>{fmt(currentTime)}</span><span>{fmt(duration)}</span></div></div>
      <div className="guide-panel">
        <button className={`guide-toggle-btn${guideVolume > 0 ? ' active' : ''}`} onClick={() => setGuideExpanded(p => !p)} aria-label="Guide vocals"><i className="ti ti-microphone" style={{ fontSize: 19 }} aria-hidden="true" />{guideVolume > 0 && !guideExpanded && <span style={{ fontSize: 11 }}>{Math.round(guideVolume * 100)}%</span>}</button>
        {guideExpanded && (<div className="guide-slider-wrap"><span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{guideVolume === 0 ? 'Off' : `${Math.round(guideVolume * 100)}%`}</span><input type="range" min="0" max="1" step="0.02" value={guideVolume} onChange={e => setGuideVolume(parseFloat(e.target.value))} className="guide-slider" aria-label="Guide vocals volume" /></div>)}
      </div>
      <div className="controls">
        <button className="ctrl-btn" onClick={handleRestart} aria-label="Restart"><i className="ti ti-player-skip-back" aria-hidden="true" /></button>
        {playBtn}
        <button className="ctrl-btn" onClick={handleSkip} aria-label={randomMode ? 'Next random' : 'Skip 10s'}><i className="ti ti-player-skip-forward" aria-hidden="true" /></button>
      </div>
      {hintLine}
    </div>
  );
}


// ── SETTINGS SCREEN ───────────────────────────────────────────────────────────
function SettingsScreen({ settings, onSettingsChange }) {
  const hasSupabase = !!(SUPA_URL && SUPA_KEY);
  return (
    <div className="screen">
      <div className="page-header"><div><div className="page-title">Settings</div><div className="page-sub">App configuration</div></div></div>
      <div style={{ padding: '0 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className={hasSupabase ? 'success-box' : 'warn-box'}><p style={{ fontWeight: 700, margin: '0 0 4px' }}><i className={`ti ${hasSupabase ? 'ti-check' : 'ti-alert-triangle'}`} aria-hidden="true" /> Supabase — {hasSupabase ? 'connected' : 'not configured'}</p><p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{hasSupabase ? 'Songs and audio saved to cloud. Deleted songs archived.' : 'Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to Vercel env vars.'}</p></div>
        <div className="card"><span className="card-label">Guide vocals — default level</span><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><i className="ti ti-microphone" style={{ fontSize: 18, color: settings.defaultGuideVolume > 0 ? 'var(--amber)' : 'var(--muted)' }} aria-hidden="true" /><input type="range" min="0" max="1" step="0.05" value={settings.defaultGuideVolume ?? 0} onChange={e => onSettingsChange({ defaultGuideVolume: parseFloat(e.target.value) })} style={{ flex: 1 }} /><span style={{ fontSize: 13, color: 'var(--muted)', minWidth: 34, textAlign: 'right' }}>{settings.defaultGuideVolume > 0 ? `${Math.round((settings.defaultGuideVolume ?? 0) * 100)}%` : 'Off'}</span></div></div>
        <div className="card"><span className="card-label">After a song finishes</span><div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>{[{ value: false, label: 'Stop playing', sub: 'Player pauses at the end (default)' }, { value: true, label: 'Play next random song', sub: 'Picks a random song automatically' }].map(opt => (<label key={String(opt.value)} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', padding: '4px 0' }}><div style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0, border: '2px solid', borderColor: (settings.autoPlayRandom ?? false) === opt.value ? 'var(--amber)' : 'var(--border)', background: (settings.autoPlayRandom ?? false) === opt.value ? 'var(--amber)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{(settings.autoPlayRandom ?? false) === opt.value && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--bg)' }} />}</div><div><p style={{ fontSize: 14, margin: 0 }}>{opt.label}</p><p style={{ fontSize: 11, color: 'var(--muted)', margin: '1px 0 0' }}>{opt.sub}</p></div><input type="radio" style={{ display: 'none' }} checked={(settings.autoPlayRandom ?? false) === opt.value} onChange={() => onSettingsChange({ autoPlayRandom: opt.value })} /></label>))}</div></div>
        <div className="card"><span className="card-label">Keyboard shortcuts</span><div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 13 }}>{[['Space','Play / pause'],['Esc','Close player'],['←','Restart (or prev song if within 2s)'],['→','Skip +10s (or next random)'],['M','Toggle guide vocals mute'],['R','Toggle random mode'],['F','Fullscreen']].map(([k,v]) => (<><span key={k+'k'} style={{ fontFamily: 'monospace', background: 'var(--elevated)', padding: '1px 7px', borderRadius: 4, color: 'var(--amber)', whiteSpace: 'nowrap', alignSelf: 'start' }}>{k}</span><span key={k+'v'} style={{ color: 'var(--muted)' }}>{v}</span></>))}</div></div>
        <div className="success-box"><p style={{ fontWeight: 700, margin: '0 0 4px' }}><i className="ti ti-check" aria-hidden="true" /> Replicate + Claude — server-side</p><p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>Demucs + WhisperX via <code>/api/replicate</code>. Claude correction via <code>/api/claude</code>. Keys in Vercel env vars.</p></div>
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
  const [randomMode, setRandomMode] = useState(false);
  const [nextUpSong, setNextUpSong] = useState(null);
  const [settings, setSettings]     = useState(() => ({ defaultGuideVolume: 0, autoPlayRandom: false, ...loadSettings() }));

  const shouldAutoPlayRef = useRef(false);
  const songHistoryRef    = useRef([]);

  useEffect(() => { loadLibrary().then(loaded => { setSongs(loaded); setLoading(false); }); }, []);
  useEffect(() => { if (randomMode && activeSong && songs.length > 1) setNextUpSong(pickRandomSong(songs, activeSong.id)); else if (!randomMode) setNextUpSong(null); }, [randomMode, activeSong?.id, songs.length]);

  function navigateToSong(song) { if (activeSong) songHistoryRef.current = [...songHistoryRef.current.slice(-19), activeSong]; shouldAutoPlayRef.current = true; setActiveSong(song); }
  function handlePlaySong(song) { if (activeSong) songHistoryRef.current = [...songHistoryRef.current.slice(-19), activeSong]; shouldAutoPlayRef.current = false; if (randomMode) stopRandomMode(); setActiveSong(song); }
  function navigateToPrevious() { const prev = songHistoryRef.current[songHistoryRef.current.length - 1]; if (!prev) return; songHistoryRef.current = songHistoryRef.current.slice(0, -1); shouldAutoPlayRef.current = true; setActiveSong(prev); }

  function handleSongEnd() { if (randomMode) { const next = nextUpSong || pickRandomSong(songs, activeSong?.id); if (next) { navigateToSong(next); return; } } if (settings.autoPlayRandom && songs.length > 1) { const next = pickRandomSong(songs, activeSong?.id); if (next) { navigateToSong(next); return; } } shouldAutoPlayRef.current = false; }
  function startRandomMode() { const first = pickRandomSong(songs, activeSong?.id); if (!first) return; setRandomMode(true); navigateToSong(first); }
  function stopRandomMode()  { setRandomMode(false); setNextUpSong(null); }
  function skipToNextRandom() { const next = nextUpSong || pickRandomSong(songs, activeSong?.id); if (next) navigateToSong(next); }

  function handleSettingsChange(patch) { const u = { ...settings, ...patch }; setSettings(u); persistSettings(u); }
  async function handleAddSong(song)   { const s = { ...song, addedAt: Date.now() }; setSongs(prev => [s, ...prev]); setTab('library'); await saveSongData(s); }
  async function handleSaveEdited(s)   { setSongs(prev => prev.map(x => x.id === s.id ? s : x)); setEditingSong(null); await saveSongData(s); }
  async function handleDeleteSong(song) { setSongs(prev => prev.filter(s => s.id !== song.id)); await archiveDeletedSong(song); }

  if (editingSong) return (<div className="app-shell app-shell--wide"><EditorScreen song={editingSong} onSave={handleSaveEdited} onBack={() => setEditingSong(null)} /></div>);

  if (activeSong) return (
    <div className="app-shell app-shell--player">
      <PlayerScreen song={activeSong} settings={settings} autoPlay={shouldAutoPlayRef.current} randomMode={randomMode} nextUpSong={nextUpSong}
        onBack={() => { stopRandomMode(); setActiveSong(null); }} onSongEnd={handleSongEnd}
        onStartRandom={startRandomMode} onStopRandom={stopRandomMode} onSkipRandom={skipToNextRandom} onGoToPrevious={navigateToPrevious} />
    </div>
  );

  return (
    <div className="app-shell">
      {loading && (<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--muted)' }}><i className="ti ti-loader spin" style={{ fontSize: 22 }} aria-hidden="true" /> Loading your library…</div>)}
      {!loading && (<>
        {tab === 'library'  && <LibraryScreen songs={songs} onPlay={handlePlaySong} onEdit={setEditingSong} onDelete={handleDeleteSong} onStartRandom={startRandomMode} />}
        {tab === 'add'      && <AddSongScreen onSave={handleAddSong} />}
        {tab === 'settings' && <SettingsScreen settings={settings} onSettingsChange={handleSettingsChange} />}
        <nav className="bottom-nav">
          <button className={`nav-btn${tab === 'library' ? ' active' : ''}`} onClick={() => setTab('library')}><i className="ti ti-playlist" aria-hidden="true" /> Library</button>
          <button className="fab" onClick={() => setTab('add')} aria-label="Add song"><i className="ti ti-plus" aria-hidden="true" /></button>
          <button className={`nav-btn${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}><i className="ti ti-settings" aria-hidden="true" /> Settings</button>
        </nav>
      </>)}
    </div>
  );
}
