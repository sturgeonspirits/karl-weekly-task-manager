import { describe, expect, it } from "vitest";
import { columnReader, BILL_COLUMNS, TASK_COLUMNS } from "./sheetSchema";

describe("columnReader", () => {
  it("prefers the sheet's own header position over the canonical one", () => {
    const column = columnReader(TASK_COLUMNS, ["title", "id", "category"]);

    expect(column.index("id")).toBe(1);
    expect(column.index("title")).toBe(0);
  });

  it("matches headers case-insensitively and ignores surrounding whitespace", () => {
    const column = columnReader(TASK_COLUMNS, ["  ID  ", "TiTlE"]);

    expect(column.index("id")).toBe(0);
    expect(column.index("title")).toBe(1);
  });

  it("falls back to the canonical position only when asked", () => {
    const column = columnReader(TASK_COLUMNS, []);

    expect(column.index("assignee")).toBe(-1);
    expect(column.index("assignee", { fallback: true })).toBe(12);
  });

  it("does not invent a position for a column missing from the canonical layout", () => {
    const column = columnReader(TASK_COLUMNS, []);

    expect(column.index("nonsense", { fallback: true })).toBe(-1);
  });

  it("resolves aliases in the order given", () => {
    const legacy = columnReader(BILL_COLUMNS, ["id", "name", "amount"]);

    expect(legacy.index(["title", "name"])).toBe(1);
  });

  it("reports whether the sheet declared a header", () => {
    const column = columnReader(BILL_COLUMNS, ["id", "title"]);

    expect(column.hasHeader("title")).toBe(true);
    expect(column.hasHeader("payee")).toBe(false);
  });

  it("returns trimmed cells and empty strings for absent columns", () => {
    const column = columnReader(TASK_COLUMNS, ["id", "title"]);

    expect(column.cell(["t-1", "  Mash grain  "], "title")).toBe("Mash grain");
    expect(column.cell(["t-1"], "assignee")).toBe("");
  });
});
