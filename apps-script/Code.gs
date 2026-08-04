// KWTM_SCRIPT_VERSION: 2026-08-04.1
// KWTM_SCRIPT_UPDATED_AT: 2026-08-04
// Purpose: Karl Weekly Task Manager sync bridge for Google Sheets.

/*
 * Karl Weekly Task Manager sync bridge.
 *
 * Paste this into the Apps Script project for the private Karl task sheet:
 * https://docs.google.com/spreadsheets/d/1NQKvTSWvpTZ3uRsYWMUPAdOa_bHvsp_VMpc7EX1c_tI/edit
 *
 * Deploy as a Web App:
 * - Execute as: Me
 * - Who has access: Anyone
 *
 * Script properties:
 * - KWTM_SYNC_TOKEN: same secret value as Netlify APPS_SCRIPT_SYNC_TOKEN
 * - KWTM_PRIVATE_SHEET_ID: optional; defaults to the sheet this script is bound to
 * - KWTM_STAFF_TODOS_SHEET_ID: optional fallback for the staff scheduler sheet ID
 * - KWTM_PUBLIC_STAFF_SHEET_ID: optional; when absent, public staff publishing is skipped
 *
 * Version:
 * - KWTM_SCRIPT_VERSION 2026-08-04.1
 * - KWTM_SCRIPT_UPDATED_AT 2026-08-04
 * - Open the deployed web app URL in a browser to confirm the live script version.
 */

var KWTM_SCRIPT_VERSION = "2026-08-04.1";
var KWTM_SCRIPT_UPDATED_AT = "2026-08-04";
var KWTM_STAFF_TODOS_SHEET_ID_FALLBACK = "1TsSonscE_UZ9A80tLSVxdnKQx_udYWGWQejTPh17wtg";

