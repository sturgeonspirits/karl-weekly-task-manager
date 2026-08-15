import type { Bill, DailyEvents, Priority, Task } from "./types";

const RESERVED_TITLES = new Set(["title", "task", "completed", "id", "true", "false"]);
export const SOFT_DELETE_RETENTION_DAYS = 90;
const SOFT_DELETE_RETENTION_MS = SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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

export function isIsoDateKey(value?: string): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export function dateKeyForWeekDay(weekId: string, dayOfWeek: number): string {
  return toLocalDateKey(addDays(dateFromKey(weekId), Math.max(1, Math.min(7, dayOfWeek)) - 1));
}

export function eventKeyFromIsoDate(dateKey: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  return dateKey;
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

export const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function compareTasksByPriority(a: Task, b: Task): number {
  if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
  if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority]) {
    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  }
  return a.title.localeCompare(b.title);
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
  if (task.isGeneralReminder) return false;
  return getTaskDate(task) < today;
}

export function isRecurringTask(task: Task): boolean {
  return Boolean(
    task.repeatsWeekly ||
      task.repeatPattern === "weekly" ||
      task.repeatPattern === "biweekly" ||
      task.repeatPattern === "monthly"
  );
}

export function shouldRetainSoftDeletedRecord(record: { deleted?: boolean; updatedAt?: number }, now = Date.now()): boolean {
  if (!record.deleted) return true;
  const updatedAt = Number(record.updatedAt || 0);
  return !updatedAt || now - updatedAt <= SOFT_DELETE_RETENTION_MS;
}

function normalizedRepeatPattern(task: Task): Task["repeatPattern"] {
  if (task.repeatPattern === "weekly" || task.repeatPattern === "biweekly" || task.repeatPattern === "monthly") {
    return task.repeatPattern;
  }
  return task.repeatsWeekly ? "weekly" : "none";
}

