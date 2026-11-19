'use strict';
/**
 * Real delivery providers for parent notifications (email / SMS / WhatsApp).
 *
 * Every adapter is a plain HTTPS POST (no extra dependencies) configured
 * exclusively through environment variables — never through the UI and never
 * stored in the database, so secrets never touch the frontend or the DB.
 *
 * Precedence per channel:
 *   1. native provider (Twilio / Meta WhatsApp Cloud API / SendGrid)
 *   2. generic webhook  (EMAIL_WEBHOOK_URL / SMS_WEBHOOK_URL / WHATSAPP_WEBHOOK_URL)
 *   3. log fallback     (demo only - honest "simulated" delivery into notifications.log)
 *   4. honest failure   (provider_not_configured — never a silent pretend-send)
 *
 * Each adapter returns the same shape: { ok, status, response }.
 */

const clampStr = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s));

/** Normalize an Indian-style mobile number to E.164 for provider APIs. */
function toE164(phone, countryCode) {
  if (!phone) return null;
  const cc = String(countryCode || process.env.NOTIFY_COUNTRY_CODE || '91').replace(/\D/g, '') || '91';
  let d = String(phone).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = cc + d;               // bare mobile → +<cc><number>
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return '+' + d;
}

async function httpJson(url, { auth, body, headers = {}, timeoutMs = 10000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth || {}), ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status, response: clampStr(await res.text(), 400) };
  } finally {
    clearTimeout(timer);
  }
}

async function httpForm(url, { basic, body, timeoutMs = 10000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(basic).toString('base64')}`,
      },
      body: new URLSearchParams(body).toString(),
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status, response: clampStr(await res.text(), 400) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ Twilio (SMS + WhatsApp) ------------------------------ */
function twilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}
async function twilioSend({ from, to, message }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const r = await httpForm(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    basic: `${sid}:${process.env.TWILIO_AUTH_TOKEN}`,
    body: { From: from, To: to, Body: message },
  });
  return r;
}

/* --------------------------- SendGrid (email over HTTP API) -------------------------- */
function sendgridConfigured() {
  return !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM);
}
async function sendgridSend({ from, to, subject, message }) {
  return httpJson('https://api.sendgrid.com/v3/mail/send', {
    auth: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
    body: {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: process.env.SENDGRID_FROM_NAME || 'Attendance Office' },
      subject,
      content: [{ type: 'text/plain', value: message }],
    },
  });
}

/* ----------------------- Meta WhatsApp Cloud API (graph.facebook.com) --------------- */
function metaWaConfigured() {
  return !!(process.env.META_WA_PHONE_NUMBER_ID && process.env.META_WA_TOKEN);
}
async function metaWaSend({ to, message }) {
  const endpoint = `https://graph.facebook.com/v18.0/${process.env.META_WA_PHONE_NUMBER_ID}/messages`;
  const headers = { Authorization: `Bearer ${process.env.META_WA_TOKEN}` };
  const digits = to.replace(/\D/g, '');
  const tpl = process.env.META_WA_TEMPLATE_NAME;
  const body = tpl
    ? { // approved utility template with ONE body variable {{1}}
        messaging_product: 'whatsapp', to: digits, type: 'template',
        template: {
          name: tpl,
          language: { code: process.env.META_WA_LANG || 'en_US' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: message }] }],
        },
      }
    : { // free-form text (only valid inside the 24h customer service window)
        messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: message },
      };
  return httpJson(endpoint, { body, headers });
}

/**
 * Resolve the native provider for a channel, if fully configured.
 * Returns { name, send(payload) } or null.
 */
function nativeProvider(channel) {
  if (channel === 'sms' && process.env.SMS_PROVIDER === 'twilio' && twilioConfigured() && process.env.TWILIO_FROM) {
    return {
      name: 'twilio',
      send: (p) => {
        const to = toE164(p.to);
        if (!to) return Promise.resolve({ ok: false, status: 0, response: 'empty recipient' });
        return twilioSend({ from: process.env.TWILIO_FROM, to, message: p.message });
      },
    };
  }
  if (channel === 'whatsapp' && process.env.WHATSAPP_PROVIDER === 'twilio' && twilioConfigured()) {
    const from = (process.env.TWILIO_WHATSAPP_FROM || '').startsWith('whatsapp:')
      ? process.env.TWILIO_WHATSAPP_FROM
      : `whatsapp:${toE164(process.env.TWILIO_WHATSAPP_FROM || '')}`;
    return {
      name: 'twilio',
      send: (p) => {
        const to = toE164(p.to);
        if (!to) return Promise.resolve({ ok: false, status: 0, response: 'empty recipient' });
        return twilioSend({ from, to: `whatsapp:${to}`, message: p.message });
      },
    };
  }
  if (channel === 'whatsapp' && process.env.WHATSAPP_PROVIDER === 'meta' && metaWaConfigured()) {
    return {
      name: 'meta',
      send: (p) => {
        const to = toE164(p.to);
        if (!to) return Promise.resolve({ ok: false, status: 0, response: 'empty recipient' });
        return metaWaSend({ to, message: p.message });
      },
    };
  }
  if (channel === 'email' && process.env.EMAIL_PROVIDER === 'sendgrid' && sendgridConfigured()) {
    return {
      name: 'sendgrid',
      send: (p) => sendgridSend({
        from: process.env.SENDGRID_FROM, to: p.to,
        subject: `Attendance alert — ${p.student.name} · ${process.env.INSTITUTION_NAME_FALLBACK || 'Attendance'}`,
        message: p.message,
      }),
    };
  }
  return null;
}

module.exports = { toE164, nativeProvider };
