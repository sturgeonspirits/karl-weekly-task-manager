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
  sanitizeDailyEvents,
  sanitizeTasks,
  toLocalDateKey,
  weekIdFromDate,
} from "./utils";

const STORAGE_KEY = "karl-weekly-task-manager-v2";
const AUTO_PULL_MS = 60_000;
const AUTO_SAVE_MS = 2_500;
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

function normalizeTasksForWeek(tasks: Task[], weekId: string): Task[] {
  return deduplicateTasks(ensureRecurringTasksForWeek(sanitizeTasks(tasks), weekId));
}

function sameTasks(left: Task[], right: Task[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((task, index) => JSON.stringify(task) === JSON.stringify(right[index]));
}

function shouldSoftDeleteTask(task: Task): boolean {
  return Boolean(
    task.source === "staff" ||
      task.id.startsWith("staff-") ||
      task.originTaskId ||
      task.repeatsWeekly ||
      task.repeatPattern === "weekly" ||
      task.repeatPattern === "biweekly" ||
      task.repeatPattern === "monthly"
  );
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
      bills: parsed.bills?.length ? parsed.bills : fallback.bills,
      staff: parsed.staff?.length ? parsed.staff : fallback.staff,
      dailyEvents: sanitizeDailyEvents(parsed.dailyEvents || fallback.dailyEvents),
      staffDailyEvents: sanitizeDailyEvents(parsed.staffDailyEvents || fallback.staffDailyEvents || {}),
    };
  } catch {
    return fallback;
  }
}

