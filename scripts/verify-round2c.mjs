// Small in-memory source models. These execute selected Kotlin expressions
// translated to JavaScript, plus structural checks; they DO NOT compile Kotlin.
// --baseline reads a JSON path-to-source map from stdin, containing only
// this task's HEAD (3d72fb9), never an earlier revision.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign, verify, createHash } from 'node:crypto';
const baseline = process.argv.includes('--baseline');
const snapshots = baseline ? JSON.parse(readFileSync(0, 'utf8')) : null;
const source = path => baseline ? snapshots[path] : readFileSync(path,'utf8');
const root = 'android/app/src/main/java/com/observatory/wildfire/';
const read = name => source(root + name + '.kt');
const repo=read('AppRepository'), map=read('MapFragment'), report=read('ReportFragment');
const team=read('TeamFragment'), risk=read('ObservatoryFragment');
let checked=0;
function check(id, fixed, detail) {
  console.log(`${id}: ${fixed ? 'FIXED' : 'REPRODUCED'} — ${detail}`);
  assert.equal(fixed, !baseline, `${id}: unexpected ${baseline?'baseline':'working-copy'} result`);
  checked++;
}
function blockAt(text, offset) {
  const start=text.indexOf('{',offset);
  let end=start+1, depth=1;
  for (;depth;end++) { if(text[end]==='{')depth++; if(text[end]==='}')depth--; }
  return text.slice(start+1,end-1);
}
function evaluate(expr,env) { return Function(...Object.keys(env),`return (${expr});`)(...Object.values(env)); }
function guard(text,anchor,env) {
  const start=text.indexOf('if (',text.indexOf(anchor)+anchor.length);
  let end=start+4,depth=1;
  for(;depth;end++){if(text[end]==='(')depth++;if(text[end]===')')depth--;}
  return evaluate(text.slice(start+4,end-1),env);
}
// Translate the actual key selection, with deterministic payload-builder and
// queue seams. Native ApiPayloadsTest separately pins payload equality.
const keySource=repo.slice(repo.indexOf('        val key =',repo.indexOf('    fun sendSos(')),repo.indexOf('        val built =',repo.indexOf('    fun sendSos(')));
const keyExpression=keySource.replace(/^\s*val key =/,'')
  .replace('.firstOrNull()','.find(() => true)')
  .replace('.firstOrNull { queued ->','.find(queued =>')
  .replace('}?.key',')?.key').replace('clientGeneratedId = ','').replace('?:','??');