var KWTM_TASK_HEADERS = [
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
var KWTM_DAILY_HEADERS = ["key", "text", "updatedAt"];
var KWTM_CATEGORY_HEADERS = ["id", "name", "color"];
var KWTM_BILL_HEADERS = [
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
];
var KWTM_STAFF_HEADERS = ["id", "name", "role", "email", "phone", "color"];
var KWTM_STAFF_SCHEDULE_HEADERS = [
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

function doPost(e) {
  var body = KWTM_parseBody_(e);
  if (body.app === "karl-weekly-task-manager") return KWTM_handleRequest_(body);
  return KWTM_json_({ ok: false, error: "Unknown app." });
}

function doGet() {
  return KWTM_json_({
    ok: true,
    message: "Karl Weekly Task Manager sync bridge is deployed.",
  });
}

function KWTM_handleRequest_(body) {
  var lock;
  try {
    KWTM_verifyToken_(body.token);

    if (body.action === "pull") {
      return KWTM_json_({
        ok: true,
        private: KWTM_readPrivateWorkbook_(body.config || {}),
        staff: KWTM_readStaffWorkbook_(body.config || {}),
      });
    }

    if (body.action === "pushOperations") {
      lock = LockService.getScriptLock();
      lock.waitLock(30000);
      KWTM_writeOperations_(body.config || {}, body.snapshot || {});
      return KWTM_json_({ ok: true });
    }

    if (body.action === "pushStaffTodos") {
      lock = LockService.getScriptLock();
      lock.waitLock(30000);
      var todoResult = KWTM_patchStaffTodos_(body.config || {}, body.tasks || []);
      return KWTM_json_({ ok: true, result: todoResult });
    }

    if (body.action === "pushStaffSchedule") {
      lock = LockService.getScriptLock();
      lock.waitLock(30000);
      var result = KWTM_writeStaffSchedule_(body.config || {}, body.weekId, body.tasks || [], body.staff || []);
      return KWTM_json_({ ok: true, result: result });
    }

    return KWTM_json_({ ok: false, error: "Unknown sync action." });
  } catch (error) {
    return KWTM_json_({ ok: false, error: error && error.message ? error.message : String(error) });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function KWTM_parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  return JSON.parse(e.postData.contents);
}

function KWTM_verifyToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty("KWTM_SYNC_TOKEN");
  if (!expected) throw new Error("Set KWTM_SYNC_TOKEN in Apps Script Script properties.");
  if (String(token || "") !== expected) throw new Error("Invalid sync token.");
}

function KWTM_property_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || "";
}

function KWTM_privateSheetId_(config) {
  return String(config.privateSheetId || KWTM_property_("KWTM_PRIVATE_SHEET_ID") || SpreadsheetApp.getActive().getId()).trim();
}

function KWTM_staffTodosSheetId_(config) {
  return String(config.staffTodosSheetId || KWTM_property_("KWTM_STAFF_TODOS_SHEET_ID") || KWTM_STAFF_TODOS_SHEET_ID_FALLBACK).trim();
}

function KWTM_publicStaffSheetId_(config) {
  return String(config.publicStaffSheetId || KWTM_property_("KWTM_PUBLIC_STAFF_SHEET_ID") || "").trim();
}

function KWTM_readPrivateWorkbook_(config) {
  var ss = SpreadsheetApp.openById(KWTM_privateSheetId_(config));
  var tabs = KWTM_sheetTitles_(ss);
  var taskTab = KWTM_pickTab_(tabs, ["Tasks", "Task List", "Todos", "Todo"]);
  var dailyTab = KWTM_pickTab_(tabs, ["Events", "Daily Notes", "Notes", "Daily Agenda"]);
  var categoryTab = KWTM_pickTab_(tabs, ["Categories"]);
  var billTab = KWTM_pickTab_(tabs, ["Bills", "Expenses"]);
  var staffTab = KWTM_pickTab_(tabs, ["Staff", "Staff Members"]);

  return {
    taskTab: taskTab || "",
    tasks: KWTM_readRows_(ss, taskTab),
    dailyEvents: KWTM_readRows_(ss, dailyTab),
    categories: KWTM_readRows_(ss, categoryTab),
    bills: KWTM_readRows_(ss, billTab),
    staff: KWTM_readRows_(ss, staffTab),
  };
}

function KWTM_readStaffWorkbook_(config) {
  var spreadsheetId = KWTM_staffTodosSheetId_(config);
  if (!spreadsheetId) return { todos: [], dailyEvents: [], staff: [] };

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var tabs = KWTM_sheetTitles_(ss);
  return {
    todos: KWTM_readRows_(ss, KWTM_pickTab_(tabs, ["Todos", "Todo"])),
    dailyEvents: KWTM_readRows_(ss, KWTM_pickTab_(tabs, ["DailyNotes", "Daily Notes", "Events", "Notes", "Daily Agenda"])),
    staff: KWTM_readRows_(ss, KWTM_pickTab_(tabs, ["Staff", "Staff Members"])),
  };
}

function KWTM_sheetTitles_(ss) {
  return ss.getSheets().map(function (sheet) {
    return sheet.getName();
  });
}

function KWTM_pickTab_(tabs, names) {
  var normalized = {};
  tabs.forEach(function (tab) {
    normalized[String(tab).trim().toLowerCase()] = tab;
  });
  for (var i = 0; i < names.length; i += 1) {
    var found = normalized[String(names[i]).toLowerCase()];
    if (found) return found;
  }
  return "";
}

function KWTM_readRows_(ss, tabName) {
  if (!tabName) return [];
  var sheet = ss.getSheetByName(tabName);
  if (!sheet || !sheet.getLastRow() || !sheet.getLastColumn()) return [];
  return sheet.getRange(1, 1, sheet.getLastRow(), Math.min(sheet.getLastColumn(), 26)).getDisplayValues();
}

function KWTM_hasTextRecordValues_(record) {
  var source = record || {};
  return Object.keys(source).some(function (key) {
    return String(source[key] || "").trim();
  });
}

function KWTM_isPrivateTask_(task) {
  var source = task || {};
  return source.source !== "staff" && !String(source.id || "").match(/^staff-/);
}

function KWTM_hasPrivateOperationsData_(snapshot) {
  var source = snapshot || {};
  return Boolean(
    (source.tasks || []).some(KWTM_isPrivateTask_) ||
      (source.bills || []).length ||
      KWTM_hasTextRecordValues_(source.dailyEvents)
  );
}

function KWTM_writeOperations_(config, snapshot) {
  if (!KWTM_hasPrivateOperationsData_(snapshot)) {
    throw new Error("Blocked unsafe empty sheet overwrite. Refresh from Google Sheets instead of saving an empty cache.");
  }

  var ss = SpreadsheetApp.openById(KWTM_privateSheetId_(config));
  var tasks = (snapshot.tasks || []).filter(function (task) {
    return task.source !== "staff";
  });

  KWTM_overwriteRows_(
    ss,
    "Tasks",
    [KWTM_TASK_HEADERS].concat(
      tasks.map(function (task) {
        return [
          task.id || "",
          task.title || "",
          task.category || "",
          task.description || "",
          task.dayOfWeek || "",
          task.completed ? "TRUE" : "FALSE",
          task.weekId || "",
          task.repeatsWeekly ? "TRUE" : "FALSE",
          task.repeatPattern || "none",
          task.originTaskId || "",
          task.deleted ? "TRUE" : "FALSE",
          KWTM_taskReminderDateForSheet_(task),
          task.assignee || "",
          task.priority || "medium",
          task.shiftHours || "",
          task.updatedAt || new Date().getTime(),
        ];
      })
    )
  );

  var dailyEvents = snapshot.dailyEvents || {};
  var now = new Date().getTime();
  KWTM_overwriteRows_(
    ss,
    "Events",
    [KWTM_DAILY_HEADERS].concat(
      Object.keys(dailyEvents)
        .sort()
        .map(function (key) {
          return [key, dailyEvents[key], now];
        })
    )
  );

  KWTM_overwriteRows_(
    ss,
    "Categories",
    [KWTM_CATEGORY_HEADERS].concat(
      (snapshot.categories || []).map(function (category) {
        return [category.id || "", category.name || "", category.color || ""];
      })
    )
  );

  KWTM_overwriteRows_(
    ss,
    "Bills",
    [KWTM_BILL_HEADERS].concat(
      (snapshot.bills || []).map(function (bill) {
        return [
          bill.id || "",
          bill.name || "",
          bill.payee || "",
          bill.amount || 0,
          bill.dueDate || "",
          KWTM_billFrequencyForSheet_(bill),
          bill.category || "",
          KWTM_billStatusForSheet_(bill),
          bill.autoPay ? "TRUE" : "FALSE",
          bill.paymentAccount || "",
          bill.notes || "",
          bill.updatedAt || new Date().getTime(),
        ];
      })
    )
  );
}

function KWTM_writeStaffSchedule_(config, weekId, tasks, staff) {
  var spreadsheetId = KWTM_publicStaffSheetId_(config);
  if (!spreadsheetId) return { skipped: true, reason: "KWTM_PUBLIC_STAFF_SHEET_ID is not set." };

  var staffByName = {};
  (staff || []).forEach(function (person) {
    staffByName[person.name] = person;
  });

  var activeTasks = (tasks || []).filter(function (task) {
    return !task.deleted && !task.isGeneralReminder && task.weekId === weekId && task.specificDate;
  });

  var rows = [KWTM_STAFF_SCHEDULE_HEADERS].concat(
    activeTasks.map(function (task) {
      var person = staffByName[task.assignee || ""] || {};
      return [
        task.weekId,
        task.dayOfWeek,
        task.specificDate || KWTM_dateForWeekDay_(task.weekId, task.dayOfWeek),
        task.assignee || "Unassigned",
        person.role || "",
        task.shiftHours || "",
        task.title || "",
        task.category || "",
        task.priority || "",
        task.completed ? "TRUE" : "FALSE",
      ];
    })
  );

  KWTM_overwriteRows_(SpreadsheetApp.openById(spreadsheetId), "Staff Schedule", rows);
  return { skipped: false, rows: rows.length - 1 };
}

function KWTM_patchStaffTodos_(config, tasks) {
  var spreadsheetId = KWTM_staffTodosSheetId_(config);
  if (!spreadsheetId) return { skipped: true, reason: "No staff scheduler sheet ID." };

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var tabName = KWTM_pickTab_(KWTM_sheetTitles_(ss), ["Todos", "Todo"]);
  if (!tabName) return { skipped: true, reason: "No Todos tab found." };

  var sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 2) return { skipped: false, updated: 0 };

  var idValues = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  var rowById = {};
  idValues.forEach(function (row, index) {
    var id = String(row[0] || "").trim();
    if (id) rowById[id] = index + 2;
  });

  var updated = 0;
  (tasks || []).forEach(function (task) {
    var rawId = String(task.id || "").replace(/^staff-/, "");
    var rowNumber = rowById[rawId];
    if (!rowNumber) return;

    sheet.getRange(rowNumber, 2).setValue(task.title || "");
    sheet.getRange(rowNumber, 3).setValue(task.category || "");
    sheet.getRange(rowNumber, 4).setValue(task.completed ? "TRUE" : "FALSE");
    if (task.specificDate) sheet.getRange(rowNumber, 9).setValue(task.specificDate);
    sheet.getRange(rowNumber, 11).setValue(task.assignee || "");
    sheet.getRange(rowNumber, 14).setValue(KWTM_staffTodoPriorityForSheet_(task.priority));
    sheet.getRange(rowNumber, 15).setValue(task.shiftHours || "");
    updated += 1;
  });

  return { skipped: false, updated: updated };
}

