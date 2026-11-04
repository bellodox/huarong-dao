import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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
  let state={available:true,stale:false,epoch:100,rows:[]};
  const context={document:doc,rankLayout,location:{protocol:'https:'},
    URLSearchParams,AbortSignal,HUARONG_PUBLIC_ENABLED:false,
    nickname:'ALICE',SCORE_STORE_V2_KEY:'huarong_local_scores_v2',
    localStorage:{getItem:key=>store.get(key)??null,setItem:(key,val)=>store.set(key,String(val))},
    window:{addEventListener(){}},
    fetch:async url=>{
      urlCalls.push(String(url));
      return {ok:true,json:async()=>String(url).startsWith('/api/submissions/')
        ?state.submission:{...state}};
    }
  };
  const script=readFileSync(new URL('../public/leaderboard-ui.js',import.meta.url),'utf8');
  runInNewContext(script,context);
  return {context,element,store,urlCalls,set:(next)=>{state={...state,...next};},
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