const build=(deviceId,lat,lng,name,phone,textMessage,audioDataUri,audioDurationSec,key)=>({first:JSON.stringify({deviceId,lat,lng,name,phone,textMessage,audioDataUri,audioDurationSec,key})});
const oldArgs=['device',36,3,null,null,'help','audio-one',2];
const queued={key:'queued-key',payload:build(...oldArgs,'queued-key').first};
const choose=args=>evaluate(keyExpression,{
  sosQueue:{snapshot:()=>[queued]}, ApiPayloads:{buildSosJson:build,newClientGeneratedId:()=> 'fresh-key'},
  ...Object.fromEntries(['deviceId','lat','lng','name','phone','textMessage','audioDataUri','audioDurationSec'].map((key,i)=>[key,args[i]])),
});
assert.equal(choose(oldArgs),'queued-key');
const changedArgs=[...oldArgs]; changedArgs[1]=37;changedArgs[6]='audio-two';
check('8362',choose(changedArgs)==='fresh-key',`lost response + new GPS/audio uses ${choose(changedArgs)}; identical retry keeps queued-key`);
assert.ok(!repo.includes('sosQueue.replacePayload(key, body)') || baseline);
// Execute the actual move-completion block. On the old code it returns before
// drawing; the new block records a refresh and falls through to geometry checks.
const moveOffset=map.indexOf('if (movedFromRequest >=');
const moveBody=blockAt(map,moveOffset).replace('routeRefreshPending = true','pending = true;').replace('return@launch','return false;');
const accepted=Function(`let pending=false; ${moveBody} return pending;`)();
const geometryWired=map.includes('GeoMath.minDistanceToPolylineM(latestFix.first, latestFix.second, pts) <= ROUTE_MATCH_DISTANCE_M');
check('8373',accepted&&geometryWired,'45 m movement: draw near-road geometry, reject off-road geometry, then consume queued refresh');
assert.ok(map.includes('hasFreshOrigin()') && map.includes('ROUTE_REFRESH_DISTANCE_M = 30.0'));
// Attack model with REAL ECDSA, using the signed-field order from MeshWire.
const wire=read('MeshWire'), crypto=read('CryptoEngine'), inbound=read('MeshInbound');
const signedFields=blockAt(wire,wire.indexOf('fun buildSignedData(')).matchAll(/out.writeLengthPrefixed\((.*)\)/g);
const fields=[...signedFields].map(m=>m[1]);
const sha=text=>createHash('sha256').update(text).digest('hex');
function hashFromSource(name,env){
  const template=wire.match(new RegExp(`fun ${name}\\([^\\n]*\\): String =\\s*sha256Hex\\("([^"\\n]+)"\\)`))[1];
  const expanded=template.replace(/\$\{([^}]+)\}|\$(\w+)/g,(_m,expr,key)=>String(expr?evaluate(expr.replaceAll('.toString()','.toString()'),env):env[key]));
  return sha(expanded);
}
const env={origEphemeralId:'abc012def345gh67',messageId:'captured-msg',nonce:7,payloadB64:'captured-body'};
const budgetHash=hashFromSource('seenTripleHash',env), hashes=new Set();
let issue=()=>env.origEphemeralId, accepts=()=>true;
if(!baseline){
  const binding=read('MeshIdentityBinding');
  const issueExpr=binding.match(/fun issue\(publicKeyBase64: String\): String =\s*([^\n]+)/)[1]
    .replace('"wlfire-ephemeral-k1:$publicKeyBase64"','`wlfire-ephemeral-k1:${publicKeyBase64}`')
    .replace('.take(60)','.slice(0,60)');
  issue=publicKeyBase64=>evaluate(issueExpr,{publicKeyBase64,SCHEME_PREFIX:'k1:',MeshWire:{sha256Hex:sha}});
  const acceptsExpr=binding.match(/fun accepts\(.*\): Boolean =\s*([^\n]+)/)[1];
  accepts=(ephemeralId,publicKeyBase64)=>evaluate(acceptsExpr,{ephemeralId,publicKeyBase64,SCHEME_PREFIX:'k1:',issue});
  assert.ok(crypto.includes('ephemeralId = MeshIdentityBinding.issue('));
  assert.ok(crypto.indexOf('if (!MeshIdentityBinding.accepts(')<crypto.indexOf('val ciphertext =',crypto.indexOf('fun verifyMessageSignature(')));
}
const trusted=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const trustedKey=trusted.publicKey.export({type:'spki',format:'der'}).toString('base64');
const boundId=issue(trustedKey);
assert.ok(accepts(boundId,trustedKey));
let boundCopies=0, legacyCopies=0;
for(let i=0;i<16;i++){
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const origPublicKey=pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
  const values={ciphertext:Buffer.from('captured-body'),iv:Buffer.alloc(12),messageId:env.messageId,type:'report',hopCount:0,origEphemeralId:env.origEphemeralId,origPublicKey,timestamp:1700000000000,nonce:7,lat:36,lng:3};
  const data=Buffer.concat(fields.map(field=>{
    const key=field.match(/^(\w+)/)[1];
    const value=field.startsWith('canonicalLatLng')?Math.round(values[field.includes('(lat)')?'lat':'lng']*1e6):values[key];
    const bytes=Buffer.isBuffer(value)?value:Buffer.from(String(value));
    const len=Buffer.alloc(4);len.writeUInt32BE(bytes.length);return Buffer.concat([len,bytes]);
  }));
  assert.ok(verify('sha256',data,pair.publicKey,sign('sha256',data,pair.privateKey)));
  assert.equal(hashFromSource('seenTripleHash',env),budgetHash);
  hashes.add(hashFromSource('seenMessageHash',{...env,senderPublicKey:origPublicKey}));
  if(accepts(boundId,origPublicKey))boundCopies++;
  if(accepts(env.origEphemeralId,origPublicKey))legacyCopies++;
}
const max=Number(inbound.match(/MAX_VARIANTS_PER_TRIPLE = (\d+)/)[1]);
assert.equal(hashes.size,max);
assert.equal(boundCopies,baseline?16:0);
assert.equal(legacyCopies,16);
assert.ok(inbound.includes('seenTripleHash(payload.messageId, payload.nonce, payload.origEphemeralId)'));
console.log(`8384: ${baseline?'REPRODUCED':'PARTIAL'} — attacker copies admitted for issued IDs: ${boundCopies}/16; legacy IDs: ${legacyCopies}/16 (still vulnerable); authentic upgraded key accepted; triple budget unchanged`);
const display=risk.slice(risk.indexOf('private fun updateRiskDisplay'),risk.indexOf('private fun formatWeatherText'));
const markerCode=display.slice(display.indexOf('\n',display.indexOf('riskScoreText?.text ='))+1,display.indexOf('        riskLabelText'))
  .replaceAll('riskBarMarker?.animate()?.cancel()','marker.cancelled = true;')
  .replace(/riskBarMarker\?\.visibility = View\.(\w+)/g,'marker.visibility = "$1";')
  .replaceAll('positionRiskMarker(score)','marker.positioned = true;')
  .replaceAll('riskScoreText?.setTextColor(RiskScore.bandColor(score))','marker.colored = true;');
