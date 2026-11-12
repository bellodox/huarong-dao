import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as cryptoModule from '../leaderboard/client.js';

/** Deliberately no MutationObserver: the app must work in the CI VM fixture. */
function fixture(){
  const elements=new Map(),store=new Map(),urlCalls=[];
  const fresh=(id='')=>{
    const handlers=new Map(),classes=new Set();
    return {
      id,value:'',textContent:'',children:[],className:'',title:'',disabled:false,
      get options(){return this.children;},get childElementCount(){return this.children.length;},
      classList:{add(name){classes.add(name);},remove(name){classes.delete(name);},
        contains(name){return classes.has(name);},toggle(name,on){
          if(on===undefined)on=!classes.has(name);
          if(on)classes.add(name);else classes.delete(name);return on;
        }},
      addEventListener(type,fn){let arr=handlers.get(type)||[];arr.push(fn);handlers.set(type,arr);},
      emit(type,props={}){for(const fn of handlers.get(type)||[])fn({target:this,type,...props});},
      replaceChildren(...children){this.children=children;this.textContent='';},
      append(...children){this.children.push(...children);},after(){},replaceWith(){},
      querySelector(sel){return element(sel);},
      setAttribute(name,value){this[name]=value;},getAttribute(name){return this[name]??null;}
    };
  };
  const element=id=>{
    if(!elements.has(id))elements.set(id,fresh(id));
    return elements.get(id);
  };
  const rankLayout=fresh('layout');rankLayout.value='rear_guard';
  rankLayout.append(Object.assign(fresh('option'),{value:'rear_guard',textContent:'Rear Guard'}));
  element('#hd1-scope').value='lifetime';
  element('#hd1-view').value='overall';
  element('btn-language').textContent='EN';
  const doc={documentElement:{lang:'bg'},createElement:(tag)=>fresh(tag),getElementById:element};
  let state={available:true,stale:false,epoch:100,rows:[]},known=true,signCalls=0;
  const postCalls=[];
  const signing={...cryptoModule,createSignedClaim(...args){signCalls++;return cryptoModule.createSignedClaim(...args);}};
  const context={document:doc,rankLayout,location:{protocol:'https:'},
    URLSearchParams,AbortSignal,HUARONG_PUBLIC_ENABLED:false,
    nickname:'ALICE',SCORE_STORE_V2_KEY:'huarong_local_scores_v2',
    allowPublicScores:false,publicNameReady:true,nameLocked:true,isPracticeLayout:()=>false,
    __cryptoModule:signing,
    localStorage:{getItem:key=>store.get(key)??null,setItem:(key,val)=>store.set(key,String(val))},
    window:{addEventListener(){}},
    fetch:async (url,init)=>{
      urlCalls.push(String(url));
      if(init?.method==='POST'){postCalls.push(init);return {ok:true,json:async()=>({status:'queued'})};}
      return {ok:!String(url).startsWith('/api/submissions/')||known,json:async()=>String(url).startsWith('/api/submissions/')
        ?state.submission:{...state}};
    }
  };
  const script=readFileSync(new URL('../public/leaderboard-ui.js',import.meta.url),'utf8');
  // Replace only the lazy module loader; all eligibility/retry code runs unchanged.
  runInNewContext(script.replace("await import('/leaderboard-client.js')",'__cryptoModule'),context);
  return {context,element,store,urlCalls,postCalls,signCalls:()=>signCalls,known:value=>{known=value;},set:(next)=>{state={...state,...next};},
    refresh:async()=>{await context.window.hd1UI.refresh();},
    submitted:async()=>{await context.window.hd1UI.refreshSubmission();}};
}
const RECEIPT_A='a'.repeat(64),RECEIPT_B='b'.repeat(64);
const ranked=(duration_ds)=>({player:'02'+'c'.repeat(64),nickname:'ALICE',points:820,completed:1,
  bests:{rear_guard:{moves:82,points:820,receipt_id:RECEIPT_A,duration_ds}}});

test('public time is displayed only for one layout, never reconstructed for overall ranking',async()=>{
  const f=fixture();
  f.set({rows:[ranked(432)]});
  await f.refresh();
  const overall=f.element('#hd1-rows').children[0].children[2];
  assert.equal(f.element('#hd1-rows').children.length,1);
  assert.doesNotMatch(f.element('#hd1-rows').children[0].children[2]?.textContent||'',/Time:|Време:/);
  const line=f.element('#hd1-rows').children[0];
  assert.doesNotMatch(line.children[1].children[1].textContent,/Time:|Време:/);
  f.element('#hd1-view').value='layout';
  await f.refresh();
  assert.match(f.element('#hd1-rows').children[0].children[1].children[1].textContent,/43\.2/);
  f.set({rows:[ranked(null)]});
  await f.refresh();
  assert.match(f.element('#hd1-rows').children[0].children[1].children[1].textContent,/—/);
  assert(!overall?.textContent?.includes('Time:'));
});

