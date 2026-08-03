import { ClipboardList, UsersRound } from "lucide-react";
import { useMemo } from "react";
import type { StaffMember, Task } from "../types";
import { compareTasksByPriority, DAY_NAMES } from "../utils";
import { staffDot } from "../lib/ui";

type StaffSchedulerViewProps = {
  weekId: string;
  tasks: Task[];
  staff: StaffMember[];
  onEditTask: (task: Task) => void;
  onToggleTask: (taskId: string) => void;
};

export function StaffSchedulerView({
  weekId,
  tasks,
  staff,
  onEditTask,
  onToggleTask,
}: StaffSchedulerViewProps) {
  const grouped = useMemo(() => {
    const groups = new Map<string, Task[]>();
    tasks
      .filter((task) => !task.deleted && (task.weekId === weekId || !task.specificDate))
      .forEach((task) => {
        const key = task.assignee || "Unassigned";
        groups.set(key, [...(groups.get(key) || []), task]);
      });

    return Array.from(groups.entries()).sort(([nameA], [nameB]) => {
      if (nameA === "Unassigned") return 1;
      if (nameB === "Unassigned") return -1;
      return nameA.localeCompare(nameB);
    });
  }, [tasks, weekId]);

  const staffByName = useMemo(() => {
    const people = new Map<string, StaffMember>();
    staff.forEach((person) => {
      people.set(person.name.toLowerCase(), person);
      if (person.email) people.set(person.email.toLowerCase(), person);
    });
    return people;
  }, [staff]);

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="eyebrow">Staff scheduler</p>
          <h2 className="page-title">Staff scheduler todos</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Only rows imported from the Staff Scheduling workbook's Todos tab appear here.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-4">
        <div className="grid gap-3">
          {grouped.map(([assignee, assigneeTasks]) => {
            const person = staffByName.get(assignee.toLowerCase());
            return (
              <section key={assignee} className="staff-lane">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className={`h-3 w-3 rounded-full ${staffDot(person?.color)}`} />
                    <div>
                      <h3 className="font-semibold text-slate-950">{assignee}</h3>
                      <p className="text-sm text-slate-500">{person?.role || "Staff todo owner"}</p>
                    </div>
                  </div>
                  <span className="stat-pill">
                    <UsersRound size={15} />
                    {assigneeTasks.length} todos
                  </span>
                </div>

                <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {assigneeTasks
                    .slice()
                    .sort((a, b) => {
                      if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
                      return compareTasksByPriority(a, b);
                    })
                    .map((task) => {
                      const taskDateLabel = task.specificDate ? `${DAY_NAMES[task.dayOfWeek - 1]} · ${task.specificDate}` : "No date";
                      return (
                        <article key={task.id} className="shift-row">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300"
                            checked={task.completed}
                            aria-label={`Mark ${task.title} complete`}
                            onChange={() => onToggleTask(task.id)}
                          />
                          <div className="min-w-0">
                            <h4 className="text-sm font-semibold text-slate-950">{task.title}</h4>
                            <p className="text-xs text-slate-500">
                              {taskDateLabel}
                              {task.shiftHours ? ` · ${task.shiftHours}` : ""}
                            </p>
                            {task.description ? <p className="mt-1 text-xs leading-5 text-slate-600">{task.description}</p> : null}
                          </div>
                          <button className="btn-secondary justify-self-end" type="button" onClick={() => onEditTask(task)}>
                            Edit
                          </button>
                        </article>
                      );
                    })}
                </div>
              </section>
            );
          })}

          {!grouped.length ? (
            <div className="empty-state">
              <ClipboardList size={20} />
              <span>No staff scheduler todos this week.</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
