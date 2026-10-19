/** Account-bound compatibility consent; no persistent settings or timers. */
export type Observation = 'exhausted' | 'available' | 'protected';
export type ApplyScope = 'selected-external-model' | 'account-ui-compatibility';
export type ApplyLifetime = 'trial' | 'runtime-session';
type RefreshResult = {requested:number;closed:number;failed:number};
export class UsageActivation {
  private mode: 'observe' | 'apply' = 'observe';
  private phase = 'observing';
  private generation = 0;
  private consentGeneration = 0;
  private latest: { kind:Observation; at:number } | null = null;
  private startedAt: number | null = null;
  private lifetime: ApplyLifetime | null = null;
  private outputs = 0;
  constructor(private binding:string, private refresh:(binding:string)=>Promise<RefreshResult>,
    private verifyIdentity:()=>Promise<string|null>,
    private clock:()=>number=Date.now, private timeoutMs=180000) {
    if(!binding || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>180000) throw new Error('Invalid activation limits');
  }
  snapshot() { return {mode:this.mode,phase:this.phase,generation:this.generation,outputs:this.outputs,activationLifetime:this.lifetime,
    appCacheConfirmed:false,requestedUiScope:'account-wide',providerIsolationAvailable:false}; }
  /** Internal batch fencing; recovery advances response generation without granting new consent. */
  consentEpoch() { return this.consentGeneration; }
  private revoke(phase:string) {
    this.mode='observe';this.phase=phase;this.startedAt=null;this.lifetime=null;this.latest=null;this.outputs=0;++this.generation;++this.consentGeneration;
  }
  invalidateIdentity() { this.revoke('identity-invalidated'); }
  observe(binding:string,kind:Observation) {
    if(binding!==this.binding)return false;
    this.latest={kind,at:this.clock()};
    // Recovery/protection cancels pending output in both lifetimes. Only explicit
    // runtime-session consent survives to evaluate a later original exhaustion.
    if(this.mode==='apply'&&kind!=='exhausted'){
      const phase=kind==='available'?'usage-recovered':'protected-observation';
      if(this.lifetime==='runtime-session'){this.phase=phase;++this.generation;}
      else {this.revoke(phase);this.latest={kind,at:this.clock()};}
    }
    return true;
  }
  private async reset(phase:string) {
    this.revoke(phase);
    return this.refresh(this.binding);
  }
  async activate(options:{scope:ApplyScope;accountWideConsent:boolean;lifetime?:ApplyLifetime}) {
    if(options.scope!=='account-ui-compatibility')return{accepted:false,reason:'selected-model-scope-unavailable',...this.snapshot()};
    if(!options.accountWideConsent)return{accepted:false,reason:'account-wide-scope-not-accepted',...this.snapshot()};
    const lifetime=options.lifetime??'trial';
    if(lifetime!=='trial'&&lifetime!=='runtime-session')return{accepted:false,reason:'invalid-lifetime',...this.snapshot()};
    const beforeVerification=this.generation,binding=this.binding;
    let verified:string|null;
    try{verified=await this.verifyIdentity();}catch{verified=null;}
    if(this.binding!==binding||this.generation!==beforeVerification)return{accepted:false,reason:'identity-not-verified',...this.snapshot()};
    if(verified!==binding){this.invalidateIdentity();return{accepted:false,reason:'identity-not-verified',...this.snapshot()};}
    if(this.mode==='apply')return{accepted:false,reason:'activation-already-pending',...this.snapshot()};
    const age=this.latest?this.clock()-this.latest.at:Infinity;
    if(!this.latest||this.latest.kind!=='exhausted'||age<0||age>300000)return{accepted:false,reason:'no-fresh-eligible-exhaustion',...this.snapshot()};
    // An exhausted observation authorizes one activation, not automatic retries.
    this.latest=null;
    this.mode='apply';this.phase='awaiting-fresh-usage';this.startedAt=this.clock();this.lifetime=lifetime;this.outputs=0;
    ++this.generation;
    const consentGeneration=++this.consentGeneration;
    let refreshed:RefreshResult;
    try { refreshed=await this.refresh(this.binding); }
    catch {
      if(this.consentGeneration===consentGeneration)this.revoke('refresh-failed');
      return{accepted:false,reason:'refresh-failed',...this.snapshot()};
    }
    // Account/mode changes while a close callback awaited invalidate this activation.
    if(this.consentGeneration!==consentGeneration)return{accepted:false,reason:'superseded',...this.snapshot()};
    // The registry settles every close and reports failures; it does not reject the batch.
    // Partial closure cannot leave rewriting enabled while an old app cache may survive.
    if(!Number.isSafeInteger(refreshed.requested)||!Number.isSafeInteger(refreshed.closed)
      ||!Number.isSafeInteger(refreshed.failed)||refreshed.requested<0||refreshed.closed<0
      ||refreshed.failed!==0||refreshed.closed!==refreshed.requested){
      this.revoke('refresh-failed');
      return{accepted:false,reason:'refresh-failed',refresh:refreshed,...this.snapshot()};
    }
    return{accepted:true,reason:'awaiting-new-response',refresh:refreshed,...this.snapshot()};
  }
  recordOutput(binding:string,generation:number) {
    if(binding!==this.binding||generation!==this.generation||this.mode!=='apply')return false;
    if(this.startedAt===null||this.clock()-this.startedAt<0
      ||this.lifetime==='trial'&&this.clock()-this.startedAt>=this.timeoutMs)return false;
    ++this.outputs;this.phase='response-produced-app-confirmation-needed';return true;
  }
  async expireIfNeeded() {
    if(this.startedAt===null||this.clock()-this.startedAt>=0
      &&(this.lifetime==='runtime-session'||this.clock()-this.startedAt<this.timeoutMs))return false;
    await this.reset('expired-awaiting-original-response');return true;
  }
  async observeOnly() { return this.reset('observing-awaiting-original-response'); }
  async changeBinding(binding:string) {
    if(!binding)throw new Error('Verified account binding is required');
    const previous=this.binding;
    this.revoke('account-changed');
    this.binding=binding;
    return this.refresh(previous);
  }
}
