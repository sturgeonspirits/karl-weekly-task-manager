import { Bell, Pencil } from "lucide-react";
import { useMemo } from "react";
import type { CategoryOption, Task } from "../types";
import { categoryTone, priorityLabel, priorityTone } from "../lib/ui";

type GeneralRemindersPanelProps = {
  tasks: Task[];
  categories: CategoryOption[];
  onToggleTask: (taskId: string) => void;
  onEditTask: (task: Task) => void;
};

export function GeneralRemindersPanel({ tasks, categories, onToggleTask, onEditTask }: GeneralRemindersPanelProps) {
  const reminders = useMemo(() => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return tasks
      .filter((task) => task.source !== "staff" && task.isGeneralReminder && !task.deleted)
      .slice()
      .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.title.localeCompare(b.title));
  }, [tasks]);

  if (!reminders.length) return null;

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="eyebrow">General reminders</p>
          <h2 className="page-title">Karl's undated task reminders</h2>
        </div>
        <span className="stat-pill">
          <Bell size={15} />
          {reminders.length} open
        </span>
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
      </div>
    </section>
  );
}
