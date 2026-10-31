import { describe, expect, it } from "vitest";
import type { Task } from "../types";
import { compareTasksByImportance, isRankable, rankTasks, taskScore } from "./ranking";

// Saturday 10/31/2026; this week's Monday is 10/26.
const TODAY = "2026-10-31";
const stamp = (dateKey: string) => new Date(`${dateKey}T12:00:00`).getTime();

function task(over: Partial<Task> & { id: string; title: string }): Task {
  return {
    dayOfWeek: 1,
    completed: false,
    priority: "medium",
    category: "sales",
    weekId: "2026-10-26",
    repeatPattern: "none",
    source: "private",
    ...over,
  };
}

const dated = (id: string, title: string, date: string, priority: Task["priority"] = "medium", over: Partial<Task> = {}) =>
  task({ id, title, specificDate: date, priority, ...over });
const reminder = (title: string, createdOn: string, priority: Task["priority"] = "medium", over: Partial<Task> = {}) =>
  task({ id: `task-${stamp(createdOn)}-abc`, title, isGeneralReminder: true, weekId: "", priority, ...over });

describe("which tasks are ranked", () => {
  it("leaves out unticked tasks from earlier weeks, which the app does not show", () => {
    expect(isRankable(dated("auto-nd74rmw-2026-10-12", "Monthly state reporting due", "2026-10-15", "high"), TODAY)).toBe(false);
    expect(isRankable(dated("task-1792801185485-zmd0zs", "Buy juice", "2026-10-24", "high"), TODAY)).toBe(false);
  });

  it("keeps this week's tasks (even earlier days), the next 7 days, and undated reminders", () => {
    expect(isRankable(dated("a", "Empty Cash Drawer", "2026-10-26", "high"), TODAY)).toBe(true);
    expect(isRankable(dated("b", "Core bars", "2026-11-03"), TODAY)).toBe(true);
    expect(isRankable(dated("c", "Gift boxes", "2026-11-16"), TODAY)).toBe(false);
    expect(isRankable(reminder("Find new cleaner for airbnb", "2026-10-12", "high"), TODAY)).toBe(true);
  });

  it("leaves out done, deleted, staff and schedule-marker tasks", () => {
    expect(isRankable(dated("d", "Done", "2026-10-30", "high", { completed: true }), TODAY)).toBe(false);
    expect(isRankable(dated("e", "Deleted", "2026-10-30", "high", { deleted: true }), TODAY)).toBe(false);
    expect(isRankable(dated("staff-1", "Staff todo", "2026-10-30", "high", { source: "staff" }), TODAY)).toBe(false);
    expect(isRankable(dated("f", "Tasting Room Open 4- 8 PM", "2026-11-01"), TODAY)).toBe(false);
    expect(isRankable(dated("g", "Bloody Mary Bar 10-12:30 PM", "2026-11-01"), TODAY)).toBe(false);
  });
});

describe("score (same numbers as Ranking.gs)", () => {
  it("adds points for being overdue or close", () => {
    expect(taskScore(dated("a", "x", "2026-10-28", "high"), TODAY)).toBe(60 + 10 + 4 * 3);
    expect(taskScore(dated("a", "x", "2026-10-31", "medium"), TODAY)).toBe(35 + 30);
    expect(taskScore(dated("a", "x", "2026-11-01", "low"), TODAY)).toBe(15 + 18);
    expect(taskScore(dated("a", "x", "2026-11-03", "high"), TODAY)).toBe(60 + 8);
    expect(taskScore(dated("a", "x", "2026-11-05", "high"), TODAY)).toBe(60);
  });

  it("an undated task gains 3 a day after 2 days, up to 30", () => {
    expect(taskScore(reminder("x", "2026-10-30", "high"), TODAY)).toBe(60);
    expect(taskScore(reminder("x", "2026-10-26", "high"), TODAY)).toBe(60 + 9);
    expect(taskScore(reminder("x", "2026-10-12", "high"), TODAY)).toBe(60 + 30);
  });

  it("puts a long-waiting Medium above a brand-new High, and done tasks last", () => {
    const oldMedium = reminder("Old medium", "2026-10-15", "medium");
    const newHigh = reminder("New high", "2026-10-31", "high");
    const done = reminder("Done", "2026-10-01", "high", { completed: true });
    expect([newHigh, done, oldMedium].sort((a, b) => compareTasksByImportance(a, b, TODAY)).map((t) => t.title)).toEqual([
      "Old medium",
      "New high",
      "Done",
    ]);
  });

  it("breaks ties by who has waited longest, not by title", () => {
    const a = dated("task-1792000000000-a", "Alpha", "2026-10-31", "high");
    const z = dated("task-1791000000000-z", "Zulu", "2026-10-31", "high");
    expect([a, z].sort((x, y) => compareTasksByImportance(x, y, TODAY)).map((t) => t.title)).toEqual(["Zulu", "Alpha"]);
  });
});

describe("the Do first list", () => {
  it("ranks in order, counts a repeating task once, and sets stale reminders apart", () => {
    const tasks: Task[] = [
      dated("auto-ogd2pma-2026-10-26", "Empty Cash Drawer", "2026-10-26", "high", { repeatPattern: "weekly", originTaskId: "ogd2pma" }),
      dated("auto-ogd2pma-2026-11-02", "Empty Cash Drawer", "2026-11-02", "high", { repeatPattern: "weekly", originTaskId: "ogd2pma" }),
      dated("fub-cinders-next", "Cinders", "2026-10-28", "high"),
      reminder("Find new cleaner for airbnb", "2026-10-12", "high"),
      reminder("Order sweatshirts", "2026-09-01", "medium"),
      dated("auto-nd74rmw-2026-10-12", "Monthly state reporting due", "2026-10-15", "high"),
      dated("fub-gabes", "Gabe's", "2026-10-30", "medium"),
    ];
    const { ranked, stale, total } = rankTasks(tasks, TODAY);
    expect(ranked.map((r) => r.task.title)).toEqual(["Find new cleaner for airbnb", "Empty Cash Drawer", "Cinders", "Gabe's"]);
    expect(ranked[1].task.specificDate).toBe("2026-10-26");
    expect(ranked[1].why).toBe("5 days overdue");
    expect(stale).toBe(1);
    expect(total).toBe(4);
  });

  it("shows at most 10", () => {
    const many = Array.from({ length: 14 }, (_, i) => dated(`t${i}`, `Task ${i}`, "2026-11-01"));
    expect(rankTasks(many, TODAY).ranked).toHaveLength(10);
  });
});