function KWTM_overwriteRows_(ss, tabName, rows) {
  var sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
  sheet.clearContents();
  if (!rows || !rows.length) return;

  var width = rows.reduce(function (max, row) {
    return Math.max(max, row.length);
  }, 1);
  var normalized = rows.map(function (row) {
    var next = row.slice();
    while (next.length < width) next.push("");
    return next;
  });

  sheet.getRange(1, 1, normalized.length, width).setValues(normalized);
}

function KWTM_dateForWeekDay_(weekId, dayOfWeek) {
  var parts = String(weekId || "").split("-").map(Number);
  var date = new Date(parts[0], parts[1] - 1, parts[2]);
  date.setDate(date.getDate() + Math.max(1, Math.min(7, Number(dayOfWeek || 1))) - 1);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function KWTM_taskReminderDateForSheet_(task) {
  return task.reminderDate || "";
}

function KWTM_billFrequencyForSheet_(bill) {
  if (bill.frequency) return bill.frequency;
  return bill.recurring ? "monthly" : "one-time";
}

function KWTM_billStatusForSheet_(bill) {
  if (bill.paid) return "paid";
  if (bill.status && String(bill.status).toLowerCase() !== "paid") return bill.status;
  return "upcoming";
}

function KWTM_staffTodoPriorityForSheet_(priority) {
  return String(priority || "").toLowerCase() === "high" ? "high" : "normal";
}

function KWTM_json_(payload) {
  payload.app = payload.app || "karl-weekly-task-manager";
  payload.version = KWTM_SCRIPT_VERSION;
  payload.updatedAt = KWTM_SCRIPT_UPDATED_AT;
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
