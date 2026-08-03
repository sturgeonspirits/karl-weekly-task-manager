import { CalendarCheck, Plus } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { CategoryOption, StaffMember, Task } from "../types";
import { dailyEventKey, DAY_LABELS, dateKeyForWeekDay, formatLongDate, makeId } from "../utils";
import { categoryTone, priorityLabel, priorityTone } from "../lib/ui";

type DailyAgendaViewProps = {
  weekId: string;
  selectedDay: number;
  tasks: Task[];
  categories: CategoryOption[];
  staff: StaffMember[];
  dailyNote: string;
  onSelectDay: (day: number) => void;
  onDailyNoteChange: (key: string, value: string) => void;
  onAddTask: (task: Task) => void;
  onToggleTask: (taskId: string) => void;
  onEditTask: (task: Task) => void;
};

export function DailyAgendaView({
  weekId,
  selectedDay,
  tasks,
  categories,
  staff,
  dailyNote,
  onSelectDay,
  onDailyNoteChange,
  onAddTask,
  onToggleTask,
  onEditTask,
}: DailyAgendaViewProps) {
  const [quickTitle, setQuickTitle] = useState("");
  const dateKey = dateKeyForWeekDay(weekId, selectedDay);
  const noteKey = dailyEventKey(weekId, selectedDay);
  const dayTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.weekId === weekId && task.dayOfWeek === selectedDay && !task.deleted && !task.isGeneralReminder && Boolean(task.specificDate))
        .sort((a, b) => Number(a.completed) - Number(b.completed) || a.title.localeCompare(b.title)),
    [selectedDay, tasks, weekId]
  );

  function submitQuickTask(event: FormEvent) {
    event.preventDefault();
    const title = quickTitle.trim();
    if (!title) return;
    onAddTask({
      id: makeId("task"),
      title,
      dayOfWeek: selectedDay,
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
    setQuickTitle("");
  }

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="eyebrow">Daily agenda</p>
          <h2 className="page-title">{formatLongDate(dateKey)}</h2>
        </div>
        <div className="segmented-days" role="tablist" aria-label="Daily agenda day">
          {DAY_LABELS.map((label, index) => (
            <button
              key={label}
              className={selectedDay === index + 1 ? "active" : ""}
              type="button"
              onClick={() => onSelectDay(index + 1)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <label className="mt-5 block rounded-lg border border-amber-200 bg-amber-50 p-4">
        <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900">
          <CalendarCheck size={17} />
          Events note · {dateKey}
        </span>
        <textarea
          className="border-amber-200 bg-white/80"
          value={dailyNote}
          onChange={(event) => onDailyNoteChange(noteKey, event.target.value)}
          placeholder="Daily note or milestone"
        />
      </label>

      <form className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={submitQuickTask}>
        <label className="sr-only" htmlFor="quick-task-title">
          Add task
        </label>
        <input
          id="quick-task-title"
          value={quickTitle}
          onChange={(event) => setQuickTitle(event.target.value)}
          placeholder="Add a task to this day"
        />
        <button className="btn-primary" type="submit">
          <Plus size={17} />
          Add
        </button>
      </form>

      <div className="mt-5 grid gap-3">
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
              <h3 className={`font-semibold ${task.completed ? "text-slate-400 line-through" : "text-slate-950"}`}>{task.title}</h3>
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
}
