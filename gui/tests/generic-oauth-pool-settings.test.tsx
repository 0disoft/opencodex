import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import AnthropicAccountPoolSettings from "../src/components/provider-workspace/AnthropicAccountPoolSettings";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoots: Root[];

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

function setupDom(): void {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoots = [];
}

async function teardownDom(): Promise<void> {
  for (const root of mountedRoots) {
    await act(async () => {
      root.unmount();
    });
  }
  mountedRoots = [];
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
}

type PoolPayload = {
  enabled: boolean;
  autoSwitchThreshold: number;
  strategy: string;
  stickyLimit: number;
  supported?: string[];
};

function stubPool(initial: PoolPayload): { gets: string[]; puts: Record<string, unknown>[] } {
  const puts: Record<string, unknown>[] = [];
  const gets: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/pool/settings") && init?.method === "PUT") {
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      puts.push(body);
      return new Response(JSON.stringify({
        ...body,
        supported: ["enabled", "strategy", "stickyLimit", "autoSwitchThreshold"],
      }), { status: 200 });
    }
    if (url.includes("/api/pool/settings")) {
      gets.push(url);
      return new Response(JSON.stringify({
        ...initial,
        supported: initial.supported ?? ["enabled", "strategy", "stickyLimit", "autoSwitchThreshold"],
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  }) as typeof fetch;
  return { gets, puts };
}

async function mountPool(accountCount = 2): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <AnthropicAccountPoolSettings
          apiBase="http://proxy"
          accountCount={accountCount}
          provider="google-antigravity"
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
  setupDom();
});

