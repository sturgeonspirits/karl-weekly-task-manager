import { ArrowRightLeft, BadgeDollarSign, CalendarDays, CheckCircle2, LayoutGrid, RotateCcw, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BillsView } from "./components/BillsView";
import { CompletedTasksView } from "./components/CompletedTasksView";
import { DailyAgendaView } from "./components/DailyAgendaView";
import { GeneralRemindersPanel } from "./components/GeneralRemindersPanel";
import { StaffSchedulerView } from "./components/StaffSchedulerView";
import { TaskDialog } from "./components/TaskDialog";
import { TransferPanel } from "./components/TransferPanel";
import { WeeklyGrid } from "./components/WeeklyGrid";
import { seedCategories } from "./data/seedData";
import {
  DEFAULT_PRIVATE_SHEET_ID,
  DEFAULT_STAFF_TODOS_SHEET_ID,
  mergeDailyEventSets,
  pullAppsScriptSnapshot,
  pushAppsScriptOperations,
  pushAppsScriptStaffSchedule,
  pushAppsScriptStaffTodos,
  type AppsScriptSyncConfig,
} from "./lib/sheetsService";
import type { Bill, CategoryOption, DailyEvents, OperationsSnapshot, StaffMember, Task } from "./types";
import {
  addDays,
  dateFromKey,
  dateKeyForWeekDay,
  deduplicateTasks,
  ensureRecurringTasksForWeek,
  getTaskDate,
  sanitizeBills,
  sanitizeDailyEvents,
  sanitizeTasks,
  todayStr,
  toLocalDateKey,
  weekIdFromDate,
} from "./utils";
import { isKarlAssignee } from "./lib/ui";
import { LAST_SYNCED_STORAGE_KEY, STORAGE_KEY } from "./lib/storage";
import { hasAnySyncedData, hasPrivateOperationsData, isPrivateTask, isStaffTask } from "./lib/taskPredicates";


const AUTO_PULL_MS = 60_000;
const AUTO_SAVE_MS = 2_500;
const AUTO_SAVE_RETRY_MS = 30_000;
const SHEET_SYNC_CONFIG: AppsScriptSyncConfig = {
  privateSheetId: DEFAULT_PRIVATE_SHEET_ID,
  staffTodosSheetId: DEFAULT_STAFF_TODOS_SHEET_ID,
  publicStaffSheetId: "",
};

type ActiveView = "weekly" | "daily" | "staff" | "bills" | "transfer" | "completed";
type DialogState = { open: boolean; day: number; task?: Task | null; generalReminder?: boolean };

const navItems: Array<{ id: ActiveView; label: string; icon: typeof LayoutGrid }> = [
  { id: "weekly", label: "Weekly", icon: LayoutGrid },
  { id: "daily", label: "Agenda", icon: CalendarDays },
  { id: "staff", label: "Staff", icon: UsersRound },
  { id: "bills", label: "Bills", icon: BadgeDollarSign },
  { id: "transfer", label: "Transfer", icon: ArrowRightLeft },
  { id: "completed", label: "Completed", icon: CheckCircle2 },
];

function initialActiveView(): ActiveView {
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches) return "daily";
  return "weekly";
}

function normalizeTasksForWeek(tasks: Task[], weekId: string): Task[] {
  return deduplicateTasks(ensureRecurringTasksForWeek(sanitizeTasks(tasks), weekId));
}

