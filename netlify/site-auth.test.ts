import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import siteAuth from "./edge-functions/site-auth";

/*
 * End-to-end tests for code sign-in: the real edge function talks (through a stubbed
 * fetch) to the real apps-script/LoginMailer.gs running against in-memory fakes.
 *
 * This file lives outside netlify/edge-functions/ on purpose: Netlify bundles every file in
 * that folder as an edge function, and a test file there would break the deploy.
 */

const here = dirname(fileURLToPath(import.meta.url));
const mailerSource = readFileSync(join(here, "..", "apps-script", "LoginMailer.gs"), "utf8");

const ORIGIN = "https://tasks.example";
const MAILER_URL = "https://script.google.com/macros/s/test/exec";
const MAILER_TOKEN = "mailer-token";

type SentMail = { to: string; subject: string; body: string };

function loadMailer(scriptProps: Map<string, string>, sent: SentMail[]) {
  const globals: Record<string, unknown> = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => (scriptProps.has(key) ? scriptProps.get(key) : null),
        setProperty: (key: string, value: string) => scriptProps.set(key, value),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { sendEmail: (mail: SentMail) => sent.push(mail) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }) },
    Utilities: {
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: "sha256" },
      computeDigest: (_algorithm: string, value: string) =>
        Array.from(createHash("sha256").update(value).digest()).map((b) => (b > 127 ? b - 256 : b)),
    },
    ContentService: {},
    Logger: { log() {} },
  };
  const names = Object.keys(globals);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${mailerSource}\n;return { KWTM_loginHandle_ };`);
  return factory(...names.map((name) => globals[name])) as {
    KWTM_loginHandle_: (e: unknown, now: number) => Record<string, unknown>;
  };
}

describe("site sign-in", () => {
  let env: Record<string, string>;
  let scriptProps: Map<string, string>;
  let sent: SentMail[];
  let next: ReturnType<typeof vi.fn>;
  const context = () => ({ next: next as unknown as () => Promise<Response> });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T15:00:00Z"));
    env = { LOGIN_MAILER_URL: MAILER_URL, LOGIN_MAILER_TOKEN: MAILER_TOKEN };
    (globalThis as any).Netlify = { env: { get: (key: string) => env[key] } };
    scriptProps = new Map([["KWTM_LOGIN_TOKEN", MAILER_TOKEN]]);
    sent = [];
    const mailer = loadMailer(scriptProps, sent);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe(MAILER_URL);
        const result = mailer.KWTM_loginHandle_({ postData: { contents: String(init.body) } }, Date.now());
        return new Response(JSON.stringify(result));
      })
    );
    next = vi.fn(async () => new Response("app body", { status: 200 }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function get(path: string, headers: Record<string, string> = {}) {
    return siteAuth(new Request(`${ORIGIN}${path}`, { headers }), context());
  }

  function post(path: string, fields: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) {
    return siteAuth(
      new Request(`${ORIGIN}${path}`, { method: "POST", body: new URLSearchParams(fields), headers }),
      context()
    );
  }

  function cookieFrom(response: Response): string {
    const header = response.headers.get("set-cookie") || "";
    return header.split(";")[0];
  }

  function lastCode(): string {
    const match = /(\d{6})$/.exec(sent[sent.length - 1]?.subject || "");
    if (!match) throw new Error("no code email was sent");
    return match[1];
  }

  async function signIn(nextPath = "/"): Promise<string> {
    await post("/auth/send", { next: nextPath });
    const response = await post("/auth/verify", { next: nextPath, code: lastCode() });
    expect(response.status).toBe(303);
    return cookieFrom(response);
  }

  it("returns 503 when no way in is configured", async () => {
    env = {};
    expect((await get("/")).status).toBe(503);
  });

  it("lets the service worker, manifest and icons through while signed out", async () => {
    for (const path of ["/sw.js", "/registerSW.js", "/workbox-abeb32eb.js", "/manifest.webmanifest", "/app-icon-192.png"]) {
      expect((await get(path)).status).toBe(200);
    }
    expect((await get("/assets/index-B-2Q_MWX.js")).status).toBe(401);
  });

  it("sends a signed-out page visit to the sign-in page and remembers where it was going", async () => {
    const response = await get("/week?x=1", { "sec-fetch-mode": "navigate" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/login?next=%2Fweek%3Fx%3D1");
    expect(next).not.toHaveBeenCalled();
  });

  it("answers a signed-out sync call with JSON the app can recognise", async () => {
    const response = await siteAuth(
      new Request(`${ORIGIN}/.netlify/functions/sheets-sync`, { method: "POST", body: "{}" }),
      context()
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, authRequired: true });
  });

  it("signs in with an emailed code and lands back where it started", async () => {
    const start = await get("/auth/login?next=%2Fweek");
    expect(await start.text()).toContain("Email me a code");

    const sendResponse = await post("/auth/send", { next: "/week" });
    expect(sendResponse.status).toBe(303);
    expect(sendResponse.headers.get("location")).toBe("/auth/login?step=code&to=o***%40example.com&next=%2Fweek");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.com");
    expect(sent[0].body).toContain(lastCode());

    const codePage = await get(sendResponse.headers.get("location")!);
    const html = await codePage.text();
    expect(html).toContain("o***@example.com");
    expect(html).toContain('autocomplete="one-time-code"');

    const verify = await post("/auth/verify", { next: "/week", code: lastCode() });
    expect(verify.status).toBe(303);
    expect(verify.headers.get("location")).toBe("/week");
    const setCookie = verify.headers.get("set-cookie") || "";
    expect(setCookie).toMatch(/^kwtm_auth=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain(`Max-Age=${90 * 86400}`);

    const app = await get("/week", { cookie: cookieFrom(verify) });
    expect(app.status).toBe(200);
    expect(await app.text()).toBe("app body");
    expect(app.headers.get("set-cookie")).toBeNull(); // fresh cookie, nothing to renew
  });

  it("does not store the code itself in the mailer", async () => {
    await post("/auth/send", {});
    expect(scriptProps.get("KWTM_LOGIN_STATE")).not.toContain(lastCode());
  });

  it("accepts a code typed with spaces", async () => {
    await post("/auth/send", {});
    const code = lastCode();
    const verify = await post("/auth/verify", { code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(verify.status).toBe(303);
  });

  it("uses each code only once", async () => {
    await post("/auth/send", {});
    const code = lastCode();
    expect((await post("/auth/verify", { code })).status).toBe(303);
    const again = await post("/auth/verify", { code });
    expect(again.status).toBe(401);
    expect(await again.text()).toContain("expired");
  });

  it("rejects a wrong code, then kills the code after five wrong tries", async () => {
    await post("/auth/send", {});
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";

    const first = await post("/auth/verify", { code: wrong });
    expect(first.status).toBe(401);
    expect(await first.text()).toContain("not right");

    for (let i = 0; i < 4; i += 1) await post("/auth/verify", { code: wrong });
    expect((await post("/auth/verify", { code })).status).toBe(401);
  });

  it("expires a code after ten minutes", async () => {
    await post("/auth/send", {});
    const code = lastCode();
    vi.setSystemTime(new Date("2026-10-30T15:10:01Z"));
    const response = await post("/auth/verify", { code });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("expired");
  });

  it("does not send a second email for a double tap", async () => {
    await post("/auth/send", {});
    await post("/auth/send", {});
    expect(sent).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-30T15:00:30Z"));
    await post("/auth/send", {});
    expect(sent).toHaveLength(2);
  });

  it("caps how many codes go out in an hour", async () => {
    for (let i = 0; i < 12; i += 1) {
      vi.setSystemTime(new Date(Date.parse("2026-10-30T15:00:00Z") + i * 30_000));
      await post("/auth/send", {});
    }
    expect(sent).toHaveLength(10);
  });

  it("shows the mailer's complaint when the tokens do not match", async () => {
    scriptProps.set("KWTM_LOGIN_TOKEN", "something-else");
    const response = await post("/auth/send", {});
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("token mismatch");
    expect(sent).toHaveLength(0);
  });

  it("refuses sign-in posts from another site", async () => {
    const response = await post("/auth/send", {}, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("never redirects off the site after sign-in", async () => {
    const send = await post("/auth/send", { next: "https://evil.example" });
    expect(send.headers.get("location")).not.toContain("evil");
    const verify = await post("/auth/verify", { next: "//evil.example/", code: lastCode() });
    expect(verify.headers.get("location")).toBe("/");
  });

  it("signs out", async () => {
    const response = await get("/auth/logout");
    expect(response.headers.get("location")).toBe("/auth/login");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  describe("with the password fallback configured", () => {
    beforeEach(() => {
      env.APP_BASIC_AUTH_USER = "karl";
      env.APP_BASIC_AUTH_PASSWORD = "hunter2";
    });

    const basic = (user: string, password: string) => ({ authorization: `Basic ${btoa(`${user}:${password}`)}` });

    it("offers it on the sign-in page", async () => {
      expect(await (await get("/auth/login")).text()).toContain("Use password instead");
    });

    it("signs in with the right password", async () => {
      const response = await get("/auth/password?next=%2Fweek", basic("karl", "hunter2"));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/week");
      expect(response.headers.get("set-cookie")).toMatch(/^kwtm_auth=/);
    });

    it("asks the browser for a password otherwise", async () => {
      const response = await get("/auth/password", basic("karl", "wrong"));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Basic");
    });

    it("keeps sessions issued by the old basic-auth function, and renews them", async () => {
      // Same format and key the old function used: HMAC(user|expiry) keyed off the password.
      const expiresAt = Math.floor(Date.now() / 1000) + 20 * 86400;
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("derived-from-password:hunter2"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`karl|${expiresAt}`));
      const token = `${expiresAt}.${Buffer.from(sig).toString("base64url")}`;

      const response = await get("/", { cookie: `kwtm_auth=${encodeURIComponent(token)}` });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain(`Max-Age=${90 * 86400}`);
    });
  });

  it("renews a session that is more than a day old", async () => {
    const cookie = await signIn();
    vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
    const response = await siteAuth(
      new Request(`${ORIGIN}/.netlify/functions/sheets-sync`, { method: "POST", body: "{}", headers: { cookie } }),
      context()
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/^kwtm_auth=/);
  });

  it("rejects a session after 90 days without a visit", async () => {
    const cookie = await signIn();
    vi.setSystemTime(new Date("2027-01-29T15:00:01Z"));
    expect((await get("/", { cookie, "sec-fetch-mode": "navigate" })).status).toBe(303);
  });
});
