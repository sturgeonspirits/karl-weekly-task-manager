// KWTM_SCRIPT_VERSION: 2026-09-02.2
// KWTM_SCRIPT_UPDATED_AT: 2026-09-02
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
 * - KWTM_SCRIPT_VERSION 2026-09-02.2
 * - KWTM_SCRIPT_UPDATED_AT 2026-09-02
 * - Open the deployed web app URL in a browser to confirm the live script version.
 *
 * Invariant: no code path may throw out of doPost. Apps Script answers an uncaught error
 * with an HTML error page rather than JSON, and the Netlify function on the other end can
 * then only report "Apps Script did not return JSON." -- the same opaque line for a
 * transient hiccup and for a real, fixable fault. Every entry point ends in KWTM_json_.
 */

var KWTM_SCRIPT_VERSION = "2026-09-02.2";
var KWTM_SCRIPT_UPDATED_AT = "2026-09-02";

// How long to wait for the script lock before telling the caller to come back. Kept short
// on purpose -- see KWTM_tryLock_ for why a long wait actively makes things worse.
var KWTM_LOCK_WAIT_MS = 8000;
var KWTM_STAFF_TODOS_SHEET_ID_FALLBACK = "1TsSonscE_UZ9A80tLSVxdnKQx_udYWGWQejTPh17wtg";
var KWTM_SOFT_DELETE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
var KWTM_BACKUP_RETENTION_DAYS = 8;

// The Todos tab in the staff scheduler workbook is owned by the staff app, not by this
// script, so its layout is fixed rather than derived from a KWTM_* header list.
var KWTM_STAFF_TODO_HEADERS = [
  "id",
  "title",
  "category",
  "completed",
  "createdBy",
  "createdAt",
  "updatedBy",
  "updatedAt",
  "dueDate",
  "token",
  "assignee",
  "proof",
  "originTaskId",
  "priority",
  "shiftHours",
];

// NOTE: the KWTM_*_HEADERS arrays below mirror src/lib/sheetSchema.ts, and
// KWTM_isPrivateTask_ / KWTM_hasPrivateOperationsData_ mirror src/lib/taskPredicates.ts.
// Apps Script cannot import from the repo, so these copies are kept in agreement by hand.
// If you add, remove, or reorder a column here, make the same change in sheetSchema.ts.

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
var KWTM_DAILY_HEADERS = ["key", "text", "updatedAt", "deleted"];
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
  "deleted",
  // v1.1 -- 2026-08-21 -- Partial payments. Mirrors BILL_COLUMNS in src/lib/sheetSchema.ts.
  "amountPaid",
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
  // Nothing here may throw. An uncaught error makes Apps Script return an HTML error page
  // instead of JSON, which the Netlify function can only report as
  // "Apps Script did not return JSON." -- an unhelpful message for a real, fixable fault.
  try {
    var body = KWTM_parseBody_(e);
    if (body.app === "karl-weekly-task-manager") return KWTM_handleRequest_(body);
    return KWTM_json_({ ok: false, error: "Unknown app." });
  } catch (error) {
    return KWTM_json_({ ok: false, error: KWTM_errorMessage_(error), stage: "doPost" });
  }
}

function doGet() {
  return KWTM_json_({
    ok: true,
    message: "Karl Weekly Task Manager sync bridge is deployed.",
  });
}

function KWTM_errorMessage_(error) {
  if (!error) return "Unknown Apps Script error.";
  return error.message ? String(error.message) : String(error);
}

/**
 * Takes the script lock, or returns null when another execution already holds it.
 *
 * This used to wait 30 seconds. The caller is a Netlify function whose own budget is far
 * shorter than that, so the wait could never pay off: the request was already dead by the
 * time the lock arrived, and the waiting execution sat on one of the few concurrent Apps
 * Script slots the whole time, making the next request likelier to be shed as HTML. A
 * short wait plus a retryable answer lets the client come back a moment later instead.
 */
function KWTM_tryLock_() {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(KWTM_LOCK_WAIT_MS)) return null;
  } catch (error) {
    return null;
  }
  return lock;
}