function sameTasks(left: Task[], right: Task[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((task, index) => JSON.stringify(task) === JSON.stringify(right[index]));
}

function isKarlVisibleTask(task: Task): boolean {
  return isPrivateTask(task) || isKarlAssignee(task.assignee);
}

function isEarlierOpenTask(task: Task, todayKey: string): boolean {
  return (
    isKarlVisibleTask(task) &&
    !task.completed &&
    !task.deleted &&
    !task.isGeneralReminder &&
    getTaskDate(task) < todayKey
  );
}

function shouldSendToStaffTodosSync(task: Task): boolean {
  if (isStaffTask(task)) return true;
  return Boolean(isPrivateTask(task) && !task.isGeneralReminder && task.assignee && !isKarlAssignee(task.assignee));
}

function loadSnapshot(weekId: string): OperationsSnapshot {
  const fallback: OperationsSnapshot = {
    tasks: [],
    categories: seedCategories,
    bills: [],
    staff: [],
    dailyEvents: {},
    staffDailyEvents: {},
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<OperationsSnapshot>;
    return {
      tasks: normalizeTasksForWeek(parsed.tasks || fallback.tasks, weekId),
      categories: parsed.categories?.length ? parsed.categories : fallback.categories,
      bills: sanitizeBills(parsed.bills?.length ? parsed.bills : fallback.bills),
      staff: parsed.staff?.length ? parsed.staff : fallback.staff,
      dailyEvents: sanitizeDailyEvents(parsed.dailyEvents || fallback.dailyEvents),
      staffDailyEvents: sanitizeDailyEvents(parsed.staffDailyEvents || fallback.staffDailyEvents || {}),
    };
  } catch {
    return fallback;
  }
}

function readLocalStorageValue(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeLocalStorageValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The in-memory refs still keep this tab safe; persistence will resume when storage works.
  }
}

function removeLocalStorageValue(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing useful to do here; the next successful sync rewrites the marker.
  }
}