function stableRecurringId(task: Task): string {
  return task.originTaskId || task.id.replace(/^auto-/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function generatedOccurrenceWeekId(task: Task): string | undefined {
  const match = task.id.match(/^auto-.+-(\d{4}-\d{2}-\d{2})$/);
  return isIsoDateKey(match?.[1]) ? match[1] : undefined;
}

function weekDistance(startWeekId: string, targetWeekId: string): number {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.round((dateFromKey(targetWeekId).getTime() - dateFromKey(startWeekId).getTime()) / msPerWeek);
}

function isLastWeekdayOfMonth(date: Date): boolean {
  const nextWeek = addDays(date, 7);
  return nextWeek.getMonth() !== date.getMonth();
}

function weekdayOrdinalInMonth(date: Date): number {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

function monthlyTaskFallsOnWeek(task: Task, targetWeekId: string): boolean {
  const anchorDate = dateFromKey(dateKeyForWeekDay(task.weekId, task.dayOfWeek));
  const targetDate = dateFromKey(dateKeyForWeekDay(targetWeekId, task.dayOfWeek));
  const monthDistance =
    (targetDate.getFullYear() - anchorDate.getFullYear()) * 12 + targetDate.getMonth() - anchorDate.getMonth();

  if (monthDistance < 0 || anchorDate.getDay() !== targetDate.getDay()) return false;
  if (isLastWeekdayOfMonth(anchorDate)) return isLastWeekdayOfMonth(targetDate);
  return weekdayOrdinalInMonth(anchorDate) === weekdayOrdinalInMonth(targetDate);
}

function recurringTaskFallsOnWeek(task: Task, targetWeekId: string): boolean {
  if (!isRecurringTask(task) || !isIsoDateKey(task.weekId) || !isIsoDateKey(targetWeekId)) return false;
  const distance = weekDistance(task.weekId, targetWeekId);
  if (distance < 0) return false;
  if (task.repeatPattern === "biweekly") return distance % 2 === 0;
  if (task.repeatPattern === "monthly") return monthlyTaskFallsOnWeek(task, targetWeekId);
  return true;
}

export function ensureRecurringTasksForWeek(tasks: Task[], targetWeekId: string): Task[] {
  if (!isIsoDateKey(targetWeekId)) return tasks;

  const existingKeys = new Set(tasks.map((task) => `${stableRecurringId(task)}|${task.weekId}|${task.dayOfWeek}`));
  const existingOccurrenceWeeks = new Set<string>();
  tasks.forEach((task) => {
    const stableId = stableRecurringId(task);
    if (isIsoDateKey(task.weekId)) existingOccurrenceWeeks.add(`${stableId}|${task.weekId}`);
    const generatedWeekId = generatedOccurrenceWeekId(task);
    if (generatedWeekId) existingOccurrenceWeeks.add(`${stableId}|${generatedWeekId}`);
  });
  const templates = new Map<string, Task>();

  tasks.forEach((task) => {
    if (!recurringTaskFallsOnWeek(task, targetWeekId)) return;
    const key = stableRecurringId(task);
    const existing = templates.get(key);
    if (
      !existing ||
      task.weekId.localeCompare(existing.weekId) > 0 ||
      (task.weekId === existing.weekId && (task.updatedAt || 0) > (existing.updatedAt || 0))
    ) {
      templates.set(key, task);
    }
  });

  const generated = Array.from(templates.values())
    .filter(
      (task) =>
        !existingKeys.has(`${stableRecurringId(task)}|${targetWeekId}|${task.dayOfWeek}`) &&
        !existingOccurrenceWeeks.has(`${stableRecurringId(task)}|${targetWeekId}`)
    )
    .map((task) => {
      const originTaskId = stableRecurringId(task);
      return {
        ...task,
        id: `auto-${originTaskId}-${targetWeekId}`,
        weekId: targetWeekId,
        completed: false,
        deleted: false,
        originTaskId,
        specificDate: dateKeyForWeekDay(targetWeekId, task.dayOfWeek),
        reminderDate: undefined,
        specificDateWasExplicit: false,
        isGeneralReminder: false,
        updatedAt: Date.now(),
      };
    });

  return generated.length ? deduplicateTasks([...tasks, ...generated]) : tasks;
}

export function sanitizeTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => !isInvalidTitle(task.title))
    .map((task): Task | null => {
      const source = task.source || (task.id.startsWith("staff-") ? "staff" : "private");
      const repeatPattern = normalizedRepeatPattern(task);
      const repeatsWeekly = Boolean(task.repeatsWeekly || repeatPattern !== "none");
      const rawWeekId = isIsoDateKey(task.weekId) ? task.weekId : undefined;
      let dayOfWeek = Math.max(1, Math.min(7, Number(task.dayOfWeek) || 1));
      const importedSpecificDate = isIsoDateKey(task.specificDate) ? task.specificDate : undefined;
      const hasExplicitSpecificDate = Boolean(task.specificDateWasExplicit && importedSpecificDate);
      const reminderDate =
        isIsoDateKey(task.reminderDate)
          ? task.reminderDate
          : source === "private" && !rawWeekId && !hasExplicitSpecificDate
            ? importedSpecificDate
            : undefined;
      let specificDate = source === "private" && !hasExplicitSpecificDate ? undefined : importedSpecificDate;
      const specificDateWasExplicit = Boolean(hasExplicitSpecificDate);

      // An undated reminder is given the current week below purely so it has a weekId to
      // sort by. That stamp must never be read back as a schedule on a later pass, or the
      // reminder turns into a Monday task -- sanitizeTasks runs on every state change, so
      // it would happen within a second of loading. Recurring tasks are excluded because
      // repeating implies a schedule, which is what makes them not reminders.
      const staysUndated = source === "private" && Boolean(task.isGeneralReminder) && !repeatsWeekly;

      if (source === "private" && rawWeekId && !staysUndated && !hasExplicitSpecificDate) {
        specificDate = dateKeyForWeekDay(rawWeekId, dayOfWeek);
      }

      if (specificDate) {
        const day = dateFromKey(specificDate).getDay();
        dayOfWeek = day === 0 ? 7 : day;
      }

      const weekId = specificDate ? weekIdFromDate(dateFromKey(specificDate)) : rawWeekId || weekIdFromDate(new Date());
      const isGeneralReminder = source === "staff" ? false : Boolean(!specificDate && (task.isGeneralReminder || !repeatsWeekly));

      return {
        ...task,
        weekId,
        specificDate,
        dayOfWeek,
        completed: Boolean(task.completed),
        priority: normalizePriority(task.priority),
        repeatsWeekly,
        repeatPattern,
        source,
        isGeneralReminder,
        reminderDate,
        specificDateWasExplicit,
        needsSheetRepair: Boolean(task.needsSheetRepair),
        updatedAt: task.updatedAt || Date.now(),
      };
    })
    .filter((task): task is Task => task !== null)
    .filter((task) => shouldRetainSoftDeletedRecord(task));
}

export function sanitizeBills(bills: Bill[]): Bill[] {
  return bills
    .map((bill): Bill => ({
      ...bill,
      name: String(bill.name || "").trim(),
      payee: bill.payee || undefined,
      amount: Number(bill.amount || 0),
      dueDate: bill.dueDate || "",
      paid: Boolean(bill.paid),
      recurring: Boolean(bill.recurring || (bill.frequency && bill.frequency.toLowerCase() !== "one-time")),
      deleted: Boolean(bill.deleted),
      updatedAt: bill.updatedAt || Date.now(),
    }))
    .filter((bill) => Boolean(bill.name && isIsoDateKey(bill.dueDate)))
    .filter((bill) => shouldRetainSoftDeletedRecord(bill));
}

export function sanitizeDailyEvents(events: DailyEvents): DailyEvents {
  const normalized = new Map<string, string[]>();

  Object.entries(events).forEach(([key, note]) => {
    const cleanNote = String(note || "").trim();

    let dateKey: string | null = null;
    const legacyWeeklyKey = key.match(/^(\d{4}-\d{2}-\d{2})-([1-7])$/);
    if (legacyWeeklyKey) {
      dateKey = dateKeyForWeekDay(legacyWeeklyKey[1], Number(legacyWeeklyKey[2]));
    } else if (isIsoDateKey(key)) {
      dateKey = key;
    }

    if (!dateKey) return;
    normalized.set(dateKey, [...(normalized.get(dateKey) || []), cleanNote]);
  });

  return Object.fromEntries(
    Array.from(normalized.entries()).map(([key, notes]) => {
      const cleanNotes = notes.filter(Boolean);
      return [key, Array.from(new Set(cleanNotes)).join("\n")];
    })
  );
}

export function deduplicateTasks(tasks: Task[]): Task[] {
  const seen = new Map<string, Task>();
  for (const task of tasks) {
    const stableId = task.originTaskId || task.id;
    const key = `${stableId}|${task.weekId}|${task.dayOfWeek}`;
    const existing = seen.get(key);
    const taskIsCanonical = Boolean(task.weekId && task.id.endsWith(task.weekId));
    const existingIsCanonical = Boolean(existing?.weekId && existing.id.endsWith(existing.weekId));
    if (
      !existing ||
      (task.updatedAt || 0) > (existing.updatedAt || 0) ||
      ((task.updatedAt || 0) === (existing.updatedAt || 0) && taskIsCanonical && !existingIsCanonical)
    ) {
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
