import type { Bill, CategoryOption, DailyEvents, StaffMember, Task } from "../types";

const CURRENT_WEEK_ID = "2026-08-03";

export const seedCategories: CategoryOption[] = [
  { id: "admin", name: "admin", color: "slate" },
  { id: "maintenance", name: "maintenance", color: "sky" },
  { id: "sales", name: "sales", color: "violet" },
  { id: "hospitality", name: "hospitality", color: "emerald" },
  { id: "compliance", name: "compliance", color: "rose" },
  { id: "production-sales", name: "Production/Sales", color: "amber" },
  { id: "bar-prep", name: "Bar Prep", color: "emerald" },
  { id: "cleaning", name: "Cleaning", color: "sky" },
  { id: "shopping", name: "Shopping", color: "violet" },
];

export const seedStaff: StaffMember[] = [
  { id: "karl@sturgeonspirits.com", name: "Karl Loewenstein", role: "Manager", email: "karl@sturgeonspirits.com", color: "violet" },
  { id: "todd.mclean@sturgeonspirits.com", name: "Todd McLean", role: "Manager", email: "todd.mclean@sturgeonspirits.com", color: "violet" },
  { id: "sophia@sturgeonspirits.com", name: "Sophia Norenberg", role: "Staff", email: "sophia@sturgeonspirits.com", color: "sky" },
  { id: "tanya@sturgeonspirits.com", name: "Tanya Schmidt", role: "Manager", email: "tanya@sturgeonspirits.com", color: "violet" },
  { id: "erika@sturgeonspirits.com", name: "Erika Joyce", role: "Staff", email: "erika@sturgeonspirits.com", color: "sky" },
  { id: "natefaust18@gmail.com", name: "Nate Faust", role: "Staff", email: "natefaust18@gmail.com", color: "sky" },
  { id: "abbenner81@yahoo.com", name: "Amanda Benner", role: "Staff", email: "abbenner81@yahoo.com", color: "sky" },
];

export function createSeedTasks(weekId = CURRENT_WEEK_ID): Task[] {
  return [
    task("auto-wmxneg9-2026-08-03", "Clean Distillery", "hospitality", 1, "low"),
    task("auto-ogd2pma-2026-08-03", "Empty Cash Drawer", "hospitality", 1, "high"),
    task("auto-kjqx24f-2026-08-03", "Laundry", "maintenance", 1, "low"),
    task("auto-tark0jj-2026-08-03", "Update website", "sales", 1, "low"),
    task("auto-xi5inm8-2026-08-03", "Social media posts", "sales", 1, "low"),
    task("auto-0iuz1a8-2026-08-03", "Tasting Room Open 4- 8 PM", "hospitality", 2, "medium"),
    task("auto-t0lcxqc-2026-08-03", "Pay Staff", "admin", 2, "low"),
    task("auto-7qtxqzt-2026-08-03", "Tasting Room Open 4-8", "hospitality", 3, "medium"),
    task("auto-t0g0rsb-2026-08-03", "Water Plants", "maintenance", 3, "low"),
    task("auto-j5r2wt7-2026-08-03", "Tasting Room Open 4 - 8 PM", "hospitality", 4, "low"),
    task("auto-xmtqufo-2026-08-03", "Tasting Room Open 1 - 9 PM", "hospitality", 5, "low"),
    task("staff-todo_1785186913713_2930", "Get hand soap for bathrooms", "Cleaning", 5, "medium", {
      assignee: "todd.mclean@sturgeonspirits.com",
      description: "Staff/general todo. Added by Karl Loewenstein.",
      specificDate: "2026-08-07",
      source: "staff",
      isGeneralReminder: false,
    }),
    task("auto-yi8eq1e-2026-08-03", "Tasting Room Open 1 - 9 PM", "hospitality", 6, "low"),
    task("auto-4qkartx-2026-08-03", "Tasting Room Open 12-6 PM", "hospitality", 7, "low"),
    task("staff-todo_1784651550639_4759", "bottle rhubarb gin", "Production/Sales", 1, "high", {
      description: "Staff/general todo. Added by Karl Loewenstein. Original todo date: 2026-07-23.",
      specificDate: "2026-08-03",
      source: "staff",
      isGeneralReminder: false,
    }),
    task("staff-todo_1785778630720_7813", "can seltzers", "Production/Sales", 1, "medium", {
      assignee: "Karl Loewenstein",
      description: "Staff/general todo. Added by Karl Loewenstein.",
      source: "staff",
      isGeneralReminder: false,
    }),
    task("staff-todo_1785778648092_7251", "bottle cherry vodka", "Production/Sales", 1, "medium", {
      assignee: "Karl Loewenstein",
      description: "Staff/general todo. Added by Karl Loewenstein.",
      source: "staff",
      isGeneralReminder: false,
    }),
    task("staff-todo_1785778657961_7443", "make cranberry vodka", "Production/Sales", 1, "medium", {
      assignee: "Karl Loewenstein",
      description: "Staff/general todo. Added by Karl Loewenstein.",
      source: "staff",
      isGeneralReminder: false,
    }),
  ].map((item) => ({
    ...item,
    weekId,
    specificDate:
      item.source === "staff" && !item.specificDate
        ? undefined
        : item.specificDate || dateForWeekDay(weekId, item.dayOfWeek),
    isGeneralReminder: item.source === "staff" ? false : Boolean(item.isGeneralReminder && !item.specificDate),
  }));
}

export function createSeedBills(): Bill[] {
  return [
    {
      id: "bill-ozfap0z",
      name: "New A/C",
      amount: 3500,
      dueDate: "2026-08-10",
      paid: false,
      category: "Equipment & Maintenance",
      recurring: false,
      updatedAt: 1785778951205,
    },
    {
      id: "bill-xoeslgh",
      name: "Berlin Packaging -- Bottles",
      amount: 4750,
      dueDate: "2026-08-10",
      paid: false,
      category: "Ingredients & Supplies",
      recurring: false,
      updatedAt: 1785778916197,
    },
  ];
}

export function createSeedDailyEvents(weekId = CURRENT_WEEK_ID): DailyEvents {
  return {
    [dateForWeekDay(weekId, 3)]: "Trivia",
    [dateForWeekDay(weekId, 4)]: "Cribbage",
    [dateForWeekDay(weekId, 5)]: "Pizza with Amanda & Erin Krebs",
    [dateForWeekDay(weekId, 6)]: "Music -- Bob Campbell",
    [dateForWeekDay(weekId, 7)]: "Closed for an Engagement Party",
  };
}

function dateForWeekDay(weekId: string, dayOfWeek: number): string {
  const [year, month, day] = weekId.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + Math.max(1, Math.min(7, dayOfWeek)) - 1);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function task(
  id: string,
  title: string,
  category: string,
  dayOfWeek: number,
  priority: Task["priority"],
  overrides: Partial<Task> = {}
): Task {
  return {
    id,
    title,
    category,
    dayOfWeek,
    completed: false,
    priority,
    weekId: CURRENT_WEEK_ID,
    repeatsWeekly: false,
    repeatPattern: "none",
    updatedAt: 1785777602775,
    source: "private",
    isGeneralReminder: false,
    ...overrides,
  };
}
