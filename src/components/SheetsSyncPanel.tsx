import { Cloud, Download, KeyRound, Send, Sheet, Upload } from "lucide-react";
import { FormEvent, useState } from "react";
import { DEFAULT_PRIVATE_SHEET_ID, DEFAULT_STAFF_TODOS_SHEET_ID, SHEETS_SCOPE } from "../lib/sheetsService";

type SheetsSyncPanelProps = {
  privateSheetId: string;
  staffTodosSheetId: string;
  publicStaffSheetId: string;
  clientId: string;
  connected: boolean;
  busy: boolean;
  status: string;
  onPrivateSheetIdChange: (value: string) => void;
  onStaffTodosSheetIdChange: (value: string) => void;
  onPublicStaffSheetIdChange: (value: string) => void;
  onClientIdChange: (value: string) => void;
  onConnect: () => void;
  onPull: () => void;
  onPush: () => void;
  onPushStaff: () => void;
};

export function SheetsSyncPanel({
  privateSheetId,
  staffTodosSheetId,
  publicStaffSheetId,
  clientId,
  connected,
  busy,
  status,
  onPrivateSheetIdChange,
  onStaffTodosSheetIdChange,
  onPublicStaffSheetIdChange,
  onClientIdChange,
  onConnect,
  onPull,
  onPush,
  onPushStaff,
}: SheetsSyncPanelProps) {
  const [expanded, setExpanded] = useState(false);

  function saveConfig(event: FormEvent) {
    event.preventDefault();
    setExpanded(false);
  }

  return (
    <section className="content-surface">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="eyebrow">Google Sheets sync</p>
          <h2 className="page-title">Private tasks, staff todos, and daily notes</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" type="button" onClick={() => setExpanded((value) => !value)}>
            <KeyRound size={17} />
            Settings
          </button>
          <button className="btn-primary" type="button" onClick={onConnect} disabled={busy}>
            <Cloud size={17} />
            {connected ? "Reconnect" : "Connect"}
          </button>
        </div>
      </div>

      {expanded ? (
        <form className="mt-5 grid gap-4" onSubmit={saveConfig}>
          <label className="field-label">
            <span>Google OAuth client ID</span>
            <input
              value={clientId}
              onChange={(event) => onClientIdChange(event.target.value)}
              placeholder="Client ID for popup OAuth"
            />
          </label>
          <label className="field-label">
            <span>Private task workbook URL or ID</span>
            <input value={privateSheetId} onChange={(event) => onPrivateSheetIdChange(event.target.value)} />
          </label>
          <label className="field-label">
            <span>Staff/general todos workbook URL or ID</span>
            <input value={staffTodosSheetId} onChange={(event) => onStaffTodosSheetIdChange(event.target.value)} />
          </label>
          <label className="field-label">
            <span>Public staff sheet ID</span>
            <input value={publicStaffSheetId} onChange={(event) => onPublicStaffSheetIdChange(event.target.value)} />
          </label>
          <button className="btn-primary justify-self-start" type="submit">
            Save Settings
          </button>
        </form>
      ) : null}

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <button className="sync-action" type="button" onClick={onPull} disabled={!connected || busy}>
          <Download size={19} />
          <span>Pull / Import</span>
          <small>Read private Tasks/Events plus staff Todos/DailyNotes.</small>
        </button>
        <button className="sync-action" type="button" onClick={onPush} disabled={!connected || busy}>
          <Upload size={19} />
          <span>Push / Overwrite</span>
          <small>Clear target tabs and write standard tables.</small>
        </button>
        <button className="sync-action" type="button" onClick={onPushStaff} disabled={!connected || busy}>
          <Send size={19} />
          <span>Staff Schedule</span>
          <small>Publish shift data to the public staff sheet.</small>
        </button>
      </div>

      <div className="mt-5 grid gap-3 text-sm text-slate-600 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="sync-meta">
          <Sheet size={17} />
          <span className="truncate">Private tasks: {privateSheetId || DEFAULT_PRIVATE_SHEET_ID}</span>
        </div>
        <div className="sync-meta">
          <Sheet size={17} />
          <span className="truncate">Staff todos: {staffTodosSheetId || DEFAULT_STAFF_TODOS_SHEET_ID}</span>
        </div>
        <div className="sync-meta">
          <Sheet size={17} />
          <span className="truncate">Public staff: {publicStaffSheetId || "Not set"}</span>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
        <strong className="text-slate-900">Scope:</strong> {SHEETS_SCOPE}
      </div>

      {status ? <p className="mt-4 text-sm font-medium text-slate-700">{status}</p> : null}
    </section>
  );
}