function KWTM_busyResponse_() {
  return KWTM_json_({
    ok: false,
    retryable: true,
    error: "Another sync is already writing to the sheet. Retry in a moment.",
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

    // One request, one lock, one execution slot. The client used to send pushOperations,
    // pushStaffTodos and pushStaffSchedule as three separate round trips per save; with two
    // clients open that is six executions contending for one script lock, which is what
    // made Apps Script start shedding requests as HTML. The three actions below are kept so
    // a browser still running the old bundle keeps working during a rollout.
    if (body.action === "pushAll") {
      lock = KWTM_tryLock_();
      if (!lock) return KWTM_busyResponse_();
      return KWTM_pushAll_(body);
    }

    if (body.action === "pushOperations") {
      lock = KWTM_tryLock_();
      if (!lock) return KWTM_busyResponse_();
      KWTM_writeOperations_(body.config || {}, body.snapshot || {});
      return KWTM_json_({ ok: true });
    }

    if (body.action === "pushStaffTodos") {
      lock = KWTM_tryLock_();
      if (!lock) return KWTM_busyResponse_();
      var todoResult = KWTM_patchStaffTodos_(body.config || {}, body.tasks || []);
      return KWTM_json_({ ok: true, result: todoResult });
    }

    if (body.action === "pushStaffSchedule") {
      lock = KWTM_tryLock_();
      if (!lock) return KWTM_busyResponse_();
      var result = KWTM_writeStaffSchedule_(body.config || {}, body.weekId, body.tasks || [], body.staff || []);
      return KWTM_json_({ ok: true, result: result });
    }

    return KWTM_json_({ ok: false, error: "Unknown sync action." });
  } catch (error) {
    return KWTM_json_({ ok: false, error: KWTM_errorMessage_(error), action: String(body.action || "") });
  } finally {
    if (lock) {
      try {
        lock.releaseLock();
      } catch (releaseError) {
        // A lock that already expired throws on release. Swallowing it here matters: an
        // error thrown from `finally` replaces the JSON response with an HTML error page.
      }
    }
  }
}

/**
 * Writes the private workbook, then the two staff mirrors, under a single lock.
 *
 * Only the private workbook is the source of truth, so only its failure fails the request.
 * A mirror that cannot be written -- the staff workbook renamed, unshared, or briefly
 * unavailable -- is reported as a warning instead. Failing the whole request for it would
 * be worse than useless: the private write has already committed by then, and the client
 * would retry the save forever, rewriting the same rows on every pass while the mirror went
 * on failing for its own unrelated reason.
 */
function KWTM_pushAll_(body) {
  var config = body.config || {};
  var snapshot = body.snapshot || {};
  var result = { operations: { skipped: true, reason: "No private operations data in snapshot." } };
  var warnings = [];

  if (KWTM_hasPrivateOperationsData_(snapshot)) {
    KWTM_writeOperations_(config, snapshot);
    result.operations = { skipped: false };
  }

  result.staffTodos = KWTM_mirror_(warnings, "staffTodos", function () {
    return KWTM_patchStaffTodos_(config, body.tasks || []);
  });
  result.staffSchedule = KWTM_mirror_(warnings, "staffSchedule", function () {
    return KWTM_writeStaffSchedule_(config, body.weekId, body.scheduledTasks || [], body.staff || []);
  });

  return KWTM_json_({ ok: true, result: result, warnings: warnings });
}

function KWTM_mirror_(warnings, name, run) {
  try {
    return run();
  } catch (error) {
    var message = KWTM_errorMessage_(error);
    warnings.push(name + ": " + message);
    return { failed: true, error: message };
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

/**
 * Resolves the four tabs this script owns, once, for both reading and writing.
 *
 * Reads used to pick a tab by preference list while writes hardcoded the canonical name, so
 * a workbook whose tab is called "Task List" was read from there and written to a brand new
 * "Tasks" tab -- the app and the sheet silently diverging. Same resolution on both sides
 * removes that split. The `|| "Tasks"` fallbacks only apply to a workbook that has no such
 * tab at all, where creating the canonical name is the right move.
 */
function KWTM_privateTabNames_(ss) {
  var tabs = KWTM_sheetTitles_(ss);
  return {
    tasks: KWTM_pickTab_(tabs, ["Tasks", "Task List", "Todos", "Todo"]) || "Tasks",
    dailyEvents: KWTM_pickTab_(tabs, ["Events", "Daily Notes", "Notes", "Daily Agenda"]) || "Events",
    categories: KWTM_pickTab_(tabs, ["Categories"]) || "Categories",
    bills: KWTM_pickTab_(tabs, ["Bills", "Expenses"]) || "Bills",
    staff: KWTM_pickTab_(tabs, ["Staff", "Staff Members"]) || "Staff",
  };
}

function KWTM_readPrivateWorkbook_(config) {
  var ss = SpreadsheetApp.openById(KWTM_privateSheetId_(config));
  var tabs = KWTM_sheetTitles_(ss);
  var taskTab = KWTM_pickTab_(tabs, ["Tasks", "Task List", "Todos", "Todo"]);

  return {
    // Empty rather than the fallback: the client switches parsers on this name, so an
    // absent tab must read as absent, not as an empty "Tasks".
    taskTab: taskTab || "",
    tasks: KWTM_readRows_(ss, taskTab),
    dailyEvents: KWTM_readRows_(ss, KWTM_pickTab_(tabs, ["Events", "Daily Notes", "Notes", "Daily Agenda"])),
    categories: KWTM_readRows_(ss, KWTM_pickTab_(tabs, ["Categories"])),
    bills: KWTM_readRows_(ss, KWTM_pickTab_(tabs, ["Bills", "Expenses"])),
    staff: KWTM_readRows_(ss, KWTM_pickTab_(tabs, ["Staff", "Staff Members"])),
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

function KWTM_hasRecordKeys_(record) {
  return Object.keys(record || {}).length > 0;
}

function KWTM_isPrivateTask_(task) {
  var source = task || {};
  return source.source !== "staff" && !String(source.id || "").match(/^staff-/);
}

function KWTM_isKarlAssignee_(assignee) {
  var normalized = String(assignee || "").trim().toLowerCase();
  return normalized === "karl" || normalized === "karl loewenstein" || normalized.indexOf("karl@") === 0;
}

function KWTM_isKwtmStaffMirrorId_(id) {
  return String(id || "").indexOf("kwtm-") === 0;
}

function KWTM_hasPrivateOperationsData_(snapshot) {
  var source = snapshot || {};
  return Boolean(
    (source.tasks || []).some(KWTM_isPrivateTask_) ||
      (source.bills || []).length ||
      KWTM_hasRecordKeys_(source.dailyEvents)
  );
}

function KWTM_writeOperations_(config, snapshot) {
  if (!KWTM_hasPrivateOperationsData_(snapshot)) {
    throw new Error("Blocked unsafe empty sync. Refresh from Google Sheets before saving an empty cache.");
  }

  var ss = SpreadsheetApp.openById(KWTM_privateSheetId_(config));
  var tabNames = KWTM_privateTabNames_(ss);
  var tasks = (snapshot.tasks || []).filter(function (task) {
    return task.source !== "staff";
  });

  KWTM_upsertRows_(
    ss,
    tabNames.tasks,
    [KWTM_TASK_HEADERS].concat(
      tasks.map(function (task) {
        return [
          task.id || "",
          task.title || "",
          task.category || "",
          task.description || "",
          KWTM_taskDayOfWeekForSheet_(task),
          task.completed ? "TRUE" : "FALSE",
          KWTM_taskWeekIdForSheet_(task),
          KWTM_taskRepeatsWeeklyForSheet_(task),
          KWTM_taskRepeatPatternForSheet_(task),
          task.originTaskId || "",
          task.deleted ? "TRUE" : "FALSE",
          KWTM_taskReminderDateForSheet_(task),
          task.assignee || "",
          task.priority || "medium",
          task.shiftHours || "",
          task.updatedAt || new Date().getTime(),
        ];
      })
    ),
    0,
    15,
    10
  );

  var dailyEvents = snapshot.dailyEvents || {};
  var now = new Date().getTime();
  KWTM_upsertRows_(
    ss,
    tabNames.dailyEvents,
    [KWTM_DAILY_HEADERS].concat(
      Object.keys(dailyEvents)
        .sort()
        .map(function (key) {
          var note = String(dailyEvents[key] || "").trim();
          return [key, note, now, note ? "FALSE" : "TRUE"];
        })
    ),
    0,
    2,
    3
  );
  KWTM_patchStaffDailyNotes_(config, dailyEvents);

  KWTM_upsertRows_(
    ss,
    tabNames.categories,
    [KWTM_CATEGORY_HEADERS].concat(
      (snapshot.categories || []).map(function (category) {
        return [category.id || "", category.name || "", category.color || ""];
      })
    ),
    0
  );

  KWTM_upsertRows_(
    ss,
    tabNames.bills,
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
          bill.deleted ? "TRUE" : "FALSE",
          KWTM_billAmountPaidForSheet_(bill),
        ];
      })
    ),
    0,
    11,
    12
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

/**
 * Mirrors this app's tasks into the staff scheduler's Todos tab, using one read and one
 * write.
 *
 * The previous version wrote each field of each row with its own setValue -- nine calls per
 * updated todo -- and appendRow per insert. Twenty mirrored todos meant close to two
 * hundred round trips to Sheets while holding the script lock, comfortably long enough to
 * outlive the caller's timeout. The layout here is the staff app's, not ours, so extra
 * columns are read and written back untouched.
 */
function KWTM_patchStaffTodos_(config, tasks) {
  var spreadsheetId = KWTM_staffTodosSheetId_(config);
  if (!spreadsheetId) return { skipped: true, reason: "No staff scheduler sheet ID." };

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var tabName = KWTM_pickTab_(KWTM_sheetTitles_(ss), ["Todos", "Todo"]);
  if (!tabName) return { skipped: true, reason: "No Todos tab found." };

  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { skipped: true, reason: "No Todos sheet found." };

  var width = Math.max(KWTM_STAFF_TODO_HEADERS.length, sheet.getLastColumn());
  var lastRow = sheet.getLastRow();
  KWTM_ensureSheetSize_(sheet, Math.max(lastRow, 1), width);

  if (lastRow < 1) {
    sheet.getRange(1, 1, 1, KWTM_STAFF_TODO_HEADERS.length).setValues([KWTM_STAFF_TODO_HEADERS]);
    lastRow = 1;
  }

  var block = (lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : []).map(function (row) {
    return KWTM_padRow_(row, width);
  });

  var indexById = {};
  var existingMirrorIds = {};
  block.forEach(function (row, index) {
    var id = String(row[0] || "").trim();
    if (!id || id in indexById) return;
    indexById[id] = index;
    if (KWTM_isKwtmStaffMirrorId_(id)) existingMirrorIds[id] = index;
  });

  var updated = 0;
  var inserted = 0;
  var closed = 0;
  var activeMirrorIds = {};

  (tasks || []).forEach(function (task) {
    var isStaffTask = task.source === "staff" || String(task.id || "").match(/^staff-/);
    var rawId = isStaffTask ? String(task.id || "").replace(/^staff-/, "") : "kwtm-" + String(task.id || "");
    var index = indexById[rawId];

    if (isStaffTask) {
      // Staff-owned rows are never created here, only updated in place.
      if (index === undefined) return;
      KWTM_applyStaffTodoUpdate_(block[index], task);
      updated += 1;
      return;
    }

    if (!KWTM_shouldMirrorPrivateTaskToStaff_(task)) {
      if (index !== undefined) {
        KWTM_applyStaffTodoClose_(block[index]);
        closed += 1;
        activeMirrorIds[rawId] = true;
      }
      return;
    }

    activeMirrorIds[rawId] = true;
    var mirrorRow = KWTM_padRow_(KWTM_staffTodoMirrorRow_(rawId, task), width);
    if (index !== undefined) {
      for (var column = 0; column < KWTM_STAFF_TODO_HEADERS.length; column += 1) {
        block[index][column] = mirrorRow[column];
      }
      updated += 1;
      return;
    }

    indexById[rawId] = block.push(mirrorRow) - 1;
    inserted += 1;
  });

  Object.keys(existingMirrorIds).forEach(function (id) {
    if (activeMirrorIds[id]) return;
    KWTM_applyStaffTodoClose_(block[existingMirrorIds[id]]);
    closed += 1;
  });

  if (block.length) {
    KWTM_ensureSheetSize_(sheet, block.length + 1, width);
    sheet.getRange(2, 1, block.length, width).setValues(block);
  }

  return { skipped: false, updated: updated, inserted: inserted, closed: closed };
}

function KWTM_shouldMirrorPrivateTaskToStaff_(task) {
  return Boolean(
    task &&
      !task.deleted &&
      !task.completed &&
      String(task.assignee || "").trim() &&
      !KWTM_isKarlAssignee_(task.assignee)
  );
}

/** Mutates a Todos row in place. Column numbers are the staff app's, hence the offsets. */
function KWTM_applyStaffTodoUpdate_(row, task) {
  row[1] = task.title || "";
  row[2] = task.category || "";
  row[3] = task.completed ? "TRUE" : "FALSE";
  row[7] = new Date().toISOString();
  row[8] = task.specificDate || "";
  row[10] = task.assignee || "";
  row[12] = task.originTaskId || "";
  row[13] = KWTM_staffTodoPriorityForSheet_(task.priority);
  row[14] = task.shiftHours || "";
}

function KWTM_staffTodoMirrorRow_(rawId, task) {
  var now = new Date().toISOString();
  return [
    rawId,
    task.title || "",
    task.category || "",
    task.completed ? "TRUE" : "FALSE",
    "Karl Weekly Task Manager",
    now,
    "Karl Weekly Task Manager",
    now,
    task.specificDate || "",
    "",
    task.assignee || "",
    "",
    task.originTaskId || String(task.id || ""),
    KWTM_staffTodoPriorityForSheet_(task.priority),
    task.shiftHours || "",
  ];
}

function KWTM_applyStaffTodoClose_(row) {
  row[3] = "TRUE";
  row[7] = new Date().toISOString();
}

function KWTM_patchStaffDailyNotes_(config, dailyEvents) {
  if (!KWTM_hasRecordKeys_(dailyEvents)) return { skipped: true, reason: "No private event notes to mirror." };

  var spreadsheetId = KWTM_staffTodosSheetId_(config);
  if (!spreadsheetId) return { skipped: true, reason: "No staff scheduler sheet ID." };

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var tabName = KWTM_pickTab_(KWTM_sheetTitles_(ss), ["DailyNotes", "Daily Notes", "Events", "Notes", "Daily Agenda"]) || "DailyNotes";
  var now = new Date().getTime();

  var rows = [KWTM_DAILY_HEADERS].concat(
    Object.keys(dailyEvents)
      .sort()
      .map(function (key) {
        var note = String(dailyEvents[key] || "").trim();
        return [key, note, now, note ? "FALSE" : "TRUE"];
      })
  );

  KWTM_upsertRows_(ss, tabName, rows, 0, 2, 3);
  return { skipped: false, rows: rows.length - 1 };
}

/**
 * Merges `rows` (header first) into `tabName`, keyed on `keyColumnIndex`, using one read
 * and one write.
 *
 * This used to issue a setValues call per changed row, plus a deleteRow per expired
 * tombstone. A busy week meant dozens of round trips to Sheets, each a few hundred
 * milliseconds, all of them inside the script lock -- which is what pushed executions past
 * the caller's timeout and left concurrent syncs to be shed by Apps Script as HTML error
 * pages. Assembling the block in memory and writing it once costs two calls regardless of
 * how much changed.
 */
function KWTM_upsertRows_(ss, tabName, rows, keyColumnIndex, updatedAtColumnIndex, deletedColumnIndex) {
  var normalized = KWTM_normalizeRows_(rows);
  if (!normalized.length) return;

  var sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
  var header = normalized[0];
  var width = header.length;
  var lastRow = sheet.getLastRow();
  // Columns past the ones we manage belong to whoever added them; read and write them back
  // untouched rather than truncating the sheet to our own schema.
  var readWidth = Math.max(width, sheet.getLastColumn());

  KWTM_ensureSheetSize_(sheet, Math.max(lastRow, 1), readWidth);
  var block = (lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, readWidth).getValues() : []).map(function (row) {
    return KWTM_padRow_(row, readWidth);
  });

  var indexByKey = {};
  block.forEach(function (row, index) {
    var key = String(row[keyColumnIndex] || "").trim();
    if (key && !(key in indexByKey)) indexByKey[key] = index;
  });

  normalized.slice(1).forEach(function (row) {
    var key = String(row[keyColumnIndex] || "").trim();
    if (!key) return;

    var index = indexByKey[key];
    if (index === undefined) {
      indexByKey[key] = block.push(KWTM_padRow_(row, readWidth)) - 1;
      return;
    }

    var existing = block[index];
    if (KWTM_shouldSkipStaleRow_(row, existing, updatedAtColumnIndex)) return;
    // A row whose only difference is its timestamp is not an edit. Rewriting it anyway
    // would hand this client precedence over another client's real, older-timestamped
    // change on the next sync -- notably for Events, whose updatedAt is stamped fresh on
    // every push because the payload carries no per-note timestamp of its own.
    if (KWTM_rowMatchesIgnoringUpdatedAt_(row, existing, width, updatedAtColumnIndex)) return;
    for (var column = 0; column < width; column += 1) existing[column] = row[column];
  });

  KWTM_ensureSheetSize_(sheet, block.length + 1, readWidth);
  sheet.getRange(1, 1, 1, width).setValues([header]);
  if (block.length) sheet.getRange(2, 1, block.length, readWidth).setValues(block);

  var pruneRowNumbers = [];
  block.forEach(function (row, index) {
    if (KWTM_shouldPruneDeletedRow_(row, deletedColumnIndex, updatedAtColumnIndex)) {
      pruneRowNumbers.push(index + 2);
    }
  });
  KWTM_deleteRows_(sheet, pruneRowNumbers);
}

function KWTM_padRow_(row, width) {
  var next = row.slice(0, width);
  while (next.length < width) next.push("");
  return next;
}

function KWTM_rowMatchesIgnoringUpdatedAt_(incomingRow, existingRow, width, updatedAtColumnIndex) {
  for (var column = 0; column < width; column += 1) {
    if (column === updatedAtColumnIndex) continue;
    if (String(incomingRow[column] === undefined ? "" : incomingRow[column]) !==
        String(existingRow[column] === undefined ? "" : existingRow[column])) {
      return false;
    }
  }
  return true;
}

function KWTM_shouldSkipStaleRow_(incomingRow, existingRow, updatedAtColumnIndex) {
  if (typeof updatedAtColumnIndex !== "number") return false;
  var incomingUpdatedAt = Number(incomingRow[updatedAtColumnIndex] || 0);
  var existingUpdatedAt = Number(existingRow[updatedAtColumnIndex] || 0);
  return Boolean(incomingUpdatedAt && existingUpdatedAt && existingUpdatedAt > incomingUpdatedAt);
}

function KWTM_shouldPruneDeletedRow_(row, deletedColumnIndex, updatedAtColumnIndex) {
  if (typeof deletedColumnIndex !== "number" || typeof updatedAtColumnIndex !== "number") return false;
  var cutoff = new Date().getTime() - KWTM_SOFT_DELETE_RETENTION_MS;
  var deleted = String(row[deletedColumnIndex] || "").trim().toLowerCase() === "true";
  var updatedAt = Number(row[updatedAtColumnIndex] || 0);
  return Boolean(deleted && updatedAt && updatedAt < cutoff);
}

/**
 * Deletes the given row numbers, bottom-up, collapsing consecutive rows into one call.
 *
 * Bottom-up keeps every not-yet-deleted row number valid as the sheet shifts up. The run
 * grouping matters when a batch of tombstones ages out together: 40 expired rows was 40
 * deleteRow calls, and now it is one.
 */
function KWTM_deleteRows_(sheet, rowNumbers) {
  var seen = {};
  var sorted = [];
  (rowNumbers || []).forEach(function (rowNumber) {
    if (rowNumber <= 1 || seen[rowNumber]) return;
    seen[rowNumber] = true;
    sorted.push(rowNumber);
  });
  if (!sorted.length) return;

  sorted.sort(function (a, b) {
    return b - a;
  });

  var runEnd = sorted[0];
  var runStart = runEnd;
  for (var i = 1; i <= sorted.length; i += 1) {
    var rowNumber = sorted[i];
    if (rowNumber === runStart - 1) {
      runStart = rowNumber;
      continue;
    }
    sheet.deleteRows(runStart, runEnd - runStart + 1);
    if (rowNumber === undefined) return;
    runEnd = rowNumber;
    runStart = rowNumber;
  }
}

function KWTM_overwriteRows_(ss, tabName, rows) {
  var normalized = KWTM_normalizeRows_(rows);
  var sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
  sheet.clearContents();
  if (!normalized.length) return;

  KWTM_ensureSheetSize_(sheet, normalized.length, normalized[0].length);
  sheet.getRange(1, 1, normalized.length, normalized[0].length).setValues(normalized);
}

function KWTM_normalizeRows_(rows) {
  if (!rows || !rows.length) return [];

  var width = rows.reduce(function (max, row) {
    return Math.max(max, row.length);
  }, 1);

  return rows.map(function (row) {
    var next = row.slice();
    while (next.length < width) next.push("");
    return next;
  });
}

/**
 * Daily snapshot of the tabs this script writes. Install with
 * KWTM_installDailyBackupTrigger, or run by hand from the Apps Script editor.
 *
 * Backups used to be taken inline, from KWTM_upsertRows_, on the first write of each day.
 * That put a full copy of four tabs on the critical path of whichever save happened to be
 * first -- usually the morning's, which is exactly when it was most likely to be blamed on
 * the connection. Nothing about a backup needs to happen while the user waits.
 */
function KWTM_dailyBackup() {
  var ss = SpreadsheetApp.openById(KWTM_privateSheetId_({}));
  var tabNames = KWTM_privateTabNames_(ss);
  var backedUp = [];

  [tabNames.tasks, tabNames.dailyEvents, tabNames.categories, tabNames.bills].forEach(function (tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    KWTM_backupTab_(ss, tabName, sheet);
    backedUp.push(tabName);
  });

  return { backedUp: backedUp, on: KWTM_todayKey_() };
}

/** Run once from the Apps Script editor to schedule KWTM_dailyBackup for ~3am. */
function KWTM_installDailyBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "KWTM_dailyBackup") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("KWTM_dailyBackup").timeBased().atHour(3).everyDays(1).create();
  return "Daily backup trigger installed for ~3am " + Session.getScriptTimeZone() + ".";
}

