import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

// ── AudioContext precision clock (module-level singleton) ─────────────────────
// Used for lyric timing only — never for audio routing.
// AudioContext.currentTime is driven by the audio hardware and immune to VBR drift.
let _audioClock = null;
function getAudioClock() {
  if (!_audioClock) {
    try { _audioClock = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (_audioClock.state === 'suspended') _audioClock.resume().catch(() => {});
  return _audioClock;
}

// Inject buffering bar animation once when the module loads
if (typeof document !== 'undefined' && !document.querySelector('#kk-buffering-style')) {
  const s = document.createElement('style');
  s.id = 'kk-buffering-style';
  s.textContent = '@keyframes kk-sweep{0%{left:-45%;width:45%}60%{left:60%;width:45%}100%{left:110%;width:45%}}';
  document.head.appendChild(s);
}

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPA_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null;

// Produces a readable, URL-safe slug from title + artist for file naming.
// Strips accents, replaces non-alphanumeric with hyphens, truncates to 25 chars each.
function makeSongSlug(title, artist) {
  const clean = str => (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 25);
  const parts = [clean(artist), clean(title)].filter(Boolean);
  return parts.join('_') || 'unknown';
}

async function uploadAudioToSupabase(file, title, artist) {
  if (!supabase) throw new Error('Supabase not configured.');
  const ext = file.name.split('.').pop() || 'mp3';
  const slug = makeSongSlug(title, artist);
  const path = `originals/${slug}_${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('songs').upload(path, file, { upsert: false });
  if (error) throw new Error(`Audio upload failed: ${error.message}`);
  return supabase.storage.from('songs').getPublicUrl(path).data.publicUrl;
}

async function uploadProcessedToSupabase(replicateUrl, folder, title, artist) {
  if (!supabase) throw new Error('Supabase not configured.');
  const resp = await fetch(replicateUrl);
  if (!resp.ok) throw new Error(`Could not download processed audio (${resp.status})`);
  const blob = await resp.blob();
  const slug = makeSongSlug(title, artist);
  const uid7 = Math.random().toString(36).slice(2, 9);
  const path = `${folder}/${slug}_${uid7}.mp3`;
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

// ── Library namespace ─────────────────────────────────────────────────────────
// All admin-owned songs live under library/admin/.
// Future user uploads will go to library/users/<userId>/.
const LIBRARY_ROOT = 'library/admin';

async function saveSongData(song) {
  if (!supabase) return;
  const slug = makeSongSlug(song.title, song.artist);
  const path = song._libraryPath || `${LIBRARY_ROOT}/${slug}_${song.id}.json`;
  const stored = { ...song, _libraryPath: path };
  const blob = new Blob([JSON.stringify(stored)], { type: 'application/json' });
  const { error } = await supabase.storage.from('songs')
    .upload(path, blob, { upsert: true, contentType: 'application/json' });
  if (error) console.warn('Cloud save failed:', error.message);
  return stored;
}

async function archiveDeletedSong(song) {
  if (!supabase) return;
  const libraryPath = song._libraryPath || `${LIBRARY_ROOT}/${song.id}.json`;
  const slug = makeSongSlug(song.title, song.artist);
  const deletedPath = `deleted/${slug}_${song.id}.json`;
  try {
    const { data } = await supabase.storage.from('songs').download(libraryPath);
    if (data) {
      const current = JSON.parse(await data.text());
      const archived = new Blob([JSON.stringify({ ...current, _deleted: true, _deletedAt: Date.now(), _deletedPath: deletedPath })], { type: 'application/json' });
      await supabase.storage.from('songs').upload(deletedPath, archived, { upsert: true, contentType: 'application/json' });
    }
  } catch (e) { console.warn('Could not archive:', e.message); }
  await supabase.storage.from('songs').remove([libraryPath]);
}

// Lists archived (deleted) songs from Supabase deleted/ folder.
async function loadDeletedSongs() {
  if (!supabase) return [];
  try {
    const { data: files } = await supabase.storage.from('songs').list('deleted');
    if (!files?.length) return [];
    const songs = await Promise.all(
      files.filter(f => f.name.endsWith('.json')).map(async f => {
        const { data } = await supabase.storage.from('songs').download(`deleted/${f.name}`);
        if (!data) return null;
        try { return JSON.parse(await data.text()); } catch { return null; }
      })
    );
    return songs.filter(Boolean).sort((a, b) => (b._deletedAt || 0) - (a._deletedAt || 0));
  } catch { return []; }
}

// Permanently removes audio files for all archived songs, then deletes the archive entries.
async function purgeDeletedSongs() {
  if (!supabase) return 0;
  const deleted = await loadDeletedSongs();
  if (!deleted.length) return 0;
  const toRemove = [];
  for (const song of deleted) {
    const audioPath = song.audioUrl?.match(/\/storage\/v1\/object\/public\/songs\/(.+)$/)?.[1];
    const vocalsPath = song.vocalsUrl?.match(/\/storage\/v1\/object\/public\/songs\/(.+)$/)?.[1];
    if (audioPath) toRemove.push(decodeURIComponent(audioPath));
    if (vocalsPath) toRemove.push(decodeURIComponent(vocalsPath));
    const archivePath = song._deletedPath || `deleted/${song.id}.json`;
    toRemove.push(archivePath);
  }
  if (toRemove.length) await supabase.storage.from('songs').remove(toRemove);
  return deleted.length;
}

async function loadLibrary() {
  if (!supabase) return [];
  try {
    // Read from library/admin (current) and legacy library/ root (pre-migration).
    // Once migration is complete the legacy folder will be empty, so this is safe to keep.
    const [adminFiles, legacyFiles] = await Promise.all([
      supabase.storage.from('songs').list(LIBRARY_ROOT),
      supabase.storage.from('songs').list('library'),
    ]);
    const adminNames  = new Set((adminFiles.data || []).map(f => f.name));
    const allFiles = [
      ...(adminFiles.data || []).filter(f => f.name.endsWith('.json')).map(f => ({ name: f.name, prefix: LIBRARY_ROOT })),
      // Only include legacy root files that haven't already been migrated (not in admin)
      ...(legacyFiles.data || []).filter(f => f.name.endsWith('.json') && !adminNames.has(f.name)).map(f => ({ name: f.name, prefix: 'library' })),
    ];
    if (!allFiles.length) return [];
    const songs = await Promise.all(
      allFiles.map(async ({ name, prefix }) => {
        const { data } = await supabase.storage.from('songs').download(`${prefix}/${name}`);
        if (!data) return null;
        try { return JSON.parse(await data.text()); } catch { return null; }
      })
    );
    return songs.filter(Boolean).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  } catch { return []; }
}

// Restores selected archived songs back to the library.
// Cleans deletion flags, re-uploads JSON to library path, removes archive entry.
async function restoreDeletedSongs(songs) {
  if (!supabase || !songs.length) return [];
  const restored = [];
  for (const song of songs) {
    const archivePath = song._deletedPath || `deleted/${song.id}.json`;
    const slug = makeSongSlug(song.title, song.artist);
    const libraryPath = song._libraryPath || `${LIBRARY_ROOT}/${slug}_${song.id}.json`;
    try {
      const { _deleted, _deletedAt, _deletedPath, ...clean } = song;
      const restoredSong = { ...clean, _libraryPath: libraryPath };
      const blob = new Blob([JSON.stringify(restoredSong)], { type: 'application/json' });
      await supabase.storage.from('songs').upload(libraryPath, blob, { upsert: true, contentType: 'application/json' });
      await supabase.storage.from('songs').remove([archivePath]);
      restored.push(restoredSong);
    } catch (e) { console.warn('Could not restore:', song.title, e.message); }
  }
  return restored;
}

// Cross-references library song URLs against actual storage files.
// Returns files in instrumentals/ and vocals/ not referenced by any active library song.
async function findOrphanedFiles() {
  if (!supabase) return [];
  try {
    // Build set of all paths currently used by library songs
    const libSongs = await loadLibrary();
    const referenced = new Set();
    for (const song of libSongs) {
      const extractPath = url => url?.match(/\/storage\/v1\/object\/public\/songs\/(.+)$/)?.[1];
      const ap = extractPath(song.audioUrl);  const vp = extractPath(song.vocalsUrl);
      if (ap) referenced.add(decodeURIComponent(ap));
      if (vp) referenced.add(decodeURIComponent(vp));
    }
    // List all files in instrumentals/ and vocals/, flag any not in the referenced set
    const orphaned = [];
    for (const folder of ['instrumentals', 'vocals']) {
      const { data: files } = await supabase.storage.from('songs').list(folder, { limit: 1000 });
      for (const file of (files || [])) {
        const path = `${folder}/${file.name}`;
        if (!referenced.has(path)) orphaned.push({ path, name: file.name, folder, size: file.metadata?.size });
      }
    }
    return orphaned;
  } catch (e) { console.warn('findOrphanedFiles:', e.message); return []; }
}

// Migrates all song JSON files from the legacy flat library/ folder to library/admin/.
// Each file is re-uploaded with an updated _libraryPath, then the old file is removed.
// Returns { migrated, skipped, failed } counts.
// Safe to run multiple times — files already in library/admin/ are skipped.
async function migrateLibraryToAdmin(onProgress) {
  if (!supabase) return { migrated: 0, skipped: 0, failed: 0 };
  const { data: files, error } = await supabase.storage.from('songs').list('library');
  if (error) throw new Error(`Could not list library/: ${error.message}`);

  // Only flat JSON files — ignore the admin/ subfolder entry itself
  const legacyFiles = (files || []).filter(f => f.name.endsWith('.json'));
  if (!legacyFiles.length) return { migrated: 0, skipped: 0, failed: 0 };

  let migrated = 0, skipped = 0, failed = 0;

  for (const file of legacyFiles) {
    const oldPath = `library/${file.name}`;
    try {
      const { data } = await supabase.storage.from('songs').download(oldPath);
      if (!data) { failed++; continue; }
      const song = JSON.parse(await data.text());

      // Derive new path — reuse the same filename under library/admin/
      const newPath = `${LIBRARY_ROOT}/${file.name}`;
      const updatedSong = { ...song, _libraryPath: newPath };

      // Upload to new location
      const blob = new Blob([JSON.stringify(updatedSong)], { type: 'application/json' });
      const { error: uploadErr } = await supabase.storage.from('songs')
        .upload(newPath, blob, { upsert: true, contentType: 'application/json' });
      if (uploadErr) { failed++; continue; }

      // Remove from old location
      await supabase.storage.from('songs').remove([oldPath]);
      migrated++;
      onProgress?.({ migrated, skipped, failed, total: legacyFiles.length, current: song.title });
    } catch (e) {
      console.warn('Migration failed for', file.name, e.message);
      failed++;
    }
  }
  return { migrated, skipped, failed };
}

const MIGRATION_KEY = 'karaklas_migration_v1_done';
// Waiting/processing items are never persisted (they'd be stale on reload).
const QUEUE_KEY = 'karaklas_queue_v1';
function loadPersistedQueue() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return saved.filter(i => (i.status === 'done' || i.status === 'failed') && (i.completedAt || 0) > cutoff);
  } catch { return []; }
}
function persistQueue(queue) {
  try {
    const toSave = queue.filter(i => (i.status === 'done' || i.status === 'failed') && i.completedAt);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(toSave));
  } catch {}
}

// ── Performance Queue persistence ────────────────────────────────────────────
const PERF_QUEUE_KEY = 'karaklas_perf_queue_v1';
function loadPerfQueue()  { try { return JSON.parse(localStorage.getItem(PERF_QUEUE_KEY) || '[]'); } catch { return []; } }
function savePerfQueue(q) { try { localStorage.setItem(PERF_QUEUE_KEY, JSON.stringify(q)); } catch {} }

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

  // First pass: positional 1-to-1 mapping of timestamp pairs to text words
  const lines = minimal.map(item => {
    const lrc = lrcMap[item.id];
    if (!lrc) return null;
    const textWords = lrc.text.split(/\s+/).filter(Boolean);
    const words = (item.w || []).slice(0, textWords.length).map((pair, i) => ({
      word: textWords[i], start: pair[0], end: pair[1],
    }));
    return { ...lrc, time: item.t != null ? item.t : lrc.time, words, endTime: words[words.length - 1]?.end ?? lrc.endTime };
  }).filter(Boolean);

  // Second pass: interpolate timestamps for missing tail words.
  // WhisperX sometimes misses the last 1-2 words of a line (soft/trailing vocals).
  // Without this, those words vanish during the wash display and are absent from the editor.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const textWords = line.text.split(/\s+/).filter(Boolean);
    const missing = textWords.length - (line.words?.length || 0);
    if (missing <= 0 || !line.words?.length) continue;

    const lastChip  = line.words[line.words.length - 1];
    // Spread missing words across the gap to the next line (or 1s per word if no next line)
    const windowEnd = lines[i + 1]?.time ?? (lastChip.end + missing * 1.0);
    const gap       = Math.max(0, windowEnd - lastChip.end);
    const step      = gap > 0 ? Math.min(gap / missing, 1.5) : 0.5; // cap at 1.5s per word

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

// ── Core song processing pipeline ────────────────────────────────────────────
// Used by both immediate processing (AddSongScreen) and the batch queue (App root).
// onStage(step, status, elapsed) is called with progress updates.
// cancelRef.aborted = true stops polling mid-flight.
async function processSong({ file, title, artist }, onStage, cancelRef = { aborted: false }) {
  const lrcResult = title.trim() ? await lrcSearch(artist, title) : null;
  const hadLrc = !!(lrcResult?.synced?.length > 0);
  const whisperPrompt = lrcResult?.plain || null;

  onStage('upload', 'running', 0);
  const originalUrl = await uploadAudioToSupabase(file, title, artist);
  if (cancelRef.aborted) return null;

  // Demucs
  onStage('demucs', 'running', 0);
  const demucsId = await repCreate(DEMUCS_VERSION, {
    audio: originalUrl, model_name: 'htdemucs', stem: 'vocals', shifts: 1, overlap: 0.25, output_format: 'mp3',
  });
  let instrumentalUrl = null, vocalsUrl = null;
  let demucsErr = null;
  try {
    const demucsOut = await repPoll(demucsId, (st, el) => { if (!cancelRef.aborted) onStage('demucs', st, el); }, cancelRef);
    onStage('demucs', 'done', 0);
    const ir = getInstrumental(demucsOut), vr = getVocals(demucsOut);
    if (ir) instrumentalUrl = await uploadProcessedToSupabase(ir, 'instrumentals', title, artist);
    if (vr) vocalsUrl       = await uploadProcessedToSupabase(vr, 'vocals', title, artist);
    if (originalUrl) await deleteSupabaseFile(originalUrl);
  } catch (e) { demucsErr = e.message; onStage('demucs', 'error', 0); }

  if (cancelRef.aborted) return null;

  // WhisperX on vocal stem
  const whisperSrc = vocalsUrl || originalUrl;
  onStage('whisper', 'running', 0);
  let whisperOut = null, whisperErr = null, lyricsAlt = [];
  try {
    const wpId = await repCreate(WHISPERX_VERSION, {
      audio_file: whisperSrc, align_output: true, temperature: 0,
      ...(whisperPrompt ? { initial_prompt: whisperPrompt } : {}),
    });
    whisperOut = await repPoll(wpId, (st, el) => { if (!cancelRef.aborted) onStage('whisper', st, el); }, cancelRef);
    onStage('whisper', 'done', 0);
    lyricsAlt = whisperToLines(whisperOut);
  } catch (e) { whisperErr = e.message; onStage('whisper', 'error', 0); }

  if (cancelRef.aborted) return null;

  // Claude correction
  let lyrics = lyricsAlt, lyricsType = lyricsAlt.length > 0 ? 'synced' : 'none', claudeApplied = false;
  if (whisperOut && hadLrc && lrcResult?.synced?.length > 0) {
    onStage('claude', 'running', 0);
    const corrected = await callClaudeCorrection(whisperOut, lrcResult.synced);
    if (corrected?.length > 0) { lyrics = corrected; claudeApplied = true; }
    else { lyrics = mergeWordsIntoLines(lrcResult.synced, whisperOut); }
    onStage('claude', claudeApplied ? 'done' : 'error', 0);
  } else if (!whisperOut && hadLrc) {
    lyrics = lrcResult.synced.length > 0 ? lrcResult.synced : [];
    lyricsType = lrcResult.synced.length > 0 ? 'synced' : 'none';
    onStage('claude', 'skipped', 0);
  } else {
    onStage('claude', 'skipped', 0);
  }

  return { instrumentalUrl, vocalsUrl, lyrics, lyricsAlt, lyricsType, claudeApplied, hadLrc, demucsErr, whisperErr };
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
          lines.push({ id: uid(), time: chunk[0].start, endTime: chunk[chunk.length - 1].end, text: chunk.map(w => w.word).join(' '), color: null, words: chunk });
        }
      } else if (seg.text.trim()) {
        // No word-level data — keep as single line, can't split without timing
        lines.push({ id: uid(), time: seg.start, endTime: seg.end, text: seg.text.trim(), color: null, words: [] });
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
    // Shrink the upper bound by 0.25s so boundary words don't bleed into
    // both the current line and the next (the 0.25s tolerance on the next
    // line's lower bound would otherwise claim the same word twice).
    const safeEnd   = lineEnd === Infinity ? Infinity : lineEnd - 0.25;
    // Use LRClib text (proper case) for word labels rather than the raw
    // WhisperX transcript (which is all lowercase). Positional mapping —
    // falls back to WhisperX word if LRClib has fewer words at this index.
    const textWords = line.text.split(/\s+/).filter(Boolean);
    const words     = allWords
      .filter(w => w.start >= lineStart - 0.25 && w.start < safeEnd)
      .map((w, j) => ({ word: textWords[j] ?? w.word, start: w.start, end: w.end }));
    return { ...line, words, endTime: words[words.length - 1]?.end ?? line.endTime };
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
// Word-level time utilities: format as m:ss.d (one decimal)
const fmtWordTime = s => { if (s == null || isNaN(s)) return ''; const m = Math.floor(s / 60); const sec = (s % 60).toFixed(1).padStart(4, '0'); return `${m}:${sec}`; };
const parseWordTime = str => { if (!str) return 0; const p = String(str).trim().split(':'); return p.length === 2 ? parseFloat(p[0]) * 60 + parseFloat(p[1]) : parseFloat(str) || 0; };
const uid = () => Math.random().toString(36).slice(2, 9);

const AVATAR_COLORS = [{ bg: '#1a2a4a', fg: '#45aaf2' }, { bg: '#1a3a2a', fg: '#20bf6b' }, { bg: '#3a1a2a', fg: '#e8607a' }, { bg: '#3a2a0a', fg: '#f4a827' }];
const songColor = s => AVATAR_COLORS[(s.title.charCodeAt(0) || 0) % AVATAR_COLORS.length];

const EDITOR_COLORS = [
  { hex: '#F4A827', name: 'Amber' }, { hex: '#E8607A', name: 'Rose' }, { hex: '#45AAF2', name: 'Sky' }, { hex: '#20BF6B', name: 'Green' },
  { hex: '#A55EEA', name: 'Purple' }, { hex: '#8D93A1', name: 'Grey' }, { hex: '#FC5C65', name: 'Coral' }, { hex: '#A3CB38', name: 'Lime' },
  { hex: '#2BCBBA', name: 'Teal' }, { hex: '#F7B731', name: 'Gold' },
];


// ── LIBRARY SCREEN ────────────────────────────────────────────────────────────
function LibraryScreen({ songs, onAddToQueueFront, onAddToQueueEnd, onEdit, onStartRandom, onToggleFavourite, showHidden }) {
  const [q, setQ]             = useState('');
  const [sortBy, setSortBy]   = useState('date');    // 'date' | 'song' | 'artist'
  const [sortDir, setSortDir] = useState('asc');     // 'asc' | 'desc' — only used for 'song' and 'artist'
  const [favOnly, setFavOnly] = useState(false);
  const [editMode, setEditMode] = useState(false);

  // Clicking a sort key: if already active, flip direction; otherwise activate it (asc)
  function handleSort(key) {
    if (key === 'date') { setSortBy('date'); return; }
    if (sortBy === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
  }

  const SORTS = [
    { key: 'date',   label: 'Date added' },
    { key: 'song',   label: 'Song' },
    { key: 'artist', label: 'Artist' },
  ];

  const visible = songs
    .filter(s => {
      const matchQ   = s.title.toLowerCase().includes(q.toLowerCase()) || (s.artist || '').toLowerCase().includes(q.toLowerCase());
      const matchFav = !favOnly || (s.tags || []).includes('favourite');
      const matchHidden = showHidden || !s.hidden;
      return matchQ && matchFav && matchHidden;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'song')   cmp = a.title.localeCompare(b.title);
      if (sortBy === 'artist') cmp = (a.artist || '').localeCompare(b.artist || '');
      if (sortBy === 'date')   return (b.addedAt || 0) - (a.addedAt || 0); // newest first, no flip
      return sortDir === 'asc' ? cmp : -cmp;
    });

  return (
    <div className="screen">
      <div className="page-header"><div><img src="/KaraKlasLogo.png" alt="KaraKlas" style={{ width: '100%', height: 'auto', display: 'block', marginBottom: 2, maxWidth: 312 }} /><div className="page-sub" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: 6 }}>Library · {songs.length} song{songs.length !== 1 ? 's' : ''}</div></div></div>

      {/* Search + shuffle + edit mode toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 18px 10px' }}>
        <div className="search-wrap" style={{ flex: 1, margin: 0, padding: 0 }}>
          <i className="ti ti-search search-icon" aria-hidden="true" />
          <input placeholder="Search songs…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <button className="shuffle-btn" onClick={onStartRandom} disabled={songs.filter(s => s.hasAudio || s.audioUrl).length < 2} aria-label="Shuffle play" title="Shuffle — play random songs">
          <i className="ti ti-arrows-shuffle" aria-hidden="true" />
        </button>
        <button
          className="shuffle-btn"
          onClick={() => setEditMode(v => !v)}
          aria-label={editMode ? 'Exit edit mode' : 'Edit songs'}
          title={editMode ? 'Exit edit mode' : 'Edit songs'}
          style={{ color: editMode ? 'var(--amber)' : undefined }}
        >
          <i className="ti ti-pencil" aria-hidden="true" />
        </button>
      </div>

      {/* Star filter + sort pills */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 18px 12px', overflowX: 'auto' }}>
        {/* Star filter pill */}
        <button
          onClick={() => setFavOnly(v => !v)}
          title={favOnly ? 'Show all songs' : 'Show favourites only'}
          aria-label={favOnly ? 'Show all songs' : 'Show favourites only'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '4px 9px', borderRadius: 20, cursor: 'pointer', flexShrink: 0,
            fontSize: 13, transition: 'background 0.15s, color 0.15s',
            background: favOnly ? 'rgba(244,168,39,0.18)' : 'var(--surface)',
            border: favOnly ? '1px solid rgba(244,168,39,0.45)' : '1px solid var(--border)',
            color: favOnly ? 'var(--amber)' : 'var(--muted)',
          }}
        >
          <i className={`ti ${favOnly ? 'ti-star-filled' : 'ti-star'}`} aria-hidden="true" />
        </button>

        {/* Divider */}
        <div style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0 }} />

        {/* Sort pills */}
        {SORTS.map(s => {
          const active = sortBy === s.key;
          const showDir = active && s.key !== 'date';
          return (
            <button
              key={s.key}
              onClick={() => handleSort(s.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '4px 10px', borderRadius: 20, cursor: 'pointer', flexShrink: 0,
                fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-ui)',
                transition: 'background 0.15s, color 0.15s',
                background: active ? 'var(--elevated)' : 'transparent',
                border: active ? '1px solid var(--border)' : '1px solid transparent',
                color: active ? 'var(--text)' : 'var(--muted)',
              }}
            >
              {s.label}
              {showDir && (
                <i
                  className={`ti ${sortDir === 'asc' ? 'ti-chevron-up' : 'ti-chevron-down'}`}
                  style={{ fontSize: 11 }}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Song list */}
      <div style={{ padding: '0 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {songs.length === 0 && (<div className="empty-state"><i className="ti ti-music" aria-hidden="true" /><h3>Your box is empty</h3><p>Tap the + button below to add your first song.</p></div>)}
        {visible.length === 0 && songs.length > 0 && (
          <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '28px 0' }}>
            {favOnly && !q ? 'No favourites yet — tap ★ on any song.' : `No results for "${q}"`}
          </p>
        )}
        {visible.map(song => {
          const activeLyrics = (song.lyricsSource === 'alt' && song.lyricsAlt?.length > 0) ? song.lyricsAlt : song.lyrics;
          const hasWords  = activeLyrics?.some(l => l.words?.length > 0);
          const noAudio   = !song.hasAudio && !song.audioUrl;
          const isFav     = (song.tags || []).includes('favourite');
          const isHidden  = !!song.hidden;
          return (
            <div key={song.id} className="song-card" style={{ gap: 0 }} onClick={() => onAddToQueueFront(song)}>
              <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                <div className="song-title">{song.title}</div>
                <div className="song-artist">{song.artist || 'Unknown artist'}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                {noAudio && <span className="badge badge-amber badge-xs">No audio</span>}
                {isHidden && <span className="badge badge-muted badge-xs" title="Hidden from library"><i className="ti ti-eye-off" style={{ fontSize: 9 }} /></span>}
                {hasWords && <span className="badge badge-teal badge-xs" title="Has word-level timing" style={{ padding: '1px 5px', fontSize: 10 }}>W</span>}
                {song.tuned && <span className="badge badge-purple badge-xs" title="Tuned" style={{ padding: '1px 5px', fontSize: 10 }}>✓</span>}
              </div>
              {/* Favourite star */}
              <button
                onClick={e => { e.stopPropagation(); onToggleFavourite(song); }}
                aria-label={isFav ? 'Remove from favourites' : 'Add to favourites'}
                title={isFav ? 'Remove from favourites' : 'Add to favourites'}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 7, marginLeft: 2, flexShrink: 0, background: 'none',
                  border: 'none', cursor: 'pointer', borderRadius: 8, minHeight: 36,
                  color: isFav ? 'var(--amber)' : 'var(--muted)',
                  transition: 'color 0.15s',
                }}
                onMouseEnter={e => { if (!isFav) e.currentTarget.style.color = 'var(--text)'; }}
                onMouseLeave={e => { if (!isFav) e.currentTarget.style.color = 'var(--muted)'; }}
              >
                <i className={`ti ${isFav ? 'ti-star-filled' : 'ti-star'}`} style={{ fontSize: 17 }} aria-hidden="true" />
              </button>
              {/* Add to queue — primary amber chip */}
              <button
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '5px 9px', marginLeft: 2, flexShrink: 0,
                  background: 'rgba(244,168,39,0.13)',
                  border: '1px solid rgba(244,168,39,0.3)',
                  borderRadius: 8, cursor: 'pointer',
                  color: 'var(--amber)', minHeight: 36,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(244,168,39,0.22)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(244,168,39,0.13)'; }}
                onClick={e => { e.stopPropagation(); onAddToQueueEnd(song); }}
                aria-label="Add to end of queue"
                title="Add to end of queue"
              >
                <i className="ti ti-playlist-add" style={{ fontSize: 21 }} aria-hidden="true" />
              </button>
              {editMode && (
                <button className="btn btn-ghost" style={{ padding: 7 }} onClick={e => { e.stopPropagation(); onEdit(song); }} aria-label="Edit"><i className="ti ti-edit" style={{ fontSize: 17, color: 'var(--muted)' }} aria-hidden="true" /></button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ── EDITOR SCREEN ─────────────────────────────────────────────────────────────
function EditorScreen({ song, onSave, onBack, onDelete }) {
  const hasAlt = (song.lyricsAlt?.length ?? 0) > 0;
  const [editingAlt, setEditingAlt] = useState(false);
  const [localTitle, setLocalTitle]   = useState(song.title  || '');
  const [localArtist, setLocalArtist] = useState(song.artist || '');
  const [lines, setLines]             = useState(() => (song.lyrics || []).map(l => ({ id: uid(), color: null, words: [], ...l })));
  const [activeIdx, setActiveIdx]     = useState(null);
  const [saving, setSaving]           = useState(false);
  const [tuned, setTuned]             = useState(song.tuned ?? false);
  const [isDirty, setIsDirty]         = useState(false);
  const [hidden,  setHidden]          = useState(song.hidden ?? false);
  // Word chip editing
  const [activeChipLine, setActiveChipLine] = useState(null);
  const [activeChipIdx,  setActiveChipIdx]  = useState(null);
  const [draftWord,  setDraftWord]  = useState('');
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd,   setDraftEnd]   = useState('');

  function selectChip(li, wi) {
    const w = lines[li].words[wi];
    setActiveChipLine(li); setActiveChipIdx(wi);
    setDraftWord(w.word); setDraftStart(fmtWordTime(w.start)); setDraftEnd(fmtWordTime(w.end));
  }
  function commitChip(li, wi) {
    if (li === null || wi === null) return;
    setIsDirty(true);
    setLines(prev => prev.map((line, i) => {
      if (i !== li) return line;
      const newWords = line.words.map((w, j) => j !== wi ? w : {
        word: draftWord.trim() || w.word,
        start: parseWordTime(draftStart),
        end:   parseWordTime(draftEnd),
      });
      return { ...line, words: newWords, text: newWords.map(w => w.word).join(' '), time: newWords[0]?.start ?? line.time, endTime: newWords[newWords.length - 1]?.end ?? line.endTime };
    }));
  }
  function addWord(li) {
    // Compute new word from current lines state directly — avoids closure issues
    const line     = lines[li];
    const last     = line.words[line.words.length - 1];
    const s        = last ? last.end + 0.1 : line.time;
    const newWord  = { word: 'word', start: s, end: s + 0.5 };
    const newWords = [...line.words, newWord];
    const newIdx   = newWords.length - 1;
    setIsDirty(true);
    setLines(prev => prev.map((l, i) =>
      i !== li ? l : { ...l, words: newWords, text: newWords.map(w => w.word).join(' '), endTime: newWords[newWords.length - 1]?.end ?? l.endTime }
    ));
    // Set draft state directly from computed values — no state read needed
    setActiveChipLine(li);
    setActiveChipIdx(newIdx);
    setDraftWord(newWord.word);
    setDraftStart(fmtWordTime(newWord.start));
    setDraftEnd(fmtWordTime(newWord.end));
  }
  function deleteWord(li, wi) {
    setIsDirty(true);
    setLines(prev => prev.map((l, i) => {
      if (i !== li) return l;
      const newWords = l.words.filter((_, j) => j !== wi);
      return { ...l, words: newWords, text: newWords.map(w => w.word).join(' '), time: newWords[0]?.start ?? l.time, endTime: newWords[newWords.length - 1]?.end ?? l.endTime };
    }));
    setActiveChipIdx(null);
  }

  function convertToWords(lineIdx) {
    const line = lines[lineIdx];
    if (!line.text.trim()) return;
    const STEP = 0.5;   // 0.4s word + 0.1s gap
    const WORD_DUR = 0.4;
    const wordList = line.text.split(/\s+/).filter(Boolean);
    const newWords = wordList.map((word, i) => ({
      word,
      start: parseFloat((line.time + i * STEP).toFixed(3)),
      end:   parseFloat((line.time + i * STEP + WORD_DUR).toFixed(3)),
    }));
    setIsDirty(true);
    setLines(prev => prev.map((l, i) => i !== lineIdx ? l : {
      ...l, words: newWords, endTime: newWords[newWords.length - 1]?.end,
    }));
    // Pre-select first chip
    setActiveChipLine(lineIdx);
    setActiveChipIdx(0);
    setDraftWord(newWords[0].word);
    setDraftStart(fmtWordTime(newWords[0].start));
    setDraftEnd(fmtWordTime(newWords[0].end));
  }

  function stripWords(lineIdx) {
    // Remove word chips from a line, keeping its text and start timestamp.
    // The line becomes a plain timestamped line again — editable in the normal way.
    if (!window.confirm('Remove word chips from this line? The text and start time will be kept.')) return;
    setIsDirty(true);
    setLines(prev => prev.map((l, i) => i !== lineIdx ? l : {
      ...l, words: [], endTime: l.endTime ?? null,
    }));
    setActiveChipLine(null);
    setActiveChipIdx(null);
  }

  function getSourceLines(useAlt) {
    const src = useAlt ? (song.lyricsAlt || []) : (song.lyrics || []);
    return src.map(l => ({ id: uid(), color: null, words: [], ...l }));
  }
  function handleToggleSource(useAlt) {
    if (useAlt === editingAlt) return;
    if (lines.length > 0 && !window.confirm(`Switch to ${useAlt ? 'WhisperX' : 'AI-corrected'} source? Unsaved changes will be lost.`)) return;
    setEditingAlt(useAlt); setLines(getSourceLines(useAlt)); setActiveIdx(null);
    setActiveChipLine(null); setActiveChipIdx(null);
  }
  function updateLine(idx, field, value) { setIsDirty(true); setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l)); }
  function deleteLine(idx, e) { e?.stopPropagation(); setIsDirty(true); setLines(prev => prev.filter((_, i) => i !== idx)); setActiveIdx(prev => prev === null || prev < idx ? prev : prev === idx ? null : prev - 1); }
  function addLine() { setIsDirty(true); const t = lines[lines.length - 1]?.time || 0; setLines(prev => [...prev, { id: uid(), time: t + 3, text: '', color: null, words: [] }]); setActiveIdx(lines.length); }

  async function handleSave() {
    setSaving(true);
    commitChip(activeChipLine, activeChipIdx);
    const sorted = [...lines].sort((a, b) => a.time - b.time);
    if (editingAlt) {
      await onSave({ ...song, lyricsAlt: sorted, lyricsSource: 'alt', tuned, hidden });
    } else {
      await onSave({ ...song, title: localTitle.trim() || song.title, artist: localArtist.trim(), lyrics: sorted, lyricsType: sorted.length > 0 ? 'synced' : 'none', lyricsSource: 'primary', tuned, hidden });
    }
    setIsDirty(false);
    setSaving(false);
  }

  function handleBack() {
    if (isDirty && !window.confirm('You have unsaved changes. Leave without saving?')) return;
    onBack();
  }

  const sourceLabel = editingAlt ? 'WhisperX (backup)' : 'AI-corrected (primary)';

  return (
    <div className="editor-shell">
      <div className="editor-header">
        <button className="btn btn-ghost" style={{ padding: 8, flexShrink: 0 }} onClick={handleBack}><i className="ti ti-arrow-left" style={{ fontSize: 20 }} aria-hidden="true" /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 16, fontWeight: 800, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{localTitle || 'Edit song'}</p>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>{lines.length} lines · Editing: {sourceLabel}</p>
        </div>
        {/* Tuned checkbox — song-level, near Save */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flexShrink: 0, padding: '0 4px' }}>
          <div style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${tuned ? 'var(--amber)' : 'var(--border)'}`, background: tuned ? 'rgba(244,168,39,0.12)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', flexShrink: 0 }}>
            {tuned && <i className="ti ti-check" style={{ fontSize: 10, color: 'var(--amber)' }} aria-hidden="true" />}
          </div>
          <span style={{ fontSize: 12, color: tuned ? 'var(--amber)' : 'var(--muted)', whiteSpace: 'nowrap' }}>Tuned</span>
          <input type="checkbox" checked={tuned} onChange={e => { setIsDirty(true); setTuned(e.target.checked); }} style={{ display: 'none' }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flexShrink: 0, padding: '0 4px' }}>
          <div style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${hidden ? 'var(--muted)' : 'var(--border)'}`, background: hidden ? 'rgba(255,255,255,0.07)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', flexShrink: 0 }}>
            {hidden && <i className="ti ti-check" style={{ fontSize: 10, color: 'var(--muted)' }} aria-hidden="true" />}
          </div>
          <span style={{ fontSize: 12, color: hidden ? 'var(--text)' : 'var(--muted)', whiteSpace: 'nowrap' }}>Hidden</span>
          <input type="checkbox" checked={hidden} onChange={e => { setIsDirty(true); setHidden(e.target.checked); }} style={{ display: 'none' }} />
        </label>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ flexShrink: 0 }}>{saving ? <><i className="ti ti-loader spin" style={{ fontSize: 13 }} aria-hidden="true" /> Saving…</> : 'Save'}</button>
      </div>

      <div className="editor-list">
        {hasAlt && (
          <div className="source-toggle">
            <button className={`source-tab${!editingAlt ? ' active' : ''}`} onClick={() => handleToggleSource(false)}>AI-corrected</button>
            <button className={`source-tab${editingAlt ? ' active' : ''}`} onClick={() => handleToggleSource(true)}>WhisperX</button>
          </div>
        )}
        {!editingAlt && (
          <div className="card" style={{ marginBottom: 8 }}>
            <span className="card-label">Song details</span>
            <div className="field"><input value={localTitle} onChange={e => { setIsDirty(true); setLocalTitle(e.target.value); }} placeholder="Song title" /></div>
            <div className="field" style={{ marginBottom: 0 }}><input value={localArtist} onChange={e => { setIsDirty(true); setLocalArtist(e.target.value); }} placeholder="Artist name" /></div>
          </div>
        )}

        {lines.map((line, idx) => {
          const isActive  = activeIdx === idx;
          const lineHasWords = (line.words?.length ?? 0) > 0;
          if (isActive) return (
            <div key={line.id} className="editor-row-active">
              <div className="editor-row-top">
                {/* Timestamp: derived if words exist, else editable */}
                {lineHasWords
                  ? <span className="editor-ts-input" style={{ color: 'var(--muted)', cursor: 'default', userSelect: 'none' }}>{fmtWordTime(line.time)}</span>
                  : <input className="editor-ts-input" defaultValue={fmt(line.time)} onBlur={e => updateLine(idx, 'time', parseTime(e.target.value))} onClick={e => e.stopPropagation()} aria-label="Timestamp" />
                }
                {/* Text: derived if words exist, else editable */}
                {lineHasWords
                  ? <div className="editor-text-derived" onClick={e => e.stopPropagation()}><i className="ti ti-lock" style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }} aria-hidden="true" /><span style={{ flex: 1, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{line.text}</span></div>
                  : <input className="editor-text-input" type="text" value={line.text} onChange={e => updateLine(idx, 'text', e.target.value)} autoFocus placeholder="Lyric text…" onClick={e => e.stopPropagation()} />
                }
                {/* End time: only for non-word lines, right-aligned balancing the start time */}
                {!lineHasWords && (
                  <input className="editor-ts-input editor-ts-input--end" defaultValue={line.endTime != null ? fmt(line.endTime) : ''} placeholder="-:--.-" onBlur={e => { const v = parseTime(e.target.value); updateLine(idx, 'endTime', v > 0 ? v : null); }} onClick={e => e.stopPropagation()} aria-label="End time (optional)" />
                )}
                <button className="btn btn-ghost editor-del-btn" onClick={e => deleteLine(idx, e)} aria-label="Delete line"><i className="ti ti-trash" aria-hidden="true" /></button>
              </div>
              {/* Color swatches */}
              <div className="editor-swatches">
                {EDITOR_COLORS.map(c => { const isSel = line.color === c.hex || (line.color === null && c.hex === '#F4A827'); return (<div key={c.hex} className={`editor-swatch${isSel ? ' editor-swatch--sel' : ''}`} style={{ background: c.hex, '--sw': c.hex }} title={c.name} onClick={e => { e.stopPropagation(); updateLine(idx, 'color', line.color === c.hex ? null : c.hex); }} />); })}
                <span className="editor-color-name">{line.color ? (EDITOR_COLORS.find(c => c.hex === line.color)?.name || '') : 'Amber (default)'}</span>
                <div style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {lineHasWords
                    ? <>
                        <button className="word-w-badge-amber" onClick={e => { e.stopPropagation(); stripWords(idx); }} title="Remove word chips — keep text and start time" style={{ fontSize: 10, padding: '2px 5px' }}>×W</button>
                        <span className="word-w-badge" title="Has word timing">W</span>
                      </>
                    : <button className="word-w-badge-amber" onClick={e => { e.stopPropagation(); convertToWords(idx); }} title="Convert to word chips">W</button>
                  }
                </div>
              </div>

              {/* Word chips — only if words exist */}
              {lineHasWords && (
                <div className="word-chips-section">
                  <p className="word-chips-hint"><i className="ti ti-info-circle" style={{ fontSize: 11 }} aria-hidden="true" /> Text and start time derive from chips below</p>
                  <div className="word-chips-row">
                    {line.words.map((w, wi) => {
                      const isSel = activeChipLine === idx && activeChipIdx === wi;
                      return (
                        <div key={wi} className={`word-chip${isSel ? ' word-chip--sel' : ''}`} onClick={e => { e.stopPropagation(); if (isSel) { commitChip(idx, wi); setActiveChipIdx(null); } else selectChip(idx, wi); }}>
                          <span className="chip-word">{w.word}</span>
                          <span className="chip-time">{fmtWordTime(w.start)}</span>
                        </div>
                      );
                    })}
                    <button className="chip-add-btn" onClick={e => { e.stopPropagation(); addWord(idx); }} aria-label="Add word"><i className="ti ti-plus" style={{ fontSize: 10 }} aria-hidden="true" /> word</button>
                  </div>
                  {/* Chip editor — shown when a chip is selected */}
                  {activeChipLine === idx && activeChipIdx !== null && activeChipIdx < line.words.length && (
                    <div className="chip-editor" onClick={e => e.stopPropagation()}>
                      <div className="chip-field-group" style={{ flex: 1, minWidth: 80 }}>
                        <span className="chip-field-label">Word</span>
                        <input className="chip-field" value={draftWord} onChange={e => setDraftWord(e.target.value)} onBlur={() => commitChip(idx, activeChipIdx)} placeholder="word" style={{ width: '100%' }} />
                      </div>
                      <div className="chip-field-group">
                        <span className="chip-field-label">Start</span>
                        <input className="chip-field chip-field--time" value={draftStart} onChange={e => setDraftStart(e.target.value)} onBlur={() => commitChip(idx, activeChipIdx)} placeholder="0:00.0" />
                      </div>
                      <div className="chip-field-group">
                        <span className="chip-field-label">End</span>
                        <input className="chip-field chip-field--time" value={draftEnd} onChange={e => setDraftEnd(e.target.value)} onBlur={() => commitChip(idx, activeChipIdx)} placeholder="0:00.0" />
                      </div>
                      <button className="btn btn-ghost" style={{ padding: '4px 7px', alignSelf: 'flex-end', color: 'var(--rose)' }} onClick={e => { e.stopPropagation(); deleteWord(idx, activeChipIdx); }} aria-label="Delete word"><i className="ti ti-trash" style={{ fontSize: 14 }} aria-hidden="true" /></button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
          return (
            <div key={line.id} className="editor-row" onClick={() => { setActiveIdx(idx); setActiveChipLine(null); setActiveChipIdx(null); }}>
              <span className="editor-ts">{fmt(line.time)}</span>
              <div className="editor-dot" style={{ background: line.color || '#F4A827' }} />
              <span className="editor-text" style={{ color: line.color || 'var(--text)' }}>{line.text || <em style={{ color: 'var(--muted)' }}>empty</em>}</span>
              {lineHasWords && <span className="word-w-badge" title="Has word timing">W</span>}
              <button className="btn btn-ghost editor-del-btn" onClick={e => deleteLine(idx, e)} aria-label="Delete line"><i className="ti ti-trash" aria-hidden="true" /></button>
            </div>
          );
        })}

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={addLine}><i className="ti ti-plus" aria-hidden="true" /> Add line</button>
          <button className="btn btn-secondary" onClick={() => {
            setLines(prev => {
              // Silently commit any active chip draft before sorting
              const committed = (activeChipLine !== null && activeChipIdx !== null)
                ? prev.map((line, i) => {
                    if (i !== activeChipLine) return line;
                    const nw = line.words.map((w, j) => j !== activeChipIdx ? w : {
                      word: draftWord.trim() || w.word,
                      start: parseWordTime(draftStart),
                      end: parseWordTime(draftEnd),
                    });
                    return { ...line, words: nw, text: nw.map(w => w.word).join(' '), time: nw[0]?.start ?? line.time, endTime: nw[nw.length - 1]?.end ?? line.endTime };
                  })
                : prev;
              // Sort lines by time, then sort words within each line
              return [...committed]
                .sort((a, b) => a.time - b.time)
                .map(line => {
                  if (!line.words?.length) return line;
                  const sw = [...line.words].sort((a, b) => a.start - b.start);
                  return { ...line, words: sw, time: sw[0]?.start ?? line.time, endTime: sw[sw.length - 1]?.end ?? line.endTime, text: sw.map(w => w.word).join(' ') };
                });
            });
          }}><i className="ti ti-arrows-sort" aria-hidden="true" /> Sort by time</button>
          {onDelete && (
            <button
              className="btn btn-secondary"
              style={{ marginLeft: 'auto', color: 'var(--rose)', borderColor: 'var(--rose)' }}
              onClick={() => { if (window.confirm(`Delete "${song.title}"? This cannot be undone.`)) onDelete(song); }}
            >
              <i className="ti ti-trash" aria-hidden="true" /> Delete song
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


// ── ADD SONG SCREEN ───────────────────────────────────────────────────────────
// Simplified: auto mode queues songs for batch processing,
// manual mode adds directly to library with existing karaoke track.
function AddSongScreen({ songs = [], onSave, onAddToQueue }) {
  const [title, setTitle]           = useState('');
  const [artist, setArtist]         = useState('');
  const [origFile, setOrigFile]     = useState(null);
  const [instrFile, setInstrFile]   = useState(null);
  const [lyricsText, setLyricsText] = useState('');
  const [mode, setMode]             = useState('auto');

  function handleSave() {
    const textLines = lyricsText.trim()
      ? parseLRC(lyricsText).length > 0 ? parseLRC(lyricsText)
        : lyricsText.split('\n').filter(Boolean).map((t, i) => ({ id: uid(), time: i * 3.5, text: t, color: null, words: [] }))
      : [];
    onSave({
      id: uid(), title: title.trim(), artist: artist.trim(),
      audioUrl: instrFile ? URL.createObjectURL(instrFile) : null,
      vocalsUrl: null, hasAudio: !!instrFile,
      lyrics: textLines, lyricsAlt: [], tags: [],
      lyricsType: textLines.length > 0 ? 'plain' : 'none',
      lyricsSource: 'primary', plainLyrics: lyricsText,
    });
  }

  function handleAddToQueue() {
    if (!origFile || !title.trim()) return;
    onAddToQueue?.({ file: origFile, title: title.trim(), artist: artist.trim() });
    setTitle(''); setArtist(''); setOrigFile(null);
  }

  const duplicate = (() => {
    if (!title.trim()) return null;
    const t = title.trim().toLowerCase(), a = artist.trim().toLowerCase();
    return songs.find(s => s.title.toLowerCase() === t && (s.artist || '').toLowerCase() === a) || null;
  })();

  return (
    <div style={{ padding: '8px 18px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="mode-tabs">{['auto', 'manual'].map(m => (<button key={m} className={`mode-tab${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}><i className={`ti ${m === 'auto' ? 'ti-sparkles' : 'ti-upload'}`} aria-hidden="true" style={{ marginRight: 5, fontSize: 13 }} />{m === 'auto' ? 'Auto · AI' : 'Manual'}</button>))}</div>
      <div className="card">
        <span className="card-label">Song details</span>
        <div className="field"><input placeholder="Song title *" value={title} onChange={e => setTitle(e.target.value)} /></div>
        <div className="field"><input placeholder="Artist name" value={artist} onChange={e => setArtist(e.target.value)} /></div>
      </div>
      {duplicate && (
        <div className="warn-box" style={{ marginTop: -6 }}>
          <i className="ti ti-alert-triangle" aria-hidden="true" /> Already in library: <strong>{duplicate.title}</strong>{duplicate.artist ? ` — ${duplicate.artist}` : ''}
        </div>
      )}

      {mode === 'auto' && (
        <>
          <div className="card">
            <span className="card-label">Upload original song</span>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>AI separates vocals, transcribes lyrics, and corrects timing. Original file is deleted after processing.</p>
            <label className={`upload-zone${origFile ? ' has-file' : ''}`}>
              <input type="file" accept="audio/*" onChange={e => setOrigFile(e.target.files[0])} />
              <i className={`ti ${origFile ? 'ti-check' : 'ti-file-music'}`} style={{ color: origFile ? '#20bf6b' : 'var(--muted)' }} aria-hidden="true" />
              {origFile ? <p className="filename">{origFile.name}</p> : <><p style={{ fontWeight: 700, color: 'var(--text)' }}>Drop audio file here</p><p>MP3, WAV, FLAC, M4A</p></>}
            </label>
          </div>
          <div className="info-box"><i className="ti ti-info-circle" aria-hidden="true" /> LRClib checked first for correct lyrics text.</div>
          <button className="btn btn-process btn-full" onClick={handleAddToQueue} disabled={!origFile || !title.trim()}>
            <i className="ti ti-stack-push" aria-hidden="true" /> Add to queue
          </button>
        </>
      )}

      {mode === 'manual' && (
        <>
          <div className="card">
            <span className="card-label">Lyrics</span>
            <button className="btn btn-secondary btn-full" style={{ marginBottom: 12 }} onClick={async () => { if (!title.trim()) return; const res = await lrcSearch(artist, title); if (res?.plain) setLyricsText(res.plain); else alert('Not found on LRClib.'); }}><i className="ti ti-search" aria-hidden="true" /> Search LRClib</button>
            <textarea value={lyricsText} onChange={e => setLyricsText(e.target.value)} placeholder={"Paste lyrics here…\n\nOr LRC format:\n[00:12.34]First line"} rows={7} />
          </div>
          <div className="card">
            <span className="card-label">Instrumental track</span>
            <label className={`upload-zone${instrFile ? ' has-file' : ''}`}>
              <input type="file" accept="audio/*" onChange={e => setInstrFile(e.target.files[0])} />
              <i className={`ti ${instrFile ? 'ti-check' : 'ti-music'}`} style={{ color: instrFile ? '#20bf6b' : 'var(--muted)' }} aria-hidden="true" />
              {instrFile ? <p className="filename">{instrFile.name}</p> : <><p style={{ fontWeight: 700, color: 'var(--text)' }}>Upload karaoke / instrumental</p><p>MP3, WAV, M4A</p></>}
            </label>
          </div>
          <button className="btn btn-primary btn-full" onClick={handleSave} disabled={!title.trim()}><i className="ti ti-plus" aria-hidden="true" /> Add to library</button>
        </>
      )}
    </div>
  );
}


