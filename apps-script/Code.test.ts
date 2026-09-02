import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvironment, FakeSheet, FakeSpreadsheet } from "./fakeSpreadsheet";
import { loadCodeGs, type CodeGs } from "./loadCodeGs";

/**
 * Tests for the half of the sync that writes to your spreadsheet. Everything here runs the
 * real Code.gs -- see loadCodeGs.ts.
 */

const PRIVATE_ID = "private-sheet";
const DAY_MS = 24 * 60 * 60 * 1000;

const TASK_HEADERS = [
  "id", "title", "category", "description", "dayOfWeek", "completed", "weekId",
  "repeatsWeekly", "repeatPattern", "originTaskId", "deleted", "reminderDate",
  "assignee", "priority", "shiftHours", "updatedAt",
];

function taskRow(id: string, title: string, updatedAt: number, deleted = false): string[] {
  return [
    id, title, "Production", "", "3", "FALSE", "2026-08-03", "FALSE", "none", "",
    deleted ? "TRUE" : "FALSE", "", "", "medium", "", String(updatedAt),
  ];
}

describe("Code.gs", () => {
  let sheets: FakeSpreadsheet;
  let script: CodeGs;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T12:00:00Z"));
    sheets = new FakeSpreadsheet(PRIVATE_ID);
    const env = createEnvironment({
      spreadsheets: { [PRIVATE_ID]: sheets },
      properties: { KWTM_SYNC_TOKEN: "test-token" },
      active: sheets,
    });
    script = loadCodeGs(env.globals);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedTasks(rows: string[][]): FakeSheet {
    return sheets.add(FakeSheet.from("Tasks", [TASK_HEADERS, ...rows]));
  }

  function upsertTasks(rows: string[][]): void {
    script.KWTM_upsertRows_(sheets, "Tasks", [TASK_HEADERS, ...rows], 0, 15, 10);
  }

  describe("upsertRows", () => {
    it("updates an existing row in place, matched by id", () => {
      seedTasks([taskRow("t-1", "Old title", 1000), taskRow("t-2", "Untouched", 1000)]);

      upsertTasks([taskRow("t-1", "New title", 2000)]);

      const rows = sheets.getSheetByName("Tasks")!.rows();
      expect(rows).toHaveLength(3);
      expect(rows[1][1]).toBe("New title");
      expect(rows[2][1]).toBe("Untouched");
    });

    it("appends rows whose id is not already present", () => {
      seedTasks([taskRow("t-1", "Existing", 1000)]);

      upsertTasks([taskRow("t-2", "Brand new", 2000)]);

      const rows = sheets.getSheetByName("Tasks")!.rows();
      expect(rows.map((row) => row[0])).toEqual(["id", "t-1", "t-2"]);
    });

    it("preserves rows that are absent from the payload", () => {
      // This is the guarantee that replaced the old full-overwrite: history the browser
      // no longer holds must survive a save.
      seedTasks([taskRow("old-1", "Last month", 500), taskRow("t-1", "Current", 1000)]);

      upsertTasks([taskRow("t-1", "Current edited", 2000)]);

      const rows = sheets.getSheetByName("Tasks")!.rows();
      expect(rows.map((row) => row[0])).toEqual(["id", "old-1", "t-1"]);
      expect(rows[1][1]).toBe("Last month");
    });

    it("does not overwrite a sheet row that is newer than the incoming one", () => {
      seedTasks([taskRow("t-1", "Newer in sheet", 5000)]);

      upsertTasks([taskRow("t-1", "Stale from browser", 1000)]);

      expect(sheets.getSheetByName("Tasks")!.rows()[1][1]).toBe("Newer in sheet");
    });

    it("creates the tab when it does not exist yet", () => {
      upsertTasks([taskRow("t-1", "First ever", 1000)]);

      expect(sheets.getSheetByName("Tasks")).not.toBeNull();
      expect(sheets.getSheetByName("Tasks")!.rows()[1][1]).toBe("First ever");
    });
  });

  describe("soft-delete pruning", () => {
    it("removes deleted rows past the retention window", () => {
      const stale = Date.now() - (91 * DAY_MS);
      seedTasks([taskRow("keep", "Keep", 1000), taskRow("drop", "Drop", stale, true)]);

      upsertTasks([]);

      expect(sheets.getSheetByName("Tasks")!.rows().map((row) => row[0])).toEqual(["id", "keep"]);
    });

    it("keeps recently deleted rows as tombstones", () => {
      const recent = Date.now() - (5 * DAY_MS);
      seedTasks([taskRow("tombstone", "Recently deleted", recent, true)]);

      upsertTasks([]);

      expect(sheets.getSheetByName("Tasks")!.rows().map((row) => row[0])).toEqual(["id", "tombstone"]);
    });

    it("removes the correct rows when several are pruned at once", () => {
      // deleteRow shifts everything below it up, so pruning must run bottom-up.
      const stale = Date.now() - (100 * DAY_MS);
      seedTasks([
        taskRow("a", "Keep A", 1000),
        taskRow("b", "Drop B", stale, true),
        taskRow("c", "Keep C", 1000),
        taskRow("d", "Drop D", stale, true),
        taskRow("e", "Keep E", 1000),
      ]);

      upsertTasks([]);

      expect(sheets.getSheetByName("Tasks")!.rows().map((row) => row[0])).toEqual(["id", "a", "c", "e"]);
    });

    it("does not prune a deleted row that the payload has just revived", () => {
      const stale = Date.now() - (100 * DAY_MS);
      seedTasks([taskRow("t-1", "Was deleted", stale, true)]);

      upsertTasks([taskRow("t-1", "Back again", Date.now())]);

      const rows = sheets.getSheetByName("Tasks")!.rows();
      expect(rows.map((row) => row[0])).toEqual(["id", "t-1"]);
      expect(rows[1][1]).toBe("Back again");
    });
  });

  // Backups run from a daily time-driven trigger, not from the save path -- a full copy of
  // four tabs has no business making the user's first save of the day wait for it.
  describe("backups", () => {
    it("is not taken on the write path", () => {
      seedTasks([taskRow("t-1", "Original", 1000)]);

      upsertTasks([taskRow("t-1", "Changed", 2000)]);

      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-04")).toBeNull();
    });

    it("copies the tab into a dated hidden backup when the daily job runs", () => {
      seedTasks([taskRow("t-1", "Original", 1000)]);

      script.KWTM_dailyBackup();

      const backup = sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-04");
      expect(backup).not.toBeNull();
      expect(backup!.hidden).toBe(true);
      expect(backup!.rows()[1][1]).toBe("Original");
    });

    it("does not overwrite the day's backup if the job runs twice", () => {
      seedTasks([taskRow("t-1", "Morning state", 1000)]);
      script.KWTM_dailyBackup();

      upsertTasks([taskRow("t-1", "Evening", 3000)]);
      script.KWTM_dailyBackup();

      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-04")!.rows()[1][1]).toBe("Morning state");
      expect(sheets.getSheetByName("Tasks")!.rows()[1][1]).toBe("Evening");
    });

    it("keeps a separate backup per day", () => {
      seedTasks([taskRow("t-1", "Day one", 1000)]);
      script.KWTM_dailyBackup();

      upsertTasks([taskRow("t-1", "Day one edit", 2000)]);
      vi.setSystemTime(new Date("2026-08-05T12:00:00Z"));
      script.KWTM_dailyBackup();

      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-04")!.rows()[1][1]).toBe("Day one");
      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-05")!.rows()[1][1]).toBe("Day one edit");
    });

    it("deletes backups older than the retention window and keeps recent ones", () => {
      sheets.add(FakeSheet.from("_KWTM Backup - Tasks - 2026-07-01", [["stale"]]));
      sheets.add(FakeSheet.from("_KWTM Backup - Tasks - 2026-08-02", [["recent"]]));
      seedTasks([taskRow("t-1", "Now", 1000)]);

      script.KWTM_dailyBackup();

      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-07-01")).toBeNull();
      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-02")).not.toBeNull();
    });

    it("does not touch backups belonging to a different tab than the one being pruned", () => {
      sheets.add(FakeSheet.from("_KWTM Backup - Bills - 2026-07-01", [["other tab"]]));
      seedTasks([taskRow("t-1", "Now", 1000)]);

      script.KWTM_dailyBackup();

      expect(sheets.getSheetByName("_KWTM Backup - Bills - 2026-07-01")).not.toBeNull();
    });
  });

  describe("writeOperations", () => {
    const config = { privateSheetId: PRIVATE_ID };

    it("refuses a snapshot with no private data rather than emptying the sheet", () => {
      seedTasks([taskRow("t-1", "Precious", 1000)]);

      expect(() =>
        script.KWTM_writeOperations_(config, { tasks: [], bills: [], dailyEvents: {}, categories: [] })
      ).toThrow(/empty/i);

      expect(sheets.getSheetByName("Tasks")!.rows()).toHaveLength(2);
    });

    it("writes an undated reminder with blank weekId and dayOfWeek", () => {
      // The counterpart to the client-side fix: a reminder must not acquire a schedule on
      // the way into the sheet either, or it comes back as a Monday task.
      script.KWTM_writeOperations_(config, {
        tasks: [
          {
            id: "airbnb",
            title: "Create ad campaign for Airbnb",
            category: "Marketing",
            isGeneralReminder: true,
            weekId: "2026-08-03",
            dayOfWeek: 1,
            priority: "medium",
            updatedAt: 1700,
          },
        ],
        bills: [],
        dailyEvents: {},
        categories: [],
      });

      const row = sheets.getSheetByName("Tasks")!.rows()[1];
      expect(row[0]).toBe("airbnb");
      expect(row[4]).toBe(""); // dayOfWeek
      expect(row[6]).toBe(""); // weekId
    });

    // v1.1 -- 2026-08-21 -- Partial payments must survive the trip through the sheet.
    it("round-trips a part-paid bill through the Bills tab", async () => {
      const { parseBills } = await import("../src/lib/sheetsService");

      script.KWTM_writeOperations_(config, {
        tasks: [{ id: "t-1", title: "Keep the write non-empty", category: "Production", weekId: "2026-08-03", dayOfWeek: 3, updatedAt: 1 }],
        bills: [
          { id: "b-1", name: "Bottle invoice", amount: 1000, amountPaid: 400, dueDate: "2026-08-10", paid: false, updatedAt: 1700 },
        ],
        dailyEvents: {},
        categories: [],
      });

      const rows = sheets.getSheetByName("Bills")!.rows() as string[][];
      const header = rows[0];
      expect(header).toContain("amountPaid");
      expect(rows[1][header.indexOf("status")]).toBe("partial");

      expect(parseBills(rows.map((row) => row.map((cell) => String(cell ?? ""))))[0]).toMatchObject({
        id: "b-1",
        amount: 1000,
        amountPaid: 400,
        paid: false,
      });
    });

    // v1.1 -- 2026-08-21 -- A status pulled back from the sheet must not outlive the
    // payments that produced it.
    it("recomputes a stale partial status instead of carrying it back", () => {
      script.KWTM_writeOperations_(config, {
        tasks: [{ id: "t-1", title: "Keep the write non-empty", category: "Production", weekId: "2026-08-03", dayOfWeek: 3, updatedAt: 1 }],
        bills: [
          // What "Clear payments" leaves behind: no money against the bill, but the
          // status the previous sync wrote is still attached to the pulled record.
          { id: "b-1", name: "Bottle invoice", amount: 1000, amountPaid: 0, status: "partial", dueDate: "2026-08-10", paid: false, updatedAt: 1700 },
          { id: "b-2", name: "Hop contract", amount: 500, amountPaid: 100, status: "disputed", dueDate: "2026-08-12", paid: false, updatedAt: 1700 },
        ],
        dailyEvents: {},
        categories: [],
      });

      const rows = sheets.getSheetByName("Bills")!.rows() as string[][];
      const status = rows[0].indexOf("status");

      expect(rows[1][status]).toBe("upcoming");
      // A status a human typed into the sheet is not one of ours to overwrite.
      expect(rows[2][status]).toBe("disputed");
    });

    it("excludes staff-sourced tasks from the private Tasks tab", () => {
      script.KWTM_writeOperations_(config, {
        tasks: [
          { id: "t-1", title: "Private", category: "Production", weekId: "2026-08-03", dayOfWeek: 3, updatedAt: 1 },
          { id: "staff-9", title: "Staff todo", source: "staff", weekId: "2026-08-03", dayOfWeek: 3, updatedAt: 1 },
        ],
        bills: [],
        dailyEvents: {},
        categories: [],
      });

      expect(sheets.getSheetByName("Tasks")!.rows().map((row) => row[0])).toEqual(["id", "t-1"]);
    });
  });

  describe("grid growth", () => {
    it("grows the sheet before writing past its current size", () => {
      const narrow = sheets.add(new FakeSheet("Tasks", 2, 4));
      expect(narrow.getMaxColumns()).toBe(4);

      upsertTasks([taskRow("t-1", "Wide row", 1000)]);

      expect(narrow.getMaxColumns()).toBeGreaterThanOrEqual(16);
      expect(narrow.rows()[1][1]).toBe("Wide row");
    });
  });

  describe("unchanged rows", () => {
    it("leaves a row alone when only its timestamp differs", () => {
      // Events carry no per-note timestamp, so every push stamps them "now". Rewriting an
      // untouched note would hand this client precedence over another client's real edit.
      const events = sheets.add(
        FakeSheet.from("Events", [
          ["key", "text", "updatedAt", "deleted"],
          ["2026-08-04", "Delivery at 9", "5000", "FALSE"],
        ])
      );

      script.KWTM_upsertRows_(
        sheets,
        "Events",
        [
          ["key", "text", "updatedAt", "deleted"],
          ["2026-08-04", "Delivery at 9", "9999", "FALSE"],
        ],
        0,
        2,
        3
      );

      expect(events.rows()[1][2]).toBe("5000");
    });

    it("still writes when the text actually changed", () => {
      const events = sheets.add(
        FakeSheet.from("Events", [
          ["key", "text", "updatedAt", "deleted"],
          ["2026-08-04", "Delivery at 9", "5000", "FALSE"],
        ])
      );

      script.KWTM_upsertRows_(
        sheets,
        "Events",
        [
          ["key", "text", "updatedAt", "deleted"],
          ["2026-08-04", "Delivery at 11", "9999", "FALSE"],
        ],
        0,
        2,
        3
      );

      expect(events.rows()[1][1]).toBe("Delivery at 11");
      expect(events.rows()[1][2]).toBe("9999");
    });

    it("keeps columns the sheet has beyond the ones this script manages", () => {
      const wide = sheets.add(
        FakeSheet.from("Tasks", [
          [...TASK_HEADERS, "myNotes"],
          [...taskRow("t-1", "Original", 1000), "hand-typed"],
        ])
      );

      upsertTasks([taskRow("t-1", "Edited", 2000)]);

      const rows = wide.rows();
      expect(rows[1][1]).toBe("Edited");
      expect(rows[1][16]).toBe("hand-typed");
    });
  });

  describe("tab resolution", () => {
    it("writes back to the tab it read from rather than creating the canonical name", () => {
      // A workbook whose tasks live in "Task List" used to be read from there and written
      // to a brand new "Tasks" tab, so the app and the sheet quietly diverged.
      sheets.add(FakeSheet.from("Task List", [TASK_HEADERS, taskRow("t-1", "Existing", 1000)]));

      script.KWTM_writeOperations_(
        { privateSheetId: PRIVATE_ID },
        {
          tasks: [
            { id: "t-1", title: "Edited", category: "Production", weekId: "2026-08-03", dayOfWeek: 3, updatedAt: 2000 },
          ],
          bills: [],
          dailyEvents: {},
          categories: [],
        }
      );

      expect(sheets.getSheetByName("Task List")!.rows()[1][1]).toBe("Edited");
      expect(sheets.getSheetByName("Tasks")).toBeNull();
    });
  });

  describe("patchStaffTodos", () => {
    const STAFF_ID = "staff-sheet";
    const TODO_HEADERS = [
      "id", "title", "category", "completed", "createdBy", "createdAt", "updatedBy",
      "updatedAt", "dueDate", "token", "assignee", "proof", "originTaskId", "priority", "shiftHours",
    ];

    function todoRow(id: string, title: string, assignee = "Sam"): string[] {
      return [id, title, "Bar", "FALSE", "Sam", "", "", "", "2026-08-05", "", assignee, "", "", "normal", ""];
    }

    let staffSheets: FakeSpreadsheet;

    function patch(tasks: unknown[]) {
      return script.KWTM_patchStaffTodos_({ staffTodosSheetId: STAFF_ID }, tasks);
    }

    beforeEach(() => {
      staffSheets = new FakeSpreadsheet(STAFF_ID);
      const env = createEnvironment({
        spreadsheets: { [PRIVATE_ID]: sheets, [STAFF_ID]: staffSheets },
        properties: { KWTM_SYNC_TOKEN: "test-token" },
        active: sheets,
      });
      script = loadCodeGs(env.globals);
    });

    it("updates a staff-owned row in place without creating one", () => {
      staffSheets.add(FakeSheet.from("Todos", [TODO_HEADERS, todoRow("abc", "Old title")]));

      const result = patch([{ id: "staff-abc", source: "staff", title: "New title", category: "Bar", assignee: "Sam" }]);

      const rows = staffSheets.getSheetByName("Todos")!.rows();
      expect(rows).toHaveLength(2);
      expect(rows[1][1]).toBe("New title");
      expect(result.updated).toBe(1);
      expect(result.inserted).toBe(0);
    });

    it("never creates a staff-owned row that is not already in the sheet", () => {
      staffSheets.add(FakeSheet.from("Todos", [TODO_HEADERS]));

      const result = patch([{ id: "staff-missing", source: "staff", title: "Ghost", assignee: "Sam" }]);

      expect(staffSheets.getSheetByName("Todos")!.rows()).toHaveLength(1);
      expect(result.inserted).toBe(0);
    });

    it("mirrors an assigned private task and closes it once it is no longer assignable", () => {
      staffSheets.add(FakeSheet.from("Todos", [TODO_HEADERS]));

      patch([{ id: "t-9", title: "Restock", category: "Bar", assignee: "Sam", priority: "high" }]);

      let rows = staffSheets.getSheetByName("Todos")!.rows();
      expect(rows[1][0]).toBe("kwtm-t-9");
      expect(rows[1][1]).toBe("Restock");
      expect(rows[1][3]).toBe("FALSE");

      // Completing it should close the mirror rather than leave it open for staff.
      patch([{ id: "t-9", title: "Restock", category: "Bar", assignee: "Sam", completed: true }]);

      rows = staffSheets.getSheetByName("Todos")!.rows();
      expect(rows).toHaveLength(2);
      expect(rows[1][3]).toBe("TRUE");
    });

    it("closes a mirror that has dropped out of the payload entirely", () => {
      staffSheets.add(
        FakeSheet.from("Todos", [TODO_HEADERS, todoRow("kwtm-t-1", "Orphaned mirror"), todoRow("real", "Staff row")])
      );

      const result = patch([]);

      const rows = staffSheets.getSheetByName("Todos")!.rows();
      expect(rows[1][3]).toBe("TRUE");
      // A row the staff app owns must not be closed just because we did not mention it.
      expect(rows[2][3]).toBe("FALSE");
      expect(result.closed).toBe(1);
    });

    it("writes many rows without one call per row", () => {
      const seeded = Array.from({ length: 25 }, (_, index) => todoRow(`kwtm-t-${index}`, `Task ${index}`));
      staffSheets.add(FakeSheet.from("Todos", [TODO_HEADERS, ...seeded]));

      const tasks = Array.from({ length: 25 }, (_, index) => ({
        id: `t-${index}`,
        title: `Renamed ${index}`,
        category: "Bar",
        assignee: "Sam",
      }));
      const result = patch(tasks);

      const rows = staffSheets.getSheetByName("Todos")!.rows();
      expect(rows).toHaveLength(26);
      expect(rows[1][1]).toBe("Renamed 0");
      expect(rows[25][1]).toBe("Renamed 24");
      expect(result.updated).toBe(25);
    });
  });

  describe("pushAll", () => {
    it("does every push in one request, and refuses a bad token first", () => {
      seedTasks([taskRow("t-1", "Before", 1000)]);

      const denied = JSON.parse(
        script.KWTM_handleRequest_({ action: "pushAll", token: "wrong", config: {} }).getContent()
      );
      expect(denied.ok).toBe(false);
      expect(sheets.getSheetByName("Tasks")!.rows()[1][1]).toBe("Before");

      const response = JSON.parse(
        script.KWTM_handleRequest_({
          action: "pushAll",
          token: "test-token",
          config: { privateSheetId: PRIVATE_ID },
          snapshot: {
            tasks: [
              { id: "t-1", title: "After", category: "Production", weekId: "2026-08-03", dayOfWeek: 3, updatedAt: 2000 },
            ],
            bills: [],
            dailyEvents: {},
            categories: [],
          },
          tasks: [],
          scheduledTasks: [],
          staff: [],
          weekId: "2026-08-03",
        }).getContent()
      );

      expect(response.ok).toBe(true);
      expect(response.result.operations.skipped).toBe(false);
      expect(sheets.getSheetByName("Tasks")!.rows()[1][1]).toBe("After");
    });

    it("still commits the private write when a staff mirror is unreachable", () => {
      // The staff workbook id points at a spreadsheet the fake environment does not have,
      // which is what an unshared or renamed workbook looks like from here.
      seedTasks([taskRow("t-1", "Before", 1000)]);

      const response = JSON.parse(
        script.KWTM_handleRequest_({
          action: "pushAll",
          token: "test-token",
          config: { privateSheetId: PRIVATE_ID, staffTodosSheetId: "missing-workbook" },
          snapshot: {
            tasks: [
              { id: "t-1", title: "After", category: "Production", weekId: "2026-08-03", dayOfWeek: 3, updatedAt: 2000 },
            ],
            bills: [],
            dailyEvents: {},
            categories: [],
          },
          tasks: [{ id: "t-2", title: "Mirror me", assignee: "Sam" }],
          scheduledTasks: [],
          staff: [],
          weekId: "2026-08-03",
        }).getContent()
      );

      // ok, so the client does not retry the save forever over a mirror it cannot fix...
      expect(response.ok).toBe(true);
      expect(sheets.getSheetByName("Tasks")!.rows()[1][1]).toBe("After");
      // ...but the failure is still reported rather than swallowed.
      expect(response.warnings.join(" ")).toMatch(/staffTodos/);
    });

    it("answers retryable when another execution holds the lock", () => {
      const busy = createEnvironment({
        spreadsheets: { [PRIVATE_ID]: sheets },
        properties: { KWTM_SYNC_TOKEN: "test-token" },
        active: sheets,
        lockAvailable: false,
      });
      const busyScript = loadCodeGs(busy.globals);

      const response = JSON.parse(
        busyScript.KWTM_handleRequest_({ action: "pushAll", token: "test-token", config: {} }).getContent()
      );

      expect(response.ok).toBe(false);
      expect(response.retryable).toBe(true);
    });
  });

  it("reports a script version so the deployed copy can be identified", () => {
    expect(script.KWTM_SCRIPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
