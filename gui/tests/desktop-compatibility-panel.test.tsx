import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CodexDesktopCompatibility from "../src/pages/codex-desktop-compatibility";
import { clearClientResourceStoresForTests, setClientResourceData } from "../src/client-resource";

const keys = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>, page: Window, root: Root | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  page = new Window({ url: "http://localhost/#codex-set/desktop" });
  page.localStorage.setItem("ocx-lang", "en");
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(page, key) });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined;
  globalThis.fetch = originalFetch; page.close();
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});
const requests: { url: string; method: string; body?: unknown }[] = [];
function server(uncertain = false, certificateState?: string, usagePhase?: string, observation?: Record<string, unknown>, buildAssessment?: unknown, runtimeExtras: Record<string, unknown> = {}) {
  requests.length = 0; let trusted = false, startup = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/settings")) {
      if (method === "POST") { startup = JSON.parse(String(init!.body)).startOnProxyStart; if (uncertain) throw new TypeError("uncertain response"); }
      return Response.json({ ok: true, settings: { startOnProxyStart: startup, revision: (startup ? "b" : "a").repeat(64) } });
    }
    if (method === "POST") { trusted = true; if (uncertain) throw new TypeError("uncertain response"); return Response.json({ ok: true }); }
    return Response.json(url.endsWith("/certificate") ? { ok: true, certificate: { supported: true, state: trusted ? "trusted" : certificateState ?? "prepared", busy: null,
      fingerprint: (url.startsWith("/second") ? "B" : "A").repeat(64) } } : { ok: true, runtime: { supported: true, phase: usagePhase ? "running" : "off", running: !!usagePhase,
        ...(buildAssessment !== undefined ? { buildAssessment } : {}),
        ...(usagePhase ? { usage: { mode: "observe", phase: usagePhase, outputs: 0, appCacheConfirmed: false, ...(observation ? { observation } : {}) } } : {}), ...runtimeExtras } });
  }) as typeof fetch;
}
async function mount(apiBase = "") {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await render(apiBase); return container;
}
async function render(apiBase: string, connected = false) {
  await act(async () => { root!.render(<StrictMode><LanguageProvider><CodexDesktopCompatibility apiBase={apiBase} active connected={connected} /></LanguageProvider></StrictMode>); });
}
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const value = [...container.querySelectorAll("button")].find(node => node.textContent === text);
  if (!value) throw new Error("Missing button: " + text); return value;
}
async function chooseAndConfirm(container: HTMLElement) {
  await act(async () => button(container, "Register trust").click());
  expect(requests.filter(req => req.method === "POST")).toHaveLength(0);
  expect(button(container, "Confirm action").disabled).toBe(true);
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  await act(async () => button(container, "Confirm action").click());
}
test("StrictMode status reads are inert and a fingerprint-bound action needs explicit consent", async () => {
  server(); const container = await mount();
  expect(button(container, "Register trust").disabled).toBe(false);
  expect(requests.every(req => req.method === "GET")).toBe(true);
  await chooseAndConfirm(container);
  const posts = requests.filter(req => req.method === "POST"); expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ action: "trust", confirmed: true, fingerprint: "A".repeat(64) });
  expect(button(container, "Start observation").disabled).toBe(false);
  await act(async () => button(container, "Start observation").click());
  expect(requests.filter(req => req.method === "POST").at(-1)?.body).toEqual({ action: "start", confirmed: true });
  expect(container.querySelector("fieldset")).toBeNull();
});

test.each(["expired-awaiting-original-response", "observing-awaiting-original-response"])("%s does not claim the native cache has reverted", async phase => {
  server(false, "trusted", phase); const container = await mount();
  expect(container.textContent).toContain("Stopping correction does not immediately reset the Codex display.");
  expect(container.textContent).toContain("this panel cannot confirm that refresh.");
  expect(requests.every(req => req.method === "GET")).toBe(true);
});

