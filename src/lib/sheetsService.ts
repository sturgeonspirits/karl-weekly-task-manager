import type { Bill, CategoryOption, DailyEvents, OperationsSnapshot, StaffMember, Task } from "../types";
import {
  dateKeyForWeekDay,
  deduplicateTasks,
  eventKeyFromIsoDate,
  isInvalidTitle,
  isIsoDateKey,
  normalizePriority,
  parseBoolean,
  sanitizeBills,
  sanitizeDailyEvents,
  sanitizeTasks,
  todayStr,
  toLocalDateKey,
  weekIdFromDate,
} from "../utils";

export const DEFAULT_PRIVATE_SHEET_ID = "1NQKvTSWvpTZ3uRsYWMUPAdOa_bHvsp_VMpc7EX1c_tI";
export const DEFAULT_STAFF_TODOS_SHEET_ID = "1TsSonscE_UZ9A80tLSVxdnKQx_udYWGWQejTPh17wtg";
export const APPS_SCRIPT_SYNC_FUNCTION = "/.netlify/functions/sheets-sync";

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

const TASK_HEADERS = [
  "id",
  "title",
  "category",
  "description",
  "dayOfWeek",
  "completed",
  "weekId",
  "repeatsWeekly",
  "repeatPattern",
  "originTaskId",
  "deleted",
  "reminderDate",
  "assignee",
  "priority",
  "shiftHours",
  "updatedAt",
];

const DAILY_HEADERS = ["key", "text", "updatedAt", "deleted"];
const CATEGORY_HEADERS = ["id", "name", "color"];
const BILL_HEADERS = [
  "id",
  "title",
  "payee",
  "amount",
  "dueDate",
  "frequency",
  "category",
  "status",
  "autoPay",
  "paymentAccount",
  "notes",
  "updatedAt",
  "deleted",
];
const STAFF_HEADERS = ["id", "name", "role", "email", "phone", "color"];
const STAFF_SCHEDULE_HEADERS = [
  "weekId",
  "dayOfWeek",
  "date",
  "assignee",
  "role",
  "shiftHours",
  "taskTitle",
  "category",
  "priority",
  "completed",
];

function isKarlAssigneeValue(value?: string): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "karl" || normalized === "karl loewenstein" || normalized.startsWith("karl@");
}

async function sheetsFetch<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || response.statusText || "Google Sheets request failed.";
    throw new Error(message);
  }
  return payload as T;
}

export function extractSpreadsheetId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([^/]+)/);
  return match?.[1] || trimmed;
}

function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

async function getSheetTitles(spreadsheetId: string, accessToken: string): Promise<string[]> {
  const data = await sheetsFetch<{ sheets?: Array<{ properties?: { title?: string } }> }>(
    `${spreadsheetId}?fields=sheets.properties.title`,
    accessToken
  );
  return (data.sheets || []).map((sheet) => sheet.properties?.title || "").filter(Boolean);
}

async function readValues(spreadsheetId: string, accessToken: string, sheetName: string): Promise<string[][]> {
  const range = `${quoteSheet(sheetName)}!A:Z`;
  const data = await sheetsFetch<{ values?: string[][] }>(
    `${spreadsheetId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
    accessToken
  );
  return data.values || [];
}

async function ensureSheets(spreadsheetId: string, accessToken: string, titles: string[]): Promise<void> {
  const existing = new Set(await getSheetTitles(spreadsheetId, accessToken));
  const missing = titles.filter((title) => !existing.has(title));
  if (!missing.length) return;

  await sheetsFetch(`${spreadsheetId}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      requests: missing.map((title) => ({
        addSheet: { properties: { title } },
      })),
    }),
  });
}

