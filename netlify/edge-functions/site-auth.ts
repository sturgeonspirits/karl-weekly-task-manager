declare const Netlify: {
  env: {
    get(key: string): string | undefined;
  };
};

type NetlifyEdgeContext = {
  next: () => Promise<Response>;
};

/*
 * Site sign-in for the whole app.
 *
 * The normal way in is an emailed one-time code: the sign-in page asks the "KWTM Login
 * Mailer" Apps Script (apps-script/LoginMailer.gs) to email a 6-digit code, and checks the
 * code with the same script. The mailer holds the code, the expiry and the try counters,
 * so this function stays stateless.
 *
 * The old username/password (HTTP Basic) still works as a fallback when
 * APP_BASIC_AUTH_PASSWORD is set -- "Use password instead" on the sign-in page -- so a
 * mailer outage never locks you out.
 *
 * Environment variables (Netlify > Site configuration > Environment variables):
 * - LOGIN_MAILER_URL    the mailer's /exec web app URL
 * - LOGIN_MAILER_TOKEN  same value as the mailer's KWTM_LOGIN_TOKEN script property
 * - APP_SESSION_SECRET  optional; signing key for the session cookie
 * - APP_BASIC_AUTH_USER / APP_BASIC_AUTH_PASSWORD  optional password fallback
 * At least one way in (mailer or password) has to be configured, or the site returns 503.
 */

const REALM = "Karl Weekly Task Manager";
const AUTH_COOKIE = "kwtm_auth";
// Sessions slide: any visit more than a day after the cookie was issued re-issues it, so
// the app only signs you out after 90 days of not opening it at all.
const SESSION_MAX_AGE_SECONDS = 90 * 86_400;
const SESSION_RENEW_AFTER_SECONDS = 86_400;
const MAILER_TIMEOUT_MS = 20_000;
const DEFAULT_USERNAME = "karl";

/*
 * Files the browser fetches on its own, often without cookies: the service worker and its
 * helpers, the manifest and the icons. None of them hold task data (that all goes through
 * the sheets-sync function, which stays locked). Letting them through means the installed
 * app keeps its icon and can still pick up a new service worker while signed out -- which
 * is what lets it show the sign-in page instead of a cached copy of the app.
 */
const PUBLIC_PATH =
  /^\/(?:sw\.js|registerSW\.js|workbox-[\w-]+\.js|manifest\.webmanifest|favicon-\d+\.png|app-icon(?:-\d+)?\.(?:png|svg)|apple-touch-icon\.png)$/;

type Config = {
  username: string;
  password: string; // "" when the password fallback is off
  mailerUrl: string;
  mailerToken: string;
  keyMaterial: string;
};

type MailerResult = {
  ok: boolean;
  error?: string;
  reason?: string;
  to?: string;
};

function readConfig(): Config | null {
  const password = Netlify.env.get("APP_BASIC_AUTH_PASSWORD") || "";
  const mailerUrl = (Netlify.env.get("LOGIN_MAILER_URL") || "").trim();
  const mailerToken = (Netlify.env.get("LOGIN_MAILER_TOKEN") || "").trim();
  if (!password && !(mailerUrl && mailerToken)) return null;

  /*
   * The session cookie is an HMAC over the username and an expiry. The key is
   * APP_SESSION_SECRET when set. Otherwise it is derived from the password (exactly as the
   * old basic-auth function did, so sessions from before this change stay valid), or from
   * the mailer token when there is no password. Rotating APP_SESSION_SECRET signs every
   * device out.
   */
  const keyMaterial =
    Netlify.env.get("APP_SESSION_SECRET") ||
    (password ? `derived-from-password:${password}` : `derived-from-mailer-token:${mailerToken}`);

  return {
    username: Netlify.env.get("APP_BASIC_AUTH_USER") || DEFAULT_USERNAME,
    password,
    mailerUrl: mailerUrl && mailerToken ? mailerUrl : "",
    mailerToken: mailerUrl && mailerToken ? mailerToken : "",
    keyMaterial,
  };
}

