import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bill, Task } from "./types";
import {
  deduplicateTasks,
  ensureRecurringTasksForWeek,
  sanitizeBills,
  sanitizeDailyEvents,
  sanitizeTasks,
  SOFT_DELETE_RETENTION_DAYS,
} from "./utils";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Mash grain",
    description: "",
    dayOfWeek: 1,
    completed: false,
    priority: "medium",
    category: "Production",
    weekId: "2026-08-03",
    repeatsWeekly: false,
    repeatPattern: "none",
    specificDate: "2026-08-03",
    updatedAt: 1_000,
    source: "private",
    isGeneralReminder: false,
    ...overrides,
  };
}

function generatedFor(tasks: Task[], weekId: string): Task | undefined {
  return tasks.find((item) => item.weekId === weekId && item.id.startsWith("auto-"));
}

function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: "bill-1",
    name: "Bottle invoice",
    amount: 100,
    dueDate: "2026-08-10",
    paid: false,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("ensureRecurringTasksForWeek", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 4, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates a weekly task for the target week", () => {
    const result = ensureRecurringTasksForWeek(
      [task({ id: "weekly-clean", repeatsWeekly: true, repeatPattern: "weekly" })],
      "2026-08-10"
    );

    expect(generatedFor(result, "2026-08-10")).toMatchObject({
      id: "auto-weekly-clean-2026-08-10",
      originTaskId: "weekly-clean",
      completed: false,
      deleted: false,
      specificDate: "2026-08-10",
      isGeneralReminder: false,
    });
  });

  it("does not generate a recurring duplicate when that week already exists", () => {
    const existing = task({
      id: "auto-weekly-clean-2026-08-10",
      originTaskId: "weekly-clean",
      weekId: "2026-08-10",
      specificDate: "2026-08-10",
      repeatsWeekly: true,
      repeatPattern: "weekly",
    });

    const result = ensureRecurringTasksForWeek(
      [task({ id: "weekly-clean", repeatsWeekly: true, repeatPattern: "weekly" }), existing],
      "2026-08-10"
    );

    expect(result.filter((item) => item.weekId === "2026-08-10")).toHaveLength(1);
  });

  it("uses the latest matching recurring template", () => {
    const result = ensureRecurringTasksForWeek(
      [
        task({ id: "weekly-clean", title: "Old title", repeatsWeekly: true, repeatPattern: "weekly", updatedAt: 100 }),
        task({
          id: "auto-weekly-clean-2026-08-10",
          originTaskId: "weekly-clean",
          title: "New title",
          weekId: "2026-08-10",
          specificDate: "2026-08-10",
          repeatsWeekly: true,
          repeatPattern: "weekly",
          updatedAt: 200,
        }),
      ],
      "2026-08-17"
    );

    expect(generatedFor(result, "2026-08-17")).toMatchObject({
      title: "New title",
      originTaskId: "weekly-clean",
      specificDate: "2026-08-17",
    });
  });

  it("generates biweekly tasks on even week distances", () => {
    const result = ensureRecurringTasksForWeek(
      [task({ id: "payroll", repeatsWeekly: true, repeatPattern: "biweekly" })],
      "2026-08-17"
    );

    expect(generatedFor(result, "2026-08-17")).toBeTruthy();
  });

  it("skips biweekly tasks on odd week distances", () => {
    const result = ensureRecurringTasksForWeek(
      [task({ id: "payroll", repeatsWeekly: true, repeatPattern: "biweekly" })],
      "2026-08-10"
    );

    expect(generatedFor(result, "2026-08-10")).toBeUndefined();
  });

  it("generates monthly tasks on the same weekday ordinal", () => {
    const result = ensureRecurringTasksForWeek(
      [
        task({
          id: "third-tuesday",
          dayOfWeek: 2,
          weekId: "2026-08-17",
          specificDate: "2026-08-18",
          repeatsWeekly: true,
          repeatPattern: "monthly",
        }),
      ],
      "2026-09-14"
    );

    expect(generatedFor(result, "2026-09-14")).toMatchObject({
      id: "auto-third-tuesday-2026-09-14",
      specificDate: "2026-09-15",
    });
  });

  it("does not generate monthly tasks on a different weekday ordinal", () => {
    const result = ensureRecurringTasksForWeek(
      [
        task({
          id: "third-tuesday",
          dayOfWeek: 2,
          weekId: "2026-08-17",
          specificDate: "2026-08-18",
          repeatsWeekly: true,
          repeatPattern: "monthly",
        }),
      ],
      "2026-09-07"
    );

    expect(generatedFor(result, "2026-09-07")).toBeUndefined();
  });

  it("treats a last weekday of month as last weekday in later months", () => {
    const result = ensureRecurringTasksForWeek(
      [
        task({
          id: "last-tuesday",
          dayOfWeek: 2,
          weekId: "2026-08-24",
          specificDate: "2026-08-25",
          repeatsWeekly: true,
          repeatPattern: "monthly",
        }),
      ],
      "2026-09-28"
    );

    expect(generatedFor(result, "2026-09-28")).toMatchObject({
      id: "auto-last-tuesday-2026-09-28",
      specificDate: "2026-09-29",
    });
  });

  it("does not treat a fourth weekday as last when there is a fifth", () => {
    const result = ensureRecurringTasksForWeek(
      [
        task({
          id: "last-tuesday",
          dayOfWeek: 2,
          weekId: "2026-08-24",
          specificDate: "2026-08-25",
          repeatsWeekly: true,
          repeatPattern: "monthly",
        }),
      ],
      "2026-12-21"
    );

    expect(generatedFor(result, "2026-12-21")).toBeUndefined();
  });

  it("does not backfill monthly tasks before the anchor week", () => {
    const result = ensureRecurringTasksForWeek(
      [
        task({
          id: "last-tuesday",
          dayOfWeek: 2,
          weekId: "2026-08-24",
          specificDate: "2026-08-25",
          repeatsWeekly: true,
          repeatPattern: "monthly",
        }),
      ],
      "2026-07-20"
    );

    expect(generatedFor(result, "2026-07-20")).toBeUndefined();
  });

  it("returns unchanged input for invalid target week IDs", () => {
    const tasks = [task({ id: "weekly-clean", repeatsWeekly: true, repeatPattern: "weekly" })];

    expect(ensureRecurringTasksForWeek(tasks, "not-a-week")).toBe(tasks);
  });
});

