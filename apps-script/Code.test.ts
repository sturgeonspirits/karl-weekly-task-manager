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

  describe("backups", () => {
    it("copies the tab into a dated hidden backup before writing", () => {
      seedTasks([taskRow("t-1", "Original", 1000)]);

      upsertTasks([taskRow("t-1", "Changed", 2000)]);

      const backup = sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-04");
      expect(backup).not.toBeNull();
      expect(backup!.hidden).toBe(true);
      expect(backup!.rows()[1][1]).toBe("Original");
    });

    it("does not overwrite the day's backup on a later save", () => {
      seedTasks([taskRow("t-1", "Morning state", 1000)]);

      upsertTasks([taskRow("t-1", "Midday", 2000)]);
      upsertTasks([taskRow("t-1", "Evening", 3000)]);

      const backup = sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-04")!;
      expect(backup.rows()[1][1]).toBe("Morning state");
      expect(sheets.getSheetByName("Tasks")!.rows()[1][1]).toBe("Evening");
    });

    it("keeps a separate backup per day", () => {
      seedTasks([taskRow("t-1", "Day one", 1000)]);
      upsertTasks([taskRow("t-1", "Day one edit", 2000)]);

      vi.setSystemTime(new Date("2026-08-05T12:00:00Z"));
      upsertTasks([taskRow("t-1", "Day two edit", 3000)]);

      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-04")!.rows()[1][1]).toBe("Day one");
      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-05")!.rows()[1][1]).toBe("Day one edit");
    });

    it("deletes backups older than the retention window and keeps recent ones", () => {
      sheets.add(FakeSheet.from("_KWTM Backup - Tasks - 2026-07-01", [["stale"]]));
      sheets.add(FakeSheet.from("_KWTM Backup - Tasks - 2026-08-02", [["recent"]]));
      seedTasks([taskRow("t-1", "Now", 1000)]);

      upsertTasks([taskRow("t-1", "Now edited", 2000)]);

      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-07-01")).toBeNull();
      expect(sheets.getSheetByName("_KWTM Backup - Tasks - 2026-08-02")).not.toBeNull();
    });

    it("does not touch backups belonging to a different tab", () => {
      sheets.add(FakeSheet.from("_KWTM Backup - Bills - 2026-07-01", [["other tab"]]));
      seedTasks([taskRow("t-1", "Now", 1000)]);

      upsertTasks([taskRow("t-1", "Now edited", 2000)]);

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

  it("reports a script version so the deployed copy can be identified", () => {
    expect(script.KWTM_SCRIPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
