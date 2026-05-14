// Vercel serverless function — proxies all Replicate API calls.
// Your API key lives here in the server environment, never in the browser.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '30mb', // allows audio files up to ~20MB as base64
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.REPLICATE_API_TOKEN;
  if (!key) {
    return res.status(500).json({
      error: 'REPLICATE_API_TOKEN is not set. Add it in Vercel → Project Settings → Environment Variables.',
    });
  }

  const { action, model, input, id } = req.body || {};

  try {
    // ── Create a new prediction ──────────────────────────────────────────
    if (action === 'create') {
      const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data?.detail || JSON.stringify(data) });
      return res.json({ id: data.id, status: data.status });
    }

    // ── Poll an existing prediction ──────────────────────────────────────
    if (action === 'poll') {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
        headers: { Authorization: `Token ${key}` },
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data?.detail || JSON.stringify(data) });
      return res.json({
        status: data.status,
        output: data.output,
        error: data.error,
        logs: data.logs,
      });
    }

    return res.status(400).json({ error: `Unknown action: "${action}". Expected "create" or "poll".` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
