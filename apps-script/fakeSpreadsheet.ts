/**
 * A minimal in-memory stand-in for the Google Sheets services that Code.gs uses, so the
 * real script can be exercised in vitest.
 *
 * Code.gs is the half of the sync that actually writes to your spreadsheet, and it was
 * previously verified only by reading it. Rather than copy its logic into a testable
 * module -- which would drift -- Code.gs.test.ts evaluates the real file against these
 * fakes, so the tests always run whatever is about to be pasted into Apps Script.
 *
 * The fakes deliberately mimic Sheets' quirks that the script depends on:
 *  - getLastRow/getLastColumn report the extent of *data*, not the grid size
 *  - getRange beyond the grid throws, which is why Code.gs calls ensureSheetSize first
 *  - deleteRow shifts every row below it up by one
 */

export type CellValue = string | number | boolean | Date | null;

function normalise(value: unknown): CellValue {
  if (value === undefined || value === null) return "";
  return value as CellValue;
}

function isBlank(value: CellValue): boolean {
  return value === "" || value === null || value === undefined;
}

export class FakeSheet {
  name: string;
  hidden = false;
  /** Dense grid. grid[row][column], both zero-based. */
  private grid: CellValue[][] = [];
  private maxRows: number;
  private maxColumns: number;

  constructor(name: string, maxRows = 1000, maxColumns = 26) {
    this.name = name;
    this.maxRows = maxRows;
    this.maxColumns = maxColumns;
  }

  getName(): string {
    return this.name;
  }

  hideSheet(): void {
    this.hidden = true;
  }

  getMaxRows(): number {
    return this.maxRows;
  }

  getMaxColumns(): number {
    return this.maxColumns;
  }

  insertRowsAfter(_afterRow: number, count: number): void {
    this.maxRows += count;
  }

  insertColumnsAfter(_afterColumn: number, count: number): void {
    this.maxColumns += count;
  }

  /** Extent of data, matching Sheets: the last row containing any non-empty cell. */
  getLastRow(): number {
    for (let row = this.grid.length - 1; row >= 0; row -= 1) {
      if ((this.grid[row] || []).some((cell) => !isBlank(cell))) return row + 1;
    }
    return 0;
  }

  getLastColumn(): number {
    let last = 0;
    this.grid.forEach((row) => {
      (row || []).forEach((cell, index) => {
        if (!isBlank(cell)) last = Math.max(last, index + 1);
      });
    });
    return last;
  }

  clearContents(): void {
    this.grid = [];
  }

  appendRow(values: unknown[]): void {
    const target = this.getLastRow();
    this.writeRow(target, values.map(normalise));
  }

  deleteRow(rowNumber: number): void {
    this.grid.splice(rowNumber - 1, 1);
    this.maxRows -= 1;
  }

  getRange(row: number, column: number, numRows = 1, numColumns = 1) {
    if (row < 1 || column < 1) throw new Error(`Invalid range at ${row},${column}`);
    if (row + numRows - 1 > this.maxRows) {
      throw new Error(
        `Range exceeds sheet rows on "${this.name}": needs ${row + numRows - 1}, grid has ${this.maxRows}`
      );
    }
    if (column + numColumns - 1 > this.maxColumns) {
      throw new Error(
        `Range exceeds sheet columns on "${this.name}": needs ${column + numColumns - 1}, grid has ${this.maxColumns}`
      );
    }

    const sheet = this;
    return {
      getValues(): CellValue[][] {
        const out: CellValue[][] = [];
        for (let r = 0; r < numRows; r += 1) {
          const source = sheet.grid[row - 1 + r] || [];
          const line: CellValue[] = [];
          for (let c = 0; c < numColumns; c += 1) line.push(normalise(source[column - 1 + c]));
          out.push(line);
        }
        return out;
      },
      getDisplayValues(): string[][] {
        return this.getValues().map((line) => line.map((cell) => (isBlank(cell) ? "" : String(cell))));
      },
      setValues(values: unknown[][]): void {
        if (values.length !== numRows) {
          throw new Error(`setValues row count ${values.length} does not match range ${numRows}`);
        }
        values.forEach((line, r) => {
          if (line.length !== numColumns) {
            throw new Error(`setValues column count ${line.length} does not match range ${numColumns}`);
          }
          line.forEach((value, c) => sheet.setCell(row - 1 + r, column - 1 + c, normalise(value)));
        });
      },
      setValue(value: unknown): void {
        sheet.setCell(row - 1, column - 1, normalise(value));
      },
    };
  }

