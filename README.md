# Minister's Fire Conference 2026: manual bank-transfer version
Flow: register -> pay N10,000 to First Bank 3032670285 -> send proof on WhatsApp -> admin approves -> QR pass emailed -> usher scans.
Install: 1) run supabase/schema.sql  2) npm i zod @supabase/supabase-js  3) copy lib/server.ts to src/lib/  4) copy each api/*/route.ts to the path in its first-line comment
5) add env vars in Netlify (mark secrets)  6) verify seedofchrist.org in Resend (SPF, DKIM, DMARC)  7) add staff via Supabase Auth, then insert into admin_users(user_id, role).
Page: registration-page.html. Change its submit handler to POST the form to /api/register and show the returned reference.
Still to build: pass page + PDF/QR rendering, admin approval screen, scanner UI, CSV export, reminders, resend-email button.
Test: duplicate email, approve twice (one pass), unapproved scan (PAYMENT_NOT_VERIFIED), double scan from two phones, email from admin@seedofchrist.org.

Branches: schema adds ministry_type/branch_name/branch_address (required when SOCGC) and a branch_directory view for export. The e-flyer is built in the browser; photos are never uploaded.

## v4: e-flyer QR, payment tracking
- E-flyer: flyer is the blurred background; carries photo, name, registration code and a QR (verify URL + code, no personal data). Set VERIFY_BASE in public/ministers-fire/index.html.
- Payment authentication: QR opens verify.html (public, status only: Payment verified / Awaiting / Not recognised). Staff check-in (api/checkin) admits only PAID codes, once.
- Tracking: public/ministers-fire/admin.html (fill SUPABASE_URL and anon key). Totals, search, filter, Approve (records amount + bank ref; must be >= fee) / Reject, CSV export. All actions audited.
- Deploy: files under public/ministers-fire/ go in your site's public folder; api/*/route.ts per first-line comments. Re-run the new ALTER statements at the end of schema.sql.
- Not yet built: the usher scanner screen (api/checkin is ready), reminders, resend-email button.
