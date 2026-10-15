const { basename } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const cp = require('node:child_process');
const started = performance.now();
function event(data) { console.error('PROFILE ' + JSON.stringify({ atMs: Math.round(performance.now() - started), ...data })); }
function wrap(target, name) {
  const original = target[name];
  target[name] = function (...args) {
    const at = performance.now();
    const command = typeof args[0] === 'string' ? args[0] : (args[0]?.cmd ?? args[0] ?? [])[0];
    const stack = new Error().stack.split('\n').slice(2, 6).map(s => s.trim());
    event({ kind: 'begin', api: name, exe: basename(command ?? ''), stack });
    try {
      const result = original.apply(this, args);
      if (name === 'spawn') result.exited?.then(() => event({ kind: 'exited', api: name, exe: basename(command ?? ''), durationMs: Math.round(performance.now() - at) }));
      return result;
    } finally { event({ kind: 'return', api: name, exe: basename(command ?? ''), durationMs: Math.round(performance.now() - at) }); }
  };
}
for (const name of ['spawnSync', 'execFileSync', 'execSync']) wrap(cp, name);
syncBuiltinESMExports();
wrap(Bun, 'spawnSync');
wrap(Bun, 'spawn');
event({ kind: 'preload' });
