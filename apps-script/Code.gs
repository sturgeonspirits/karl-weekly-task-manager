// KWTM_SCRIPT_VERSION: 2026-09-02.9
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
 * - KWTM_SCRIPT_VERSION 2026-09-02.9
 * - KWTM_SCRIPT_UPDATED_AT 2026-09-02
 * - Open the deployed web app URL in a browser to confirm the live script version.
 *
 * Invariant: no code path may throw out of doPost. Apps Script answers an uncaught error
 * with an HTML error page rather than JSON, and the Netlify function on the other end can
 * then only report "Apps Script did not return JSON." -- the same opaque line for a
 * transient hiccup and for a real, fixable fault. Every entry point ends in KWTM_json_.
 */

var KWTM_SCRIPT_VERSION = "2026-09-02.9";
var KWTM_SCRIPT_UPDATED_AT = "2026-09-02";

// How long to wait for the script lock before telling the caller to come back. Kept short
// on purpose -- see KWTM_tryLock_ for why a long wait actively makes things worse.
var KWTM_LOCK_WAIT_MS = 8000;

// Sheets refuses any cell over 50,000 characters, and one oversized cell fails the entire
// write. Truncating below that keeps every other row saving.
var KWTM_MAX_CELL_CHARS = 45000;
var KWTM_TRUNCATION_MARKER = "\n[truncated by sync: cell exceeded 45000 characters]";
var KWTM_STAFF_TODOS_SHEET_ID_FALLBACK = "1TsSonscE_UZ9A80tLSVxdnKQx_udYWGWQejTPh17wtg";
var KWTM_SOFT_DELETE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// Three days, not eight. These snapshots live inside the workbook the app opens on every
// single sync, so each one is a permanent tax on every read and write. Google Sheets keeps
// its own full version history (File > Version history), which is a better restore path than
// these tabs; they exist only as a fast in-sheet undo for a bad write, and three days of
// that is plenty. Set KWTM_BACKUP_SHEET_ID to move them out of the live workbook entirely.
var KWTM_BACKUP_RETENTION_DAYS = 3;

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

    // Reading both workbooks in one request was the single slowest call in the app, and it
    // has to finish inside the caller's budget or the connection is dropped and the whole
    // refresh is lost. `scope` lets the client fetch them as two requests, each with its
    // own budget. An absent scope still reads both, for callers running an older bundle.
    if (body.action === "pull") {
      var scope = String(body.scope || "both");
      var pulled = { ok: true };
      if (scope === "private" || scope === "both") pulled.private = KWTM_readPrivateWorkbook_(body.config || {});
      if (scope === "staff" || scope === "both") pulled.staff = KWTM_readStaffWorkbook_(body.config || {});
      return KWTM_json_(pulled);
    }

    // One request, one lock, one execution slot. The client used to send pushOperations,
    // pushStaffTodos and pushStaffSchedule as three separate round trips per save; with two
    // clients open that is six executions contending for one script lock, which is what
    // made Apps Script start shedding requests as HTML. The three actions below are kept so
    // a browser still running the old bundle keeps working during a rollout.
    // Read-only, and deliberately its own action: the archive is not part of a normal sync,
    // so the app fetches it only when someone opens the Archive view. Keeping it off the
    // pull path means a large history never slows down opening the app.
    if (body.action === "pullArchive") {
      var archiveSpreadsheet = KWTM_archiveSpreadsheet_();
      if (!archiveSpreadsheet) {
        return KWTM_json_({ ok: true, configured: false, rows: [] });
      }
      return KWTM_json_({
        ok: true,
        configured: true,
        tab: String(body.tab || "Tasks"),
        rows: KWTM_readArchiveRows_(archiveSpreadsheet, String(body.tab || "Tasks"), Number(body.limit || 0)),
      });
    }

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
      var todoConfig = body.config || {};
      var todoResult = KWTM_patchStaffTodos_(todoConfig, body.tasks || []);
      // Same workbook, already open: mirroring the notes here costs almost nothing, where
      // doing it from pushOperations cost that request a second openById.
      var notesResult = KWTM_patchStaffDailyNotes_(todoConfig, body.dailyEvents || {});
      return KWTM_json_({ ok: true, result: todoResult, notes: notesResult });
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
  result.staffNotes = KWTM_mirror_(warnings, "staffNotes", function () {
    return KWTM_patchStaffDailyNotes_(config, (body.snapshot || {}).dailyEvents || {});
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
  // The staff-workbook mirror of these notes deliberately does NOT happen here. Opening a
  // second spreadsheet inside this request roughly doubled its time, and the whole request
  // has to finish inside the caller's budget. pushStaffTodos already has that workbook
  // open, so the mirror rides along there instead.

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
    sheet.getRange(2, 1, block.length, width).setValues(
      block.map(function (row) {
        return row.map(KWTM_capCell_);
      })
    );
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
  var duplicateRowNumbers = [];
  block.forEach(function (row, index) {
    var key = KWTM_normalizeKey_(row[keyColumnIndex]);
    if (!key) return;
    if (key in indexByKey) {
      // Self-healing: a key that already has a row is a duplicate this bug created, and
      // leaving it would let the concatenation keep multiplying. Collapse onto the first.
      duplicateRowNumbers.push(index + 2);
      return;
    }
    indexByKey[key] = index;
  });

  normalized.slice(1).forEach(function (row) {
    var key = KWTM_normalizeKey_(row[keyColumnIndex]);
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
  if (block.length) {
    sheet.getRange(2, 1, block.length, readWidth).setValues(
      block.map(function (row) {
        return row.map(KWTM_capCell_);
      })
    );
  }

  var pruneRowNumbers = duplicateRowNumbers.slice();
  block.forEach(function (row, index) {
    if (KWTM_shouldPruneDeletedRow_(row, deletedColumnIndex, updatedAtColumnIndex)) {
      pruneRowNumbers.push(index + 2);
    }
  });
  KWTM_deleteRows_(sheet, pruneRowNumbers);
}

/**
 * A cell value reduced to the string the rest of the sync compares against.
 *
 * This exists because reads and writes disagreed about what a key is. KWTM_readRows_ uses
 * getDisplayValues, so the app sees the Events key as the text "2026-08-25". KWTM_upsertRows_
 * matched on getValues, and Sheets stores a date-shaped key as a real Date -- whose string
 * form is "Mon Aug 25 2026 00:00:00 GMT-0500 (CDT)". That never equalled the incoming key,
 * so every sync decided the row was new and appended another copy. The Events tab reached
 * 6,124 rows across 5 distinct keys; one key had 6,081 rows. parseDailyEvents then joined
 * all of a key's rows into one string, the app saved that string back, and the next sync
 * joined it again -- multiplying the cell by the duplicate count until it passed the
 * 50,000-character ceiling and blocked every save.
 *
 * Tasks and Bills were untouched because they key on ids like "task-..." that Sheets cannot
 * coerce into a date. That contrast is what identified this.
 */
function KWTM_normalizeKey_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return String(value === undefined || value === null ? "" : value).trim();
}

/** Keeps one oversized cell from failing the whole write. See KWTM_MAX_CELL_CHARS. */
function KWTM_capCell_(value) {
  if (typeof value !== "string" || value.length <= KWTM_MAX_CELL_CHARS) return value;
  return value.slice(0, KWTM_MAX_CELL_CHARS - KWTM_TRUNCATION_MARKER.length) + KWTM_TRUNCATION_MARKER;
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
/**
 * Where snapshots are written. Set the KWTM_BACKUP_SHEET_ID script property to the id of a
 * separate, empty spreadsheet and backups stop weighing on the live workbook.
 *
 * This matters more than it sounds. On 2026-09-02 the private workbook held 34 backup tabs
 * totalling 837,902 characters against 271,256 characters of real data -- 76% of the file
 * was snapshots, and every openById, getSheets and tab lookup on the sync path paid for it.
 * Falls back to the live workbook so a missing or unreadable property never loses a backup.
 */
/**
 * The long-term record: every version of every row, appended once, kept forever.
 *
 * Daily full snapshots were the wrong shape for this. They stored a complete copy of each
 * tab per day -- almost entirely identical to yesterday's, so the cost grew with the size of
 * the sheet rather than with how much actually changed -- and they still lost anything that
 * was edited twice between two runs. An append-only archive keyed on (id, updatedAt) records
 * each distinct version exactly once, so it grows only when something really changes, and
 * nothing is ever overwritten.
 *
 * Set KWTM_ARCHIVE_SHEET_ID to a separate empty spreadsheet's id. Returns null when it is
 * unset or unreadable, in which case the caller falls back to snapshots.
 */
var KWTM_ARCHIVE_DEFAULT_LIMIT = 1500;
var KWTM_ARCHIVE_MAX_LIMIT = 5000;

/**
 * The most recent `limit` archived rows, header first.
 *
 * Reads from the END of the sheet rather than the start. The archive is append-only and only
 * ever grows, so the newest rows are the last ones, and reading the whole tab would put the
 * request back under the timeout pressure described in the sync notes.
 */
function KWTM_readArchiveRows_(ss, tabName, limit) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];

  var capped = Math.min(Math.max(Number(limit) || KWTM_ARCHIVE_DEFAULT_LIMIT, 1), KWTM_ARCHIVE_MAX_LIMIT);
  var lastRow = sheet.getLastRow();
  var width = sheet.getLastColumn();
  var start = Math.max(2, lastRow - capped + 1);

  return sheet
    .getRange(1, 1, 1, width)
    .getDisplayValues()
    .concat(sheet.getRange(start, 1, lastRow - start + 1, width).getDisplayValues());
}

function KWTM_archiveSpreadsheet_() {
  var id = KWTM_property_("KWTM_ARCHIVE_SHEET_ID");
  if (!id) return null;
  try {
    return SpreadsheetApp.openById(id);
  } catch (error) {
    return null;
  }
}

var KWTM_ARCHIVE_STAMP_HEADER = "archivedAt";

/**
 * Records the FINAL state of every row, one row per id, kept forever.
 *
 * Not a version log. Edits in progress are not interesting -- what matters is that a task
 * which has left the live sheet is still readable afterwards. So a row already in the
 * archive is updated in place when the live sheet has a newer version of it, and a row that
 * disappears from the live sheet simply stays at whatever state it last had. One row per
 * task, forever, no growth from editing.
 *
 * Reads with getDisplayValues so what is archived is what you would see in the sheet, and
 * matches ids through KWTM_normalizeKey_ so a date-shaped key cannot read back differently
 * and duplicate the whole tab -- the mistake that produced 6,081 rows for one key.
 */
function KWTM_archiveTab_(archiveSpreadsheet, tabName, sourceSheet, headers, keyColumnIndex, updatedAtColumnIndex) {
  if (!sourceSheet || sourceSheet.getLastRow() < 2) return { tab: tabName, added: 0, updated: 0, skipped: "empty" };

  var width = headers.length;
  var stampIndex = width;
  var readWidth = Math.min(sourceSheet.getLastColumn(), width);
  var sourceRows = sourceSheet.getRange(2, 1, sourceSheet.getLastRow() - 1, readWidth).getDisplayValues();

  var target = archiveSpreadsheet.getSheetByName(tabName);
  if (!target) {
    target = archiveSpreadsheet.insertSheet(tabName);
    KWTM_ensureSheetSize_(target, 1, width + 1);
    target.getRange(1, 1, 1, width + 1).setValues([headers.concat([KWTM_ARCHIVE_STAMP_HEADER])]);
  }

  var archivedRows = target.getLastRow();
  KWTM_ensureSheetSize_(target, Math.max(archivedRows, 1), width + 1);
  var block = (archivedRows > 1 ? target.getRange(2, 1, archivedRows - 1, width + 1).getDisplayValues() : []).map(
    function (row) {
      return KWTM_padRow_(row, width + 1);
    }
  );

  var indexByKey = {};
  block.forEach(function (row, index) {
    var key = KWTM_normalizeKey_(row[keyColumnIndex]);
    if (key && !(key in indexByKey)) indexByKey[key] = index;
  });

  var stamp = new Date().toISOString();
  var added = 0;
  var updated = 0;

  sourceRows.forEach(function (row) {
    var padded = KWTM_padRow_(row, width).map(KWTM_capCell_);
    var key = KWTM_normalizeKey_(padded[keyColumnIndex]);
    if (!key) return;

    var index = indexByKey[key];
    if (index === undefined) {
      indexByKey[key] = block.push(padded.concat([stamp])) - 1;
      added += 1;
      return;
    }

    var existing = block[index];
    // Nothing changed since we last saw it, so leave the archived stamp alone.
    if (KWTM_rowMatchesIgnoringUpdatedAt_(padded, existing, width, updatedAtColumnIndex)) return;
    if (KWTM_shouldSkipStaleRow_(padded, existing, updatedAtColumnIndex)) return;

    for (var column = 0; column < width; column += 1) existing[column] = padded[column];
    existing[stampIndex] = stamp;
    updated += 1;
  });

  if (block.length) {
    KWTM_ensureSheetSize_(target, block.length + 1, width + 1);
    target.getRange(2, 1, block.length, width + 1).setValues(block);
  }

  return { tab: tabName, added: added, updated: updated, total: block.length };
}

function KWTM_backupSpreadsheet_(liveSpreadsheet) {
  var id = KWTM_property_("KWTM_BACKUP_SHEET_ID");
  if (!id) return liveSpreadsheet;
  try {
    return SpreadsheetApp.openById(id);
  } catch (error) {
    return liveSpreadsheet;
  }
}

function KWTM_dailyBackup() {
  var ss = SpreadsheetApp.openById(KWTM_privateSheetId_({}));
  var tabNames = KWTM_privateTabNames_(ss);
  var archive = KWTM_archiveSpreadsheet_();

  // With a real archive configured there is nothing for snapshots to add -- the archive
  // already holds every version of every row -- so the live workbook gets no backup tabs at
  // all, and the ones an earlier version left behind are swept.
  if (archive) {
    return {
      on: KWTM_todayKey_(),
      mode: "archive",
      archived: [
        KWTM_archiveTab_(archive, "Tasks", ss.getSheetByName(tabNames.tasks), KWTM_TASK_HEADERS, 0, 15),
        KWTM_archiveTab_(archive, "Events", ss.getSheetByName(tabNames.dailyEvents), KWTM_DAILY_HEADERS, 0, 2),
        KWTM_archiveTab_(archive, "Bills", ss.getSheetByName(tabNames.bills), KWTM_BILL_HEADERS, 0, 11),
      ],
      snapshotTabsRemoved: KWTM_pruneAllBackupTabs_(ss).concat(KWTM_pruneStaffBackupTabs_(tabNames)),
    };
  }

  var target = KWTM_backupSpreadsheet_(ss);
  var backedUp = [];
  [tabNames.tasks, tabNames.dailyEvents, tabNames.categories, tabNames.bills].forEach(function (tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    KWTM_backupTab_(target, tabName, sheet);
    backedUp.push(tabName);
  });

  return {
    on: KWTM_todayKey_(),
    mode: "snapshot",
    warning: "Set KWTM_ARCHIVE_SHEET_ID to keep a permanent record instead of 3 days of snapshots.",
    backedUp: backedUp,
    pruned: KWTM_pruneOldBackupTabs_(target),
    external: target !== ss,
  };
}

/*
 * KWTM_dailyBackup is scheduled from the Triggers panel (clock icon) in the Apps Script
 * editor, NOT from code. An installer function here would have to call the trigger
 * service, and merely referencing that service anywhere in the file adds its OAuth scope
 * to the whole project. Changing a deployed web app's scope set makes its anonymous
 * requests fail until the owner re-authorizes and redeploys -- and that failure happens in
 * the runtime, before doPost runs, so the try/catch above cannot turn it into JSON. The
 * caller just sees an HTML error page. Not worth it for a convenience function that is run
 * exactly once. See the README for the four clicks that replace it.
 */

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
}

