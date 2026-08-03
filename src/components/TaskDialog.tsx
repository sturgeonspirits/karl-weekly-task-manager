import { Save, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CategoryOption, Priority, StaffMember, Task } from "../types";
import { dateKeyForWeekDay, makeId } from "../utils";

type TaskDialogProps = {
  open: boolean;
  weekId: string;
  defaultDay: number;
  task?: Task | null;
  categories: CategoryOption[];
  staff: StaffMember[];
  onClose: () => void;
  onSave: (task: Task) => void;
};

type TaskForm = {
  title: string;
  description: string;
  dayOfWeek: number;
  category: string;
  priority: Priority;
  assignee: string;
  shiftHours: string;
  repeatsWeekly: boolean;
  repeatPattern: "weekly" | "biweekly" | "none";
};

function createForm(task: Task | null | undefined, weekId: string, defaultDay: number, categories: CategoryOption[]): TaskForm {
  return {
    title: task?.title || "",
    description: task?.description || "",
    dayOfWeek: task?.dayOfWeek || defaultDay,
    category: task?.category || categories[0]?.name || "Production",
    priority: task?.priority || "medium",
    assignee: task?.assignee || "",
    shiftHours: task?.shiftHours || "",
    repeatsWeekly: Boolean(task?.repeatsWeekly),
    repeatPattern: task?.repeatPattern || "none",
  };
}

export function TaskDialog({
  open,
  weekId,
  defaultDay,
  task,
  categories,
  staff,
  onClose,
  onSave,
}: TaskDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [form, setForm] = useState<TaskForm>(() => createForm(task, weekId, defaultDay, categories));

  useEffect(() => {
    if (open) {
      setForm(createForm(task, weekId, defaultDay, categories));
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  }, [categories, defaultDay, open, task, weekId]);

  const isEditing = Boolean(task);
  const dayOptions = useMemo(() => [1, 2, 3, 4, 5, 6, 7], []);

  function update<K extends keyof TaskForm>(key: K, value: TaskForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const title = form.title.trim();
    if (!title) return;

    onSave({
      id: task?.id || makeId("task"),
      title,
      description: form.description.trim(),
      dayOfWeek: form.dayOfWeek,
      completed: task?.completed || false,
      priority: form.priority,
      category: form.category,
      weekId: task?.weekId || weekId,
      repeatsWeekly: form.repeatsWeekly,
      repeatPattern: form.repeatsWeekly ? form.repeatPattern : "none",
      originTaskId: task?.originTaskId,
      deleted: task?.deleted,
      specificDate: dateKeyForWeekDay(task?.weekId || weekId, form.dayOfWeek),
      updatedAt: Date.now(),
      assignee: form.assignee.trim() || undefined,
      shiftHours: form.shiftHours.trim() || undefined,
    });
  }

  return (
    <dialog ref={dialogRef} className="modal" onCancel={onClose} onClose={onClose}>
      <form className="modal-panel" onSubmit={submit}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="eyebrow">{isEditing ? "Edit task" : "Add task"}</p>
            <h2 className="text-xl font-semibold text-slate-950">{isEditing ? task?.title : "New operations task"}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close task form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 grid gap-4">
          <label className="field-label">
            <span>Title</span>
            <input value={form.title} onChange={(event) => update("title", event.target.value)} required />
          </label>

          <label className="field-label">
            <span>Description</span>
            <textarea value={form.description} onChange={(event) => update("description", event.target.value)} />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field-label">
              <span>Day</span>
              <select value={form.dayOfWeek} onChange={(event) => update("dayOfWeek", Number(event.target.value))}>
                {dayOptions.map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            </label>

            <label className="field-label">
              <span>Category</span>
              <select value={form.category} onChange={(event) => update("category", event.target.value)}>
                {categories.map((category) => (
                  <option key={category.id} value={category.name}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="field-label">
              <span>Priority</span>
              <select value={form.priority} onChange={(event) => update("priority", event.target.value as Priority)}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>

            <label className="field-label">
              <span>Assignee</span>
              <select value={form.assignee} onChange={(event) => update("assignee", event.target.value)}>
                <option value="">Unassigned</option>
                {staff.map((person) => (
                  <option key={person.id} value={person.name}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field-label">
              <span>Shift hours</span>
              <input
                value={form.shiftHours}
                onChange={(event) => update("shiftHours", event.target.value)}
                placeholder="9:00 AM - 5:00 PM"
              />
            </label>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <label className="inline-flex items-center gap-3 text-sm font-semibold text-slate-800">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300"
                checked={form.repeatsWeekly}
                onChange={(event) => update("repeatsWeekly", event.target.checked)}
              />
              Repeats
            </label>
            <select
              className="mt-3"
              value={form.repeatPattern}
              disabled={!form.repeatsWeekly}
              onChange={(event) => update("repeatPattern", event.target.value as TaskForm["repeatPattern"])}
            >
              <option value="none">None</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
            </select>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            <Save size={17} />
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
