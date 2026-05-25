// Proxies lyrics correction requests to the Claude API.
// Requires ANTHROPIC_API_KEY in Vercel environment variables.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { whisperWords, lrcLines } = req.body;
  if (!Array.isArray(whisperWords) || !Array.isArray(lrcLines)) {
    return res.status(400).json({ error: 'whisperWords and lrcLines must be arrays' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel environment variables' });

  const system = `You are a lyrics alignment assistant for a karaoke app.

INPUT:
- whisperWords: word-level timestamps from WhisperX audio analysis {word,start,end} — timing is accurate, spelling may have errors
- lrcLines: lyric lines from LRClib {id,time,text,color,words} — text is correct, timing may be off

TASK: For each LRClib line, map its words to WhisperX timestamps.

RULES:
1. Keep each LRClib line text EXACTLY as-is (spelling, capitalisation, punctuation)
2. Use WhisperX start/end times for each word's timing
3. Match LRClib words to WhisperX words by sound: "using"="usin'", "gonna"="going to", etc.
4. Set each line's "time" to the WhisperX start time of its first matched word
5. If a line has no matching WhisperX words, keep original LRClib time and set words:[]
6. Preserve id and color from each LRClib line exactly
7. Return ONLY compact JSON — no markdown fences, no explanation, no extra whitespace`;

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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Claude API error: ${err}` });
    }

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message || 'Unknown Claude error' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
