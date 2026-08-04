/**
 * Single source of truth for Google Sheets column layouts.
 *
 * Every parser in sheetsService.ts resolves columns through `columnReader` instead of
 * hardcoding `row[7]`, so reordering a column in the sheet no longer silently corrupts
 * data. When a header row is present and recognised, its position wins; otherwise we fall
 * back to the canonical position below, which is what the parsers used to assume
 * unconditionally.
 *
 * NOTE: apps-script/Code.gs writes these same tabs and keeps its own copies of these
 * arrays (KWTM_TASK_HEADERS, KWTM_BILL_HEADERS, ...). Apps Script cannot import from
 * src/, so the two must be changed together. If you edit a layout here, edit Code.gs too.
 */

export const TASK_COLUMNS = [
  "id",
  "title",
  "category",
  "description",
  "dayOfWeek",
  "completed",
  "weekId",
  "repeatsWeekly",
  "repeatPattern",
  "originTaskId",
  "deleted",
  "reminderDate",
  "assignee",
  "priority",
  "shiftHours",
  "updatedAt",
] as const;

/** The `Todos` tab in the staff scheduling workbook. Written by KWTM_patchStaffTodos_. */
export const STAFF_TODO_COLUMNS = [
  "id",
  "title",
  "category",
  "completed",
  "createdBy",
  "createdAt",
  "updatedBy",
  "updatedAt",
  "dueDate",
  "token",
  "assignee",
  "proof",
  "originTaskId",
  "priority",
  "shiftHours",
] as const;

export const BILL_COLUMNS = [
  "id",
  "title",
  "payee",
  "amount",
  "dueDate",
  "frequency",
  "category",
  "status",
  "autoPay",
  "paymentAccount",
  "notes",
  "updatedAt",
  "deleted",
] as const;

/** Older Bills layout, still present in sheets that predate the `title`/`payee` columns. */
export const LEGACY_BILL_COLUMNS = [
  "id",
  "name",
  "amount",
  "dueDate",
  "status",
  "category",
  "recurring",
  "updatedAt",
] as const;

export const DAILY_COLUMNS = ["key", "text", "updatedAt", "deleted"] as const;
export const CATEGORY_COLUMNS = ["id", "name", "color"] as const;
export const STAFF_COLUMNS = ["id", "name", "role", "email", "phone", "color"] as const;

/** The `Staff` tab in the staff scheduling workbook: email first, then name, then a manager flag. */
export const STAFF_ROSTER_COLUMNS = ["email", "name", "manager"] as const;

export type ColumnReader = {
  /**
   * Column index for the first matching name, or -1.
   *
   * Pass `fallback: true` to fall back to the canonical position when the sheet has no
   * usable header row. Columns that were historically header-only -- where an absent
   * header means "this data does not exist" rather than "look at the usual spot" --
   * should be looked up without a fallback.
   */
  index(names: string | readonly string[], options?: { fallback?: boolean }): number;
  /** Trimmed cell value for the first matching name, or "" when the column is absent. */
  cell(row: readonly string[], names: string | readonly string[], options?: { fallback?: boolean }): string;
  /** True when the sheet's own header row contains this name. */
  hasHeader(name: string): boolean;
};

export function columnReader(canonical: readonly string[], headerRow?: readonly string[]): ColumnReader {
  const actual = (headerRow || []).map((header) => String(header ?? "").trim().toLowerCase());
  const canonicalLower = canonical.map((name) => name.toLowerCase());

  function index(names: string | readonly string[], options?: { fallback?: boolean }): number {
    const candidates = typeof names === "string" ? [names] : names;

    for (const name of candidates) {
      const found = actual.indexOf(name.toLowerCase());
      if (found >= 0) return found;
    }

    if (!options?.fallback) return -1;

    for (const name of candidates) {
      const found = canonicalLower.indexOf(name.toLowerCase());
      if (found >= 0) return found;
    }

    return -1;
  }

  function cell(row: readonly string[], names: string | readonly string[], options?: { fallback?: boolean }): string {
    const position = index(names, options);
    if (position < 0) return "";
    return String(row[position] ?? "").trim();
  }

  function hasHeader(name: string): boolean {
    return actual.includes(name.toLowerCase());
  }

  return { index, cell, hasHeader };
}
