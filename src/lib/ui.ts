import type { CategoryOption, Priority } from "../types";

export const toneClasses: Record<string, string> = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  rose: "border-rose-200 bg-rose-50 text-rose-800",
  sky: "border-sky-200 bg-sky-50 text-sky-800",
  violet: "border-violet-200 bg-violet-50 text-violet-800",
  slate: "border-slate-200 bg-slate-50 text-slate-700",
  copper: "border-orange-200 bg-orange-50 text-orange-800",
};

export const staffDotClasses: Record<string, string> = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  slate: "bg-slate-500",
  copper: "bg-orange-500",
};

export function categoryTone(categoryName: string, categories: CategoryOption[]): string {
  const category = categories.find((option) => option.name.toLowerCase() === categoryName.toLowerCase());
  return toneClasses[category?.color || "slate"] || toneClasses.slate;
}

export function staffDot(color?: string): string {
  return staffDotClasses[color || "slate"] || staffDotClasses.slate;
}

export function priorityTone(priority: Priority): string {
  if (priority === "high") return "border-rose-200 bg-rose-50 text-rose-800";
  if (priority === "medium") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-sky-200 bg-sky-50 text-sky-800";
}

export function priorityLabel(priority: Priority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}
