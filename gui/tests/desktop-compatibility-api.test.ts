import { afterEach, expect, test } from "bun:test";
import { parseCompatibilityCertificate, parseCompatibilityRuntime, runCompatibilityAction } from "../src/desktop-compatibility-api";
import { DICTS } from "../src/i18n/catalogs";
const originalFetch = globalThis.fetch;
test("observation counters never upgrade response observations into native recovery proof", () => {
  const observation = { jsonSnapshots: 1, streamSnapshots: 3, validatedActiveStreams: 1, lastSnapshotAt: 1000,
    sourceProcessVerified: false, composerRecoveryVerified: false };
  const status = { supported: true, phase: "running", running: true,
    usage: { mode: "observe", phase: "observing", outputs: 0, appCacheConfirmed: false, observation } };
  expect(parseCompatibilityRuntime(status).usage?.observation).toEqual(observation);
  for (const invalid of [{ ...observation, sourceProcessVerified: true }, { ...observation, composerRecoveryVerified: true },
    { ...observation, streamSnapshots: -1 }, { ...observation, jsonSnapshots: "1" }, { ...observation, lastSnapshotAt: Infinity }]) {
    expect(() => parseCompatibilityRuntime({ ...status, usage: { ...status.usage, observation: invalid } })).toThrow("invalid_runtime_status");
  }
});
afterEach(() => { globalThis.fetch = originalFetch; });
test("status projection excludes private/unknown data and rejects coerced states", () => {
  const certificate = parseCompatibilityCertificate({ supported: true, state: "trusted", busy: null, fingerprint: "A".repeat(64), privateKey: "fixture-secret" });
  expect(JSON.stringify(certificate)).not.toContain("fixture-secret");
  expect(() => parseCompatibilityCertificate({ supported: true, state: ["trusted"], busy: null })).toThrow();
  expect(() => parseCompatibilityRuntime({ supported: true, phase: "off", running: true })).toThrow();
  expect(() => parseCompatibilityRuntime({ supported: true, phase: ["running"], running: true })).toThrow();
  expect(parseCompatibilityRuntime({ supported: true, phase: "running", running: true, contextFailure: "native_routing_unverified" }).contextFailure).toBe("native_routing_unverified");
  expect(() => parseCompatibilityRuntime({ supported: true, phase: "running", running: true, contextFailure: "untrusted-arbitrary-message" })).toThrow();
});
test("certificate actions bind the displayed fingerprint and never retry uncertain writes", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_input, init) => { calls.push(init!); throw new TypeError("connection lost"); }) as typeof fetch;
  await expect(runCompatibilityAction("", { target: "certificate", action: "trust", fingerprint: "A".repeat(64) }, new AbortController().signal)).rejects.toThrow();
  expect(calls).toHaveLength(1);
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ action: "trust", confirmed: true, fingerprint: "A".repeat(64) });
  await expect(runCompatibilityAction("", { target: "certificate", action: "renew" }, new AbortController().signal)).rejects.toThrow("certificate_fingerprint_required");
  expect(calls).toHaveLength(1);
});
test("only the deliberate apply action carries account-wide consent", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input, init) => { bodies.push(JSON.parse(String(init!.body))); return Response.json({ ok: true }); }) as typeof fetch;
  await runCompatibilityAction("", { target: "runtime", action: "start" }, new AbortController().signal);
  await runCompatibilityAction("", { target: "runtime", action: "apply" }, new AbortController().signal);
  expect(bodies).toEqual([{ action: "start", confirmed: true }, { action: "apply", confirmed: true, accountWideConsent: true }]);
});
test("session activation carries the explicit lifetime and never silently falls back to a trial", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init!.body)));
    return Response.json({ ok: false, error: "invalid_lifetime" }, { status: 400 });
  }) as typeof fetch;
  await expect(runCompatibilityAction("", { target: "runtime", action: "apply", lifetime: "runtime-session" }, new AbortController().signal)).rejects.toThrow("invalid_lifetime");
  expect(bodies).toEqual([{ action: "apply", confirmed: true, accountWideConsent: true, lifetime: "runtime-session" }]);
});
test("runtime activation capabilities, lifetime and certificate deadline stay optional and strictly typed", () => {
  const base = { supported: true, phase: "running", running: true };
  const usage = { mode: "apply", phase: "session-awaiting-eligible-usage", outputs: 0, appCacheConfirmed: false };
  expect(parseCompatibilityRuntime(base)).toEqual(base);
  const status = { ...base, supportedActivationLifetimes: ["trial", "runtime-session"], safetyDeadline: 1770000000000,
    usage: { ...usage, activationLifetime: "runtime-session" } };
  expect(parseCompatibilityRuntime(status)).toEqual(status);
  expect(parseCompatibilityRuntime({ ...base, supportedActivationLifetimes: ["trial"] }).supportedActivationLifetimes).toEqual(["trial"]);
  for (const activationLifetime of ["trial", "runtime-session", null])
    expect(parseCompatibilityRuntime({ ...base, usage: { ...usage, activationLifetime } }).usage?.activationLifetime).toBe(activationLifetime);
  for (const supportedActivationLifetimes of [null, "runtime-session", ["permanent"], ["trial", "trial"], [true], ["trial", "runtime-session", "next"]])
    expect(() => parseCompatibilityRuntime({ ...base, supportedActivationLifetimes })).toThrow("invalid_runtime_status");
  for (const activationLifetime of ["permanent", true, ["runtime-session"]])
    expect(() => parseCompatibilityRuntime({ ...base, usage: { ...usage, activationLifetime } })).toThrow("invalid_runtime_status");
  for (const safetyDeadline of [null, "1770000000000", -1, 1.5, Infinity, 8.64e15 + 1])
    expect(() => parseCompatibilityRuntime({ ...base, safetyDeadline })).toThrow("invalid_runtime_status");
});
test("legacy build assessment projection is strict, optional and requires the assessed version", () => {
  const base = { supported: true, phase: "off", running: false };
  expect(parseCompatibilityRuntime(base).buildAssessment).toBeUndefined();
  expect(parseCompatibilityRuntime({ ...base, buildAssessment: null }).buildAssessment).toBeNull();
  const assessed = { assessedVersion: "26.924.2738.0", observedVersion: "26.1007.9446.0", verified: false, completedAt: 1770000000000 };
  expect(parseCompatibilityRuntime({ ...base, buildAssessment: assessed }).buildAssessment).toEqual(assessed);
  expect(parseCompatibilityRuntime({ ...base, buildAssessment: { ...assessed, observedVersion: "26.924.2738.0", verified: true } }).buildAssessment?.verified).toBe(true);
  for (const invalid of [{ ...assessed, verified: true }, { ...assessed, assessedVersion: "26.924" }, { ...assessed, observedVersion: "C:\\path" },
    { ...assessed, verified: "true" }, { ...assessed, completedAt: 1.5 }, { ...assessed, completedAt: Infinity },
    { ...assessed, observedVersion: undefined }, { ...assessed, observedVersion: null, verified: true }, "C:\\Program Files\\WindowsApps", 42])
    expect(() => parseCompatibilityRuntime({ ...base, buildAssessment: invalid })).toThrow("invalid_runtime_status");
});
test("package identity assessments retain diagnostic versions without claiming response or composer verification", () => {
  const base = { supported: true, phase: "off", running: false };
  const assessment = { assessedVersion: "26.924.2738.0", observedVersion: "26.1007.9446.0", verified: true,
    completedAt: 1770000000000, verificationBasis: "package-identity" };
  for (const observedVersion of [assessment.observedVersion, assessment.assessedVersion]) {
    const expected = { ...assessment, observedVersion };
    expect(parseCompatibilityRuntime({ ...base, buildAssessment: { ...expected, privatePath: "fixture-secret", composerRecoveryVerified: true } }).buildAssessment).toEqual(expected);
  }
  expect(parseCompatibilityRuntime({ ...base, buildAssessment: { ...assessment, verified: false } }).buildAssessment?.verified).toBe(false);
  expect(parseCompatibilityRuntime({ ...base, buildAssessment: { ...assessment, observedVersion: null, verified: false } }).buildAssessment)
    .toEqual({ ...assessment, observedVersion: null, verified: false });
  expect(() => parseCompatibilityRuntime({ ...base, buildAssessment: { ...assessment, observedVersion: null } })).toThrow("invalid_runtime_status");
  for (const verificationBasis of ["version", "package-identity-v2", "", null, true, ["package-identity"]])
    expect(() => parseCompatibilityRuntime({ ...base, buildAssessment: { ...assessment, observedVersion: assessment.assessedVersion, verificationBasis } })).toThrow("invalid_runtime_status");
  expect(() => parseCompatibilityRuntime({ ...base, buildAssessment: { ...assessment, observedVersion: "not-a-version" } })).toThrow("invalid_runtime_status");
});
test("every supported locale contains the complete compatibility consent namespace", () => {
  const keys = Object.keys(DICTS.en).filter(key => key.startsWith("desktopCompat."));
  expect(keys.length).toBeGreaterThan(20);
  for (const [locale, catalog] of Object.entries(DICTS)) {
    expect(Object.keys(catalog).filter(key => key.startsWith("desktopCompat."))).toEqual(keys);
    for (const key of keys) expect((catalog as Record<string, string>)[key]?.length).toBeGreaterThan(0);
    if (locale !== "en") expect(catalog["desktopCompat.trialRisk"]).not.toBe(DICTS.en["desktopCompat.trialRisk"]);
  }
});
