// =====================================================================
// Supabase Edge Function: submit-booking                      (Deno runtime)  -  hardened version
// Public:   action "create"  (anyone can request an appointment; protected by CAPTCHA + rate limits + server-side validation)
// Private:  actions "status" and "retry" need EITHER the booking's secret access token (returned to the patient who created it)
//           OR the Authorization header of a signed-in clinic admin (checked server-side against public.admins). Nothing else works.
// Secrets live ONLY in Supabase (Edge Function secrets). The service-role key never leaves this function.
// Deploy WITHOUT JWT verification (publishable keys are not JWTs):  supabase functions deploy submit-booking --no-verify-jwt
//
// Provided by Supabase automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// REQUIRED:  BOOKING_SECRET (random, 32+ characters: signs patient access tokens and hashes IP addresses)
//            TURNSTILE_SECRET_KEY (Cloudflare Turnstile CAPTCHA)   -- or REQUIRE_CAPTCHA=0 to run WITHOUT a CAPTCHA (not recommended)
// Email (Resend): RESEND_API_KEY, EMAIL_FROM (the address, e.g. bookings@yourdomain.com; or a full "Name <address>")
//            optional: EMAIL_FROM_NAME (default "Dr. Tamer Fayez Clinic - Appointment confirmation email"), EMAIL_ENGLISH_COPY ("0" = Arabic only)
// WhatsApp (Meta Cloud API): WA_TOKEN, WA_PHONE_NUMBER_ID, WA_TEMPLATE  (+ WA_TO, WA_TEMPLATE_LANG; WA_MODE=text only inside the 24h window)
// Optional:  ALLOWED_ORIGIN (your site, e.g. https://yourname.github.io), CLINIC_NAME, CLINIC_PHONE, CLINIC_WHATSAPP,
//            RL_IP_HOUR, RL_IP_DAY, RL_EMAIL_HOUR, RL_EMAIL_DAY, RL_GLOBAL_HOUR, RL_GLOBAL_DAY (rate limits)
// SQL needed: supabase_quick_fix.sql, supabase_bookings.sql, supabase_bookings_security.sql
// =====================================================================
const env = (k, d = "") => Deno.env.get(k) ?? d;
const num = (k, d) => { const n = Number(env(k)); return Number.isFinite(n) && n > 0 ? n : d; };

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
const MAX_DAYS = 90, TZ = "Africa/Cairo";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STALE_MS = 2 * 60 * 1000, MAX_BODY = 8192, PATIENT_MAX_ATTEMPTS = 4, PATIENT_COOLDOWN_MS = 60 * 1000;
// Limits that do NOT depend on the submitted email or UUID: per network address (hashed), and for the whole clinic. Mobile carriers share addresses, so keep these generous.
const LIMITS = () => ({ ipHour: num("RL_IP_HOUR", 10), ipDay: num("RL_IP_DAY", 30), emailHour: num("RL_EMAIL_HOUR", 3), emailDay: num("RL_EMAIL_DAY", 6), globalHour: num("RL_GLOBAL_HOUR", 100), globalDay: num("RL_GLOBAL_DAY", 400) });

