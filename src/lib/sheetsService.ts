import type { Bill, CategoryOption, DailyEvents, OperationsSnapshot, StaffMember, Task } from "../types";
import {
  dateKeyForWeekDay,
  deduplicateTasks,
  eventKeyFromIsoDate,
  isInvalidTitle,
  isIsoDateKey,
  makeId,
  normalizePriority,
  parseBoolean,
  sanitizeBills,
  sanitizeDailyEvents,
  sanitizeTasks,
  todayStr,
  toLocalDateKey,
  weekIdFromDate,
} from "../utils";
import {
  BILL_COLUMNS,
  CATEGORY_COLUMNS,
  columnReader,
  DAILY_COLUMNS,
  LEGACY_BILL_COLUMNS,
  STAFF_COLUMNS,
  STAFF_ROSTER_COLUMNS,
  STAFF_TODO_COLUMNS,
  TASK_COLUMNS,
} from "./sheetSchema";
import { isKarlAssignee } from "./ui";

/** Trimmed value at a resolved column index; "" when the column is absent. */
function cellAt(row: readonly string[], index: number): string {
  if (index < 0) return "";
  return String(row[index] ?? "").trim();
}

export const DEFAULT_PRIVATE_SHEET_ID = "1NQKvTSWvpTZ3uRsYWMUPAdOa_bHvsp_VMpc7EX1c_tI";
export const DEFAULT_STAFF_TODOS_SHEET_ID = "1TsSonscE_UZ9A80tLSVxdnKQx_udYWGWQejTPh17wtg";
export const APPS_SCRIPT_SYNC_FUNCTION = "/.netlify/functions/sheets-sync";
const SYNC_REQUEST_TIMEOUT_MS = 50_000;

export type AppsScriptSyncConfig = {
  privateSheetId: string;
  staffTodosSheetId: string;
  publicStaffSheetId: string;
};

type AppsScriptRows = {
  taskTab?: string;
  tasks?: string[][];
  dailyEvents?: string[][];
  categories?: string[][];
  bills?: string[][];
  staff?: string[][];
  todos?: string[][];
};

type AppsScriptPullResponse = {
  ok?: boolean;
  private?: AppsScriptRows;
  staff?: AppsScriptRows;
  error?: string;
  message?: string;
};

const WITH_FALLBACK = { fallback: true } as const;

