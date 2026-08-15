// NOTE: isPrivateTask / hasRecordKeys / hasPrivateOperationsData below are duplicates of
// src/lib/taskPredicates.ts, and of KWTM_isPrivateTask_ / KWTM_hasPrivateOperationsData_ in
// apps-script/Code.gs. A Netlify Function bundle cannot import from src/, so the three
// copies must be kept in agreement by hand. Change one, change all three.

const ALLOWED_ACTIONS = new Set(["pull", "pushOperations", "pushStaffTodos", "pushStaffSchedule"]);
const APPS_SCRIPT_FETCH_TIMEOUT_MS = 45_000;

function hasRecordKeys(record) {
  return Object.keys(record || {}).length > 0;
}

function isPrivateTask(task = {}) {
  return task.source !== "staff" && !String(task.id || "").startsWith("staff-");
}

function hasPrivateOperationsData(snapshot = {}) {
  return Boolean(
    snapshot.tasks?.some(isPrivateTask) || snapshot.bills?.length || hasRecordKeys(snapshot.dailyEvents)
  );
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}

function isAbortError(error) {
  return error && error.name === "AbortError";
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed." });
  }

  const syncUrl = (process.env.APPS_SCRIPT_SYNC_URL || "").trim();
  const syncToken = (process.env.APPS_SCRIPT_SYNC_TOKEN || "").trim();
  if (!syncUrl || !syncToken) {
    return json(500, {
      ok: false,
      error: "Autosync is not configured. Add APPS_SCRIPT_SYNC_URL and APPS_SCRIPT_SYNC_TOKEN in Netlify.",
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON request." });
  }

  if (!ALLOWED_ACTIONS.has(payload.action)) {
    return json(400, { ok: false, error: "Unknown sync action." });
  }

  if (payload.action === "pushOperations" && !hasPrivateOperationsData(payload.snapshot)) {
    return json(409, {
      ok: false,
      error: "Blocked unsafe empty sync. Refresh from Google Sheets before saving an empty cache.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPS_SCRIPT_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(syncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ...payload,
        app: "karl-weekly-task-manager",
        token: syncToken,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json(502, { ok: false, error: "Apps Script did not return JSON." });
    }

    if (!response.ok || data.ok === false) {
      return json(502, { ok: false, error: data.error || response.statusText || "Apps Script sync failed." });
    }

    return json(200, data);
  } catch (error) {
    if (isAbortError(error)) {
      return json(504, { ok: false, error: "Apps Script sync timed out before returning a response." });
    }
    return json(502, { ok: false, error: error instanceof Error ? error.message : "Apps Script sync failed." });
  } finally {
    clearTimeout(timeout);
  }
}