async function overwriteSheets(
  spreadsheetId: string,
  accessToken: string,
  sheets: Array<{ name: string; values: unknown[][] }>
): Promise<void> {
  await ensureSheets(
    spreadsheetId,
    accessToken,
    sheets.map((sheet) => sheet.name)
  );

  await sheetsFetch(`${spreadsheetId}/values:batchClear`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      ranges: sheets.map((sheet) => `${quoteSheet(sheet.name)}!A:Z`),
    }),
  });

  await sheetsFetch(`${spreadsheetId}/values:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: sheets.map((sheet) => ({
        range: `${quoteSheet(sheet.name)}!A1`,
        majorDimension: "ROWS",
        values: sheet.values,
      })),
    }),
  });
}

function pickTab(tabs: string[], names: string[]): string | null {
  const normalized = new Map(tabs.map((tab) => [tab.trim().toLowerCase(), tab]));
  for (const name of names) {
    const found = normalized.get(name.toLowerCase());
    if (found) return found;
  }
  return null;
}

function parseTasks(rows: string[][]): Task[] {
  let lastScheduledWeekId = "";

  return rows
    .slice(1)
    .filter((row) => !isInvalidTitle(row[1]))
    .filter((row) => !String(row[0] || "").startsWith("auto-def-") && !String(row[9] || "").startsWith("def-"))
    .map((row) => {
      const dayOfWeek = Math.max(1, Math.min(7, Number(row[4] || 1)));
      const repeatsWeekly = parseBoolean(row[7]);
      const repeatPattern: Task["repeatPattern"] =
        row[8] === "weekly" || row[8] === "biweekly" || row[8] === "monthly" ? row[8] : repeatsWeekly ? "weekly" : "none";
      const rawWeekCell = String(row[6] || "").trim();
      const rawWeekId = isIsoDateKey(rawWeekCell) ? rawWeekCell : "";
      if (rawWeekId) lastScheduledWeekId = rawWeekId;
      const rawReminderCell = String(row[11] || "").trim();
      const reminderDate = isIsoDateKey(rawReminderCell) ? rawReminderCell : undefined;
      const legacyNumericWeekValue = /^[1-7]$/.test(rawWeekCell);
      const weekId = rawWeekId || (legacyNumericWeekValue ? lastScheduledWeekId : "");
      const specificDate = weekId ? dateKeyForWeekDay(weekId, dayOfWeek) : undefined;
      const needsSheetRepair = legacyNumericWeekValue || Boolean(rawReminderCell && !reminderDate);
      return {
        id: row[0] || crypto.randomUUID(),
        title: row[1] || "",
        category: row[2] || "Production",
        description: row[3] || "",
        dayOfWeek,
        completed: parseBoolean(row[5]),
        weekId,
        repeatsWeekly: repeatsWeekly || repeatPattern !== "none",
        repeatPattern,
        originTaskId: row[9] || undefined,
        deleted: parseBoolean(row[10]),
        specificDate,
        reminderDate,
        specificDateWasExplicit: false,
        assignee: row[12] || undefined,
        priority: normalizePriority(row[13]),
        shiftHours: row[14] || undefined,
        updatedAt: Number(row[15] || Date.now()),
        source: "private" as const,
        isGeneralReminder: !specificDate && repeatPattern === "none",
        needsSheetRepair,
      };
    });
}

function parseTodos(rows: string[][]): Task[] {
  const todayKey = todayStr();
  return rows
    .slice(1)
    .filter((row) => !isInvalidTitle(row[1]))
    .filter((row) => !String(row[0] || "").startsWith("kwtm-"))
    .map((row) => {
      const completed = parseBoolean(row[3]);
      const hasExplicitDate = /^\d{4}-\d{2}-\d{2}$/.test(row[8] || "");
      const sourceDate = hasExplicitDate ? row[8] : todayKey;
      const taskDate = !completed && sourceDate < todayKey ? todayKey : sourceDate;
      const date = new Date(`${taskDate}T12:00:00`);
      const day = date.getDay();
      const dayOfWeek = day === 0 ? 7 : day;
      const monday = new Date(date);
      monday.setDate(date.getDate() - dayOfWeek + 1);
      const weekId = toLocalDateKey(monday);
      const rawPriority = String(row[13] || "").toLowerCase();
      const priority: Task["priority"] = rawPriority === "high" ? "high" : rawPriority === "low" ? "low" : "medium";
      const assignee = row[10] || undefined;
      const isKarlTodo = isKarlAssigneeValue(assignee);
      const descriptionParts = [
        row[4] ? `Added by ${row[4]}` : "",
        row[8] && row[8] !== taskDate ? `Original todo date: ${row[8]}` : "",
        row[11] ? `Proof: ${row[11]}` : "",
      ].filter(Boolean);

      return {
        id: row[0] ? `staff-${row[0]}` : crypto.randomUUID(),
        title: row[1] || "",
        description: ["Staff/general todo", ...descriptionParts].join(". "),
        dayOfWeek,
        completed,
        priority,
        category: row[2] || "Staff Todos",
        weekId,
        repeatsWeekly: false,
        repeatPattern: "none",
        originTaskId: row[12] || undefined,
        deleted: false,
        specificDate: hasExplicitDate || isKarlTodo ? taskDate : undefined,
        updatedAt: Date.parse(row[7] || row[5] || "") || Date.now(),
        assignee,
        shiftHours: row[14] || undefined,
        source: "staff",
        isGeneralReminder: false,
      } satisfies Task;
    });
}

function parseDailyEvents(rows: string[][]): DailyEvents {
  const headers = (rows[0] || []).map((header) => String(header || "").trim().toLowerCase());
  const deletedIndex = headers.indexOf("deleted");
  const events: DailyEvents = {};
  rows.slice(1).forEach((row) => {
    if (deletedIndex >= 0 && parseBoolean(row[deletedIndex])) return;
    const rawKey = String(row[0] || "").trim();
    const note = String(row[1] || "").trim();
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
  return rows
    .slice(1)
    .filter((row) => row[1])
    .map((row) => ({
      id: row[0] || row[1].toLowerCase().replace(/\s+/g, "-"),
      name: row[1],
      color: row[2] || "slate",
    }));
}

function parseBills(rows: string[][]): Bill[] {
  const headers = (rows[0] || []).map((header) => String(header || "").trim().toLowerCase());
  const indexOf = (name: string, fallback: number) => {
    const index = headers.indexOf(name);
    return index >= 0 ? index : fallback;
  };
  const idIndex = indexOf("id", 0);
  const nameIndex = headers.includes("title") ? indexOf("title", 1) : indexOf("name", 1);
  const payeeIndex = indexOf("payee", -1);
  const amountIndex = indexOf("amount", headers.includes("title") ? 3 : 2);
  const dueDateIndex = indexOf("duedate", headers.includes("title") ? 4 : 3);
  const frequencyIndex = headers.indexOf("frequency");
  const categoryIndex = indexOf("category", headers.includes("title") ? 6 : 5);
  const statusIndex = indexOf("status", headers.includes("title") ? 7 : 4);
  const autoPayIndex = headers.indexOf("autopay");
  const paymentAccountIndex = headers.indexOf("paymentaccount");
  const notesIndex = headers.indexOf("notes");
  const recurringIndex = indexOf("recurring", 6);
  const updatedAtIndex = indexOf("updatedat", headers.includes("title") ? 11 : 7);
  const deletedIndex = headers.indexOf("deleted");

  return sanitizeBills(
    rows
      .slice(1)
      .filter((row) => row[nameIndex])
      .map((row) => {
        const frequency = frequencyIndex >= 0 ? String(row[frequencyIndex] || "").trim() : "";
        const status = String(row[statusIndex] || "").trim();
        return {
          id: row[idIndex] || crypto.randomUUID(),
          name: row[nameIndex],
          payee: payeeIndex >= 0 ? row[payeeIndex] || undefined : undefined,
          amount: Number(String(row[amountIndex] || "0").replace(/[$,]/g, "")) || 0,
          dueDate: row[dueDateIndex] || "",
          paid: parseBoolean(status) || status.toLowerCase() === "paid",
          category: row[categoryIndex] || undefined,
          recurring: parseBoolean(row[recurringIndex]) || (frequency ? frequency.toLowerCase() !== "one-time" : false),
          frequency: frequency || undefined,
          status: status || undefined,
          autoPay: autoPayIndex >= 0 ? parseBoolean(row[autoPayIndex]) : undefined,
          paymentAccount: paymentAccountIndex >= 0 ? row[paymentAccountIndex] || undefined : undefined,
          notes: notesIndex >= 0 ? row[notesIndex] || undefined : undefined,
          updatedAt: Number(row[updatedAtIndex] || Date.now()),
          deleted: deletedIndex >= 0 ? parseBoolean(row[deletedIndex]) : false,
        };
      })
  );
}

function parseStaff(rows: string[][]): StaffMember[] {
  return rows
    .slice(1)
    .filter((row) => row[1])
    .map((row) => ({
      id: row[0] || row[1].toLowerCase().replace(/\s+/g, "-"),
      name: row[1],
      role: row[2] || "Staff",
      email: row[3] || undefined,
      phone: row[4] || undefined,
      color: row[5] || "slate",
    }));
}

function parseStaffRoster(rows: string[][]): StaffMember[] {
  return rows
    .slice(1)
    .filter((row) => row[1] || row[0])
    .map((row, index) => ({
      id: row[0] || `staff-roster-${index}`,
      name: row[1] || row[0],
      role: parseBoolean(row[2]) ? "Manager" : "Staff",
      email: row[0] || undefined,
      color: parseBoolean(row[2]) ? "violet" : "sky",
    }));
}

async function syncFunctionFetch<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(APPS_SCRIPT_SYNC_FUNCTION, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });

  const text = await response.text();
  let data: { ok?: boolean; error?: string; message?: string };
  try {
    data = JSON.parse(text);
  } catch {
    const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    if (isLocal) {
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
  const deletedKeys = new Set<string>();
  eventSets.forEach((events) => {
    Object.entries(events).forEach(([key, value]) => {
      if (!String(value || "").trim()) {
        deletedKeys.add(key);
        merged[key] = "";
        return;
      }
      if (deletedKeys.has(key)) return;

      const lines = String(value)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
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

function taskReminderDateForSheet(task: Task): string {
  return task.isGeneralReminder ? "" : task.reminderDate || "";
}

function taskRowForSheet(task: Task): unknown[] {
  const isGeneralReminder = Boolean(task.isGeneralReminder);
  return [
    task.id,
    task.title,
    task.category,
    task.description || "",
    isGeneralReminder ? "" : task.dayOfWeek,
    task.completed ? "TRUE" : "FALSE",
    isGeneralReminder ? "" : task.weekId,
    isGeneralReminder ? "FALSE" : task.repeatsWeekly ? "TRUE" : "FALSE",
    isGeneralReminder ? "none" : task.repeatPattern || "none",
    task.originTaskId || "",
    task.deleted ? "TRUE" : "FALSE",
    taskReminderDateForSheet(task),
    task.assignee || "",
    task.priority,
    isGeneralReminder ? "" : task.shiftHours || "",
    task.updatedAt || Date.now(),
  ];
}

function billFrequencyForSheet(bill: Bill): string {
  if (bill.frequency) return bill.frequency;
  return bill.recurring ? "monthly" : "one-time";
}

function billStatusForSheet(bill: Bill): string {
  if (bill.paid) return "paid";
  if (bill.status && bill.status.toLowerCase() !== "paid") return bill.status;
  return "upcoming";
}

function billRowForSheet(bill: Bill): unknown[] {
  return [
    bill.id,
    bill.name,
    bill.payee || "",
    bill.amount,
    bill.dueDate,
    billFrequencyForSheet(bill),
    bill.category || "",
    billStatusForSheet(bill),
    bill.autoPay ? "TRUE" : "FALSE",
    bill.paymentAccount || "",
    bill.notes || "",
    bill.updatedAt || Date.now(),
    bill.deleted ? "TRUE" : "FALSE",
  ];
}

function dailyEventRows(events: DailyEvents): unknown[][] {
  return Object.entries(events)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, note]) => {
      const cleanNote = String(note || "").trim();
      return [key, cleanNote, Date.now(), cleanNote ? "FALSE" : "TRUE"];
    });
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

export async function pullOperationsSnapshot(
  spreadsheetId: string,
  accessToken: string,
  fallback: OperationsSnapshot
): Promise<OperationsSnapshot> {
  const tabs = await getSheetTitles(spreadsheetId, accessToken);
  const taskTab = pickTab(tabs, ["Tasks", "Task List", "Todos", "Todo"]);
  const dailyTab = pickTab(tabs, ["Events", "Daily Notes", "Notes", "Daily Agenda"]);
  const categoryTab = pickTab(tabs, ["Categories"]);
  const billTab = pickTab(tabs, ["Bills", "Expenses"]);
  const staffTab = pickTab(tabs, ["Staff", "Staff Members"]);

  const [taskRows, dailyRows, categoryRows, billRows, staffRows] = await Promise.all([
    taskTab ? readValues(spreadsheetId, accessToken, taskTab) : Promise.resolve([]),
    dailyTab ? readValues(spreadsheetId, accessToken, dailyTab) : Promise.resolve([]),
    categoryTab ? readValues(spreadsheetId, accessToken, categoryTab) : Promise.resolve([]),
    billTab ? readValues(spreadsheetId, accessToken, billTab) : Promise.resolve([]),
    staffTab ? readValues(spreadsheetId, accessToken, staffTab) : Promise.resolve([]),
  ]);

  return {
    tasks: taskRows.length
      ? deduplicateTasks(sanitizeTasks(taskTab?.toLowerCase() === "todos" ? parseTodos(taskRows) : parseTasks(taskRows)))
      : fallback.tasks,
    dailyEvents: dailyRows.length ? parseDailyEvents(dailyRows) : fallback.dailyEvents,
    categories: categoryRows.length ? parseCategories(categoryRows) : fallback.categories,
    bills: billRows.length ? parseBills(billRows) : fallback.bills,
    staff: staffRows.length ? parseStaff(staffRows) : fallback.staff,
  };
}

export async function pullStaffSchedulingSnapshot(
  spreadsheetId: string,
  accessToken: string
): Promise<Pick<OperationsSnapshot, "tasks" | "dailyEvents" | "staff">> {
  const tabs = await getSheetTitles(spreadsheetId, accessToken);
  const todoTab = pickTab(tabs, ["Todos", "Todo"]);
  const dailyTab = pickTab(tabs, ["DailyNotes", "Daily Notes", "Events", "Notes", "Daily Agenda"]);
  const staffTab = pickTab(tabs, ["Staff", "Staff Members"]);

  const [todoRows, dailyRows, staffRows] = await Promise.all([
    todoTab ? readValues(spreadsheetId, accessToken, todoTab) : Promise.resolve([]),
    dailyTab ? readValues(spreadsheetId, accessToken, dailyTab) : Promise.resolve([]),
    staffTab ? readValues(spreadsheetId, accessToken, staffTab) : Promise.resolve([]),
  ]);

  return {
    tasks: todoRows.length ? deduplicateTasks(sanitizeTasks(parseTodos(todoRows))) : [],
    dailyEvents: dailyRows.length ? parseDailyEvents(dailyRows) : {},
    staff: staffRows.length ? parseStaffRoster(staffRows) : [],
  };
}

export async function pushOperationsSnapshot(
  spreadsheetId: string,
  accessToken: string,
  snapshot: OperationsSnapshot
): Promise<void> {
  await overwriteSheets(spreadsheetId, accessToken, [
    {
      name: "Tasks",
      values: [
        TASK_HEADERS,
        ...snapshot.tasks.filter((task) => task.source !== "staff").map(taskRowForSheet),
      ],
    },
    {
      name: "Events",
      values: [DAILY_HEADERS, ...dailyEventRows(snapshot.dailyEvents)],
    },
    {
      name: "Categories",
      values: [CATEGORY_HEADERS, ...snapshot.categories.map((category) => [category.id, category.name, category.color])],
    },
    {
      name: "Bills",
      values: [
        BILL_HEADERS,
        ...snapshot.bills.map(billRowForSheet),
      ],
    },
  ]);
}

export async function pushStaffSchedule(
  spreadsheetId: string,
  accessToken: string,
  weekId: string,
  tasks: Task[],
  staff: StaffMember[]
): Promise<void> {
  const staffByName = new Map(staff.map((person) => [person.name, person]));
  const activeTasks = tasks.filter((task) => !task.deleted && !task.isGeneralReminder && task.weekId === weekId && task.specificDate);

  await overwriteSheets(spreadsheetId, accessToken, [
    {
      name: "Staff Schedule",
      values: [
        STAFF_SCHEDULE_HEADERS,
        ...activeTasks.map((task) => {
          const person = staffByName.get(task.assignee || "");
          return [
            task.weekId,
            task.dayOfWeek,
            task.specificDate || dateKeyForWeekDay(task.weekId, task.dayOfWeek),
            task.assignee || "Unassigned",
            person?.role || "",
            task.shiftHours || "",
            task.title,
            task.category,
            task.priority,
            task.completed ? "TRUE" : "FALSE",
          ];
        }),
      ],
    },
  ]);
}