export function parseTasks(rows: string[][]): Task[] {
  const column = columnReader(TASK_COLUMNS, rows[0]);
  const at = {
    id: column.index("id", WITH_FALLBACK),
    title: column.index("title", WITH_FALLBACK),
    category: column.index("category", WITH_FALLBACK),
    description: column.index("description", WITH_FALLBACK),
    dayOfWeek: column.index("dayOfWeek", WITH_FALLBACK),
    completed: column.index("completed", WITH_FALLBACK),
    weekId: column.index("weekId", WITH_FALLBACK),
    repeatsWeekly: column.index("repeatsWeekly", WITH_FALLBACK),
    repeatPattern: column.index("repeatPattern", WITH_FALLBACK),
    originTaskId: column.index("originTaskId", WITH_FALLBACK),
    deleted: column.index("deleted", WITH_FALLBACK),
    reminderDate: column.index("reminderDate", WITH_FALLBACK),
    assignee: column.index("assignee", WITH_FALLBACK),
    priority: column.index("priority", WITH_FALLBACK),
    shiftHours: column.index("shiftHours", WITH_FALLBACK),
    updatedAt: column.index("updatedAt", WITH_FALLBACK),
  };

  let lastScheduledWeekId = "";

  return rows
    .slice(1)
    .filter((row) => !isInvalidTitle(cellAt(row, at.title)))
    .filter(
      (row) => !cellAt(row, at.id).startsWith("auto-def-") && !cellAt(row, at.originTaskId).startsWith("def-")
    )
    .map((row) => {
      const dayOfWeek = Math.max(1, Math.min(7, Number(cellAt(row, at.dayOfWeek) || 1)));
      const repeatsWeekly = parseBoolean(cellAt(row, at.repeatsWeekly));
      const rawRepeatPattern = cellAt(row, at.repeatPattern);
      const repeatPattern: Task["repeatPattern"] =
        rawRepeatPattern === "weekly" || rawRepeatPattern === "biweekly" || rawRepeatPattern === "monthly"
          ? rawRepeatPattern
          : repeatsWeekly
            ? "weekly"
            : "none";
      const rawWeekCell = cellAt(row, at.weekId);
      const rawWeekId = isIsoDateKey(rawWeekCell) ? rawWeekCell : "";
      if (rawWeekId) lastScheduledWeekId = rawWeekId;
      const rawReminderCell = cellAt(row, at.reminderDate);
      const reminderDate = isIsoDateKey(rawReminderCell) ? rawReminderCell : undefined;
      const legacyNumericWeekValue = /^[1-7]$/.test(rawWeekCell);
      const weekId = rawWeekId || (legacyNumericWeekValue ? lastScheduledWeekId : "");
      const specificDate = weekId ? dateKeyForWeekDay(weekId, dayOfWeek) : undefined;
      const needsSheetRepair = legacyNumericWeekValue || Boolean(rawReminderCell && !reminderDate);
      return {
        id: cellAt(row, at.id) || makeId("task"),
        title: cellAt(row, at.title),
        category: cellAt(row, at.category) || "Production",
        description: cellAt(row, at.description),
        dayOfWeek,
        completed: parseBoolean(cellAt(row, at.completed)),
        weekId,
        repeatsWeekly: repeatsWeekly || repeatPattern !== "none",
        repeatPattern,
        originTaskId: cellAt(row, at.originTaskId) || undefined,
        deleted: parseBoolean(cellAt(row, at.deleted)),
        specificDate,
        reminderDate,
        specificDateWasExplicit: false,
        assignee: cellAt(row, at.assignee) || undefined,
        priority: normalizePriority(cellAt(row, at.priority)),
        shiftHours: cellAt(row, at.shiftHours) || undefined,
        updatedAt: Number(cellAt(row, at.updatedAt) || Date.now()),
        source: "private" as const,
        isGeneralReminder: !specificDate && repeatPattern === "none",
        needsSheetRepair,
      };
    });
}

export function parseTodos(rows: string[][]): Task[] {
  const todayKey = todayStr();
  const column = columnReader(STAFF_TODO_COLUMNS, rows[0]);
  const at = {
    id: column.index("id", WITH_FALLBACK),
    title: column.index("title", WITH_FALLBACK),
    category: column.index("category", WITH_FALLBACK),
    completed: column.index("completed", WITH_FALLBACK),
    createdBy: column.index("createdBy", WITH_FALLBACK),
    createdAt: column.index("createdAt", WITH_FALLBACK),
    updatedAt: column.index("updatedAt", WITH_FALLBACK),
    dueDate: column.index("dueDate", WITH_FALLBACK),
    assignee: column.index("assignee", WITH_FALLBACK),
    proof: column.index("proof", WITH_FALLBACK),
    originTaskId: column.index("originTaskId", WITH_FALLBACK),
    priority: column.index("priority", WITH_FALLBACK),
    shiftHours: column.index("shiftHours", WITH_FALLBACK),
  };

  return rows
    .slice(1)
    .filter((row) => !isInvalidTitle(cellAt(row, at.title)))
    .filter((row) => !cellAt(row, at.id).startsWith("kwtm-"))
    .map((row) => {
      const completed = parseBoolean(cellAt(row, at.completed));
      const rawDueDate = cellAt(row, at.dueDate);
      const hasExplicitDate = isIsoDateKey(rawDueDate);
      const sourceDate = hasExplicitDate ? rawDueDate : todayKey;
      const taskDate = !completed && sourceDate < todayKey ? todayKey : sourceDate;
      const date = new Date(`${taskDate}T12:00:00`);
      const day = date.getDay();
      const dayOfWeek = day === 0 ? 7 : day;
      const monday = new Date(date);
      monday.setDate(date.getDate() - dayOfWeek + 1);
      const weekId = toLocalDateKey(monday);
      const rawPriority = cellAt(row, at.priority).toLowerCase();
      const priority: Task["priority"] = rawPriority === "high" ? "high" : rawPriority === "low" ? "low" : "medium";
      const assignee = cellAt(row, at.assignee) || undefined;
      const isKarlTodo = isKarlAssignee(assignee);
      const createdBy = cellAt(row, at.createdBy);
      const proof = cellAt(row, at.proof);
      const rawId = cellAt(row, at.id);
      const descriptionParts = [
        createdBy ? `Added by ${createdBy}` : "",
        rawDueDate && rawDueDate !== taskDate ? `Original todo date: ${rawDueDate}` : "",
        proof ? `Proof: ${proof}` : "",
      ].filter(Boolean);

      return {
        id: rawId ? `staff-${rawId}` : makeId("staff"),
        title: cellAt(row, at.title),
        description: ["Staff/general todo", ...descriptionParts].join(". "),
        dayOfWeek,
        completed,
        priority,
        category: cellAt(row, at.category) || "Staff Todos",
        weekId,
        repeatsWeekly: false,
        repeatPattern: "none",
        originTaskId: cellAt(row, at.originTaskId) || undefined,
        deleted: false,
        specificDate: hasExplicitDate || isKarlTodo ? taskDate : undefined,
        updatedAt: Date.parse(cellAt(row, at.updatedAt) || cellAt(row, at.createdAt) || "") || Date.now(),
        assignee,
        shiftHours: cellAt(row, at.shiftHours) || undefined,
        source: "staff",
        isGeneralReminder: false,
      } satisfies Task;
    });
}

