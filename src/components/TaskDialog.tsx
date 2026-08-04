import { Save, Trash2, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import type { CategoryOption, Priority, RepeatPattern, StaffMember, Task } from "../types";
import { dateFromKey, dateKeyForWeekDay, isIsoDateKey, makeId, weekIdFromDate } from "../utils";
import { categoryValue, isKarlAssignee, KARL_ASSIGNEE } from "../lib/ui";

type TaskDialogProps = {
  open: boolean;
  weekId: string;
  defaultDay: number;
  defaultGeneralReminder?: boolean;
  task?: Task | null;
  categories: CategoryOption[];
  staff: StaffMember[];
  onClose: () => void;
  onSave: (task: Task) => void;
  onDelete?: (task: Task) => void;
};

type TaskForm = {
  title: string;
  description: string;
  dayOfWeek: number;
  category: string;
  priority: Priority;
  scheduledDate: string;
  assignee: string;
  shiftHours: string;
  repeatsWeekly: boolean;
  repeatPattern: RepeatPattern;
  isGeneralReminder: boolean;
};

function createForm(
  task: Task | null | undefined,
  weekId: string,
  defaultDay: number,
  categories: CategoryOption[],
  staff: StaffMember[],
  defaultGeneralReminder = false
): TaskForm {
  const isGeneralReminder = task?.source === "staff" ? false : Boolean(task?.isGeneralReminder || defaultGeneralReminder);
  const defaultAssignee = staff.some((person) => isKarlAssignee(person.name) || isKarlAssignee(person.email)) ? KARL_ASSIGNEE : KARL_ASSIGNEE;
  return {
    title: task?.title || "",
    description: task?.description || "",
    dayOfWeek: task?.dayOfWeek || defaultDay,
    category: categoryValue(task?.category, categories),
    priority: task?.priority || "medium",
    scheduledDate: isGeneralReminder ? "" : task?.specificDate || (task?.source === "staff" ? "" : dateKeyForWeekDay(task?.weekId || weekId, task?.dayOfWeek || defaultDay)),
    assignee: task?.assignee || (task?.source === "staff" ? "" : defaultAssignee),
    shiftHours: task?.shiftHours || "",
    repeatsWeekly: Boolean(task?.repeatsWeekly || (task?.repeatPattern && task.repeatPattern !== "none")),
    repeatPattern: task?.repeatPattern || "none",
    isGeneralReminder,
  };
}

function dayOfWeekFromDateKey(dateKey: string, fallback: number): number {
  if (!isIsoDateKey(dateKey)) return fallback;
  const day = dateFromKey(dateKey).getDay();
  return day === 0 ? 7 : day;
}

export function TaskDialog({
  open,
  weekId,
  defaultDay,
  defaultGeneralReminder = false,
  task,
  categories,
  staff,
  onClose,
  onSave,
  onDelete,
}: TaskDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [form, setForm] = useState<TaskForm>(() => createForm(task, weekId, defaultDay, categories, staff, defaultGeneralReminder));

  useEffect(() => {
    if (open) {
      setForm(createForm(task, weekId, defaultDay, categories, staff, defaultGeneralReminder));
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  }, [categories, defaultDay, defaultGeneralReminder, open, staff, task, weekId]);

  const isEditing = Boolean(task);
  function update<K extends keyof TaskForm>(key: K, value: TaskForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateScheduledDate(value: string) {
    setForm((current) => ({
      ...current,
      scheduledDate: value,
      dayOfWeek: dayOfWeekFromDateKey(value, current.dayOfWeek),
    }));
  }

  function updateGeneralReminder(value: boolean) {
    setForm((current) => ({
      ...current,
      isGeneralReminder: value,
      scheduledDate: value ? "" : current.scheduledDate || dateKeyForWeekDay(weekId, current.dayOfWeek),
      repeatsWeekly: value ? false : current.repeatsWeekly,
      repeatPattern: value ? "none" : current.repeatPattern,
    }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const title = form.title.trim();
    if (!title) return;
    const hasScheduledDate = isIsoDateKey(form.scheduledDate);
    const scheduledDayOfWeek = dayOfWeekFromDateKey(form.scheduledDate, form.dayOfWeek);
    const scheduledWeekId = hasScheduledDate ? weekIdFromDate(dateFromKey(form.scheduledDate)) : task?.weekId || weekId;

    onSave({
      ...task,
      id: task?.id || makeId("task"),
      title,
      description: form.description.trim(),
      dayOfWeek: scheduledDayOfWeek,
      completed: task?.completed || false,
      priority: form.priority,
      category: form.category,
      weekId: scheduledWeekId,
      repeatsWeekly: form.isGeneralReminder ? false : form.repeatsWeekly,
      repeatPattern: form.isGeneralReminder || !form.repeatsWeekly ? "none" : form.repeatPattern,
      originTaskId: task?.originTaskId,
      deleted: task?.deleted,
      specificDate: form.isGeneralReminder || !hasScheduledDate ? undefined : form.scheduledDate,
      updatedAt: Date.now(),
      assignee: form.assignee.trim() || undefined,
      shiftHours: form.shiftHours.trim() || undefined,
      source: task?.source || "private",
      isGeneralReminder: task?.source === "staff" ? false : form.isGeneralReminder,
    });
  }

  function handleDelete() {
    if (task && onDelete) onDelete(task);
  }

  return (
    <dialog ref={dialogRef} className="modal" onCancel={onClose} onClose={onClose}>
      <form className="modal-panel" onSubmit={submit}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="eyebrow">{isEditing ? "Edit task" : "Add task"}</p>
            <h2 className="text-xl font-semibold text-slate-950">
              {isEditing ? task?.title : form.isGeneralReminder ? "New undated reminder" : "New operations task"}
            </h2>
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

          {task?.source !== "staff" ? (
            <div className="option-panel">
              <label className="inline-flex items-center gap-3 text-sm font-semibold text-slate-800">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={form.isGeneralReminder}
                  onChange={(event) => updateGeneralReminder(event.target.checked)}
                />
                General reminder
              </label>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field-label">
              <span>Date</span>
              <input
                type="date"
                value={form.scheduledDate}
                disabled={form.isGeneralReminder}
                onChange={(event) => updateScheduledDate(event.target.value)}
              />
            </label>

            <label className="field-label">
              <span>Category</span>
              <select value={form.category} onChange={(event) => update("category", event.target.value)}>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
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
                {!staff.some((person) => isKarlAssignee(person.name) || isKarlAssignee(person.email)) ? (
                  <option value={KARL_ASSIGNEE}>{KARL_ASSIGNEE}</option>
                ) : null}
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

          <div className="option-panel">
            <label className="inline-flex items-center gap-3 text-sm font-semibold text-slate-800">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300"
                checked={!form.isGeneralReminder && form.repeatsWeekly}
                disabled={form.isGeneralReminder}
                onChange={(event) => update("repeatsWeekly", event.target.checked)}
              />
              Repeats
            </label>
            <select
              className="mt-3"
              value={form.repeatPattern}
              disabled={form.isGeneralReminder || !form.repeatsWeekly}
              onChange={(event) => update("repeatPattern", event.target.value as TaskForm["repeatPattern"])}
            >
              <option value="none">None</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {isEditing && onDelete ? (
            <button type="button" className="btn-secondary text-[#96321F]" onClick={handleDelete}>
              <Trash2 size={17} />
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex justify-end gap-3">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              <Save size={17} />
              Save
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
