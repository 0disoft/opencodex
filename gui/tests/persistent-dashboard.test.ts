import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { promptForAdminToken } from "../src/admin-token-dialog";
import { hasApiSession, installApiAuthFetch, resetApiAuthFetchForTests } from "../src/api";

const names = ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement"] as const;
let previous: unknown[];
let browser: Window;
beforeEach(() => {
  previous = names.map(name => Reflect.get(globalThis, name));
  browser = new Window({ url: "https://dashboard.example.test/" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: Reflect.get(browser, name) });
  const meta = document.createElement("meta"); meta.name = "opencodex-management-auth-required"; meta.content = "1"; document.head.append(meta);
  resetApiAuthFetchForTests();
});
afterEach(() => { resetApiAuthFetchForTests(); browser.close(); names.forEach((name, i) => Object.defineProperty(globalThis, name, { configurable: true, value: previous[i] })); });

test("remember is opt-in and asks the server to persist, never browser storage", async () => {
  let requested: unknown;
  const pending = promptForAdminToken(async (_token, remember) => { requested = remember; return "accepted"; });
  const box = document.querySelector<HTMLInputElement>('input[name="remember-device"]');
  expect(box).not.toBeNull(); expect(box!.checked).toBe(false);
  box!.checked = true;
  const form = document.querySelector("form")!;
  form.querySelector<HTMLInputElement>('input[name="password"]')!.value = "ocx_admin_fixture";
  form.dispatchEvent(new browser.Event("submit", { cancelable: true }));
  expect(await pending).toBe("ocx_admin_fixture"); expect(requested).toBe(true);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0); expect(document.cookie).toBe("");
});

test("remember installs the returned GUI session instead of retrying with the admin token", async () => {
  const seen: Array<{ path: string; headers: Headers; init?: RequestInit }> = [];
  resetApiAuthFetchForTests(async (verify, allowed) => { expect(allowed).toBe(true); expect(await verify("ocx_admin_fixture", true)).toBe("accepted"); return "ocx_admin_fixture"; });
  window.fetch = (async (input, init) => {
    const path = String(input); const headers = new Headers(init?.headers); seen.push({ path, headers, init });
    if (path.endsWith("/api/session/remember")) return Response.json({ session: { token: "ocx_session_remembered", csrfToken: "csrf-fixture", browserOrigin: window.location.origin, serverOrigin: window.location.origin } });
    if (path === "/api/config" && headers.get("X-OpenCodex-API-Key") === "ocx_session_remembered") return Response.json({ ok: true });
    return new Response(null, { status: 401 });
  }) as typeof fetch;
  installApiAuthFetch();
  expect((await window.fetch("/api/config")).status).toBe(200); expect(hasApiSession("shared")).toBe(true);
  const exchange = seen.find(row => row.path.endsWith("/api/session/remember"))!;
  expect(exchange.init?.method).toBe("POST"); expect(exchange.init?.credentials).toBe("same-origin");
  expect(seen.filter(row => row.path === "/api/config").some(row => row.headers.get("X-OpenCodex-API-Key") === "ocx_admin_fixture")).toBe(false);
});

test("obsolete remembered bearer tokens are removed without reading or migrating them", () => {
  localStorage.setItem("opencodex.remembered-admin-token", "unsafe-legacy");
  localStorage.setItem("opencodex.remembered-admin-token:https://server|same-origin", "unsafe-scoped");
  localStorage.setItem("opencodex.remembered-admin-token-decoy", "unrelated");
  const getter = localStorage.getItem.bind(localStorage); let reads = 0;
  localStorage.getItem = key => { reads++; return getter(key); };
  installApiAuthFetch();
  expect(reads).toBe(0); expect(getter("opencodex.remembered-admin-token")).toBeNull();
  expect(getter("opencodex.remembered-admin-token:https://server|same-origin")).toBeNull();
  expect(getter("opencodex.remembered-admin-token-decoy")).toBe("unrelated");
});