test("observed response counts are displayed without claiming a native process or recovered composer", async () => {
  server(false, "trusted", "observing", { jsonSnapshots: 2, streamSnapshots: 3, validatedActiveStreams: 1, lastSnapshotAt: 1000,
    sourceProcessVerified: false, composerRecoveryVerified: false });
  const container = await mount();
  expect(container.textContent).toContain("JSON 2, SSE 3; active bound streams: 1");
  expect(container.textContent).toContain("Counts do not identify the sending process or prove composer recovery.");
  expect(requests.every(req => req.method === "GET")).toBe(true);
});

test("trial confirmation explains delayed native refresh before any correction request", async () => {
  server(false, "trusted", "observing"); const container = await mount();
  expect(container.textContent).not.toContain("Stopping correction does not immediately reset the Codex display.");
  await act(async () => button(container, "Run 3-minute trial").click());
  expect(container.querySelector("fieldset")?.textContent).toContain("Codex must receive fresh usage data");
  expect(button(container, "Confirm action").disabled).toBe(true);
  expect(requests.every(req => req.method === "GET")).toBe(true);
});
test.each([{ supportedActivationLifetimes: undefined }, { supportedActivationLifetimes: ["trial"] }])("session selection requires an explicit server capability advertisement: %j", async ({ supportedActivationLifetimes }) => {
  server(false, "trusted", "observing", undefined, undefined,
    supportedActivationLifetimes === undefined ? {} : { supportedActivationLifetimes });
  const container = await mount();
  expect(container.textContent).not.toContain("Use until compatibility service stops");
  expect(button(container, "Run 3-minute trial").disabled).toBe(false);
  await act(async () => button(container, "Run 3-minute trial").click());
  await act(async () => (container.querySelector("fieldset input[type=checkbox]") as HTMLInputElement).click());
  await act(async () => button(container, "Confirm action").click());
  expect(requests.filter(req => req.method === "POST").map(req => req.body)).toEqual([{ action: "apply", confirmed: true, accountWideConsent: true }]);
});
test("session selection needs its own explicit account-wide consent and binds the requested lifetime", async () => {
  server(false, "trusted", "observing", undefined, undefined, { supportedActivationLifetimes: ["trial", "runtime-session"] });
  const container = await mount();
  await act(async () => button(container, "Use until compatibility service stops").click());
  const text = container.querySelector("fieldset")?.textContent;
  for (const phrase of ["whole signed-in account, across models", "Usage, credits and server limits remain unchanged", "Recovery and renewed exhaustion are handled automatically",
    "package identity or routing checks fail", "certificate safety deadline", "Restarting does not reactivate it"])
    expect(text).toContain(phrase);
  expect(button(container, "Confirm action").disabled).toBe(true);
  expect(requests.every(req => req.method === "GET")).toBe(true);
  await act(async () => (container.querySelector("fieldset input[type=checkbox]") as HTMLInputElement).click());
  await act(async () => button(container, "Confirm action").click());
  expect(requests.filter(req => req.method === "POST").map(req => req.body))
    .toEqual([{ action: "apply", confirmed: true, accountWideConsent: true, lifetime: "runtime-session" }]);
});
test("switching trial to session clears trial consent", async () => {
  server(false, "trusted", "observing", undefined, undefined, { supportedActivationLifetimes: ["trial", "runtime-session"] });
  const container = await mount();
  await act(async () => button(container, "Run 3-minute trial").click());
  await act(async () => (container.querySelector("fieldset input[type=checkbox]") as HTMLInputElement).click());
  expect(button(container, "Confirm action").disabled).toBe(false);
  await act(async () => button(container, "Use until compatibility service stops").click());
  expect(button(container, "Confirm action").disabled).toBe(true);
  expect(requests.every(req => req.method === "GET")).toBe(true);
});
test("withdrawn session support disables a previously acknowledged confirmation", async () => {
  server(false, "trusted", "observing", undefined, undefined, { supportedActivationLifetimes: ["trial", "runtime-session"] });
  const container = await mount();
  await act(async () => button(container, "Use until compatibility service stops").click());
  await act(async () => (container.querySelector("fieldset input[type=checkbox]") as HTMLInputElement).click());
  expect(button(container, "Confirm action").disabled).toBe(false);
  await act(async () => setClientResourceData("desktop-compatibility-runtime:", {
    supported: true, phase: "running", running: true, supportedActivationLifetimes: ["trial"],
  }));
  expect(button(container, "Confirm action").disabled).toBe(true);
  expect(container.querySelector("fieldset [role=alert]")?.textContent).toContain("has not confirmed support for session activation");
  expect(requests.every(req => req.method === "GET")).toBe(true);
});
test("a rejected session request is sent once and does not start a trial", async () => {
  server(false, "trusted", "observing", undefined, undefined, { supportedActivationLifetimes: ["trial", "runtime-session"] });
  const read = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") {
      requests.push({ url: String(input), method: "POST", body: JSON.parse(String(init.body)) });
      return Response.json({ ok: false, error: "invalid_lifetime" }, { status: 400 });
    }
    return read(input, init);
  }) as typeof fetch;
  const container = await mount();
  await act(async () => button(container, "Use until compatibility service stops").click());
  await act(async () => (container.querySelector("fieldset input[type=checkbox]") as HTMLInputElement).click());
  await act(async () => button(container, "Confirm action").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("no trial was started instead");
  expect(requests.filter(req => req.method === "POST").map(req => req.body))
    .toEqual([{ action: "apply", confirmed: true, accountWideConsent: true, lifetime: "runtime-session" }]);
});
test("armed session waiting is shown separately from correction and native recovery proof", async () => {
  server(false, "trusted", "observing", undefined, undefined, { supportedActivationLifetimes: ["trial", "runtime-session"], safetyDeadline: 1770000000000,
    usage: { mode: "apply", phase: "session-awaiting-eligible-usage", activationLifetime: "runtime-session", outputs: 0, appCacheConfirmed: false } });
  const container = await mount();
  expect(container.textContent).toContain("Session armed: waiting for eligible exhaustion evidence.");
  expect(container.textContent).toContain("This phase does not confirm response changes or composer recovery.");
  expect(container.textContent).toContain("Only eligible exhausted usage responses may be adjusted.");
  expect(container.textContent).toContain("Certificate safety deadline");
  expect(container.textContent).toContain(new Date(1770000000000).toLocaleString("en"));
  expect(container.textContent).not.toContain("For up to 3 minutes, two UI flags are adjusted");
  expect(requests.every(req => req.method === "GET")).toBe(true);
});