// ---------------------------------------------------------------------------------------
// Responses

function isFunctionRequest(url: URL): boolean {
  return url.pathname.startsWith("/.netlify/functions/");
}

function isNavigation(request: Request): boolean {
  if (request.method !== "GET") return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") || "").includes("text/html");
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(null, { status: 303, headers });
}

function unavailable(url: URL): Response {
  if (isFunctionRequest(url)) return jsonResponse(503, { ok: false, error: "Site access is not configured." });
  return new Response("Site access is not configured.", {
    status: 503,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------------------
// Session cookie

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sign(payload: string, keyMaterial: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

/** Cookie value is `<expiryEpochSeconds>.<hmac>` -- readable expiry, unforgeable signature. */
async function sessionToken(config: Config, expiresAt: number): Promise<string> {
  return `${expiresAt}.${await sign(`${config.username}|${expiresAt}`, config.keyMaterial)}`;
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return;
      const key = part.slice(0, separator).trim();
      if (!key) return;
      try {
        cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        cookies[key] = "";
      }
    });
  return cookies;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function readSession(request: Request, config: Config): Promise<{ valid: boolean; renew: boolean }> {
  const cookieValue = parseCookies(request.headers.get("cookie"))[AUTH_COOKIE] || "";
  const separator = cookieValue.indexOf(".");
  if (separator < 0) return { valid: false, renew: false };

  const expiresAt = Number(cookieValue.slice(0, separator));
  const now = nowSeconds();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { valid: false, renew: false };

  const valid = constantTimeEquals(cookieValue, await sessionToken(config, expiresAt));
  return { valid, renew: valid && expiresAt - now < SESSION_MAX_AGE_SECONDS - SESSION_RENEW_AFTER_SECONDS };
}

// SameSite=Lax rather than Strict: Strict drops the cookie whenever the site is opened from
// a link in another app or site (an email, a bookmark sync), which looked like being
// signed out for no reason.
async function sessionCookie(config: Config): Promise<string> {
  const token = await sessionToken(config, nowSeconds() + SESSION_MAX_AGE_SECONDS);
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearedSessionCookie(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function withSessionCookie(response: Response, config: Config): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", await sessionCookie(config));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------------------
// Password fallback (HTTP Basic)

function parseBasicAuth(header: string | null): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice("Basic ".length).trim());
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  const length = Math.max(actualBytes.length, expectedBytes.length, 1);
  let difference = actualBytes.length ^ expectedBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (actualBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }
  return difference === 0;
}

function hasValidPassword(request: Request, config: Config): boolean {
  if (!config.password) return false;
  const credentials = parseBasicAuth(request.headers.get("authorization"));
  // Both comparisons always run: `&&` would short-circuit on a wrong username and leak
  // which half failed through response timing.
  const usernameMatches = constantTimeEquals(credentials?.username ?? "", config.username);
  const passwordMatches = constantTimeEquals(credentials?.password ?? "", config.password);
  return Boolean(credentials) && usernameMatches && passwordMatches;
}

// ---------------------------------------------------------------------------------------
// Mailer

async function callMailer(config: Config, body: Record<string, unknown>): Promise<MailerResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAILER_TIMEOUT_MS);
  try {
    const response = await fetch(config.mailerUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ...body, token: config.mailerToken }),
      signal: controller.signal,
    });
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      return data && typeof data === "object" ? data : { ok: false, error: "The sign-in mailer gave an empty answer." };
    } catch {
      // Google's own HTML page: usually the mailer deployment needs re-authorizing.
      return {
        ok: false,
        error: "The sign-in mailer answered with a Google error page. Its Apps Script deployment may need re-authorizing.",
      };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "The sign-in mailer did not answer in time. Try again." };
    }
    return { ok: false, error: "Could not reach the sign-in mailer. Try again." };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------------------
// Sign-in pages

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only same-site paths, never back into /auth/, so the redirect can't be pointed elsewhere. */
function safeNext(raw: unknown): string {
  const value = String(raw || "");
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.startsWith("/auth/")) {
    return "/";
  }
  return value;
}

