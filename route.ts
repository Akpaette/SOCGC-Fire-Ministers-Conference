// -> app/api/verify/route.ts  (PUBLIC; returns status only, never personal data)
import { NextResponse } from "next/server"; import { db } from "@/lib/server";
export async function GET(req: Request) {
  const ref = (new URL(req.url).searchParams.get("ref") || "").toUpperCase();
  if (!/^MFC-[0-9A-F]{10}$/.test(ref)) return NextResponse.json({ status: "INVALID" });
  const { data: r } = await db().from("registrations").select("payment_status,status").eq("reference", ref).maybeSingle();
  return NextResponse.json({ status: !r ? "INVALID" : r.status === "CANCELLED" ? "CANCELLED" : r.payment_status === "PAID" ? "PAID" : "AWAITING_PAYMENT" });
}
