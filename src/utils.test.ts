import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bill, Task } from "./types";
import {
  applyBillPayment,
  billAmountPaid,
  billRemaining,
  deduplicateTasks,
  ensureRecurringTasksForWeek,
  frequencyForRecurringChoice,
  isPartiallyPaid,
  roundCurrency,
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

  it("does not recreate the original date after a generated monthly occurrence is moved", () => {
    const result = ensureRecurringTasksForWeek(
      [
        task({
          id: "monthly-state-reporting",
          title: "monthly state reporting due",
          dayOfWeek: 2,
          weekId: "2026-07-13",
          specificDate: "2026-07-14",
          repeatsWeekly: true,
          repeatPattern: "monthly",
          updatedAt: 100,
        }),
        task({
          id: "auto-monthly-state-reporting-2026-08-10",
          originTaskId: "monthly-state-reporting",
          title: "monthly state reporting due",
          dayOfWeek: 3,
          weekId: "2026-08-10",
          specificDate: "2026-08-12",
          repeatsWeekly: true,
          repeatPattern: "monthly",
          specificDateWasExplicit: true,
          updatedAt: 200,
        }),
      ],
      "2026-08-10"
    );

    expect(result.filter((item) => item.title === "monthly state reporting due" && item.weekId === "2026-08-10")).toHaveLength(1);
    expect(result.find((item) => item.id === "auto-monthly-state-reporting-2026-08-10")).toMatchObject({
      specificDate: "2026-08-12",
      dayOfWeek: 3,
    });
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

  it("lets an edited bill change amount and due date", () => {
    const [result] = sanitizeBills([bill({ amount: 400, dueDate: "2026-09-01" })]);

    expect(result).toMatchObject({ amount: 400, dueDate: "2026-09-01" });
  });
});

// v1.1 -- 2026-08-21 -- Partial payments.
describe("partial bill payments", () => {
  it("reports nothing paid on a fresh bill", () => {
    expect(billAmountPaid(bill())).toBe(0);
    expect(billRemaining(bill())).toBe(100);
    expect(isPartiallyPaid(bill())).toBe(false);
  });

  it("treats a legacy paid bill with no amountPaid as paid in full", () => {
    const legacy = bill({ paid: true });

    expect(billAmountPaid(legacy)).toBe(100);
    expect(billRemaining(legacy)).toBe(0);
    expect(isPartiallyPaid(legacy)).toBe(false);
  });

  it("records a partial payment without settling the bill", () => {
    const result = applyBillPayment(bill(), 40);

    expect(result.amountPaid).toBe(40);
    expect(result.paid).toBe(false);
    expect(billRemaining(result)).toBe(60);
    expect(isPartiallyPaid(result)).toBe(true);
  });

  it("accumulates payments and settles the bill once the balance clears", () => {
    const afterFirst = applyBillPayment(bill(), 40);
    const afterSecond = applyBillPayment(afterFirst, 60);

    expect(afterSecond.amountPaid).toBe(100);
    expect(afterSecond.paid).toBe(true);
    expect(billRemaining(afterSecond)).toBe(0);
  });

  it("never lets payments exceed the bill amount", () => {
    const result = applyBillPayment(bill(), 250);

    expect(result.amountPaid).toBe(100);
    expect(result.paid).toBe(true);
  });

  it("ignores a zero, negative, or non-numeric payment", () => {
    const original = bill();

    expect(applyBillPayment(original, 0)).toBe(original);
    expect(applyBillPayment(original, -25)).toBe(original);
    expect(applyBillPayment(original, Number.NaN)).toBe(original);
  });

  it("does not drift on repeated fractional payments", () => {
    // Three payments of 0.10 against a 0.30 bill must land exactly on paid, not on
    // 0.30000000000000004, which would leave a phantom balance forever.
    const cents = bill({ amount: 0.3 });
    const result = [0.1, 0.1, 0.1].reduce((current, payment) => applyBillPayment(current, payment), cents);

    expect(result.amountPaid).toBe(0.3);
    expect(result.paid).toBe(true);
    expect(billRemaining(result)).toBe(0);
  });

  it("rounds stray floating point values to whole cents", () => {
    expect(roundCurrency(0.1 + 0.2)).toBe(0.3);
    expect(roundCurrency(Number.NaN)).toBe(0);
  });

  it("clamps an over-large amountPaid through sanitizeBills", () => {
    const [result] = sanitizeBills([bill({ amountPaid: 500 })]);

    expect(result.amountPaid).toBe(100);
    expect(result.paid).toBe(true);
  });

  it("keeps paid and amountPaid consistent through sanitizeBills", () => {
    const [settled] = sanitizeBills([bill({ paid: true })]);
    const [covered] = sanitizeBills([bill({ amountPaid: 100 })]);
    const [partial] = sanitizeBills([bill({ amountPaid: 25 })]);

    expect(settled.amountPaid).toBe(100);
    expect(covered.paid).toBe(true);
    expect(partial.paid).toBe(false);
    expect(partial.amountPaid).toBe(25);
  });

  it("reopens a balance when an edit raises the bill amount", () => {
    // Paying 100 of a 100 bill settles it; correcting the invoice to 150 must leave 50
    // owed rather than keeping the bill closed.
    const settled = applyBillPayment(bill(), 100);
    const [corrected] = sanitizeBills([{ ...settled, amount: 150, paid: false }]);

    expect(corrected.amountPaid).toBe(100);
    expect(corrected.paid).toBe(false);
    expect(billRemaining(corrected)).toBe(50);
  });
});

describe("frequencyForRecurringChoice", () => {
  it("clears the frequency when recurring is switched off", () => {
    expect(frequencyForRecurringChoice(false, "monthly")).toBe("one-time");
  });

  it("keeps a specific cadence when recurring stays on", () => {
    expect(frequencyForRecurringChoice(true, "quarterly")).toBe("quarterly");
  });

  it("leaves the frequency unset when switching recurring on from one-time", () => {
    expect(frequencyForRecurringChoice(true, "one-time")).toBeUndefined();
    expect(frequencyForRecurringChoice(true, undefined)).toBeUndefined();
  });

  it("makes unticking recurring actually stick through sanitizeBills", () => {
    // Without clearing the frequency, sanitizeBills reads "monthly" and flips recurring
    // back on, so the checkbox would appear to do nothing.
    const edited = bill({
      recurring: false,
      frequency: frequencyForRecurringChoice(false, "monthly"),
    });

    expect(sanitizeBills([edited])[0].recurring).toBe(false);
  });

  it("keeps a recurring bill recurring through sanitizeBills", () => {
    const edited = bill({ recurring: true, frequency: frequencyForRecurringChoice(true, "monthly") });

    expect(sanitizeBills([edited])[0].recurring).toBe(true);
  });
});