function KWTM_backupTab_(ss, tabName, sourceSheet) {
  if (!sourceSheet || sourceSheet.getLastRow() < 1 || sourceSheet.getLastColumn() < 1) return;

  var backupPrefix = "_KWTM Backup - " + tabName + " - ";
  var backupName = backupPrefix + KWTM_todayKey_();
  if (ss.getSheetByName(backupName)) return;

  var values = sourceSheet.getRange(1, 1, sourceSheet.getLastRow(), sourceSheet.getLastColumn()).getValues();
  var backupSheet = ss.insertSheet(backupName);
  KWTM_ensureSheetSize_(backupSheet, values.length, values[0].length);
  backupSheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  backupSheet.hideSheet();
  KWTM_pruneOldBackupTabs_(ss, backupPrefix);
}

function KWTM_pruneOldBackupTabs_(ss, backupPrefix) {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KWTM_BACKUP_RETENTION_DAYS);
  var cutoffKey = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), "yyyy-MM-dd");

  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name.indexOf(backupPrefix) !== 0) return;
    var dateKey = name.slice(backupPrefix.length);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey) && dateKey < cutoffKey) ss.deleteSheet(sheet);
  });
}

function KWTM_todayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function KWTM_ensureSheetSize_(sheet, rowCount, columnCount) {
  if (sheet.getMaxRows() < rowCount) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rowCount - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < columnCount) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), columnCount - sheet.getMaxColumns());
  }
}

