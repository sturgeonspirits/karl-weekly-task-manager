import {
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  MoveRight,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import { useMemo } from "react";
import type { CategoryOption, DailyEvents, StaffMember, Task } from "../types";
import { addDays, compareTasksByPriority, dateFromKey, DAY_NAMES, formatShortDate, toLocalDateKey, weekIdFromDate } from "../utils";
import { categoryLabel, categoryMatches, categoryTone, priorityLabel, priorityTone, staffDot } from "../lib/ui";

type WeeklyGridProps = {
  weekId: string;
  tasks: Task[];
  categories: CategoryOption[];
  staff: StaffMember[];
  dailyEvents: DailyEvents;
  searchTerm: string;
  categoryFilter: string;
  onSearch: (value: string) => void;
  onCategoryFilter: (value: string) => void;
  onDailyNoteChange: (key: string, value: string) => void;
  onWeekChange: (weekId: string) => void;
  onAddTask: (dayOfWeek: number) => void;
  onMoveEarlierTasks: () => void;
  onEditTask: (task: Task) => void;
  onToggleTask: (taskId: string) => void;
  onCloneTask: (task: Task) => void;
  earlierOpenCount: number;
};

export function WeeklyGrid({
  weekId,
  tasks,
  categories,
  staff,
  dailyEvents,
  searchTerm,
  categoryFilter,
  onSearch,
  onCategoryFilter,
  onDailyNoteChange,
  onWeekChange,
  onAddTask,
  onMoveEarlierTasks,
  onEditTask,
  onToggleTask,
  onCloneTask,
  earlierOpenCount,
}: WeeklyGridProps) {
  const weekStart = useMemo(() => dateFromKey(weekId), [weekId]);
  const weekDays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => ({
        dayOfWeek: index + 1,
        dateKey: toLocalDateKey(addDays(weekStart, index)),
        label: DAY_NAMES[index],
      })),
    [weekStart]
  );

  const visibleTasks = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return tasks
      .filter((task) => task.weekId === weekId && !task.deleted && !task.isGeneralReminder && Boolean(task.specificDate))
      .filter((task) => categoryMatches(task.category, categoryFilter, categories))
      .filter((task) => {
        if (!query) return true;
        return [task.title, task.description, task.category, categoryLabel(task.category, categories), task.assignee, task.shiftHours]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .sort(compareTasksByPriority);
  }, [categories, categoryFilter, searchTerm, tasks, weekId]);

  const staffByName = useMemo(() => new Map(staff.map((person) => [person.name, person])), [staff]);
  const completionCount = visibleTasks.filter((task) => task.completed).length;

  function moveWeek(offset: number) {
    onWeekChange(toLocalDateKey(addDays(weekStart, offset)));
  }

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="eyebrow">Weekly grid</p>
          <h2 className="page-title">{formatShortDate(weekId)} operations week</h2>
          <div className="mt-2 flex flex-wrap gap-2 text-sm text-slate-600">
            <span className="stat-pill">
              <CalendarDays size={15} />
              {weekId}
            </span>
            <span className="stat-pill">
              <CheckCircle2 size={15} />
              {completionCount}/{visibleTasks.length} complete
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" type="button" onClick={() => moveWeek(-7)}>
            <ChevronLeft size={17} />
            Previous
          </button>
          <button className="btn-secondary" type="button" onClick={() => onWeekChange(weekIdFromDate(new Date()))}>
            Today
          </button>
          <button className="btn-secondary" type="button" onClick={() => moveWeek(7)}>
            Next
            <ChevronRight size={17} />
          </button>
          <button className="btn-secondary" type="button" onClick={onMoveEarlierTasks} disabled={!earlierOpenCount}>
            <MoveRight size={17} />
            Move Earlier {earlierOpenCount ? `(${earlierOpenCount})` : ""}
          </button>
          <button className="btn-primary" type="button" onClick={() => onAddTask(1)}>
            <Plus size={17} />
            Add Task
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(16rem,1fr)_16rem]">
        <label className="search-field">
          <Search size={18} />
          <input
            value={searchTerm}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search tasks, staff, category"
          />
        </label>
        <label className="sr-only" htmlFor="weekly-category-filter">
          Category
        </label>
        <select id="weekly-category-filter" value={categoryFilter} onChange={(event) => onCategoryFilter(event.target.value)}>
          <option value="all">All categories</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>

      <div className="weekly-grid-scroll mt-5 overflow-x-auto pb-2">
        <div className="weekly-grid-board grid min-w-[84rem] grid-cols-7 gap-3">
          {weekDays.map((day) => {
            const dayTasks = visibleTasks.filter((task) => task.dayOfWeek === day.dayOfWeek);
            const eventNote = dailyEvents[day.dateKey] || "";
            return (
              <div key={day.dayOfWeek} className="day-column">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-950">{day.label}</h3>
                    <p className="text-xs text-slate-500">{day.dateKey}</p>
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Add task for ${day.label}`}
                    onClick={() => onAddTask(day.dayOfWeek)}
                  >
                    <Plus size={16} />
                  </button>
                </div>

                <label className="weekly-event-field">
                  <span>
                    <CalendarCheck size={14} />
                    Event
                  </span>
                  <input
                    className="weekly-event-input"
                    value={eventNote}
                    onChange={(event) => onDailyNoteChange(day.dateKey, event.target.value)}
                    placeholder="Add event note"
                  />
                </label>

                <div className="mt-3 grid gap-3">
                  {dayTasks.map((task) => {
                    const person = staffByName.get(task.assignee || "");
                    return (
                      <article key={task.id} className={`task-card ${task.completed ? "task-card-complete" : ""}`}>
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border-slate-300"
                            checked={task.completed}
                            aria-label={`Mark ${task.title} complete`}
                            onChange={() => onToggleTask(task.id)}
                          />
                          <div className="min-w-0 flex-1">
                            <h4 className="text-sm font-semibold leading-snug text-slate-950">{task.title}</h4>
                            {task.description ? (
                              <p className="mt-1 line-clamp-3 text-xs leading-5 text-slate-600">{task.description}</p>
                            ) : null}
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className={`badge ${priorityTone(task.priority)}`}>{priorityLabel(task.priority)}</span>
                          <span className={`badge ${categoryTone(task.category, categories)}`}>{categoryLabel(task.category, categories)}</span>
                        </div>

                        {(task.assignee || task.shiftHours) && (
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                            {task.assignee ? (
                              <span className="assignee-pill">
                                <span className={`h-2 w-2 rounded-full ${staffDot(person?.color)}`} />
                                {task.assignee}
                              </span>
                            ) : null}
                            {task.shiftHours ? <span>{task.shiftHours}</span> : null}
                          </div>
                        )}

                        <div className="mt-3 flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Edit ${task.title}`}
                            onClick={() => onEditTask(task)}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Clone ${task.title} to next week`}
                            onClick={() => onCloneTask(task)}
                          >
                            <CopyPlus size={15} />
                          </button>
                        </div>
                      </article>
                    );
                  })}

                  {!dayTasks.length ? (
                    <button className="empty-day" type="button" onClick={() => onAddTask(day.dayOfWeek)}>
                      <Plus size={16} />
                      Add task
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
