// api/claude.js — Claude API 프록시 + MHT 파싱 (Kaoni 공문서 전용)
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
      return res.status(200).json(result);
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

// ── MHT 파싱 메인 ──────────────────────────────────────────────
function parseMHT(raw) {
  // 1. HTML 파트 추출
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  const boundary = boundaryMatch ? boundaryMatch[1].trim() : null;
  let html = '';

  if (boundary) {
    const parts = raw.split(new RegExp('--' + escRx(boundary)));
    for (const part of parts) {
      if (!/Content-Type:\s*text\/html/i.test(part)) continue;
      const bs = part.search(/\r?\n\r?\n/);
      if (bs === -1) continue;
      const partHeader = part.slice(0, bs);
      const partBody   = part.slice(bs).trim();
      if (/Content-Transfer-Encoding:\s*base64/i.test(partHeader)) {
        try { html = Buffer.from(partBody.replace(/\s/g, ''), 'base64').toString('utf-8'); }
        catch(e) { html = partBody; }
      } else if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(partHeader)) {
        html = decodeQP(partBody);
      } else {
        html = partBody;
      }
      break;
    }
  }
  if (!html) html = decodeQP(raw);

  // 2. 스타일 추출
  const fontMatch   = html.match(/FONT-SIZE:\s*(\d+pt)/i);
  const familyMatch = html.match(/FONT-FAMILY:\s*['"&quot;]*([^'";,&<]+)/i);
  const lhMatch     = html.match(/LINE-HEIGHT:\s*(\d+(?:\.\d+)?)[^%]/i);
  const style = {
    fontSize:   fontMatch   ? fontMatch[1]                           : '12pt',
    fontFamily: familyMatch ? familyMatch[1].replace(/&quot;/g,'').trim() : '맑은 고딕',
    lineHeight: lhMatch     ? (parseFloat(lhMatch[1]) * 100) + '%'  : '200%',
  };

  // 3. 제목 추출 (id="doctitle" — FIELD 제거 전에)
  let title = '';
  const doctitleM = html.match(/id="doctitle"[^>]*>([\s\S]*?)<\/td>/i);
  if (doctitleM) title = plain(doctitleM[1]).trim();

  // 4. 본문 추출 — id="bodyblock" 우선, 없으면 id="body"
  let bodyHtml = '';
  const bbM = html.match(/id="bodyblock"[^>]*>([\s\S]+)/i);
  if (bbM) {
    // bodyblock 이후 전체에서 </body> 직전까지
    const afterBB = bbM[1];
    // 닫는 태그 찾기
    const endM = afterBB.search(/<\/body>/i);
    bodyHtml = endM >= 0 ? afterBB.slice(0, endM) : afterBB;
  } else {
    // fallback: 제목 이후 전체
    const titlePos = html.search(/id="doctitle"/i);
    if (titlePos >= 0) bodyHtml = html.slice(titlePos);
    else bodyHtml = html;
  }

  // 5. 본문 변환 (표 구조 보존)
  const clean = convertBody(bodyHtml, html).slice(0, 6000);

  return { clean, title, style };
}

// ── 본문 변환: 단락 + 표 ──────────────────────────────────────
function convertBody(bodyHtml, fullHtml) {
  // style/script 제거
  bodyHtml = bodyHtml
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<img[^>]*>/gi, '');

  // 표를 [TABLE] 문법으로 교체
  // <table> 태그가 bodyHtml을 넘어 fullHtml에 있을 수 있으므로
  // 표 시작 위치 기준으로 fullHtml에서 추출
  let result = '';
  let remaining = bodyHtml;
  let tableIdx = 0;

  while (true) {
    const tStart = remaining.indexOf('<table');
    if (tStart < 0) break;

    // 표 앞 텍스트 처리
    const before = remaining.slice(0, tStart);
    result += htmlToText(before);

    // 표 끝 찾기: </table> 이 remaining에 없으면 fullHtml에서 찾기
    let tEnd = remaining.toLowerCase().indexOf('</table>', tStart);
    let tableHtml;
    if (tEnd >= 0) {
      tableHtml = remaining.slice(tStart, tEnd + 8);
      remaining = remaining.slice(tEnd + 8);
    } else {
      // fullHtml에서 이 표의 시작 위치를 찾아 끝까지 추출
      const absStart = fullHtml.indexOf(remaining.slice(tStart, tStart + 50));
      if (absStart >= 0) {
        const absEnd = fullHtml.toLowerCase().indexOf('</table>', absStart);
        if (absEnd >= 0) {
          tableHtml = fullHtml.slice(absStart, absEnd + 8);
        } else {
          tableHtml = remaining.slice(tStart);
        }
      } else {
        tableHtml = remaining.slice(tStart);
      }
      remaining = ''; // 표 이후 내용은 fullHtml에서 처리 불가, 종료
    }

    tableIdx++;
    result += convertTable(tableHtml, tableIdx);

    if (!remaining) break;
  }

  // 나머지 텍스트
  if (remaining) result += htmlToText(remaining);

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ── 표 변환: rowspan/colspan 완전 처리 ──────────────────────
function convertTable(tableHtml, idx) {
  const trs = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (!trs.length) return '';

  // rowspan 처리를 위한 가상 그리드
  const grid = [];
  const rowspanTrack = {}; // col → {remaining, value}

  for (const trMatch of trs) {
    const tr = trMatch[1];
    const tds = [...tr.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)];
    const row = [];
    let gridCol = 0;

    // 이전 rowspan으로 채워진 칼럼 처리
    for (const td of tds) {
      // rowspan이 남아있는 칼럼 먼저 채우기
      while (rowspanTrack[gridCol] && rowspanTrack[gridCol].remaining > 0) {
        row.push(rowspanTrack[gridCol].value);
        rowspanTrack[gridCol].remaining--;
        gridCol++;
      }
      const attrs   = td[1];
      const content = td[2];
      const rs = parseInt((attrs.match(/rowspan="(\d+)"/i) || [,'1'])[1]);
      const cs = parseInt((attrs.match(/colspan="(\d+)"/i) || [,'1'])[1]);
      const text = plain(content).replace(/\s+/g, ' ').trim();

      // colspan만큼 셀 반복
      for (let c = 0; c < cs; c++) {
        row.push(c === 0 ? text : '');
        if (rs > 1) {
          rowspanTrack[gridCol] = { remaining: rs - 1, value: c === 0 ? text : '' };
        }
        gridCol++;
      }
    }
    // 행 끝에서도 rowspan 잔여 채우기
    while (rowspanTrack[gridCol] && rowspanTrack[gridCol].remaining > 0) {
      row.push(rowspanTrack[gridCol].value);
      rowspanTrack[gridCol].remaining--;
      gridCol++;
    }
    grid.push(row);
  }

  if (!grid.length) return '';

  // [TABLE] 문법 생성
  const rows = grid.map(row => row.join('|'));
  return `\n[TABLE:표${idx}]\n${rows.join('\n')}\n[/TABLE]\n`;
}

// ── 일반 HTML → 텍스트 ──────────────────────────────────────
function htmlToText(html) {
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

function plain(html) {
  return htmlToText(html);
}

// QP 디코딩 — UTF-8 멀티바이트 한글 지원
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

function escRx(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
