import type { Bill, CategoryOption, DailyEvents, OperationsSnapshot, StaffMember, Task } from "../types";
import {
  dailyEventKey,
  dateKeyForWeekDay,
  deduplicateTasks,
  eventKeyFromIsoDate,
  isInvalidTitle,
  normalizePriority,
  parseBoolean,
  sanitizeDailyEvents,
  sanitizeTasks,
} from "../utils";

export const DEFAULT_PRIVATE_SHEET_ID = "1NQKvTSWvpTZ3uRsYWMUPAdOa_bHvsp_VMpc7EX1c_tI";
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

const DAILY_HEADERS = ["dateKey", "note"];
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
  return rows
    .slice(1)
    .filter((row) => !isInvalidTitle(row[1]))
    .map((row) => {
      const repeatPattern: Task["repeatPattern"] =
        row[8] === "weekly" || row[8] === "biweekly" ? row[8] : "none";
      return {
        id: row[0] || crypto.randomUUID(),
        title: row[1] || "",
        category: row[2] || "Production",
        description: row[3] || "",
        dayOfWeek: Number(row[4] || 1),
        completed: parseBoolean(row[5]),
        weekId: row[6] || "",
        repeatsWeekly: parseBoolean(row[7]),
        repeatPattern,
        originTaskId: row[9] || undefined,
        deleted: parseBoolean(row[10]),
        specificDate: row[11] || undefined,
        assignee: row[12] || undefined,
        priority: normalizePriority(row[13]),
        shiftHours: row[14] || undefined,
        updatedAt: Number(row[15] || Date.now()),
      };
    })
    .filter((task) => task.weekId);
}

function parseDailyEvents(rows: string[][]): DailyEvents {
  const events: DailyEvents = {};
  rows.slice(1).forEach((row) => {
    const rawKey = String(row[0] || "").trim();
    const note = String(row[1] || "").trim();
    if (!rawKey || !note) return;
    const key = /^\d{4}-\d{2}-\d{2}-[1-7]$/.test(rawKey) ? rawKey : eventKeyFromIsoDate(rawKey);
    if (key) events[key] = note;
  });
  return sanitizeDailyEvents(events);
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
  return rows
    .slice(1)
    .filter((row) => row[1])
    .map((row) => ({
      id: row[0] || crypto.randomUUID(),
      name: row[1],
      amount: Number(String(row[2] || "0").replace(/[$,]/g, "")) || 0,
      dueDate: row[3] || "",
      paid: parseBoolean(row[4]),
      category: row[5] || undefined,
      recurring: parseBoolean(row[6]),
      updatedAt: Number(row[7] || Date.now()),
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

export async function pullOperationsSnapshot(
  spreadsheetId: string,
  accessToken: string,
  fallback: OperationsSnapshot
): Promise<OperationsSnapshot> {
  const tabs = await getSheetTitles(spreadsheetId, accessToken);
  const taskTab = pickTab(tabs, ["Todo", "Tasks"]);
  const dailyTab = pickTab(tabs, ["Daily Notes", "Events", "Notes", "Daily Agenda"]);
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
    tasks: taskRows.length ? deduplicateTasks(sanitizeTasks(parseTasks(taskRows))) : fallback.tasks,
    dailyEvents: dailyRows.length ? parseDailyEvents(dailyRows) : fallback.dailyEvents,
    categories: categoryRows.length ? parseCategories(categoryRows) : fallback.categories,
    bills: billRows.length ? parseBills(billRows) : fallback.bills,
    staff: staffRows.length ? parseStaff(staffRows) : fallback.staff,
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
        ...snapshot.tasks.map((task) => [
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
      name: "Daily Notes",
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
  const activeTasks = tasks.filter((task) => !task.deleted && task.weekId === weekId);

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
