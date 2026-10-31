/**
 * Task ranking: which open tasks matter most right now.
 *
 * The Sturgeon Secretary's Ranking.gs (Email assistant project, secretary/Ranking.gs) scores
 * tasks with exactly these rules for the "Do first" list in the morning brief, so the brief and
 * the app agree. If you change a number or a rule here, change it there too.
 *
 * Ranking.gs also RAISES a task's priority when Karl keeps putting it off (one level after 3
 * days, to High after 7), missed tasks included. That happens in the sheet, so here it simply
 * shows up as a higher priority.
 */

import type { Priority, Task } from "../types";
import { addDays, dateFromKey, toLocalDateKey, weekIdFromDate } from "../utils";

export const DO_FIRST_COUNT = 10;
/** Undated reminders waiting longer than this, and tasks missed longer ago than this, are not ranked. */
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

function isRepeating(task: Task): boolean {
  return Boolean(task.repeatPattern && task.repeatPattern !== "none");
}

function seriesKey(task: Task): string {
  return task.originTaskId || task.id;
}

function isOpenTodo(task: Task): boolean {
  return !task.completed && !task.deleted && task.source !== "staff" && !isScheduleMarker(task);
}

/**
 * Open tasks on screen in the app: undated reminders, and dated tasks from this week's Monday
 * through a week from today.
 */
export function isOnScreen(task: Task, todayKey: string): boolean {
  if (!isOpenTodo(task)) return false;
  if (task.isGeneralReminder) return true;
  if (!task.specificDate) return false;
  const weekStart = weekIdFromDate(dateFromKey(todayKey));
  const horizon = toLocalDateKey(addDays(dateFromKey(todayKey), 7));
  return task.specificDate >= weekStart && task.specificDate <= horizon;
}

/**
 * Tasks Karl missed in an earlier week (up to 30 days back) that are still open. A repeating
 * chore's missed copy does not count once a newer copy exists: the new one replaces it.
 */
export function missedTasks(tasks: Task[], todayKey: string): Task[] {
  const weekStart = weekIdFromDate(dateFromKey(todayKey));
  const latest = new Map<string, string>();
  tasks.forEach((task) => {
    if (!isRepeating(task) || !task.specificDate || task.deleted) return;
    const key = seriesKey(task);
    if ((latest.get(key) || "") < task.specificDate) latest.set(key, task.specificDate);
  });
  return tasks.filter((task) => {
    if (!isOpenTodo(task) || !task.specificDate || task.specificDate >= weekStart) return false;
    if (daysBetween(task.specificDate, todayKey) > STALE_AFTER_DAYS) return false;
    return !(isRepeating(task) && (latest.get(seriesKey(task)) || "") > task.specificDate);
  });
}

/** Important enough to come back to the top: High (Ranking.gs raises missed tasks over time). */
export function isImportant(task: Task): boolean {
  return task.priority === "high";
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

export type RankedTask = { task: Task; score: number; why: string; missed: boolean };

function shortDay(dateKey: string): string {
  return dateFromKey(dateKey).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}

function whyLabel(task: Task, todayKey: string): string {
  if (task.specificDate) {
    const days = daysBetween(todayKey, task.specificDate);
    if (days < 0) return `missed ${shortDay(task.specificDate)}, ${-days} day${days === -1 ? "" : "s"} overdue`;
    if (days === 0) return "due today";
    if (days === 1) return "due tomorrow";
    return `due ${dateFromKey(task.specificDate).toLocaleDateString("en-US", { weekday: "short" })}`;
  }
  const age = ageDays(task, todayKey);
  return age <= 1 ? "new" : `waiting ${age} days`;
}

/**
 * The ranked list for the top of the page: the 10 highest-scoring tasks, plus every important
 * task that was missed (its day has passed) even if that makes the list longer. A repeating
 * task counts once (its earliest open copy on screen).
 */
export function rankTasks(
  tasks: Task[],
  todayKey: string,
  limit = DO_FIRST_COUNT
): { ranked: RankedTask[]; stale: number; total: number } {
  const onScreen = tasks.filter((task) => isOnScreen(task, todayKey));
  const firstOfSeries = new Map<string, Task>();
  onScreen.filter(isRepeating).forEach((task) => {
    const seen = firstOfSeries.get(seriesKey(task));
    if (!seen || (task.specificDate || "") < (seen.specificDate || "")) firstOfSeries.set(seriesKey(task), task);
  });
  const shown = onScreen.filter((task) => !isRepeating(task) || firstOfSeries.get(seriesKey(task)) === task);
  const fresh = shown.filter((task) => !isStale(task, todayKey));
  const fromEarlierWeeks = missedTasks(tasks, todayKey).filter(isImportant);
  const candidates = fresh.concat(fromEarlierWeeks).sort(importanceComparator(todayKey));
  const isMissed = (task: Task) => Boolean(task.specificDate && task.specificDate < todayKey);
  const picked = candidates.filter((task, index) => index < limit || (isMissed(task) && isImportant(task)));
  return {
    ranked: picked.map((task) => ({ task, score: taskScore(task, todayKey), why: whyLabel(task, todayKey), missed: isMissed(task) })),
    stale: shown.length - fresh.length,
    total: candidates.length,
  };
}

/** Ids of missed tasks shown in the Do first list, which come off their old day in the calendar views. */
export function movedToTopIds(tasks: Task[], todayKey: string): Set<string> {
  return new Set(rankTasks(tasks, todayKey).ranked.filter((r) => r.missed).map((r) => r.task.id));
}