// ── PLAYER SCREEN ─────────────────────────────────────────────────────────────
function PlayerScreen({ song, settings, autoPlay, randomMode, nextUpSong, nextQueuedSong, hasNext, onBack, onSongEnd, onReload, onStartRandom, onStopRandom, onSkipRandom, onGoToPrevious }) {
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
  const [lyricMode, setLyricMode] = useState(() => { try { return localStorage.getItem('karaklas_lyric_mode') || 'wash'; } catch { return 'wash'; } });
  function toggleLyricMode(mode) { setLyricMode(mode); try { localStorage.setItem('karaklas_lyric_mode', mode); } catch {} }

  const [isCinematic, setIsCinematic] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);
  useEffect(() => { const check = () => setIsCinematic(window.innerWidth >= 768); window.addEventListener('resize', check); return () => window.removeEventListener('resize', check); }, []);
  const [isBuffering, setIsBuffering] = useState(false);

  const clockAnchorRef = useRef(null); // { clockTime, audioTime } — set on every play/resume/seek
  const seekSafetyRef  = useRef(null); // timeout handle for seek watchdog
  const retryTimerRef  = useRef(null); // timeout handle for AbortError retry

  stateRef.current = { playing, currentTime, duration, randomMode, guideVolume, hasNext, onSongEnd };

  // Record where we are in both clocks so the RAF tick can interpolate accurately
  function setClockAnchor(audioTime) {
    const clock = getAudioClock();
    if (clock) clockAnchorRef.current = { clockTime: clock.currentTime, audioTime };
  }

  useEffect(() => {
    setPlaying(false); setCurrentTime(0); setDuration(0); setActiveLine(-1);
    setGuideExpanded(false); setGuideVolume(settings?.defaultGuideVolume ?? 0); setPlayError(null);
    clockAnchorRef.current = null; // discard anchor — new song starts fresh
    setIsBuffering(false);         // clear any leftover buffering state from previous song
    if (autoPlay) {
      const el = audioRef.current;
      if (!el) return;
      // For blob: URLs readyState >= 3 immediately (data in memory) — no buffering shown.
      // For Supabase URLs, wait for canplay and show the loading bar while waiting.
      if (el.readyState >= 3) { setPlaying(true); return; }
      setIsBuffering(true);
      const onReady = () => { setIsBuffering(false); setPlaying(true); };
      el.addEventListener('canplay', onReady, { once: true });
      const fallback = setTimeout(() => {
        el.removeEventListener('canplay', onReady);
        setIsBuffering(false);
        setPlaying(true); // try anyway after 5s
      }, 5000);
      return () => {
        el.removeEventListener('canplay', onReady);
        clearTimeout(fallback);
        setIsBuffering(false);
      };
    }
  }, [song.id]);

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const onMeta = () => { setDuration(a.duration); };
    // Use stateRef so onSongEnd always reflects current queue state,
    // even if songs were added after this song started playing
    const onEnd  = () => { setPlaying(false); setActiveLine(-1); stateRef.current.onSongEnd?.(); };
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnd);
    return () => {
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnd);
    };
  }, [song.id]);

  // Abort in-flight audio downloads when this song's component unmounts.
  // Without this, partial downloads hold CDN connections open across song changes.
  // After 2-3 skips the browser's per-domain connection pool fills up and new songs stall.
  // el.src = '' + el.load() is the standard HTML5 pattern for aborting media fetches.
  useEffect(() => {
    return () => {
      const abort = el => {
        if (!el) return;
        try { el.pause(); el.src = ''; el.load(); } catch {}
      };
      abort(audioRef.current);
      abort(guideRef.current);
    };
  }, []); // [] = cleanup only runs on unmount, not on every render

  // Start guide vocals synced to wherever the instrumental currently is.
  // If guide isn't buffered yet, wait for canplay then seek to current position.
  // This prevents the ~3s late-start caused by a cold browser cache.
  function startGuideSynced(main, guide, vol) {
    if (!guide || !main) return;
    const doStart = () => {
      if (main.paused) return; // user paused while guide was loading — don't start
      guide.volume = vol;
      guide.currentTime = main.currentTime; // catch up to wherever instrumental is
      guide.play().catch(() => {});
    };
    if (guide.readyState >= 2) { doStart(); }
    else { guide.addEventListener('canplay', doStart, { once: true }); }
  }

  // Reload: triggered by the reload button or called from App when needed.
  // Clears any error state, then delegates to App for a full PlayerScreen remount
  // (the only reliable way to get a fresh audio element + new CDN request).
  function reloadSong() {
    setPlayError(null);
    setPlaying(false);
    onReload?.();
  }

  // Sync: re-anchor the lyrics clock and snap guide vocals to instrumental position.
  // Equivalent to pause+play but without interrupting audio — useful when guide
  // vocals drift or lyrics fall behind due to VBR timing drift.
  function handleSync() {
    const main  = audioRef.current;
    const guide = guideRef.current;
    if (!main) return;
    setClockAnchor(main.currentTime);                     // re-anchor lyrics timing
    if (guide && guideVolume > 0) {
      guide.currentTime = main.currentTime;               // snap guide to instrumental
      if (guide.paused && !main.paused) guide.play().catch(() => {});
    }
  }

  useEffect(() => {
    const main = audioRef.current; const guide = guideRef.current; if (!main) return;
    if (playing) {
      main.volume = settings.masterVolume ?? 1;
      getAudioClock(); // ensure clock is running (resumes if suspended)

      main.play().then(() => {
        setClockAnchor(main.currentTime);
      }).catch(err => {
        if (err.name === 'AbortError') {
          // AbortError during navigation — retry once after a short delay.
          // Stored in a ref so the cleanup below can cancel it if the song changes.
          retryTimerRef.current = setTimeout(() => {
            if (!audioRef.current || !audioRef.current.paused) return;
            audioRef.current.play()
              .then(() => setClockAnchor(audioRef.current.currentTime))
              .catch(() => setPlaying(false));
          }, 250);
          return;
        }
        console.error('Playback failed:', err.message);
        setPlaying(false);
        setPlayError(song.audioUrl?.startsWith('blob:') ? 'Audio expired — re-add this song to fix.' : `Could not play. (${err.message})`);
      });

      if (guide && guideVolume > 0) {
        startGuideSynced(main, guide, (settings.masterVolume ?? 1) * guideVolume);
      }
      const tick = () => {
        const anchor = clockAnchorRef.current;
        const clock  = _audioClock;
        const t = (anchor && clock)
          ? Math.min(anchor.audioTime + (clock.currentTime - anchor.clockTime), duration || Infinity)
          : main.currentTime;
        setCurrentTime(t);
        const src = song.lyrics?.length > 0 ? song.lyrics : [];
        if (src.length > 0) {
          let idx = -1;
          for (let i = 0; i < src.length; i++) {
            if (src[i].time <= t) idx = i; else break;
          }
          setActiveLine(idx);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else { main.pause(); guide?.pause(); cancelAnimationFrame(rafRef.current); }
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(retryTimerRef.current); // cancel pending retry if song changes mid-flight
    };
  }, [playing]);

  useEffect(() => {
    const guide = guideRef.current; const main = audioRef.current; if (!guide) return;
    guide.volume = (settings.masterVolume ?? 1) * guideVolume;
    if (playing && guideVolume > 0) {
      startGuideSynced(main, guide, (settings.masterVolume ?? 1) * guideVolume);
    }
    else if (guideVolume === 0) guide.pause();
  }, [guideVolume]);

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const { playing, currentTime, duration, randomMode, guideVolume, hasNext: refHasNext, onSongEnd: refOnSongEnd } = stateRef.current;
      switch (e.key) {
        case ' ': e.preventDefault(); setPlaying(p => !p); break;
        case 'Escape': e.preventDefault(); onBack?.(); break;
        case 'ArrowRight': e.preventDefault(); if (refHasNext) { refOnSongEnd?.(); } else if (audioRef.current) { const t = Math.min(duration, currentTime + 10); audioRef.current.currentTime = t; if (guideRef.current) guideRef.current.currentTime = t; if (_audioClock) clockAnchorRef.current = { clockTime: _audioClock.currentTime, audioTime: t }; setCurrentTime(t); } break;
        case 'ArrowLeft': e.preventDefault(); if (currentTime <= 2) { onGoToPrevious?.(); } else { if (audioRef.current) { audioRef.current.currentTime = 0; } if (guideRef.current) guideRef.current.currentTime = 0; if (_audioClock) clockAnchorRef.current = { clockTime: _audioClock.currentTime, audioTime: 0 }; setCurrentTime(0); setActiveLine(-1); } break;
        case 'm': case 'M': setGuideVolume(v => v > 0 ? 0 : 0.3); break;
        case 'r': case 'R': if (randomMode) onStopRandom?.(); else onStartRandom?.(); break;
        case 'f': case 'F': if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch?.(() => {}); else document.exitFullscreen?.().catch?.(() => {}); break;
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function seek(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (duration || 0);
    const main = audioRef.current;
    if (!main) return;

    setCurrentTime(t); // immediate visual feedback

    // Re-anchor AFTER the browser confirms the seek position — critical for VBR MP3s
    // where the actual seeked position can differ from the requested one.
    clearTimeout(seekSafetyRef.current);
    const onSeeked = () => {
      clearTimeout(seekSafetyRef.current);
      const actual = main.currentTime;
      setClockAnchor(actual);
      if (guideRef.current) guideRef.current.currentTime = actual;
    };
    main.addEventListener('seeked', onSeeked, { once: true });
    // Safety: if seeked never fires (e.g. network stall), anchor after 2s anyway
    seekSafetyRef.current = setTimeout(() => {
      main.removeEventListener('seeked', onSeeked);
      setClockAnchor(main.currentTime);
    }, 2000);

    main.currentTime = t;
    if (guideRef.current) guideRef.current.currentTime = t;
  }
  function handleRestart() {
    if (audioRef.current) { audioRef.current.currentTime = 0; }
    if (guideRef.current) guideRef.current.currentTime = 0;
    setClockAnchor(0);
    setCurrentTime(0);
    setActiveLine(-1);
  }
  function handleSkip() {
    if (hasNext) { onSongEnd?.(); return; }
    if (audioRef.current) {
      const t = Math.min(duration, currentTime + 10);
      audioRef.current.currentTime = t;
      if (guideRef.current) guideRef.current.currentTime = t;
      setClockAnchor(t);
      setCurrentTime(t);
    }
  }

  // Respect the source preference saved from the editor
  const lyrics   = (song.lyricsSource === 'alt' && song.lyricsAlt?.length > 0)
    ? song.lyricsAlt
    : (song.lyrics || []);
  const hasWords = lyrics.some(l => l.words?.length > 0);
  const pct      = duration > 0 ? (currentTime / duration) * 100 : 0;
  const c        = songColor(song);
  // Show "up next" card 20s before end — covers both random nextUp and queued next song
  const displayNextSong = nextUpSong || nextQueuedSong || null;
  const showNextUp = !!displayNextSong && duration > 0 && (duration - currentTime) <= 20 && (duration - currentTime) > 0;

  function renderActiveLine(line) {
    if (!line) return '\u00A0';
    const lineColor = line.color || 'var(--amber)';
    if (lyricMode === 'wash' && line.words?.length > 0) {
      // Always iterate line.text words — not line.words.
      // Chips (line.words) may be shorter than the text (WhisperX missed some words),
      // or slightly misaligned (Claude shifted assignment). By driving from text and
      // using chips[i] purely for timing, every word stays visible regardless of
      // data quality. Words without a matching chip show at lineColor (no animation).
      const textWords = line.text?.split(/\s+/).filter(Boolean) || [];
      const chips     = line.words;
      return (
        <span>
          {textWords.map((word, i) => {
            const chip     = chips[i];       // timing for this word (may be undefined)
            const nextChip = chips[i + 1];   // used to detect when this word ends
            let color;
            if (!chip) {
              color = lineColor;             // no timing data — show visibly, no animation
            } else if (currentTime < chip.start) {
              color = lineColor;             // not yet
            } else if (!nextChip || currentTime < nextChip.start) {
              color = makePale(line.color || '#F4A827'); // currently singing
            } else {
              color = 'rgba(237,233,224,0.42)';          // sung, dimmed but readable
            }
            return (
              <span key={i} style={{ color, transition: 'color 0.1s' }}>
                {word}{i < textWords.length - 1 ? ' ' : ''}
              </span>
            );
          })}
        </span>
      );
    }
    return line.text;
  }

  const audioEls = (<>{song.audioUrl && <audio ref={audioRef} src={song.audioUrl} preload="auto" />}{song.vocalsUrl && <audio ref={guideRef} src={song.vocalsUrl} preload="metadata" />}</>);

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
        const singEnd       = lastWordEnd ?? currentLine?.endTime ?? currentLine?.time ?? 0;
        const totalBreak    = nextLine ? nextLine.time - singEnd : 0;
        const pastSinging   = lastWordEnd ? currentTime >= lastWordEnd : (currentTime - (currentLine?.time ?? 0)) >= 2;
        const inBreak        = activeLine >= 0 && nextLine !== undefined && totalBreak >= 20 && pastSinging && timeToNext !== null && timeToNext > 0;
        const breakCountdown = inBreak ? Math.max(0, Math.ceil(timeToNext)) : 0;
        const showIntro      = activeLine < 0 && lyrics.length > 0 && lyrics[0].time > 15 && currentTime < lyrics[0].time;
        const introCountdown = showIntro ? Math.max(0, Math.ceil(lyrics[0].time - currentTime)) : 0;
        const lastLyricLine  = lyrics[lyrics.length - 1];
        const songDuration   = audioRef.current?.duration || 0;
        const pastLastLyric  = activeLine >= lyrics.length - 1 && lastLyricLine && currentTime > (lastLyricLine.endTime ?? lastLyricLine.time);
        const outroRemaining = songDuration > 0 ? songDuration - currentTime : 0;
        const showOutro      = pastLastLyric && outroRemaining > 15;
        const outroCountdown = showOutro ? Math.max(0, Math.ceil(outroRemaining)) : 0;
        const classMap      = { '-1':'past','0':'active','1':'next1','2':'next2' };
        return (
          <>
            {[-1,0].map(off => {
              const line      = lyrics[activeLine + off];
              const isCur     = off === 0;
              const lineColor = line?.color || 'var(--amber)';
              const cls       = (isCur && inBreak) ? 'past' : classMap[String(off)];
              const content = isCur
                ? (showIntro ? null : renderActiveLine(line))   // null = handled by intro pill above
                : (line ? line.text : '\u00A0');
              if (isCur && showIntro) return <div key={off} className="lyric-line past">{'\u00A0'}</div>;
              if (isCur && showOutro)  return <div key={off} className="lyric-line past">{'\u00A0'}</div>;
              return (<div key={off} className={`lyric-line ${cls}`} style={(isCur && !inBreak && !showIntro && !showOutro) ? { color: lineColor, textShadow: `0 0 28px ${lineColor}50` } : undefined}>{content ?? '\u00A0'}</div>);
            })}
            {showIntro && activeLine < 0 && (
              <div className="lyric-break-info">Intro — {introCountdown}s</div>
            )}
            {inBreak && <div className="lyric-break-info">Musical break — {breakCountdown}s</div>}
            {showOutro && <div className="lyric-break-info">Outro — {outroCountdown}s</div>}
            {[1,2].map(off => { const line = lyrics[activeLine + off]; return (<div key={off} className={`lyric-line ${classMap[String(off)]}`}>{line ? line.text : '\u00A0'}</div>); })}
          </>
        );
      })()}
    </div>
  );

  const nextUpCard = showNextUp && (() => {
    const nc = songColor(displayNextSong);
    return (
      <div className="next-up-card" onClick={() => onSongEnd?.()}>
        <div className="song-avatar" style={{ background: nc.bg, color: nc.fg, width: 36, height: 36, fontSize: 15, flexShrink: 0 }}>{displayNextSong.title[0]?.toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="next-up-label">Up next</p>
          <p className="next-up-title">{displayNextSong.title}</p>
          <p className="next-up-artist">{displayNextSong.artist}</p>
        </div>
        <i className="ti ti-chevron-right" style={{ fontSize: 16, color: 'var(--muted)', flexShrink: 0 }} aria-hidden="true" />
      </div>
    );
  })();

  const playBtn = (<button className="play-btn" onClick={() => setPlaying(p => !p)} disabled={!song.audioUrl} aria-label={playing ? 'Pause' : 'Play'}><i className={`ti ${playing ? 'ti-player-pause' : 'ti-player-play'}`} aria-hidden="true" /></button>);

  const hintLine = <p style={{ textAlign: 'center', fontSize: 10, color: 'rgba(91,98,128,0.4)', padding: '0 0 8px', margin: 0 }}>Space · Esc · ← → · M · R · F</p>;

  if (isCinematic) return (
    <div className="player-screen" style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      {audioEls}{randomBand}
      {/* Amber sweep bar — visible only while waiting for canplay */}
      <div aria-hidden="true" style={{ height: isBuffering ? 2 : 0, overflow: 'hidden', background: 'rgba(255,255,255,0.06)', flexShrink: 0, position: 'relative', transition: 'height 0.15s' }}>
        {isBuffering && <div style={{ position: 'absolute', top: 0, left: 0, height: '100%', background: '#F4A827', animation: 'kk-sweep 1.8s cubic-bezier(.4,0,.2,1) infinite' }} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 28px', borderBottom: '0.5px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <button className="player-back" onClick={onBack} aria-label="Back"><i className="ti ti-arrow-left" aria-hidden="true" /></button>
        <p style={{ flex: 1, fontSize: 14, color: 'rgba(200,205,230,0.65)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{song.title}{song.artist ? ` — ${song.artist}` : ''}</p>
        {!song.audioUrl && <span className="badge badge-amber">No audio</span>}
        {hasWords && (
          <div className="lyric-mode-toggle" style={{ flexShrink: 0 }}>
            <button className={`lmt-btn${lyricMode === 'wash' ? ' lmt-active' : ''}`} onClick={() => toggleLyricMode('wash')} title="Words" aria-label="Word wash mode">W</button>
            <button className={`lmt-btn${lyricMode === 'solid' ? ' lmt-active' : ''}`} onClick={() => toggleLyricMode('solid')} title="Lines" aria-label="Lines colour mode">¶</button>
          </div>
        )}
        {/* Reload + cancel — matched pair, song management actions */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ padding: 7 }} onClick={reloadSong} aria-label="Reload song" title="Reload — restart if audio is stuck"><i className="ti ti-rotate-2" style={{ fontSize: 16, color: 'rgba(200,205,230,0.45)' }} aria-hidden="true" /></button>
          <button className="btn btn-ghost" style={{ padding: 7 }} onClick={() => hasNext ? onSongEnd?.() : onBack?.()} aria-label="Cancel song" title="Cancel song"><i className="ti ti-x" style={{ fontSize: 16, color: 'rgba(200,205,230,0.45)' }} aria-hidden="true" /></button>
        </div>
      </div>
      {playError && (<div style={{ margin: '0 28px 8px', padding: '10px 14px', background: 'rgba(232,96,122,0.12)', border: '1px solid rgba(232,96,122,0.25)', borderRadius: 'var(--radius)', fontSize: 13, color: '#E8607A', lineHeight: 1.5 }}>{playError}</div>)}
      {lyricsArea}{nextUpCard}
      {guideExpanded && (<div className="cinematic-guide-panel"><i className="ti ti-microphone" style={{ fontSize: 18, color: guideVolume > 0 ? 'var(--amber)' : 'var(--muted)', flexShrink: 0 }} aria-hidden="true" /><input type="range" min="0" max="1" step="0.02" value={guideVolume} onChange={e => setGuideVolume(parseFloat(e.target.value))} className="guide-slider" aria-label="Guide vocals volume" /><span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 36, textAlign: 'right', flexShrink: 0 }}>{guideVolume === 0 ? 'Off' : `${Math.round(guideVolume * 100)}%`}</span></div>)}
      <div className="cinematic-bar" style={{ opacity: isBuffering ? 0.35 : 1, transition: 'opacity 0.2s', pointerEvents: isBuffering ? 'none' : 'auto' }}>
        <button className="ctrl-btn" onClick={handleRestart} aria-label="Restart"><i className="ti ti-player-skip-back" aria-hidden="true" /></button>
        {playBtn}
        <button className="ctrl-btn" onClick={handleSkip} aria-label={hasNext ? 'Next song' : 'Skip 10s'}><i className="ti ti-player-skip-forward" aria-hidden="true" /></button>
        <div className="cinematic-progress" onClick={seek}><div className="cinematic-fill" style={{ width: `${pct}%` }} /></div>
        <span className="cinematic-time">{fmt(currentTime)} / {fmt(duration)}</span>
        {/* Sync + mic — paired audio-control actions */}
        <button className="sync-btn" onClick={handleSync} aria-label="Sync" title="Sync — re-align lyrics and guide vocals"><i className="ti ti-refresh" aria-hidden="true" /></button>
        <button className={`guide-toggle-btn${guideVolume > 0 ? ' active' : ''}`} onClick={() => setGuideExpanded(p => !p)} aria-label="Guide vocals"><i className="ti ti-microphone" style={{ fontSize: 19 }} aria-hidden="true" />{guideVolume > 0 && !guideExpanded && <span style={{ fontSize: 11 }}>{Math.round(guideVolume * 100)}%</span>}</button>
      </div>
      {hintLine}
    </div>
  );

  return (
    <div className="player-screen">
      {audioEls}{randomBand}
      {/* Amber sweep bar — visible only while waiting for canplay */}
      <div aria-hidden="true" style={{ height: isBuffering ? 2 : 0, overflow: 'hidden', background: 'rgba(255,255,255,0.06)', flexShrink: 0, position: 'relative', transition: 'height 0.15s' }}>
        {isBuffering && <div style={{ position: 'absolute', top: 0, left: 0, height: '100%', background: '#F4A827', animation: 'kk-sweep 1.8s cubic-bezier(.4,0,.2,1) infinite' }} />}
      </div>
      <div className="player-header">
        <button className="player-back" onClick={onBack} aria-label="Back"><i className="ti ti-arrow-left" aria-hidden="true" /></button>
        <div className="song-avatar" style={{ background: c.bg, color: c.fg, width: 44, height: 44, fontSize: 18 }}>{song.title[0]?.toUpperCase()}</div>
        <div className="player-meta" style={{ flex: 1, minWidth: 0 }}><div className="player-title">{song.title}</div><div className="player-artist">{song.artist || 'Unknown artist'}</div></div>
        {!song.audioUrl && <span className="badge badge-amber">No audio</span>}
        {hasWords && (
          <div className="lyric-mode-toggle">
            <button className={`lmt-btn${lyricMode === 'wash' ? ' lmt-active' : ''}`} onClick={() => toggleLyricMode('wash')} title="Words" aria-label="Word wash mode">W</button>
            <button className={`lmt-btn${lyricMode === 'solid' ? ' lmt-active' : ''}`} onClick={() => toggleLyricMode('solid')} title="Lines" aria-label="Lines colour mode">¶</button>
          </div>
        )}
        {/* Reload + cancel — matched pair, song management actions */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ padding: 7 }} onClick={reloadSong} aria-label="Reload song" title="Reload — restart if audio is stuck"><i className="ti ti-rotate-2" style={{ fontSize: 16, color: 'var(--muted)' }} aria-hidden="true" /></button>
          <button className="btn btn-ghost" style={{ padding: 7 }} onClick={() => hasNext ? onSongEnd?.() : onBack?.()} aria-label="Cancel song" title="Cancel song"><i className="ti ti-x" style={{ fontSize: 16, color: 'var(--muted)' }} aria-hidden="true" /></button>
        </div>
      </div>
      {playError && (<div style={{ margin: '0 20px 6px', padding: '10px 14px', background: 'rgba(232,96,122,0.12)', border: '1px solid rgba(232,96,122,0.25)', borderRadius: 'var(--radius)', fontSize: 13, color: '#E8607A', lineHeight: 1.5 }}>{playError}</div>)}
      {lyricsArea}{nextUpCard}
      <div className="progress-wrap"><div className="progress-track" onClick={seek}><div className="progress-fill" style={{ width: `${pct}%` }} /></div><div className="time-row"><span>{fmt(currentTime)}</span><span>{fmt(duration)}</span></div></div>
      <div className="guide-panel">
        {/* Sync + mic — paired audio-control actions */}
        <button className="sync-btn" onClick={handleSync} aria-label="Sync" title="Sync — re-align lyrics and guide vocals"><i className="ti ti-refresh" aria-hidden="true" /></button>
        <button className={`guide-toggle-btn${guideVolume > 0 ? ' active' : ''}`} onClick={() => setGuideExpanded(p => !p)} aria-label="Guide vocals"><i className="ti ti-microphone" style={{ fontSize: 19 }} aria-hidden="true" />{guideVolume > 0 && !guideExpanded && <span style={{ fontSize: 11 }}>{Math.round(guideVolume * 100)}%</span>}</button>
        {guideExpanded && (<div className="guide-slider-wrap"><span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{guideVolume === 0 ? 'Off' : `${Math.round(guideVolume * 100)}%`}</span><input type="range" min="0" max="1" step="0.02" value={guideVolume} onChange={e => setGuideVolume(parseFloat(e.target.value))} className="guide-slider" aria-label="Guide vocals volume" /></div>)}
      </div>
      <div className="controls" style={{ opacity: isBuffering ? 0.35 : 1, transition: 'opacity 0.2s', pointerEvents: isBuffering ? 'none' : 'auto' }}>
        <button className="ctrl-btn" onClick={handleRestart} aria-label="Restart"><i className="ti ti-player-skip-back" aria-hidden="true" /></button>
        {playBtn}
        <button className="ctrl-btn" onClick={handleSkip} aria-label={hasNext ? 'Next song' : 'Skip 10s'}><i className="ti ti-player-skip-forward" aria-hidden="true" /></button>
      </div>
      {hintLine}
    </div>
  );
}