function cors() {
  return { "Access-Control-Allow-Origin": env("ALLOWED_ORIGIN") || "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
           "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors(), "Content-Type": "application/json", "Cache-Control": "no-store" } });
const originOk = (req) => { const a = env("ALLOWED_ORIGIN"); if (!a || a === "*") return true; const o = req.headers.get("origin"); return !o || o === a; };

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

// ---------- secrets-derived values: patient access token and hashed network address ----------
const enc = new TextEncoder();
const secretOk = () => env("BOOKING_SECRET").length >= 32;
async function hmac(msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env("BOOKING_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
const b64url = (u) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (u) => Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
const tokenFor = async (id) => b64url(await hmac("booking-token:" + id));      // unguessable without BOOKING_SECRET; never stored
const ipHashOf = async (ip) => hex(await hmac("ip:" + ip)).slice(0, 32);
function safeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function clientIp(req) {                       // Supabase runs behind Cloudflare, which sets cf-connecting-ip itself; the browser cannot choose it
  const h = req.headers, cf = h.get("cf-connecting-ip"); if (cf) return cf.trim();
  const real = h.get("x-real-ip"); if (real) return real.trim();
  const xf = h.get("x-forwarded-for"); if (xf) { const p = xf.split(",").map((s) => s.trim()).filter(Boolean); return p[p.length - 1] || "unknown"; }
  return "unknown";                            // unknown addresses all share one bucket, so the limits still apply
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
async function insertBooking(id, v, ipHash) {
  for (let i = 0; i < 5; i++) {
    const row = { id, ref: newRef(), name: v.name, email: v.email, phone: v.phone, service: v.service, req_date: v.date, req_time: v.time, notes: v.notes, lang: v.lang, ip_hash: ipHash };
    const r = await db("bookings", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
    if (r.ok) return { row: (await r.json())[0], created: true };
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 && /ref/i.test(JSON.stringify(j))) continue;           // reference collision: pick another
    if (r.status === 409) return { row: await getBooking(id), created: false };  // same id: already saved (double click / parallel request)
    throw new Error("db_insert_" + r.status);
  }
  throw new Error("db_ref");
}

// ---------- abuse protection (new bookings only) ----------
async function verifyCaptcha(req, token) {
  const secret = env("TURNSTILE_SECRET_KEY");
  if (!secret) return env("REQUIRE_CAPTCHA", "1") === "0" ? { ok: true } : { ok: false, status: 503, code: "captcha_not_configured" };
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) return { ok: false, status: 403, code: "captcha_required" };
  try {
    const f = new URLSearchParams({ secret, response: token, remoteip: clientIp(req) });
    const r = await withTimeout("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: f });
    const j = await r.json();
    return j && j.success === true ? { ok: true } : { ok: false, status: 403, code: "captcha_failed" };
  } catch (_) { return { ok: false, status: 503, code: "captcha_unavailable" }; }   // fail closed
}
async function atLimit(filter, limit, since) {
  const r = await db(`bookings?select=id&created_at=gte.${q(since)}${filter}&limit=${limit}`);
  if (!r.ok) throw new Error("db_limit_" + r.status);                           // cannot check = refuse
  return (await r.json()).length >= limit;
}
async function rateLimited(ipHash, email) {
  const L = LIMITS(), h = new Date(Date.now() - 3600e3).toISOString(), d = new Date(Date.now() - 86400e3).toISOString();
  const ip = `&ip_hash=eq.${q(ipHash)}`, em = `&email=eq.${q(email)}`;
  for (const [f, n, s] of [[ip, L.ipHour, h], [ip, L.ipDay, d], [em, L.emailHour, h], [em, L.emailDay, d], ["", L.globalHour, h], ["", L.globalDay, d]])
    if (await atLimit(f, n, s)) return true;
  return false;
}

// ---------- admin check: the caller's own login token is verified by Supabase Auth, then looked up in public.admins ----------
async function verifyAdmin(req) {
  const m = /^Bearer (.+)$/i.exec(req.headers.get("authorization") || ""); if (!m) return { ok: false, status: 401 };
  let r; try { r = await withTimeout(env("SUPABASE_URL") + "/auth/v1/user", { headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: "Bearer " + m[1] } }); } catch (_) { return { ok: false, status: 503 }; }
  if (!r.ok) return { ok: false, status: r.status >= 500 ? 503 : 401 };
  const u = await r.json().catch(() => null); if (!u || !UUID.test(String(u.id))) return { ok: false, status: 401 };
  const a = await db(`admins?select=user_id&user_id=eq.${q(u.id)}`); if (!a.ok) return { ok: false, status: 503 };
  return (await a.json()).length ? { ok: true } : { ok: false, status: 403 };    // removing a row from public.admins revokes access immediately
}

// ---------- notifications: claimed atomically so a retry or double call can never send twice ----------
async function claim(id, col, patient) {
  await db(`bookings?id=eq.${q(id)}&${col}_status=eq.sending&${col}_at=lt.${q(new Date(Date.now() - STALE_MS).toISOString())}`, { method: "PATCH", body: JSON.stringify({ [col + "_status"]: "failed", [col + "_error"]: "interrupted" }) });
  const rules = patient ? `&${col}_attempts=lt.${PATIENT_MAX_ATTEMPTS}&or=(${col}_at.is.null,${col}_at.lt.${q(new Date(Date.now() - PATIENT_COOLDOWN_MS).toISOString())})` : "";
  const r = await db(`bookings?id=eq.${q(id)}&${col}_status=in.(pending,failed,not_configured)${rules}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ [col + "_status"]: "sending", [col + "_at"]: new Date().toISOString() }) });
  return r.ok ? (await r.json())[0] || null : null;
}
const settle = (id, col, status, error, attempts) => db(`bookings?id=eq.${q(id)}`, { method: "PATCH", body: JSON.stringify({ [col + "_status"]: status, [col + "_error"]: error ? String(error).slice(0, 160) : null, [col + "_at"]: new Date().toISOString(), [col + "_attempts"]: Math.min(100, (attempts || 0) + 1) }) });
async function withTimeout(url, init, ms = 10000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}
async function runChannel(id, col, sender, patient) {
  const b = await claim(id, col, patient); if (!b) return;   // already accepted, being handled, or not allowed to retry yet
  let res; try { res = await sender(b); } catch (_) { res = { status: "failed", error: "network_error" }; }
  await settle(id, col, res.status, res.error, b[col + "_attempts"]);
}

const CLINIC = () => ({ name: env("CLINIC_NAME", "Dr. Tamer Fayez Dental Clinic"), phone: env("CLINIC_PHONE", "+20 155 627 7801"), wa: env("CLINIC_WHATSAPP", "201556277801") });
const weekdayOf = (ymd, lang) => new Date(ymd + "T12:00:00Z").toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const timeOf = (s, lang) => (lang === "ar" ? s.replace(/ pm$/i, " م").replace(/ am$/i, " ص") : s);

function emailContent(b) {
  const c = CLINIC();
  const A = { subject: `تم استلام طلب موعدك - ${b.ref}`, h: "استلمنا طلب حجز موعدك", hi: `مرحباً ${b.name}،`, sub: "شكراً لاختيارك عيادة Dr. Tamer Fayez.",
    note: "تم استلام طلب حجز موعدك بنجاح. ده طلب حجز وليس موعداً مؤكداً بعد، وهتتواصل معاك العيادة لتأكيده.",
    foot: "لتغيير أي تفصيل أو إلغاء الطلب، اتصل بالعيادة أو راسلها على واتساب.", sig1: "مع تحياتنا،", sig2: "Dr. Tamer Fayez Clinic",
    rows: [["رقم الحجز", b.ref], ["العلاج", (SERVICES[b.service] || [])[0] || b.service], ["التاريخ المطلوب", weekdayOf(b.req_date, "ar")], ["الوقت المطلوب", timeOf(b.req_time, "ar")]] };
  const E = { h: "We received your appointment request", hi: `Hello ${b.name},`, sub: `Thank you for choosing ${c.name}.`,
    note: "Your appointment request was received. This is a request, not a confirmed appointment yet - the clinic will contact you to confirm it.",
    foot: `To change any detail or cancel the request, call the clinic (${c.phone}) or message it on WhatsApp.`, sig1: "Kind regards,", sig2: "Dr. Tamer Fayez Clinic",
    rows: [["Booking reference", b.ref], ["Treatment", b.service], ["Requested date", weekdayOf(b.req_date, "en")], ["Requested time", b.req_time]] };
  const block = (dir, T) => `<div dir="${dir}" style="text-align:${dir === "rtl" ? "right" : "left"};padding:24px 28px"><h2 style="margin:0 0 14px;color:#0f7470;font-size:22px">${esc(T.h)}</h2><p style="margin:0 0 6px;font-size:16px">${esc(T.hi)}</p><p style="margin:0 0 14px;color:#4b7370">${esc(T.sub)}</p>` +
    `<p style="margin:0 0 16px;background:#e8f5f2;border-radius:10px;padding:12px 14px;line-height:1.7">${esc(T.note)}</p>` +
    `<table style="border-collapse:collapse;width:100%;margin:0 0 16px">${T.rows.map(([k, v]) => `<tr><td style="padding:9px 8px;border-bottom:1px solid #e3eeec;color:#5a7378;width:38%">${esc(k)}</td><td style="padding:9px 8px;border-bottom:1px solid #e3eeec"><b>${esc(v)}</b></td></tr>`).join("")}</table>` +
    `<p style="margin:0 0 16px;color:#4b7370;line-height:1.7">${esc(T.foot)}</p><p style="margin:0;line-height:1.6">${esc(T.sig1)}<br><b>${esc(T.sig2)}</b></p></div>`;
  const textOf = (T) => [T.h, "", T.hi, T.sub, "", T.note, "", ...T.rows.map(([k, v]) => `${k}: ${v}`), "", T.foot, "", T.sig1, T.sig2].join("\n");
  const english = b.lang !== "ar" && env("EMAIL_ENGLISH_COPY", "1") !== "0";
  const html = `<div style="font-family:Arial,Tahoma,sans-serif;max-width:600px;margin:auto;color:#10242c;background:#ffffff;border:1px solid #d6e8e4;border-radius:14px;overflow:hidden"><div style="background:#0f7470;color:#ffffff;padding:16px 28px;font-size:18px;font-weight:bold;text-align:center">Dr. Tamer Fayez Clinic</div>` +
    block("rtl", { ...A }) + (english ? `<div style="border-top:1px solid #d6e8e4">${block("ltr", E)}</div>` : "") + `</div>`;
  return { subject: A.subject, html, text: textOf(A) + (english ? "\n\n----------\n\n" + textOf(E) : "") };
}
function classify(status) { return status === 401 || status === 403 ? "auth_or_sender_not_verified" : status === 422 || status === 400 ? "rejected" : status === 429 ? "rate_limited" : status >= 500 ? "provider_down" : "http_" + status; }

async function sendEmail(b) {
  const key = env("RESEND_API_KEY"), addr = env("EMAIL_FROM");
  if (!key || !addr) return { status: "not_configured", error: "email provider secrets missing" };
  const from = addr.includes("<") ? addr : `${env("EMAIL_FROM_NAME", "Dr. Tamer Fayez Clinic - Appointment confirmation email")} <${addr}>`;
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
async function notifyChannels(id, cols, patient) {
  await Promise.allSettled(cols.map((c) => runChannel(id, c, c === "email" ? sendEmail : sendWhatsApp, patient)));
  return getBooking(id);
}
const retryEligible = (b, c) => ["failed", "pending", "not_configured"].includes(b[c + "_status"]) && (b[c + "_attempts"] || 0) < PATIENT_MAX_ATTEMPTS && (!b[c + "_at"] || Date.now() - Date.parse(b[c + "_at"]) >= PATIENT_COOLDOWN_MS);

// ---------- actions ----------
async function replay(existing, v, id) {          // same booking id sent again (lost response / double click): answer only, never send anything
  const same = existing.name === v.name && existing.email === v.email && existing.phone === v.phone && existing.service === v.service && existing.req_date === v.date && existing.req_time === v.time && (existing.notes || null) === (v.notes || null);
  if (!same) return reply(409, { ok: false, saved: false, code: "id_conflict" });
  return reply(200, { ok: true, saved: true, created: false, ...view(existing), token: secretOk() ? await tokenFor(id) : null });
}
async function create(req, id, body) {
  const { errors, v } = validate(body);
  const existing = await getBooking(id);
  if (existing) return replay(existing, v, id);
  if (Object.keys(errors).length) return reply(400, { ok: false, saved: false, code: "invalid", errors });
  if (!secretOk()) return reply(503, { ok: false, saved: false, code: "not_configured" });
  const cap = await verifyCaptcha(req, body.captcha); if (!cap.ok) return reply(cap.status, { ok: false, saved: false, code: cap.code });
  const ipHash = await ipHashOf(clientIp(req));
  if (await rateLimited(ipHash, v.email)) return reply(429, { ok: false, saved: false, code: "rate_limited" });
  const ins = await insertBooking(id, v, ipHash);
  if (!ins.created) return replay(ins.row, v, id);
  db("clinic_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ t: new Date().toISOString(), type: "request", email: v.email, name: v.name, phone: v.phone, service: v.service, req_date: v.date, req_time: v.time, notes: v.notes }) }).catch(() => {});
  const nb = await notifyChannels(id, ["email", "whatsapp"], false);      // only a brand-new booking triggers notifications
  return reply(200, { ok: true, saved: true, created: true, ...view(nb || ins.row), token: await tokenFor(id) });
}
async function manage(req, action, id, body) {
  let admin = false;
  if (req.headers.get("authorization")) {
    const a = await verifyAdmin(req);
    if (!a.ok) return reply(a.status, { ok: false, saved: false, code: a.status === 403 ? "forbidden" : a.status === 401 ? "unauthorized" : "auth_unavailable" });
    admin = true;
  } else {
    const t = String(body.token ?? "");
    if (!secretOk() || t.length < 20 || t.length > 200 || !safeEqual(t, await tokenFor(id))) return reply(403, { ok: false, saved: false, code: "forbidden" });   // same answer whether or not the booking exists
  }
  const b = await getBooking(id); if (!b) return reply(404, { ok: false, saved: false, code: "not_found" });
  if (action === "status") return reply(200, { ok: true, saved: true, ...view(b) });
  const cols = ["email", "whatsapp"].includes(body.channel) ? [body.channel] : ["email", "whatsapp"];
  const allowed = admin ? cols : cols.filter((c) => retryEligible(b, c));
  if (!allowed.length) return reply(429, { ok: false, saved: true, code: "retry_not_allowed", ...view(b) });
  return reply(200, { ok: true, saved: true, ...view(await notifyChannels(id, allowed, !admin)) });
}

// ---------- request handler ----------
async function readBody(req) {
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return { tooLarge: true };
  const t = await req.text(); if (t.length > MAX_BODY) return { tooLarge: true };
  try { const j = JSON.parse(t); return j && typeof j === "object" && !Array.isArray(j) ? { body: j } : { bad: true }; } catch (_) { return { bad: true }; }
}
async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "POST") return reply(405, { ok: false, code: "method" });
  if (!originOk(req)) return reply(403, { ok: false, saved: false, code: "origin" });
  const rb = await readBody(req);
  if (rb.tooLarge) return reply(413, { ok: false, saved: false, code: "too_large" });
  if (rb.bad) return reply(400, { ok: false, saved: false, code: "bad_json" });
  const body = rb.body, action = body.action || "create", id = String(body.id ?? "");
  if (!UUID.test(id)) return reply(400, { ok: false, saved: false, code: "bad_id" });
  try {
    if (action === "status" || action === "retry") return await manage(req, action, id, body);
    if (action !== "create") return reply(400, { ok: false, saved: false, code: "bad_action" });
    return await create(req, id, body);
  } catch (_) {
    return reply(503, { ok: false, saved: false, code: "db_error" });   // no details, no secrets
  }
}
Deno.serve(handle);
