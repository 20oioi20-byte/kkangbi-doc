// api/supabase.js — Supabase REST API 프록시
// 브라우저 CORS 문제 없이 서버에서 Supabase 직접 호출

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    const { method, table, query = '', body } = req.body || {};
    const url = `${SB_URL}/rest/v1/${table}${query ? '?' + query : ''}`;

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Prefer': 'return=representation'
    };

    const fetchOpts = { method: method || 'GET', headers };
    if (body && method !== 'GET') fetchOpts.body = JSON.stringify(body);

    const response = await fetch(url, fetchOpts);
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
