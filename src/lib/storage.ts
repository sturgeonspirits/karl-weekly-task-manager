/** localStorage key for the cached operations snapshot. Bump the suffix to invalidate old caches. */
export const STORAGE_KEY = "karl-weekly-task-manager-v2";

export function clearCachedSnapshot(): void {
  localStorage.removeItem(STORAGE_KEY);
}
