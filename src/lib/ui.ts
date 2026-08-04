import type { CategoryOption, Priority } from "../types";

export const KARL_ASSIGNEE = "Karl Loewenstein";

export const toneClasses: Record<string, string> = {
  emerald: "border-[#87A67F]/45 bg-[#87A67F]/15 text-[#3F5D39]",
  amber: "border-[#C8BCA4] bg-[#F1F1E7] text-[#7E613F]",
  rose: "border-[#96321F]/35 bg-[#96321F]/10 text-[#96321F]",
  sky: "border-[#7E613F]/25 bg-[#C8BCA4]/20 text-[#7E613F]",
  violet: "border-[#7E613F]/30 bg-[#F1F1E7] text-[#242622]",
  slate: "border-[#242622]/20 bg-[#F1F1E7] text-[#242622]",
  copper: "border-[#96321F]/35 bg-[#96321F]/10 text-[#96321F]",
};

export const staffDotClasses: Record<string, string> = {
  emerald: "bg-[#87A67F]",
  amber: "bg-[#C8BCA4]",
  rose: "bg-[#96321F]",
  sky: "bg-[#7E613F]",
  violet: "bg-[#242622]",
  slate: "bg-[#7E613F]",
  copper: "bg-[#96321F]",
};

function findCategory(categoryName: string, categories: CategoryOption[]): CategoryOption | undefined {
  const normalized = categoryName.toLowerCase();
  return categories.find((option) => option.id.toLowerCase() === normalized || option.name.toLowerCase() === normalized);
}

function humanizeCategory(categoryName: string): string {
  const trimmed = categoryName.trim();
  if (!trimmed) return "Uncategorized";
  if (/[A-Z&/]/.test(trimmed)) return trimmed;
  return trimmed
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function categoryLabel(categoryName: string, categories: CategoryOption[]): string {
  return findCategory(categoryName, categories)?.name || humanizeCategory(categoryName);
}

export function categoryValue(categoryName: string | undefined, categories: CategoryOption[]): string {
  if (!categoryName) return categories[0]?.id || "production";
  return findCategory(categoryName, categories)?.id || categoryName;
}

export function categoryMatches(categoryName: string, selectedCategory: string, categories: CategoryOption[]): boolean {
  if (selectedCategory === "all") return true;
  return categoryValue(categoryName, categories).toLowerCase() === selectedCategory.toLowerCase();
}

export function categoryTone(categoryName: string, categories: CategoryOption[]): string {
  const category = findCategory(categoryName, categories);
  if (category?.color.includes(" ") || category?.color.startsWith("bg-")) return category.color;
  return toneClasses[category?.color || "slate"] || toneClasses.slate;
}

export function isKarlAssignee(assignee?: string): boolean {
  const normalized = String(assignee || "").trim().toLowerCase();
  return normalized === "karl" || normalized === "karl loewenstein" || normalized.startsWith("karl@");
}

export function staffDot(color?: string): string {
  return staffDotClasses[color || "slate"] || staffDotClasses.slate;
}

export function priorityTone(priority: Priority): string {
  if (priority === "high") return "border-[#96321F]/35 bg-[#96321F]/10 text-[#96321F]";
  if (priority === "medium") return "border-[#C8BCA4] bg-[#F1F1E7] text-[#7E613F]";
  return "border-[#87A67F]/45 bg-[#87A67F]/15 text-[#3F5D39]";
}

export function priorityLabel(priority: Priority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}