afterEach(async () => {
  await teardownDom();
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

describe("generic OAuth account pool settings", () => {
  test("loads google-antigravity through the unified pool settings contract", async () => {
    const { gets } = stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    const host = await mountPool();

    expect(gets.some((url) => url.includes("provider=google-antigravity"))).toBe(true);
    expect(host.textContent).toContain("Account pool");
    expect(host.querySelector("#google-antigravity-pool-quota-window")).toBeNull();
    expect(host.textContent).not.toContain("Quota window");
  });

  test("renders minimal strategy status info for generic providers", async () => {
    stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    const host = await mountPool();
    expect(host.textContent).toContain("Quota");
  });

  test("supports soonest reset strategy for generic providers", async () => {
    stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "reset-first",
      stickyLimit: 1,
    });
    const host = await mountPool();
    expect(host.textContent).toContain("Soonest reset first");
    expect(host.textContent).toContain("Consumes the account whose 7-day weekly allowance resets earliest");
  });

  test("renders fill-first strategy for generic providers", async () => {
    stubPool({
      enabled: true,
      autoSwitchThreshold: 90,
      strategy: "fill-first",
      stickyLimit: 1,
    });
    const host = await mountPool();
    expect(host.textContent).toContain("Fill-first");
  });

  test("omits quotaWindow from generic saves", async () => {
    const { puts } = stubPool({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    const host = await mountPool();
    const toggle = host.querySelector<HTMLButtonElement>("button.toggle");
    if (!toggle) throw new Error("toggle missing");

    await act(async () => {
      toggle.click();
      await flush();
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({
      provider: "google-antigravity",
      enabled: false,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    expect(puts[0]).not.toHaveProperty("quotaWindow");
  });

  test("keeps the proactive toggle off until two accounts exist", async () => {
    stubPool({
      enabled: false,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
    const host = await mountPool(1);
    const toggle = host.querySelector<HTMLButtonElement>("button.toggle");
    if (!toggle) throw new Error("toggle missing");
    expect(toggle.disabled).toBe(true);
    expect(host.textContent).toContain("at least two OAuth accounts");
  });
})

  test(
    "ignores stale GET and PUT completions after switching providers",
    async () => {
      const strategies: Record<string, string> = { "provider-a": "quota", "provider-b": "reset-first" };
      const payload = (provider: string) => ({ enabled: true, autoSwitchThreshold: 80, strategy: strategies[provider], stickyLimit: 1, supported: ["enabled", "strategy", "stickyLimit", "autoSwitchThreshold"] });
      const pendingGets = new Map<string, (v: Response) => void>();
      const pendingPuts = new Map<string, { resolve: (v: Response) => void; body: Record<string, unknown> }>();
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const params = new URL(url, "http://proxy").searchParams;
        if (url.includes("/api/pool/settings") && init?.method === "PUT") {
          const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
          const key = typeof body.provider === "string" ? (body.provider as string) : (params.get("provider") ?? "");
          return new Promise<Response>((resolve) => { pendingPuts.set(key, { resolve, body }); });
        }
        if (url.includes("/api/pool/settings")) {
          const provider = params.get("provider") ?? "";
          if (provider === "provider-a") return new Promise<Response>((resolve) => { pendingGets.set(provider, resolve); });
          return new Response(JSON.stringify(payload(provider)), { status: 200 });
        }
        throw new Error("unexpected fetch: " + url);
      }) as typeof fetch;

      const host = testWindow.document.createElement("div");
      testWindow.document.body.appendChild(host as never);
      const { createRoot } = await import("react-dom/client");
      let root: Root | null = null;
      const renderProvider = async (provider: string) => {
        await act(async () => {
          if (!root) { root = createRoot(host); mountedRoots.push(root); }
          root.render(
            <LanguageProvider>
              <AnthropicAccountPoolSettings apiBase="http://proxy" accountCount={2} provider={provider} />
            </LanguageProvider>,
          );
        });
        await act(async () => { await flush(); });
      };
      const strategyLabel = (): string | null => {
        const cands = [...testWindow.document.querySelectorAll("button")] as HTMLButtonElement[];
        const el = cands.find((b) => (b.id || "").slice(-9) === "-strategy");
        return el ? (el.textContent ?? "") : null;
      };
      const poolToggle = (): HTMLButtonElement | null => host.querySelector("button.toggle");

      await renderProvider("provider-a");
      await renderProvider("provider-b");
      expect(strategyLabel()).toBe("Soonest reset first");
      const resolveA = pendingGets.get("provider-a");
      if (!resolveA) throw new Error("A GET was never issued");
      await act(async () => {
        resolveA(new Response(JSON.stringify(payload("provider-a")), { status: 200 }));
        await flush();
      });
      expect(strategyLabel()).toBe("Soonest reset first");

      const toggle = poolToggle();
      if (!toggle) throw new Error("toggle missing");
      await act(async () => { toggle.click(); await flush(); });
      const put = pendingPuts.get("provider-b");
      if (!put) throw new Error("B PUT was never issued");
      await renderProvider("provider-a");
      expect(strategyLabel()).toBeNull();
      const resolveA2 = pendingGets.get("provider-a");
      if (!resolveA2) throw new Error("second A GET was never issued");
      await act(async () => {
        resolveA2(new Response(JSON.stringify(payload("provider-a")), { status: 200 }));
        await flush();
      });
      expect(strategyLabel()).toBe("Quota");
      expect(poolToggle()?.getAttribute("aria-pressed")).toBe("true");
      await act(async () => {
        put.resolve(new Response(JSON.stringify({ ...put.body, supported: payload("provider-b").supported }), { status: 200 }));
        await flush();
      });
      expect(strategyLabel()).toBe("Quota");
      expect(poolToggle()?.getAttribute("aria-pressed")).toBe("true");
    },
  );

describe("generic pool card in the OAuth account list", () => {
  type Stored = { enabled: boolean; strategy: string; inert?: boolean };

  /** A server that keeps the stored settings and answers every write with the full DTO. */
  function stubPoolServer(stored: Stored): { puts: Record<string, unknown>[]; reads: string[] } {
    const puts: Record<string, unknown>[] = [];
    const reads: string[] = [];
    const dto = () => ({ kind: "generic", supported: ["enabled", "strategy", "stickyLimit", "autoSwitchThreshold"], ...stored });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/api/pool/settings")) return new Response("{}", { status: 200 });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push(body);
        if (typeof body.enabled === "boolean") stored.enabled = body.enabled;
        if (typeof body.strategy === "string") stored.strategy = body.strategy;
      } else {
        reads.push(url);
      }
      return new Response(JSON.stringify(dto()), { status: 200 });
    }) as typeof fetch;
    return { puts, reads };
  }

  async function mountPanel(provider: string): Promise<HTMLElement> {
    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    const { default: ProviderAuthPanel } = await import("../src/components/provider-workspace/ProviderAuthPanel");
    const noop = () => {};
    await act(async () => {
      const root = createRoot(host);
      mountedRoots.push(root);
      root.render(
        <LanguageProvider>
          <ProviderAuthPanel
            item={{ name: provider, adapter: "openai-responses", authMode: "oauth", hasApiKey: false } as never}
            apiBase="http://proxy"
            accounts={[
              { id: "a", email: "a@example.test", active: true },
              { id: "b", email: "b@example.test", active: false },
            ] as never}
            authHandlers={{
              onLogin: noop, onLogout: noop, onReauth: noop, onSwitchAccount: noop, onRemoveAccount: noop,
              onPauseAccount: noop, onAddApiKey: async () => true, onSwitchApiKey: noop, onRemoveApiKey: noop, onEditAlias: noop,
            }}
          />
        </LanguageProvider>,
      );
    });
    await act(async () => { await flush(); });
    return host as unknown as HTMLElement;
  }

  const card = (host: HTMLElement) => host.querySelector<HTMLElement>(".anthropic-pool-card");
  const cardToggle = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".anthropic-pool-card button.toggle");
  const strategyButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(`#${"kiro"}-strategy, #google-antigravity-strategy`);

  test("a generic OAuth provider gets the pool card from the unified contract", async () => {
    const { reads } = stubPoolServer({ enabled: true, strategy: "quota", inert: false });
    const host = await mountPanel("google-antigravity");
    expect(card(host)?.textContent).toContain("Account pool");
    expect(reads).toEqual(["http://proxy/api/pool/settings?provider=google-antigravity"]);
  });

  test("a strategy the runtime does not consume is shown as saved, not selectable as live", async () => {
    stubPoolServer({ enabled: true, strategy: "round-robin", inert: true });
    const host = await mountPanel("google-antigravity");
    const select = strategyButton(host);
    if (!select) throw new Error("strategy select missing");
    expect(select.disabled).toBe(true);
    expect(select.textContent).toBe("Round-robin");
    expect(card(host)?.textContent).toContain("Saved, not live");
  });

  test("a live pool keeps the strategy selectable and carries no stored-only marker", async () => {
    stubPoolServer({ enabled: true, strategy: "reset-first", inert: false });
    const host = await mountPanel("google-antigravity");
    const select = strategyButton(host);
    if (!select) throw new Error("strategy select missing");
    expect(select.disabled).toBe(false);
    expect(select.textContent).toBe("Soonest reset first");
    expect(card(host)?.textContent).not.toContain("Saved, not live");
  });

  test("toggling the pool never rewrites a stored strategy this dashboard does not model", async () => {
    const stored: Stored = { enabled: true, strategy: "least-loaded", inert: false };
    const { puts } = stubPoolServer(stored);
    const host = await mountPanel("kiro");
    expect(strategyButton(host)?.textContent).toBe("least-loaded");

    await act(async () => { cardToggle(host)?.click(); await flush(); });
    await act(async () => { cardToggle(host)?.click(); await flush(); });

    expect(puts).toHaveLength(2);
    expect(puts.map(put => put.enabled)).toEqual([false, true]);
    for (const put of puts) expect(put).not.toHaveProperty("strategy");
    expect(stored.strategy).toBe("least-loaded");
    expect(strategyButton(host)?.textContent).toBe("least-loaded");
  });
  test("explicitly choosing quota replaces a CLI-only least-loaded strategy", async () => {
    const stored: Stored = { enabled: true, strategy: "least-loaded", inert: false };
    const { puts } = stubPoolServer(stored);
    const host = await mountPanel("kiro");
    await act(async () => { strategyButton(host)?.click(); });
    const quota = Array.from(testWindow.document.querySelectorAll('[role="option"]'))
      .find(option => option.textContent === "Quota");
    expect(quota).toBeDefined();
    await act(async () => { (quota as unknown as HTMLButtonElement).click(); await flush(); });
    expect(puts).toHaveLength(1);
    expect(puts[0].strategy).toBe("quota");
    expect(stored.strategy).toBe("quota");
  });

});