function parseDailyEvents(rows: string[][]): DailyEvents {
  const column = columnReader(DAILY_COLUMNS, rows[0]);
  const keyAt = column.index("key", WITH_FALLBACK);
  const textAt = column.index("text", WITH_FALLBACK);
  const deletedAt = column.index("deleted");

  const events: DailyEvents = {};
  rows.slice(1).forEach((row) => {
    if (deletedAt >= 0 && parseBoolean(cellAt(row, deletedAt))) return;
    const rawKey = cellAt(row, keyAt);
    const note = cellAt(row, textAt);
    if (!rawKey || !note) return;
    const key = normalizeDailyEventKey(rawKey);
    if (key) events[key] = events[key] ? `${events[key]}\n${note}` : note;
  });
  return sanitizeDailyEvents(events);
}

function normalizeDailyEventKey(rawKey: string): string | null {
  const legacyWeeklyKey = rawKey.match(/^(\d{4}-\d{2}-\d{2})-([1-7])$/);
  if (legacyWeeklyKey) return dateKeyForWeekDay(legacyWeeklyKey[1], Number(legacyWeeklyKey[2]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawKey)) return eventKeyFromIsoDate(rawKey);

  const usDate = rawKey.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!usDate) return null;

  const [, month, day, year] = usDate;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  return toLocalDateKey(date);
}

function parseCategories(rows: string[][]): CategoryOption[] {
  const column = columnReader(CATEGORY_COLUMNS, rows[0]);
  const at = {
    id: column.index("id", WITH_FALLBACK),
    name: column.index("name", WITH_FALLBACK),
    color: column.index("color", WITH_FALLBACK),
  };

  return rows
    .slice(1)
    .filter((row) => cellAt(row, at.name))
    .map((row) => {
      const name = cellAt(row, at.name);
      return {
        id: cellAt(row, at.id) || name.toLowerCase().replace(/\s+/g, "-"),
        name,
        color: cellAt(row, at.color) || "slate",
      };
    });
}

