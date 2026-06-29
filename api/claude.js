// api/claude.js — Claude API 프록시 + MHT Base64/QP 서버사이드 파싱
// Vercel 환경변수: ANTHROPIC_API_KEY

export default async function handler(req, res) {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수 미설정' });
  }

  const body = req.body || {};

  // ── MHT 파싱 모드 ──────────────────────────────────────────
  if (body.type === 'parse_mht') {
    try {
      const raw = body.content || '';
      const clean = parseMHT(raw);
      return res.status(200).json({ clean });
    } catch (e) {
      return res.status(500).json({ error: 'MHT 파싱 실패: ' + e.message });
    }
  }

  // ── Claude API 프록시 모드 ──────────────────────────────────
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            ANTHROPIC_API_KEY,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify({
        model:      body.model      || 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 4000,
        system:     body.system,
        messages:   body.messages,
        tools:      body.tools,
      }),
    });

    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── MHT 파싱 유틸 ──────────────────────────────────────────────
function parseMHT(raw) {
  // Quoted-Printable 디코딩
  let decoded = raw
    .replace(/=\r?\n/g, '')                                  // 소프트 줄바꿈 제거
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))                   // QP 이스케이프 → 문자
    );

  // Base64 인코딩된 파트 디코딩 시도
  const b64Match = decoded.match(/Content-Transfer-Encoding:\s*base64[\s\S]*?\n\n([\s\S]+?)(?=--|\n--)/i);
  if (b64Match) {
    try {
      const b64 = b64Match[1].replace(/\s/g, '');
      decoded = Buffer.from(b64, 'base64').toString('utf-8');
    } catch (e) { /* base64 디코딩 실패 시 QP 결과 사용 */ }
  }

  // HTML 태그 제거 → 순수 텍스트 추출
  const clean = decoded
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);                                         // Claude 토큰 절약

  return clean;
}
