import { ArrowRightLeft, CopyPlus } from "lucide-react";
import { useMemo } from "react";
import type { Task } from "../types";
import { addDays, dateFromKey, formatShortDate, makeId, toLocalDateKey } from "../utils";

type TransferPanelProps = {
  weekId: string;
  tasks: Task[];
  onTransfer: (tasks: Task[]) => void;
};

export function TransferPanel({ weekId, tasks, onTransfer }: TransferPanelProps) {
  const previousWeekId = toLocalDateKey(addDays(dateFromKey(weekId), -7));
  const existingKeys = useMemo(
    () => new Set(tasks.filter((task) => task.weekId === weekId).map((task) => `${task.originTaskId || task.id}|${task.dayOfWeek}`)),
    [tasks, weekId]
  );

  const candidates = useMemo(
    () =>
      tasks.filter((task) => {
        if (task.weekId !== previousWeekId || task.completed || task.deleted) return false;
        return !existingKeys.has(`${task.originTaskId || task.id}|${task.dayOfWeek}`);
      }),
    [existingKeys, previousWeekId, tasks]
  );

  function transferAll() {
    const transferred = candidates.map((task) => ({
      ...task,
      id: makeId("task"),
      weekId,
      completed: false,
      originTaskId: task.originTaskId || task.id,
      updatedAt: Date.now(),
    }));
    onTransfer(transferred);
  }

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="eyebrow">Transfer & carryover</p>
          <h2 className="page-title">Unfinished work from {formatShortDate(previousWeekId)}</h2>
        </div>
        <button className="btn-primary" type="button" onClick={transferAll} disabled={!candidates.length}>
          <CopyPlus size={17} />
          Transfer {candidates.length}
        </button>
      </div>

      <div className="mt-5 grid gap-3">
        {candidates.map((task) => (
          <article key={task.id} className="carryover-row">
            <ArrowRightLeft size={18} className="text-slate-400" />
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-slate-950">{task.title}</h3>
              <p className="text-xs text-slate-500">
                Day {task.dayOfWeek} · {task.category}
                {task.assignee ? ` · ${task.assignee}` : ""}
              </p>
            </div>
          </article>
        ))}

        {!candidates.length ? (
          <div className="empty-state">
            <ArrowRightLeft size={20} />
            <span>No unfinished tasks are waiting to transfer.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
