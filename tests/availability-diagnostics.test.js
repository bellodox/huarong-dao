import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { handleRelayRequest } from '../leaderboard/relay-entry.js';
import { bindings } from './publisher-fixture.js';

/** Exercise runtime configuration without allowing any external request or mutation. */
test('disabled public GET retains the precise sanitized configuration reason without enabling publication',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('unexpected_network');};
  try {
    for(const [env,code] of [[{},'issuer_not_configured'],[{HD1_PUBLISHER:'false'},'issuance_disabled'],
      [{ROD_APP_WIF:'not-exposed'},'storage_not_configured'],[{...bindings,HD1_RATE_HMAC_KEY:'short'},'rate_secret_not_configured'],
      [{...bindings,ROD_APP_WIF:'not-exposed'},'invalid_publisher_configuration']]) {
      const response=await handleRelayRequest(new Request('https://game.test/api/leaderboard?limit=1'),env);
      assert.equal(response.status,200);
      const result=await response.json();assert.equal(result.available,false);assert.equal(result.code,'issuance_disabled');
      assert.deepEqual(result.publisher,{available:false,code});assert.deepEqual(result.rows,[]);
      assert(!JSON.stringify(result).includes('not-exposed'));
    }
    assert.equal(calls,0);
  }finally {globalThis.fetch=original;}
});

/** Run the actual UI script with only the DOM surface used by walletless refresh. */
function uiFixture() {
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:id==='#hd1-scope'?'lifetime':'overall',textContent:'',children:[],
      classList:{remove(){},toggle(){}},addEventListener(){},after(){},
      replaceChildren(){this.children=[];this.textContent='';},append(child){this.children.push(child);},querySelector:element});
    return elements.get(id);
  };
  let result={available:false,code:'issuance_disabled'},failure=false;
  const context={document:{createElement:()=>element('panel'),getElementById:element},location:{protocol:'https:'},
    localStorage:{getItem:()=>null},URLSearchParams,AbortSignal,
    rankLayout:{addEventListener(){}},HUARONG_PUBLIC_ENABLED:false,window:{addEventListener(){}},
    fetch:async()=>{if(failure)throw Error('offline');return {ok:true,json:async()=>result};}};
  runInNewContext(readFileSync(new URL('../public/leaderboard-ui.js',import.meta.url),'utf8'),context);
  return {context,element,refresh:async(value,offline=false)=>{result=value;failure=offline;await context.window.hd1UI.refresh();},
    text:()=>element('#hd1-status').textContent+element('#hd1-status').children.map(child=>child.textContent).join('')};
}

test('UI distinguishes explicit disable from readiness failure and fails closed after a network outage',async()=>{
  const ui=uiFixture();
  await ui.refresh({available:false,code:'issuance_disabled',publisher:{code:'issuer_not_configured'}});
  assert.match(ui.text(),/не е достъпно/);assert.match(ui.text(),/issuer_not_configured/);
  for(const code of ['initial_sync','publisher_stale','schema_upgrade_required','funds_unavailable','recovery_required']) {
    await ui.refresh({available:false,publisher:{code}});
    assert.match(ui.text(),/не е достъпно/);assert.doesNotMatch(ui.text(),/е изключено/);
    assert.equal(ui.context.HUARONG_PUBLIC_ENABLED,false);
  }
  await ui.refresh({available:false,code:'issuance_disabled'});assert.match(ui.text(),/е изключено/);
  await ui.refresh({available:false,publisher:{code:'<script>private backend detail</script>'}});
  assert.doesNotMatch(ui.text(),/private backend detail/);
  await ui.refresh({available:true,stale:false});assert.equal(ui.context.HUARONG_PUBLIC_ENABLED,true);
  await ui.refresh(null,true);assert.equal(ui.context.HUARONG_PUBLIC_ENABLED,false);assert.match(ui.text(),/не е достъпно/);
});
