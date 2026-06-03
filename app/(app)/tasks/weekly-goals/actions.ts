"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { db } from "@/lib/db";
import { weeklyGoals } from "@/db/schema";
import { CACHE_TAGS } from "@/lib/cache-tags";
import { requireUser } from "@/lib/auth/current";
import { rateLimitOrError } from "@/lib/rate-limit";
import { mondayOf, nextWeekStart } from "@/lib/weekly-goals/week";
import {
  CreateWeeklyGoalSchema,
  type CreateWeeklyGoalInput,
  EditWeeklyGoalSchema,
  type EditWeeklyGoalInput,
  SetPctDoneSchema,
  type SetPctDoneInput,
  CarryOverSchema,
  type CarryOverInput,
  DeleteWeeklyGoalSchema,
} from "@/lib/validators/weekly-goal";

type ActionOk<T> = T extends undefined ? { ok: true } : { ok: true } & T;
type ActionResult<T = undefined> = ActionOk<T> | { ok: false; error: string };

function revalidateWeeklyGoals() {
  revalidatePath("/tasks/weekly-goals");
  revalidatePath("/tasks/weekly-goals/dashboard");
  updateTag(CACHE_TAGS.weeklyGoals);
}

/** Next Sr. No. for an (employee, week) — max(position)+1, 1-based. */
async function nextPosition(employeeId: string, weekStart: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${weeklyGoals.position}), 0)::int` })
    .from(weeklyGoals)
    .where(
      and(eq(weeklyGoals.employeeId, employeeId), eq(weeklyGoals.weekStart, weekStart)),
    );
  return (row?.max ?? 0) + 1;
}

/**
 * Fetch a goal + decide whether the signed-in user may write it.
 * Owners (the goal's employee) and admins may edit; nobody else.
 */
type LoadResult =
  | { ok: false; error: string }
  | { ok: true; row: typeof weeklyGoals.$inferSelect };

async function loadWritableGoal(
  id: string,
  me: { id: string; isAdmin: boolean },
): Promise<LoadResult> {
  const [row] = await db.select().from(weeklyGoals).where(eq(weeklyGoals.id, id)).limit(1);
  if (!row) return { ok: false, error: "Goal not found" };
  if (!me.isAdmin && row.employeeId !== me.id) {
    return { ok: false, error: "You can only edit your own weekly goals" };
  }
  return { ok: true, row };
}

/**
 * Create one weekly-goal row. Non-admins can only file goals against
 * themselves; admins can file against anyone. The week is snapped to its
 * Monday defensively. Used by the fast-add row (one submit = one priority).
 */
export async function createWeeklyGoal(
  input: CreateWeeklyGoalInput,
): Promise<ActionResult<{ id: string }>> {
  const me = await requireUser();
  const limited = rateLimitOrError(me.id, "write");
  if (limited) return limited;

  const parsed = CreateWeeklyGoalSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  // Owner enforcement: a non-admin may only target their own row.
  const employeeId = me.isAdmin ? data.employeeId : me.id;
  const weekStart = mondayOf(data.weekStart);

  try {
    const position = await nextPosition(employeeId, weekStart);
    const [row] = await db
      .insert(weeklyGoals)
      .values({
        employeeId,
        weekStart,
        position,
        client: data.client,
        subject: data.subject,
        priority: data.priority,
        incentive: data.incentive,
        kpi: data.kpi,
        targetDone: data.targetDone,
        explanation: data.explanation,
        linkUrl: data.linkUrl,
        createdById: me.id,
        updatedById: me.id,
      })
      .returning({ id: weeklyGoals.id });
    if (!row) return { ok: false, error: "Insert returned no row" };
    revalidateWeeklyGoals();
    return { ok: true, id: row.id };
  } catch (err) {
    return { ok: false, error: `DB: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Edit a goal's content fields (client/subject/priority/flags/notes). */
export async function editWeeklyGoal(
  input: EditWeeklyGoalInput,
): Promise<ActionResult> {
  const me = await requireUser();
  const parsed = EditWeeklyGoalSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;

  const loaded = await loadWritableGoal(id, me);
  if (!loaded.ok) return loaded;

  // Only write the keys actually provided so a partial edit doesn't clobber.
  const patch: Record<string, unknown> = { updatedById: me.id, updatedAt: new Date() };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) patch[k] = v;
  }

  try {
    await db.update(weeklyGoals).set(patch).where(eq(weeklyGoals.id, id));
    revalidateWeeklyGoals();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `DB: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Set "% Done (Actual)". Owner enters it; admin (Manan) can overwrite. We
 * snapshot who moved it + when so the dashboard can show provenance.
 */
export async function setWeeklyGoalPct(
  input: SetPctDoneInput,
): Promise<ActionResult> {
  const me = await requireUser();
  const parsed = SetPctDoneSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid percentage" };
  }
  const loaded = await loadWritableGoal(parsed.data.id, me);
  if (!loaded.ok) return loaded;

  try {
    await db
      .update(weeklyGoals)
      .set({
        pctDone: parsed.data.pctDone,
        pctUpdatedById: me.id,
        pctUpdatedAt: new Date(),
        updatedById: me.id,
        updatedAt: new Date(),
      })
      .where(eq(weeklyGoals.id, parsed.data.id));
    revalidateWeeklyGoals();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `DB: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Carry a goal forward into a later week WITHOUT touching the original — used
 * when a priority wasn't finished, was only partly done, or simply repeats.
 * Writes a fresh row in the target week linked back via `carriedFromId`.
 */
export async function carryOverWeeklyGoal(
  input: CarryOverInput,
): Promise<ActionResult<{ id: string }>> {
  const me = await requireUser();
  const parsed = CarryOverSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const loaded = await loadWritableGoal(parsed.data.id, me);
  if (!loaded.ok) return loaded;
  const src = loaded.row;

  const toWeek = parsed.data.toWeekStart
    ? mondayOf(parsed.data.toWeekStart)
    : nextWeekStart(src.weekStart);

  try {
    const position = await nextPosition(src.employeeId, toWeek);
    const [row] = await db
      .insert(weeklyGoals)
      .values({
        employeeId: src.employeeId,
        weekStart: toWeek,
        position,
        client: src.client,
        subject: src.subject,
        priority: src.priority,
        incentive: src.incentive,
        kpi: src.kpi,
        targetDone: src.targetDone,
        explanation: src.explanation,
        linkUrl: src.linkUrl,
        pctDone: parsed.data.keepProgress ? src.pctDone : 0,
        carriedFromId: src.id,
        createdById: me.id,
        updatedById: me.id,
      })
      .returning({ id: weeklyGoals.id });
    if (!row) return { ok: false, error: "Insert returned no row" };
    revalidateWeeklyGoals();
    return { ok: true, id: row.id };
  } catch (err) {
    return { ok: false, error: `DB: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function deleteWeeklyGoal(input: { id: string }): Promise<ActionResult> {
  const me = await requireUser();
  const parsed = DeleteWeeklyGoalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid id" };

  const loaded = await loadWritableGoal(parsed.data.id, me);
  if (!loaded.ok) return loaded;

  try {
    await db.delete(weeklyGoals).where(eq(weeklyGoals.id, parsed.data.id));
    revalidateWeeklyGoals();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `DB: ${err instanceof Error ? err.message : String(err)}` };
  }
}
