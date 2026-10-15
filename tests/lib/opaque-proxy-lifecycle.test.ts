import {test as bunTest} from 'bun:test';
interface CleanupContext {after(cleanup: () => void | Promise<void>): void;}
function test(name: string, run: (context: CleanupContext) => void | Promise<void>) {
  bunTest(name, async () => {
    const cleanups: Array<() => void | Promise<void>> = [];
    try {await run({after: cleanup => {cleanups.push(cleanup);}});}
    finally {for (const cleanup of cleanups.reverse()) await cleanup();}
  });
}
import assert from 'node:assert/strict';
import net, {type AddressInfo, type Socket} from 'node:net';
import {once} from 'node:events';
import {createManagedIngress, type ManagedIngressOptions} from '../../src/lib/opaque-proxy-lifecycle/managed-ingress';
import {createOwnerManager, type WorkerContext} from '../../src/lib/opaque-proxy-lifecycle/owner-manager';
const authorization = 'Basic ' + Buffer.from('session:synthetic-test-only-capability-000000000000').toString('base64');
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function deferred<T>() {let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((a,b) => {resolve=a; reject=b;}); return {promise, resolve, reject};}
async function until(fn: () => boolean) {for(let n=0; n<100;n++){if(fn()) return; await pause(5);} assert.fail('Condition did not settle');}
async function setup(t: CleanupContext, options: Partial<ManagedIngressOptions>={}) {
  const peers = new Set<Socket>(); let proxyCalls = 0;
  const proxy = net.createServer({allowHalfOpen:true}, socket => {
    peers.add(socket); socket.on('error',()=>{}); socket.on('close',()=>peers.delete(socket));
    socket.once('data', () => {proxyCalls++; socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(socket);});
  });
  proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
  const ingress = createManagedIngress({authorization, candidates:[{id:'test',host:'127.0.0.1',port:(proxy.address() as AddressInfo).port}], allowTarget:a=>a==='test.invalid:443', idleMs:1000,totalMs:3000,...options});
  const address = await ingress.listen(); const clients: Socket[]=[];
  t.after(async()=>{for(const s of clients)s.destroy();await ingress.close(); for(const s of peers)s.destroy(); await new Promise(r=>proxy.close(r));});
  async function client(header: string | null=authorization, extra='') {
    const s = Object.assign(net.connect(address.port, '127.0.0.1'), {output:''}); clients.push(s); s.on('error',()=>{}); s.on('data',b=>s.output+=b.toString());
    await once(s,'connect'); s.write(`CONNECT test.invalid:443 HTTP/1.1\r\nHost: test.invalid:443\r\n${header===null?'':`Proxy-Authorization: ${header}\r\n`}${extra}\r\n`); return s;
  }
  return {ingress,address,client,clients,calls:()=>proxyCalls};
}
test('explicit owner, authorization, and loopback readiness are required', async()=>{
  const owner={}; const m=createOwnerManager({owner,createWorker:()=>({listen:()=>({address:'0.0.0.0',port:1}),close:()=>{}})});
  assert.throws(()=>m.start({},{authorized:true,authorization}),/owner/);
  assert.throws(()=>m.start(owner,{authorization}),/authorization/);
  // Deliberately invalid runtime values exercise the boundary's strict true check.
  for (const authorized of [false, 'false', 1, Promise.resolve(true)]) assert.throws(()=>m.start(owner,{authorized:authorized as boolean,authorization}),/authorization/);
  await assert.rejects(m.start(owner,{authorized:true,authorization}),/loopback/);
  assert.equal(m.status().state,'stopped');
});
test('duplicate starts share readiness; old lease cannot stop new generation', async()=>{
  const owner={}, workers: Array<{opts: WorkerContext; closed: number}>=[];
  const m=createOwnerManager({owner,createWorker:opts=>{const w={opts,closed:0,listen:()=>({address:'127.0.0.1',port:1234}),close(){this.closed++;}};workers.push(w); return w;}});
  const a=m.start(owner,{authorized:true,authorization}), b=m.start(owner,{authorized:true,authorization}); assert.equal(a,b);
  const first=await a; await first.stop(); const second=await m.start(owner,{authorized:true,authorization});
  await first.stop(); workers[0].opts.onExit(); assert.equal(m.status().generation,second.generation); assert.equal(workers[1].closed,0);
  await m.shutdown(owner); assert.throws(()=>m.start(owner,{authorized:true,authorization}),/unavailable/);
});
test('stop during startup and late readiness cannot publish over a new generation', async()=>{
  const owner={}, ready=deferred<{address: string; port: number}>(); let n=0;
  const m=createOwnerManager({owner,createWorker:()=>({listen:()=>++n===1?ready.promise:{address:'127.0.0.1',port:2},close:()=>{}})});
  const old=m.start(owner,{authorized:true,authorization}); const oldResult=assert.rejects(old,/Stale/);
  await pause(0); await m.stop(owner); const next=await m.start(owner,{authorized:true,authorization}); ready.resolve({address:'127.0.0.1',port:1}); await oldResult;
  assert.equal(m.status().generation,next.generation); await m.stop(owner);
});
test('startup timeout closes own worker; crashed generation has no automatic restart',async()=>{
 const owner={}; let calls=0,closed=0;let onExit!: WorkerContext['onExit'];
 const m=createOwnerManager({owner,startupMs:20,createWorker:o=>{calls++;onExit=o.onExit;return{listen:()=>new Promise(()=>{}),close:()=>{closed++;}};}});
 await assert.rejects(m.start(owner,{authorized:true,authorization}),/Startup/); assert.equal(closed,1);onExit();assert.equal(calls,1);
});
test('failed shutdown is bounded and blocks new starts instead of orphaning ownership',async()=>{
 const owner={};const m=createOwnerManager({owner,shutdownMs:20,createWorker:()=>({listen:()=>({address:'127.0.0.1',port:2}),close:()=>new Promise(()=>{})})});
 await m.start(owner,{authorized:true,authorization});await assert.rejects(m.stop(owner),/Shutdown/);assert.throws(()=>m.start(owner,{authorized:true,authorization}),/unavailable/);
});
test('missing, wrong, duplicate capability denied before dialing; authorized bytes echoed',async t=>{
 const x=await setup(t); assert.equal(x.address.address,'127.0.0.1');
 for(const [header,extra] of [[null,''],['wrong',''],[authorization,`Proxy-Authorization: ${authorization}\r\n`]] as const){
  const s=await x.client(header,extra);await until(()=>s.destroyed);assert.match(s.output,/407/);
 }
 assert.equal(x.calls(),0);const good=await x.client();await until(()=>good.output.includes('200'));good.write('opaque-data');await until(()=>good.output.includes('opaque-data'));assert.equal(x.calls(),1);
});
test('concurrency and queue are bounded; disconnect promotes only queued accepted client',async t=>{
 const x=await setup(t,{maxActive:1,maxQueued:1});const a=await x.client();await until(()=>a.output.includes('200'));
 const b=await x.client();await until(()=>x.ingress.stats().queued===1);const c=await x.client();await until(()=>c.destroyed);assert.match(c.output,/503/);assert.equal(x.calls(),1);
 a.destroy();await until(()=>b.output.includes('200'));assert.equal(x.calls(),2);assert.equal(x.ingress.stats().active,1);
});
test('queue deadline removes waiting client without dialing',async t=>{
 const x=await setup(t,{maxActive:1,maxQueued:1,queueMs:25});const a=await x.client();await until(()=>a.output.includes('200'));const b=await x.client();await until(()=>b.destroyed);assert.match(b.output,/503/);a.destroy();await pause(25);assert.equal(x.calls(),1);
});
test('idle deadline and total session deadline close owned sockets',async t=>{
 const x=await setup(t,{idleMs:40,totalMs:120}); const a=await x.client();await until(()=>a.output.includes('200'));await until(()=>a.destroyed);
 const b=await x.client();await until(()=>b.output.includes('200'));const timer=setInterval(()=>b.write('x'),10);await until(()=>b.destroyed);clearInterval(timer);await until(()=>x.ingress.stats().clients===0);
});
test('raw clients also bounded and expired before authentication',async t=>{
 const x=await setup(t,{maxClients:1,idleMs:40}); const a=net.connect(x.address.port,'127.0.0.1');x.clients.push(a);a.on('error',()=>{});a.resume();await once(a,'connect');
 const b=net.connect(x.address.port,'127.0.0.1');x.clients.push(b);b.on('error',()=>{});b.resume();await until(()=>b.destroyed);await until(()=>a.destroyed);assert.equal(x.calls(),0);
});
test('late successful dial after close is destroyed, without response or replay',async t=>{
 const late=deferred<{socket: {destroy(): void}}>();let calls=0,destroyed=0;
 // This late-resolution branch only calls destroy; keep the fake narrow at the dialer boundary.
 const x=await setup(t,{dial:()=>{calls++;return late.promise as unknown as ReturnType<NonNullable<ManagedIngressOptions['dial']>>;}});const a=await x.client();await until(()=>calls===1);await x.ingress.close();
 late.resolve({socket:{destroy(){destroyed++;}}});await until(()=>destroyed===1);assert.equal(calls,1);assert.equal(a.output,'');
});
test('manager integrates real ingress; shutdown releases listener and active tunnel',async t=>{
 const x=await setup(t);await x.ingress.close(); const owner={};
 const m=createOwnerManager({owner,createWorker:({authorization})=>createManagedIngress({authorization,candidates:[{id:'unused',host:'127.0.0.1',port:1}],allowTarget:()=>true})});
 const lease=await m.start(owner,{authorized:true,authorization});const s=net.connect(lease.port,lease.host);s.on('error',()=>{});s.resume();await once(s,'connect');await m.shutdown(owner);await until(()=>s.destroyed);assert.equal(m.status().state,'stopped');
});
test('policy rejection and thrown policy never dial',async t=>{
 for(const allowTarget of [()=>false,()=>{throw Error('deny');}]){
 const x=await setup(t,{allowTarget});const a=await x.client();await until(()=>a.destroyed);assert.match(a.output,/403/);assert.equal(x.calls(),0);
 }
});
test('half-close flushes opaque payload before session disposal',async t=>{
 const x=await setup(t);const a=await x.client();await until(()=>a.output.includes('200'));const payload='z'.repeat(1024*1024);a.end(payload);await until(()=>a.destroyed);assert.equal(a.output.split('\r\n\r\n')[1],payload);assert.equal(x.calls(),1);
});
test('close aborts establishing and queued clients without promoting or replaying',async t=>{
 let calls=0;let signal: AbortSignal | undefined;
 const x=await setup(t,{maxActive:1,maxQueued:2,dial:(_a,_c,opts)=>{calls++;signal=opts.signal;return new Promise(()=>{});}});
 const a=await x.client();await until(()=>calls===1);const b=await x.client();await until(()=>x.ingress.stats().queued===1);await x.ingress.close();await until(()=>a.destroyed&&b.destroyed);assert.ok(signal);assert.equal(signal.aborted,true);assert.equal(calls,1);assert.equal(x.ingress.stats().clients,0);
});
test('establishment has absolute deadline even for a non-cooperating dialer',async t=>{
 let signal: AbortSignal | undefined;
 const x=await setup(t,{establishMs:30,dial:(_a,_c,opts)=>{signal=opts.signal;return new Promise(()=>{});}});const a=await x.client();await until(()=>a.destroyed);assert.ok(signal);assert.equal(signal.aborted,true);assert.equal(x.ingress.stats().active,0);
});
test('crash after ready closes only owned generation and never restarts',async()=>{
 const owner={};let callback!: WorkerContext['onExit'];let closed=0,created=0;
 const m=createOwnerManager({owner,createWorker:({onExit})=>{created++;callback=onExit;return {listen:()=>({address:'127.0.0.1',port:3}),close:()=>{closed++;}};}});
 await m.start(owner,{authorized:true,authorization});callback();await until(()=>m.status().state==='stopped');assert.equal(closed,1);assert.equal(created,1);
});
test('session capability expires with listener and active clients, zero automatic renewal',async t=>{
 const x=await setup(t,{sessionMs:45});const a=await x.client();await until(()=>a.output.includes('200'));await until(()=>a.destroyed);assert.equal(x.ingress.server.listening,false);assert.equal(x.calls(),1);
 const owner={};let created=0;
 const m=createOwnerManager({owner,sessionMs:20,createWorker:()=>{created++;return {listen:()=>({address:'127.0.0.1',port:2}),close:()=>{}};}});
 await m.start(owner,{authorized:true,authorization});await until(()=>m.status().state==='stopped');assert.equal(created,1);
});
test('reverse half-close preserves slow upstream upload after server FIN',async t=>{
 const payload=Buffer.alloc(4*1024*1024,0x78);let received=0;let resolveDone!: () => void;const done=new Promise<void>(r=>resolveDone=r);const peers=new Set<Socket>();
 const echo=net.createServer({allowHalfOpen:true},s=>{peers.add(s);s.on('error',()=>{});s.once('data',()=>{
  s.end('HTTP/1.1 200 Connection Established\r\n\r\n');s.on('data',b=>{received+=b.length;s.pause();setTimeout(()=>s.resume(),2);});s.once('end',resolveDone);
 });});echo.listen(0,'127.0.0.1');await once(echo,'listening');
 const ingress=createManagedIngress({authorization,candidates:[{id:'reverse',host:'127.0.0.1',port:(echo.address() as AddressInfo).port}],allowTarget:()=>true,totalMs:5000});const address=await ingress.listen();
 const client=net.connect({port:address.port,host:'127.0.0.1',allowHalfOpen:true});client.on('error',()=>{});
 t.after(async()=>{client.destroy();await ingress.close();for(const s of peers)s.destroy();await new Promise(r=>echo.close(r));});
 await once(client,'connect');client.write(`CONNECT test.invalid:443 HTTP/1.1\r\nHost: test.invalid:443\r\nProxy-Authorization: ${authorization}\r\n\r\n`);await once(client,'data');await once(client,'end');client.end(payload);await done;assert.equal(received,payload.length);
});
test('synchronous factory exit leaves no timer keeping process alive',async()=>{
 const {execFile}=await import('node:child_process');
 const moduleURL=new URL('../../src/lib/opaque-proxy-lifecycle/owner-manager.ts',import.meta.url).href;
 await new Promise<void>((resolve,reject)=>execFile(process.execPath,['--eval',`
  import {createOwnerManager} from ${JSON.stringify(moduleURL)};
  const owner={};const manager=createOwnerManager({owner,createWorker:({onExit})=>{onExit();return {listen(){throw Error('must not start')},close(){}};}});
  try {await manager.start(owner,{authorized:true,authorization:${JSON.stringify(authorization)}});process.exitCode=2;}catch{}
 `],{timeout:1500},error=>error?reject(error):resolve()));
});
test('composition forwards real ingress termination to matching owner generation',async()=>{
 const {createOwnedIngressManager}=await import('../../src/lib/opaque-proxy-lifecycle/managed-session');const owner={};
 const m=createOwnedIngressManager({owner,candidates:[{id:'unused',host:'127.0.0.1',port:1}],allowTarget:()=>true,ingress:{sessionMs:30},manager:{sessionMs:1000}});
 const lease=await m.start(owner,{authorized:true,authorization});assert.equal(m.status().state,'ready');await until(()=>m.status().state==='stopped');await lease.stop();
});
test('fragmented CONNECT authenticates only at header end and preserves early bytes',async t=>{
 const x=await setup(t);const s=net.connect(x.address.port,'127.0.0.1');x.clients.push(s);s.on('error',()=>{});let output='';s.on('data',b=>output+=b.toString());await once(s,'connect');
 s.write('CONNECT test.invalid:443 HTTP/1.1\r\nHost: test.invalid:443\r\n');await pause(20);assert.equal(x.calls(),0);
 s.write(`Proxy-Authorization: ${authorization}\r\n\r\nearly-payload`);await until(()=>output.endsWith('early-payload'));assert.equal(x.calls(),1);
});
test('absolute raw deadline defeats trickle activity; incomplete EOF frees slot',async t=>{
 const x=await setup(t,{idleMs:40,totalMs:80});const s=net.connect(x.address.port,'127.0.0.1');x.clients.push(s);s.on('error',()=>{});s.resume();await once(s,'connect');const trickle=setInterval(()=>s.write('x'),5);
 try {await until(()=>s.destroyed);}finally{clearInterval(trickle);}assert.equal(x.calls(),0);assert.equal(x.ingress.stats().clients,0);
 const eof=net.connect(x.address.port,'127.0.0.1');x.clients.push(eof);eof.on('error',()=>{});eof.resume();await once(eof,'connect');eof.end('CONNECT partial');await until(()=>eof.destroyed);assert.equal(x.ingress.stats().clients,0);
});
test('ambiguous and oversized raw headers are rejected before any actual proxy dial',async t=>{
 const x=await setup(t);const base=`CONNECT test.invalid:443 HTTP/1.1\r\nHost: test.invalid:443\r\nProxy-Authorization: ${authorization}`;
 for(const request of [base+'\r\nHost: test.invalid:443\r\n\r\n',base+'\r\nContent-Length: 0\r\n\r\n',base+'\r\nTransfer-Encoding: chunked\r\n\r\n',base+'\r\n Folded: a\r\n\r\n',base+'\r\nX: a\0b\r\n\r\n',base.replace('\r\n','\n')+'\r\n\r\n',base+'\r\nX: '+'x'.repeat(8500)]){
  const s=net.connect(x.address.port,'127.0.0.1');x.clients.push(s);s.on('error',()=>{});let output='';s.on('data',b=>output+=b.toString());await once(s,'connect');s.end(request);await until(()=>s.destroyed);assert.match(output,/HTTP\/1.1 (400|431)/);
 }
 assert.equal(x.calls(),0);
});
test('reentrant synchronous factory startup rejects rather than returning missing readiness',async()=>{
 const owner={};let manager: ReturnType<typeof createOwnerManager>;
 manager=createOwnerManager({owner,createWorker:()=>{assert.throws(()=>manager.start(owner,{authorized:true,authorization}),/Reentrant/);return {listen:()=>({address:'127.0.0.1',port:2}),close:()=>{}};}});
 await manager.start(owner,{authorized:true,authorization});await manager.stop(owner);
});
test('queued authorization is rechecked before physical dial after policy withdrawal',async t=>{
 let allowed=true;const x=await setup(t,{maxActive:1,maxQueued:1,allowTarget:()=>allowed});const a=await x.client();await until(()=>a.output.includes('200'));const b=await x.client();await until(()=>x.ingress.stats().queued===1);allowed=false;a.destroy();await until(()=>b.destroyed);assert.match(b.output,/502/);assert.equal(x.calls(),1);
});
test('invalid async policy rejection is observed and denied without dialing',async t=>{
 // Invalid async policies intentionally cross the synchronous policy API boundary.
 const allowTarget=(async()=>{throw new Error('synthetic denied policy');}) as unknown as ManagedIngressOptions['allowTarget'];
 const x=await setup(t,{allowTarget});const a=await x.client();await until(()=>a.destroyed);assert.match(a.output,/403/);await pause(10);assert.equal(x.calls(),0);
});
test('queued policy changing to rejected promise cannot leak rejection or dial',async t=>{
 let withdrawn=false;
 // The policy becomes invalid at runtime after this connection enters the queue.
 const allowTarget=(()=>withdrawn?Promise.reject(new Error('synthetic policy withdrawn')):true) as ManagedIngressOptions['allowTarget'];
 const x=await setup(t,{maxActive:1,maxQueued:1,allowTarget});
 const a=await x.client();await until(()=>a.output.includes('200'));const b=await x.client();await until(()=>x.ingress.stats().queued===1);withdrawn=true;a.destroy();await until(()=>b.destroyed);assert.match(b.output,/502/);await pause(10);assert.equal(x.calls(),1);
});
