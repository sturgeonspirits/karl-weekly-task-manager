import { describe, expect, it } from "vitest";
import { mergeDailyEventSets, parseBills, parseTasks } from "./sheetsService";
import { BILL_COLUMNS, LEGACY_BILL_COLUMNS, TASK_COLUMNS } from "./sheetSchema";

describe("mergeDailyEventSets", () => {
  it("lets a higher-priority tombstone hide lower-priority notes", () => {
    expect(mergeDailyEventSets({ "2026-08-04": "" }, { "2026-08-04": "Trivia" })).toEqual({
      "2026-08-04": "",
    });
  });

  it("does not let a lower-priority tombstone hide a higher-priority note", () => {
    expect(mergeDailyEventSets({ "2026-08-04": "Trivia" }, { "2026-08-04": "" })).toEqual({
      "2026-08-04": "Trivia",
    });
  });

  it("combines distinct notes from multiple non-tombstone sources", () => {
    expect(mergeDailyEventSets({ "2026-08-04": "Trivia" }, { "2026-08-04": "Cribbage" })).toEqual({
      "2026-08-04": "Trivia\nCribbage",
    });
  });
});

describe("parseTasks", () => {
  const canonicalRow = [
    "t-1",
    "Mash grain",
    "Production",
    "Fill the tun",
    "3",
    "FALSE",
    "2026-08-03",
    "FALSE",
    "none",
    "",
    "FALSE",
    "",
    "Karl Loewenstein",
    "high",
    "06:00-14:00",
    "1700",
  ];

  const expected = {
    id: "t-1",
    title: "Mash grain",
    category: "Production",
    description: "Fill the tun",
    dayOfWeek: 3,
    completed: false,
    weekId: "2026-08-03",
    specificDate: "2026-08-05",
    assignee: "Karl Loewenstein",
    priority: "high",
    shiftHours: "06:00-14:00",
    updatedAt: 1700,
    source: "private",
    deleted: false,
    isGeneralReminder: false,
  };

  it("parses a row laid out in the canonical column order", () => {
    expect(parseTasks([[...TASK_COLUMNS], canonicalRow])[0]).toMatchObject(expected);
  });

  it("parses the same row when the sheet's columns are reordered", () => {
    const order = ["updatedAt", "title", "weekId", "dayOfWeek", "id", "priority", "assignee", "shiftHours"];
    const positionInCanonical = (name: string) => TASK_COLUMNS.indexOf(name as (typeof TASK_COLUMNS)[number]);
    const shuffled = order.map((name) => canonicalRow[positionInCanonical(name)]);

    expect(parseTasks([order, shuffled])[0]).toMatchObject({
      id: "t-1",
      title: "Mash grain",
      dayOfWeek: 3,
      weekId: "2026-08-03",
      specificDate: "2026-08-05",
      assignee: "Karl Loewenstein",
      priority: "high",
      shiftHours: "06:00-14:00",
      updatedAt: 1700,
    });
  });

  it("falls back to canonical positions when the header row is unrecognised", () => {
    expect(parseTasks([["", "", ""], canonicalRow])[0]).toMatchObject(expected);
  });

  it("skips placeholder rows seeded by older versions of the sheet", () => {
    const seeded = [...canonicalRow];
    seeded[0] = "auto-def-1";

    expect(parseTasks([[...TASK_COLUMNS], seeded])).toEqual([]);
  });

  it("flags legacy numeric week cells as needing sheet repair", () => {
    const legacy = [...canonicalRow];
    legacy[6] = "3";

    expect(parseTasks([[...TASK_COLUMNS], canonicalRow, legacy])[1]).toMatchObject({
      needsSheetRepair: true,
      weekId: "2026-08-03",
    });
  });
});

describe("parseBills", () => {
  // v1.1 -- 2026-08-21 -- Partial payments.
  it("reads a part-paid bill as unpaid with a balance", () => {
    const row = [
      "b-partial", "Bottle invoice", "Glass Co", "1000", "2026-08-10", "one-time",
      "Supplies", "partial", "FALSE", "Checking", "", "1700", "FALSE", "400",
    ];

    expect(parseBills([[...BILL_COLUMNS], row])[0]).toMatchObject({
      id: "b-partial",
      amount: 1000,
      amountPaid: 400,
      paid: false,
    });
  });

  it("settles a bill whose recorded payments cover it", () => {
    const row = [
      "b-covered", "Bottle invoice", "", "250", "2026-08-10", "one-time",
      "", "partial", "FALSE", "", "", "1700", "FALSE", "250",
    ];

    expect(parseBills([[...BILL_COLUMNS], row])[0]).toMatchObject({ paid: true, amountPaid: 250 });
  });

  it("treats a sheet with no amountPaid column as nothing paid", () => {
    const row = [
      "b-legacy", "Bottle invoice", "", "250", "2026-08-10", "one-time",
      "", "upcoming", "FALSE", "", "", "1700", "FALSE",
    ];

    expect(parseBills([[...BILL_COLUMNS], row])[0]).toMatchObject({ paid: false, amountPaid: 0 });
  });

  it("parses the current Bills layout", () => {
    const row = [
      "b-1",
      "Bottle invoice",
      "Glass Co",
      "$1,250.50",
      "2026-08-10",
      "monthly",
      "Supplies",
      "upcoming",
      "FALSE",
      "Checking",
      "Rush order",
      "1700",
      "FALSE",
    ];

    expect(parseBills([[...BILL_COLUMNS], row])[0]).toMatchObject({
      id: "b-1",
      name: "Bottle invoice",
      payee: "Glass Co",
      amount: 1250.5,
      dueDate: "2026-08-10",
      paid: false,
      category: "Supplies",
      recurring: true,
      frequency: "monthly",
      autoPay: false,
      paymentAccount: "Checking",
      notes: "Rush order",
      updatedAt: 1700,
      deleted: false,
    });
  });

  it("parses the legacy Bills layout that predates the payee column", () => {
    const row = ["b-2", "Rent", "3000", "2026-08-15", "paid", "Facilities", "TRUE", "1800"];

    expect(parseBills([[...LEGACY_BILL_COLUMNS], row])[0]).toMatchObject({
      id: "b-2",
      name: "Rent",
      amount: 3000,
      dueDate: "2026-08-15",
      paid: true,
      category: "Facilities",
      recurring: true,
      updatedAt: 1800,
      deleted: false,
    });
  });

  it("does not guess a payee position when the legacy layout has no payee column", () => {
    const row = ["b-2", "Rent", "3000", "2026-08-15", "paid", "Facilities", "TRUE", "1800"];

    expect(parseBills([[...LEGACY_BILL_COLUMNS], row])[0].payee).toBeUndefined();
  });

  it("parses a reordered Bills sheet", () => {
    const order = ["dueDate", "title", "amount", "id", "status"];
    const row = ["2026-08-10", "Bottle invoice", "250", "b-1", "paid"];

    expect(parseBills([order, row])[0]).toMatchObject({
      id: "b-1",
      name: "Bottle invoice",
      amount: 250,
      dueDate: "2026-08-10",
      paid: true,
    });
  });

  it("drops rows without a usable due date", () => {
    const row = ["b-3", "Mystery charge", "", "50", "not-a-date", "", "", "upcoming", "", "", "", "1700", "FALSE"];

    expect(parseBills([[...BILL_COLUMNS], row])).toEqual([]);
  });
});
