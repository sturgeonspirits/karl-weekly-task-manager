/**
 * Predicates that classify tasks by origin. These decide what gets written back to which
 * workbook, so they must agree across every layer of the sync.
 *
 * NOTE: netlify/functions/sheets-sync.mjs and apps-script/Code.gs each keep their own copy
 * of `isPrivateTask` / `hasPrivateOperationsData` -- a Netlify Function bundle and an Apps
 * Script project cannot import from src/. If you change the rules here, change them there
 * too (KWTM_isPrivateTask_, KWTM_hasPrivateOperationsData_).
 */

import type { OperationsSnapshot, Task } from "../types";

export function isPrivateTask(task: Pick<Task, "id" | "source">): boolean {
  return task.source !== "staff" && !String(task.id || "").startsWith("staff-");
}

export function isStaffTask(task: Pick<Task, "id" | "source">): boolean {
  return !isPrivateTask(task);
}

/** True when a record has any keys at all, including deletion tombstones with empty values. */
export function hasRecordKeys(record?: Record<string, string>): boolean {
  return Object.keys(record || {}).length > 0;
}

/**
 * Guards against pushing an empty browser cache over a populated sheet. Tombstones count,
 * because deleting the last note is a legitimate change that must be allowed to sync.
 */
export function hasPrivateOperationsData(snapshot: OperationsSnapshot): boolean {
  return Boolean(
    snapshot.tasks.some(isPrivateTask) || snapshot.bills.length || hasRecordKeys(snapshot.dailyEvents)
  );
}

export function hasAnySyncedData(snapshot: OperationsSnapshot): boolean {
  return Boolean(
    snapshot.tasks.length ||
      snapshot.bills.length ||
      snapshot.staff.length ||
      hasRecordKeys(snapshot.dailyEvents) ||
      hasRecordKeys(snapshot.staffDailyEvents)
  );
}
