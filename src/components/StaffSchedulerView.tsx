import { Radio, Save, Send, Trash2, UsersRound } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { StaffMember, Task } from "../types";
import { DAY_NAMES, dateKeyForWeekDay, makeId } from "../utils";
import { staffDot } from "../lib/ui";

type StaffSchedulerViewProps = {
  weekId: string;
  tasks: Task[];
  staff: StaffMember[];
  syncBusy: boolean;
  onSaveStaff: (staff: StaffMember[]) => void;
  onEditTask: (task: Task) => void;
  onToggleTask: (taskId: string) => void;
  onPushStaffSchedule: () => void;
};

type StaffForm = {
  name: string;
  role: string;
  email: string;
  phone: string;
  color: string;
};

const colorOptions = ["emerald", "amber", "sky", "violet", "rose", "slate"];

export function StaffSchedulerView({
  weekId,
  tasks,
  staff,
  syncBusy,
  onSaveStaff,
  onEditTask,
  onToggleTask,
  onPushStaffSchedule,
}: StaffSchedulerViewProps) {
  const [form, setForm] = useState<StaffForm>({ name: "", role: "", email: "", phone: "", color: "emerald" });

  const grouped = useMemo(() => {
    const groups = new Map<string, Task[]>();
    tasks
      .filter((task) => task.weekId === weekId && !task.deleted)
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

  const staffByName = useMemo(() => new Map(staff.map((person) => [person.name, person])), [staff]);

  function update<K extends keyof StaffForm>(key: K, value: StaffForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    const existing = staff.find((person) => person.name.toLowerCase() === name.toLowerCase());
    const saved: StaffMember = {
      id: existing?.id || makeId("staff"),
      name,
      role: form.role.trim() || "Staff",
      email: form.email.trim() || undefined,
      phone: form.phone.trim() || undefined,
      color: form.color,
    };
    onSaveStaff(existing ? staff.map((person) => (person.id === existing.id ? saved : person)) : [...staff, saved]);
    setForm({ name: "", role: "", email: "", phone: "", color: "emerald" });
  }

  function removeStaff(id: string) {
    onSaveStaff(staff.filter((person) => person.id !== id));
  }

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="eyebrow">Staff scheduler</p>
          <h2 className="page-title">Shift plan by assignee</h2>
        </div>
        <button className="btn-primary" type="button" onClick={onPushStaffSchedule} disabled={syncBusy}>
          <Send size={17} />
          Push Public Schedule
        </button>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid gap-3">
          {grouped.map(([assignee, assigneeTasks]) => {
            const person = staffByName.get(assignee);
            return (
              <section key={assignee} className="staff-lane">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className={`h-3 w-3 rounded-full ${staffDot(person?.color)}`} />
                    <div>
                      <h3 className="font-semibold text-slate-950">{assignee}</h3>
                      <p className="text-sm text-slate-500">{person?.role || "No role assigned"}</p>
                    </div>
                  </div>
                  <span className="stat-pill">
                    <UsersRound size={15} />
                    {assigneeTasks.length} shifts
                  </span>
                </div>

                <div className="mt-4 grid gap-2">
                  {assigneeTasks
                    .slice()
                    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
                    .map((task) => (
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
                            {DAY_NAMES[task.dayOfWeek - 1]} · {dateKeyForWeekDay(weekId, task.dayOfWeek)}
                            {task.shiftHours ? ` · ${task.shiftHours}` : ""}
                          </p>
                        </div>
                        <button className="btn-secondary justify-self-end" type="button" onClick={() => onEditTask(task)}>
                          Edit
                        </button>
                      </article>
                    ))}
                </div>
              </section>
            );
          })}

          {!grouped.length ? (
            <div className="empty-state">
              <Radio size={20} />
              <span>No scheduled shifts this week.</span>
            </div>
          ) : null}
        </div>

        <aside className="side-panel">
          <h3 className="text-sm font-semibold text-slate-950">Staff roster</h3>
          <form className="mt-4 grid gap-3" onSubmit={submit}>
            <label className="field-label">
              <span>Name</span>
              <input value={form.name} onChange={(event) => update("name", event.target.value)} />
            </label>
            <label className="field-label">
              <span>Role</span>
              <input value={form.role} onChange={(event) => update("role", event.target.value)} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <label className="field-label">
                <span>Email</span>
                <input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} />
              </label>
              <label className="field-label">
                <span>Phone</span>
                <input value={form.phone} onChange={(event) => update("phone", event.target.value)} />
              </label>
            </div>
            <label className="field-label">
              <span>Color</span>
              <select value={form.color} onChange={(event) => update("color", event.target.value)}>
                {colorOptions.map((color) => (
                  <option key={color} value={color}>
                    {color}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn-primary" type="submit">
              <Save size={17} />
              Save Staff
            </button>
          </form>

          <div className="mt-5 grid gap-2">
            {staff.map((person) => (
              <div key={person.id} className="roster-row">
                <span className={`h-2.5 w-2.5 rounded-full ${staffDot(person.color)}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-950">{person.name}</p>
                  <p className="truncate text-xs text-slate-500">{person.role}</p>
                </div>
                <button className="icon-button" type="button" aria-label={`Remove ${person.name}`} onClick={() => removeStaff(person.id)}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
