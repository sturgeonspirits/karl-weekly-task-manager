import { Archive, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { ArchivedTask } from "../lib/sheetsService";
import type { CategoryOption } from "../types";
import { categoryLabel, categoryTone, priorityLabel, priorityTone } from "../lib/ui";
import { formatLongDate } from "../utils";

type ArchiveViewProps = {
  status: "idle" | "loading" | "ready" | "error" | "unconfigured";
  tasks: ArchivedTask[];
  error: string;
  categories: CategoryOption[];
  onLoad: () => void;
};

/**
 * The permanent record of tasks, read from the archive workbook.
 *
 * Loaded on demand rather than with the rest of the app: the archive only ever grows, and
 * nothing here is needed to plan a week, so it must never sit on the path that opens the app.
 */
export function ArchiveView({ status, tasks, error, categories, onLoad }: ArchiveViewProps) {
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matched = needle
      ? tasks.filter((task) =>
          [task.title, task.category, task.assignee || ""].some((field) => field.toLowerCase().includes(needle))
        )
      : tasks;
    // Most recently archived first -- the last thing you did is the thing you look for.
    return matched.slice().sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0));
  }, [tasks, search]);

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="eyebrow">Archive</p>
          <h2 className="page-title">Every task, kept</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="stat-pill">{tasks.length} archived</span>
          <button className="btn-secondary" type="button" onClick={onLoad} disabled={status === "loading"}>
            <RefreshCw size={17} />
            {status === "loading" ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {status === "unconfigured" ? (
        <p className="mt-5 text-sm text-slate-600">
          No archive workbook is set up yet. Create an empty Google Sheet and set its id as the
          <code className="mx-1">KWTM_ARCHIVE_SHEET_ID</code> script property in Apps Script. The nightly job then
          keeps the final version of every task there, including ones removed from the working sheet.
        </p>
      ) : null}

      {status === "error" ? <p className="mt-5 text-sm text-rose-600">{error}</p> : null}

      {status === "idle" || status === "loading" ? (
        <p className="mt-5 text-sm text-slate-500">
          {status === "loading" ? "Reading the archive..." : "Loading the archive..."}
        </p>
      ) : null}

      {status === "ready" ? (
        <>
          <label className="agenda-note-field mt-5 block">
            <span className="mb-2 flex items-center gap-2 text-sm font-semibold agenda-note-label">
              <Search size={17} />
              Search archived tasks
            </span>
            <input
              className="agenda-note-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Title, category or assignee"
            />
          </label>

          {visible.length === 0 ? (
            <p className="mt-5 text-sm text-slate-500">
              {tasks.length === 0 ? "Nothing archived yet. The nightly job fills this in." : "No archived task matches that search."}
            </p>
          ) : (
            <div className="agenda-task-list mt-5 grid gap-3">
              {visible.map((task) => (
                <article key={`${task.id}-${task.archivedAt}`} className="agenda-row">
                  <Archive size={17} className="mt-1 text-slate-400" />
                  <div className="min-w-0">
                    <h4 className={`font-semibold ${task.completed ? "text-slate-400 line-through" : "text-slate-950"}`}>
                      {task.title}
                    </h4>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className={`badge ${priorityTone(task.priority as never)}`}>{priorityLabel(task.priority as never)}</span>
                      <span className={`badge ${categoryTone(task.category, categories)}`}>
                        {categoryLabel(task.category, categories)}
                      </span>
                      {task.assignee ? <span className="badge border-slate-200 bg-white text-slate-700">{task.assignee}</span> : null}
                      {task.deleted ? <span className="badge border-slate-200 bg-white text-slate-500">Removed</span> : null}
                    </div>
                    <p className="mt-2 text-sm text-slate-500">
                      {task.specificDate ? formatLongDate(task.specificDate) : "Undated"}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
