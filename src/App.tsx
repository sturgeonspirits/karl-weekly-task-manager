import { ArrowRightLeft, BadgeDollarSign, CalendarDays, LayoutGrid, RotateCcw, Sheet, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BillsView } from "./components/BillsView";
import { DailyAgendaView } from "./components/DailyAgendaView";
import { GeneralRemindersPanel } from "./components/GeneralRemindersPanel";
import { SheetsSyncPanel } from "./components/SheetsSyncPanel";
import { StaffSchedulerView } from "./components/StaffSchedulerView";
import { TaskDialog } from "./components/TaskDialog";
import { TransferPanel } from "./components/TransferPanel";
import { WeeklyGrid } from "./components/WeeklyGrid";
import { seedCategories } from "./data/seedData";
import {
  DEFAULT_PRIVATE_SHEET_ID,
  DEFAULT_STAFF_TODOS_SHEET_ID,
  extractSpreadsheetId,
  pullOperationsSnapshot,
  pullStaffSchedulingSnapshot,
  pushOperationsSnapshot,
  pushStaffSchedule,
  requestSheetsAccessToken,
} from "./lib/sheetsService";
import type { Bill, CategoryOption, DailyEvents, OperationsSnapshot, StaffMember, Task } from "./types";
import { addDays, dateFromKey, dateKeyForWeekDay, deduplicateTasks, sanitizeDailyEvents, sanitizeTasks, toLocalDateKey, weekIdFromDate } from "./utils";

const STORAGE_KEY = "karl-weekly-task-manager-v2";
const CONFIG_KEY = "karl-weekly-task-manager-config-v2";

type ActiveView = "weekly" | "daily" | "staff" | "bills" | "transfer" | "sync";
type DialogState = { open: boolean; day: number; task?: Task | null; generalReminder?: boolean };
type SyncConfig = {
  privateSheetId: string;
  staffTodosSheetId: string;
  publicStaffSheetId: string;
  clientId: string;
};

const navItems: Array<{ id: ActiveView; label: string; icon: typeof LayoutGrid }> = [
  { id: "weekly", label: "Weekly", icon: LayoutGrid },
  { id: "daily", label: "Agenda", icon: CalendarDays },
  { id: "staff", label: "Staff", icon: UsersRound },
  { id: "bills", label: "Bills", icon: BadgeDollarSign },
  { id: "transfer", label: "Transfer", icon: ArrowRightLeft },
  { id: "sync", label: "Sync", icon: Sheet },
];

function loadSnapshot(weekId: string): OperationsSnapshot {
  const fallback: OperationsSnapshot = {
    tasks: [],
    categories: seedCategories,
    bills: [],
    staff: [],
    dailyEvents: {},
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<OperationsSnapshot>;
    return {
      tasks: deduplicateTasks(sanitizeTasks(parsed.tasks || fallback.tasks)),
      categories: parsed.categories?.length ? parsed.categories : fallback.categories,
      bills: parsed.bills?.length ? parsed.bills : fallback.bills,
      staff: parsed.staff?.length ? parsed.staff : fallback.staff,
      dailyEvents: sanitizeDailyEvents(parsed.dailyEvents || fallback.dailyEvents),
    };
  } catch {
    return fallback;
  }
}

function loadConfig(): SyncConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") as Partial<SyncConfig>;
    return {
      privateSheetId: parsed.privateSheetId || DEFAULT_PRIVATE_SHEET_ID,
      staffTodosSheetId: parsed.staffTodosSheetId || DEFAULT_STAFF_TODOS_SHEET_ID,
      publicStaffSheetId: parsed.publicStaffSheetId || "",
      clientId: parsed.clientId || "",
    };
  } catch {
    return {
      privateSheetId: DEFAULT_PRIVATE_SHEET_ID,
      staffTodosSheetId: DEFAULT_STAFF_TODOS_SHEET_ID,
      publicStaffSheetId: "",
      clientId: "",
    };
  }
}

