// NOTE: isPrivateTask / hasRecordKeys / hasPrivateOperationsData below are duplicates of
// src/lib/taskPredicates.ts, and of KWTM_isPrivateTask_ / KWTM_hasPrivateOperationsData_ in
// apps-script/Code.gs. A Netlify Function bundle cannot import from src/, so the three
// copies must be kept in agreement by hand. Change one, change all three.

// pushAll replaces the three separate push actions; those stay allowed so a browser still
// running an older bundle keeps syncing through a deploy.
const ALLOWED_ACTIONS = new Set([
  "pull",
  "pullArchive",
  "pushAll",
  "pushOperations",
  "pushStaffTodos",
  "pushStaffSchedule",
]);

/*
 * How long to wait for Apps Script, in milliseconds.
 *
 * Netlify kills a synchronous function at 10s by default, or 26s once support raises the
 * limit for a site. This budget has to sit just under whichever applies: too high and Netlify
 * tears the invocation down first, so the caller gets a bare gateway error instead of the
 * clean retryable message below; too low and we clip a sync that would have succeeded, since
 * Apps Script routinely needs 5-9s for a single spreadsheet operation.
 *
 * It reads from an environment variable so raising it does not need a code change. When
 * Netlify raises this site to 26s, set APPS_SCRIPT_FETCH_TIMEOUT_MS to 24000 in the Netlify
 * UI and redeploy -- nothing here has to be edited, and the value can be put back just as
 * fast if the raise is ever reverted.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 9_300;
// Hard ceiling: even with the 26s limit, leave Netlify room to return our response.
const MAX_FETCH_TIMEOUT_MS = 25_000;
const MIN_FETCH_TIMEOUT_MS = 2_000;

function appsScriptFetchTimeoutMs() {
  const configured = Number(process.env.APPS_SCRIPT_FETCH_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_FETCH_TIMEOUT_MS;
  // Clamped rather than trusted: a typo here would otherwise silently break every sync.
  return Math.min(Math.max(configured, MIN_FETCH_TIMEOUT_MS), MAX_FETCH_TIMEOUT_MS);
}

// Enough of the upstream body to identify which page Google served -- a sign-in
// interstitial, a quota notice, a script error page -- without dumping a whole document
// into the browser.
const UPSTREAM_SNIPPET_LENGTH = 300;

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

/**
 * Apps Script answers with HTML, not JSON, whenever Google handles the request instead of
 * our script: a sign-in interstitial, a quota or concurrency rejection, or the error page
 * shown when something escapes the script's own try/catch. All of those used to collapse
 * into one opaque line -- "Apps Script did not return JSON." -- so the same message
 * covered a transient hiccup and a genuine misconfiguration. Keep a snippet so they can be
 * told apart, and flag the transient shapes as retryable.
 */
function describeNonJsonUpstream(status, text) {
  const body = String(text || "").trim();
  const snippet = body.slice(0, UPSTREAM_SNIPPET_LENGTH).replace(/\s+/g, " ");
  const looksLikeSignIn = /accounts\.google\.com|ServiceLogin|Sign in|Meet the requirements/i.test(body);
  const looksLikeTransient =
    /Sorry, unable to open the file|too many|rate|temporarily|try again|Service invoked/i.test(body);

  if (looksLikeSignIn) {
    return {
      retryable: false,
      error:
        "Apps Script returned a Google sign-in page. Redeploy the web app with Execute as: Me and Who has access: Anyone.",
      upstreamStatus: status,
      upstreamSnippet: snippet,
    };
  }

  return {
    retryable: looksLikeTransient || status === 429 || status >= 500,
    error: `Apps Script returned ${status} with a non-JSON body.`,
    upstreamStatus: status,
    upstreamSnippet: snippet,
  };
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

  // pushOperations writes the private workbook unconditionally, so an empty snapshot there
  // would wipe it. pushAll is not guarded the same way: it skips the private write itself
  // when the snapshot holds nothing, and still has staff mirrors worth sending.
  if (payload.action === "pushOperations" && !hasPrivateOperationsData(payload.snapshot)) {
    return json(409, {
      ok: false,
      error: "Blocked unsafe empty sync. Refresh from Google Sheets before saving an empty cache.",
    });
  }

  const budgetMs = appsScriptFetchTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), budgetMs);

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
      return json(502, { ok: false, ...describeNonJsonUpstream(response.status, text) });
    }

    if (!response.ok || data.ok === false) {
      return json(502, {
        ok: false,
        // The script marks lock contention retryable; anything else is a real failure.
        retryable: Boolean(data.retryable),
        error: data.error || response.statusText || "Apps Script sync failed.",
      });
    }

    return json(200, data);
  } catch (error) {
    if (isAbortError(error)) {
      return json(504, {
        ok: false,
        retryable: true,
        error: `Apps Script did not answer within ${Math.round(budgetMs / 1000)}s.`,
      });
    }
    // A dropped connection to Google is transient far more often than not.
    return json(502, {
      ok: false,
      retryable: true,
      error: error instanceof Error ? error.message : "Apps Script sync failed.",
    });
  } finally {
    clearTimeout(timeout);
  }
}