function loginPath(next: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (next !== "/") params.set("next", next);
  const query = params.toString();
  return `/auth/login${query ? `?${query}` : ""}`;
}

const PAGE_STYLE = `
:root{--bg:#f6f1ea;--card:#fffdf9;--ink:#2b211c;--muted:#6e6058;--brand:#96321f;--brand-ink:#fff;--line:#e3d8cc;--error-bg:#fbe9e5;--error:#8a2a18}
@media (prefers-color-scheme:dark){:root{--bg:#1d1714;--card:#28201c;--ink:#f3ebe4;--muted:#b9aaa0;--brand:#c4543b;--line:#43362f;--error-bg:#3b211b;--error:#f2b5a6}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px}
.app{margin:0 0 4px;color:var(--muted);font-size:14px}
h1{margin:0 0 12px;font-size:24px;line-height:1.2}
p{margin:0 0 16px}
label{display:block;font-weight:600;margin-bottom:6px}
input{width:100%;font-size:28px;letter-spacing:.3em;text-align:center;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);margin-bottom:16px}
button.primary{width:100%;font-size:17px;font-weight:600;padding:13px;border:0;border-radius:10px;background:var(--brand);color:var(--brand-ink);cursor:pointer}
button.primary:disabled{opacity:.6}
.alt{margin-top:18px;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:15px}
.alt form{margin:0}
.alt a,.alt button{color:var(--brand);background:none;border:0;padding:0;font:inherit;text-decoration:underline;cursor:pointer}
.error{background:var(--error-bg);color:var(--error);border-radius:10px;padding:10px 12px}
`;

