/** localStorage key for the cached operations snapshot. Bump the suffix to invalidate old caches. */
export const STORAGE_KEY = "karl-weekly-task-manager-v2";
export const LAST_SYNCED_STORAGE_KEY = "karl-weekly-task-manager-last-synced-v1";

export function clearCachedSnapshot(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LAST_SYNCED_STORAGE_KEY);
}
