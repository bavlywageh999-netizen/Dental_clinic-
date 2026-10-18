// =====================================================================
// Supabase Edge Function: submit-booking                      (Deno runtime)
// 1) validates a booking request  2) saves it (the database must accept it first)
// 3) emails the patient           4) notifies the clinic on WhatsApp
// Provider secrets exist ONLY as Edge Function secrets in Supabase - never in the website.
// Deploy WITHOUT JWT verification (publishable keys are not JWTs):  supabase functions deploy submit-booking --no-verify-jwt
// Required secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Email (Resend): RESEND_API_KEY, EMAIL_FROM            WhatsApp (Meta Cloud API): WA_TOKEN, WA_PHONE_NUMBER_ID, WA_TO, WA_TEMPLATE, WA_TEMPLATE_LANG
// Optional: CLINIC_NAME, CLINIC_PHONE, CLINIC_WHATSAPP, ALLOWED_ORIGIN, WA_MODE ("text" only works inside WhatsApp's 24-hour window)
// =====================================================================
const env = (k, d = "") => Deno.env.get(k) ?? d;

// Must match the booking form on the website (English names; Arabic labels are mapped back to English).
const SERVICES = {
  "Check-up and cleaning": [
    "الكشف والتنظيف"
  ],
  "Teeth whitening": [
    "تبييض الأسنان"
  ],
  "Fillings and repairs": [
    "الحشوات والترميم"
  ],
  "Crowns, bridges and dentures": [
    "التيجان والجسور وطقم الأسنان"
  ],
  "Root canal treatment": [
    "علاج قناة الجذر"
  ],
  "Braces and aligners": [
    "التقويم والمقوّمات الشفافة"
  ],
  "Dental implants": [
    "زراعة الأسنان"
  ],
  "Gum treatment and surgery": [
    "علاج اللثة وجراحتها"
  ],
  "Veneers and smile design": [
    "الفينير وتصميم الابتسامة"
  ],
  "Toothache or emergency": [
    "ألم أسنان أو حالة طارئة"
  ]
};
const SLOTS = ["12:00 pm","1:00 pm","2:00 pm","3:00 pm","4:00 pm","5:00 pm","6:00 pm","7:00 pm","8:00 pm","9:00 pm"];
const OPEN_DAYS = [0, 1, 2, 3, 6];          // 0 = Sunday ... 6 = Saturday (Thursday and Friday closed)
const MAX_DAYS = 90, TZ = "Africa/Cairo", MAX_PER_EMAIL_PER_HOUR = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STALE_MS = 2 * 60 * 1000;

function cors() {
  return { "Access-Control-Allow-Origin": env("ALLOWED_ORIGIN", "*"), "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
           "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors(), "Content-Type": "application/json" } });

// ---------- helpers ----------
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function cairoNow() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
function addDays(ymd, n) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function slotMinutes(s) { const m = /^(\d{1,2}):(\d{2}) (am|pm)$/i.exec(s); let h = Number(m[1]) % 12; if (m[3].toLowerCase() === "pm") h += 12; return h * 60 + Number(m[2]); }
function canonicalService(x) {
  const t = clean(x, 80);
  for (const [en, others] of Object.entries(SERVICES)) if (t === en || others.includes(t)) return en;
  return "";
}

// Server-side validation: nothing sent by the browser is trusted.
function validate(b) {
  const errors = {}, v = {};
  v.name = clean(b.name, 100); if (v.name.length < 3) errors.name = "Enter your full name.";
  v.email = String(b.email ?? "").trim().toLowerCase();
  if (v.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = "Enter a valid email address.";
  v.phone = String(b.phone ?? "").replace(/[\s\-()]/g, ""); if (!/^\+?\d{8,15}$/.test(v.phone)) errors.phone = "Enter a valid phone number.";
  v.service = canonicalService(b.service); if (!v.service) errors.service = "Choose a treatment.";
  const now = cairoNow(), date = String(b.date ?? "");
  v.date = date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + "T12:00:00Z")) || new Date(date + "T12:00:00Z").toISOString().slice(0, 10) !== date) errors.date = "Choose a date.";
  else if (date < now.date) errors.date = "Choose today or a later date.";
  else if (date > addDays(now.date, MAX_DAYS)) errors.date = "Choose a date within the next 90 days.";
  else if (!OPEN_DAYS.includes(new Date(date + "T12:00:00Z").getUTCDay())) errors.date = "The clinic is closed on Thursdays and Fridays.";
  v.time = clean(b.time, 10); if (!SLOTS.includes(v.time)) errors.time = "Choose a time.";
  else if (!errors.date && date === now.date && slotMinutes(v.time) <= now.minutes) errors.time = "That time has already passed today.";
  v.notes = clean(b.notes, 500) || null;
  v.lang = b.lang === "ar" ? "ar" : "en";
  return { errors, v };
}

