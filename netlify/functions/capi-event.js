const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const PIXEL_ID = process.env.FB_PIXEL_ID;
  const ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

  if (!PIXEL_ID || !ACCESS_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing FB_PIXEL_ID or FB_ACCESS_TOKEN env vars' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { event_name, event_id, event_source_url, fbp, fbc, phone } = payload;

  if (!event_name || !event_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'event_name and event_id are required' }) };
  }

  const clientIp =
    event.headers['x-nf-client-connection-ip'] ||
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    undefined;
  const userAgent = event.headers['user-agent'];

  const userData = {
    client_ip_address: clientIp,
    client_user_agent: userAgent,
  };
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (phone) userData.ph = [sha256(phone)];

  const body = {
    data: [
      {
        event_name,
        event_time: Math.floor(Date.now() / 1000),
        event_id,
        event_source_url: event_source_url || '',
        action_source: 'website',
        user_data: userData,
      },
    ],
  };

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json();
    return { statusCode: res.ok ? 200 : 500, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