/**
 * Deletes every backup tab past the retention window, whatever tab it belonged to.
 *
 * This used to prune only the prefix it had just written, so a backup of a tab that was
 * later renamed or removed stayed forever. Sweeping all of them keeps orphans from
 * accumulating in a workbook the sync path has to read.
 */
/**
 * The staff workbook collects snapshot tabs too, and nothing was ever cleaning them.
 *
 * KWTM_patchStaffDailyNotes_ writes through KWTM_upsertRows_, which used to take a backup
 * inline -- so the staff workbook accumulated its own `_KWTM Backup - DailyNotes - <date>`
 * tabs. Pruning only ever looked at the private workbook, so those were orphaned: 9 tabs and
 * about 536,000 characters, all of it read on the staff half of every pull.
 */
function KWTM_pruneStaffBackupTabs_(config) {
  var spreadsheetId = KWTM_staffTodosSheetId_(config || {});
  if (!spreadsheetId) return [];
  try {
    return KWTM_pruneAllBackupTabs_(SpreadsheetApp.openById(spreadsheetId));
  } catch (error) {
    return [];
  }
}

/**
 * One-off maintenance: collapse duplicate-key rows and sweep snapshot tabs in both workbooks.
 *
 * Run this by hand from the editor when a workbook has already accumulated damage. The
 * ordinary sync collapses duplicates as it writes, but that only helps if a write succeeds --
 * and once a tab is bloated enough, the write is exactly what times out. This does the
 * collapse without needing the app to complete a sync first.
 *
 * Passing just a header row to KWTM_upsertRows_ updates nothing and rewrites the block, which
 * is all the collapse needs.
 */
