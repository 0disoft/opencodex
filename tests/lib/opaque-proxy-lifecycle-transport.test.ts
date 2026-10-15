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
import net, {type AddressInfo, type Server, type Socket} from 'node:net';
import {once} from 'node:events';
import {createOwnedIngressManager} from '../../src/lib/opaque-proxy-lifecycle/managed-session';
const authorization='Basic '+Buffer.from('session:synthetic-integration-only-capability').toString('base64');
const pause=(ms: number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(fn: () => boolean){for(let n=0;n<200;n++){if(fn())return;await pause(5);}assert.fail('Did not settle');}
async function fixture(t: CleanupContext,{sessionMs=2000}={}){
 const sockets=new Set<Socket>(),listeners: Server[]=[];let failedAttempts=0,proxyAttempts=0,targetConnections=0,targetBytes=0;const proxyHeaders: string[]=[];
 async function listen(handler: (socket: Socket) => void){const s=net.createServer({allowHalfOpen:true},socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));handler(socket);});listeners.push(s);s.listen(0,'127.0.0.1');await once(s,'listening');return (s.address() as AddressInfo).port;}
 const targetPort=await listen(s=>{targetConnections++;s.on('data',b=>targetBytes+=b.length);s.pipe(s);});
 const firstPort=await listen(s=>{failedAttempts++;s.destroy();});
 const goodPort=await listen(client=>{
  proxyAttempts++;let bytes=Buffer.alloc(0);
  function receive(chunk: Buffer){bytes=Buffer.concat([bytes,chunk]);const end=bytes.indexOf('\r\n\r\n');if(end<0)return;client.removeListener('data',receive);client.pause();
   proxyHeaders.push(bytes.subarray(0,end).toString());
   const upstream=net.connect(targetPort,'127.0.0.1');sockets.add(upstream);upstream.on('error',()=>client.destroy());upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});client.on('close',()=>upstream.destroy());
   upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');const head=bytes.subarray(end+4);if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  }client.on('data',receive);
 });
 const owner={},authority=`127.0.0.1:${targetPort}`;
 const manager=createOwnedIngressManager({owner,candidates:[{id:'closed-first',kind:'http',host:'127.0.0.1',port:firstPort},{id:'working-second',kind:'http',host:'127.0.0.1',port:goodPort}],allowTarget:a=>a===authority,ingress:{sessionMs,idleMs:1000,totalMs:2000},manager:{sessionMs:3000}});
 const lease=await manager.start(owner,{authorized:true,authorization});const clients: Socket[]=[];
 async function connect(auth: string){const client=Object.assign(net.connect(lease.port,lease.host),{output:''});clients.push(client);client.on('error',()=>{});client.on('data',b=>client.output+=b.toString());await once(client,'connect');client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${auth}\r\n\r\n`);return client;}
 t.after(async()=>{for(const s of clients)s.destroy();await manager.shutdown(owner);for(const s of sockets)s.destroy();await Promise.all(listeners.map(s=>new Promise(r=>s.close(r))));});
 return{manager,owner,lease,connect,proxyHeaders,counts:()=>({failedAttempts,proxyAttempts,targetConnections,targetBytes,sockets:sockets.size})};
}
test('real composition: wrong capability has zero network dials; approved fallback carries opaque bytes once; stop reclaims generation',async t=>{
 const x=await fixture(t);const denied=await x.connect('Basic invalid');await until(()=>denied.destroyed);assert.match(denied.output,/407/);assert.deepEqual(x.counts(),{failedAttempts:0,proxyAttempts:0,targetConnections:0,targetBytes:0,sockets:0});
 const accepted=await x.connect(authorization);await until(()=>accepted.output.includes('200'));const body='opaque-TLS-like-synthetic-application-bytes';accepted.write(body);await until(()=>accepted.output.endsWith(body));assert.equal(x.counts().failedAttempts,1);assert.equal(x.counts().proxyAttempts,1);assert.equal(x.counts().targetConnections,1);assert.equal(x.counts().targetBytes,body.length);assert.doesNotMatch(x.proxyHeaders[0],/Proxy-Authorization/i);
 await x.manager.stop(x.owner);await until(()=>accepted.destroyed&&x.counts().sockets===0);assert.equal(x.manager.status().state,'stopped');assert.equal(x.counts().failedAttempts,1);assert.equal(x.counts().proxyAttempts,1);
});
test('real composition: ingress session expiry invalidates ready lease and closes active target tunnel without renewal',async t=>{
 const x=await fixture(t,{sessionMs:80});const accepted=await x.connect(authorization);await until(()=>accepted.output.includes('200'));accepted.write('one');await until(()=>accepted.output.endsWith('one'));await until(()=>accepted.destroyed&&x.counts().sockets===0&&x.manager.status().state==='stopped');await x.lease.stop();assert.equal(x.counts().proxyAttempts,1);assert.equal(x.counts().targetBytes,3);
});
