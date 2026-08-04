import { describe, expect, it } from "vitest";
import { mergeDailyEventSets } from "./sheetsService";

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
