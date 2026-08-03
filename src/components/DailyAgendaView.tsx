import { CalendarCheck, Plus } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { CategoryOption, DailyEvents, StaffMember, Task } from "../types";
import { compareTasksByPriority, DAY_NAMES, dateKeyForWeekDay, formatLongDate, formatShortDate, makeId } from "../utils";
import { categoryTone, priorityLabel, priorityTone } from "../lib/ui";

type DailyAgendaViewProps = {
  weekId: string;
  tasks: Task[];
  categories: CategoryOption[];
  staff: StaffMember[];
  dailyEvents: DailyEvents;
  onDailyNoteChange: (key: string, value: string) => void;
  onAddTask: (task: Task) => void;
  onToggleTask: (taskId: string) => void;
  onEditTask: (task: Task) => void;
};

export function DailyAgendaView({
  weekId,
  tasks,
  categories,
  staff,
  dailyEvents,
  onDailyNoteChange,
  onAddTask,
  onToggleTask,
  onEditTask,
}: DailyAgendaViewProps) {
  const [quickTitles, setQuickTitles] = useState<Record<number, string>>({});
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

  function updateQuickTitle(dayOfWeek: number, title: string) {
    setQuickTitles((current) => ({ ...current, [dayOfWeek]: title }));
  }

  function submitQuickTask(event: FormEvent, dayOfWeek: number, dateKey: string) {
    event.preventDefault();
    const title = (quickTitles[dayOfWeek] || "").trim();
    if (!title) return;
    onAddTask({
      id: makeId("task"),
      title,
      dayOfWeek,
      completed: false,
      priority: "medium",
      category: categories[0]?.name || "Production",
      weekId,
      repeatPattern: "none",
      specificDate: dateKey,
      source: "private",
      isGeneralReminder: false,
      assignee: staff[0]?.name,
      shiftHours: "",
      updatedAt: Date.now(),
    });
    updateQuickTitle(dayOfWeek, "");
  }

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
                <span className="stat-pill">{dayTasks.length} tasks</span>
              </div>

              <label className="agenda-note-field mt-3">
                <span className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold agenda-note-label">
                  <CalendarCheck size={17} />
                  Events note · {day.dateKey}
                  <span className="save-pill">Auto-saves locally</span>
                </span>
                <input
                  className="agenda-note-input"
                  value={note}
                  onChange={(event) => onDailyNoteChange(day.dateKey, event.target.value)}
                  placeholder="Daily note or milestone"
                />
              </label>

              <form className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={(event) => submitQuickTask(event, day.dayOfWeek, day.dateKey)}>
                <label className="sr-only" htmlFor={`quick-task-${day.dayOfWeek}`}>
                  Add task for {day.label}
                </label>
                <input
                  id={`quick-task-${day.dayOfWeek}`}
                  value={quickTitles[day.dayOfWeek] || ""}
                  onChange={(event) => updateQuickTitle(day.dayOfWeek, event.target.value)}
                  placeholder={`Add task for ${day.label}`}
                />
                <button className="btn-primary" type="submit">
                  <Plus size={17} />
                  Add
                </button>
              </form>

              <div className="mt-3 grid gap-3">
                {dayTasks.map((task) => (
                  <article key={task.id} className="agenda-row">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300"
                      checked={task.completed}
                      aria-label={`Mark ${task.title} complete`}
                      onChange={() => onToggleTask(task.id)}
                    />
                    <div className="min-w-0">
                      <h4 className={`font-semibold ${task.completed ? "text-slate-400 line-through" : "text-slate-950"}`}>{task.title}</h4>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <span className={`badge ${priorityTone(task.priority)}`}>{priorityLabel(task.priority)}</span>
                        <span className={`badge ${categoryTone(task.category, categories)}`}>{task.category}</span>
                        {task.assignee ? <span className="badge border-slate-200 bg-white text-slate-700">{task.assignee}</span> : null}
                        {task.shiftHours ? <span className="badge border-slate-200 bg-white text-slate-700">{task.shiftHours}</span> : null}
                      </div>
                    </div>
                    <button className="btn-secondary justify-self-end" type="button" onClick={() => onEditTask(task)}>
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
            </section>
          );
        })}
      </div>
    </section>
  );
}