function page(title: string, content: string, status = 200, setCookie?: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#96321F">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} - Karl Tasks</title>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<style>${PAGE_STYLE}</style>
</head>
<body><main><p class="app">Karl Weekly Task Manager</p>${content}</main></body>
</html>`;
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(html, { status, headers });
}

function errorBlock(message?: string): string {
  return message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : "";
}

function passwordLink(config: Config, next: string): string {
  if (!config.password) return "";
  return `<a href="/auth/password?next=${encodeURIComponent(next)}">Use password instead</a>`;
}

function startPage(config: Config, next: string, error?: string, status = 200): Response {
  const hidden = `<input type="hidden" name="next" value="${escapeHtml(next)}">`;
  if (!config.mailerUrl) {
    return page(
      "Sign in",
      `<h1>Sign in</h1>${errorBlock(error)}<p>Code sign-in isn't set up yet, so use your password.</p>
<div class="alt">${passwordLink(config, next)}</div>`,
      status
    );
  }
  return page(
    "Sign in",
    `<h1>Sign in</h1>${errorBlock(error)}
<p>We'll email you a 6-digit code. No password needed.</p>
<form method="post" action="/auth/send">${hidden}<button class="primary" type="submit">Email me a code</button></form>
<div class="alt">${passwordLink(config, next)}</div>`,
    status
  );
}

function codePage(config: Config, next: string, to: string, error?: string, status = 200): Response {
  const hidden = `<input type="hidden" name="next" value="${escapeHtml(next)}">`;
  const where = to ? `<strong>${escapeHtml(to)}</strong>` : "your email";
  return page(
    "Enter your code",
    `<h1>Check your email</h1>
<p>We sent a 6-digit code to ${where}. It expires in 10 minutes.</p>${errorBlock(error)}
<form method="post" action="/auth/verify" id="code-form">${hidden}<input type="hidden" name="to" value="${escapeHtml(to)}">
<label for="code">Code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required autofocus>
<button class="primary" type="submit">Sign in</button>
</form>
<div class="alt"><form method="post" action="/auth/send">${hidden}<button type="submit">Send a new code</button></form>${passwordLink(config, next)}</div>
<script>
(function(){var f=document.getElementById("code-form"),i=document.getElementById("code"),sent=false;
f.addEventListener("submit",function(){sent=true;f.querySelector("button").disabled=true;});
i.addEventListener("input",function(){if(!sent&&i.value.replace(/\\D/g,"").length===6){f.requestSubmit?f.requestSubmit():f.submit();}});})();
</script>`,
    status
  );
}

// ---------------------------------------------------------------------------------------
// /auth/* routes

/** Refuse form posts from other sites (stops a stranger's page from spamming codes). */
function isCrossSitePost(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin !== "null" && origin !== url.origin);
}

async function readForm(request: Request): Promise<Record<string, string>> {
  try {
    const form = await request.formData();
    const values: Record<string, string> = {};
    form.forEach((value, key) => {
      if (typeof value === "string") values[key] = value;
    });
    return values;
  } catch {
    return {};
  }
}

async function handleAuthRoute(request: Request, url: URL, config: Config): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/auth/logout") {
    return redirect("/auth/login", clearedSessionCookie());
  }

  if (path === "/auth/login" && request.method === "GET") {
    const next = safeNext(url.searchParams.get("next"));
    if ((await readSession(request, config)).valid) return redirect(next);
    if (url.searchParams.get("step") === "code" && config.mailerUrl) {
      return codePage(config, next, url.searchParams.get("to") || "");
    }
    return startPage(config, next);
  }

  if (path === "/auth/password" && request.method === "GET") {
    const next = safeNext(url.searchParams.get("next"));
    if (!config.password) return redirect(loginPath(next));
    if (hasValidPassword(request, config)) return redirect(next, await sessionCookie(config));
    // The browser shows its own username/password box for this. If it's cancelled, this
    // page is what's left on screen.
    const response = page(
      "Password sign-in",
      `<h1>Password sign-in cancelled</h1><p><a href="${escapeHtml(loginPath(next))}">Back to code sign-in</a></p>`,
      401
    );
    response.headers.set("www-authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
    return response;
  }

  if ((path === "/auth/send" || path === "/auth/verify") && request.method === "POST") {
    if (isCrossSitePost(request, url)) return new Response("Forbidden.", { status: 403 });
    const form = await readForm(request);
    const next = safeNext(form.next);

    if (!config.mailerUrl) return startPage(config, next);

    if (path === "/auth/send") {
      const result = await callMailer(config, { action: "send" });
      if (!result.ok) return startPage(config, next, result.error || "Could not send a code. Try again.", 502);
      return redirect(loginPath(next, { step: "code", to: String(result.to || "") }));
    }

    const to = String(form.to || "").slice(0, 120);
    const code = String(form.code || "").replace(/\D/g, "");
    if (code.length !== 6) return codePage(config, next, to, "Enter the 6-digit code from the email.", 400);

    const result = await callMailer(config, { action: "verify", code });
    if (!result.ok) {
      const message =
        result.reason === "locked" && config.password
          ? `${result.error} Use your password for now.`
          : result.error || "That code didn't work. Try again.";
      return codePage(config, next, to, message, 401);
    }
    return redirect(next, await sessionCookie(config));
  }

  return redirect(loginPath("/"));
}

// ---------------------------------------------------------------------------------------

export default async function siteAuth(request: Request, context: NetlifyEdgeContext): Promise<Response> {
  const url = new URL(request.url);
  if (PUBLIC_PATH.test(url.pathname)) return context.next();

  const config = readConfig();
  if (!config) return unavailable(url);

  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
    return handleAuthRoute(request, url, config);
  }

  const session = await readSession(request, config);
  if (session.valid) {
    const response = await context.next();
    return session.renew ? withSessionCookie(response, config) : response;
  }

  // Scripts or old bookmarks that send the password directly still get in.
  if (hasValidPassword(request, config)) return withSessionCookie(await context.next(), config);

  if (isFunctionRequest(url)) {
    return jsonResponse(401, { ok: false, authRequired: true, error: "Signed out. Sign in again to sync." });
  }
  if (isNavigation(request)) return redirect(loginPath(safeNext(`${url.pathname}${url.search}`)));
  return new Response("Sign-in required.", {
    status: 401,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}
