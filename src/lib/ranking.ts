/**
 * Task ranking: which open tasks matter most right now.
 *
 * The Sturgeon Secretary's Ranking.gs (Email assistant project, secretary/Ranking.gs) scores
 * tasks with exactly these rules for the "Do first" list in the morning brief, so the brief and
 * the app agree. If you change a number or a rule here, change it there too.
 *
 * Ranking.gs also RAISES a task's priority when Karl keeps putting it off (one level after 3
 * days, to High after 7). That happens in the sheet, so here it simply shows up as a higher
 * priority.
 */

import type { Priority, Task } from "../types";
import { addDays, dateFromKey, toLocalDateKey, weekIdFromDate } from "../utils";

export const DO_FIRST_COUNT = 10;
export const STALE_AFTER_DAYS = 30;

/** Schedule markers, not to-dos (Ranking.gs: Settings "Never rank"). Matched at the start of the title. */
export const SCHEDULE_MARKERS = ["tasting room open", "bloody mary bar"];

const POINTS: Record<Priority, number> = { high: 60, medium: 35, low: 15 };

function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000);
}

/** When the task was made: the app and the secretary both stamp a 13-digit time into ids. */
export function taskCreatedAt(task: Pick<Task, "id" | "updatedAt">): number {
  const match = String(task.id).match(/(?:^|-)(\d{13})/);
  const stamp = match ? Number(match[1]) : 0;
  if (stamp > 1_500_000_000_000 && stamp < Date.now() + 86_400_000) return stamp;
  return Number(task.updatedAt) || 0;
}

/** Days an undated task has been waiting. */
function ageDays(task: Task, todayKey: string): number {
  const created = taskCreatedAt(task);
  if (!created) return 0;
  return Math.max(0, daysBetween(toLocalDateKey(new Date(created)), todayKey));
}

export function isScheduleMarker(task: Pick<Task, "title">): boolean {
  const title = task.title.trim().toLowerCase();
  return SCHEDULE_MARKERS.some((marker) => title.startsWith(marker));
}

/**
 * Open tasks Karl can actually see: undated reminders, and dated tasks from this week's
 * Monday through a week from today. Unticked tasks from earlier weeks are left out; they sit
 * behind the weekly grid's "Move Earlier" button and are usually done or dropped.
 */
export function isRankable(task: Task, todayKey: string): boolean {
  if (task.completed || task.deleted || task.source === "staff" || isScheduleMarker(task)) return false;
  if (task.isGeneralReminder) return true;
  if (!task.specificDate) return false;
  const weekStart = weekIdFromDate(dateFromKey(todayKey));
  const horizon = toLocalDateKey(addDays(dateFromKey(todayKey), 7));
  return task.specificDate >= weekStart && task.specificDate <= horizon;
}

/** An undated reminder that has waited more than 30 days: listed apart rather than ranked. */
export function isStale(task: Task, todayKey: string): boolean {
  return !task.specificDate && ageDays(task, todayKey) > STALE_AFTER_DAYS;
}

/** Bigger is more important. */
export function taskScore(task: Task, todayKey: string): number {
  let score = POINTS[task.priority] ?? POINTS.medium;
  if (task.specificDate) {
    const days = daysBetween(todayKey, task.specificDate);
    if (days < 0) score += Math.min(50, 10 + 4 * -days);
    else if (days === 0) score += 30;
    else if (days === 1) score += 18;
    else if (days <= 3) score += 8;
    else if (days > 7) score -= 15;
  } else {
    score += Math.min(30, 3 * Math.max(0, ageDays(task, todayKey) - 2));
  }
  return score;
}

/** Done last, then most important first, then the one waiting longest, then by title. */
export function compareTasksByImportance(a: Task, b: Task, todayKey: string): number {
  if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
  const byScore = taskScore(b, todayKey) - taskScore(a, todayKey);
  if (byScore) return byScore;
  const byAge = (taskCreatedAt(a) || Infinity) - (taskCreatedAt(b) || Infinity);
  if (byAge) return byAge;
  return a.title.localeCompare(b.title);
}

export function importanceComparator(todayKey: string): (a: Task, b: Task) => number {
  return (a, b) => compareTasksByImportance(a, b, todayKey);
}

export type RankedTask = { task: Task; score: number; why: string };

function whyLabel(task: Task, todayKey: string): string {
  const parts: string[] = [];
  if (task.specificDate) {
    const days = daysBetween(todayKey, task.specificDate);
    if (days < 0) parts.push(`${-days} day${days === -1 ? "" : "s"} overdue`);
    else if (days === 0) parts.push("due today");
    else if (days === 1) parts.push("due tomorrow");
    else parts.push(`due ${dateFromKey(task.specificDate).toLocaleDateString("en-US", { weekday: "short" })}`);
  } else {
    const age = ageDays(task, todayKey);
    parts.push(age <= 1 ? "new" : `waiting ${age} days`);
  }
  return parts.join(", ");
}

/**
 * The ranked list for the top of the page. A repeating task counts once (its earliest open
 * copy), so last Monday's and next Monday's "Clean Distillery" don't take two places.
 */
export function rankTasks(tasks: Task[], todayKey: string, limit = DO_FIRST_COUNT): { ranked: RankedTask[]; stale: number; total: number } {
  const rankable = tasks.filter((task) => isRankable(task, todayKey));
  const firstOfSeries = new Map<string, Task>();
  rankable
    .filter((task) => task.repeatPattern && task.repeatPattern !== "none")
    .forEach((task) => {
      const key = task.originTaskId || task.id;
      const seen = firstOfSeries.get(key);
      if (!seen || (task.specificDate || "") < (seen.specificDate || "")) firstOfSeries.set(key, task);
    });
  const candidates = rankable.filter((task) => {
    if (!task.repeatPattern || task.repeatPattern === "none") return true;
    return firstOfSeries.get(task.originTaskId || task.id) === task;
  });
  const fresh = candidates.filter((task) => !isStale(task, todayKey));
  const sorted = fresh.slice().sort(importanceComparator(todayKey));
  return {
    ranked: sorted.slice(0, limit).map((task) => ({ task, score: taskScore(task, todayKey), why: whyLabel(task, todayKey) })),
    stale: candidates.length - fresh.length,
    total: fresh.length,
  };
}
