import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const marker = "oauth-cli-provider-response-marker";
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(repoPath("src", "oauth", name)).href);
const publicMessage = "OAuth authentication failed. Check the OpenCodex account status and retry.";

for (const scenario of [
  { provider: "anthropic", status: 400, body: JSON.stringify({ error: marker }), diagnostic: "HTTP 400" },
  { provider: "anthropic", status: 503, body: marker, diagnostic: "HTTP 503" },
  { provider: "xai", status: 400, body: JSON.stringify({ error: marker, error_description: marker }), diagnostic: "HTTP 400" },
  { provider: "anthropic", status: 200, body: marker, diagnostic: "oauth_authentication_failed" },
]) {
  test(`${scenario.provider} login prints a fixed error for token HTTP ${scenario.status}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-login-errors-"));
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => {
        requests++;
        return new Response(scenario.body, { status: scenario.status });
      },
    });
    const endpoint = JSON.stringify(`http://127.0.0.1:${server.port}/token`);
    const child = Bun.spawn([process.execPath, "--eval", `
      import { handleLogin } from ${moduleUrl("login-cli.ts")};
      import { OAUTH_PROVIDERS } from ${moduleUrl("index.ts")};
      import { AnthropicOAuthFlow } from ${moduleUrl("anthropic.ts")};
      import { postXaiToken } from ${moduleUrl("xai.ts")};
      const localFetch = globalThis.fetch;
      globalThis.fetch = (_input, init) => localFetch(${endpoint}, init);
      OAUTH_PROVIDERS[${JSON.stringify(scenario.provider)}].login = async ctrl => {
        if (${JSON.stringify(scenario.provider)} === "xai") {
          return await postXaiToken(${endpoint}, { grant_type: "authorization_code", code: "test-code" });
        }
        return await new AnthropicOAuthFlow(ctrl).exchangeToken("test-code", "test-state", "http://127.0.0.1/callback");
      };
      await handleLogin(${JSON.stringify(scenario.provider)}, { ask: async () => "" });
    `], {
      cwd: repoRoot(),
      env: { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(requests).toBe(1);
      expect(stderr).not.toContain(marker);
      expect(stderr.trim()).toBe(`❌ OAuth login failed (${scenario.diagnostic}): ${publicMessage}`);
      expect(code).toBe(1);
      expect(stdout).not.toContain("Logged in");
    } finally {
      child.kill();
      await child.exited;
      await server.stop(true);
      removeTreeWithRetry(home);
    }
  });
}

test("a non-Error login rejection prints fixed text and exits unsuccessfully", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-login-rejection-"));
  const child = Bun.spawn([process.execPath, "--eval", `
    import { handleLogin } from ${moduleUrl("login-cli.ts")};
    await handleLogin("anthropic", {
      ask: async () => "",
      runLogin: async () => { throw ${JSON.stringify(marker)}; },
    });
  `], {
    cwd: repoRoot(),
    env: { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).not.toContain(marker);
    expect(stderr.trim()).toBe(`❌ OAuth login failed (oauth_authentication_failed): ${publicMessage}`);
    expect(code).toBe(1);
    expect(stdout).not.toContain("Logged in");
  } finally {
    child.kill();
    await child.exited;
    removeTreeWithRetry(home);
  }
});