export function parseBills(rows: string[][]): Bill[] {
  // Sheets written before the payee/frequency columns existed use a different order, so
  // pick the canonical layout from the header row before resolving positions.
  const headerRow = rows[0];
  const isModernLayout = columnReader(BILL_COLUMNS, headerRow).hasHeader("title");
  const column = columnReader(isModernLayout ? BILL_COLUMNS : LEGACY_BILL_COLUMNS, headerRow);

  const at = {
    id: column.index("id", WITH_FALLBACK),
    name: column.index(["title", "name"], WITH_FALLBACK),
    amount: column.index("amount", WITH_FALLBACK),
    dueDate: column.index("dueDate", WITH_FALLBACK),
    category: column.index("category", WITH_FALLBACK),
    status: column.index("status", WITH_FALLBACK),
    recurring: column.index("recurring", WITH_FALLBACK),
    updatedAt: column.index("updatedAt", WITH_FALLBACK),
    // Header-only: an absent column means the data does not exist, so never guess a position.
    payee: column.index("payee"),
    frequency: column.index("frequency"),
    autoPay: column.index("autoPay"),
    paymentAccount: column.index("paymentAccount"),
    notes: column.index("notes"),
    deleted: column.index("deleted"),
  };

  return sanitizeBills(
    rows
      .slice(1)
      .filter((row) => cellAt(row, at.name))
      .map((row) => {
        const frequency = cellAt(row, at.frequency);
        const status = cellAt(row, at.status);
        return {
          id: cellAt(row, at.id) || makeId("bill"),
          name: cellAt(row, at.name),
          payee: cellAt(row, at.payee) || undefined,
          amount: Number(cellAt(row, at.amount).replace(/[$,]/g, "")) || 0,
          dueDate: cellAt(row, at.dueDate),
          paid: parseBoolean(status) || status.toLowerCase() === "paid",
          category: cellAt(row, at.category) || undefined,
          recurring:
            parseBoolean(cellAt(row, at.recurring)) || (frequency ? frequency.toLowerCase() !== "one-time" : false),
          frequency: frequency || undefined,
          status: status || undefined,
          autoPay: at.autoPay >= 0 ? parseBoolean(cellAt(row, at.autoPay)) : undefined,
          paymentAccount: cellAt(row, at.paymentAccount) || undefined,
          notes: cellAt(row, at.notes) || undefined,
          updatedAt: Number(cellAt(row, at.updatedAt) || Date.now()),
          deleted: parseBoolean(cellAt(row, at.deleted)),
        };
      })
  );
}

function parseStaff(rows: string[][]): StaffMember[] {
  const column = columnReader(STAFF_COLUMNS, rows[0]);
  const at = {
    id: column.index("id", WITH_FALLBACK),
    name: column.index("name", WITH_FALLBACK),
    role: column.index("role", WITH_FALLBACK),
    email: column.index("email", WITH_FALLBACK),
    phone: column.index("phone", WITH_FALLBACK),
    color: column.index("color", WITH_FALLBACK),
  };

  return rows
    .slice(1)
    .filter((row) => cellAt(row, at.name))
    .map((row) => {
      const name = cellAt(row, at.name);
      return {
        id: cellAt(row, at.id) || name.toLowerCase().replace(/\s+/g, "-"),
        name,
        role: cellAt(row, at.role) || "Staff",
        email: cellAt(row, at.email) || undefined,
        phone: cellAt(row, at.phone) || undefined,
        color: cellAt(row, at.color) || "slate",
      };
    });
}