function KWTM_dateForWeekDay_(weekId, dayOfWeek) {
  var parts = String(weekId || "").split("-").map(Number);
  var date = new Date(parts[0], parts[1] - 1, parts[2]);
  date.setDate(date.getDate() + Math.max(1, Math.min(7, Number(dayOfWeek || 1))) - 1);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function KWTM_taskReminderDateForSheet_(task) {
  if (task && task.isGeneralReminder) return "";
  return task.reminderDate || "";
}

function KWTM_taskDayOfWeekForSheet_(task) {
  if (task && task.isGeneralReminder) return "";
  return task.dayOfWeek || "";
}

function KWTM_taskWeekIdForSheet_(task) {
  if (task && task.isGeneralReminder) return "";
  return task.weekId || "";
}

function KWTM_taskRepeatsWeeklyForSheet_(task) {
  if (task && task.isGeneralReminder) return "FALSE";
  return task && task.repeatsWeekly ? "TRUE" : "FALSE";
}

function KWTM_taskRepeatPatternForSheet_(task) {
  if (task && task.isGeneralReminder) return "none";
  return task && task.repeatPattern ? task.repeatPattern : "none";
}

function KWTM_billFrequencyForSheet_(bill) {
  if (bill.frequency) return bill.frequency;
  return bill.recurring ? "monthly" : "one-time";
}

// v1.1 -- 2026-08-21 -- Partial payments: a bill with money against it but a balance
// left reads as "partial" in the sheet instead of "upcoming".
//
// The three statuses this app derives -- paid, partial, upcoming -- are always recomputed
// from the current amounts. A status pulled from the sheet is only passed through when a
// human wrote something else there ("disputed"), so clearing a bill's payments cannot
// leave a stale "partial" sitting next to an amountPaid of 0 forever.
function KWTM_billStatusForSheet_(bill) {
  if (bill.paid) return "paid";
  var current = bill.status ? String(bill.status).toLowerCase() : "";
  var isDerived = current === "" || current === "paid" || current === "partial" || current === "upcoming";
  if (!isDerived) return bill.status;
  if (KWTM_billAmountPaidForSheet_(bill) > 0) return "partial";
  return "upcoming";
}

// v1.1 -- 2026-08-21 -- Dollars paid so far, clamped to the bill amount.
function KWTM_billAmountPaidForSheet_(bill) {
  var amount = Number(bill.amount || 0);
  if (!isFinite(amount) || amount < 0) amount = 0;
  if (bill.paid) return amount;
  var paidSoFar = Number(bill.amountPaid || 0);
  if (!isFinite(paidSoFar) || paidSoFar < 0) paidSoFar = 0;
  return Math.min(paidSoFar, amount);
}

function KWTM_staffTodoPriorityForSheet_(priority) {
  var normalized = String(priority || "").toLowerCase();
  if (normalized === "high") return "high";
  if (normalized === "low") return "low";
  return "normal";
}

function KWTM_json_(payload) {
  payload.app = payload.app || "karl-weekly-task-manager";
  payload.version = KWTM_SCRIPT_VERSION;
  payload.updatedAt = KWTM_SCRIPT_UPDATED_AT;
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