function mergeDailyEvents(...eventSets: DailyEvents[]): DailyEvents {
  const merged: DailyEvents = {};
  eventSets.forEach((events) => {
    Object.entries(events).forEach(([key, value]) => {
      const lines = String(value)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const current = new Set((merged[key] || "").split("\n").filter(Boolean));
      lines.forEach((line) => current.add(line));
      merged[key] = Array.from(current).join("\n");
    });
  });
  return sanitizeDailyEvents(merged);
}

function mergeStaff(primary: StaffMember[], secondary: StaffMember[]): StaffMember[] {
  const byKey = new Map<string, StaffMember>();
  [...primary, ...secondary].forEach((person) => {
    const key = (person.email || person.name).toLowerCase();
    if (!byKey.has(key)) byKey.set(key, person);
  });
  return Array.from(byKey.values());
}

export default function App() {
  const [weekId, setWeekId] = useState(() => weekIdFromDate(new Date()));
  const [activeView, setActiveView] = useState<ActiveView>("weekly");
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dialog, setDialog] = useState<DialogState>({ open: false, day: 1, task: null });
  const [snapshot, setSnapshot] = useState<OperationsSnapshot>(() => loadSnapshot(weekId));
  const [syncConfig, setSyncConfig] = useState<SyncConfig>(() => loadConfig());
  const [accessToken, setAccessToken] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }, [snapshot]);

  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(syncConfig));
  }, [syncConfig]);

  const scheduledTasks = useMemo(
    () => snapshot.tasks.filter((task) => !task.deleted && !task.isGeneralReminder && Boolean(task.specificDate)),
    [snapshot.tasks]
  );
  const activeWeekTasks = useMemo(
    () => scheduledTasks.filter((task) => task.weekId === weekId),
    [scheduledTasks, weekId]
  );
  const generalReminderTasks = useMemo(
    () => snapshot.tasks.filter((task) => task.source !== "staff" && task.isGeneralReminder && !task.deleted),
    [snapshot.tasks]
  );
  const staffSchedulerTasks = useMemo(
    () => snapshot.tasks.filter((task) => task.source === "staff" || task.id.startsWith("staff-")),
    [snapshot.tasks]
  );

  const completed = activeWeekTasks.filter((task) => task.completed).length;
  const highPriority = activeWeekTasks.filter((task) => !task.completed && task.priority === "high").length;
  const assigned = activeWeekTasks.filter((task) => task.assignee).length;
  const outstandingBills = snapshot.bills.filter((bill) => !bill.paid).reduce((sum, bill) => sum + bill.amount, 0);

  function setTasks(tasks: Task[]) {
    setSnapshot((current) => ({ ...current, tasks: deduplicateTasks(sanitizeTasks(tasks)) }));
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

  function cloneTaskToNextWeek(task: Task) {
    const nextWeekId = toLocalDateKey(addDays(dateFromKey(task.weekId), 7));
    const clone: Task = {
      ...task,
      id: `task-${nextWeekId}-${task.dayOfWeek}-${Date.now()}`,
      weekId: nextWeekId,
      completed: false,
      originTaskId: task.originTaskId || task.id,
      specificDate: dateKeyForWeekDay(nextWeekId, task.dayOfWeek),
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
    });
  }

  async function connectSheets() {
    setSyncBusy(true);
    setSyncStatus("Opening Google sign-in...");
    try {
      const token = await requestSheetsAccessToken(syncConfig.clientId);
      setAccessToken(token);
      setSyncStatus("Connected to Google Sheets.");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "Could not connect to Google Sheets.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function pullSheets() {
    if (!accessToken) return;
    setSyncBusy(true);
    setSyncStatus("Pulling private task workbook and staff todos...");
    try {
      const privateSnapshot = await pullOperationsSnapshot(extractSpreadsheetId(syncConfig.privateSheetId), accessToken, snapshot);
      const staffSnapshot = syncConfig.staffTodosSheetId.trim()
        ? await pullStaffSchedulingSnapshot(extractSpreadsheetId(syncConfig.staffTodosSheetId), accessToken)
        : { tasks: [], dailyEvents: {}, staff: [] };

      setSnapshot({
        ...privateSnapshot,
        tasks: deduplicateTasks(sanitizeTasks([...privateSnapshot.tasks, ...staffSnapshot.tasks])),
        dailyEvents: mergeDailyEvents(privateSnapshot.dailyEvents, staffSnapshot.dailyEvents),
        staff: mergeStaff(privateSnapshot.staff, staffSnapshot.staff),
      });
      setSyncStatus("Imported private tasks, staff/general todos, events, daily notes, categories, bills, and staff.");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function pushSheets() {
    if (!accessToken) return;
    setSyncBusy(true);
    setSyncStatus("Pushing local operations data...");
    try {
      await pushOperationsSnapshot(extractSpreadsheetId(syncConfig.privateSheetId), accessToken, snapshot);
      setSyncStatus("Private schedule workbook was overwritten with local data.");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "Push failed.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function pushStaff() {
    if (!accessToken) {
      setSyncStatus("Connect to Google Sheets first.");
      setActiveView("sync");
      return;
    }
    if (!syncConfig.publicStaffSheetId.trim()) {
      setSyncStatus("Add a public staff sheet ID in Sheets settings.");
      setActiveView("sync");
      return;
    }
    setSyncBusy(true);
    setSyncStatus("Publishing staff schedule...");
    try {
      await pushStaffSchedule(extractSpreadsheetId(syncConfig.publicStaffSheetId), accessToken, weekId, scheduledTasks, snapshot.staff);
      setSyncStatus("Public staff schedule was updated.");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "Staff schedule push failed.");
    } finally {
      setSyncBusy(false);
    }
  }

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
            <button className="btn-header" type="button" onClick={resetLocalData}>
              <RotateCcw size={17} />
              Clear App Cache
            </button>
          </div>

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
            tasks={scheduledTasks}
            categories={snapshot.categories}
            staff={snapshot.staff}
            dailyEvents={snapshot.dailyEvents}
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
            tasks={scheduledTasks}
            categories={snapshot.categories}
            staff={snapshot.staff}
            dailyEvents={snapshot.dailyEvents}
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
            syncBusy={syncBusy}
            onEditTask={(task) => setDialog({ open: true, day: task.dayOfWeek, task })}
            onToggleTask={toggleTask}
            onPushStaffSchedule={pushStaff}
          />
        ) : null}

        {activeView === "bills" ? <BillsView bills={snapshot.bills} onSaveBills={setBills} /> : null}

        {activeView === "transfer" ? <TransferPanel weekId={weekId} tasks={scheduledTasks} onTransfer={transferTasks} /> : null}

        {activeView === "sync" ? (
          <SheetsSyncPanel
            privateSheetId={syncConfig.privateSheetId}
            staffTodosSheetId={syncConfig.staffTodosSheetId}
            publicStaffSheetId={syncConfig.publicStaffSheetId}
            clientId={syncConfig.clientId}
            connected={Boolean(accessToken)}
            busy={syncBusy}
            status={syncStatus}
            onPrivateSheetIdChange={(value) => setSyncConfig((current) => ({ ...current, privateSheetId: extractSpreadsheetId(value) }))}
            onStaffTodosSheetIdChange={(value) => setSyncConfig((current) => ({ ...current, staffTodosSheetId: extractSpreadsheetId(value) }))}
            onPublicStaffSheetIdChange={(value) => setSyncConfig((current) => ({ ...current, publicStaffSheetId: extractSpreadsheetId(value) }))}
            onClientIdChange={(value) => setSyncConfig((current) => ({ ...current, clientId: value }))}
            onConnect={connectSheets}
            onPull={pullSheets}
            onPush={pushSheets}
            onPushStaff={pushStaff}
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
      />
    </div>
  );
}
