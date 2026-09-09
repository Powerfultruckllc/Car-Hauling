const VERIFY_TOKEN = process.env.FB_WEBHOOK_VERIFY_TOKEN;
const FB_TOKEN = process.env.FB_ACCESS_TOKEN;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// In-memory dedupe (per warm container). Netlify Blobs would persist across cold
// starts, but Meta itself rarely redelivers the same lead_id more than a few
// seconds apart, so this covers the realistic duplicate window.
const seen = new Set();

const FIELD_LABELS = {
  full_name: 'Имя',
  first_name: 'Имя',
  last_name: 'Фамилия',
  phone_number: 'Телефон',
  email: 'Email',
  car_hauling_experience: 'Опыт в Car Hauling',
  city: 'Город',
  state: 'Штат',
};

function labelFor(name) {
  return FIELD_LABELS[name] || name;
}

function prettyValue(name, value) {
  if (name === 'car_hauling_experience') {
    if (value === 'no') return 'Нет';
    if (value === 'yes') return 'Да';
  }
  return value;
}

async function fetchLead(leadId) {
  const url = `https://graph.facebook.com/v21.0/${leadId}?fields=id,created_time,field_data,ad_id,campaign_id&access_token=${FB_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendTelegram(text, attempt = 1) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
  });
  if (res.ok) return true;
  if (attempt < 3) {
    await new Promise((r) => setTimeout(r, attempt * 1000));
    return sendTelegram(text, attempt + 1);
  }
  throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

function buildMessage(lead) {
  const lines = ['🚛 <b>Новая заявка — Car Hauling</b>', ''];
  for (const f of lead.field_data || []) {
    const value = (f.values || []).map((v) => prettyValue(f.name, v)).join(', ');
    lines.push(`<b>${labelFor(f.name)}:</b> ${value}`);
  }
  if (lead.created_time) {
    const t = new Date(lead.created_time).toLocaleString('ru-RU', {
      timeZone: 'America/Los_Angeles',
    });
    lines.push('', `🕐 ${t} (PT)`);
  }
  lines.push(`<code>lead_id: ${lead.id}</code>`);
  return lines.join('\n');
}

exports.handler = async function (event) {
  // Meta webhook verification handshake
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === VERIFY_TOKEN) {
      return { statusCode: 200, body: q['hub.challenge'] || '' };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  // Always ack fast so Meta does not retry on our processing errors.
  const jobs = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const leadId = change.value && change.value.leadgen_id;
      if (!leadId || seen.has(leadId)) continue;
      seen.add(leadId);
      jobs.push(
        fetchLead(leadId)
          .then((lead) => sendTelegram(buildMessage(lead)))
          .catch((err) => {
            seen.delete(leadId); // allow a retry on the next delivery
            console.error('lead handling failed', leadId, err.message);
          })
      );
    }
  }

  await Promise.all(jobs);
  return { statusCode: 200, body: 'EVENT_RECEIVED' };
};