describe("deduplicateTasks", () => {
  it("keeps the newest task for the same origin/week/day", () => {
    const result = deduplicateTasks([
      task({ id: "old", originTaskId: "series-1", title: "Old", updatedAt: 100 }),
      task({ id: "new", originTaskId: "series-1", title: "New", updatedAt: 200 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("New");
  });

  it("uses canonical week-suffixed IDs as a tiebreaker", () => {
    const result = deduplicateTasks([
      task({ id: "draft-series", originTaskId: "series-1", title: "Draft", updatedAt: 100 }),
      task({ id: "auto-series-1-2026-08-03", originTaskId: "series-1", title: "Canonical", updatedAt: 100 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Canonical");
  });

  it("sorts tasks by week, day, then title", () => {
    const result = deduplicateTasks([
      task({ id: "c", title: "Zulu", weekId: "2026-08-10", dayOfWeek: 1 }),
      task({ id: "b", title: "Beta", weekId: "2026-08-03", dayOfWeek: 2 }),
      task({ id: "a", title: "Alpha", weekId: "2026-08-03", dayOfWeek: 1 }),
    ]);

    expect(result.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("uses originTaskId as the stable duplicate key", () => {
    const result = deduplicateTasks([
      task({ id: "auto-series-1-2026-08-03", originTaskId: "series-1", title: "Generated", updatedAt: 100 }),
      task({ id: "clone", originTaskId: "series-1", title: "Clone", updatedAt: 300 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("clone");
  });
});

describe("sanitizeTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 4, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops tasks with invalid reserved titles", () => {
    expect(sanitizeTasks([task({ title: "completed" })])).toEqual([]);
  });

  it("infers staff source from staff IDs and prevents general reminders", () => {
    const [result] = sanitizeTasks([
      task({ id: "staff-abc", source: undefined, specificDate: undefined, isGeneralReminder: true }),
    ]);

    expect(result).toMatchObject({
      source: "staff",
      isGeneralReminder: false,
    });
  });

  it("normalizes scheduled private tasks from week/day", () => {
    const [result] = sanitizeTasks([
      task({ dayOfWeek: 9, priority: "urgent" as Task["priority"], weekId: "2026-08-03", specificDate: "2026-08-30" }),
    ]);

    expect(result).toMatchObject({
      dayOfWeek: 7,
      specificDate: "2026-08-09",
      priority: "medium",
      isGeneralReminder: false,
    });
  });

  it("turns imported undated private tasks into general reminders with reminder dates", () => {
    const [result] = sanitizeTasks([
      task({ weekId: "", specificDate: "2026-09-15", dayOfWeek: 2, isGeneralReminder: false }),
    ]);

    expect(result).toMatchObject({
      weekId: "2026-08-03",
      specificDate: undefined,
      reminderDate: "2026-09-15",
      isGeneralReminder: true,
    });
  });

  it("keeps an undated reminder undated when sanitized repeatedly", () => {
    // sanitizeTasks stamps the current week onto an undated reminder so it has some
    // weekId to sort by. On the next pass that weekId must not be read back as a
    // schedule, or the reminder silently becomes a Monday task.
    const reminder = task({
      id: "airbnb",
      title: "Create ad campaign for Airbnb",
      weekId: "",
      specificDate: undefined,
      dayOfWeek: 1,
      isGeneralReminder: true,
      repeatsWeekly: false,
      repeatPattern: "none",
    });

    const [once] = sanitizeTasks([reminder]);
    const [twice] = sanitizeTasks([once]);
    const [thrice] = sanitizeTasks([twice]);

    expect(once).toMatchObject({ isGeneralReminder: true, specificDate: undefined });
    expect(twice).toMatchObject({ isGeneralReminder: true, specificDate: undefined });
    expect(thrice).toMatchObject({ isGeneralReminder: true, specificDate: undefined });
  });

  it("still schedules a reminder once the user gives it a date", () => {
    const [result] = sanitizeTasks([
      task({ weekId: "2026-08-03", dayOfWeek: 3, specificDate: "2026-08-05", isGeneralReminder: false }),
    ]);

    expect(result).toMatchObject({
      isGeneralReminder: false,
      specificDate: "2026-08-05",
      dayOfWeek: 3,
    });
  });

  it("preserves an explicit edited date and recomputes its week and day", () => {
    const [result] = sanitizeTasks([
      task({
        weekId: "2026-08-03",
        dayOfWeek: 1,
        specificDate: "2026-08-12",
        specificDateWasExplicit: true,
      }),
    ]);

    expect(result).toMatchObject({
      weekId: "2026-08-10",
      dayOfWeek: 3,
      specificDate: "2026-08-12",
      specificDateWasExplicit: true,
      isGeneralReminder: false,
    });
  });

  it("normalizes legacy repeatsWeekly tasks to weekly repeat pattern", () => {
    const [result] = sanitizeTasks([task({ repeatsWeekly: true, repeatPattern: "none", isGeneralReminder: true })]);

    expect(result).toMatchObject({
      repeatsWeekly: true,
      repeatPattern: "weekly",
      isGeneralReminder: false,
    });
  });

  it("retains historical completed one-off tasks", () => {
    const [result] = sanitizeTasks([
      task({
        id: "old-completed",
        completed: true,
        weekId: "2026-07-20",
        specificDate: "2026-07-20",
        updatedAt: 100,
      }),
    ]);

    expect(result.id).toBe("old-completed");
  });

  it("prunes stale soft-deleted tasks after the retention window", () => {
    const staleUpdatedAt = Date.now() - (SOFT_DELETE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000;

    expect(sanitizeTasks([task({ deleted: true, updatedAt: staleUpdatedAt })])).toEqual([]);
  });

  it("retains recent soft-deleted tasks as tombstones", () => {
    const recentUpdatedAt = Date.now() - (SOFT_DELETE_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1_000;
    const [result] = sanitizeTasks([task({ deleted: true, updatedAt: recentUpdatedAt })]);

    expect(result.deleted).toBe(true);
  });
});

describe("sanitizeDailyEvents", () => {
  it("preserves past daily notes and normalizes legacy weekly keys", () => {
    expect(sanitizeDailyEvents({ "2026-07-27-2": "Trivia" })).toEqual({
      "2026-07-28": "Trivia",
    });
  });

  it("preserves blank valid keys as deletion tombstones", () => {
    expect(sanitizeDailyEvents({ "2026-08-04": "" })).toEqual({
      "2026-08-04": "",
    });
  });

  it("deduplicates multi-source notes for the same date", () => {
    expect(
      sanitizeDailyEvents({
        "2026-08-03-2": "Trivia",
        "2026-08-04": "Trivia",
      })
    ).toEqual({
      "2026-08-04": "Trivia",
    });
  });
});

describe("sanitizeBills", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 4, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes stale soft-deleted bills after the retention window", () => {
    const staleUpdatedAt = Date.now() - (SOFT_DELETE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000;

    expect(sanitizeBills([bill({ deleted: true, updatedAt: staleUpdatedAt })])).toEqual([]);
  });

  it("retains recent soft-deleted bills as tombstones", () => {
    const recentUpdatedAt = Date.now() - (SOFT_DELETE_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1_000;
    const [result] = sanitizeBills([bill({ deleted: true, updatedAt: recentUpdatedAt })]);

    expect(result.deleted).toBe(true);
  });
});