export function parseStaffRoster(rows: string[][]): StaffMember[] {
  const column = columnReader(STAFF_ROSTER_COLUMNS, rows[0]);
  const at = {
    email: column.index("email", WITH_FALLBACK),
    name: column.index("name", WITH_FALLBACK),
    manager: column.index("manager", WITH_FALLBACK),
  };

  return rows
    .slice(1)
    .filter((row) => cellAt(row, at.name) || cellAt(row, at.email))
    .map((row, index) => {
      const email = cellAt(row, at.email);
      const isManager = parseBoolean(cellAt(row, at.manager));
      return {
        id: email || `staff-roster-${index}`,
        name: cellAt(row, at.name) || email,
        role: isManager ? "Manager" : "Staff",
        email: email || undefined,
        color: isManager ? "violet" : "sky",
      };
    });
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function isLocalHostname(): boolean {
  const hostname = typeof window === "undefined" ? "" : window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

async function syncFunctionFetch<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS);
  let response: Response;
  let text: string;

  try {
    response = await fetch(APPS_SCRIPT_SYNC_FUNCTION, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Sheet sync timed out after ${Math.round(SYNC_REQUEST_TIMEOUT_MS / 1000)} seconds.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  let data: { ok?: boolean; error?: string; message?: string };
  try {
    data = JSON.parse(text);
  } catch {
    if (isLocalHostname()) {
      throw new Error("Sheet sync is not available from this local Vite server. Use the deployed Netlify site or run with Netlify Dev.");
    }
    throw new Error(`Sheet sync endpoint returned ${response.status || "a non-JSON response"}. Refresh the page and sign in again if prompted.`);
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.message || response.statusText || "Sheet sync failed.");
  }

  return data as T;
}

export function mergeDailyEventSets(...eventSets: DailyEvents[]): DailyEvents {
  const merged: DailyEvents = {};
  const tombstoneKeys = new Set<string>();
  eventSets.forEach((events) => {
    Object.entries(events).forEach(([key, value]) => {
      if (tombstoneKeys.has(key)) return;

      const lines = String(value)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (!lines.length) {
        if (!Object.prototype.hasOwnProperty.call(merged, key)) {
          merged[key] = "";
          tombstoneKeys.add(key);
        }
        return;
      }

      const current = new Set((merged[key] || "").split("\n").filter(Boolean));
      lines.forEach((line) => current.add(line));
      merged[key] = Array.from(current).join("\n");
    });
  });
  return sanitizeDailyEvents(merged);
}

function mergeStaffLists(primary: StaffMember[], secondary: StaffMember[]): StaffMember[] {
  const byKey = new Map<string, StaffMember>();
  [...primary, ...secondary].forEach((person) => {
    const key = (person.email || person.name).toLowerCase();
    if (!byKey.has(key)) byKey.set(key, person);
  });
  return Array.from(byKey.values());
}

export async function pullAppsScriptSnapshot(
  config: AppsScriptSyncConfig,
  fallback: OperationsSnapshot
): Promise<OperationsSnapshot> {
  const data = await syncFunctionFetch<AppsScriptPullResponse>("pull", { config });
  const privateRows = data.private || {};
  const staffRows = data.staff || {};
  const privateTaskRows = privateRows.tasks || [];
  const privateTaskTab = String(privateRows.taskTab || "");

  const privateSnapshot: OperationsSnapshot = {
    tasks: privateTaskRows.length
      ? deduplicateTasks(
          sanitizeTasks(privateTaskTab.toLowerCase() === "todos" ? parseTodos(privateTaskRows) : parseTasks(privateTaskRows))
        )
      : fallback.tasks,
    dailyEvents: privateRows.dailyEvents?.length ? parseDailyEvents(privateRows.dailyEvents) : fallback.dailyEvents,
    categories: privateRows.categories?.length ? parseCategories(privateRows.categories) : fallback.categories,
    bills: privateRows.bills?.length ? parseBills(privateRows.bills) : fallback.bills,
    staff: privateRows.staff?.length ? parseStaff(privateRows.staff) : fallback.staff,
  };

  const staffSnapshot: Pick<OperationsSnapshot, "tasks" | "dailyEvents" | "staff"> = {
    tasks: staffRows.todos?.length ? deduplicateTasks(sanitizeTasks(parseTodos(staffRows.todos))) : [],
    dailyEvents: staffRows.dailyEvents?.length ? parseDailyEvents(staffRows.dailyEvents) : {},
    staff: staffRows.staff?.length ? parseStaffRoster(staffRows.staff) : [],
  };

  return {
    ...privateSnapshot,
    tasks: deduplicateTasks(sanitizeTasks([...privateSnapshot.tasks, ...staffSnapshot.tasks])),
    dailyEvents: privateSnapshot.dailyEvents,
    staffDailyEvents: staffSnapshot.dailyEvents,
    staff: mergeStaffLists(privateSnapshot.staff, staffSnapshot.staff),
  };
}

export async function pushAppsScriptOperations(config: AppsScriptSyncConfig, snapshot: OperationsSnapshot): Promise<void> {
  await syncFunctionFetch("pushOperations", { config, snapshot });
}

export async function pushAppsScriptStaffTodos(config: AppsScriptSyncConfig, tasks: Task[]): Promise<void> {
  await syncFunctionFetch("pushStaffTodos", { config, tasks });
}

export async function pushAppsScriptStaffSchedule(
  config: AppsScriptSyncConfig,
  weekId: string,
  tasks: Task[],
  staff: StaffMember[]
): Promise<void> {
  await syncFunctionFetch("pushStaffSchedule", { config, weekId, tasks, staff });
}
