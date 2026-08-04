import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTasks } from "./lib/sheetsService";
import { TASK_COLUMNS } from "./lib/sheetSchema";
import { sanitizeTasks } from "./utils";

/**
 * End-to-end checks across the sheet -> parse -> sanitize path.
 *
 * The unit tests cover each stage in isolation, which is how an undated reminder was able
 * to turn itself into a Monday task: every stage looked right on its own, but sanitizeTasks
 * was not idempotent, and App.tsx runs it on every state change.
 */

/** What Apps Script writes for a general reminder: blank dayOfWeek and blank weekId. */
const reminderRow = [
  "airbnb",
  "Create ad campaign for Airbnb",
  "Marketing",
  "",
  "", // dayOfWeek
  "FALSE",
  "", // weekId
  "FALSE",
  "none",
  "",
  "FALSE",
  "",
  "",
  "medium",
  "",
  "1700",
];

/** A normal scheduled task: Wednesday of the week beginning 2026-08-03. */
const scheduledRow = [
  "mash",
  "Mash grain",
  "Production",
  "",
  "3",
  "FALSE",
  "2026-08-03",
  "FALSE",
  "none",
  "",
  "FALSE",
  "",
  "",
  "high",
  "",
  "1700",
];

describe("sheet round-trip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 4, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps an undated reminder undated through parse and repeated sanitize", () => {
    let tasks = parseTasks([[...TASK_COLUMNS], reminderRow]);
    expect(tasks[0]).toMatchObject({ isGeneralReminder: true, specificDate: undefined });

    for (let pass = 1; pass <= 5; pass += 1) {
      tasks = sanitizeTasks(tasks);
      expect(tasks[0], `sanitize pass ${pass}`).toMatchObject({
        isGeneralReminder: true,
        specificDate: undefined,
      });
    }
  });

  it("keeps a scheduled task on its own day through repeated sanitize", () => {
    let tasks = parseTasks([[...TASK_COLUMNS], scheduledRow]);
    expect(tasks[0]).toMatchObject({ isGeneralReminder: false, specificDate: "2026-08-05" });

    for (let pass = 1; pass <= 5; pass += 1) {
      tasks = sanitizeTasks(tasks);
      expect(tasks[0], `sanitize pass ${pass}`).toMatchObject({
        isGeneralReminder: false,
        specificDate: "2026-08-05",
        dayOfWeek: 3,
      });
    }
  });

  it("does not let a reminder and a scheduled task collapse into each other", () => {
    let tasks = parseTasks([[...TASK_COLUMNS], reminderRow, scheduledRow]);
    for (let pass = 1; pass <= 3; pass += 1) tasks = sanitizeTasks(tasks);

    expect(tasks).toHaveLength(2);
    expect(tasks.filter((entry) => entry.isGeneralReminder)).toHaveLength(1);
    expect(tasks.filter((entry) => Boolean(entry.specificDate))).toHaveLength(1);
  });
});