test('modal close dismisses the same receipt during pending and confirmed updates',async()=>{
  const f=fixture();const ui=f.context.window.hd1UI;
  ui.beginSubmission({layout:'rear_guard',moves:82,player:'ALICE'},RECEIPT_A);
  assert.equal(f.element('#hd1-submission').classList.contains('hidden'),false);
  f.element('btn-close-leaderboard').emit('click');
  assert.equal(f.store.get('huarong_hd1_dismissed_receipt_v1'),RECEIPT_A);
  f.set({submission:{status:'queued',confirmations:0}});
  await f.submitted();
  assert.equal(f.element('#hd1-submission').classList.contains('hidden'),true);
  f.set({submission:{status:'confirmed',confirmations:10}});
  await f.submitted();ui.onModalOpened();
  assert.equal(f.element('#hd1-submission').classList.contains('hidden'),true);
  // The game does not know the signed receipt ID. The same run must not clear it.
  ui.beginSubmission({layout:'rear_guard',moves:82,player:'ALICE'});
  await f.submitted();
  assert(f.urlCalls.at(-1).endsWith(RECEIPT_A));
  assert.equal(f.element('#hd1-submission').classList.contains('hidden'),true);
  // A genuinely distinct accepted receipt can be shown.
  ui.beginSubmission({layout:'rear_guard',moves:80,player:'ALICE'},RECEIPT_B);
  assert.equal(f.element('#hd1-submission').classList.contains('hidden'),false);
});

test('backdrop and Escape also dismiss, with no MutationObserver required',()=>{
  const f=fixture(),ui=f.context.window.hd1UI;
  ui.beginSubmission({layout:'rear_guard',moves:82,player:'ALICE'},RECEIPT_A);
  f.element('leaderboard-modal').emit('click',{target:f.element('leaderboard-modal')});
  assert.equal(f.element('#hd1-submission').classList.contains('hidden'),true);
  ui.beginSubmission({layout:'rear_guard',moves:81,player:'ALICE'},RECEIPT_B);
  f.element('leaderboard-modal').emit('keydown',{key:'Escape'});
  assert.equal(f.store.get('huarong_hd1_dismissed_receipt_v1'),RECEIPT_B);
});

test('submission notice preserves authoritative retry failures with allowlisted translated reasons',async()=>{
  const f=fixture(),ui=f.context.window.hd1UI;
  ui.beginSubmission({layout:'rear_guard',moves:82,player:'ALICE'},RECEIPT_A);
  for(const language of ['bg','en']) {
    f.context.document.documentElement.lang=language;
    for(const status of ['queued','broadcast_unknown','broadcast_pending']) {
      f.set({submission:{status,publication_retryable:false,retry_code:'spend_budget_exhausted'}});
      await f.submitted();
      assert.match(f.element('#hd1-submission-note').textContent,language==='en'?/spend budget exhausted/:/изчерпан бюджет за разходи/);
    }
    for(const retry_code of ['constructor','<img src=x onerror=alert(1)>']) {
      f.set({submission:{status:'queued',publication_retryable:false,retry_code}});await f.submitted();
      assert.equal(f.element('#hd1-submission-note').textContent,language==='en'?'Publication retry unavailable':'Повторното публикуване не е достъпно');
    }
    f.set({submission:{status:'included',publication_retryable:false,retry_code:null}});await f.submitted();
    assert.doesNotMatch(f.element('#hd1-submission-note').textContent,/retry unavailable|Повторното/);
  }
});

test('time tie-break explanation uses English after language switch',()=>{
  const f=fixture();
  f.context.document.documentElement.lang='en';
  f.element('btn-language').emit('click');
  assert.match(f.element('details p').textContent,/Only when moves tie within the same layout/);
});


test('over-220 signed outbox stays byte-identical and read-only, without starving eligible retries or signing oversized evidence',async()=>{
  for(const language of ['bg','en'])for(const known of [false,true]) {
    const f=fixture();await f.refresh();f.context.document.documentElement.lang=language;
    f.context.allowPublicScores=true;f.known(known);
    const witness={id:'session',proof:'proof',rodAnchor:{hash:'a'.repeat(64)}};
    // Deliberately misleading metadata: the actual signed path must control retry admission.
    const oversized={id:RECEIPT_A,player:'ALICE',moves:1,layout:'wings',bytes:JSON.stringify({m:'A'.repeat(448)}),witness};
    const eligible={id:RECEIPT_B,player:'ALICE',moves:999,layout:'rear_guard',bytes:JSON.stringify({m:'A'.repeat(220)}),witness};
    const saved=JSON.stringify({[RECEIPT_A]:oversized,[RECEIPT_B]:eligible});
    f.store.set('huarong_hd1_outbox_v1',saved);
    const evidence=JSON.stringify({evidence:{long:{p:'hd1',n:'ALICE',l:'wings',m:'A'.repeat(221),moves:221,witness}}});
    f.store.set('huarong_local_scores_v2',evidence);
    f.context.window.hd1UI.beginSubmission(oversized,RECEIPT_A);
    f.set({submission:{status:'queued',publication_retryable:true}});
    await f.context.window.hd1UI.sync();
    assert.equal(f.postCalls.length,1);assert.equal(f.postCalls[0].body,eligible.bytes);
    assert.equal(f.signCalls(),0,'ineligible evidence must not reach signing');
    assert.equal(f.store.get('huarong_hd1_outbox_v1'),saved);
    assert.equal(f.store.get('huarong_local_scores_v2'),evidence);
    assert(f.urlCalls.includes('/api/submissions/'+RECEIPT_A));
    assert.equal(f.store.has('huarong_rod_identity_v1'),false);
    assert.match(f.element('#hd1-submission-note').textContent,known?
      (language==='en'?/accepted/:/приет/):(language==='en'?/220 moves inclusive/:/220 хода включително/));
  }
});
