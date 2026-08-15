import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createLeaseNote,
  LEASE_NOTE_MAX_LENGTH,
  leaseNoteActor,
  listLeaseNotes,
} from "@/lib/lease-notes";
import { requireStaffToken } from "@/lib/resman-api-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * The shared staff notes thread on a lease (manager app, pipeline detail
 * sheet).
 *
 *   GET  ?lease=<resman_lease_id> — the lease's thread, oldest first.
 *   POST { resmanLeaseId, body, unitNumber? } — append one note; attribution
 *        (name + role + admin id) comes from the token, like
 *        delinquency-actions.
 *
 * Rides on `manager:leases` on purpose: notes are part of the lease surface,
 * and a new capability would have signed every existing manager token out of
 * the thread (see app-role-capabilities on why PM rides on work-orders).
 */

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "manager:leases");
  if (!auth.ok) return auth.response;

  const lease = new URL(request.url).searchParams.get("lease")?.trim() ?? "";
  if (!lease || lease.length > 120) {
    return NextResponse.json({ error: "lease query parameter is required" }, { status: 400 });
  }

  try {
    const notes = await listLeaseNotes(createUntypedAdminClient(), lease);
    return NextResponse.json({ data: notes });
  } catch (error) {
    console.error("[resman-api manager/lease-notes] List error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

const CreateSchema = z.object({
  resmanLeaseId: z.string().trim().min(1).max(120),
  unitNumber: z.string().trim().max(60).optional(),
  body: z.string().trim().min(1).max(LEASE_NOTE_MAX_LENGTH),
});

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireStaffToken(request, "manager:leases");
  if (!auth.ok) return auth.response;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const note = await createLeaseNote(createUntypedAdminClient(), parsed.data, leaseNoteActor(auth));
    return NextResponse.json({ data: note }, { status: 201 });
  } catch (error) {
    console.error("[resman-api manager/lease-notes] Create error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
