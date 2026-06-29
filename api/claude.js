// api/claude.js — Claude API 프록시 + MHT 파싱 (Kaoni 공문서 / 제목+본문만 추출)
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

  if (body.type === 'parse_mht') {
    try {
      const result = parseMHT(body.content || '');
      // result가 {clean, style} 객체이거나 이전 버전 string일 수 있음
      const clean = typeof result === 'string' ? result : result.clean;
      const style = typeof result === 'object' ? result.style : null;
      return res.status(200).json({ clean, style });
    } catch (e) {
      return res.status(500).json({ error: 'MHT 파싱 실패: ' + e.message });
    }
  }

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

// ── MHT 파싱 ──────────────────────────────────────────────────
function parseMHT(raw) {
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  const boundary = boundaryMatch ? boundaryMatch[1].trim() : null;

  let htmlContent = '';

  if (boundary) {
    const parts = raw.split(new RegExp('--' + escapeRegex(boundary)));
    for (const part of parts) {
      if (!/Content-Type:\s*text\/html/i.test(part)) continue;
      const bodyStart = part.search(/\r?\n\r?\n/);
      if (bodyStart === -1) continue;
      const partHeader = part.slice(0, bodyStart);
      const partBody   = part.slice(bodyStart).trim();

      if (/Content-Transfer-Encoding:\s*base64/i.test(partHeader)) {
        try {
          htmlContent = Buffer.from(partBody.replace(/\s/g, ''), 'base64').toString('utf-8');
        } catch(e) { htmlContent = partBody; }
      } else if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(partHeader)) {
        htmlContent = decodeQP(partBody);
      } else {
        htmlContent = partBody;
      }
      break;
    }
  }

  if (!htmlContent) htmlContent = decodeQP(raw);

  const { text, style } = extractDocContent(htmlContent);
  return { clean: text.slice(0, 5000), style };
}

// ── Kaoni 공문서 핵심 추출: 제목 + 본문만 ──────────────────
function extractDocContent(html) {
  // 스타일 추출 (폰트/크기/줄간격)
  const fontMatch  = html.match(/FONT-SIZE:\s*(\d+pt)/i);
  const familyMatch= html.match(/FONT-FAMILY:\s*['"]*([^'";,]+)/i);
  const lhMatch    = html.match(/line-height\s*:\s*(\d+(?:\.\d+)?)/i);
  const docStyle = {
    fontSize:   fontMatch   ? fontMatch[1]               : '12pt',
    fontFamily: familyMatch ? familyMatch[1].replace(/&quot;/g,'').trim() : '맑은 고딕',
    lineHeight: lhMatch     ? (parseFloat(lhMatch[1]) * 100) + '%' : '200%',
  };
  html = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<img[^>]*>/gi, '');

  // ── 1. 제목 추출 (FIELD 제거 전에 먼저) ──
  // Kaoni: id="doctitle" 또는 "제 목 :" 다음 셀
  let titleText = '';
  const doctitleMatch = html.match(/id="doctitle"[^>]*>([\s\S]*?)<\/td>/i);
  if (doctitleMatch) {
    titleText = htmlToPlain(doctitleMatch[1]).trim();
  } else {
    // fallback: "제 목 :" 텍스트 다음 TD
    const titleRowMatch = html.match(/제\s*목\s*[：:][^<]*<\/[^>]+>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    if (titleRowMatch) titleText = htmlToPlain(titleRowMatch[1]).trim();
  }

  // ── 2. 헤더 메타정보 제거 ──
  // FIELD 클래스 셀 (문서번호, 결재란 등)
  html = html.replace(/<td[^>]*class="FIELD"[^>]*>[\s\S]*?<\/td>/gi, '<td></td>');
  // 결재/협조 테이블 (기안자, 팀장, 단장 등 키워드가 있는 행 전체)
  html = html.replace(/<tr[^>]*>[\s\S]*?(?:기안자?|결\s*재|협\s*조|보안등급|생산부서|보존기간)[\s\S]*?<\/tr>/gi, '');

  // ── 3. 제목 이후 본문 추출 ──
  const titlePos = html.search(/제\s*목\s*[：:]/i);
  const bodyHtml = titlePos > 0 ? html.slice(titlePos) : html;

  // ── 4. 표 → [TABLE] 변환 ──
  const structured = htmlToStructuredText(bodyHtml);

  // ── 5. 노이즈 라인 필터링 ──
  const lines = structured.split('\n');
  const cleaned = lines.filter(line => {
    const t = line.trim();
    if (!t) return true;
    if (/^\d{2}\.\d{2}\s*\|?\s*$/.test(t)) return false;       // "06.02" 같은 짧은 날짜
    if (/^[\|\s]+$/.test(t)) return false;                      // | 만 있는 줄
    if (/^(\|\s*){2,}$/.test(t)) return false;                  // 빈 셀 연속
    if (/^제\s*목\s*[：:]/.test(t)) return false;               // "제 목 :" 레이블 줄
    return true;
  });

  const bodyText = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const text = (titleText ? '제목: ' + titleText + '\n\n' : '') + bodyText;
  return { text, style: docStyle };
}

// ── HTML → 표 구조 보존 텍스트 ──────────────────────────────
function htmlToStructuredText(html) {
  let tableIdx = 0;
  html = html.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    tableIdx++;
    const rows = [];
    const trMatches = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (const tr of trMatches) {
      const cells = [];
      const cellMatches = tr.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
      for (const cell of cellMatches) {
        cells.push(htmlToPlain(cell).replace(/\s+/g, ' ').trim());
      }
      const nonEmpty = cells.filter(c => c);
      if (nonEmpty.length >= 2) rows.push(cells.join('|'));
    }
    if (!rows.length) return '';
    if (rows.length > 1) {
      return `\n[TABLE:표${tableIdx}]\n${rows.join('\n')}\n[/TABLE]\n`;
    }
    return '\n' + rows.join('\n') + '\n';
  });

  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToPlain(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeQP(str) {
  const joined = str.replace(/=\r?\n/g, '');
  let result = ''; let i = 0;
  while (i < joined.length) {
    if (joined[i] === '=' && i + 2 < joined.length && /[0-9A-Fa-f]{2}/.test(joined.slice(i+1, i+3))) {
      const bytes = [];
      while (i < joined.length && joined[i] === '=' && /[0-9A-Fa-f]{2}/.test(joined.slice(i+1, i+3))) {
        bytes.push(parseInt(joined.slice(i+1, i+3), 16));
        i += 3;
      }
      try { result += Buffer.from(bytes).toString('utf-8'); }
      catch(e) { result += bytes.map(b => String.fromCharCode(b)).join(''); }
    } else { result += joined[i]; i++; }
  }
  return result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
