declare const Netlify: {
  env: {
    get(key: string): string | undefined;
  };
};

type NetlifyEdgeContext = {
  next: () => Promise<Response>;
};

const REALM = "Karl Weekly Task Manager";
const AUTH_COOKIE = "kwtm_auth";

function isFunctionRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/.netlify/functions/");
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

function unauthorized(request: Request, message = "Authentication required."): Response {
  if (isFunctionRequest(request)) return jsonResponse(401, { ok: false, error: message });
  return new Response(message, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
    },
  });
}

function unavailable(request: Request): Response {
  if (isFunctionRequest(request)) return jsonResponse(503, { ok: false, error: "Site access is not configured." });
  return new Response("Site access is not configured.", {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function sessionToken(username: string, password: string): string {
  return btoa(`${username}:${password}`);
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

function hasValidSessionCookie(request: Request, username: string, password: string): boolean {
  const cookieValue = parseCookies(request.headers.get("cookie"))[AUTH_COOKIE] || "";
  return constantTimeEquals(cookieValue, sessionToken(username, password));
}

function sessionCookie(username: string, password: string): string {
  return `${AUTH_COOKIE}=${encodeURIComponent(sessionToken(username, password))}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
}

function withSessionCookie(response: Response, username: string, password: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", sessionCookie(username, password));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseBasicAuth(header: string | null): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;

  try {
    const decoded = atob(header.slice("Basic ".length).trim());
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
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

export default async function requireBasicAuth(request: Request, context: NetlifyEdgeContext): Promise<Response> {
  const expectedUsername = Netlify.env.get("APP_BASIC_AUTH_USER");
  const expectedPassword = Netlify.env.get("APP_BASIC_AUTH_PASSWORD");
  if (!expectedUsername || !expectedPassword) return unavailable(request);

  if (hasValidSessionCookie(request, expectedUsername, expectedPassword)) return context.next();

  const credentials = parseBasicAuth(request.headers.get("authorization"));
  if (
    !credentials ||
    !constantTimeEquals(credentials.username, expectedUsername) ||
    !constantTimeEquals(credentials.password, expectedPassword)
  ) {
    return unauthorized(request);
  }

  return withSessionCookie(await context.next(), expectedUsername, expectedPassword);
}