// ---------- database (service role: the browser never sees this key) ----------
const q = encodeURIComponent;
function db(path, init = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return fetch(env("SUPABASE_URL") + "/rest/v1/" + path, { ...init, headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", ...(init.headers || {}) } });
}
async function getBooking(id) {
  const r = await db(`bookings?select=*&id=eq.${q(id)}`); if (!r.ok) throw new Error("db_read_" + r.status);
  return (await r.json())[0] || null;
}
function newRef() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", b = crypto.getRandomValues(new Uint8Array(6));
  return "TF-" + Array.from(b, (x) => A[x % A.length]).join("");
}
async function insertBooking(id, v) {
  for (let i = 0; i < 5; i++) {
    const row = { id, ref: newRef(), name: v.name, email: v.email, phone: v.phone, service: v.service, req_date: v.date, req_time: v.time, notes: v.notes, lang: v.lang };
    const r = await db("bookings", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
    if (r.ok) return { row: (await r.json())[0], created: true };
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 && /ref/i.test(JSON.stringify(j))) continue;           // reference collision: pick another
    if (r.status === 409) return { row: await getBooking(id), created: false };  // same id: already saved (retry / double click)
    throw new Error("db_insert_" + r.status);
  }
  throw new Error("db_ref");
}

// ---------- notifications: claimed atomically so a retry or double call can never send twice ----------
async function claim(id, col) {
  await db(`bookings?id=eq.${q(id)}&${col}_status=eq.sending&${col}_at=lt.${q(new Date(Date.now() - STALE_MS).toISOString())}`, { method: "PATCH", body: JSON.stringify({ [col + "_status"]: "failed", [col + "_error"]: "interrupted" }) });
  const r = await db(`bookings?id=eq.${q(id)}&${col}_status=in.(pending,failed,not_configured)`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ [col + "_status"]: "sending", [col + "_at"]: new Date().toISOString() }) });
  return r.ok ? (await r.json())[0] || null : null;
}
const settle = (id, col, status, error) => db(`bookings?id=eq.${q(id)}`, { method: "PATCH", body: JSON.stringify({ [col + "_status"]: status, [col + "_error"]: error ? String(error).slice(0, 160) : null, [col + "_at"]: new Date().toISOString() }) });
async function withTimeout(url, init, ms = 10000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}
async function runChannel(id, col, sender) {
  const b = await claim(id, col); if (!b) return;           // already accepted, or another request is handling it
  let res; try { res = await sender(b); } catch (_) { res = { status: "failed", error: "network_error" }; }
  await settle(id, col, res.status, res.error);
}

const CLINIC = () => ({ name: env("CLINIC_NAME", "Dr. Tamer Fayez Dental Clinic"), phone: env("CLINIC_PHONE", "+20 155 627 7801"), wa: env("CLINIC_WHATSAPP", "201555687219") });
const weekdayOf = (ymd, lang) => new Date(ymd + "T12:00:00Z").toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const timeOf = (s, lang) => (lang === "ar" ? s.replace(/ pm$/i, " م").replace(/ am$/i, " ص") : s);

