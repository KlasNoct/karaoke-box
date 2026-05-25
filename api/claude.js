// Proxies lyrics correction to Claude API using a minimal output format
// that reduces output tokens ~80%, staying within Vercel Hobby timeouts.
// Requires ANTHROPIC_API_KEY in Vercel environment variables.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { whisperWords, lrcLines } = req.body;
  if (!Array.isArray(whisperWords) || !Array.isArray(lrcLines)) {
    return res.status(400).json({ error: 'whisperWords and lrcLines must be arrays' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // Minimal output format reduces output tokens from ~5000 to ~1000.
  // App reconstructs full lyrics from this compact representation.
  const system = `You are a lyrics alignment assistant for a karaoke app.

INPUT:
- whisperWords: word timestamps from audio {word,start,end} — timing is accurate
- lrcLines: lyric lines {id,time,text,...} — text is correct

TASK: Map each LRClib line's words to WhisperX timestamps.

OUTPUT: compact JSON array only, no markdown, no explanation:
[{"id":"<id>","t":<time>,"w":[[start,end],[start,end],...]}]

Rules:
- "id" = lrcLine id exactly
- "t" = WhisperX start time of line's first matched word
- "w" = [start,end] pairs, one per word in lrcLine.text order
- Match by sound: "using"="usin'", "gonna"="going to" etc.
- No match: use original lrcLine.time and "w":[]
- Return ALL lrcLines in input order`;

  const userMsg = `whisperWords:${JSON.stringify(whisperWords)}
lrcLines:${JSON.stringify(lrcLines)}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Claude API: ${err}` });
    }

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message || 'Unknown error' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
