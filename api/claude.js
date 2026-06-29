// api/claude.js — Claude API 프록시 + MHT 파싱 (Kaoni MHT / UTF-8 한글 지원)
// Vercel 환경변수: ANTHROPIC_API_KEY

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 미설정' });

  const body = req.body || {};

  // ── MHT 파싱 모드 ──────────────────────────────────────────
  if (body.type === 'parse_mht') {
    try {
      const clean = parseMHT(body.content || '');
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
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
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
  // 1단계: boundary 추출
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  const boundary = boundaryMatch ? boundaryMatch[1].trim() : null;

  let htmlContent = '';

  if (boundary) {
    // 2단계: MIME 파트 분리
    const parts = raw.split(new RegExp('--' + escapeRegex(boundary)));
    for (const part of parts) {
      if (!part.trim() || part.trim() === '--') continue;

      const isHtml = /Content-Type:\s*text\/html/i.test(part);
      if (!isHtml) continue;

      // 헤더/본문 분리 (빈 줄 기준)
      const bodyStart = part.search(/\r?\n\r?\n/);
      if (bodyStart === -1) continue;
      const partHeader = part.slice(0, bodyStart);
      const partBody   = part.slice(bodyStart).trim();

      const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(partHeader);
      const isQP     = /Content-Transfer-Encoding:\s*quoted-printable/i.test(partHeader);

      if (isBase64) {
        try {
          const b64 = partBody.replace(/\s/g, '');
          htmlContent = Buffer.from(b64, 'base64').toString('utf-8');
        } catch(e) { htmlContent = partBody; }
      } else if (isQP) {
        htmlContent = decodeQP(partBody);
      } else {
        // 인코딩 없음 — UTF-8 직접 포함
        htmlContent = partBody;
      }
      break;
    }
  }

  // boundary 없거나 HTML 파트 못 찾은 경우 → 전체 QP 디코딩
  if (!htmlContent) {
    htmlContent = decodeQP(raw);
  }

  // 3단계: HTML → 순수 텍스트
  return htmlToText(htmlContent).slice(0, 4000);
}

// QP 디코딩 — Latin-1 바이트열을 UTF-8로 변환 (한글 지원)
function decodeQP(str) {
  // 소프트 줄바꿈 제거
  const joined = str.replace(/=\r?\n/g, '');

  // =XX 시퀀스를 바이트 배열로 수집 후 Buffer로 UTF-8 디코딩
  // 연속된 =XX (멀티바이트 UTF-8) 처리
  let result = '';
  let i = 0;
  while (i < joined.length) {
    if (joined[i] === '=' && i + 2 < joined.length && /[0-9A-Fa-f]{2}/.test(joined.slice(i+1, i+3))) {
      // =XX 시퀀스 수집 (연속 멀티바이트 포함)
      const bytes = [];
      while (i < joined.length && joined[i] === '=' && /[0-9A-Fa-f]{2}/.test(joined.slice(i+1, i+3))) {
        bytes.push(parseInt(joined.slice(i+1, i+3), 16));
        i += 3;
      }
      try {
        result += Buffer.from(bytes).toString('utf-8');
      } catch(e) {
        result += bytes.map(b => String.fromCharCode(b)).join('');
      }
    } else {
      result += joined[i];
      i++;
    }
  }
  return result;
}

function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/th>/gi, ' | ')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/[ \t]+/g,  ' ')
    .replace(/\n{3,}/g,  '\n\n')
    .trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
