import { CalendarCheck, Plus } from "lucide-react";
import { useMemo } from "react";
import type { CategoryOption, DailyEvents, StaffMember, Task } from "../types";
import { compareTasksByPriority, DAY_NAMES, dateKeyForWeekDay, formatLongDate, formatShortDate } from "../utils";
import { categoryLabel, categoryTone, priorityLabel, priorityTone } from "../lib/ui";

type DailyAgendaViewProps = {
  weekId: string;
  tasks: Task[];
  categories: CategoryOption[];
  staff: StaffMember[];
  dailyEvents: DailyEvents;
  onDailyNoteChange: (key: string, value: string) => void;
  onAddTask: (dayOfWeek: number) => void;
  onToggleTask: (taskId: string) => void;
  onEditTask: (task: Task) => void;
};

export function DailyAgendaView({
  weekId,
  tasks,
  categories,
  dailyEvents,
  onDailyNoteChange,
  onAddTask,
  onToggleTask,
  onEditTask,
}: DailyAgendaViewProps) {
  const weekDays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => ({
        dayOfWeek: index + 1,
        dateKey: dateKeyForWeekDay(weekId, index + 1),
        label: DAY_NAMES[index],
      })),
    [weekId]
  );
  const tasksByDay = useMemo(() => {
    const groups = new Map<number, Task[]>();

    tasks
      .filter((task) => task.weekId === weekId && !task.deleted && !task.isGeneralReminder && Boolean(task.specificDate))
      .slice()
      .sort((a, b) => {
        if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
        return compareTasksByPriority(a, b);
      })
      .forEach((task) => {
        groups.set(task.dayOfWeek, [...(groups.get(task.dayOfWeek) || []), task]);
      });

    return groups;
  }, [tasks, weekId]);
  const weekTaskCount = useMemo(() => Array.from(tasksByDay.values()).reduce((total, dayTasks) => total + dayTasks.length, 0), [tasksByDay]);

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="eyebrow">Agenda</p>
          <h2 className="page-title">Week of {formatShortDate(weekId)}</h2>
        </div>
        <span className="stat-pill">{weekTaskCount} scheduled tasks</span>
      </div>

      <div className="agenda-week-stack mt-5 grid gap-4">
        {weekDays.map((day) => {
          const dayTasks = tasksByDay.get(day.dayOfWeek) || [];
          const note = dailyEvents[day.dateKey] || "";

          return (
            <section key={day.dateKey} className="agenda-day-section">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-base font-semibold text-slate-950">{day.label}</h3>
                  <p className="text-sm text-slate-500">{formatLongDate(day.dateKey)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="stat-pill">{dayTasks.length} tasks</span>
                  <button className="btn-primary" type="button" onClick={() => onAddTask(day.dayOfWeek)}>
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