function KWTM_repairWorkbooks() {
  var ss = SpreadsheetApp.openById(KWTM_privateSheetId_({}));
  var tabNames = KWTM_privateTabNames_(ss);
  var report = { privateSnapshotsRemoved: KWTM_pruneAllBackupTabs_(ss) };

  KWTM_upsertRows_(ss, tabNames.dailyEvents, [KWTM_DAILY_HEADERS], 0, 2, 3);
  report.privateEvents = KWTM_rowCount_(ss, tabNames.dailyEvents);

  var staffId = KWTM_staffTodosSheetId_({});
  if (staffId) {
    var staff = SpreadsheetApp.openById(staffId);
    report.staffSnapshotsRemoved = KWTM_pruneAllBackupTabs_(staff);
    var notesTab = KWTM_pickTab_(KWTM_sheetTitles_(staff), ["DailyNotes", "Daily Notes", "Events", "Notes", "Daily Agenda"]);
    if (notesTab) {
      KWTM_upsertRows_(staff, notesTab, [KWTM_DAILY_HEADERS], 0, 2, 3);
      report.staffDailyNotes = KWTM_rowCount_(staff, notesTab);
    }
  }

  return report;
}

function KWTM_rowCount_(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  return sheet ? Math.max(sheet.getLastRow() - 1, 0) : 0;
}

