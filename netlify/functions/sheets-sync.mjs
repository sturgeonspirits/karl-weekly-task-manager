const ALLOWED_ACTIONS = new Set(["pull", "pushOperations", "pushStaffTodos", "pushStaffSchedule"]);

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

  try {
    const response = await fetch(syncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ...payload,
        app: "karl-weekly-task-manager",
        token: syncToken,
      }),
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
    return json(502, { ok: false, error: error instanceof Error ? error.message : "Apps Script sync failed." });
  }
}
