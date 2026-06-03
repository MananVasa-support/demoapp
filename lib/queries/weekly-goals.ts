import "server-only";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { employees, weeklyGoals } from "@/db/schema";
import type { TaskPriority } from "@/db/enums";
import {
  periodStart,
  recentWeekStarts,
  type PerformerPeriod,
} from "@/lib/weekly-goals/week";

export interface WeeklyGoalRow {
  id: string;
  employeeId: string;
  employeeName: string;
  weekStart: string;
  position: number;
  client: string | null;
  subject: string | null;
  priority: TaskPriority;
  incentive: boolean;
  kpi: boolean;
  targetDone: string | null;
  pctDone: number;
  pctUpdatedAt: Date | null;
  explanation: string | null;
  linkUrl: string | null;
  carriedFromId: string | null;
  updatedAt: Date;
}

const ROW_SELECT = {
  id: weeklyGoals.id,
  employeeId: weeklyGoals.employeeId,
  employeeName: employees.name,
  weekStart: weeklyGoals.weekStart,
  position: weeklyGoals.position,
  client: weeklyGoals.client,
  subject: weeklyGoals.subject,
  priority: weeklyGoals.priority,
  incentive: weeklyGoals.incentive,
  kpi: weeklyGoals.kpi,
  targetDone: weeklyGoals.targetDone,
  pctDone: weeklyGoals.pctDone,
  pctUpdatedAt: weeklyGoals.pctUpdatedAt,
  explanation: weeklyGoals.explanation,
  linkUrl: weeklyGoals.linkUrl,
  carriedFromId: weeklyGoals.carriedFromId,
  updatedAt: weeklyGoals.updatedAt,
} as const;

/**
 * Goals for one employee in one week, in Sr.-No. order. This is the per-person
 * planner view (a doer editing their own week, or an admin scoped to one).
 */
export async function listWeeklyGoals(opts: {
  employeeId: string;
  weekStart: string;
}): Promise<WeeklyGoalRow[]> {
  return db
    .select(ROW_SELECT)
    .from(weeklyGoals)
    .innerJoin(employees, eq(weeklyGoals.employeeId, employees.id))
    .where(
      and(
        eq(weeklyGoals.employeeId, opts.employeeId),
        eq(weeklyGoals.weekStart, opts.weekStart),
      ),
    )
    .orderBy(asc(weeklyGoals.position), asc(weeklyGoals.createdAt));
}

/**
 * Every goal across all employees for one week — the admin's bird's-eye view.
 * Sorted by employee then Sr. No.
 */
export async function listGoalsForWeek(weekStart: string): Promise<WeeklyGoalRow[]> {
  return db
    .select(ROW_SELECT)
    .from(weeklyGoals)
    .innerJoin(employees, eq(weeklyGoals.employeeId, employees.id))
    .where(eq(weeklyGoals.weekStart, weekStart))
    .orderBy(asc(employees.name), asc(weeklyGoals.position));
}

export interface EmployeeRanking {
  employeeId: string;
  employeeName: string;
  goals: number;
  completed: number;
  avgPct: number;
}

/**
 * Leaderboard for a period (this week / this month / YTD). Averages % done over
 * every goal whose week falls in the window, ranked best-first. Only employees
 * with ≥1 goal in the window appear.
 */
export async function employeeRankings(
  period: PerformerPeriod,
  now: Date = new Date(),
): Promise<EmployeeRanking[]> {
  const start = periodStart(period, now);
  const rows = await db
    .select({
      employeeId: weeklyGoals.employeeId,
      employeeName: employees.name,
      goals: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${weeklyGoals.pctDone} >= 100)::int`,
      avgPct: sql<number>`coalesce(round(avg(${weeklyGoals.pctDone}))::int, 0)`,
    })
    .from(weeklyGoals)
    .innerJoin(employees, eq(weeklyGoals.employeeId, employees.id))
    .where(gte(weeklyGoals.weekStart, start))
    .groupBy(weeklyGoals.employeeId, employees.name)
    .orderBy(
      desc(sql`avg(${weeklyGoals.pctDone})`),
      desc(sql`count(*) filter (where ${weeklyGoals.pctDone} >= 100)`),
    );
  return rows;
}

/** Single top performer for a period, or null if nobody set a goal. */
export async function performerOf(
  period: PerformerPeriod,
  now: Date = new Date(),
): Promise<EmployeeRanking | null> {
  const ranked = await employeeRankings(period, now);
  return ranked[0] ?? null;
}

export interface WeekTrendPoint {
  weekStart: string;
  avgPct: number;
  goals: number;
}

/**
 * Per-week average % done over the last `weeks` weeks. When `employeeId` is
 * given, scoped to that person; otherwise org-wide. Weeks with no goals are
 * emitted as 0 so the chart shows a continuous timeline.
 */
export async function weekWiseTrend(opts: {
  weeks: number;
  employeeId?: string;
  now?: Date;
}): Promise<WeekTrendPoint[]> {
  const now = opts.now ?? new Date();
  const span = recentWeekStarts(Math.max(1, opts.weeks), now);
  const earliest = span[0]!;

  const where = opts.employeeId
    ? and(gte(weeklyGoals.weekStart, earliest), eq(weeklyGoals.employeeId, opts.employeeId))
    : gte(weeklyGoals.weekStart, earliest);

  const rows = await db
    .select({
      weekStart: weeklyGoals.weekStart,
      avgPct: sql<number>`coalesce(round(avg(${weeklyGoals.pctDone}))::int, 0)`,
      goals: sql<number>`count(*)::int`,
    })
    .from(weeklyGoals)
    .where(where)
    .groupBy(weeklyGoals.weekStart);

  const byWeek = new Map(rows.map((r) => [r.weekStart, r]));
  return span.map((weekStart) => {
    const hit = byWeek.get(weekStart);
    return {
      weekStart,
      avgPct: hit?.avgPct ?? 0,
      goals: hit?.goals ?? 0,
    };
  });
}

/** Active employees (incl. interns) for the person selector. */
export async function listGoalEmployees(): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: employees.id, name: employees.name })
    .from(employees)
    .where(eq(employees.isActive, true))
    .orderBy(asc(employees.name));
}
