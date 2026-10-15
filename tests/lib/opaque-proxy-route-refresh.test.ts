import {afterEach, test} from 'bun:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {createOwnedIngressManager} from '../../src/lib/opaque-proxy-lifecycle/managed-session';
import {snapshotProxyRoutes} from '../../src/lib/opaque-proxy-tunnel';
import {TunnelFixtureScope, httpProxy, target, allowTarget, until, wait} from '../helpers/opaque-proxy-tunnel';
const scope = new TunnelFixtureScope();
afterEach(() => scope.close());
const authorization = 'Basic ' + Buffer.from('session:synthetic-route-refresh-capability').toString('base64');
async function fixture(maxActive = 16) {
  const first = await httpProxy(scope), second = await httpProxy(scope), owner = {};
  const manager = createOwnedIngressManager({owner, candidates:[first.candidate], allowTarget,
    ingress:{maxActive, sessionMs:10000, totalMs:10000, idleMs:5000}, manager:{sessionMs:15000}});
  scope.after(() => manager.shutdown(owner));
  const lease = await manager.start(owner, {authorized:true, authorization});
  async function connect(auth = authorization) {
    const socket = scope.own(net.connect(lease.port, lease.host));
    let output = '';
    socket.on('data', bytes => output += bytes.toString());
    await once(socket, 'connect');
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    return {socket, output:() => output};
  }
  return {first, second, owner, manager, lease, connect};
}
test('refresh keeps endpoint and established stream, routes only the next connection', async () => {
  const x = await fixture(), old = await x.connect();
  await until(() => old.output().includes('200'));
  old.socket.write('before'); await until(() => old.output().endsWith('before'));
  assert.equal(x.manager.updateRoutes(x.owner, {...x.manager.routeVersion(), revision:0}, [x.second.candidate]), 1);
  assert.equal(await x.manager.start(x.owner, {authorized:true, authorization}), x.lease);
  old.socket.write('after'); await until(() => old.output().endsWith('beforeafter'));
  const next = await x.connect(); await until(() => next.output().includes('200'));
  next.socket.write('new'); await until(() => next.output().endsWith('new'));
  assert.equal(x.first.seen.calls, 1); assert.equal(x.first.seen.bytes, 11);
  assert.equal(x.second.seen.calls, 1); assert.equal(x.second.seen.bytes, 3);
});
test('queued CONNECT retains its accepted route across refresh', async () => {
  const x = await fixture(1), old = await x.connect(); await until(() => old.output().includes('200'));
  const queued = await x.connect(); await wait(30);
  assert.equal(queued.output(), '');
  x.manager.updateRoutes(x.owner, {...x.manager.routeVersion(), revision:0}, [x.second.candidate]);
  old.socket.destroy();
  await until(() => queued.output().includes('200'));
  assert.equal(x.first.seen.calls, 2); assert.equal(x.second.seen.calls, 0);
  queued.socket.destroy();
  const fresh = await x.connect(); await until(() => fresh.output().includes('200'));
  assert.equal(x.second.seen.calls, 1);
});
test('wrong owner, stale revision and invalid replacement cannot change the accepted route', async () => {
  const x = await fixture();
  assert.throws(() => x.manager.updateRoutes({}, {...x.manager.routeVersion(), revision:0}, [x.second.candidate]), /Wrong owner/);
  assert.throws(() => x.manager.updateRoutes(x.owner, {...x.manager.routeVersion(), revision:1}, [x.second.candidate]), /Stale/);
  assert.throws(() => x.manager.updateRoutes(x.owner, {...x.manager.routeVersion(), revision:0}, []), /candidates/);
  assert.equal(x.manager.routeVersion().revision, 0);
  const client = await x.connect(); await until(() => client.output().includes('200'));
  assert.equal(x.first.seen.calls, 1); assert.equal(x.second.seen.calls, 0);
});
test('caller route edits cannot alter a committed refresh, and shutdown cannot be renewed', async () => {
  const x = await fixture();
  const routes = [{...x.second.candidate}];
  x.manager.updateRoutes(x.owner, {...x.manager.routeVersion(), revision:0}, routes); routes[0].port = x.first.candidate.port;
  const client = await x.connect(); await until(() => client.output().includes('200'));
  assert.equal(x.second.seen.calls, 1); assert.equal(x.first.seen.calls, 0);
  await x.manager.shutdown(x.owner);
  assert.throws(() => x.manager.updateRoutes(x.owner, {...x.manager.routeVersion(), revision:1}, [x.first.candidate]), /unavailable/);
  assert.equal(x.manager.routeVersion().revision, 1);
});
test('TLS trust bytes are owned by a route snapshot', () => {
  const certificate = Buffer.from('synthetic-trust-bytes');
  const routes = snapshotProxyRoutes([{id:'tls', kind:'https', host:'proxy.invalid', port:443, proxyCa:certificate}]);
  certificate.fill(0);
  assert.equal(routes[0].proxyCa?.toString(), 'synthetic-trust-bytes');
  assert.ok(Object.isFrozen(routes)); assert.ok(Object.isFrozen(routes[0]));
});
test('route refresh is allowed before activation without opening a listener', async () => {
  const first = await httpProxy(scope), second = await httpProxy(scope), owner = {};
  const manager = createOwnedIngressManager({owner, candidates:[first.candidate], allowTarget});
  scope.after(() => manager.shutdown(owner));
  assert.equal(manager.updateRoutes(owner, manager.routeVersion(), [second.candidate]), 1);
  assert.equal(manager.status().state, 'stopped');
  assert.equal(first.seen.calls + second.seen.calls, 0);
});

test('standard proxy challenge discloses no capability and a subsequent authorized connection succeeds', async () => {
  const x = await fixture(), denied = await x.connect('Basic invalid');
  await until(() => denied.output().includes('407'));
  assert.match(denied.output(), /Proxy-Authenticate: Basic realm="opencodex-session"/);
  assert.ok(!denied.output().includes(authorization));
  assert.equal(x.first.seen.calls, 0);
  const accepted = await x.connect(); await until(() => accepted.output().includes('200'));
  assert.equal(x.first.seen.calls, 1);
});

test('an update observed before restart cannot mutate the new capability generation', async () => {
  const x = await fixture(), observed = x.manager.routeVersion();
  await x.manager.stop(x.owner);
  const next = await x.manager.start(x.owner, {authorized:true, authorization:authorization + 'next'});
  assert.notEqual(next.generation, observed.generation);
  assert.throws(() => x.manager.updateRoutes(x.owner, observed, [x.second.candidate]), /Stale/);
  assert.equal(x.manager.routeVersion().revision, 0);
});

test('an update observed while stopped cannot survive an intervening start and stop', async () => {
  const proxy = await httpProxy(scope), owner = {};
  const manager = createOwnedIngressManager({owner, candidates:[proxy.candidate], allowTarget});
  scope.after(() => manager.shutdown(owner));
  const observed = manager.routeVersion();
  await manager.start(owner, {authorized:true, authorization}); await manager.stop(owner);
  assert.equal(manager.status().generation, null);
  assert.throws(() => manager.updateRoutes(owner, observed, [proxy.candidate]), /Stale/);
});
