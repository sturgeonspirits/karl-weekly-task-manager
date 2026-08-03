declare const Netlify: {
  env: {
    get(key: string): string | undefined;
  };
};

type NetlifyEdgeContext = {
  next: () => Promise<Response>;
};

const REALM = "Karl Weekly Task Manager";

function unauthorized(message = "Authentication required."): Response {
  return new Response(message, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
    },
  });
}

function unavailable(): Response {
  return new Response("Site access is not configured.", {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
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
  if (!expectedUsername || !expectedPassword) return unavailable();

  const credentials = parseBasicAuth(request.headers.get("authorization"));
  if (
    !credentials ||
    !constantTimeEquals(credentials.username, expectedUsername) ||
    !constantTimeEquals(credentials.password, expectedPassword)
  ) {
    return unauthorized();
  }

  return context.next();
}
