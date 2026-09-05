import { CalendarCheck, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useMemo } from "react";
import type { CategoryOption, DailyEvents, StaffMember, Task } from "../types";
import { addDays, compareTasksByPriority, dateFromKey, DAY_NAMES, formatLongDate, formatShortDate, rollingAgendaDays, todayStr, toLocalDateKey } from "../utils";

// Today plus the next seven days.
const AGENDA_DAY_COUNT = 8;
import { categoryLabel, categoryTone, priorityLabel, priorityTone } from "../lib/ui";

type DailyAgendaViewProps = {
  anchorDate: string;
  tasks: Task[];
  categories: CategoryOption[];
  staff: StaffMember[];
  dailyEvents: DailyEvents;
  onDailyNoteChange: (key: string, value: string) => void;
  onAnchorChange: (dateKey: string) => void;
  onAddTask: (dateKey: string) => void;
  onToggleTask: (taskId: string) => void;
  onEditTask: (task: Task) => void;
};

export function DailyAgendaView({
  anchorDate,
  tasks,
  categories,
  dailyEvents,
  onDailyNoteChange,
  onAnchorChange,
  onAddTask,
  onToggleTask,
  onEditTask,
}: DailyAgendaViewProps) {
  const todayKey = toLocalDateKey(new Date());
  const agendaDays = useMemo(() => {
    // Consecutive real dates from the anchor. Grouping by dayOfWeek within one weekId is what
    // made the old view wrap back to the start of the same week instead of moving forward.
    return rollingAgendaDays(anchorDate, AGENDA_DAY_COUNT).map((dateKey) => {
      const date = dateFromKey(dateKey);
      const jsDay = date.getDay();
      return {
        dateKey,
        dayOfWeek: jsDay === 0 ? 7 : jsDay,
        label: DAY_NAMES[(jsDay === 0 ? 7 : jsDay) - 1],
        isToday: dateKey === todayKey,
      };
    });
  }, [anchorDate, todayKey]);

  const tasksByDate = useMemo(() => {
    const groups = new Map<string, Task[]>();

    tasks
      .filter((task) => !task.deleted && !task.isGeneralReminder && Boolean(task.specificDate))
      .slice()
      .sort((a, b) => {
        // Date first, because the window spans more than one week now.
        if (a.specificDate !== b.specificDate) return (a.specificDate || "").localeCompare(b.specificDate || "");
        return compareTasksByPriority(a, b);
      })
      .forEach((task) => {
        const key = task.specificDate as string;
        groups.set(key, [...(groups.get(key) || []), task]);
      });

    return groups;
  }, [tasks]);

  const windowTaskCount = useMemo(
    () => agendaDays.reduce((total, day) => total + (tasksByDate.get(day.dateKey) || []).length, 0),
    [agendaDays, tasksByDate]
  );

  // Shift the window a whole week at a time; "Today" snaps it back to now.
  function moveWindow(offsetDays: number) {
    onAnchorChange(toLocalDateKey(addDays(dateFromKey(anchorDate), offsetDays)));
  }

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="eyebrow">Agenda</p>
          <h2 className="page-title">
            {formatShortDate(agendaDays[0]?.dateKey || anchorDate)} – {formatShortDate(agendaDays[agendaDays.length - 1]?.dateKey || anchorDate)}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" type="button" onClick={() => moveWindow(-7)}>
            <ChevronLeft size={17} />
            Previous
          </button>
          <button className="btn-secondary" type="button" onClick={() => onAnchorChange(todayStr())}>
            Today
          </button>
          <button className="btn-secondary" type="button" onClick={() => moveWindow(7)}>
            Next
            <ChevronRight size={17} />
          </button>
          <span className="stat-pill">{windowTaskCount} scheduled tasks</span>
        </div>
      </div>

      <div className="agenda-week-stack mt-5 grid gap-4">
        {agendaDays.map((day) => {
          const dayTasks = tasksByDate.get(day.dateKey) || [];
          const note = dailyEvents[day.dateKey] || "";

          return (
            <section key={day.dateKey} className="agenda-day-section">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-950">
                    {day.label}
                    {day.isToday ? <span className="badge border-slate-900 bg-slate-900 text-white">Today</span> : null}
                  </h3>
                  <p className="text-sm text-slate-500">{formatLongDate(day.dateKey)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="stat-pill">{dayTasks.length} tasks</span>
                  <button className="btn-primary" type="button" onClick={() => onAddTask(day.dateKey)}>
                    <Plus size={17} />
                    Add
                  </button>
                </div>
              </div>

              <div className="agenda-day-body mt-3">
                <label className="agenda-note-field">
                  <span className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold agenda-note-label">
                    <CalendarCheck size={17} />
                    Events note · {day.dateKey}
                    <span className="save-pill">Auto-saves to Sheets</span>
                  </span>
                  <input
                    className="agenda-note-input"
                    value={note}
                    onChange={(event) => onDailyNoteChange(day.dateKey, event.target.value)}
                    placeholder="Daily note or milestone"
                  />
                </label>

                <div className="agenda-task-list grid gap-3">
                  {dayTasks.map((task) => (
                    <article key={task.id} className="agenda-row agenda-row-clickable" onClick={() => onEditTask(task)}>
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-slate-300"
                        checked={task.completed}
                        aria-label={`Mark ${task.title} complete`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                        onChange={() => onToggleTask(task.id)}
                      />
                      <div className="min-w-0">
                        <h4 className={`font-semibold ${task.completed ? "text-slate-400 line-through" : "text-slate-950"}`}>{task.title}</h4>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className={`badge ${priorityTone(task.priority)}`}>{priorityLabel(task.priority)}</span>
                          <span className={`badge ${categoryTone(task.category, categories)}`}>{categoryLabel(task.category, categories)}</span>
                          {task.assignee ? <span className="badge border-slate-200 bg-white text-slate-700">{task.assignee}</span> : null}
                          {task.shiftHours ? <span className="badge border-slate-200 bg-white text-slate-700">{task.shiftHours}</span> : null}
                        </div>
                      </div>
                      <button
                        className="btn-secondary agenda-edit-button justify-self-end"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditTask(task);
                        }}
                      >
                        Edit
                      </button>
                    </article>
                  ))}

                  {!dayTasks.length ? (
                    <div className="empty-state">
                      <CalendarCheck size={20} />
                      <span>No tasks on this day.</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
