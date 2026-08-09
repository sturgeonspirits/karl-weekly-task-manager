import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Evaluates the real apps-script/Code.gs against injected fakes and hands back its
 * internal functions.
 *
 * The alternative -- copying Code.gs's logic into a testable module -- would drift from
 * the file you actually paste into the Apps Script editor. This way the tests always
 * exercise the exact source that gets deployed. Code.gs is plain ES5-style script, so its
 * `function` and `var` declarations hoist into the wrapper's scope and can be returned.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "Code.gs"), "utf8");

/** Everything the tests reach for. Add to this list to expose more of the script. */
const EXPORTED = [
  "KWTM_SCRIPT_VERSION",
  "KWTM_TASK_HEADERS",
  "KWTM_DAILY_HEADERS",
  "KWTM_BILL_HEADERS",
  "KWTM_SOFT_DELETE_RETENTION_MS",
  "KWTM_BACKUP_RETENTION_DAYS",
  "KWTM_upsertRows_",
  "KWTM_overwriteRows_",
  "KWTM_shouldSkipStaleRow_",
  "KWTM_shouldPruneDeletedRow_",
  "KWTM_deleteRows_",
  "KWTM_backupTab_",
  "KWTM_pruneOldBackupTabs_",
  "KWTM_normalizeRows_",
  "KWTM_ensureSheetSize_",
  "KWTM_hasPrivateOperationsData_",
  "KWTM_writeOperations_",
  "KWTM_taskWeekIdForSheet_",
  "KWTM_taskDayOfWeekForSheet_",
  "KWTM_todayKey_",
] as const;

export type CodeGs = Record<(typeof EXPORTED)[number], any>;

export function loadCodeGs(globals: Record<string, unknown>): CodeGs {
  const names = Object.keys(globals);
  const body = `${source}\n;return { ${EXPORTED.join(", ")} };`;
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, body) as (...args: unknown[]) => CodeGs;
  return factory(...names.map((name) => globals[name]));
}
