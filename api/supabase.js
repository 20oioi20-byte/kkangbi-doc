// api/supabase.js — Supabase REST 프록시 (CORS 해결용)
// Vercel 환경변수: SUPABASE_URL, SUPABASE_ANON_KEY

export default async function handler(req, res) {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL      = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase 환경변수 미설정' });
  }

  const { method = 'GET', table, query = '', body } = req.body || {};
  if (!table) return res.status(400).json({ error: 'table 필수' });

  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;

  const headers = {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    'Prefer':        'return=representation',
  };

  try {
    const fetchOpts = { method, headers };
    if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
      fetchOpts.body = JSON.stringify(body);
    }

    const r = await fetch(url, fetchOpts);
    const text = await r.text();

    // 응답이 비어있는 경우 (DELETE 등)
    if (!text) return res.status(r.status).end();

    try {
      const data = JSON.parse(text);
      return res.status(r.status).json(data);
    } catch {
      return res.status(r.status).send(text);
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