function emailContent(b) {
  const c = CLINIC(), ar = b.lang === "ar", date = weekdayOf(b.req_date, b.lang), time = timeOf(b.req_time, b.lang);
  const T = ar
    ? { subject: `تم استلام طلب موعدك – ${b.ref}`, h: "استلمنا طلب حجز موعدك", hi: `مرحبًا ${b.name}،`, note: "هذا طلب موعد وليس موعدًا مؤكدًا بعد. ستتواصل معك العيادة لتأكيده.", ref: "رقم الحجز", svc: "العلاج", d: "التاريخ المطلوب", t: "الوقت المطلوب", change: `لتغيير أي تفصيل أو إلغاء الطلب، اتصل بنا على ${c.phone} أو راسلنا على واتساب.` }
    : { subject: `Appointment request received – ${b.ref}`, h: "We received your appointment request", hi: `Hello ${b.name},`, note: "This is a request, not a confirmed appointment yet. The clinic will contact you to confirm it.", ref: "Booking reference", svc: "Treatment", d: "Requested date", t: "Requested time", change: `To change any detail or cancel the request, call ${c.phone} or message us on WhatsApp.` };
  const rows = [[T.ref, b.ref], [T.svc, b.service], [T.d, date], [T.t, time]];
  const html = `<div dir="${ar ? "rtl" : "ltr"}" style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#10242c"><h2 style="color:#1a6675">${esc(T.h)}</h2><p>${esc(T.hi)}</p><p>${esc(T.note)}</p>` +
    `<table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:8px;border-bottom:1px solid #e3eeec;color:#5a7378">${esc(k)}</td><td style="padding:8px;border-bottom:1px solid #e3eeec"><b>${esc(v)}</b></td></tr>`).join("")}</table>` +
    `<p>${esc(T.change)}</p><p style="color:#5a7378">${esc(c.name)}</p></div>`;
  const text = [T.hi, "", T.note, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", T.change, c.name].join("\n");
  return { subject: T.subject, html, text };
}
function classify(status) { return status === 401 || status === 403 ? "auth_or_sender_not_verified" : status === 422 || status === 400 ? "rejected" : status === 429 ? "rate_limited" : status >= 500 ? "provider_down" : "http_" + status; }

async function sendEmail(b) {
  const key = env("RESEND_API_KEY"), from = env("EMAIL_FROM");
  if (!key || !from) return { status: "not_configured", error: "email provider secrets missing" };
  const m = emailContent(b);
  const r = await withTimeout("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "Idempotency-Key": `booking-${b.id}-confirmation` }, body: JSON.stringify({ from, to: [b.email], subject: m.subject, html: m.html, text: m.text }) });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.id ? { status: "accepted" } : { status: "failed", error: classify(r.status) };   // "accepted" = the provider took it; delivery is not guaranteed
}
async function sendWhatsApp(b) {
  const token = env("WA_TOKEN"), pid = env("WA_PHONE_NUMBER_ID"), to = env("WA_TO", CLINIC().wa).replace(/\D/g, "");
  if (!token || !pid || !to) return { status: "not_configured", error: "WhatsApp API secrets missing" };
  const vals = [b.ref, b.name, b.service, `${b.req_date}`, b.req_time, b.phone];
  const body = env("WA_MODE") === "text"
    ? { messaging_product: "whatsapp", to, type: "text", text: { body: `New booking request ${b.ref}\nName: ${b.name}\nPhone: ${b.phone}\nTreatment: ${b.service}\nDate: ${b.req_date}\nTime: ${b.req_time}` } }
    : { messaging_product: "whatsapp", to, type: "template", template: { name: env("WA_TEMPLATE"), language: { code: env("WA_TEMPLATE_LANG", "en") }, components: [{ type: "body", parameters: vals.map((x) => ({ type: "text", text: String(x).slice(0, 200) })) }] } };
  if (env("WA_MODE") !== "text" && !env("WA_TEMPLATE")) return { status: "not_configured", error: "WA_TEMPLATE missing" };
  const r = await withTimeout(`https://graph.facebook.com/v21.0/${pid}/messages`, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.messages && j.messages[0] && j.messages[0].id ? { status: "accepted" } : { status: "failed", error: "whatsapp_" + (j.error && j.error.code ? j.error.code : classify(r.status)) };   // accepted by the API, not proof it was read
}

