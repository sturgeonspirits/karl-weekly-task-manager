import { Bell, Pencil, Plus } from "lucide-react";
import { useMemo } from "react";
import type { CategoryOption, Task } from "../types";
import { compareTasksByPriority } from "../utils";
import { categoryTone, priorityLabel, priorityTone } from "../lib/ui";

type GeneralRemindersPanelProps = {
  tasks: Task[];
  categories: CategoryOption[];
  onAddReminder: () => void;
  onToggleTask: (taskId: string) => void;
  onEditTask: (task: Task) => void;
};

export function GeneralRemindersPanel({ tasks, categories, onAddReminder, onToggleTask, onEditTask }: GeneralRemindersPanelProps) {
  const reminders = useMemo(() => {
    return tasks
      .filter((task) => task.source !== "staff" && task.isGeneralReminder && !task.deleted)
      .slice()
      .sort(compareTasksByPriority);
  }, [tasks]);

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="eyebrow">General reminders</p>
          <h2 className="page-title">Karl's undated task reminders</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="stat-pill">
            <Bell size={15} />
            {reminders.length} open
          </span>
          <button className="btn-secondary" type="button" onClick={onAddReminder}>
            <Plus size={17} />
            Add Reminder
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {reminders.map((task) => (
          <article key={task.id} className={`reminder-card ${task.completed ? "task-card-complete" : ""}`}>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-slate-300"
              checked={task.completed}
              aria-label={`Mark ${task.title} complete`}
              onChange={() => onToggleTask(task.id)}
            />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold leading-snug text-slate-950">{task.title}</h3>
              {task.description ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{task.description}</p> : null}
              {task.reminderDate ? <p className="mt-1 text-xs font-semibold text-[#96321F]">Reminder: {task.reminderDate}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <span className={`badge ${priorityTone(task.priority)}`}>{priorityLabel(task.priority)}</span>
                <span className={`badge ${categoryTone(task.category, categories)}`}>{task.category}</span>
              </div>
            </div>
            <button className="icon-button justify-self-end" type="button" aria-label={`Edit ${task.title}`} onClick={() => onEditTask(task)}>
              <Pencil size={15} />
            </button>
          </article>
        ))}

        {!reminders.length ? (
          <div className="empty-state md:col-span-2 xl:col-span-3">
            <Bell size={20} />
            <span>No undated private task reminders loaded.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
