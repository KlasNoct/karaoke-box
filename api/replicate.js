// Vercel serverless proxy — all Replicate API calls go through here.
// Your API key lives in REPLICATE_API_TOKEN env var, never in the browser.

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' }, // audio is now uploaded via Supabase, so payloads are tiny
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
      error: 'REPLICATE_API_TOKEN is not set in Vercel environment variables.',
    });
  }

  const { action, model, version, input, id } = req.body || {};

  try {
    // ── Create a prediction ──────────────────────────────────────────────────
    // If a version hash is supplied, use /v1/predictions (works for all models).
    // Otherwise fall back to /v1/models/{owner}/{name}/predictions.
    if (action === 'create') {
      const url = version
        ? 'https://api.replicate.com/v1/predictions'
        : `https://api.replicate.com/v1/models/${model}/predictions`;

      const body = version ? { version, input } : { input };

      const r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = await r.json();
      if (!r.ok) {
        return res.status(r.status).json({
          error: data?.detail || data?.error || JSON.stringify(data),
        });
      }
      return res.json({ id: data.id, status: data.status });
    }

    // ── Poll an existing prediction ──────────────────────────────────────────
    if (action === 'poll') {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
        headers: { Authorization: `Token ${key}` },
      });
      const data = await r.json();
      if (!r.ok) {
        return res.status(r.status).json({
          error: data?.detail || data?.error || JSON.stringify(data),
        });
      }
      return res.json({
        status: data.status,
        output: data.output,
        error: data.error,
        logs: data.logs,
      });
    }

    return res.status(400).json({ error: `Unknown action: "${action}"` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
