import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
export const db = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const sign = (t: string) => crypto.createHmac("sha256", process.env.QR_SIGNING_SECRET!).update(t).digest("base64url");
export const makeToken = (t: string) => `${t}.${sign(t)}`;  // QR holds only this: no personal data
export const readToken = (tok: string) => { const [t, s] = (tok || "").split("."); if (!t || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(sign(t)); return a.length === b.length && crypto.timingSafeEqual(a, b) ? t : null; };
export const newTicket = () => { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return "MFC26-" + Array.from(crypto.randomBytes(8), b => A[b % 32]).join(""); };
export const newRef = () => "MFC-" + crypto.randomBytes(5).toString("hex").toUpperCase();
export async function requireStaff(req: Request, roles = ["admin", "usher"]) {
  const jwt = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const { data } = await db().auth.getUser(jwt); if (!data.user) return null;
  const { data: row } = await db().from("admin_users").select("role").eq("user_id", data.user.id).maybeSingle();
  return row && roles.includes(row.role) ? { id: data.user.id, role: row.role } : null; }
export async function sendEmail(o: { to: string; subject: string; html: string; type: string; registrationId?: string }) {
  const { data: log } = await db().from("email_notifications").insert({ registration_id: o.registrationId, recipient: o.to, subject: o.subject, notification_type: o.type }).select("id").single();
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Seed of Christ Golden Church <admin@seedofchrist.org>", to: o.to, subject: o.subject, html: o.html }) });
    if (!r.ok) throw new Error(await r.text());
    await db().from("email_notifications").update({ delivery_status: "SENT", sent_at: new Date().toISOString(), attempts: 1 }).eq("id", log!.id);
  } catch (e: any) { await db().from("email_notifications").update({ delivery_status: "FAILED", attempts: 1, error: String(e.message).slice(0, 400) }).eq("id", log!.id); } }