export default function App() {
  const [weekId, setWeekId] = useState(() => weekIdFromDate(new Date()));
  const [activeView, setActiveView] = useState<ActiveView>("weekly");
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dialog, setDialog] = useState<DialogState>({ open: false, day: 1, task: null });
  const [snapshot, setSnapshot] = useState<OperationsSnapshot>(() => loadSnapshot(weekId));
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const autoPullStartedRef = useRef(false);
  const autoSaveTimerRef = useRef<number | null>(null);
  const syncReadyRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const remoteSnapshotJsonRef = useRef("");
  const lastSavedSnapshotJsonRef = useRef(JSON.stringify(snapshot));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }, [snapshot]);

  const scheduledTasks = useMemo(
    () => snapshot.tasks.filter((task) => !task.deleted && !task.isGeneralReminder && Boolean(task.specificDate)),
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
    () => snapshot.tasks.filter((task) => (task.source === "staff" || task.id.startsWith("staff-")) && !task.completed),
    [snapshot.tasks]
  );
  const visibleDailyEvents = useMemo(
    () => mergeDailyEventSets(snapshot.dailyEvents, snapshot.staffDailyEvents || {}),
    [snapshot.dailyEvents, snapshot.staffDailyEvents]
  );

  const completed = activeWeekTasks.filter((task) => task.completed).length;
  const highPriority = activeWeekTasks.filter((task) => !task.completed && task.priority === "high").length;
  const assigned = activeWeekTasks.filter((task) => !task.completed && task.assignee).length;
  const outstandingBills = snapshot.bills.filter((bill) => !bill.paid).reduce((sum, bill) => sum + bill.amount, 0);

  function setTasks(tasks: Task[]) {
    setSnapshot((current) => ({ ...current, tasks: normalizeTasksForWeek(tasks, weekId) }));
  }

  function setBills(bills: Bill[]) {
    setSnapshot((current) => ({ ...current, bills: bills.map((bill) => ({ ...bill, updatedAt: bill.updatedAt || Date.now() })) }));
  }

  function setStaff(staff: StaffMember[]) {
    setSnapshot((current) => ({ ...current, staff }));
  }

  function saveTask(task: Task) {
    const source = task.source || (task.id.startsWith("staff-") ? "staff" : "private");
    const specificDate = task.isGeneralReminder || (source === "staff" && !task.specificDate) ? undefined : task.specificDate;
    const normalizedTask: Task = {
      ...task,
      source,
      specificDate,
      specificDateWasExplicit: false,
      isGeneralReminder: source === "staff" ? false : Boolean(task.isGeneralReminder || !specificDate),
    };
    const exists = snapshot.tasks.some((item) => item.id === normalizedTask.id);
    setTasks(exists ? snapshot.tasks.map((item) => (item.id === normalizedTask.id ? normalizedTask : item)) : [...snapshot.tasks, normalizedTask]);
    setDialog({ open: false, day: normalizedTask.dayOfWeek, task: null });
  }

  function toggleTask(taskId: string) {
    setTasks(
      snapshot.tasks.map((task) =>
        task.id === taskId ? { ...task, completed: !task.completed, updatedAt: Date.now() } : task
      )
    );
  }

  function deleteTask(task: Task) {
    if (!window.confirm(`Delete "${task.title}"?`)) return;
    const softDelete = shouldSoftDeleteTask(task);
    const deletedTasks = softDelete
      ? snapshot.tasks.map((item) =>
          item.id === task.id
            ? {
                ...item,
                deleted: true,
                completed: item.source === "staff" || item.id.startsWith("staff-") ? true : item.completed,
                updatedAt: Date.now(),
              }
            : item
        )
      : snapshot.tasks.filter((item) => item.id !== task.id);
    setTasks(deletedTasks);
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
    setTasks([...snapshot.tasks, clone]);
    setWeekId(nextWeekId);
  }

  function changeDailyNote(key: string, value: string) {
    setSnapshot((current) => {
      const dailyEvents: DailyEvents = { ...current.dailyEvents };
      if (value.trim()) dailyEvents[key] = value;
      else delete dailyEvents[key];
      return { ...current, dailyEvents: sanitizeDailyEvents(dailyEvents) };
    });
  }

  function transferTasks(tasks: Task[]) {
    if (!tasks.length) return;
    setTasks([
      ...snapshot.tasks,
      ...tasks.map((task) => ({
        ...task,
        specificDate: dateKeyForWeekDay(weekId, task.dayOfWeek),
        specificDateWasExplicit: false,
        isGeneralReminder: false,
      })),
    ]);
  }

  function resetLocalData() {
    if (!window.confirm("Clear this browser's cached app data? Google Sheets will not be changed.")) return;
    const next = weekIdFromDate(new Date());
    setWeekId(next);
    setSnapshot({
      tasks: [],
      categories: seedCategories,
      bills: [],
      staff: [],
      dailyEvents: {},
      staffDailyEvents: {},
    });
  }

  const pullSheets = useCallback(async (silent = false) => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setSyncBusy(true);
    if (!silent) setSyncStatus("Refreshing from Google Sheets...");
    try {
      const pulledSnapshot = await pullAppsScriptSnapshot(SHEET_SYNC_CONFIG, snapshot);
      const nextSnapshot = { ...pulledSnapshot, tasks: normalizeTasksForWeek(pulledSnapshot.tasks, weekId) };
      const snapshotJson = JSON.stringify(nextSnapshot);
      const needsSheetRepair = nextSnapshot.tasks.some((task) => task.needsSheetRepair);
      remoteSnapshotJsonRef.current = needsSheetRepair ? "" : snapshotJson;
      lastSavedSnapshotJsonRef.current = needsSheetRepair ? "" : snapshotJson;
      syncReadyRef.current = true;
      setSnapshot(nextSnapshot);
      setSyncStatus(needsSheetRepair ? "Sheets refreshed; cleanup queued." : silent ? "Autosync refreshed from Sheets." : "Sheets refreshed.");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "Autosync refresh failed.");
    } finally {
      syncInFlightRef.current = false;
      setSyncBusy(false);
    }
  }, [snapshot]);

  const autoSaveSnapshot = useCallback(async (snapshotToSave: OperationsSnapshot, snapshotJson: string) => {
    if (syncInFlightRef.current) {
      autoSaveTimerRef.current = window.setTimeout(() => autoSaveSnapshot(snapshotToSave, snapshotJson), AUTO_SAVE_MS);
      return;
    }

    syncInFlightRef.current = true;
    setSyncBusy(true);
    setSyncStatus("Autosaving to Sheets...");
    try {
      const snapshotForSave = { ...snapshotToSave, tasks: normalizeTasksForWeek(snapshotToSave.tasks, weekId) };
      const normalizedSnapshotJson = JSON.stringify(snapshotForSave);
      const scheduledTasksForWeek = snapshotForSave.tasks.filter(
        (task) => task.weekId === weekId && !task.deleted && !task.isGeneralReminder && Boolean(task.specificDate)
      );
      const staffTodos = snapshotForSave.tasks.filter((task) => task.source === "staff" || task.id.startsWith("staff-"));
      await pushAppsScriptOperations(SHEET_SYNC_CONFIG, snapshotForSave);
      await pushAppsScriptStaffTodos(SHEET_SYNC_CONFIG, staffTodos);
      await pushAppsScriptStaffSchedule(SHEET_SYNC_CONFIG, weekId, scheduledTasksForWeek, snapshotForSave.staff);
      lastSavedSnapshotJsonRef.current = normalizedSnapshotJson;
      setSyncStatus("Autosaved to Sheets.");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "Autosave failed.");
    } finally {
      autoSaveTimerRef.current = null;
      syncInFlightRef.current = false;
      setSyncBusy(false);
    }
  }, [weekId]);

  useEffect(() => {
    if (autoPullStartedRef.current) return;
    autoPullStartedRef.current = true;
    void pullSheets();
  }, [pullSheets]);

  useEffect(() => {
    setSnapshot((current) => {
      const tasks = normalizeTasksForWeek(current.tasks, weekId);
      if (sameTasks(tasks, current.tasks)) return current;
      return { ...current, tasks };
    });
  }, [weekId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible" || autoSaveTimerRef.current) return;
      void pullSheets(true);
    }, AUTO_PULL_MS);
    return () => window.clearInterval(interval);
  }, [pullSheets]);

  useEffect(() => {
    const snapshotJson = JSON.stringify(snapshot);
    if (remoteSnapshotJsonRef.current === snapshotJson) {
      remoteSnapshotJsonRef.current = "";
      return;
    }
    if (!syncReadyRef.current || lastSavedSnapshotJsonRef.current === snapshotJson) return;

    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    setSyncStatus("Autosave queued...");
    autoSaveTimerRef.current = window.setTimeout(() => {
      void autoSaveSnapshot(snapshot, snapshotJson);
    }, AUTO_SAVE_MS);
  }, [autoSaveSnapshot, snapshot]);

  useEffect(
    () => () => {
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
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
              <h1 className="text-2xl font-semibold text-ink sm:text-3xl">Distillery Schedule & Operations Desk</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#7E613F]">
                Weekly tasks, daily notes, staff shifts, bills, carryover, and Google Sheets sync in one operations desk.
              </p>
            </div>
            <div className="header-actions">
              <button className="btn-header" type="button" onClick={resetLocalData} disabled={syncBusy}>
                <RotateCcw size={17} />
                Clear App Cache
              </button>
            </div>
          </div>
          {syncStatus ? <p className="header-sync-status">{syncStatus}</p> : null}

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

      <main className="mx-auto grid max-w-[1500px] gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <section className="ops-overview" aria-label="Week summary">
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

        <GeneralRemindersPanel
          tasks={generalReminderTasks}
          categories={snapshot.categories}
          onAddReminder={() => setDialog({ open: true, day: 1, task: null, generalReminder: true })}
          onToggleTask={toggleTask}
          onEditTask={(task) => setDialog({ open: true, day: task.dayOfWeek, task })}
        />

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
            onWeekChange={setWeekId}
            onAddTask={(day) => setDialog({ open: true, day, task: null })}
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
            onAddTask={(task) => setTasks([...snapshot.tasks, task])}
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

        {activeView === "transfer" ? <TransferPanel weekId={weekId} tasks={openScheduledTasks} onTransfer={transferTasks} /> : null}

        {activeView === "completed" ? (
          <CompletedTasksView
            tasks={snapshot.tasks}
            categories={snapshot.categories}
            onToggleTask={toggleTask}
            onEditTask={(task) => setDialog({ open: true, day: task.dayOfWeek, task })}
          />
        ) : null}

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
