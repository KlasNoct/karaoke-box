# 🎤 Karaoke Box

Personal karaoke app — add any song, auto-remove vocals, auto-transcribe lyrics.

## Deploy to Vercel (5 minutes)

### 1. Put the code on GitHub
1. Go to github.com → New repository → name it `karaoke-box` → Create
2. Upload these files (drag & drop the folder, or use GitHub Desktop)

### 2. Deploy on Vercel
1. Go to vercel.com → Add New Project → Import your `karaoke-box` repo
2. Framework: leave as "Other" (Vercel detects Vite automatically)
3. Click Deploy — first deploy will succeed but Replicate won't work yet

### 3. Add your Replicate API key (critical!)
1. In Vercel: go to your project → Settings → Environment Variables
2. Add:  `REPLICATE_API_TOKEN` = your key from replicate.com/account/api-tokens
3. Go to Deployments → click the three dots on the latest → Redeploy

That's it. Your app is live and Replicate works.

## Local development

```bash
npm install
# Create .env.local with:
# REPLICATE_API_TOKEN=r8_...
npx vercel dev   # runs both Vite + the /api functions locally
```

## How it works

- **Auto mode**: upload original song → Demucs removes vocals → Whisper transcribes lyrics → synced karaoke player
- **LRClib first**: if synced lyrics are found for free, Whisper is skipped (saves credits)
- **Manual mode**: upload your own instrumental + paste lyrics
- **~€0.10–0.40 per song** via Replicate

## Architecture

```
Browser → /api/replicate (Vercel function) → Replicate API
                                          → cjwbw/demucs  (vocal removal)
                                          → openai/whisper (transcription)
```

The Replicate API key lives in Vercel env vars. It is never sent to the browser.

## Coming next
- v1.2: Supabase cloud storage (persistent library across devices)
- v1.3: Lyrics editor with manual timing correction
- v1.4: Pitch / key shift + mic reverb
- v1.5: Genius lyrics source
