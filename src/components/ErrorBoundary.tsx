import { Component, type ErrorInfo, type ReactNode } from "react";
import { clearCachedSnapshot } from "../lib/storage";

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error: Error | null };

/**
 * Without this, one malformed row arriving from Sheets throws during render and the whole
 * page goes blank with no way back. The local cache is the only copy of unsaved work, so
 * the recovery path deliberately does NOT clear it -- it offers a reload first, and keeps
 * clearing the cache as a separate, clearly labelled last resort.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error in Karl Weekly Task Manager", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen bg-mash px-4 py-10 text-ink">
        <div className="mx-auto max-w-xl rounded-lg border border-[#96321F]/35 bg-[#F1F1E7] p-6">
          <p className="eyebrow text-[#96321F]">Something broke</p>
          <h1 className="mt-1 text-xl font-semibold">The app stopped rendering</h1>
          <p className="mt-3 text-sm leading-6 text-[#7E613F]">
            Your Google Sheets data is untouched. Reloading usually fixes this. If it happens every
            time, the browser cache may hold a bad record &mdash; clearing it will pull a fresh copy
            from Sheets and lose only changes that never finished syncing.
          </p>

          <pre className="mt-4 overflow-x-auto rounded border border-[#C8BCA4] bg-white/60 p-3 text-xs text-[#242622]">
            {error.message || String(error)}
          </pre>

          <div className="mt-5 flex flex-wrap gap-3">
            <button className="btn-header" type="button" onClick={() => window.location.reload()}>
              Reload the page
            </button>
            <button
              className="btn-header"
              type="button"
              onClick={() => {
                if (!window.confirm("Clear the local cache and reload from Google Sheets? Changes that never synced will be lost.")) return;
                clearCachedSnapshot();
                window.location.reload();
              }}
            >
              Clear cache and reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