// ── ORPHANED FILES PANEL ─────────────────────────────────────────────────────
function OrphanedFilesPanel() {
  const [files, setFiles]     = useState(null); // null = not loaded
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState([]);
  const [deleting, setDeleting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const allSel = files?.length > 0 && selected.length === files.length;

  function toggleSel(path) { setSelected(p => p.includes(path) ? p.filter(x => x !== path) : [...p, path]); }
  function toggleAll()      { setSelected(allSel ? [] : (files || []).map(f => f.path)); }

  async function handleLoad() {
    setLoading(true); setStatusMsg('');
    const found = await findOrphanedFiles();
    setFiles(found); setSelected([]); setLoading(false);
  }

  async function handleDelete() {
    const toDel = (files || []).filter(f => selected.includes(f.path));
    if (!toDel.length) return;
    if (!window.confirm(`Permanently delete ${toDel.length} file${toDel.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    setDeleting(true);
    await supabase.storage.from('songs').remove(toDel.map(f => f.path));
    setFiles(p => p.filter(f => !selected.includes(f.path)));
    setStatusMsg(`✓ Deleted ${toDel.length} file${toDel.length !== 1 ? 's' : ''}`);
    setSelected([]);
    setDeleting(false);
  }

  const fmtSize = b => b == null ? '' : b > 1048576 ? `${(b/1048576).toFixed(1)} MB` : b > 1024 ? `${(b/1024).toFixed(0)} KB` : `${b} B`;

  if (files === null) return (
    <button className="btn btn-secondary" onClick={handleLoad} disabled={loading}>
      {loading ? <><i className="ti ti-loader spin" style={{ fontSize: 13 }} aria-hidden="true" /> Scanning…</> : <><i className="ti ti-search" aria-hidden="true" /> Scan for orphaned files</>}
    </button>
  );

  if (files.length === 0) return (
    <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{statusMsg || '✓ No orphaned files found.'}</p>
  );

  return (
    <>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 8px', cursor: 'pointer', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        <input type="checkbox" checked={allSel} onChange={toggleAll} style={{ width: 15, height: 15, accentColor: 'var(--amber)', flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Select all ({files.length})</span>
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12, maxHeight: 200, overflowY: 'auto' }}>
        {files.map(f => (
          <label key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px', cursor: 'pointer', borderRadius: 4, background: selected.includes(f.path) ? 'rgba(244,168,39,0.05)' : 'transparent' }}>
            <input type="checkbox" checked={selected.includes(f.path)} onChange={() => toggleSel(f.path)} style={{ width: 15, height: 15, accentColor: 'var(--amber)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 12, fontWeight: 600, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', color: 'var(--muted)' }}>{f.name}</p>
              <p style={{ fontSize: 10, color: 'var(--muted)', margin: 0, opacity: 0.6 }}>{f.folder}{f.size != null ? ` · ${fmtSize(f.size)}` : ''}</p>
            </div>
          </label>
        ))}
      </div>
      {statusMsg && <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 8px' }}>{statusMsg}</p>}
      <button className="btn btn-secondary" onClick={handleDelete} disabled={!selected.length || deleting}
        style={{ fontSize: 12, color: selected.length ? 'var(--rose)' : undefined, borderColor: selected.length ? 'var(--rose)' : undefined }}>
        <i className="ti ti-trash" aria-hidden="true" /> Delete{selected.length ? ` (${selected.length})` : ''}
      </button>
    </>
  );
}

// ── LIBRARY MIGRATION PANEL ───────────────────────────────────────────────────
// One-time migration from library/ to library/admin/.
// Disappears once completed (tracked in localStorage).
function LibraryMigrationPanel() {
  const [done]       = useState(() => !!localStorage.getItem(MIGRATION_KEY));
  const [status, setStatus] = useState('idle'); // 'idle' | 'running' | 'done' | 'error'
  const [progress, setProgress] = useState(null); // { migrated, total, current }
  const [result, setResult]     = useState(null);

  if (done) return null;

  async function handleMigrate() {
    setStatus('running');
    setProgress({ migrated: 0, total: '?', current: '…' });
    try {
      const res = await migrateLibraryToAdmin(p => setProgress(p));
      setResult(res);
      setStatus('done');
      if (res.failed === 0) localStorage.setItem(MIGRATION_KEY, '1');
    } catch (e) {
      setResult({ error: e.message });
      setStatus('error');
    }
  }

  return (
    <div className="card" style={{ borderColor: status === 'done' && result?.failed === 0 ? 'rgba(32,191,107,0.3)' : 'rgba(244,168,39,0.3)' }}>
      <span className="card-label">Library migration</span>
      {status === 'idle' && (
        <>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.6 }}>
            Moves your songs from <code style={{ fontSize: 11 }}>library/</code> to <code style={{ fontSize: 11 }}>library/admin/</code> to prepare for multi-user support. Run this once before adding more songs.
          </p>
          <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={handleMigrate}>
            <i className="ti ti-folder-arrow-right" aria-hidden="true" style={{ marginRight: 6 }} />
            Migrate now
          </button>
        </>
      )}
      {status === 'running' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--amber)' }}>
          <i className="ti ti-loader spin" aria-hidden="true" />
          {progress ? `Moving ${progress.migrated + 1} of ${progress.total === '?' ? '…' : progress.total} — ${progress.current}` : 'Starting…'}
        </div>
      )}
      {status === 'done' && result && (
        <div style={{ fontSize: 13, color: result.failed === 0 ? '#20BF6B' : 'var(--rose)' }}>
          {result.failed === 0
            ? <><i className="ti ti-check" aria-hidden="true" style={{ marginRight: 6 }} />Done — {result.migrated} song{result.migrated !== 1 ? 's' : ''} moved. This panel will not appear again.</>
            : <><i className="ti ti-alert-triangle" aria-hidden="true" style={{ marginRight: 6 }} />{result.migrated} moved, {result.failed} failed. Check console for details and try again.</>
          }
        </div>
      )}
      {status === 'error' && (
        <div style={{ fontSize: 13, color: 'var(--rose)' }}>
          <i className="ti ti-alert-triangle" aria-hidden="true" style={{ marginRight: 6 }} />
          Migration error: {result?.error}
        </div>
      )}
    </div>
  );
}

// ── SETTINGS SCREEN ─────────────────────────────────────────────────────────
function SettingsScreen({ settings, onSettingsChange, onRestoreSongs, songs, onAddSong, queue, queueRunning, onAddToQueue, onRemoveFromQueue, onStartQueue }) {
  const [settingsTab, setSettingsTab] = useState('songs');

  return (
    <div className="screen">
      <div className="page-header"><div><img src="/KaraKlasLogo.png" alt="KaraKlas" style={{ width: '100%', height: 'auto', display: 'block', marginBottom: 2, maxWidth: 312 }} /><div className="page-sub" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: 6 }}>Settings</div></div></div>

      {/* Internal tab bar */}
      <div className="settings-tabs-row">
        <button className={`settings-tab-btn${settingsTab === 'songs' ? ' active' : ''}`} onClick={() => setSettingsTab('songs')}>Songs</button>
        <button className={`settings-tab-btn${settingsTab === 'app' ? ' active' : ''}`} onClick={() => setSettingsTab('app')}>App</button>
      </div>

      {/* ── Songs tab ── */}
      {settingsTab === 'songs' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Add Song form */}
          <AddSongScreen songs={songs} onSave={onAddSong} onAddToQueue={onAddToQueue} />

          {/* Processing queue — shown only in this tab */}
          {queue.length > 0 && (
            <div style={{ padding: '0 18px', marginTop: 8 }}>
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="card-label" style={{ margin: 0 }}>Queue — {queue.length} song{queue.length !== 1 ? 's' : ''}</span>
                  {queue.filter(i => i.status === 'waiting').length > 0 && !queueRunning && (
                    <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={onStartQueue}>
                      <i className="ti ti-player-play" aria-hidden="true" /> Process ({queue.filter(i => i.status === 'waiting').length})
                    </button>
                  )}
                  {queueRunning && <span style={{ fontSize: 11, color: 'var(--amber)' }}><i className="ti ti-loader spin" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Running…</span>}
                </div>
                {queue.filter(item => {
            if (item.status === 'done' || item.status === 'failed')
              return (item.completedAt || 0) > Date.now() - 24 * 60 * 60 * 1000;
            return true;
          }).map(item => (
                  <div key={item.qid} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 13, fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: item.status === 'processing' ? 'var(--amber)' : item.status === 'failed' ? 'var(--rose)' : item.status === 'done' ? 'var(--muted)' : 'var(--text)' }}>{item.title}{item.artist ? ` — ${item.artist}` : ''}</p>
                      <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>{item.stageMsg}{item.error ? ` · ${item.error}` : ''}</p>
                    </div>
                    {item.status === 'waiting'
                      ? <button className="btn btn-ghost" style={{ padding: 5, flexShrink: 0 }} onClick={() => onRemoveFromQueue(item.qid)} aria-label="Remove from queue"><i className="ti ti-x" style={{ fontSize: 14 }} aria-hidden="true" /></button>
                      : <span style={{ fontSize: 16, flexShrink: 0 }}>
                          {item.status === 'processing' && <i className="ti ti-loader spin" style={{ color: 'var(--amber)' }} aria-hidden="true" />}
                          {item.status === 'done'       && <i className="ti ti-check" style={{ color: '#20BF6B' }} aria-hidden="true" />}
                          {item.status === 'failed'     && <i className="ti ti-alert-triangle" style={{ color: 'var(--rose)' }} aria-hidden="true" />}
                        </span>
                    }
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Storage management */}
          <div style={{ padding: '8px 18px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {!!(SUPA_URL && SUPA_KEY) && (
              <>
                <LibraryMigrationPanel />
                <div className="card">
                  <span className="card-label">Archived songs</span>
                  <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.6 }}>Songs deleted from the library. Audio files are kept until purged.</p>
                  <ArchivedSongsPanel onRestoreSongs={onRestoreSongs} />
                </div>
                <div className="card">
                  <span className="card-label">Orphaned files</span>
                  <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.6 }}>Audio files not referenced by any library song — from old processing attempts.</p>
                  <OrphanedFilesPanel />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── App tab ── */}
      {settingsTab === 'app' && (
        <div style={{ padding: '0 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <span className="card-label">Master volume</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <i className="ti ti-volume" style={{ fontSize: 18, color: (settings.masterVolume ?? 1) > 0 ? 'var(--amber)' : 'var(--muted)' }} aria-hidden="true" />
              <input type="range" min="0" max="1" step="0.05" value={settings.masterVolume ?? 1} onChange={e => onSettingsChange({ masterVolume: parseFloat(e.target.value) })} style={{ flex: 1 }} />
              <span style={{ fontSize: 13, color: 'var(--muted)', minWidth: 34, textAlign: 'right' }}>{Math.round((settings.masterVolume ?? 1) * 100)}%</span>
            </div>
          </div>
          <div className="card"><span className="card-label">Guide vocals — default level</span><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><i className="ti ti-microphone" style={{ fontSize: 18, color: settings.defaultGuideVolume > 0 ? 'var(--amber)' : 'var(--muted)' }} aria-hidden="true" /><input type="range" min="0" max="1" step="0.05" value={settings.defaultGuideVolume ?? 0} onChange={e => onSettingsChange({ defaultGuideVolume: parseFloat(e.target.value) })} style={{ flex: 1 }} /><span style={{ fontSize: 13, color: 'var(--muted)', minWidth: 34, textAlign: 'right' }}>{settings.defaultGuideVolume > 0 ? `${Math.round((settings.defaultGuideVolume ?? 0) * 100)}%` : 'Off'}</span></div></div>
          <div className="card"><span className="card-label">After a song finishes</span><div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>{[{ value: false, label: 'Stop playing', sub: 'Player pauses at the end (default)' }, { value: true, label: 'Play next random song', sub: 'Picks a random song automatically' }].map(opt => (<label key={String(opt.value)} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', padding: '4px 0' }}><div style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0, border: '2px solid', borderColor: (settings.autoPlayRandom ?? false) === opt.value ? 'var(--amber)' : 'var(--border)', background: (settings.autoPlayRandom ?? false) === opt.value ? 'var(--amber)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{(settings.autoPlayRandom ?? false) === opt.value && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--bg)' }} />}</div><div><p style={{ fontSize: 14, margin: 0 }}>{opt.label}</p><p style={{ fontSize: 11, color: 'var(--muted)', margin: '1px 0 0' }}>{opt.sub}</p></div><input type="radio" style={{ display: 'none' }} checked={(settings.autoPlayRandom ?? false) === opt.value} onChange={() => onSettingsChange({ autoPlayRandom: opt.value })} /></label>))}</div></div>
          <div className="card">
            <span className="card-label">Library</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', padding: '2px 0' }}>
              <div style={{ width: 18, height: 18, borderRadius: 3, border: `1.5px solid ${settings.showHidden ? 'var(--amber)' : 'var(--border)'}`, background: settings.showHidden ? 'rgba(244,168,39,0.12)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', flexShrink: 0 }}>
                {settings.showHidden && <i className="ti ti-check" style={{ fontSize: 11, color: 'var(--amber)' }} aria-hidden="true" />}
              </div>
              <div>
                <p style={{ fontSize: 14, margin: 0 }}>Show hidden songs</p>
                <p style={{ fontSize: 11, color: 'var(--muted)', margin: '1px 0 0' }}>Hidden songs are visible but marked — toggle off to hide them from the library</p>
              </div>
              <input type="checkbox" checked={settings.showHidden ?? false} onChange={e => onSettingsChange({ showHidden: e.target.checked })} style={{ display: 'none' }} />
            </label>
          </div>
          <div className="card"><span className="card-label">Keyboard shortcuts</span><div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 13 }}>{[['Space','Play / pause'],['Esc','Close player'],['←','Restart (or prev song if within 2s)'],['→','Skip +10s (or next random)'],['M','Toggle guide vocals mute'],['R','Toggle random mode'],['F','Fullscreen']].map(([k,v]) => (<><span key={k+'k'} style={{ fontFamily: 'monospace', background: 'var(--elevated)', padding: '1px 7px', borderRadius: 4, color: 'var(--amber)', whiteSpace: 'nowrap', alignSelf: 'start' }}>{k}</span><span key={k+'v'} style={{ color: 'var(--muted)' }}>{v}</span></>))}</div></div>
          <div className="success-box"><p style={{ fontWeight: 700, margin: '0 0 4px' }}><i className="ti ti-check" aria-hidden="true" /> Processing — server-side</p><p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>Vocal separation, transcription, and AI lyrics correction run via <code>/api/</code> endpoints. Keys in Vercel env vars.</p></div>
        </div>
      )}
    </div>
  );
}

// ── Archived songs panel (extracted from old SettingsScreen) ──────────────
function ArchivedSongsPanel({ onRestoreSongs }) {
  const [deletedSongs, setDeletedSongs]     = useState(null);
  const [loadingDeleted, setLoadingDeleted] = useState(false);
  const [selected, setSelected]             = useState([]);
  const [working, setWorking]               = useState(false);
  const [statusMsg, setStatusMsg]           = useState('');
  const allSelected = deletedSongs?.length > 0 && selected.length === deletedSongs.length;
  const anySelected = selected.length > 0;
  function toggleSelect(id) { setSelected(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]); }
  function toggleAll() { setSelected(allSelected ? [] : (deletedSongs || []).map(s => s.id)); }
  async function handleLoadDeleted() { setLoadingDeleted(true); setStatusMsg(''); const songs = await loadDeletedSongs(); setDeletedSongs(songs); setSelected([]); setLoadingDeleted(false); }
  async function handleRestore() {
    const toRestore = (deletedSongs || []).filter(s => selected.includes(s.id));
    if (!toRestore.length) return;
    setWorking(true); setStatusMsg('');
    const restored = await restoreDeletedSongs(toRestore);
    if (restored.length) { onRestoreSongs?.(restored); setDeletedSongs(p => p.filter(s => !selected.includes(s.id))); setSelected([]); setStatusMsg(`✓ Restored ${restored.length} song${restored.length !== 1 ? 's' : ''}`); }
    setWorking(false);
  }
  async function handlePurge() {
    const toPurge = (deletedSongs || []).filter(s => selected.includes(s.id));
    if (!toPurge.length) return;
    if (!window.confirm(`Permanently delete audio for ${toPurge.length} archived song${toPurge.length !== 1 ? 's' : ''}? Cannot be undone.`)) return;
    setWorking(true); setStatusMsg('');
    const toRemove = [];
    for (const song of toPurge) {
      const ap = song.audioUrl?.match(/\/storage\/v1\/object\/public\/songs\/(.+)$/)?.[1];
      const vp = song.vocalsUrl?.match(/\/storage\/v1\/object\/public\/songs\/(.+)$/)?.[1];
      if (ap) toRemove.push(decodeURIComponent(ap));
      if (vp) toRemove.push(decodeURIComponent(vp));
      toRemove.push(song._deletedPath || `deleted/${song.id}.json`);
    }
    if (toRemove.length) await supabase.storage.from('songs').remove(toRemove);
    setDeletedSongs(p => p.filter(s => !selected.includes(s.id)));
    setSelected([]); setStatusMsg(`✓ Purged ${toPurge.length} song${toPurge.length !== 1 ? 's' : ''}`); setWorking(false);
  }
  if (deletedSongs === null) return <button className="btn btn-secondary" onClick={handleLoadDeleted} disabled={loadingDeleted}>{loadingDeleted ? <><i className="ti ti-loader spin" style={{ fontSize: 13 }} aria-hidden="true" /> Loading…</> : <><i className="ti ti-archive" aria-hidden="true" /> View archived songs</>}</button>;
  if (deletedSongs.length === 0) return <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{statusMsg || 'No archived songs.'}</p>;
  return (
    <>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 8px', cursor: 'pointer', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ width: 15, height: 15, accentColor: 'var(--amber)', flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Select all ({deletedSongs.length})</span>
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12, maxHeight: 240, overflowY: 'auto' }}>
        {deletedSongs.map(s => (
          <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px', cursor: 'pointer', borderRadius: 4, background: selected.includes(s.id) ? 'rgba(244,168,39,0.05)' : 'transparent' }}>
            <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggleSelect(s.id)} style={{ width: 15, height: 15, accentColor: 'var(--amber)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</p>
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>{s.artist || 'Unknown'}{s._deletedAt ? ` · ${new Date(s._deletedAt).toLocaleDateString()}` : ''}</p>
            </div>
            <span style={{ fontSize: 10, color: s.audioUrl ? 'var(--muted)' : 'var(--rose)', flexShrink: 0 }}>{s.audioUrl ? '♪' : '○'}</span>
          </label>
        ))}
      </div>
      {statusMsg && <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 8px' }}>{statusMsg}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary" onClick={handleRestore} disabled={!anySelected || working} style={{ flex: 1, fontSize: 12 }}><i className="ti ti-restore" aria-hidden="true" /> Restore{anySelected ? ` (${selected.length})` : ''}</button>
        <button className="btn btn-secondary" onClick={handlePurge} disabled={!anySelected || working} style={{ flex: 1, fontSize: 12, color: anySelected ? 'var(--rose)' : undefined, borderColor: anySelected ? 'var(--rose)' : undefined }}><i className="ti ti-trash" aria-hidden="true" /> Purge{anySelected ? ` (${selected.length})` : ''}</button>
      </div>
    </>
  );
}


// ── QUEUE SCREEN ──────────────────────────────────────────────────────────────
function QueueArrow({ direction, disabled, onPress }) {
  return (
    <button
      onClick={disabled ? undefined : onPress}
      disabled={disabled}
      aria-label={direction === 'up' ? 'Move up' : 'Move down'}
      style={{
        width: 36, height: 36,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'none',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 8,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.2 : 0.7,
        color: 'inherit', flexShrink: 0,
        transition: 'opacity 0.12s, background 0.12s',
      }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; } }}
      onMouseLeave={e => { if (!disabled) { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.background = 'none'; } }}
    >
      <i className={`ti ${direction === 'up' ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize: 15 }} aria-hidden="true" />
    </button>
  );
}

function QueueScreen({ queue, currentSong, onPlay, onRemove, onMoveUp, onMoveDown, onShuffle, onClear, onGoToLibrary, onCancelCurrent }) {
  const hasQueue    = queue.length > 0;
  const canPlay     = hasQueue && !currentSong;

  return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div className="page-header" style={{ flexShrink: 0 }}>
        <div>
          <img src="/KaraKlasLogo.png" alt="KaraKlas" style={{ width: '100%', height: 'auto', display: 'block', marginBottom: 2, maxWidth: 312 }} />
          <div className="page-sub" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: 1 }}>
            Queue{hasQueue ? ` · ${queue.length} song${queue.length !== 1 ? 's' : ''} up next` : ''}
          </div>
        </div>
      </div>

      {/* Now Playing */}
      {currentSong && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '10px 8px 12px 18px', background: 'rgba(244,168,39,0.06)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, color: 'var(--amber)', marginBottom: 3 }}>♪ Now Playing</div>
            <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentSong.title}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentSong.artist || 'Unknown artist'}</div>
          </div>
          {onCancelCurrent && (
            <button
              onClick={onCancelCurrent}
              aria-label="Cancel current song"
              title="Cancel song"
              style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, cursor: 'pointer', opacity: 0.6, color: 'inherit', flexShrink: 0 }}
            >
              <i className="ti ti-x" style={{ fontSize: 14 }} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {/* Queue list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {hasQueue ? (
          <div style={{ padding: '8px 0' }}>
            {queue.map((song, i) => (
              <div
                key={`${song.id}-${i}`}
                style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 4px 18px', minHeight: 60, borderBottom: '1px solid var(--border)' }}
              >
                {/* Index */}
                <span style={{ fontSize: 12, color: 'var(--muted)', width: 20, flexShrink: 0, textAlign: 'right', marginRight: 12, fontVariantNumeric: 'tabular-nums' }}>
                  {i + 1}
                </span>
                {/* Song info */}
                <div style={{ flex: 1, minWidth: 0, marginRight: 4 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{song.title}</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{song.artist || 'Unknown artist'}</div>
                </div>
                {/* Controls — chips with borders, 4px gap */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <QueueArrow direction="up"   disabled={i === 0}                  onPress={() => onMoveUp(i)} />
                  <QueueArrow direction="down" disabled={i === queue.length - 1}   onPress={() => onMoveDown(i)} />
                  <button
                    onClick={() => onRemove(i)}
                    aria-label="Remove from queue"
                    style={{
                      width: 36, height: 36,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'none',
                      border: '1px solid rgba(255,255,255,0.14)',
                      borderRadius: 8,
                      cursor: 'pointer', opacity: 0.55, color: 'inherit', flexShrink: 0,
                      transition: 'opacity 0.12s, background 0.12s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '0.55'; e.currentTarget.style.background = 'none'; }}
                  >
                    <i className="ti ti-x" style={{ fontSize: 14 }} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Empty state */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 280, padding: '40px 32px', textAlign: 'center', gap: 12 }}>
            <div style={{ fontSize: 44 }}>🎤</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Queue is empty</div>
            <div style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 220, lineHeight: 1.5 }}>Tap any song in the Library to add it here</div>
            <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={onGoToLibrary}>Go to Library →</button>
          </div>
        )}
      </div>

      {/* Footer actions */}
      {hasQueue && (
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexShrink: 0 }}>
          {canPlay && (
            <button className="btn btn-primary" style={{ flex: 1, gap: 6 }} onClick={onPlay}>
              <i className="ti ti-player-play" aria-hidden="true" /> Play
            </button>
          )}
          <button className="btn btn-secondary" style={{ flex: canPlay ? '0 0 auto' : 1 }} onClick={onShuffle} title="Shuffle queue">
            <i className="ti ti-arrows-shuffle" aria-hidden="true" /> Shuffle
          </button>
          <button className="btn btn-secondary" style={{ flex: '0 0 auto', color: 'var(--muted)' }} onClick={onClear} title="Clear queue">
            Clear
          </button>
        </div>
      )}
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
  const [settings, setSettings]     = useState(() => ({ defaultGuideVolume: 0, autoPlayRandom: false, masterVolume: 1, showHidden: false, ...loadSettings() }));
  const [isDesktop, setIsDesktop]   = useState(() => window.innerWidth >= 900);

  // ── Processing queue ────────────────────────────────────────────────────
  const [queue, setQueue]         = useState(() => { const p = loadPersistedQueue(); return p; });
  const [queueRunning, setQueueRunning] = useState(false);
  const queueRef                  = useRef(loadPersistedQueue());
  const queueActiveRef            = useRef(false);

  // ── Performance queue ────────────────────────────────────────────────────
  const [perfQueue, setPerfQueue] = useState(() => loadPerfQueue());

  function updateQueueItem(qid, patch) {
    const isFinished = patch.status === 'done' || patch.status === 'failed';
    const withTs = isFinished && !patch.completedAt ? { ...patch, completedAt: Date.now() } : patch;
    queueRef.current = queueRef.current.map(i => i.qid === qid ? { ...i, ...withTs } : i);
    setQueue([...queueRef.current]);
    if (isFinished) persistQueue(queueRef.current);
  }
  function addToQueue({ file, title, artist }) {
    const item = { qid: uid(), file, title, artist, status: 'waiting', stageMsg: 'Waiting…', error: null };
    queueRef.current = [...queueRef.current, item];
    setQueue([...queueRef.current]);
    // Does NOT auto-start — user clicks "Process" explicitly
  }
  function removeFromQueue(qid) {
    queueRef.current = queueRef.current.filter(i => i.qid !== qid);
    setQueue([...queueRef.current]);
  }
  function startQueue() {
    if (queueActiveRef.current || !queueRef.current.some(i => i.status === 'waiting')) return;
    runQueueLoop();
  }
  async function runQueueLoop() {
    queueActiveRef.current = true;
    setQueueRunning(true);
    while (true) {
      const next = queueRef.current.find(i => i.status === 'waiting');
      if (!next) break;
      updateQueueItem(next.qid, { status: 'processing', stageMsg: 'Starting…' });
      try {
        const result = await processSong(
          { file: next.file, title: next.title, artist: next.artist },
          step => {
            const labels = { upload: 'Uploading…', demucs: 'Separating vocals…', whisper: 'Transcribing…', claude: 'Correcting lyrics…' };
            updateQueueItem(next.qid, { stageMsg: labels[step] || 'Processing…' });
          }
        );
        if (result) {
          const slug = makeSongSlug(next.title, next.artist);
          const newId = uid();
          const libraryPath = `${LIBRARY_ROOT}/${slug}_${newId}.json`;
          const song = { id: newId, title: next.title, artist: next.artist, addedAt: Date.now(), tags: [], _libraryPath: libraryPath, audioUrl: result.instrumentalUrl, vocalsUrl: result.vocalsUrl, hasAudio: !!result.instrumentalUrl, lyrics: result.lyrics, lyricsAlt: result.lyricsAlt, lyricsType: result.lyricsType, lyricsSource: 'primary', plainLyrics: '' };
          setSongs(prev => [song, ...prev]);
          const stored = await saveSongData(song);
          if (stored) setSongs(prev => prev.map(x => x.id === song.id ? stored : x));
          updateQueueItem(next.qid, { status: 'done', stageMsg: '✓ Added to library' });
        } else {
          updateQueueItem(next.qid, { status: 'failed', stageMsg: 'Cancelled' });
        }
      } catch (e) {
        updateQueueItem(next.qid, { status: 'failed', stageMsg: 'Failed', error: e.message });
      }
      await sleep(300);
    }
    queueActiveRef.current = false;
    setQueueRunning(false);
  }

  // ── Performance queue functions ──────────────────────────────────────────
  // Persist whenever perfQueue changes
  useEffect(() => { savePerfQueue(perfQueue); }, [perfQueue]);

  // ── Blob pre-fetch for next queued song ─────────────────────────────────────
  // Fetch the next song's audio files completely while the current song plays.
  // Result is a blob: URL — local memory, no CDN involved during playback.
  // This eliminates the connection-pool / Cloudflare issues that caused songs 3+
  // to stall: by the time the song needs to play, the data is already here.
  const blobCache = useRef({}); // { [songId]: 'loading' | { audioUrl, vocalsUrl } }

  useEffect(() => {
    const song = perfQueue[0];
    if (!song?.audioUrl || blobCache.current[song.id]) return; // nothing to do

    let active = true;
    blobCache.current[song.id] = 'loading';

    const toBlob = url => url
      ? fetch(url)
          .then(r => r.ok ? r.blob() : null)
          .then(b => (b && active) ? URL.createObjectURL(b) : url)
          .catch(() => url) // fall back to original URL on any network error
      : Promise.resolve(url);

    Promise.all([toBlob(song.audioUrl), toBlob(song.vocalsUrl)])
      .then(([audioUrl, vocalsUrl]) => {
        if (active) blobCache.current[song.id] = { audioUrl, vocalsUrl };
      });

    return () => { active = false; };
  }, [perfQueue[0]?.id ?? '']); // eslint-disable-line

  // Revoke blob URLs for the previous song once it's no longer active
  const prevActiveSongIdRef = useRef(null);
  useEffect(() => {
    const prevId = prevActiveSongIdRef.current;
    if (prevId) {
      const cached = blobCache.current[prevId];
      if (cached && cached !== 'loading') {
        if (cached.audioUrl?.startsWith('blob:'))  URL.revokeObjectURL(cached.audioUrl);
        if (cached.vocalsUrl?.startsWith('blob:')) URL.revokeObjectURL(cached.vocalsUrl);
      }
      delete blobCache.current[prevId];
    }
    prevActiveSongIdRef.current = activeSong?.id ?? null;
  }, [activeSong?.id ?? '']); // eslint-disable-line

  function perfQueueAddFront(song) { setPerfQueue(q => { const next = [song, ...q]; return next; }); }
  function perfQueueAddEnd(song)   { setPerfQueue(q => [...q, song]); }
  function perfQueueRemove(i)      { setPerfQueue(q => q.filter((_, idx) => idx !== i)); }
  function perfQueueMove(from, to) {
    setPerfQueue(q => {
      const next = [...q];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }
  function perfQueueShuffle() {
    setPerfQueue(q => {
      const next = [...q];
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      return next;
    });
  }
  function perfQueueClear()   { setPerfQueue([]); }
  /** Start playing the first song in the performance queue */
  function playFromPerfQueue() {
    if (perfQueue.length === 0) return;
    const next = perfQueue[0];
    // Use pre-fetched blob URLs if ready — bypasses CDN entirely for playback.
    // Falls back to direct Supabase URLs if blob isn't ready yet (first song, rapid skip).
    const cached = blobCache.current[next.id];
    const ready  = cached && cached !== 'loading';
    const songToPlay = ready
      ? { ...next, audioUrl: cached.audioUrl ?? next.audioUrl, vocalsUrl: cached.vocalsUrl ?? next.vocalsUrl }
      : next;
    setPerfQueue(q => q.slice(1));
    navigateToSong(songToPlay);
  }

  const shouldAutoPlayRef = useRef(false);
  const songHistoryRef    = useRef([]);

  useEffect(() => { loadLibrary().then(loaded => { setSongs(loaded); setLoading(false); }); }, []);
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 900);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  useEffect(() => { if (randomMode && activeSong && songs.length > 1) setNextUpSong(pickRandomSong(songs, activeSong.id)); else if (!randomMode) setNextUpSong(null); }, [randomMode, activeSong?.id, songs.length]);

  function navigateToSong(s) { if (activeSong) songHistoryRef.current = [...songHistoryRef.current.slice(-19), activeSong]; shouldAutoPlayRef.current = true; setActiveSong(s); }
  function handlePlaySong(s) { if (activeSong) songHistoryRef.current = [...songHistoryRef.current.slice(-19), activeSong]; shouldAutoPlayRef.current = false; if (randomMode) stopRandomMode(); setActiveSong(s); }
  function navigateToPrevious() { const prev = songHistoryRef.current[songHistoryRef.current.length - 1]; if (!prev) return; songHistoryRef.current = songHistoryRef.current.slice(0, -1); shouldAutoPlayRef.current = true; setActiveSong(prev); }
  function handleSongEnd() {
    // Performance queue takes priority — auto-advance to next queued song
    if (perfQueue.length > 0) { playFromPerfQueue(); return; }
    if (randomMode) { const next = nextUpSong || pickRandomSong(songs, activeSong?.id); if (next) { navigateToSong(next); return; } } if (settings.autoPlayRandom && songs.length > 1) { const next = pickRandomSong(songs, activeSong?.id); if (next) { navigateToSong(next); return; } } shouldAutoPlayRef.current = false; }
  function startRandomMode() { const first = pickRandomSong(songs, activeSong?.id); if (!first) return; setRandomMode(true); navigateToSong(first); }
  function stopRandomMode()  { setRandomMode(false); setNextUpSong(null); }
  function skipToNextRandom() { const next = nextUpSong || pickRandomSong(songs, activeSong?.id); if (next) navigateToSong(next); }
  function handleSettingsChange(patch) { const u = { ...settings, ...patch }; setSettings(u); persistSettings(u); }
  async function handleAddSong(song)   { const s = { ...song, addedAt: Date.now() }; setSongs(prev => [s, ...prev]); setTab('library'); const stored = await saveSongData(s); if (stored) setSongs(prev => prev.map(x => x.id === s.id ? stored : x)); }
  function handleRestoreSongs(restored) { setSongs(prev => { const ids = new Set(restored.map(s => s.id)); return [...restored, ...prev.filter(s => !ids.has(s.id))].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)); }); }
  async function handleSaveEdited(s)   { setSongs(prev => prev.map(x => x.id === s.id ? { ...x, ...s } : x)); setEditingSong(null); await saveSongData(s); }
  async function handleDeleteSong(song) { setSongs(prev => prev.filter(s => s.id !== song.id)); await archiveDeletedSong(song); }
  async function handleToggleFavourite(song) {
    const tags = song.tags || [];
    const isFav = tags.includes('favourite');
    const newTags = isFav ? tags.filter(t => t !== 'favourite') : [...tags, 'favourite'];
    const updated = { ...song, tags: newTags };
    setSongs(prev => prev.map(s => s.id === song.id ? updated : s));
    await saveSongData(updated);
  }

  if (editingSong) return (
    <div className={`app-shell${isDesktop ? ' app-shell--wide' : ''}`}>
      <EditorScreen song={editingSong} onSave={handleSaveEdited} onBack={() => setEditingSong(null)} onDelete={song => { handleDeleteSong(song); setEditingSong(null); }} />
    </div>
  );

  const settingsProps = { settings, onSettingsChange: handleSettingsChange, onRestoreSongs: handleRestoreSongs, songs, onAddSong: handleAddSong, queue, queueRunning, onAddToQueue: addToQueue, onRemoveFromQueue: removeFromQueue, onStartQueue: startQueue };
  // Proper reload: pre-warm CDN connections then fully remount the PlayerScreen.
  // This gives a completely fresh <audio> element and a new CDN request, unlike
  // audio.load() which reuses the same element in the same (potentially broken) state.
  function handleReloadSong() {
    const song = activeSong;
    if (!song) return;
    // Look up the canonical song from the library to get original Supabase URLs.
    // activeSong.audioUrl may be a revoked blob: URL if it was played from the pre-fetch
    // cache — using the original URLs ensures the reload always works.
    const canonical = songs.find(s => s.id === song.id) || song;
    const reloadSong = { ...song, audioUrl: canonical.audioUrl, vocalsUrl: canonical.vocalsUrl };
    // Fire HEAD requests to establish fresh Cloudflare connections before remounting.
    if (canonical.audioUrl?.startsWith('http'))  fetch(canonical.audioUrl,  { method: 'HEAD' }).catch(() => {});
    if (canonical.vocalsUrl?.startsWith('http')) fetch(canonical.vocalsUrl, { method: 'HEAD' }).catch(() => {});
    shouldAutoPlayRef.current = true;
    setTimeout(() => {
      setActiveSong(null);                                    // unmount PlayerScreen
      setTimeout(() => setActiveSong(reloadSong), 80);       // remount with clean URLs
    }, 200); // 200ms head-start for CDN pre-warm
  }

  const playerProps   = { song: activeSong, settings, autoPlay: shouldAutoPlayRef.current, randomMode, nextUpSong, nextQueuedSong: perfQueue[0] || null, hasNext: perfQueue.length > 0 || randomMode, onBack: () => { stopRandomMode(); setActiveSong(null); }, onSongEnd: handleSongEnd, onReload: handleReloadSong, onStartRandom: startRandomMode, onStopRandom: stopRandomMode, onSkipRandom: skipToNextRandom, onGoToPrevious: navigateToPrevious };

  const libraryView  = <LibraryScreen songs={songs} onAddToQueueFront={perfQueueAddFront} onAddToQueueEnd={perfQueueAddEnd} onEdit={setEditingSong} onStartRandom={startRandomMode} onToggleFavourite={handleToggleFavourite} showHidden={settings.showHidden ?? false} />;
  const settingsView = <SettingsScreen {...settingsProps} />;
  const queueView    = (
    <QueueScreen
      queue={perfQueue}
      currentSong={activeSong}
      onPlay={playFromPerfQueue}
      onRemove={perfQueueRemove}
      onMoveUp={i => perfQueueMove(i, i - 1)}
      onMoveDown={i => perfQueueMove(i, i + 1)}
      onShuffle={perfQueueShuffle}
      onClear={perfQueueClear}
      onGoToLibrary={() => setTab('library')}
      onCancelCurrent={() => { if (perfQueue.length > 0 || randomMode) { handleSongEnd(); } else { stopRandomMode(); setActiveSong(null); } }}
    />
  );

  // Desktop two-column layout
  if (isDesktop) return (
    <div className="app-desktop">
      <aside className="app-sidebar">
        {loading
          ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--muted)' }}><i className="ti ti-loader spin" style={{ fontSize: 22 }} aria-hidden="true" /> Loading…</div>
          : <>
              {tab === 'library'  ? libraryView  : null}
              {tab === 'queue'    ? queueView    : null}
              {tab === 'settings' ? settingsView : null}
            </>
        }
        <nav className="desktop-nav">
          <button className={`desktop-nav-btn${tab === 'library' ? ' active' : ''}`} onClick={() => setTab('library')}><i className="ti ti-playlist" aria-hidden="true" /><span>Library</span></button>
          <button className={`desktop-nav-btn${tab === 'queue' ? ' active' : ''}`} onClick={() => setTab('queue')} style={{ position: 'relative' }}>
            <i className="ti ti-list" aria-hidden="true" />
            <span>Queue</span>
            {perfQueue.length > 0 && (
              <span className="nav-badge" style={{ top: 6, right: 6 }}>
                {perfQueue.length > 99 ? '99+' : perfQueue.length}
              </span>
            )}
          </button>
          <button className={`desktop-nav-btn${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}><i className="ti ti-settings" aria-hidden="true" /><span>Settings</span></button>
        </nav>
      </aside>
      <main className="app-main">
        {activeSong
          ? <PlayerScreen key={activeSong.id} {...playerProps} />
          : <div className="desktop-empty" style={{ opacity: 1 }}><img src="/KaraKlasLogo.png" alt="KaraKlas" style={{ width: 'min(900px, 80%)', maxHeight: '40vh', height: 'auto', objectFit: 'contain' }} /><p style={{ opacity: 0.4 }}>Select a song to start</p></div>
        }
      </main>
    </div>
  );

  // Mobile layout
  if (activeSong) return (
    <div className="app-shell app-shell--player">
      <PlayerScreen key={activeSong.id} {...playerProps} />
    </div>
  );
  return (
    <div className="app-shell">
      {loading
        ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--muted)' }}><i className="ti ti-loader spin" style={{ fontSize: 22 }} aria-hidden="true" /> Loading…</div>
        : <>
            {tab === 'library'  && libraryView}
            {tab === 'queue'    && queueView}
            {tab === 'settings' && settingsView}
            <nav className="bottom-nav">
              <button className={`nav-btn${tab === 'library' ? ' active' : ''}`} onClick={() => setTab('library')}><i className="ti ti-playlist" aria-hidden="true" /> Library</button>
              <button className={`nav-btn${tab === 'queue' ? ' active' : ''}`} onClick={() => setTab('queue')} style={{ position: 'relative' }}>
                <i className="ti ti-list" aria-hidden="true" /> Queue
                {perfQueue.length > 0 && (
                  <span className="nav-badge" style={{ top: 4, left: '50%', transform: 'translateX(14px)' }}>
                    {perfQueue.length > 99 ? '99+' : perfQueue.length}
                  </span>
                )}
              </button>
              <button className={`nav-btn${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}><i className="ti ti-settings" aria-hidden="true" /> Settings</button>
            </nav>
          </>
      }
    </div>
  );
}