export default function App() {
  const [weekId, setWeekId] = useState(() => weekIdFromDate(new Date()));
  const [activeView, setActiveView] = useState<ActiveView>(initialActiveView);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dialog, setDialog] = useState<DialogState>({ open: false, day: 1, task: null });
  const [snapshot, setSnapshot] = useState<OperationsSnapshot>(() => loadSnapshot(weekId));
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  // Kept separate from syncStatus so a failure is not silently painted over by the next
  // "Autosave queued...". It clears only when a sync actually succeeds.
  const [syncError, setSyncError] = useState("");
  const autoPullStartedRef = useRef(false);
  const autoSaveTimerRef = useRef<number | null>(null);
  const retrySaveTimerRef = useRef<number | null>(null);
  const syncReadyRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const remoteSnapshotJsonRef = useRef("");
  const initialSnapshotJson = JSON.stringify(snapshot);
  const cachedSnapshotExistsRef = useRef(Boolean(readLocalStorageValue(STORAGE_KEY)));
  const storedLastSyncedSnapshotRef = useRef(readLocalStorageValue(LAST_SYNCED_STORAGE_KEY));
  const hasUnconfirmedCachedSnapshotRef = useRef(
    cachedSnapshotExistsRef.current && !storedLastSyncedSnapshotRef.current && hasAnySyncedData(snapshot)
  );
  const lastSavedSnapshotJsonRef = useRef(
    hasUnconfirmedCachedSnapshotRef.current ? "" : storedLastSyncedSnapshotRef.current || initialSnapshotJson
  );

  // Serialising the snapshot is O(size of everything), so do it once per change and share
  // the result between the cache write and the autosave dirty check.
  const snapshotJson = useMemo(() => JSON.stringify(snapshot), [snapshot]);

  // Lets pullSheets read the newest snapshot without taking it as a dependency. Without
  // this, pullSheets is rebuilt on every edit and the auto-pull interval below is torn
  // down and restarted with it, so it never actually reaches AUTO_PULL_MS while you type.
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    writeLocalStorageValue(STORAGE_KEY, snapshotJson);
  }, [snapshotJson]);

  const scheduledTasks = useMemo(
    () =>
      snapshot.tasks.filter(
        (task) => !task.deleted && !task.isGeneralReminder && Boolean(task.specificDate) && isKarlVisibleTask(task)
      ),
    [snapshot.tasks]
  );
  const activeWeekTasks = useMemo(
    () => scheduledTasks.filter((task) => task.weekId === weekId),
    [scheduledTasks, weekId]
  );
  const openScheduledTasks = useMemo(() => scheduledTasks.filter((task) => !task.completed), [scheduledTasks]);
  const generalReminderTasks = useMemo(
    () => snapshot.tasks.filter((task) => task.source !== "staff" && task.isGeneralReminder && !task.deleted && !task.completed),
    [snapshot.tasks]
  );
  const staffSchedulerTasks = useMemo(
    () => snapshot.tasks.filter((task) => isStaffTask(task) && !task.deleted && !task.completed),
    [snapshot.tasks]
  );
  const visibleDailyEvents = useMemo(
    () => mergeDailyEventSets(snapshot.dailyEvents, snapshot.staffDailyEvents || {}),
    [snapshot.dailyEvents, snapshot.staffDailyEvents]
  );
  const earlierOpenTasks = useMemo(() => {
    const todayKey = todayStr();
    return snapshot.tasks.filter((task) => isEarlierOpenTask(task, todayKey));
  }, [snapshot.tasks]);

  const completed = activeWeekTasks.filter((task) => task.completed).length;
  const highPriority = activeWeekTasks.filter((task) => !task.completed && task.priority === "high").length;
  const assigned = activeWeekTasks.filter((task) => !task.completed && task.assignee).length;
  const outstandingBills = snapshot.bills.filter((bill) => !bill.deleted && !bill.paid).reduce((sum, bill) => sum + bill.amount, 0);

  /**
   * Every task mutation goes through here. The updater receives the freshest task list
   * rather than the one captured when this render started, so two changes landing in the
   * same tick (a rapid double toggle, a save while an autosync is applying) can no longer
   * clobber each other.
   */
  function updateTasks(updater: (tasks: Task[]) => Task[]) {
    setSnapshot((current) => ({ ...current, tasks: normalizeTasksForWeek(updater(current.tasks), weekId) }));
  }

  function setBills(bills: Bill[]) {
    setSnapshot((current) => ({ ...current, bills: sanitizeBills(bills) }));
  }

  function setStaff(staff: StaffMember[]) {
    setSnapshot((current) => ({ ...current, staff }));
  }

  function saveTask(task: Task) {
    const source = task.source || (task.id.startsWith("staff-") ? "staff" : "private");
    const isGeneralReminder = source === "staff" ? false : Boolean(task.isGeneralReminder || !task.specificDate);
    const specificDate = isGeneralReminder || (source === "staff" && !task.specificDate) ? undefined : task.specificDate;
    const normalizedTask: Task = {
      ...task,
      source,
      specificDate,
      specificDateWasExplicit: false,
      repeatsWeekly: isGeneralReminder ? false : task.repeatsWeekly,
      repeatPattern: isGeneralReminder ? "none" : task.repeatPattern || "none",
      assignee: source === "private" ? task.assignee || undefined : task.assignee,
      shiftHours: isGeneralReminder ? undefined : task.shiftHours,
      isGeneralReminder,
    };
    updateTasks((tasks) =>
      tasks.some((item) => item.id === normalizedTask.id)
        ? tasks.map((item) => (item.id === normalizedTask.id ? normalizedTask : item))
        : [...tasks, normalizedTask]
    );
    setSyncStatus(syncReadyRef.current ? "Autosave queued..." : "Saved locally. Waiting for Sheets connection before autosave.");
    setDialog({ open: false, day: normalizedTask.dayOfWeek, task: null });
  }

  function toggleTask(taskId: string) {
    updateTasks((tasks) =>
      tasks.map((task) => (task.id === taskId ? { ...task, completed: !task.completed, updatedAt: Date.now() } : task))
    );
  }

  function deleteTask(task: Task) {
    if (!window.confirm(`Delete "${task.title}"?`)) return;
    updateTasks((tasks) =>
      tasks.map((item) =>
        item.id === task.id
          ? {
              ...item,
              deleted: true,
              completed: isStaffTask(item) ? true : item.completed,
              updatedAt: Date.now(),
            }
          : item
      )
    );
    setDialog({ open: false, day: task.dayOfWeek, task: null, generalReminder: false });
  }

  function cloneTaskToNextWeek(task: Task) {
    const nextWeekId = toLocalDateKey(addDays(dateFromKey(task.weekId), 7));
    const clone: Task = {
      ...task,
      id: `task-${nextWeekId}-${task.dayOfWeek}-${Date.now()}`,
      weekId: nextWeekId,
      completed: false,
      originTaskId: task.originTaskId || task.id,
      specificDate: dateKeyForWeekDay(nextWeekId, task.dayOfWeek),
      specificDateWasExplicit: false,
      isGeneralReminder: false,
      updatedAt: Date.now(),
    };
    updateTasks((tasks) => [...tasks, clone]);
    setWeekId(nextWeekId);
  }

  function changeDailyNote(key: string, value: string) {
    setSnapshot((current) => {
      const dailyEvents: DailyEvents = { ...current.dailyEvents };
      if (value.trim()) dailyEvents[key] = value;
      else dailyEvents[key] = "";
      return { ...current, dailyEvents: sanitizeDailyEvents(dailyEvents) };
    });
  }

  function transferTasks(tasksToTransfer: Task[]) {
    if (!tasksToTransfer.length) return;
    updateTasks((tasks) => [
      ...tasks,
      ...tasksToTransfer.map((task) => ({
        ...task,
        specificDate: dateKeyForWeekDay(weekId, task.dayOfWeek),
        specificDateWasExplicit: false,
        isGeneralReminder: false,
      })),
    ]);
  }

  function moveEarlierOpenTasksToToday() {
    if (!earlierOpenTasks.length) return;
    if (!window.confirm(`Move ${earlierOpenTasks.length} earlier open task${earlierOpenTasks.length === 1 ? "" : "s"} to today?`)) return;

    const todayKey = todayStr();
    const today = dateFromKey(todayKey);
    const day = today.getDay();
    const dayOfWeek = day === 0 ? 7 : day;
    const targetWeekId = weekIdFromDate(today);

    setWeekId(targetWeekId);
    updateTasks((tasks) =>
      // Re-select inside the updater rather than reusing the memo, so a task that finished
      // syncing between the confirm and this update is not dragged forward anyway.
      tasks.map((task) =>
        isEarlierOpenTask(task, todayKey)
          ? {
              ...task,
              weekId: targetWeekId,
              dayOfWeek,
              specificDate: todayKey,
              isGeneralReminder: false,
              updatedAt: Date.now(),
            }
          : task
      )
    );
  }

  function resetLocalData() {
    if (!window.confirm("Reload this app from Google Sheets? Local browser cache will be cleared, but nothing will be saved to Sheets.")) return;
    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    if (retrySaveTimerRef.current) window.clearTimeout(retrySaveTimerRef.current);
    autoSaveTimerRef.current = null;
    retrySaveTimerRef.current = null;
    syncReadyRef.current = false;
    remoteSnapshotJsonRef.current = "";
    lastSavedSnapshotJsonRef.current = JSON.stringify(snapshotRef.current);
    removeLocalStorageValue(STORAGE_KEY);
    removeLocalStorageValue(LAST_SYNCED_STORAGE_KEY);
    setSyncStatus("Local cache cleared. Refreshing from Google Sheets...");
    void pullSheets();
  }

  const pullSheets = useCallback(async (silent = false) => {
    const pendingSnapshot = snapshotRef.current;
    const pendingSnapshotJson = JSON.stringify(pendingSnapshot);
    if (hasAnySyncedData(pendingSnapshot) && lastSavedSnapshotJsonRef.current !== pendingSnapshotJson) {
      if (!silent) setSyncStatus("Local changes are waiting to sync before the next refresh.");
      return;
    }
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setSyncBusy(true);
    if (!silent) setSyncStatus("Refreshing from Google Sheets...");
    try {
      const pulledSnapshot = await pullAppsScriptSnapshot(SHEET_SYNC_CONFIG, snapshotRef.current);
      const nextSnapshot = { ...pulledSnapshot, tasks: normalizeTasksForWeek(pulledSnapshot.tasks, weekId) };
      const pulledJson = JSON.stringify(nextSnapshot);
      const needsSheetRepair = nextSnapshot.tasks.some((task) => task.needsSheetRepair);
      remoteSnapshotJsonRef.current = needsSheetRepair ? "" : pulledJson;
      lastSavedSnapshotJsonRef.current = needsSheetRepair ? "" : pulledJson;
      if (needsSheetRepair) removeLocalStorageValue(LAST_SYNCED_STORAGE_KEY);
      else writeLocalStorageValue(LAST_SYNCED_STORAGE_KEY, pulledJson);
      syncReadyRef.current = true;
      setSnapshot(nextSnapshot);
      setSyncStatus(needsSheetRepair ? "Sheets refreshed; cleanup queued." : silent ? "Autosync refreshed from Sheets." : "Sheets refreshed.");
      setSyncError("");
    } catch (error) {
      setSyncStatus("");
      setSyncError(`Could not refresh from Sheets: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      syncInFlightRef.current = false;
      setSyncBusy(false);
    }
  }, [weekId]);

  const autoSaveSnapshot = useCallback(async (snapshotToSave: OperationsSnapshot, snapshotJson: string) => {
    if (syncInFlightRef.current) {
      autoSaveTimerRef.current = window.setTimeout(() => autoSaveSnapshot(snapshotToSave, snapshotJson), AUTO_SAVE_MS);
      return;
    }
    if (retrySaveTimerRef.current) {
      window.clearTimeout(retrySaveTimerRef.current);
      retrySaveTimerRef.current = null;
    }

    syncInFlightRef.current = true;
    setSyncBusy(true);
    setSyncStatus("Autosaving to Sheets...");
    try {
      const snapshotForSave = { ...snapshotToSave, tasks: normalizeTasksForWeek(snapshotToSave.tasks, weekId) };
      const normalizedSnapshotJson = JSON.stringify(snapshotForSave);
      if (!hasAnySyncedData(snapshotForSave)) {
        lastSavedSnapshotJsonRef.current = normalizedSnapshotJson;
        setSyncStatus("Autosave blocked: empty cache had no rows or tombstones to sync.");
        return;
      }
      const scheduledTasksForWeek = snapshotForSave.tasks.filter(
        (task) => task.weekId === weekId && !task.deleted && !task.isGeneralReminder && Boolean(task.specificDate)
      );
      const staffTodos = snapshotForSave.tasks.filter(shouldSendToStaffTodosSync);
      if (hasPrivateOperationsData(snapshotForSave)) {
        await pushAppsScriptOperations(SHEET_SYNC_CONFIG, snapshotForSave);
      }
      await pushAppsScriptStaffTodos(SHEET_SYNC_CONFIG, staffTodos);
      await pushAppsScriptStaffSchedule(SHEET_SYNC_CONFIG, weekId, scheduledTasksForWeek, snapshotForSave.staff);
      lastSavedSnapshotJsonRef.current = normalizedSnapshotJson;
      writeLocalStorageValue(LAST_SYNCED_STORAGE_KEY, normalizedSnapshotJson);
      hasUnconfirmedCachedSnapshotRef.current = false;
      setSyncStatus("Autosaved to Sheets.");
      setSyncError("");
    } catch (error) {
      setSyncStatus("");
      setSyncError(
        `Not saved to Sheets: ${error instanceof Error ? error.message : "unknown error"}. Your changes are still in this browser and will retry automatically.`
      );
      if (retrySaveTimerRef.current) window.clearTimeout(retrySaveTimerRef.current);
      retrySaveTimerRef.current = window.setTimeout(() => {
        retrySaveTimerRef.current = null;
        if (!syncReadyRef.current) return;
        const current = snapshotRef.current;
        const currentJson = JSON.stringify(current);
        if (lastSavedSnapshotJsonRef.current === currentJson) return;
        void autoSaveSnapshot(current, currentJson);
      }, AUTO_SAVE_RETRY_MS);
    } finally {
      autoSaveTimerRef.current = null;
      syncInFlightRef.current = false;
      setSyncBusy(false);
    }
  }, [weekId]);

  useEffect(() => {
    if (autoPullStartedRef.current) return;
    autoPullStartedRef.current = true;
    if (hasUnconfirmedCachedSnapshotRef.current || lastSavedSnapshotJsonRef.current !== JSON.stringify(snapshotRef.current)) {
      syncReadyRef.current = true;
      setSyncStatus("Saving browser changes to Sheets...");
      const current = snapshotRef.current;
      void autoSaveSnapshot(current, JSON.stringify(current));
      return;
    }
    void pullSheets();
  }, [autoSaveSnapshot, pullSheets]);

  useEffect(() => {
    setSnapshot((current) => {
      const tasks = normalizeTasksForWeek(current.tasks, weekId);
      if (sameTasks(tasks, current.tasks)) return current;
      return { ...current, tasks };
    });
  }, [weekId]);

  // pullSheets now depends only on weekId, so this interval survives editing instead of
  // being cleared and restarted on every keystroke.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible" || autoSaveTimerRef.current || retrySaveTimerRef.current) return;
      const current = snapshotRef.current;
      const currentJson = JSON.stringify(current);
      if (lastSavedSnapshotJsonRef.current !== currentJson) {
        if (hasAnySyncedData(current) && !syncInFlightRef.current) {
          syncReadyRef.current = true;
          void autoSaveSnapshot(current, currentJson);
        }
        return;
      }
      void pullSheets(true);
    }, AUTO_PULL_MS);
    return () => window.clearInterval(interval);
  }, [autoSaveSnapshot, pullSheets]);

  useEffect(() => {
    if (remoteSnapshotJsonRef.current === snapshotJson) {
      remoteSnapshotJsonRef.current = "";
      return;
    }
    if (!syncReadyRef.current || lastSavedSnapshotJsonRef.current === snapshotJson) return;

    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    if (retrySaveTimerRef.current) {
      window.clearTimeout(retrySaveTimerRef.current);
      retrySaveTimerRef.current = null;
    }
    setSyncStatus("Autosave queued...");
    autoSaveTimerRef.current = window.setTimeout(() => {
      void autoSaveSnapshot(snapshot, snapshotJson);
    }, AUTO_SAVE_MS);
  }, [autoSaveSnapshot, snapshot]);

  // Mobile browsers can keep reporting "online" while individual cellular requests fail.
  // Push as soon as the connection returns; pull first if there was nothing pending.
  useEffect(() => {
    function handleOnline() {
      if (!syncReadyRef.current) {
        const current = snapshotRef.current;
        const currentJson = JSON.stringify(current);
        if (hasAnySyncedData(current) && lastSavedSnapshotJsonRef.current !== currentJson) {
          syncReadyRef.current = true;
          setSyncStatus("Back online. Saving...");
          void autoSaveSnapshot(current, currentJson);
          return;
        }
        void pullSheets(true);
        return;
      }
      const pending = lastSavedSnapshotJsonRef.current !== JSON.stringify(snapshotRef.current);
      if (!pending) {
        void pullSheets(true);
        return;
      }
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
      if (retrySaveTimerRef.current) {
        window.clearTimeout(retrySaveTimerRef.current);
        retrySaveTimerRef.current = null;
      }
      setSyncStatus("Back online. Saving...");
      autoSaveTimerRef.current = window.setTimeout(() => {
        const current = snapshotRef.current;
        void autoSaveSnapshot(current, JSON.stringify(current));
      }, 0);
    }

    function handleOffline() {
      setSyncStatus("");
      setSyncError("Offline. Changes are saved in this browser and will sync when the connection returns.");
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [autoSaveSnapshot, pullSheets]);

  useEffect(() => {
    function retryPendingSave() {
      if (document.visibilityState !== "visible" || syncInFlightRef.current) return;
      const current = snapshotRef.current;
      const currentJson = JSON.stringify(current);
      if (lastSavedSnapshotJsonRef.current === currentJson) return;
      if (!hasAnySyncedData(current)) return;
      syncReadyRef.current = true;
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
      if (retrySaveTimerRef.current) {
        window.clearTimeout(retrySaveTimerRef.current);
        retrySaveTimerRef.current = null;
      }
      setSyncStatus("Saving pending browser changes...");
      autoSaveTimerRef.current = window.setTimeout(() => {
        const latest = snapshotRef.current;
        void autoSaveSnapshot(latest, JSON.stringify(latest));
      }, 0);
    }

    document.addEventListener("visibilitychange", retryPendingSave);
    window.addEventListener("focus", retryPendingSave);
    return () => {
      document.removeEventListener("visibilitychange", retryPendingSave);
      window.removeEventListener("focus", retryPendingSave);
    };
  }, [autoSaveSnapshot]);

  useEffect(
    () => () => {
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
      if (retrySaveTimerRef.current) window.clearTimeout(retrySaveTimerRef.current);
    },
    []
  );

  return (
    <div className="min-h-screen bg-mash text-ink">
      <header className="app-header">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="eyebrow text-[#96321F]">Karl Weekly Task Manager</p>
              <h1 className="text-2xl font-semibold text-ink sm:text-3xl">Distillery Schedule</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#7E613F]">
                Weekly tasks, daily notes, staff shifts, bills, carryover, and Google Sheets sync in one place.
              </p>
            </div>
            <div className="header-actions">
              <button className="btn-header" type="button" onClick={resetLocalData} disabled={syncBusy}>
                <RotateCcw size={17} />
                Reload From Sheets
              </button>
            </div>
          </div>
          {syncError ? (
            <p className="header-sync-error" role="alert">
              {syncError}
            </p>
          ) : syncStatus ? (
            <p className="header-sync-status">{syncStatus}</p>
          ) : null}

          <nav className="app-nav" aria-label="Application views">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={activeView === item.id ? "active" : ""}
                  onClick={() => setActiveView(item.id)}
                >
                  <Icon size={17} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="app-main mx-auto grid max-w-[1500px] gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <section className="ops-overview app-support-panel" aria-label="Week summary">
          <div>
            <span>Tasks</span>
            <strong>{completed}/{activeWeekTasks.length}</strong>
          </div>
          <div>
            <span>High Priority Open</span>
            <strong>{highPriority}</strong>
          </div>
          <div>
            <span>Assigned Shifts</span>
            <strong>{assigned}</strong>
          </div>
          <div>
            <span>Outstanding Bills</span>
            <strong>${Math.round(outstandingBills).toLocaleString()}</strong>
          </div>
        </section>

        <div className="app-support-panel">
          <GeneralRemindersPanel
            tasks={generalReminderTasks}
            categories={snapshot.categories}
            onAddReminder={() => setDialog({ open: true, day: 1, task: null, generalReminder: true })}
            onToggleTask={toggleTask}
            onEditTask={(task) => setDialog({ open: true, day: task.dayOfWeek, task })}
          />
        </div>

        <div className="app-primary-panel">
          {activeView === "weekly" ? (
            <WeeklyGrid
              weekId={weekId}
              tasks={openScheduledTasks}
              categories={snapshot.categories}
              staff={snapshot.staff}
              dailyEvents={visibleDailyEvents}
              searchTerm={searchTerm}
              categoryFilter={categoryFilter}
              onSearch={setSearchTerm}
              onCategoryFilter={setCategoryFilter}
              onDailyNoteChange={changeDailyNote}
              onWeekChange={setWeekId}
              onAddTask={(day) => setDialog({ open: true, day, task: null })}
              onMoveEarlierTasks={moveEarlierOpenTasksToToday}
              earlierOpenCount={earlierOpenTasks.length}
              onEditTask={(task) => setDialog({ open: true, day: task.dayOfWeek, task })}
              onToggleTask={toggleTask}
              onCloneTask={cloneTaskToNextWeek}
            />
          ) : null}

          {activeView === "daily" ? (
            <DailyAgendaView
              weekId={weekId}
              tasks={openScheduledTasks}
              categories={snapshot.categories}
              staff={snapshot.staff}
              dailyEvents={visibleDailyEvents}
              onDailyNoteChange={changeDailyNote}
              onWeekChange={setWeekId}
              onAddTask={(day) => setDialog({ open: true, day, task: null })}
              onToggleTask={toggleTask}
              onEditTask={(task) => setDialog({ open: true, day: task.dayOfWeek, task })}
            />
          ) : null}

          {activeView === "staff" ? (
            <StaffSchedulerView
              weekId={weekId}
              tasks={staffSchedulerTasks}
              staff={snapshot.staff}
              onEditTask={(task) => setDialog({ open: true, day: task.dayOfWeek, task })}
              onToggleTask={toggleTask}
            />
          ) : null}

          {activeView === "bills" ? <BillsView bills={snapshot.bills} onSaveBills={setBills} /> : null}

          {activeView === "transfer" ? (
            <TransferPanel weekId={weekId} tasks={openScheduledTasks} categories={snapshot.categories} onTransfer={transferTasks} />
          ) : null}

          {activeView === "completed" ? (
            <CompletedTasksView
              tasks={snapshot.tasks}
              categories={snapshot.categories}
              onToggleTask={toggleTask}
              onEditTask={(task) => setDialog({ open: true, day: task.dayOfWeek, task })}
            />
          ) : null}
        </div>

      </main>

      <TaskDialog
        open={dialog.open}
        task={dialog.task}
        weekId={weekId}
        defaultDay={dialog.day}
        defaultGeneralReminder={Boolean(dialog.generalReminder)}
        categories={snapshot.categories}
        staff={snapshot.staff}
        onClose={() => setDialog({ open: false, day: dialog.day, task: null, generalReminder: false })}
        onSave={saveTask}
        onDelete={deleteTask}
      />
    </div>
  );
}
