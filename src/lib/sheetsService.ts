import type { Bill, CategoryOption, DailyEvents, OperationsSnapshot, StaffMember, Task } from "../types";
import {
  dateKeyForWeekDay,
  deduplicateTasks,
  eventKeyFromIsoDate,
  isInvalidTitle,
  normalizePriority,
  parseBoolean,
  sanitizeDailyEvents,
  sanitizeTasks,
  todayStr,
  toLocalDateKey,
  weekIdFromDate,
} from "../utils";

export const DEFAULT_PRIVATE_SHEET_ID = "1NQKvTSWvpTZ3uRsYWMUPAdOa_bHvsp_VMpc7EX1c_tI";
export const DEFAULT_STAFF_TODOS_SHEET_ID = "1TsSonscE_UZ9A80tLSVxdnKQx_udYWGWQejTPh17wtg";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

type TokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type TokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

type GoogleWindow = Window & {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          callback: (response: TokenResponse) => void;
        }) => TokenClient;
      };
    };
  };
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
  "specificDate",
  "assignee",
  "priority",
  "shiftHours",
  "updatedAt",
];

const DAILY_HEADERS = ["date", "text"];
const CATEGORY_HEADERS = ["id", "name", "color"];
const BILL_HEADERS = ["id", "name", "amount", "dueDate", "paid", "category", "recurring", "updatedAt"];
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

export function loadGoogleIdentityScript(): Promise<void> {
  const googleWindow = window as GoogleWindow;
  if (googleWindow.google?.accounts?.oauth2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-google-identity]");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Google sign-in could not load.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Google sign-in could not load.")), { once: true });
    document.head.appendChild(script);
  });
}

export async function requestSheetsAccessToken(clientId: string): Promise<string> {
  if (!clientId.trim()) throw new Error("Add a Google OAuth client ID first.");
  await loadGoogleIdentityScript();
  const googleWindow = window as GoogleWindow;
  const initTokenClient = googleWindow.google?.accounts?.oauth2?.initTokenClient;
  if (!initTokenClient) throw new Error("Google sign-in is unavailable.");

  return new Promise((resolve, reject) => {
    const tokenClient = initTokenClient({
      client_id: clientId.trim(),
      scope: SHEETS_SCOPE,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        if (!response.access_token) {
          reject(new Error("No access token was returned."));
          return;
        }
        resolve(response.access_token);
      },
    });

    tokenClient.requestAccessToken({ prompt: "consent" });
  });
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
  const fallbackWeekId = weekIdFromDate(new Date());
  return rows
    .slice(1)
    .filter((row) => !isInvalidTitle(row[1]))
    .filter((row) => !String(row[0] || "").startsWith("auto-def-") && !String(row[9] || "").startsWith("def-"))
    .map((row) => {
      const repeatPattern: Task["repeatPattern"] =
        row[8] === "weekly" || row[8] === "biweekly" ? row[8] : "none";
      const specificDate = row[11] || undefined;
      const weekId = row[6] || (specificDate ? weekIdFromDate(new Date(`${specificDate}T12:00:00`)) : fallbackWeekId);
      return {
        id: row[0] || crypto.randomUUID(),
        title: row[1] || "",
        category: row[2] || "Production",
        description: row[3] || "",
        dayOfWeek: Number(row[4] || 1),
        completed: parseBoolean(row[5]),
        weekId,
        repeatsWeekly: parseBoolean(row[7]),
        repeatPattern,
        originTaskId: row[9] || undefined,
        deleted: parseBoolean(row[10]),
        specificDate,
        assignee: row[12] || undefined,
        priority: normalizePriority(row[13]),
        shiftHours: row[14] || undefined,
        updatedAt: Number(row[15] || Date.now()),
        source: "private" as const,
        isGeneralReminder: !specificDate,
      };
    })
    .filter((task) => task.weekId);
}

function parseTodos(rows: string[][]): Task[] {
  const todayKey = todayStr();
  return rows
    .slice(1)
    .filter((row) => !isInvalidTitle(row[1]))
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
      const priority = String(row[13] || "").toLowerCase() === "high" ? "high" : "medium";
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
        specificDate: hasExplicitDate ? taskDate : undefined,
        updatedAt: Date.parse(row[7] || row[5] || "") || Date.now(),
        assignee: row[10] || row[4] || undefined,
        shiftHours: row[14] || undefined,
        source: "staff",
        isGeneralReminder: false,
      } satisfies Task;
    });
}

function parseDailyEvents(rows: string[][]): DailyEvents {
  const events: DailyEvents = {};
  rows.slice(1).forEach((row) => {
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
  const amountIndex = indexOf("amount", 2);
  const dueDateIndex = indexOf("duedate", 3);
  const statusIndex = indexOf("status", 4);
  const categoryIndex = indexOf("category", 5);
  const recurringIndex = indexOf("recurring", 6);
  const frequencyIndex = headers.indexOf("frequency");
  const updatedAtIndex = indexOf("updatedat", 7);

  return rows
    .slice(1)
    .filter((row) => row[nameIndex])
    .map((row) => ({
      id: row[idIndex] || crypto.randomUUID(),
      name: row[nameIndex],
      amount: Number(String(row[amountIndex] || "0").replace(/[$,]/g, "")) || 0,
      dueDate: row[dueDateIndex] || "",
      paid: parseBoolean(row[statusIndex]) || String(row[statusIndex] || "").toLowerCase() === "paid",
      category: row[categoryIndex] || undefined,
      recurring:
        parseBoolean(row[recurringIndex]) ||
        (frequencyIndex >= 0 ? String(row[frequencyIndex] || "").toLowerCase() !== "one-time" : false),
      updatedAt: Number(row[updatedAtIndex] || Date.now()),
    }))
    .filter((bill) => /^\d{4}-\d{2}-\d{2}$/.test(bill.dueDate));
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
        ...snapshot.tasks.filter((task) => task.source !== "staff").map((task) => [
          task.id,
          task.title,
          task.category,
          task.description || "",
          task.dayOfWeek,
          task.completed ? "TRUE" : "FALSE",
          task.weekId,
          task.repeatsWeekly ? "TRUE" : "FALSE",
          task.repeatPattern || "none",
          task.originTaskId || "",
          task.deleted ? "TRUE" : "FALSE",
          task.specificDate || "",
          task.assignee || "",
          task.priority,
          task.shiftHours || "",
          task.updatedAt || Date.now(),
        ]),
      ],
    },
    {
      name: "Events",
      values: [DAILY_HEADERS, ...Object.entries(snapshot.dailyEvents).map(([key, note]) => [key, note])],
    },
    {
      name: "Categories",
      values: [CATEGORY_HEADERS, ...snapshot.categories.map((category) => [category.id, category.name, category.color])],
    },
    {
      name: "Bills",
      values: [
        BILL_HEADERS,
        ...snapshot.bills.map((bill) => [
          bill.id,
          bill.name,
          bill.amount,
          bill.dueDate,
          bill.paid ? "TRUE" : "FALSE",
          bill.category || "",
          bill.recurring ? "TRUE" : "FALSE",
          bill.updatedAt || Date.now(),
        ]),
      ],
    },
    {
      name: "Staff",
      values: [
        STAFF_HEADERS,
        ...snapshot.staff.map((person) => [
          person.id,
          person.name,
          person.role,
          person.email || "",
          person.phone || "",
          person.color || "slate",
        ]),
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
