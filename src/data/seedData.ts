import type { Bill, CategoryOption, DailyEvents, StaffMember, Task } from "../types";
import { addDays, dailyEventKey, dateKeyForWeekDay, makeId, toLocalDateKey } from "../utils";

export const seedCategories: CategoryOption[] = [
  { id: "production", name: "Production", color: "emerald" },
  { id: "distilling", name: "Distilling", color: "amber" },
  { id: "maintenance", name: "Maintenance", color: "rose" },
  { id: "front-of-house", name: "Front of House", color: "sky" },
  { id: "compliance", name: "Compliance", color: "violet" },
  { id: "admin", name: "Admin", color: "slate" },
];

export const seedStaff: StaffMember[] = [
  { id: "staff-ella", name: "Ella", role: "Production Lead", email: "ella@sturgeonspirits.com", color: "emerald" },
  { id: "staff-marco", name: "Marco", role: "Distiller", email: "marco@sturgeonspirits.com", color: "amber" },
  { id: "staff-jules", name: "Jules", role: "Tasting Room", email: "jules@sturgeonspirits.com", color: "sky" },
  { id: "staff-nora", name: "Nora", role: "Operations", email: "nora@sturgeonspirits.com", color: "violet" },
];

export function createSeedTasks(weekId: string): Task[] {
  return [
    {
      id: makeId("task"),
      title: "Mash prep for rye run",
      description: "Verify grain bill, water temp, and yeast inventory before milling.",
      dayOfWeek: 1,
      completed: false,
      priority: "high",
      category: "Production",
      weekId,
      repeatsWeekly: true,
      repeatPattern: "weekly",
      assignee: "Ella",
      shiftHours: "8:00 AM - 2:00 PM",
      updatedAt: Date.now(),
    },
    {
      id: makeId("task"),
      title: "Clean fermentation room drains",
      description: "Log completed sanitation check for the weekly maintenance binder.",
      dayOfWeek: 2,
      completed: false,
      priority: "medium",
      category: "Maintenance",
      weekId,
      assignee: "Marco",
      shiftHours: "10:00 AM - 12:00 PM",
      updatedAt: Date.now(),
    },
    {
      id: makeId("task"),
      title: "Bottle batch SS-0826",
      description: "Pull labels, inspect closures, and confirm case count after pack-off.",
      dayOfWeek: 3,
      completed: false,
      priority: "high",
      category: "Production",
      weekId,
      assignee: "Ella",
      shiftHours: "9:00 AM - 5:00 PM",
      updatedAt: Date.now(),
    },
    {
      id: makeId("task"),
      title: "Update excise record packet",
      description: "Reconcile proof gallons and attach production notes.",
      dayOfWeek: 4,
      completed: false,
      priority: "medium",
      category: "Compliance",
      weekId,
      assignee: "Nora",
      shiftHours: "1:00 PM - 4:00 PM",
      updatedAt: Date.now(),
    },
    {
      id: makeId("task"),
      title: "Weekend tasting room setup",
      description: "Stock glassware, garnish station, POS drawer, and sample bottles.",
      dayOfWeek: 5,
      completed: false,
      priority: "low",
      category: "Front of House",
      weekId,
      assignee: "Jules",
      shiftHours: "2:00 PM - 9:00 PM",
      updatedAt: Date.now(),
    },
    {
      id: makeId("task"),
      title: "Proof still safety inspection",
      description: "Check seals, condenser flow, and emergency shutoff documentation.",
      dayOfWeek: 6,
      completed: false,
      priority: "high",
      category: "Distilling",
      weekId,
      assignee: "Marco",
      shiftHours: "7:00 AM - 11:00 AM",
      updatedAt: Date.now(),
    },
  ];
}

export function createSeedBills(): Bill[] {
  const now = new Date();
  return [
    {
      id: makeId("bill"),
      name: "Glass bottle shipment",
      amount: 1840,
      dueDate: toLocalDateKey(addDays(now, 4)),
      paid: false,
      category: "Packaging",
      recurring: false,
      updatedAt: Date.now(),
    },
    {
      id: makeId("bill"),
      name: "Utilities",
      amount: 620,
      dueDate: toLocalDateKey(addDays(now, 8)),
      paid: false,
      category: "Facilities",
      recurring: true,
      updatedAt: Date.now(),
    },
    {
      id: makeId("bill"),
      name: "Label printer lease",
      amount: 195,
      dueDate: toLocalDateKey(addDays(now, 13)),
      paid: true,
      category: "Equipment",
      recurring: true,
      updatedAt: Date.now(),
    },
  ];
}

export function createSeedDailyEvents(weekId: string): DailyEvents {
  return {
    [dailyEventKey(weekId, 1)]: "County buyer pickup window is 11:00 AM - 1:00 PM.",
    [dailyEventKey(weekId, 3)]: `Batch SS-0826 uses bottles staged on ${dateKeyForWeekDay(weekId, 2)}.`,
  };
}
