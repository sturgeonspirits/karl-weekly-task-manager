import { ListOrdered } from "lucide-react";
import { useMemo } from "react";
import type { CategoryOption, Task } from "../types";
import { DO_FIRST_COUNT, rankTasks } from "../lib/ranking";
import { categoryLabel, categoryTone, priorityLabel, priorityTone } from "../lib/ui";

type DoFirstPanelProps = {
  tasks: Task[];
  categories: CategoryOption[];
  today: string;
  onToggleTask: (taskId: string) => void;
  onEditTask: (task: Task) => void;
};

/**
 * The most important open tasks, in order, at the very top of the page. Same ranking as the
 * "Do first" list in the morning brief (see lib/ranking.ts). Ticking one off moves the next up.
 */
export function DoFirstPanel({ tasks, categories, today, onToggleTask, onEditTask }: DoFirstPanelProps) {
  const { ranked, stale, total } = useMemo(() => rankTasks(tasks, today), [tasks, today]);
  if (!ranked.length) return null;

  return (
    <section className="content-surface" aria-label="Do first">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="eyebrow">
            <ListOrdered size={14} className="mr-1 inline" />
            Do first
          </p>
          <h2 className="page-title">Most important right now</h2>
        </div>
        <span className="stat-pill self-start sm:self-auto">
          Top {Math.min(DO_FIRST_COUNT, total)} of {total} open
        </span>
      </div>

      <ol className="do-first-list mt-4 grid gap-2">
        {ranked.map(({ task, why }, index) => (
          <li key={task.id} className="agenda-row agenda-row-clickable do-first-row" onClick={() => onEditTask(task)}>
            <span className="do-first-rank" aria-hidden="true">
              {index + 1}
            </span>
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
              <h4 className="font-semibold text-slate-950 break-words">{task.title}</h4>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`badge ${priorityTone(task.priority)}`}>{priorityLabel(task.priority)}</span>
                <span className="text-sm text-[#7E613F]">{why}</span>
                <span className={`badge ${categoryTone(task.category, categories)}`}>{categoryLabel(task.category, categories)}</span>
              </div>
            </div>
          </li>
        ))}
      </ol>

      {stale ? (
        <p className="mt-3 text-sm text-[#7E613F]">
          {stale} undated reminder{stale === 1 ? " has" : "s have"} waited more than 30 days and {stale === 1 ? "is" : "are"} left out of
          this list. Tick off or date the ones that still matter (General reminders, below).
        </p>
      ) : null}
    </section>
  );
}