/** Removes every snapshot tab, whatever its date. Used once an archive supersedes them. */
function KWTM_pruneAllBackupTabs_(ss) {
  var sheets = ss.getSheets();
  var remaining = sheets.length;
  var removed = [];
  sheets.forEach(function (sheet) {
    var name = sheet.getName();
    if (name.indexOf("_KWTM Backup - ") !== 0 || remaining <= 1) return;
    ss.deleteSheet(sheet);
    remaining -= 1;
    removed.push(name);
  });
  return removed;
}

function KWTM_pruneOldBackupTabs_(ss) {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KWTM_BACKUP_RETENTION_DAYS);
  var cutoffKey = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), "yyyy-MM-dd");

  var sheets = ss.getSheets();
  var remaining = sheets.length;
  var removed = [];

  sheets.forEach(function (sheet) {
    var name = sheet.getName();
    if (name.indexOf("_KWTM Backup - ") !== 0) return;

    var dateKey = name.slice(name.length - 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
    // `<=` not `<`: with an 8-day window the old comparison kept nine days of snapshots.
    if (dateKey > cutoffKey) return;
    // A spreadsheet must keep at least one sheet, and a dedicated backup workbook can be
    // nothing but backups -- deleting the last one would throw and lose the whole run.
    if (remaining <= 1) return;

    ss.deleteSheet(sheet);
    remaining -= 1;
    removed.push(name);
  });

  return removed;
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
