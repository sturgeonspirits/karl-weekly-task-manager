import { describe, expect, it } from "vitest";
import { taskFormIdentity } from "./TaskDialog";
import type { Task } from "../types";

function task(id: string, title: string): Task {
  return {
    id,
    title,
    category: "Production",
    description: "",
    dayOfWeek: 3,
    completed: false,
    weekId: "2026-08-31",
    repeatsWeekly: false,
    repeatPattern: "none",
    deleted: false,
    priority: "medium",
    updatedAt: 1,
    source: "private",
    isGeneralReminder: false,
  } as Task;
}

describe("taskFormIdentity", () => {
  it("is stable when the same task arrives as a brand new object", () => {
    // This is what a background sync does: identical content, fresh object identity. The
    // dialog used to rebuild its form on that, wiping whatever was half-typed.
    expect(taskFormIdentity(task("t-1", "Clean still"), 3, false)).toBe(
      taskFormIdentity(task("t-1", "Clean still"), 3, false)
    );
  });

  it("is stable even when the synced copy of the task has changed", () => {
    // A pull can legitimately bring a newer version of the row being edited. Keeping the
    // identity stable means the typing survives; the save still uses the edited values.
    expect(taskFormIdentity(task("t-1", "Edited elsewhere"), 3, false)).toBe(
      taskFormIdentity(task("t-1", "Clean still"), 3, false)
    );
  });

  it("changes when a different task is opened", () => {
    expect(taskFormIdentity(task("t-1", "A"), 3, false)).not.toBe(taskFormIdentity(task("t-2", "B"), 3, false));
  });

  it("distinguishes a new task from an existing one", () => {
    expect(taskFormIdentity(null, 3, false)).not.toBe(taskFormIdentity(task("t-1", "A"), 3, false));
  });

  it("distinguishes a new reminder from a new scheduled task on the same day", () => {
    expect(taskFormIdentity(null, 3, true)).not.toBe(taskFormIdentity(null, 3, false));
  });

  it("distinguishes new tasks added to different days", () => {
    expect(taskFormIdentity(null, 2, false)).not.toBe(taskFormIdentity(null, 5, false));
  });
});

describe("taskFormIdentity with an explicit date", () => {
  it("distinguishes new tasks added to different dates in the rolling window", () => {
    // Two Mondays are both dayOfWeek 1; only the date tells them apart.
    expect(taskFormIdentity(null, 1, false, "2026-08-31")).not.toBe(taskFormIdentity(null, 1, false, "2026-09-07"));
  });

  it("stays stable for the same date across re-renders", () => {
    expect(taskFormIdentity(null, 1, false, "2026-09-07")).toBe(taskFormIdentity(null, 1, false, "2026-09-07"));
  });
});
