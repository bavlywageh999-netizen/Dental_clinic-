# Automatic booking: save -> email the patient -> notify the clinic on WhatsApp

Nothing here is live until you finish these steps. `index.html` ships with `AUTO_NOTIFY = false` (old behaviour keeps working).

1. **Admin check**: run `supabase_quick_fix.sql` (once). Then run `supabase_bookings.sql` (creates the `bookings` table; admins read/update status; nobody else can).
2. **Deploy the function**: Supabase > Edge Functions > *Deploy a new function* > name `submit-booking` > paste `supabase/functions/submit-booking/index.ts` > turn **Verify JWT OFF** (publishable keys are not JWTs) > Deploy. (CLI alternative: `supabase functions deploy submit-booking --no-verify-jwt`.)
3. **Email (Resend or similar)**: create an account, verify your sending domain, create an API key. Edge Functions > Secrets: `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `Dr. Tamer Fayez <bookings@yourdomain.com>`).
4. **WhatsApp notification to the clinic (Meta WhatsApp Cloud API)**: needs a Meta Business account, a WhatsApp Business phone number, an access token, and an **approved message template** (business-initiated messages require one) with 6 body variables in this order: {{1}} reference, {{2}} patient name, {{3}} treatment, {{4}} date, {{5}} time, {{6}} patient phone. Secrets: `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_TO` (clinic number, digits only, e.g. 201555687219), `WA_TEMPLATE`, `WA_TEMPLATE_LANG`.
5. Optional secrets: `CLINIC_NAME`, `CLINIC_PHONE`, `CLINIC_WHATSAPP`, `ALLOWED_ORIGIN` (your site address).
6. In `index.html` change `var AUTO_NOTIFY = false;` to `true`, then upload `index.html` and `admin.html`.
7. **Test with fake data only** (e.g. name "ZZ TEST", `test@yourdomain.com`): submit one booking and check separately: (a) a row in `bookings`, (b) the email arrives (Resend dashboard > Emails), (c) the WhatsApp message arrives on the clinic phone, (d) Admin > Appointments shows it with its status. If a provider is not set up the page says so; the booking is still saved.

"Accepted" means the provider took the message; it is not proof of delivery or that anyone read it. A new request is always "Requested"; only the clinic can set "Confirmed" in the dashboard.
Rollback: set `AUTO_NOTIFY` back to `false`; `drop table public.bookings;` only if you want the table gone.