const marker=Function(`let marker={visibility:"VISIBLE"}; const fresh=false, score=0; ${markerCode} return marker;`)();
check('8391',marker.visibility==='GONE'&&marker.cancelled===true&&!marker.positioned&&!marker.colored,`stale marker state: ${JSON.stringify(marker)}`);
// Evaluate actual Boolean policies, not a separately restated condition.
let canMovePlaceFields=false, canApplyRecovery=()=>true;
if(!baseline){
  const policy=read('ReportPlacePolicy');
  const expr=name=>policy.match(new RegExp(`fun ${name}\\([\\s\\S]*?\\): Boolean =\\s*([\\s\\S]*?)(?=\\n\\s*(?:fun|\\}))`))[1].trim();
  const sameCoordinates=(bound,fix)=>evaluate(expr('sameCoordinates'),{bound,fix});
  canApplyRecovery=(bound,fix,nameManuallyEdited,wilayaManuallyEdited)=>evaluate(expr('canApplyRecovery'),{bound,fix,nameManuallyEdited,wilayaManuallyEdited,sameCoordinates});
  const canFill=(bound,fix,autofilledName,nameManuallyEdited,wilayaManuallyEdited)=>evaluate(expr('canFillOfflineWilaya'),{bound,fix,autofilledName,nameManuallyEdited,wilayaManuallyEdited,sameCoordinates});
  canMovePlaceFields=canFill({lat:36,lng:3},{lat:37,lng:4},true,false,false);
  assert.equal(canFill({lat:36,lng:3},{lat:36,lng:3},true,false,false),true);
  assert.equal(canApplyRecovery({lat:36,lng:3},{lat:36,lng:3},true,true),true);
}
const canFillDuringBackoff=guard(report,'if (SystemClock.elapsedRealtime() < geoBackoffUntilElapsedMs)',{autofilledWilaya:false,canMovePlaceFields});
check('8404',!canFillDuringBackoff,'old autofilled name + different fresh fix: backoff preserves binding; same-fix offline fill remains allowed');
const completion=report.slice(report.indexOf('if (!isAdded) return@launch'),report.indexOf('private fun openCamera'));
const protects=!canApplyRecovery({lat:36,lng:3},{lat:37,lng:4},true,false);
check('8414',protects&&completion.indexOf('ReportPlacePolicy.canApplyRecovery(')>=0&&completion.indexOf('ReportPlacePolicy.canApplyRecovery(')<completion.indexOf('if (result == null)')&&report.includes('AlertDialog.Builder'),'manual edit rejects entire recovery response before fallback, with explicit current-location confirmation');
const gated=team.includes('if (!MESH_CHAT_KIND_ENABLED)');
if(!baseline){
  const expression=read('MeshChatPolicy').match(/fun plaintext\(text: String\): String = (.*)/)[1].replace('text.take(160)','text.slice(0,160)');
  for(const text of ['hello team','{"app":"wlfire","kind":"report"}','a'.repeat(500)]){
    const sent=evaluate(expression,{text});
    assert.throws(()=>JSON.parse(sent)); // Both receiver parsers take the raw-chat branch.
    assert.ok(sent.slice(0,160).length<=160);
  }
}
check('8422',!gated&&repo.includes('if (kind == "chat") MeshChatPolicy.plaintext(text)')&&team.includes('entry.text.take(160)'),`chat send ${gated?'blocked':'plain-text fallback'}; receiver implementation untouched`);
const panel=source('src/components/command/SosPanel.tsx'), central=source('src/components/CentralCommand.tsx');
check('8434',panel.includes('teamsLoaded &&')&&central.includes('teamsLoaded={teamsLastUpdated !== null}'),'waiting state requires successful first roster load (runtime React regressions separately verify it)');
check('8446',panel.includes('matchingTeams.map(')&&panel.includes('team.activeMission?.since'),'dispatch names and millisecond elapsed times use the active roster (runtime React regressions separately verify it)');
const smoke=source('tests/e2e/smoke.spec.ts');
check('e2e locator (static read only)',smoke.includes("page.locator('#admin-auth-card').getByPlaceholder"),'password locator scoped; pre-login StaffManager retained; e2e execution deferred to CI');
console.log(`${checked} ${baseline?'baseline reproductions':'fixed source checks'} verified; 8384 legacy rollout remains open. Kotlin execution and e2e require CI.`);
