// Upload to the repo root, then rename it to  netlify/functions/api.mjs  (see steps).
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const newRef = () => "MFC-" + crypto.randomBytes(5).toString("hex").toUpperCase();
const newTicket = () => { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return "MFC26-" + Array.from(crypto.randomBytes(8), b => A[b % 32]).join(""); };
const str = (v, min, max) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max;
const esc = (t) => String(t).replace(/[<>&"]/g, "");

async function staff(req, roles) {
  const jwt = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const { data } = await db.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: r } = await db.from("admin_users").select("role").eq("user_id", data.user.id).maybeSingle();
  return r && roles.includes(r.role) ? { id: data.user.id } : null;
}

async function sendEmail(o) {
  const { data: log } = await db.from("email_notifications").insert({ registration_id: o.registrationId, recipient: o.to, subject: o.subject, notification_type: o.type }).select("id").single();
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Seed of Christ Golden Church <admin@seedofchrist.org>", to: o.to, subject: o.subject, html: o.html }) });
    if (!r.ok) throw new Error(await r.text());
    await db.from("email_notifications").update({ delivery_status: "SENT", sent_at: new Date().toISOString(), attempts: 1 }).eq("id", log.id);
  } catch (e) { await db.from("email_notifications").update({ delivery_status: "FAILED", attempts: 1, error: String(e.message).slice(0, 400) }).eq("id", log.id); }
}

async function register(req) {
  const b = (await req.json().catch(() => null)) || {};
  const email = String(b.email || "").trim().toLowerCase();
  if (!str(b.full_name, 3, 120) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\+?[0-9\s-]{7,16}$/.test(String(b.phone || "").trim())
    || !["Male", "Female"].includes(b.gender) || !str(b.country, 2, 80) || !str(b.state, 2, 80) || !str(b.city, 2, 80) || b.consent !== true || b.terms !== true)
    return J({ error: "Please check your details and try again." }, 400);
  const mt = ["SOCGC", "OTHER"].includes(b.ministry_type) ? b.ministry_type : null;
  if (mt === "SOCGC" && !(str(b.branch_name, 2, 120) && str(b.branch_address, 3, 300)))
    return J({ error: "Branch and branch address are required for Seed of Christ Golden Church members." }, 400);
  const { data: ex } = await db.from("registrations").select("reference,payment_status").eq("email", email).neq("status", "CANCELLED").maybeSingle();
  if (ex) return J({ state: ex.payment_status === "PAID" ? "ALREADY_CONFIRMED" : "ALREADY_REGISTERED", reference: ex.reference }, 409);
  const { data, error } = await db.from("registrations").insert({
    full_name: b.full_name.trim(), email, phone: b.phone.trim(), gender: b.gender, country: b.country.trim(), state: b.state.trim(), city: b.city.trim(),
    church_affiliation: b.church_affiliation ? String(b.church_affiliation).slice(0, 150) : null,
    ministerial_designation: b.ministerial_designation ? String(b.ministerial_designation).slice(0, 100) : null,
    ministry_type: mt, branch_name: mt === "SOCGC" ? b.branch_name.trim() : null, branch_address: mt === "SOCGC" ? b.branch_address.trim() : null,
    reference: newRef(), consent_at: new Date().toISOString() }).select("reference").single();
  if (error) return J({ error: "Could not save your registration. Please try again." }, 500);
  return J({ reference: data.reference });
}

async function verify(req) {   // PUBLIC: status only, never personal data
  const ref = (new URL(req.url).searchParams.get("ref") || "").toUpperCase();
  if (!/^MFC-[0-9A-F]{10}$/.test(ref)) return J({ status: "INVALID" });
  const { data: r } = await db.from("registrations").select("payment_status,status").eq("reference", ref).maybeSingle();
  return J({ status: !r ? "INVALID" : r.status === "CANCELLED" ? "CANCELLED" : r.payment_status === "PAID" ? "PAID" : "AWAITING_PAYMENT" });
}

async function payments(req) {
  if (!(await staff(req, ["admin"]))) return J({ error: "Unauthorised" }, 401);
  const { data } = await db.from("registrations").select("reference,full_name,email,phone,state,city,ministry_type,church_affiliation,branch_name,branch_address,fee_ngn,payment_status,status,amount_received,bank_reference,approval_note,approved_at,created_at").order("created_at", { ascending: false }).limit(5000);
  return J({ rows: data ?? [] });
}