const view = (b) => ({ ref: b.ref, status: b.status, email: { status: b.email_status, error: b.email_error }, whatsapp: { status: b.whatsapp_status, error: b.whatsapp_error } });
async function notifyAll(id, channels) {
  const jobs = [];
  if (channels === "all" || channels === "email") jobs.push(runChannel(id, "email", sendEmail));
  if (channels === "all" || channels === "whatsapp") jobs.push(runChannel(id, "whatsapp", sendWhatsApp));
  await Promise.allSettled(jobs);
  return getBooking(id);
}

// ---------- request handler ----------
async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "POST") return reply(405, { ok: false, code: "method" });
  let body; try { body = await req.json(); } catch (_) { return reply(400, { ok: false, saved: false, code: "bad_json" }); }
  const action = body.action || "create", id = String(body.id ?? "");
  if (!UUID.test(id)) return reply(400, { ok: false, saved: false, code: "bad_id" });
  try {
    
    // Public users may only create a booking.
    // Status lookup and notification retries must use a separate,
    // properly authenticated admin endpoint.
    if (action !== "create") {
      return reply(403, {
        ok: false,
        saved: false,
        code: "forbidden"
      });
    }

    const { errors, v } = validate(body);

    if (Object.keys(errors).length) {
      return reply(400, {
        ok: false,
        saved: false,
        code: "invalid",
        errors
      });
    }

    // Never reveal details or resend notifications for an existing ID.
    let existing = await getBooking(id);

    if (existing) {
      return reply(200, {
        ok: true,
        saved: true,
        created: false,
        code: "already_processed"
      });
    }

    // Fail closed if the rate-limit query fails.
    const since = new Date(
      Date.now() - 3600 * 1000
    ).toISOString();

    const rc = await db(
      `bookings?select=id&email=eq.${q(v.email)}&created_at=gte.${q(since)}`
    );

    if (!rc.ok) {
      return reply(503, {
        ok: false,
        saved: false,
        code: "rate_limit_check_failed"
      });
    }

    const recent = await rc.json();

    if (recent.length >= MAX_PER_EMAIL_PER_HOUR) {
      return reply(429, {
        ok: false,
        saved: false,
        code: "rate_limited"
      });
    }

    const ins = await insertBooking(id, v);
    const booking = ins.row;

    // A concurrent duplicate request must never trigger notifications.
    if (!ins.created || !booking) {
      return reply(200, {
        ok: true,
        saved: true,
        created: false,
        code: "already_processed"
      });
    }

    // Record the existing clinic event without blocking the booking.
    db("clinic_events", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        t: new Date().toISOString(),
        type: "request",
        email: v.email,
        name: v.name,
        phone: v.phone,
        service: v.service,
        req_date: v.date,
        req_time: v.time,
        notes: v.notes
      })
    }).catch(() => {});

    // Only the request that actually created the booking sends notifications.
    const notified = await notifyAll(id, "all");

    return reply(200, {
      ok: true,
      saved: true,
      created: true,
      ...view(notified || booking)
    });
  
    } catch (_e) {
    try {
      const savedBooking = await getBooking(id);

      if (savedBooking) {
        return reply(200, {
          ok: true,
          saved: true,
          created: false,
          code: "saved_notification_status_unknown",
          ...view(savedBooking)
        });
      }
    } catch (_readError) {
      // Could not verify whether the booking was saved.
    }

    return reply(503, {
      ok: false,
      saved: false,
      code: "request_failed"
    });
  }
}
Deno.serve(handle);
