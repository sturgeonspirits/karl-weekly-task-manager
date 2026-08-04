import { CheckCircle2, Pencil, RotateCcw } from "lucide-react";
import { useMemo } from "react";
import type { CategoryOption, Task } from "../types";
import { compareTasksByPriority, formatLongDate } from "../utils";
import { categoryLabel, categoryTone, priorityLabel, priorityTone } from "../lib/ui";

type CompletedTasksViewProps = {
  tasks: Task[];
  categories: CategoryOption[];
  onToggleTask: (taskId: string) => void;
  onEditTask: (task: Task) => void;
};

function taskDateLabel(task: Task): string {
  if (task.specificDate) return formatLongDate(task.specificDate);
  if (task.reminderDate) return `Reminder ${task.reminderDate}`;
  return "No date";
}

export function CompletedTasksView({ tasks, categories, onToggleTask, onEditTask }: CompletedTasksViewProps) {
  const completedTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.completed && !task.deleted)
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || compareTasksByPriority(a, b)),
    [tasks]
  );

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="eyebrow">Completed</p>
          <h2 className="page-title">Completed tasks</h2>
        </div>
        <span className="stat-pill">
          <CheckCircle2 size={15} />
          {completedTasks.length} done
        </span>
      </div>

      <div className="mt-5 grid gap-3">
        {completedTasks.map((task) => (
          <article key={task.id} className="agenda-row">
            <CheckCircle2 className="mt-1 text-emerald-700" size={18} />
            <div className="min-w-0">
              <h3 className="font-semibold text-slate-950">{task.title}</h3>
              <p className="mt-1 text-xs text-slate-500">
                {taskDateLabel(task)}
                {task.source === "staff" ? " · Staff scheduler" : " · Karl tasks"}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className={`badge ${priorityTone(task.priority)}`}>{priorityLabel(task.priority)}</span>
                <span className={`badge ${categoryTone(task.category, categories)}`}>{categoryLabel(task.category, categories)}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" type="button" onClick={() => onToggleTask(task.id)}>
                <RotateCcw size={15} />
                Move Back
              </button>
              <button className="icon-button" type="button" aria-label={`Edit ${task.title}`} onClick={() => onEditTask(task)}>
                <Pencil size={15} />
              </button>
            </div>
          </article>
        ))}

        {!completedTasks.length ? (
          <div className="empty-state">
            <CheckCircle2 size={20} />
            <span>No completed tasks yet.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
