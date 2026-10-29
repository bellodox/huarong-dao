/* Same-origin hd1 UI. Network failure never blocks the puzzle or local score commit. */
(() => {
  'use strict';
  const OUTBOX_KEY='huarong_hd1_outbox_v1';
  let snapshot=null,busy=false,generation=0;
  const panel=document.createElement('section');panel.className='border border-slate-700 rounded-xl p-3 mt-3 text-xs';
  panel.id='hd1-public-board';
  panel.innerHTML='<h3 class="font-bold text-amber-300">Публична класация · преиграни резултати</h3>'+ 
    '<label for="hd1-scope">Период</label> <select id="hd1-scope" class="bg-slate-800"><option value="lifetime">Всички времена</option><option value="week">Текуща седмица</option></select>'+ 
    '<label for="hd1-view">Изглед</label> <select id="hd1-view" class="bg-slate-800"><option value="overall">Общо</option><option value="layout">Избрана подредба</option></select>'+ 
    '<p id="hd1-status" role="status" aria-live="polite"></p><div id="hd1-rows"></div><div id="hd1-pending"></div>'+ 
    '<p>Името, постоянният публичен ключ и целият път стават публични. Оттеглянето на съгласие не изтрива публикувани данни. Няма награди или преводи.</p>'+ 
    '<button id="hd1-backup" type="button" class="hidden mt-2">Архивирай самоличността</button>';
  document.getElementById('ranking-source').after(panel);
  const status=panel.querySelector('#hd1-status'),rows=panel.querySelector('#hd1-rows'),pending=panel.querySelector('#hd1-pending'),scope=panel.querySelector('#hd1-scope');
  /** Retain exact evidence independently of the local lifetime best and recent-five list. */
  function evidenceRows() {
    try {return Object.entries(JSON.parse(localStorage.getItem(SCORE_STORE_V2_KEY)||'{}').evidence||{}).map(([localId,row])=>({...row,localId})).filter(row=>
      row.p==='hd1'&&!row.assisted&&!isPracticeLayout(row.l)&&row.n===nickname&&typeof row.m==='string'&&row.m.length===row.moves);}catch{return [];}
  }
  function candidate(layout) {return evidenceRows().filter(row=>row.l===layout).at(-1)||null;}
  function outbox() {try{return JSON.parse(localStorage.getItem(OUTBOX_KEY)||'{}');}catch{return {};}}
  function saveOutbox(value) {
    const bytes=JSON.stringify(value);localStorage.setItem(OUTBOX_KEY,bytes);
    if(localStorage.getItem(OUTBOX_KEY)!==bytes)throw Error('outbox_save_failed');
  }
  /** Status is distinct from confirmed ranking; arbitrary backend strings are never rendered as HTML. */
  function showStatus(row) {
    const text={queued:'На опашка · непотвърдено',signed_persisted:'Подписано · непотвърдено',broadcast_pending:'Изпратено · непотвърдено',broadcast_unknown:'Неизвестен резултат · непотвърдено',signing_unknown:'Подписването е спряно за проверка',confirmed:'Потвърдено · поне 6 блока',reorged:'Реорганизация · проверката е спряна',not_improved:'Няма строго подобрение',epoch_changed:'Седмицата е сменена · нужно е ново съгласие',name_conflict:'Конфликт на публичното име · локалната игра продължава',evidence_too_large:'Целият път надхвърля 2048 байта · запазен е локално'};
    status.textContent=text[row.status||row.code]||'Публичното изпращане не е достъпно · резултатът е локален';
  }
  /** Viewing is walletless. Availability contains no secret or binding value. */
  async function refresh() {
    if(!/^https?:$/.test(location.protocol))return;
    const current=++generation;
    try {
      const params=new URLSearchParams({scope:scope.value});
      if(panel.querySelector('#hd1-view').value==='layout')params.set('layout',rankLayout.value||'wings');
      if(scope.value==='week')params.set('week',String(snapshot?.epoch??0));
      const response=await fetch('/api/leaderboard?'+params,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('backend_unavailable');
      const result=await response.json();if(current!==generation)return;
      snapshot=result;HUARONG_PUBLIC_ENABLED=result.available===true;
      rows.replaceChildren();pending.replaceChildren();
      for(const row of result.rows||[]) {
        const line=document.createElement('p');line.textContent=row.nickname+' · '+row.points+' т. · '+row.completed+' подредби';rows.append(line);
      }
      for(const row of result.pending||[]) {const line=document.createElement('p');line.textContent='Непотвърдено · '+(row.confirmations||0)+'/6';pending.append(line);}
      status.textContent=!HUARONG_PUBLIC_ENABLED?'Публичното изпращане е изключено · локалната игра продължава':result.stale?'Данните не са актуални · локалната игра продължава':'Преиграно · не доказва човешка игра';
      document.getElementById('ranking-public-privacy').classList.toggle('hidden',!HUARONG_PUBLIC_ENABLED);
      panel.querySelector('#hd1-backup').classList.toggle('hidden',!localStorage.getItem('huarong_rod_identity_v1'));
    }catch {status.textContent='Публичното изпращане не е достъпно · резултатът е локален';}
  }
  /** Opt-in only. Persist signed bytes before POST and reuse them after ambiguous failures. */
  async function sync() {
    if(busy||!HUARONG_PUBLIC_ENABLED||!allowPublicScores||!publicNameReady||!nameLocked)return;
    busy=true;
    const player=nickname,consented=()=>allowPublicScores&&publicNameReady&&nameLocked&&nickname===player;
    try {
      const cryptoModule=await import('/leaderboard-client.js');
      if(!consented())return;
      const durable=outbox();
      /** Recover one exact signed entry; an offline entry must not starve other evidence. */
      async function retry(signed) {
        try {
          if(!consented())return;
          const known=await fetch('/api/submissions/'+signed.id,{cache:'no-store',signal:AbortSignal.timeout(10000)});
          if(!consented())return;
          if(known.ok) {
            const state=await known.json();if(!consented())return;showStatus(state);
            // GET only observes. An explicit consented retry reuses the same signed POST.
            if(!['not_improved','queued','unsigned_preparing','signed_persisted','broadcast_pending','broadcast_unknown'].includes(state.status))return;
          }
          if(!consented())return;
          const response=await fetch('/api/score',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':signed.id},body:signed.bytes,signal:AbortSignal.timeout(15000)});
          if(!consented())return;
          const state=await response.json();if(!consented())return;showStatus(state);
          if(state.code==='epoch_changed')setPublicScoreConsent(false);
        }catch(error){if(consented())showStatus({code:error.message});}
      }
      // Persisted consent-authorized bytes remain recoverable even when a newer run is chosen.
      for(const signed of Object.values(durable).filter(row=>row.player===player)) {
        if(!consented())return;
        await retry(signed);
      }
      for(const layout of [...new Set(evidenceRows().map(row=>row.l))]) {
        if(!consented())return;
        const evidence=candidate(layout);if(!evidence)continue;
        if(Object.values(durable).some(row=>row.localId===evidence.localId&&row.epoch===snapshot.epoch&&row.player===player))continue;
        const claim=cryptoModule.createSignedClaim(evidence,player,snapshot.epoch,{consented});
        const signed={...claim,localId:evidence.localId,layout,moves:evidence.moves,epoch:snapshot.epoch,player};
        durable[claim.id]=signed;saveOutbox(durable);
        await retry(signed);
      }
      panel.querySelector('#hd1-backup').classList.remove('hidden');
    }catch(error){showStatus({code:error.message});}
    finally{busy=false;}
  }
  panel.querySelector('#hd1-backup').onclick=async()=>{
    try {const module=await import('/leaderboard-client.js');const blob=new Blob([module.exportIdentity()],{type:'application/json'});
      const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='huarong-player-backup.json';link.click();URL.revokeObjectURL(link.href);
    }catch{status.textContent='Архивирането не успя · самоличността не е променена';}
  };
  scope.onchange=refresh;panel.querySelector('#hd1-view').onchange=refresh;rankLayout.addEventListener('change',refresh);
  document.getElementById('btn-leaderboard').addEventListener('click',refresh);
  window.addEventListener('online',()=>{refresh();sync();});
  window.hd1UI={candidate,refresh,sync};
  refresh();
})();
