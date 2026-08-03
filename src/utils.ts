import type { DailyEvents, Priority, Task } from "./types";

const RESERVED_TITLES = new Set(["title", "task", "completed", "id", "true", "false"]);

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function toLocalDateKey(date: Date): string {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = local.getTimezoneOffset() * 60_000;
  return new Date(local.getTime() - offset).toISOString().slice(0, 10);
}

export function startOfWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = copy.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + mondayOffset);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function weekIdFromDate(date: Date): string {
  return toLocalDateKey(startOfWeek(date));
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function dateFromKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function dateKeyForWeekDay(weekId: string, dayOfWeek: number): string {
  return toLocalDateKey(addDays(dateFromKey(weekId), Math.max(1, Math.min(7, dayOfWeek)) - 1));
}

export function dailyEventKey(weekId: string, dayOfWeek: number): string {
  return `${weekId}-${Math.max(1, Math.min(7, dayOfWeek))}`;
}

export function eventKeyFromIsoDate(dateKey: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const date = dateFromKey(dateKey);
  const monday = startOfWeek(date);
  const diff = Math.round((date.getTime() - monday.getTime()) / 86_400_000);
  return `${toLocalDateKey(monday)}-${diff + 1}`;
}

export function formatShortDate(dateKey: string): string {
  return dateFromKey(dateKey).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatLongDate(dateKey: string): string {
  return dateFromKey(dateKey).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function parseBoolean(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
}

export function normalizePriority(value: unknown): Priority {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") return normalized;
  return "medium";
}

export function isInvalidTitle(value: unknown): boolean {
  const title = String(value ?? "").trim().toLowerCase();
  return !title || RESERVED_TITLES.has(title);
}

export function getTaskDate(task: Task): string {
  return task.specificDate || dateKeyForWeekDay(task.weekId, task.dayOfWeek);
}

export function todayStr(): string {
  return toLocalDateKey(new Date());
}

export function isTaskBeforeToday(task: Task, today = todayStr()): boolean {
  return getTaskDate(task) < today;
}

export function sanitizeTasks(tasks: Task[]): Task[] {
  const today = todayStr();
  return tasks
    .filter((task) => !isInvalidTitle(task.title))
    .filter((task) => !task.deleted)
    .filter((task) => !isTaskBeforeToday(task, today))
    .map((task) => ({
      ...task,
      dayOfWeek: Math.max(1, Math.min(7, Number(task.dayOfWeek) || 1)),
      completed: Boolean(task.completed),
      priority: normalizePriority(task.priority),
      repeatPattern: task.repeatPattern || "none",
      updatedAt: task.updatedAt || Date.now(),
    }));
}

export function sanitizeDailyEvents(events: DailyEvents): DailyEvents {
  const today = todayStr();
  return Object.fromEntries(
    Object.entries(events)
      .filter(([key, note]) => {
        if (!String(note || "").trim()) return false;
        const iso = key.match(/^(\d{4}-\d{2}-\d{2})(?:-[1-7])?$/)?.[1];
        return Boolean(iso && iso >= today);
      })
      .map(([key, note]) => [key, String(note).trim()])
  );
}

export function deduplicateTasks(tasks: Task[]): Task[] {
  const seen = new Map<string, Task>();
  for (const task of tasks) {
    const stableId = task.originTaskId || task.id;
    const key = `${stableId}|${task.weekId}|${task.dayOfWeek}`;
    const existing = seen.get(key);
    if (!existing || (task.updatedAt || 0) >= (existing.updatedAt || 0)) {
      seen.set(key, task);
    }
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.weekId !== b.weekId) return a.weekId.localeCompare(b.weekId);
    if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
    return a.title.localeCompare(b.title);
  });
}

export function currency(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value || 0);
}
