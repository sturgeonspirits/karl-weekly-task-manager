import { ChevronDown, ChevronUp, Sunrise } from "lucide-react";
import { useState } from "react";
import type { DailyBrief } from "../types";
import { formatLongDate } from "../utils";

const COLLAPSED_KEY = "kwtm-daily-brief-collapsed";

function readCollapsedDate(): string {
  try {
    return localStorage.getItem(COLLAPSED_KEY) || "";
  } catch {
    return "";
  }
}

type DailyBriefCardProps = {
  brief: DailyBrief | null;
  today: string;
};

/**
 * The Sturgeon Secretary's morning brief, at the top of the app. Shows only today's brief:
 * yesterday's would read as current, which is worse than showing nothing. Collapsing it
 * lasts for the rest of the day; tomorrow's brief opens expanded.
 */
export function DailyBriefCard({ brief, today }: DailyBriefCardProps) {
  const [collapsedOn, setCollapsedOn] = useState(readCollapsedDate);
  if (!brief || brief.date !== today) return null;

  const collapsed = collapsedOn === today;
  function toggle() {
    const next = collapsed ? "" : today;
    setCollapsedOn(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next);
    } catch {
      // Collapsing still works for this visit.
    }
  }

  return (
    <section className="content-surface" aria-label="Morning brief">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={toggle}
        aria-expanded={!collapsed}
      >
        <div>
          <p className="eyebrow">
            <Sunrise size={14} className="mr-1 inline" />
            Morning brief{brief.updated ? ` · ${brief.updated}` : ""}
          </p>
          <h2 className="page-title">{formatLongDate(brief.date)}</h2>
        </div>
        {collapsed ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
      </button>
      {!collapsed && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {brief.sections
            // The Do first list is shown, live, in its own panel at the top of the page.
            .filter((section) => section.title.trim().toLowerCase() !== "do first")
            .map((section) => (
            <div key={section.title}>
              <h3 className="text-sm font-semibold text-ink">{section.title}</h3>
              <ul className="mt-1 space-y-1 text-sm leading-6 text-[#7E613F]">
                {section.lines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
