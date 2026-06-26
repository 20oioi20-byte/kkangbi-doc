// api/claude.js
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // MHT 파싱 요청
    if (req.body && req.body.type === 'parse_mht') {
      const clean = parseMHT(req.body.content || '');
      return res.status(200).json({ clean });
    }

    // Claude API 프록시
    const body = Object.assign({}, req.body);
    delete body.type;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function parseMHT(mhtText) {
  const parts = mhtText.split(/--[^\r\n]+/);
  let htmlPart = '';
  let encoding = '';

  for (const part of parts) {
    if (!part.includes('Content-Type')) continue;
    const ctMatch = part.match(/Content-Type:\s*([^\r\n;]+)/i);
    const ct = (ctMatch && ctMatch[1]) ? ctMatch[1].trim().toLowerCase() : '';
    if (!ct.includes('text/html') && !ct.includes('text/plain')) continue;

    const encMatch = part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
    encoding = (encMatch && encMatch[1]) ? encMatch[1].trim().toLowerCase() : 'none';

    const bodyMatch = part.match(/\r?\n\r?\n([\s\S]+)$/);
    if (bodyMatch) { htmlPart = bodyMatch[1].trim(); break; }
  }

  if (!htmlPart) {
    const bodyMatch = mhtText.match(/\r?\n\r?\n([\s\S]+)$/);
    htmlPart = bodyMatch ? bodyMatch[1].trim() : mhtText;
    const encMatch = mhtText.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
    encoding = (encMatch && encMatch[1]) ? encMatch[1].trim().toLowerCase() : 'none';
  }

  let decoded = htmlPart;

  if (encoding === 'base64') {
    try {
      decoded = Buffer.from(htmlPart.replace(/\s+/g, ''), 'base64').toString('utf-8');
    } catch (e) { decoded = htmlPart; }
  } else if (encoding === 'quoted-printable') {
    decoded = decoded
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, function(_, h) {
        return String.fromCharCode(parseInt(h, 16));
      });
  }

  return decoded
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}