  private setCell(row: number, column: number, value: CellValue): void {
    while (this.grid.length <= row) this.grid.push([]);
    const line = this.grid[row];
    while (line.length <= column) line.push("");
    line[column] = value;
  }

  private writeRow(row: number, values: CellValue[]): void {
    values.forEach((value, index) => this.setCell(row, index, value));
  }

  /** Test helper: every populated row as strings, header included. */
  rows(): string[][] {
    const lastRow = this.getLastRow();
    const lastColumn = this.getLastColumn();
    if (!lastRow || !lastColumn) return [];
    return this.getRange(1, 1, lastRow, lastColumn).getDisplayValues();
  }

  /** Test helper: seed a sheet from a header row plus data rows. */
  static from(name: string, rows: unknown[][]): FakeSheet {
    const sheet = new FakeSheet(name);
    rows.forEach((line, index) => sheet.writeRow(index, line.map(normalise)));
    return sheet;
  }
}

export class FakeSpreadsheet {
  private sheets: FakeSheet[] = [];

  constructor(private id = "fake-sheet-id") {}

  getId(): string {
    return this.id;
  }

  getSheets(): FakeSheet[] {
    return [...this.sheets];
  }

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.find((sheet) => sheet.getName() === name) || null;
  }

  insertSheet(name: string): FakeSheet {
    if (this.getSheetByName(name)) throw new Error(`Sheet "${name}" already exists`);
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }

  deleteSheet(sheet: FakeSheet): void {
    this.sheets = this.sheets.filter((candidate) => candidate !== sheet);
  }

  /** Test helper. */
  add(sheet: FakeSheet): FakeSheet {
    this.sheets.push(sheet);
    return sheet;
  }
}

export type AppsScriptEnvironment = {
  spreadsheets: Map<string, FakeSpreadsheet>;
  properties: Record<string, string>;
  globals: Record<string, unknown>;
};

export function createEnvironment(options: {
  spreadsheets?: Record<string, FakeSpreadsheet>;
  properties?: Record<string, string>;
  active?: FakeSpreadsheet;
  timeZone?: string;
} = {}): AppsScriptEnvironment {
  const spreadsheets = new Map(Object.entries(options.spreadsheets || {}));
  const properties = { ...(options.properties || {}) };
  const timeZone = options.timeZone || "UTC";

  const SpreadsheetApp = {
    openById(id: string): FakeSpreadsheet {
      const found = spreadsheets.get(id);
      if (!found) throw new Error(`No fake spreadsheet registered for id "${id}"`);
      return found;
    },
    getActive(): FakeSpreadsheet {
      if (!options.active) throw new Error("No active fake spreadsheet configured");
      return options.active;
    },
  };

  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty: (key: string) => (key in properties ? properties[key] : null),
        setProperty: (key: string, value: string) => {
          properties[key] = value;
        },
      };
    },
  };

  const LockService = {
    getScriptLock() {
      return { waitLock: () => undefined, releaseLock: () => undefined };
    },
  };

  const Utilities = {
    formatDate(date: Date, _timeZone: string, format: string): string {
      // Code.gs only ever asks for yyyy-MM-dd.
      if (format !== "yyyy-MM-dd") throw new Error(`Unexpected date format "${format}"`);
      return date.toISOString().slice(0, 10);
    },
  };

  const Session = { getScriptTimeZone: () => timeZone };

  return {
    spreadsheets,
    properties,
    globals: { SpreadsheetApp, PropertiesService, LockService, Utilities, Session },
  };
}