test.each([
  ["prepared", false, true], ["trusted", true, true], ["expired", true, true], ["renewal-required", true, true], ["unknown", true, false], ["invalid", false, false],
] as const)("certificate state %s exposes only supported cleanup and renewal actions", async (state, remove, renew) => {
  server(false, state); const container = await mount();
  const labels = [...container.querySelectorAll("button")].map(value => value.textContent);
  expect(labels.includes("Remove trust")).toBe(remove); expect(labels.includes("Renew certificate")).toBe(renew);
  if (state === "renewal-required") expect(labels.includes("Start observation")).toBe(false);
  expect(requests.filter(value => value.method === "POST")).toHaveLength(0);
});
test("a lost write response disables replay until a fresh read proves the actual state", async () => {
  server(true); const container = await mount(); await chooseAndConfirm(container);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(requests.filter(req => req.method === "POST")).toHaveLength(1);
  await act(async () => button(container, "Refresh status").click());
  expect(button(container, "Start observation").disabled).toBe(false);
  expect(requests.filter(req => req.method === "POST")).toHaveLength(1);
});
test("changing target drops an outstanding certificate confirmation", async () => {
  server(); const container = await mount();
  await act(async () => button(container, "Register trust").click());
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  await render("/second");
  expect(container.querySelector("fieldset")).toBeNull(); expect(container.textContent).toContain("B".repeat(64));
  expect(requests.filter(req => req.method === "POST")).toHaveLength(0);
});
test("managed client mode never falls back to mutating the shared hub", async () => {
  server(); const container = await mount(); requests.length = 0;
  await render("/machine", true);
  expect(container.textContent).toContain("unavailable in OpenCodex managed client mode");
  expect(requests).toHaveLength(0); expect(container.querySelector("button")).toBeNull();
});
test("a completed legacy build assessment shows reference and last observed versions without claiming support", async () => {
  server(false, "trusted", undefined, undefined,
    { assessedVersion: "26.924.2738.0", observedVersion: "26.1007.9446.0", verified: false, completedAt: 1770000000000, privatePath: "fixture-secret" });
  const container = await mount();
  expect(container.textContent).toContain("Previously reviewed version (reference)");
  expect(container.textContent).toContain("Last observed package version");
  expect(container.textContent).not.toContain("Installed package version");
  expect(container.textContent).toContain("26.924.2738.0");
  expect(container.textContent).toContain("26.1007.9446.0");
  expect(container.textContent).toContain(new Date(1770000000000).toLocaleString("en"));
  expect(container.textContent).not.toContain("fixture-secret");
  expect(container.textContent).not.toContain("Not detected");
  expect(container.textContent).not.toContain("Last check confirmed package identity");
});
test.each([true, false])("package identity verification %s stays separate from response and composer proof", async verified => {
  server(false, "trusted", "observing", undefined,
    { assessedVersion: "26.924.2738.0", observedVersion: "26.1007.9446.0", verified, completedAt: 1770000000000, verificationBasis: "package-identity" });
  const container = await mount();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Previously reviewed version (reference)");
  expect(container.textContent).toContain("26.1007.9446.0");
  expect(container.textContent).toContain(verified ? "Last check confirmed package identity. Version is diagnostic; this does not verify response handling or composer recovery."
    : "Last check did not confirm package identity. Correction requires a verified package identity.");
  expect(container.textContent).not.toContain("An unreviewed app version cannot run a correction trial");
  expect(button(container, "Run 3-minute trial").disabled).toBe(false);
  expect(requests.every(req => req.method === "GET")).toBe(true);
});
test("a build assessment without an observed version reports detection, not verification", async () => {
  server(false, "trusted", undefined, undefined,
    { assessedVersion: "26.924.2738.0", observedVersion: null, verified: false, completedAt: 1770000000000 });
  const container = await mount();
  expect(container.textContent).toContain("Last observed package version");
  expect(container.textContent).toContain("Not detected");
  expect(container.textContent).toContain(new Date(1770000000000).toLocaleString("en"));
});
test("no probe result hides the build version rows", async () => {
  server(false, "trusted");
  const container = await mount();
  expect(container.textContent).not.toContain("Last observed package version");
  expect(container.textContent).not.toContain("Observed at");
});
test("a stopped runtime still presents a stale verified check as a past observation, not current proof", async () => {
  server(false, "trusted", undefined, undefined,
    { assessedVersion: "26.924.2738.0", observedVersion: "26.924.2738.0", verified: true, completedAt: 1770000000000 });
  const container = await mount();
  expect(container.textContent).toContain("Last observed package version");
  expect(container.textContent).toContain(new Date(1770000000000).toLocaleString("en"));
  expect(container.textContent).not.toContain("Installed package version");
  expect(container.textContent).not.toContain("currently installed");
});
test("auto-start toggle writes once with the displayed revision and rechecks the saved state", async () => {
  server(); const container = await mount();
  const toggle = button(container, "Resume observation when OpenCodex starts");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  const posts = requests.filter(req => req.method === "POST"); expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toEndWith("/settings"); expect(posts[0]!.body).toEqual({ confirmed: true, startOnProxyStart: true, revision: "a".repeat(64) });
  expect(requests.some(req => req.method === "POST" && req.url.endsWith("/runtime"))).toBe(false);
});
test("an uncertain auto-start write is not replayed and refresh recovers its committed state", async () => {
  server(true); const container = await mount();
  const toggle = button(container, "Resume observation when OpenCodex starts");
  await act(async () => toggle.click()); expect(toggle.disabled).toBe(true);
  const setting = toggle.closest(".panel")!;
  await act(async () => button(setting as HTMLElement, "Refresh status").click());
  expect(toggle.disabled).toBe(false); expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(requests.filter(req => req.method === "POST")).toHaveLength(1);
});
