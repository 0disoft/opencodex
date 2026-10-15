import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const repo = resolve(process.argv[2] ?? '.');
for (let run = 1; run <= 3; run++) {
  const root = mkdtempSync(join(tmpdir(), 'ocx-start-profile-'));
  const home = join(root, 'home'), ocx = join(root, 'ocx'), codex = join(root, 'codex');
  for (const dir of [home, ocx, codex]) mkdirSync(dir);
  writeFileSync(join(ocx, 'config.json'), JSON.stringify({ port: 0, hostname: '127.0.0.1', codexAutoStart: false, syncResumeHistory: false, checkForUpdates: false, clientIntegrations: { codex: false, grok: false, 'claude-desktop': false }, claudeCode: { systemEnv: false }, providers: {}, defaultProvider: 'openai' }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocx, CODEX_HOME: codex, OCX_OWNER_REGISTRY_DIR: join(root, 'registry'), NO_PROXY: '127.0.0.1,localhost' };
  const started = performance.now();
  console.log(JSON.stringify({ run, kind: 'start', platform: process.platform }));
  const child = Bun.spawn([process.execPath, '--preload', resolve('scripts/diagnostics/startup-profile-preload.cjs'), join(repo, 'src/cli/index.ts'), 'start'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const drain = async (stream: ReadableStream<Uint8Array>, channel: string) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) console.log(JSON.stringify({ run, atMs: Math.round(performance.now() - started), channel, text: decoder.decode(bytes) }));
  };
  const drains = [drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr')];
  const deadline = Date.now() + 120_000;
  try {
    while (Date.now() < deadline && child.exitCode === null) {
      const path = join(ocx, 'runtime-port.json');
      if (existsSync(path)) {
        const runtime = JSON.parse(readFileSync(path, 'utf8'));
        console.log(JSON.stringify({ run, kind: 'runtime', atMs: Math.round(performance.now() - started) }));
        const response = await fetch(`http://127.0.0.1:${runtime.port}/healthz`, { signal: AbortSignal.timeout(5000) });
        console.log(JSON.stringify({ run, kind: 'health', status: response.status, atMs: Math.round(performance.now() - started) }));
        break;
      }
      await Bun.sleep(20);
    }
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await child.exited;
    clearTimeout(timer);
    await Promise.all(drains);
  }
}
