# Automatic booking (Submit -> save -> email the patient -> notify the clinic) - setup and safe testing

Nothing is live until you finish this. `index.html` ships with `AUTO_NOTIFY = false` and `TURNSTILE_SITEKEY = ""`.
In that state the new **Submit** button still works: it saves the request (as before) and the toast honestly says that e-mail and automatic WhatsApp are not active yet.

## 1. Database (SQL Editor, in this order; each is additive)
1. `supabase_quick_fix.sql` (admin check `public.is_admin()` + `public.admins`)
2. `supabase_bookings.sql` (bookings table; only admins can read it or change its status)
3. `supabase_bookings_security.sql` (hashed-IP column and retry counters the hardened function needs)

## 2. CAPTCHA (Cloudflare Turnstile, free)
Cloudflare dashboard > Turnstile > Add site > your website's domain > keep the **Managed** widget. Copy the **Site key** (public) and the **Secret key** (private).

## 3. Deploy the function
Supabase > Edge Functions > Deploy a new function > name exactly `submit-booking` > paste `supabase/functions/submit-booking/index.ts` > turn **Verify JWT OFF** > Deploy.
(Why off: your public key is not a JWT. The function does its own checks: CAPTCHA + limits for new bookings; booking token or verified admin login for everything else.)

## 4. Secrets (Edge Functions > Secrets). Never put these in the website files.
| Secret | Value |
|---|---|
| `BOOKING_SECRET` | a long random string, 32+ characters (e.g. run `openssl rand -base64 48`). Signs patient access tokens and hashes IP addresses. **Required.** |
| `TURNSTILE_SECRET_KEY` | the Turnstile secret key. **Required** (or set `REQUIRE_CAPTCHA=0` to run without a CAPTCHA: not recommended) |
| `RESEND_API_KEY`, `EMAIL_FROM` | your email provider key (Resend) and the address, e.g. `bookings@yourdomain.com` (domain must be verified at the provider). The sender name shown to patients is "Dr. Tamer Fayez Clinic - Appointment confirmation email" (change with `EMAIL_FROM_NAME`). |
| `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_TEMPLATE`, `WA_TEMPLATE_LANG`, `WA_TO` | Meta WhatsApp Cloud API. The template must have 6 body variables: {{1}} reference, {{2}} patient name, {{3}} treatment, {{4}} date, {{5}} time, {{6}} patient phone. `WA_TO` = clinic number, digits only (default 201556277801). |
| `ALLOWED_ORIGIN` | your website address, e.g. `https://yourname.github.io` (recommended) |
| optional | `EMAIL_ENGLISH_COPY=0` (Arabic-only emails), `CLINIC_NAME`, `CLINIC_PHONE`, `CLINIC_WHATSAPP`, `RL_IP_HOUR`(10) `RL_IP_DAY`(30) `RL_EMAIL_HOUR`(3) `RL_EMAIL_DAY`(6) `RL_GLOBAL_HOUR`(100) `RL_GLOBAL_DAY`(400) |
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase automatically.

## 5. Test the function BEFORE switching the website on (Terminal; fake data only; replace the placeholders)
Every command below must be REFUSED. `ID` can be any UUID.
```
URL=https://YOUR-PROJECT.supabase.co/functions/v1/submit-booking ; ID=$(uuidgen)
curl -s -X POST $URL -H 'Content-Type: application/json' -d "{\"action\":\"status\",\"id\":\"$ID\"}"          # expect 403 forbidden
curl -s -X POST $URL -H 'Content-Type: application/json' -d "{\"action\":\"retry\",\"id\":\"$ID\"}"           # expect 403 forbidden
curl -s -X POST $URL -H 'Content-Type: application/json' -d "{\"action\":\"create\",\"id\":\"$ID\",\"name\":\"ZZ TEST\",\"email\":\"test@example.com\",\"phone\":\"01012345678\",\"service\":\"Teeth whitening\",\"date\":\"2030-01-06\",\"time\":\"4:00 pm\"}"   # expect 403 captcha_required
```
Then in Supabase Table Editor confirm `bookings` has no new row. Also confirm in the Supabase logs that no secret value is printed.

## 6. Switch the website on
In `index.html` set `var TURNSTILE_SITEKEY = "your-site-key";` and `var AUTO_NOTIFY = true;`, upload `index.html` and `admin.html`.
Submit ONE booking with fake data (name "ZZ TEST", an inbox you own) and check separately: (a) a row in `bookings` (Admin > Appointments), (b) the email arrives (and looks like the Arabic template), (c) the WhatsApp message reaches the clinic phone, (d) Admin > Appointments shows it as "Requested". Delete the test row only as admin.

## What "sent" means
The toast says the email "was sent" only when the email provider accepted it; delivery to the inbox is not guaranteed. Clinic WhatsApp is reported as notified only when the WhatsApp API accepted the message (it does not prove anyone read it). A new request is always "Requested"; only the clinic can set "Confirmed" in the dashboard.
## Rollback
Set `AUTO_NOTIFY` back to `false` and re-upload `index.html`. The new SQL only adds things; `supabase_bookings_security.sql` has its own rollback line.