async function approve(req) {   // the ONLY way a registration becomes PAID
  const a = await staff(req, ["admin"]);
  if (!a) return J({ error: "Unauthorised" }, 401);
  const { reference, action, note, amount_received, bank_reference } = (await req.json().catch(() => null)) || {};
  const { data: r } = await db.from("registrations").select("id,full_name,email,reference,fee_ngn,payment_status").eq("reference", reference).maybeSingle();
  if (!r) return J({ error: "Not found" }, 404);
  if (action === "reject") {
    if (r.payment_status === "PAID") return J({ error: "Already paid" }, 409);
    await db.from("registrations").update({ payment_status: "REJECTED", approval_note: note ?? null, approved_by: a.id, approved_at: new Date().toISOString() }).eq("id", r.id);
    await db.from("admin_audit_logs").insert({ administrator_id: a.id, action: "REJECT_PAYMENT", affected_record: r.reference });
    return J({ ok: true });
  }
  if (!Number.isInteger(amount_received) || amount_received < r.fee_ngn) return J({ error: `Amount received must be at least N${r.fee_ngn}` }, 400);
  const { data: res } = await db.rpc("approve_payment", { p_reg: r.id, p_admin: a.id, p_ticket: newTicket(), p_note: note ?? null });
  if (res?.first_time) {
    await db.from("registrations").update({ amount_received, bank_reference: bank_reference ?? null, proof_received_at: new Date().toISOString() }).eq("id", r.id);
    await sendEmail({ to: r.email, type: "CONFIRMATION", registrationId: r.id, subject: "Your Minister's Fire Conference Registration Is Confirmed — THE MAJOR CALLING",
      html: `<h2>Hello ${esc(r.full_name)},</h2><p>Your payment has been received and confirmed. You are registered for the 2026 Fire Ministers Conference, 25th–27th November 2026, at Sebioba National Camp, Lagos–Ibadan Expressway, Lufuape, Ogun State.</p><p>Registration code: <b>${r.reference}</b></p><p>Your QR code on your e-flyer is now verified. Present it, or quote your registration code, at the venue.</p><p>Contact: admin@seedofchrist.org</p>` });
  }
  return J(res ?? { ok: false });
}

async function checkin(req) {
  const s = await staff(req, ["admin", "usher"]);
  if (!s) return J({ error: "Unauthorised" }, 401);
  const { scan } = (await req.json().catch(() => null)) || {};
  const m = String(scan || "").toUpperCase().match(/MFC-[0-9A-F]{10}/);
  if (!m) return J({ outcome: "INVALID" });
  const { data: r } = await db.from("registrations").select("id,payment_status,status").eq("reference", m[0]).maybeSingle();
  if (!r) return J({ outcome: "INVALID" });
  if (r.status === "CANCELLED") return J({ outcome: "CANCELLED" });
  if (r.payment_status !== "PAID") return J({ outcome: "PAYMENT_NOT_VERIFIED" });
  const { data: p } = await db.from("event_passes").select("ticket_number").eq("registration_id", r.id).maybeSingle();
  if (!p) return J({ outcome: "PAYMENT_NOT_VERIFIED" });
  const { data } = await db.rpc("check_in_pass", { p_ticket: p.ticket_number, p_usher: s.id });   // atomic: only one usher wins
  return J(data ?? { outcome: "INVALID" });
}

export default async (req) => {
  const p = new URL(req.url).pathname.replace(/^\/api/, "");
  try {
    if (p === "/register" && req.method === "POST") return await register(req);
    if (p === "/verify" && req.method === "GET") return await verify(req);
    if (p === "/admin/payments" && req.method === "GET") return await payments(req);
    if (p === "/admin/approve" && req.method === "POST") return await approve(req);
    if (p === "/checkin" && req.method === "POST") return await checkin(req);
    return J({ error: "Not found" }, 404);
  } catch (e) { console.error(e); return J({ error: "Server error. Please try again." }, 500); }
};
export const config = { path: "/api/*" };
