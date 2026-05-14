import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

// ── Supabase client ───────────────────────────────────────────────────────────
// Credentials are intentionally in the browser — Supabase is designed for this.
const SUPA_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null;

async function uploadAudioToSupabase(file) {
  if (!supabase) throw new Error(
    'Supabase not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to Vercel env vars, then redeploy.'
  );
  const ext = file.name.split('.').pop() || 'mp3';
  const path = `originals/${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from('songs')
    .upload(path, file, { upsert: false });
  if (error) throw new Error(`Audio upload failed: ${error.message}`);
  const { data } = supabase.storage.from('songs').getPublicUrl(path);
  return data.publicUrl;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function parseLRC(lrc) {
  if (!lrc) return [];
  return lrc.split('\n').flatMap(line => {
    const m = line.match(/^\[(\d{2}):(\d{2})\.(\d{1,3})\](.*)/);
    if (!m) return [];
    const t = +m[1] * 60 + +m[2] + +m[3].padEnd(3, '0') / 1000;
    const text = m[4].trim();
    return text ? [{ time: t, text }] : [];
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

// ── Replicate model version hashes ───────────────────────────────────────────
// Using explicit version hashes is more reliable than model-name-only calls.
// To update: visit replicate.com/cjwbw/demucs or replicate.com/openai/whisper
// → click the "API" tab → copy the hash shown at the top.
const DEMUCS_VERSION  = '25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953';
const WHISPER_VERSION = '8099696689d249cf8b122d833c36ac3f75505c666a395ca40ef26f68e7d3d16e';

// ── Replicate API — goes through /api/replicate (Vercel proxy) ──────────────
// This avoids CORS issues and keeps the API key server-side.

async function repCreate(version, input) {
  const r = await fetch('/api/replicate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', version, input }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.id;
}

async function repPoll(predId, onTick, cancelRef) {
  let elapsed = 0;
  while (!cancelRef.aborted) {
    await sleep(3500);
    elapsed += 3.5;
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

function whisperToLines(out) {
  if (!out) return [];
  if (out.segments?.length > 0) {
    return out.segments
      .map(s => ({ time: s.start, text: s.text.trim() }))
      .filter(l => l.text);
  }
  const text = out.transcription || out.text || (typeof out === 'string' ? out : '');
  return text.split(/\n+/).filter(Boolean).map((t, i) => ({ time: i * 3, text: t.trim() }));
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

// Fetch a remote URL and create a local blob URL (for storing Replicate output)
async function toBlobUrl(url) {
  try {
    const r = await fetch(url);
    const blob = await r.blob();
    return URL.createObjectURL(blob);
  } catch { return url; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = s => (!s || isNaN(s)) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const uid = () => Math.random().toString(36).slice(2, 9);

const AVATAR_COLORS = [
  { bg: '#1a2a4a', fg: '#45aaf2' },
  { bg: '#1a3a2a', fg: '#20bf6b' },
  { bg: '#3a1a2a', fg: '#e8607a' },
  { bg: '#3a2a0a', fg: '#f4a827' },
];
const songColor = s => AVATAR_COLORS[(s.title.charCodeAt(0) || 0) % AVATAR_COLORS.length];


// ── LIBRARY SCREEN ────────────────────────────────────────────────────────────

function LibraryScreen({ songs, onPlay }) {
  const [q, setQ] = useState('');
  const filtered = songs.filter(s =>
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
        <input
          placeholder="Search songs…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
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
          <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '28px 0' }}>
            No results for "{q}"
          </p>
        )}
        {filtered.map(song => {
          const c = songColor(song);
          return (
            <div key={song.id} className="song-card" onClick={() => onPlay(song)}>
              <div className="song-avatar" style={{ background: c.bg, color: c.fg }}>
                {song.title[0]?.toUpperCase()}
              </div>
              <div className="song-info">
                <div className="song-title">{song.title}</div>
                <div className="song-artist">{song.artist || 'Unknown artist'}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                {song.hasAudio && <span className="badge badge-green">Ready</span>}
                {song.lyricsType === 'synced' && <span className="badge badge-blue">Synced</span>}
                {song.lyricsType === 'plain' && <span className="badge badge-muted">Lyrics</span>}
                {song.lyricsType === 'none' && <span className="badge badge-amber">No lyrics</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ── ADD SONG SCREEN ───────────────────────────────────────────────────────────

function AddSongScreen({ onSave, onBack }) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [origFile, setOrigFile] = useState(null);
  const [instrFile, setInstrFile] = useState(null);
  const [lyricsText, setLyricsText] = useState('');
  const [mode, setMode] = useState('auto');

  // Processing state
  const [stage, setStage] = useState('idle'); // idle|uploading|processing|review|error
  const [demucsState, setDemucsState] = useState({ status: 'waiting', elapsed: 0 });
  const [whisperState, setWhisperState] = useState({ status: 'waiting', elapsed: 0 });
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const cancelRef = useRef({ aborted: false });
  const timers = useRef({});

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
      // Upload audio to Supabase Storage, then pass the public URL to Replicate.
      // This avoids sending large files through Vercel (which has a 4.5MB limit).
      setStage('uploading');
      const audioUrl = await uploadAudioToSupabase(origFile);
      if (cancelRef.current.aborted) return;

      // Try LRClib first — free and instant, saves Whisper credits if found
      const lrcResult = title.trim() ? await lrcSearch(artist, title) : null;
      const skipWhisper = lrcResult?.synced?.length > 0;

      setStage('processing');

      // Start Demucs first (vocal separation).
      // stem:'vocals' gives us two outputs: the isolated vocals + the no_vocals instrumental.
      setDemucsState(p => ({ ...p, status: 'running' }));
      startTick('demucs', setDemucsState);
      const demucsId = await repCreate(DEMUCS_VERSION, {
        audio: audioUrl,
        model_name: 'htdemucs',
        stem: 'vocals',
        shifts: 1,
        overlap: 0.25,
        output_format: 'mp3',
      });

      // Small gap before second request — avoids hitting the burst-of-1 rate limit
      // on Replicate accounts with low credit balance.
      await sleep(2000);

      // Start Whisper (transcription) — skip if LRClib already found synced lyrics.
      setWhisperState(p => ({ ...p, status: skipWhisper ? 'skipped_lrc' : 'running' }));
      if (!skipWhisper) startTick('whisper', setWhisperState);
      const whisperPredId = skipWhisper
        ? null
        : await repCreate(WHISPER_VERSION, {
            audio: audioUrl,
            word_timestamps: false,
            temperature: 0,
          });
      if (cancelRef.current.aborted) return;

      let instrumentalUrl = null, lyrics = [], lyricsType = 'none';
      let demucsErr = null, whisperErr = null;

      // Poll both concurrently (polling is cheap — no rate limit impact)
      await Promise.allSettled([
        repPoll(demucsId, (st, el) => {
          if (!cancelRef.current.aborted)
            setDemucsState({ status: st === 'succeeded' ? 'done' : st === 'failed' ? 'error' : 'running', elapsed: el });
        }, cancelRef.current).then(async out => {
          stopTick('demucs');
          setDemucsState(p => ({ ...p, status: 'done' }));
          const rawUrl = getInstrumental(out);
          if (rawUrl) instrumentalUrl = await toBlobUrl(rawUrl);
        }).catch(e => {
          stopTick('demucs');
          demucsErr = e.message;
          setDemucsState(p => ({ ...p, status: 'error' }));
        }),

        whisperPredId
          ? repPoll(whisperPredId, (st, el) => {
              if (!cancelRef.current.aborted)
                setWhisperState({ status: st === 'succeeded' ? 'done' : st === 'failed' ? 'error' : 'running', elapsed: el });
            }, cancelRef.current).then(out => {
              stopTick('whisper');
              setWhisperState(p => ({ ...p, status: 'done' }));
              lyrics = whisperToLines(out);
              lyricsType = 'synced';
            }).catch(e => {
              stopTick('whisper');
              whisperErr = e.message;
              setWhisperState(p => ({ ...p, status: 'error' }));
            })
          : Promise.resolve().then(() => {
              lyrics = lrcResult.synced.length > 0
                ? lrcResult.synced
                : lrcResult.plain.split('\n').filter(Boolean).map((t, i) => ({ time: i * 3, text: t }));
              lyricsType = lrcResult.synced.length > 0 ? 'synced' : 'plain';
            }),
      ]);

      if (cancelRef.current.aborted) return;
      setResult({ instrumentalUrl, lyrics, lyricsType, demucsErr, whisperErr, skippedWhisper: skipWhisper });
      setStage('review');
    } catch (e) {
      Object.values(timers.current).forEach(clearInterval);
      setErrorMsg(e.message);
      setStage('error');
    }
  }

  function handleSave() {
    const r = result || {};
    const textLines = lyricsText.trim()
      ? parseLRC(lyricsText).length > 0
        ? parseLRC(lyricsText)
        : lyricsText.split('\n').filter(Boolean).map((t, i) => ({ time: i * 3.5, text: t }))
      : [];
    const finalLyrics = r.lyrics?.length > 0 ? r.lyrics : textLines;
    onSave({
      id: uid(),
      title: title.trim(),
      artist: artist.trim(),
      audioUrl: r.instrumentalUrl || (instrFile ? URL.createObjectURL(instrFile) : null),
      hasAudio: !!(r.instrumentalUrl || instrFile),
      lyrics: finalLyrics,
      lyricsType: r.lyrics?.length > 0 ? r.lyricsType : finalLyrics.length > 0 ? 'plain' : 'none',
      plainLyrics: lyricsText,
    });
  }

  // ── Uploading ──
  if (stage === 'uploading') return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center', padding: '0 32px' }}>
      <i className="ti ti-cloud-upload spin" style={{ fontSize: 40, color: 'var(--muted)' }} aria-hidden="true" />
      <p style={{ fontWeight: 700, fontSize: 16 }}>Uploading "{title}"…</p>
      <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
        Saving to Supabase storage, then sending to Replicate.
      </p>
    </div>
  );

  // ── Processing ──
  if (stage === 'processing') {
    const steps = [
      {
        key: 'demucs', icon: 'ti-scissors',
        label: 'Removing vocals', sub: 'Demucs — creates karaoke track',
        ...demucsState,
      },
      {
        key: 'whisper', icon: 'ti-text-recognition',
        label: whisperState.status === 'skipped_lrc' ? 'Lyrics from LRClib' : 'Transcribing lyrics',
        sub: whisperState.status === 'skipped_lrc' ? 'Synced lyrics found — Whisper skipped ✓' : 'Whisper — with timestamps',
        ...whisperState,
      },
    ];
    return (
      <div className="screen" style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontWeight: 700, fontSize: 17, marginBottom: 2 }}>Processing "{title}"…</p>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.6 }}>
          Running in parallel. Usually 2–5 minutes. Keep this window open.
        </p>
        {steps.map(step => (
          <div key={step.key} className="step-row">
            <i
              className={`ti ${step.icon}${step.status === 'running' ? ' spin' : ''}`}
              style={{
                color: step.status === 'done' || step.status === 'skipped_lrc' ? '#20bf6b'
                  : step.status === 'error' ? 'var(--rose)' : 'var(--muted)'
              }}
              aria-hidden="true"
            />
            <div className="step-info">
              <div className="step-title">{step.label}</div>
              <div className="step-sub">{step.sub}</div>
            </div>
            <div className="step-status" style={{
              color: step.status === 'done' || step.status === 'skipped_lrc' ? '#20bf6b'
                : step.status === 'error' ? 'var(--rose)' : 'var(--muted)'
            }}>
              {step.status === 'done' || step.status === 'skipped_lrc' ? '✓ Done'
                : step.status === 'error' ? 'Failed'
                : step.status === 'running' ? fmt(step.elapsed)
                : '…'}
            </div>
          </div>
        ))}
        <button className="btn btn-secondary" onClick={() => { cancelRef.current.aborted = true; setStage('idle'); }}>
          <i className="ti ti-x" aria-hidden="true" /> Cancel
        </button>
      </div>
    );
  }

  // ── Review ──
  if (stage === 'review' && result) return (
    <div className="screen" style={{ padding: '16px 18px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontWeight: 700, fontSize: 17, margin: '6px 0 0' }}>Review & save</p>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <i className={`ti ${result.instrumentalUrl ? 'ti-check' : 'ti-alert-triangle'}`}
            style={{ fontSize: 20, color: result.instrumentalUrl ? '#20bf6b' : 'var(--amber)', flexShrink: 0 }}
            aria-hidden="true"
          />
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
              {result.instrumentalUrl ? 'Instrumental track ready' : 'Vocal separation failed'}
            </p>
            {result.demucsErr && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 0 0' }}>{result.demucsErr}</p>}
          </div>
        </div>
        <div className="divider" style={{ margin: 0 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <i className={`ti ${result.lyrics.length > 0 ? 'ti-check' : 'ti-alert-triangle'}`}
            style={{ fontSize: 20, color: result.lyrics.length > 0 ? '#20bf6b' : 'var(--amber)', flexShrink: 0 }}
            aria-hidden="true"
          />
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
              {result.lyrics.length > 0
                ? `${result.lyrics.length} lyrics lines${result.skippedWhisper ? ' (LRClib)' : ' (Whisper)'} — synced`
                : 'No lyrics extracted'}
            </p>
            {result.whisperErr && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 0 0' }}>{result.whisperErr}</p>}
          </div>
        </div>
      </div>

      {result.lyrics.length > 0 && (
        <div className="card" style={{ padding: '12px 14px' }}>
          <span className="card-label">Lyrics preview</span>
          <div style={{ maxHeight: 170, overflowY: 'auto' }}>
            {result.lyrics.slice(0, 10).map((l, i) => (
              <div key={i} className="lyric-preview-row">
                <span className="lyric-timestamp">{fmt(l.time)}</span>
                <span>{l.text}</span>
              </div>
            ))}
            {result.lyrics.length > 10 && (
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                …and {result.lyrics.length - 10} more lines
              </p>
            )}
          </div>
        </div>
      )}

      {!result.lyrics.length && (
        <div className="card">
          <span className="card-label">Paste lyrics manually</span>
          <textarea
            value={lyricsText}
            onChange={e => setLyricsText(e.target.value)}
            placeholder={"Paste lyrics here, one line per row…\n\nOr use LRC format for timing:\n[00:12.34]First line\n[00:16.50]Second line"}
            rows={6}
          />
        </div>
      )}

      <p className="pin-note">
        <i className="ti ti-pin" aria-hidden="true" />
        Lyrics editor with manual timing correction — pinned for v1.2
      </p>

      <button className="btn btn-process btn-full" onClick={handleSave}>
        <i className="ti ti-device-floppy" aria-hidden="true" />
        Save "{title}" to library
      </button>
    </div>
  );

  // ── Error ──
  if (stage === 'error') return (
    <div className="screen" style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="warn-box">
        <p style={{ fontWeight: 700, marginBottom: 6 }}>
          <i className="ti ti-alert-triangle" aria-hidden="true" />
          Processing failed
        </p>
        <p style={{ margin: 0, wordBreak: 'break-word' }}>{errorMsg}</p>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
          Check: REPLICATE_API_TOKEN is set in Vercel env vars and your account has credits.
        </p>
      </div>
      <button className="btn btn-secondary btn-full" onClick={() => { setStage('idle'); setErrorMsg(''); }}>
        <i className="ti ti-refresh" aria-hidden="true" /> Try again
      </button>
    </div>
  );

  // ── Idle form ──
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
        <div className="field">
          <input placeholder="Song title *" value={title} onChange={e => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <input placeholder="Artist name" value={artist} onChange={e => setArtist(e.target.value)} />
        </div>
      </div>

      {mode === 'auto' && (
        <>
          <div className="card">
            <span className="card-label">Upload original song</span>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
              We'll remove the vocals with Demucs and transcribe the lyrics with Whisper — in parallel. Works in any language.
            </p>
            <label className={`upload-zone${origFile ? ' has-file' : ''}`}>
              <input type="file" accept="audio/*" onChange={e => setOrigFile(e.target.files[0])} />
              <i className={`ti ${origFile ? 'ti-check' : 'ti-file-music'}`} style={{ color: origFile ? '#20bf6b' : 'var(--muted)' }} aria-hidden="true" />
              {origFile
                ? <p className="filename">{origFile.name}</p>
                : <><p style={{ fontWeight: 700, color: 'var(--text)' }}>Drop audio file here</p><p>MP3, WAV, FLAC, M4A</p></>
              }
            </label>
          </div>
          <div className="info-box">
            <i className="ti ti-info-circle" aria-hidden="true" />
            LRClib is checked first (free, instant). If synced lyrics are found, Whisper is skipped to save credits.
          </div>
          <button
            className="btn btn-process btn-full"
            onClick={handleProcess}
            disabled={!origFile || !title.trim()}
          >
            <i className="ti ti-sparkles" aria-hidden="true" />
            Process with Replicate
          </button>
        </>
      )}

      {mode === 'manual' && (
        <>
          <div className="card">
            <span className="card-label">Lyrics</span>
            <button
              className="btn btn-secondary btn-full"
              style={{ marginBottom: 12 }}
              onClick={async () => {
                if (!title.trim()) return;
                const res = await lrcSearch(artist, title);
                if (res?.plain) setLyricsText(res.plain);
                else alert('Not found on LRClib. Paste lyrics manually, or use Auto mode to transcribe from audio.');
              }}
            >
              <i className="ti ti-search" aria-hidden="true" /> Search LRClib
            </button>
            <textarea
              value={lyricsText}
              onChange={e => setLyricsText(e.target.value)}
              placeholder={"Paste lyrics here…\n\nOr use LRC timed format:\n[00:12.34]First line here\n[00:16.50]Second line"}
              rows={7}
            />
          </div>
          <div className="card">
            <span className="card-label">Instrumental track</span>
            <label className={`upload-zone${instrFile ? ' has-file' : ''}`}>
              <input type="file" accept="audio/*" onChange={e => setInstrFile(e.target.files[0])} />
              <i className={`ti ${instrFile ? 'ti-check' : 'ti-music'}`} style={{ color: instrFile ? '#20bf6b' : 'var(--muted)' }} aria-hidden="true" />
              {instrFile
                ? <p className="filename">{instrFile.name}</p>
                : <><p style={{ fontWeight: 700, color: 'var(--text)' }}>Upload karaoke / instrumental</p><p>MP3, WAV, M4A</p></>
              }
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
  const rafRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [activeLine, setActiveLine] = useState(-1);

  const lyrics = song.lyrics || [];

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onMeta = () => setDuration(a.duration);
    const onEnd = () => { setPlaying(false); setActiveLine(-1); };
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnd);
    return () => {
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnd);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.play().catch(() => setPlaying(false));
      const tick = () => {
        const t = a.currentTime;
        setCurrentTime(t);
        if (lyrics.length > 0) {
          let idx = -1;
          for (let i = 0; i < lyrics.length; i++) {
            if (lyrics[i].time <= t) idx = i; else break;
          }
          setActiveLine(idx);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else {
      a.pause();
      cancelAnimationFrame(rafRef.current);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  function seek(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * (duration || 0);
    if (audioRef.current) audioRef.current.currentTime = t;
    setCurrentTime(t);
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const c = songColor(song);

  const offsets = [-2, -1, 0, 1, 2];
  const classMap = { '-2': 'past', '-1': 'past', '0': 'active', '1': 'next1', '2': 'next2' };

  return (
    <div className="player-screen">
      {song.audioUrl && <audio ref={audioRef} src={song.audioUrl} preload="metadata" />}

      <div className="player-header">
        <button className="player-back" onClick={onBack} aria-label="Back">
          <i className="ti ti-arrow-left" aria-hidden="true" />
        </button>
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
          const line = lyrics[activeLine + off];
          return (
            <div key={off} className={`lyric-line ${classMap[String(off)]}`}>
              {line ? line.text : '\u00A0'}
            </div>
          );
        })}
      </div>

      <div className="progress-wrap">
        <div className="progress-track" onClick={seek}>
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="time-row">
          <span>{fmt(currentTime)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>

      <div className="controls">
        <button
          className="ctrl-btn"
          onClick={() => { if (audioRef.current) { audioRef.current.currentTime = 0; setCurrentTime(0); setActiveLine(-1); } }}
          aria-label="Restart"
        >
          <i className="ti ti-player-skip-back" aria-hidden="true" />
        </button>
        <button
          className="play-btn"
          onClick={() => setPlaying(p => !p)}
          disabled={!song.hasAudio}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <i className={`ti ${playing ? 'ti-player-pause' : 'ti-player-play'}`} aria-hidden="true" />
        </button>
        <button
          className="ctrl-btn"
          onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.min(duration, currentTime + 10); }}
          aria-label="Skip 10 seconds"
        >
          <i className="ti ti-player-skip-forward" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}


// ── SETTINGS SCREEN ───────────────────────────────────────────────────────────

function SettingsScreen({ onBack }) {
  const [saved, setSaved] = useState(false);
  // Note: In the deployed app, the API key lives in Vercel env vars, not here.
  // This screen is for Supabase config (coming next).

  return (
    <div className="screen">
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Configure storage & services</div>
        </div>
      </div>

      <div style={{ padding: '0 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="success-box">
          <p style={{ fontWeight: 700, margin: '0 0 4px' }}>
            <i className="ti ti-check" aria-hidden="true" /> Replicate — server-side
          </p>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            Your Replicate API key lives in Vercel environment variables, not in the app.
            It's never sent to the browser. Vocal separation and transcription work via the <code>/api/replicate</code> proxy.
          </p>
        </div>

        <div className="card settings-section">
          <span className="card-label">Supabase — cloud storage</span>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.6 }}>
            Coming in the next step. Once configured, your song library and audio tracks persist across devices and page reloads. Currently songs are session-only.
          </p>
        </div>

        <div className="card settings-section">
          <span className="card-label">Lyrics sources</span>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--text)' }}>LRClib</strong> — checked first, free, has synced lyrics for many tracks.<br />
            <strong style={{ color: 'var(--text)' }}>Whisper</strong> — transcribes from audio when LRClib doesn't have it. Works in any language.<br />
            <strong style={{ color: 'var(--text)' }}>Genius</strong> — coming in v1.4 via Vercel edge function.
          </p>
        </div>

        <div className="card settings-section">
          <span className="card-label">Roadmap</span>
          <p className="pin-note" style={{ marginBottom: 8 }}>
            <i className="ti ti-pin" aria-hidden="true" />
            v1.2 — Supabase cloud storage (persistent library)
          </p>
          <p className="pin-note" style={{ marginBottom: 8 }}>
            <i className="ti ti-pin" aria-hidden="true" />
            v1.3 — Lyrics editor with manual timing correction
          </p>
          <p className="pin-note" style={{ marginBottom: 8 }}>
            <i className="ti ti-pin" aria-hidden="true" />
            v1.4 — Pitch / key shift + mic reverb effects
          </p>
          <p className="pin-note">
            <i className="ti ti-pin" aria-hidden="true" />
            v1.5 — Genius lyrics via Vercel edge function
          </p>
        </div>
      </div>
    </div>
  );
}


// ── ROOT ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState('library');
  const [songs, setSongs] = useState([]);
  const [activeSong, setActiveSong] = useState(null);

  function addSong(song) {
    setSongs(prev => [song, ...prev]);
    setTab('library');
  }

  if (activeSong) {
    return (
      <div className="app-shell">
        <PlayerScreen song={activeSong} onBack={() => setActiveSong(null)} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {tab === 'library' && <LibraryScreen songs={songs} onPlay={setActiveSong} />}
      {tab === 'add' && <AddSongScreen onSave={addSong} onBack={() => setTab('library')} />}
      {tab === 'settings' && <SettingsScreen onBack={() => setTab('library')} />}

      <nav className="bottom-nav">
        <button className={`nav-btn${tab === 'library' ? ' active' : ''}`} onClick={() => setTab('library')}>
          <i className="ti ti-playlist" aria-hidden="true" />
          Library
        </button>
        <button className="fab" onClick={() => setTab('add')} aria-label="Add song">
          <i className="ti ti-plus" aria-hidden="true" />
        </button>
        <button className={`nav-btn${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>
          <i className="ti ti-settings" aria-hidden="true" />
          Settings
        </button>
      </nav>
    </div>
  );
}
