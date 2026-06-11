import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPA_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null;

const LIBRARY_ROOT     = 'library/admin';
const BATCH_KEY        = 'karaklas_bulk_batch_v1';
const DEMUCS_VERSION   = '25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953';
const WHISPERX_VERSION = '5d4424b04099904320e7f7c8343d09788c88f8bf8d0b3ba160dfb97112ebb6ba';

// Average seconds per song for time estimate (conservative)
const AVG_SECONDS_PER_SONG = 5 * 60;

// ── Utilities (copied from App.jsx — no shared import to keep uploader isolated) ─
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid   = () => Math.random().toString(36).slice(2, 9);

function makeSongSlug(title, artist) {
  const clean = str => (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 25);
  const parts = [clean(artist), clean(title)].filter(Boolean);
  return parts.join('_') || 'unknown';
}

async function uploadAudioToSupabase(file, title, artist) {
  if (!supabase) throw new Error('Supabase not configured.');
  const ext  = file.name.split('.').pop() || 'mp3';
  const slug = makeSongSlug(title, artist);
  const path = `originals/${slug}_${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('songs').upload(path, file, { upsert: false });
  if (error) throw new Error(`Audio upload failed: ${error.message}`);
  return supabase.storage.from('songs').getPublicUrl(path).data.publicUrl;
}

async function uploadProcessedToSupabase(replicateUrl, folder, title, artist, fixedSlugId) {
  if (!supabase) throw new Error('Supabase not configured.');
  const resp = await fetch(replicateUrl);
  if (!resp.ok) throw new Error(`Could not download processed audio (${resp.status})`);
  const blob = await resp.blob();
  const path = `${folder}/${fixedSlugId}.mp3`;
  const { error } = await supabase.storage.from('songs').upload(path, blob, { contentType: 'audio/mpeg', upsert: true });
  if (error) throw new Error(`Failed to save to ${folder}: ${error.message}`);
  return supabase.storage.from('songs').getPublicUrl(path).data.publicUrl;
}

async function deleteSupabaseFile(publicUrl) {
  if (!supabase || !publicUrl) return;
  try {
    const match = publicUrl.match(/\/storage\/v1\/object\/public\/songs\/(.+)$/);
    if (match) await supabase.storage.from('songs').remove([decodeURIComponent(match[1])]);
  } catch {}
}

async function saveSongData(song) {
  if (!supabase) return;
  const path  = song._libraryPath;
  const blob  = new Blob([JSON.stringify(song)], { type: 'application/json' });
  const { error } = await supabase.storage.from('songs')
    .upload(path, blob, { upsert: true, contentType: 'application/json' });
  if (error) throw new Error(`Library save failed: ${error.message}`);
  return song;
}

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
    return { synced: hit.syncedLyrics ? parseLRC(hit.syncedLyrics) : [], plain: hit.plainLyrics || '' };
  } catch { return null; }
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
        for (const chunk of splitSegmentWords(words)) {
          lines.push({ id: uid(), time: chunk[0].start, endTime: chunk[chunk.length - 1].end, text: chunk.map(w => w.word).join(' '), color: null, words: chunk });
        }
      } else if (seg.text.trim()) {
        lines.push({ id: uid(), time: seg.start, endTime: seg.end, text: seg.text.trim(), color: null, words: [] });
      }
    }
    return lines;
  }
  const text = out.transcription || out.text || (typeof out === 'string' ? out : '');
  return text.split(/\n+/).filter(Boolean).map((t, i) => ({ id: uid(), time: i * 3, text: t.trim(), color: null, words: [] }));
}

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
    const safeEnd   = lineEnd === Infinity ? Infinity : lineEnd - 0.25;
    const textWords = line.text.split(/\s+/).filter(Boolean);
    const words     = allWords
      .filter(w => w.start >= lineStart - 0.25 && w.start < safeEnd)
      .map((w, j) => ({ word: textWords[j] ?? w.word, start: w.start, end: w.end }));
    return { ...line, words, endTime: words[words.length - 1]?.end ?? line.endTime };
  });
}

function reconstructFromMinimal(minimal, lrcLines) {
  const lrcMap = Object.fromEntries(lrcLines.map(l => [l.id, l]));
  const lines  = minimal.map(item => {
    const lrc = lrcMap[item.id];
    if (!lrc) return null;
    const textWords = lrc.text.split(/\s+/).filter(Boolean);
    const words = (item.w || []).slice(0, textWords.length).map((pair, i) => ({
      word: textWords[i], start: pair[0], end: pair[1],
    }));
    return { ...lrc, time: item.t != null ? item.t : lrc.time, words, endTime: words[words.length - 1]?.end ?? lrc.endTime };
  }).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line      = lines[i];
    const textWords = line.text.split(/\s+/).filter(Boolean);
    const missing   = textWords.length - (line.words?.length || 0);
    if (missing <= 0 || !line.words?.length) continue;
    const lastChip  = line.words[line.words.length - 1];
    const windowEnd = lines[i + 1]?.time ?? (lastChip.end + missing * 1.0);
    const gap       = Math.max(0, windowEnd - lastChip.end);
    const step      = gap > 0 ? Math.min(gap / missing, 1.5) : 0.5;
    for (let j = 0; j < missing; j++) {
      const wordStart = lastChip.end + j * step;
      line.words.push({ word: textWords[line.words.length], start: wordStart, end: wordStart + step });
    }
    line.endTime = line.words[line.words.length - 1].end;
  }
  return lines;
}

async function callClaudeCorrection(whisperOut, lrcLines) {
  if (!whisperOut?.segments || !lrcLines?.length) return null;
  const whisperWords = whisperOut.segments.flatMap(s =>
    (s.words || []).map(w => ({ word: w.word.replace(/^\s+/, ''), start: w.start, end: w.end }))
  );
  if (!whisperWords.length) return null;
  try {
    const r = await fetch('/api/claude', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ whisperWords, lrcLines }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const text  = data.content?.[0]?.text;
    if (!text) throw new Error('No content');
    const clean   = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const minimal = JSON.parse(clean);
    if (!Array.isArray(minimal)) throw new Error('Not an array');
    return reconstructFromMinimal(minimal, lrcLines);
  } catch { return null; }
}

// ── ID3v2 tag reader (no dependencies — hand-rolled binary parser) ────────────
// Reads TIT2 (title) and TPE1 (artist) from the first ~64 KB of the MP3 file.
// Handles ID3v2.3 and v2.4 (the two versions Sidify writes). Falls back to
// filename if the header is absent or the tags are missing.
async function readID3Tags(file) {
  const fallback = () => ({ title: file.name.replace(/\.[^.]+$/, ''), artist: '' });
  try {
    // Read only the first 64 KB — enough for all practical ID3 headers
    const buf  = await file.slice(0, 65536).arrayBuffer();
    const view = new DataView(buf);
    const u8   = new Uint8Array(buf);

    // ID3v2 header: "ID3" magic + version byte (3 or 4) + flags + 4-byte syncsafe size
    if (u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return fallback();
    const version = u8[3]; // 3 = ID3v2.3, 4 = ID3v2.4

    // Tag header size is always syncsafe regardless of version
    const syncsafe    = (a, b, c, d) => (a << 21) | (b << 14) | (c << 7) | d;
    const tagSize     = syncsafe(u8[6], u8[7], u8[8], u8[9]);
    const end         = Math.min(10 + tagSize, u8.length);

    // Frame sizes: plain 32-bit big-endian in v2.3, syncsafe in v2.4
    const readFrameSize = version >= 4
      ? (a, b, c, d) => syncsafe(a, b, c, d)
      : (a, b, c, d) => (a << 24) | (b << 16) | (c << 8) | d;

    // Decode a text frame: skip encoding byte, decode remaining as UTF-8 or UTF-16
    function readTextFrame(offset, size) {
      if (size < 2) return '';
      const enc  = u8[offset];
      const data = u8.slice(offset + 1, offset + size);
      if (enc === 1 || enc === 2) {
        // UTF-16 with or without BOM
        const hasBom = data[0] === 0xFF && data[1] === 0xFE;
        const little = hasBom ? true : !(data[0] === 0xFE && data[1] === 0xFF);
        const start  = (data[0] === 0xFF || data[0] === 0xFE) ? 2 : 0;
        let str = '';
        for (let i = start; i + 1 < data.length; i += 2) {
          const cp = little ? (data[i] | (data[i + 1] << 8)) : ((data[i] << 8) | data[i + 1]);
          if (cp === 0) break;
          str += String.fromCodePoint(cp);
        }
        return str.trim();
      }
      // enc 0 = Latin-1, enc 3 = UTF-8
      return new TextDecoder(enc === 3 ? 'utf-8' : 'latin1').decode(data).replace(/\0/g, '').trim();
    }

    let title = '', artist = '';
    let pos = 10;

    while (pos + 10 < end && (title === '' || artist === '')) {
      const frameId = String.fromCharCode(u8[pos], u8[pos+1], u8[pos+2], u8[pos+3]);
      const fSize   = readFrameSize(u8[pos+4], u8[pos+5], u8[pos+6], u8[pos+7]);
      if (fSize <= 0 || fSize > end - pos - 10) break;
      if (frameId === 'TIT2') title  = readTextFrame(pos + 10, fSize);
      if (frameId === 'TPE1') artist = readTextFrame(pos + 10, fSize);
      pos += 10 + fSize;
    }

    return { title, artist };
  } catch {
    return fallback();
  }
}

// ── Batch state persistence ───────────────────────────────────────────────────
function loadBatch() {
  try { return JSON.parse(localStorage.getItem(BATCH_KEY) || 'null'); } catch { return null; }
}
function saveBatch(items) {
  try {
    // Persist everything except the File object (not serialisable)
    const toSave = items.map(({ file, ...rest }) => rest);
    localStorage.setItem(BATCH_KEY, JSON.stringify(toSave));
  } catch {}
}
function clearBatch() {
  try { localStorage.removeItem(BATCH_KEY); } catch {}
}

// ── Format helpers ────────────────────────────────────────────────────────────
function fmtDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Status display helpers ────────────────────────────────────────────────────
const STATUS_ICON = {
  pending:    { icon: 'ti-clock-hour3',   color: 'var(--muted)' },
  processing: { icon: 'ti-loader spin',   color: 'var(--amber)' },
  done:       { icon: 'ti-circle-check',  color: '#20bf6b'      },
  failed:     { icon: 'ti-circle-x',      color: 'var(--rose)'  },
  skipped:    { icon: 'ti-minus-vertical',color: 'var(--muted)' },
};

const STAGE_LABELS = {
  upload:  'Uploading…',
  demucs:  'Separating vocals…',
  whisper: 'Transcribing…',
  claude:  'Correcting lyrics…',
  saving:  'Saving to library…',
};

// ── Main Uploader component ───────────────────────────────────────────────────
export default function Uploader() {
  const [items,       setItems]       = useState([]);       // batch items
  const [running,     setRunning]     = useState(false);
  const [paused,      setPaused]      = useState(false);
  const [resumePrompt, setResumePrompt] = useState(false);  // show resume/clear dialog
  const [dragOver,    setDragOver]    = useState(false);
  const [editingId,   setEditingId]   = useState(null);     // item id being edited inline

  const itemsRef    = useRef([]);
  const cancelRef   = useRef({ aborted: false });
  const pauseRef    = useRef(false);
  const runningRef  = useRef(false);
  const keepaliveRef = useRef(null);

  // Sync itemsRef with items state
  useEffect(() => { itemsRef.current = items; }, [items]);

  // On mount: check for saved batch
  useEffect(() => {
    const saved = loadBatch();
    if (saved?.length) {
      // Any item stuck in 'processing' was mid-flight when the tab died — reset to pending
      const restored = saved.map(i =>
        i.status === 'processing' ? { ...i, status: 'pending', stage: null, stageElapsed: 0 } : i
      );
      const hasPending = restored.some(i => i.status === 'pending');
      const hasAny     = restored.length > 0;
      if (hasAny) {
        setItems(restored);
        itemsRef.current = restored;
        if (hasPending) setResumePrompt(true);
      }
    }
  }, []);

  // Persist batch whenever items change
  useEffect(() => {
    if (items.length > 0) saveBatch(items);
  }, [items]);

  // Keepalive: prevent tab sleep during processing
  function startKeepalive() {
    if (keepaliveRef.current) return;
    keepaliveRef.current = setInterval(() => {
      // Silent audio context ping to keep browser active
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.001);
        setTimeout(() => ctx.close(), 500);
      } catch {}
      // Also log so the browser knows this tab is alive
      console.debug('[KaraKlas Uploader] keepalive', new Date().toLocaleTimeString());
    }, 20000);
  }

  function stopKeepalive() {
    if (keepaliveRef.current) { clearInterval(keepaliveRef.current); keepaliveRef.current = null; }
  }

  // ── Item state helpers ──────────────────────────────────────────────────────
  function patchItem(id, patch) {
    itemsRef.current = itemsRef.current.map(i => i.id === id ? { ...i, ...patch } : i);
    setItems([...itemsRef.current]);
  }

  // ── File drop / selection ───────────────────────────────────────────────────
  const handleFiles = useCallback(async (fileList) => {
    const mp3s = Array.from(fileList).filter(f =>
      f.type === 'audio/mpeg' || f.name.toLowerCase().endsWith('.mp3')
    );
    if (!mp3s.length) return;

    const newItems = await Promise.all(mp3s.map(async file => {
      const tags = await readID3Tags(file);
      const id   = uid();
      const slug = makeSongSlug(tags.title || file.name, tags.artist);
      const fixedSlugId = `${slug}_${id}`;
      return {
        id,
        slug,
        fixedSlugId,
        title:    tags.title  || file.name.replace(/\.[^.]+$/, ''),
        artist:   tags.artist || '',
        filename: file.name,
        file,                          // File object — not persisted to localStorage
        status:   'pending',
        stage:    null,
        stageElapsed: 0,
        instrumentalUrl: null,
        vocalsUrl:       null,
        error:    null,
        addedAt:  Date.now(),
        completedAt: null,
      };
    }));

    // Warn about duplicate filenames already in batch
    const existingFilenames = new Set(itemsRef.current.map(i => i.filename));
    const dupes = newItems.filter(i => existingFilenames.has(i.filename));
    if (dupes.length > 0) {
      const names = dupes.map(d => d.filename).join(', ');
      if (!window.confirm(`These files are already in the batch:\n\n${names}\n\nAdd them again?`)) {
        return;
      }
    }

    const merged = [...itemsRef.current, ...newItems];
    itemsRef.current = merged;
    setItems(merged);
  }, []);

  const onDrop = useCallback(e => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const onDragOver = useCallback(e => { e.preventDefault(); setDragOver(true); }, []);
  const onDragLeave = useCallback(() => setDragOver(false), []);

  // ── Processing pipeline for a single item ──────────────────────────────────
  async function processItem(item) {
    const { id, title, artist, fixedSlugId } = item;

    // Item needs a File object — if we're resuming and it was lost (tab restart),
    // the file is missing. Flag it clearly.
    if (!item.file) {
      patchItem(id, { status: 'failed', error: 'File lost — re-add this MP3 to process it.' });
      return;
    }

    patchItem(id, { status: 'processing', stage: 'lrc', stageElapsed: 0, error: null });

    try {
      // Step 1: LRClib lyrics search
      const lrcResult     = await lrcSearch(artist, title);
      const hadLrc        = !!(lrcResult?.synced?.length > 0);
      const whisperPrompt = lrcResult?.plain || null;

      // Step 2: Upload original to Supabase
      patchItem(id, { stage: 'upload' });
      const originalUrl = await uploadAudioToSupabase(item.file, title, artist);
      if (cancelRef.current.aborted) throw new Error('cancelled');

      // Step 3: Demucs vocal separation
      patchItem(id, { stage: 'demucs', stageElapsed: 0 });
      const demucsId = await repCreate(DEMUCS_VERSION, {
        audio: originalUrl, model_name: 'htdemucs', stem: 'vocals', shifts: 1, overlap: 0.25, output_format: 'mp3',
      });
      let instrumentalUrl = null, vocalsUrl = null;
      try {
        const demucsOut = await repPoll(demucsId,
          (st, el) => patchItem(id, { stage: 'demucs', stageElapsed: el }),
          cancelRef.current
        );
        const ir = getInstrumental(demucsOut), vr = getVocals(demucsOut);
        if (ir) instrumentalUrl = await uploadProcessedToSupabase(ir, 'instrumentals', title, artist, `${fixedSlugId}_inst`);
        if (vr) vocalsUrl       = await uploadProcessedToSupabase(vr, 'vocals',        title, artist, `${fixedSlugId}_vox`);
        await deleteSupabaseFile(originalUrl);
        patchItem(id, { instrumentalUrl, vocalsUrl });
      } catch (e) {
        // Demucs failure is non-fatal — continue without audio separation
        patchItem(id, { stage: 'demucs_warn' });
      }
      if (cancelRef.current.aborted) throw new Error('cancelled');

      // Step 4: WhisperX transcription
      patchItem(id, { stage: 'whisper', stageElapsed: 0 });
      let whisperOut = null, lyricsAlt = [];
      try {
        const whisperSrc = vocalsUrl || originalUrl;
        const wpId = await repCreate(WHISPERX_VERSION, {
          audio_file: whisperSrc, align_output: true, temperature: 0,
          ...(whisperPrompt ? { initial_prompt: whisperPrompt } : {}),
        });
        whisperOut = await repPoll(wpId,
          (st, el) => patchItem(id, { stage: 'whisper', stageElapsed: el }),
          cancelRef.current
        );
        lyricsAlt = whisperToLines(whisperOut);
      } catch {}
      if (cancelRef.current.aborted) throw new Error('cancelled');

      // Step 5: Claude lyrics correction
      patchItem(id, { stage: 'claude', stageElapsed: 0 });
      let lyrics = lyricsAlt, lyricsType = lyricsAlt.length > 0 ? 'synced' : 'none';
      if (whisperOut && hadLrc && lrcResult?.synced?.length > 0) {
        const corrected = await callClaudeCorrection(whisperOut, lrcResult.synced);
        if (corrected?.length > 0) { lyrics = corrected; }
        else { lyrics = mergeWordsIntoLines(lrcResult.synced, whisperOut); }
      } else if (!whisperOut && hadLrc) {
        lyrics = lrcResult.synced.length > 0 ? lrcResult.synced : [];
        lyricsType = lrcResult.synced.length > 0 ? 'synced' : 'none';
      }

      // Step 6: Save to library
      patchItem(id, { stage: 'saving' });
      const libraryPath = `${LIBRARY_ROOT}/${fixedSlugId}.json`;
      const song = {
        id:           id,
        title,
        artist,
        addedAt:      Date.now(),
        tags:         [],
        hidden:       false,
        _libraryPath: libraryPath,
        audioUrl:     instrumentalUrl,
        vocalsUrl:    vocalsUrl,
        hasAudio:     !!instrumentalUrl,
        lyrics,
        lyricsAlt,
        lyricsType,
        lyricsSource: 'primary',
        plainLyrics:  '',
        tuned:        false,
      };
      await saveSongData(song);
      patchItem(id, { status: 'done', stage: null, completedAt: Date.now() });

    } catch (e) {
      if (e.message === 'cancelled') {
        patchItem(id, { status: 'pending', stage: null });
      } else if (e.message?.includes('402') || e.message?.includes('payment')) {
        // Replicate quota — pause the whole batch
        patchItem(id, { status: 'pending', stage: null, error: 'Replicate quota exceeded — top up and resume.' });
        throw new Error('QUOTA_EXCEEDED');
      } else {
        patchItem(id, { status: 'failed', stage: null, error: e.message });
      }
    }
  }

  // ── Batch run loop ──────────────────────────────────────────────────────────
  async function runLoop() {
    runningRef.current = true;
    setRunning(true);
    setPaused(false);
    startKeepalive();
    cancelRef.current = { aborted: false };

    try {
      while (true) {
        if (pauseRef.current) break;

        const next = itemsRef.current.find(i => i.status === 'pending');
        if (!next) break;

        try {
          await processItem(next);
        } catch (e) {
          if (e.message === 'QUOTA_EXCEEDED') {
            setPaused(true);
            break;
          }
          // Other errors: already handled inside processItem, continue
        }

        await sleep(400); // brief pause between songs
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      stopKeepalive();
    }
  }

  function handleStart() {
    if (runningRef.current) return;
    pauseRef.current = false;
    runLoop();
  }

  function handlePause() {
    // Signal the loop to stop after current song finishes
    pauseRef.current = true;
    // Don't set running=false here — the loop will do that when the current song completes
    setPaused(true);
  }

  function handleClear() {
    if (running && !paused) {
      if (!window.confirm('A batch is running. Pause it first, then clear.')) return;
      return;
    }
    if (!window.confirm('Clear the entire batch? Songs already saved to the library are not affected.')) return;
    cancelRef.current.aborted = true;
    itemsRef.current = [];
    setItems([]);
    setRunning(false);
    setPaused(false);
    pauseRef.current = false;
    stopKeepalive();
    clearBatch();
  }

  function handleResume() {
    setResumePrompt(false);
    // Don't auto-start — let the user review and hit Start
  }

  function handleClearSaved() {
    if (!window.confirm('Discard the saved batch and start fresh?')) return;
    itemsRef.current = [];
    setItems([]);
    clearBatch();
    setResumePrompt(false);
  }

  function handleRemoveItem(itemId) {
    if (running && itemsRef.current.find(i => i.id === itemId)?.status === 'processing') return;
    itemsRef.current = itemsRef.current.filter(i => i.id !== itemId);
    setItems([...itemsRef.current]);
  }

  function handleRetry(itemId) {
    patchItem(itemId, { status: 'pending', stage: null, error: null });
  }

  // ── Derived stats ───────────────────────────────────────────────────────────
  const total      = items.length;
  const done       = items.filter(i => i.status === 'done').length;
  const failed     = items.filter(i => i.status === 'failed').length;
  const pending    = items.filter(i => i.status === 'pending').length;
  const processing = items.filter(i => i.status === 'processing').length;
  const remaining  = pending + processing;
  const estSeconds = remaining * AVG_SECONDS_PER_SONG;
  const allDone    = total > 0 && remaining === 0 && !running;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      color: 'var(--text)',
      fontFamily: 'var(--font-ui)',
      display: 'flex',
      flexDirection: 'column',
      maxWidth: 720,
      margin: '0 auto',
      padding: '0 0 40px',
    }}>

      {/* ── Header ── */}
      <div style={{
        padding: '40px 24px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 16,
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <a href="/" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>
              ← KaraKlas
            </a>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1 }}>
            Bulk Uploader
          </h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            Drop MP3s, walk away. Songs are processed and saved to your library automatically.
          </p>
        </div>

        {/* Control buttons */}
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'flex-end' }}>
          {!running && !paused && pending > 0 && (
            <button className="btn btn-primary" onClick={handleStart}>
              <i className="ti ti-player-play" /> Start
            </button>
          )}
          {(running && !paused) && (
            <button className="btn btn-secondary" onClick={handlePause}>
              <i className="ti ti-player-pause" /> Pause
            </button>
          )}
          {paused && pending > 0 && (
            <button className="btn btn-primary" onClick={handleStart}>
              <i className="ti ti-player-play" /> Resume
            </button>
          )}
          {total > 0 && (
            <button
              className="btn btn-ghost"
              onClick={handleClear}
              style={{ color: 'var(--muted)', fontSize: 13 }}
              title="Clear batch"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Resume prompt ── */}
      {resumePrompt && (
        <div style={{
          margin: '16px 24px 0',
          padding: '16px',
          background: 'var(--elevated)',
          border: '1px solid var(--amber)',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Saved batch found</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {items.filter(i => i.status === 'pending').length} songs still pending from your last session.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-primary" style={{ padding: '8px 14px', fontSize: 13 }} onClick={handleResume}>
              Review &amp; Resume
            </button>
            <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={handleClearSaved}>
              Start fresh
            </button>
          </div>
        </div>
      )}

      {/* ── Stats bar ── */}
      {total > 0 && (
        <div style={{
          padding: '12px 24px',
          display: 'flex',
          gap: 20,
          fontSize: 13,
          color: 'var(--muted)',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          <span><span style={{ color: '#20bf6b', fontWeight: 700 }}>{done}</span> done</span>
          {failed > 0 && <span><span style={{ color: 'var(--rose)', fontWeight: 700 }}>{failed}</span> failed</span>}
          <span>{pending} pending</span>
          <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
            {remaining > 0
              ? `~${fmtDuration(estSeconds)} remaining`
              : allDone ? '✓ All done' : ''}
          </span>
          {running && !paused && (
            <span style={{ color: 'var(--amber)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
              <i className="ti ti-loader spin" style={{ fontSize: 14 }} /> Running
            </span>
          )}
          {paused && pending > 0 && (
            <span style={{ color: 'var(--amber)' }}>Paused</span>
          )}
        </div>
      )}

      {/* ── Drop zone ── */}
      <div style={{ padding: '16px 24px 0' }}>
        <div
          className={`upload-zone${dragOver ? ' has-file' : ''}`}
          style={{ marginBottom: 0 }}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => document.getElementById('bulk-file-input').click()}
        >
          <input
            id="bulk-file-input"
            type="file"
            accept=".mp3,audio/mpeg"
            multiple
            style={{ display: 'none' }}
            onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
          />
          <i className="ti ti-music-plus" style={{ fontSize: 28, display: 'block', marginBottom: 8, color: dragOver ? 'var(--amber)' : 'var(--muted)' }} />
          <p style={{ color: dragOver ? 'var(--amber)' : 'var(--muted)', fontWeight: dragOver ? 700 : 400 }}>
            {dragOver ? 'Drop to add' : 'Drop MP3 files here, or click to browse'}
          </p>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Artist and title are read from ID3 tags automatically
          </p>
        </div>
      </div>

      {/* ── Song list ── */}
      {items.length > 0 && (
        <div style={{ padding: '12px 24px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map(item => (
            <SongRow
              key={item.id}
              item={item}
              editing={editingId === item.id}
              onEdit={() => setEditingId(item.id)}
              onEditDone={(title, artist) => {
                patchItem(item.id, { title, artist });
                setEditingId(null);
              }}
              onEditCancel={() => setEditingId(null)}
              onRemove={() => handleRemoveItem(item.id)}
              onRetry={() => handleRetry(item.id)}
              running={running}
            />
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {items.length === 0 && !resumePrompt && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          color: 'var(--muted)',
          opacity: 0.4,
          padding: '60px 24px',
        }}>
          <i className="ti ti-music-off" style={{ fontSize: 56 }} />
          <p style={{ fontSize: 15, fontWeight: 600 }}>No songs yet</p>
          <p style={{ fontSize: 12 }}>Drop some MP3s above to get started</p>
        </div>
      )}
    </div>
  );
}

// ── Song row component ────────────────────────────────────────────────────────
function SongRow({ item, editing, onEdit, onEditDone, onEditCancel, onRemove, onRetry, running }) {
  const [editTitle,  setEditTitle]  = useState(item.title);
  const [editArtist, setEditArtist] = useState(item.artist);

  // Reset edit fields if item changes from outside
  useEffect(() => {
    setEditTitle(item.title);
    setEditArtist(item.artist);
  }, [item.title, item.artist]);

  const { icon, color } = STATUS_ICON[item.status] || STATUS_ICON.pending;
  const isProcessing    = item.status === 'processing';
  const isDone          = item.status === 'done';
  const isFailed        = item.status === 'failed';
  const canEdit         = item.status === 'pending' && !running;
  const canRemove       = item.status !== 'processing';
  const canRetry        = isFailed;

  function stageLabel() {
    if (!item.stage) return null;
    const base = STAGE_LABELS[item.stage] || item.stage;
    if (item.stageElapsed > 0) return `${base} ${item.stageElapsed}s`;
    return base;
  }

  if (editing) {
    return (
      <div style={{
        background: 'var(--elevated)',
        border: '1px solid var(--amber)',
        borderRadius: 12,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            placeholder="Title"
            style={{ flex: 2 }}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') onEditDone(editTitle, editArtist); if (e.key === 'Escape') onEditCancel(); }}
          />
          <input
            value={editArtist}
            onChange={e => setEditArtist(e.target.value)}
            placeholder="Artist"
            style={{ flex: 1 }}
            onKeyDown={e => { if (e.key === 'Enter') onEditDone(editTitle, editArtist); if (e.key === 'Escape') onEditCancel(); }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={onEditCancel}>Cancel</button>
          <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 14px' }} onClick={() => onEditDone(editTitle, editArtist)}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 14px',
      background: 'var(--surface)',
      border: `1px solid ${isProcessing ? 'rgba(244,168,39,0.3)' : 'var(--border)'}`,
      borderRadius: 12,
      opacity: isDone ? 0.65 : 1,
      transition: 'border-color 0.2s',
    }}>
      {/* Status icon */}
      <i className={`ti ${icon}`} style={{ fontSize: 18, color, flexShrink: 0 }} />

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14,
          fontWeight: 700,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: isProcessing ? 'var(--amber)' : isDone ? 'var(--muted)' : 'var(--text)',
        }}>
          {item.title || '—'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>
          {item.artist || <span style={{ opacity: 0.5 }}>No artist</span>}
          {item.artist && ' · '}
          <span style={{ opacity: 0.6 }}>{item.filename}</span>
        </div>
        {isProcessing && item.stage && (
          <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 2 }}>
            {stageLabel()}
          </div>
        )}
        {isFailed && item.error && (
          <div style={{ fontSize: 11, color: 'var(--rose)', marginTop: 2 }}>{item.error}</div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {canEdit && (
          <button
            onClick={onEdit}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4 }}
            title="Edit title / artist"
          >
            <i className="ti ti-pencil" style={{ fontSize: 15 }} />
          </button>
        )}
        {canRetry && (
          <button
            onClick={onRetry}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--amber)', padding: 4 }}
            title="Retry"
          >
            <i className="ti ti-refresh" style={{ fontSize: 15 }} />
          </button>
        )}
        {canRemove && (
          <button
            onClick={onRemove}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4 }}
            title="Remove from batch"
          >
            <i className="ti ti-x" style={{ fontSize: 15 }} />
          </button>
        )}
      </div>
    </div>
  );
}
