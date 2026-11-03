/* Same-origin versioned leaderboard UI. Network failure never blocks local play. */
(() => {
  'use strict';
  const OUTBOX_KEY='huarong_hd1_outbox_v1';
  let snapshot=null,busy=false,generation=0;
  const panel=document.createElement('section');
  panel.id='hd1-public-board';
  panel.className='rounded-xl border border-slate-700/70 bg-slate-950/35 p-3 text-xs';
  panel.innerHTML=`
    <div class="flex items-center justify-between gap-3 mb-3">
      <div class="min-w-0">
        <h3 class="hd1-board-title font-extrabold text-amber-300">Резултати</h3>
        <p class="text-[11px] text-slate-400 mt-1">Потвърдени резултати · ходовете са проверени</p>
      </div>
      <button id="hd1-refresh" type="button" aria-label="Обнови класацията" title="Обнови класацията" class="shrink-0 border border-slate-700 bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 text-amber-200 font-bold">↻</button>
    </div>
    <section id="hd1-submission" class="hd1-submission hidden" aria-live="polite" aria-label="Статус на изпращане">
      <div class="flex items-center justify-between gap-2 mb-1">
        <strong id="hd1-submission-heading" class="text-amber-200">Последен резултат</strong>
        <span id="hd1-submission-state" class="hd1-submission-status">Подготовка…</span>
      </div>
      <p id="hd1-submission-score" class="text-[11px] text-slate-300"></p>
      <p id="hd1-submission-note" class="text-[11px] text-slate-400 mt-1"></p>
    </section>
    <div class="grid grid-cols-2 gap-2 mb-3">
      <label class="block text-[11px] text-slate-300 font-semibold" for="hd1-scope">Период
        <select id="hd1-scope" class="block mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-2.5 text-slate-100 text-xs">
          <option value="lifetime">Всички времена</option><option value="week">Текуща седмица</option>
        </select>
      </label>
      <label class="block text-[11px] text-slate-300 font-semibold" for="hd1-view">Класиране
        <select id="hd1-view" class="block mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-2.5 text-slate-100 text-xs">
          <option value="overall">Общо точки</option><option value="layout">По подредба</option>
        </select>
      </label>
    </div>
    <label id="hd1-layout-wrap" class="hidden block mb-3 text-[11px] text-slate-300 font-semibold" for="hd1-layout">Подредба
      <select id="hd1-layout" class="block mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-2.5 text-slate-100 text-xs"></select>
    </label>
    <p id="hd1-status" role="status" aria-live="polite" class="text-[11px] text-slate-400 mb-3 hd1-rank-note"></p>
    <div id="hd1-rows" class="space-y-1" aria-live="polite"></div>
    <div id="hd1-pending" class="mt-2 text-[11px] text-amber-200"></div>
    <details class="mt-3 pt-3 border-t border-slate-800 text-[11px] text-slate-400 hd1-rank-note">
      <summary class="cursor-pointer text-slate-300">Правила и проверка</summary>
      <p class="mt-2">Класирането се определя от броя ходове и сложността на подредбата, не от времето. За общото класиране ходовете са сбор от личните рекорди по подредби. Времето не се публикува в ROD и е видимо само на устройството, на което е записано. Публикуваните ходове се преиграват и потвърждават в блокчейна.</p>
    </details>
    `;
  const backup=document.createElement('button');
  backup.id='hd1-backup';backup.type='button';
  backup.className='hidden w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-200';
  backup.textContent='Архивирай самоличността';
  document.getElementById('hd1-backup-anchor')?.append(backup);
  const anchor=document.getElementById('hd1-public-anchor');
  if(anchor&&typeof anchor.replaceWith==='function')anchor.replaceWith(panel);
  else document.getElementById('ranking-source').after(panel);
  const status=panel.querySelector('#hd1-status'),rows=panel.querySelector('#hd1-rows'),pending=panel.querySelector('#hd1-pending');
  const scope=panel.querySelector('#hd1-scope'),view=panel.querySelector('#hd1-view'),layoutSelect=panel.querySelector('#hd1-layout');
  const t=(bg,en)=>document.documentElement?.lang==='en'?en:bg;
  function syncLayoutChoices(preferGame=false){
    const options=Array.from(rankLayout.options||[]);
    if(!options.length)return;
    const old=layoutSelect.value;
    if(layoutSelect.options?.length!==options.length){
      layoutSelect.replaceChildren();
      for(const option of options){const copy=document.createElement('option');copy.value=option.value;copy.textContent=option.textContent;layoutSelect.append(copy);}
    }
    const selected=preferGame?rankLayout.value:old;
    layoutSelect.value=options.some(option=>option.value===selected)?selected:(rankLayout.value||options[0].value);
  }
  function changeView(){
    panel.querySelector('#hd1-layout-wrap').classList.toggle('hidden',view.value!=='layout');
    refresh();
  }
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
  const submissionBox=panel.querySelector('#hd1-submission');
  const submissionHeading=panel.querySelector('#hd1-submission-heading');
  const submissionState=panel.querySelector('#hd1-submission-state');
  const submissionScore=panel.querySelector('#hd1-submission-score');
  const submissionNote=panel.querySelector('#hd1-submission-note');
  let currentSubmissionId=null,currentSubmission=null;
  function beginSubmission(run,id=null){
    if(!run)return;
    currentSubmission={layout:run.layout||run.l||'',moves:run.moves,player:run.player||nickname};
    currentSubmissionId=id;
    submissionBox.classList.remove('hidden');
    submissionHeading.textContent=t('Последен резултат','Latest result');
    const option=Array.from(rankLayout.options||[]).find(x=>x.value===currentSubmission.layout);
    const layoutName=option?.textContent||currentSubmission.layout;
    submissionScore.textContent=layoutName+(Number.isSafeInteger(currentSubmission.moves)?' · '+currentSubmission.moves+' '+t('хода','moves'):'');
    submissionState.textContent=t('Подготовка…','Preparing…');
    submissionNote.textContent=t('Резултатът още не е приет от сървъра.','The server has not accepted this result yet.');
  }
  function statusMessage(row){
    const code=row?.status||row?.code;
    const mapping={
      queued:[t('Прието · на опашка','Accepted · queued'),t('Резултатът е приет. Очаква излъчване в ROD.','The result was accepted. Awaiting ROD broadcast.')],
      unsigned_preparing:[t('Прието · подготвя се','Accepted · preparing'),t('Транзакцията се подготвя.','Transaction preparation is in progress.')],
      signed_persisted:[t('Подписано · непотвърдено','Signed · unconfirmed'),t('Транзакцията е запазена за публикуване.','The transaction is stored for publication.')],
      broadcast_pending:[t('Изпратено · непотвърдено','Broadcast · unconfirmed'),t('Изпратено в ROD; очаква потвърждения.','Sent to ROD; awaiting confirmations.')],
      broadcast_unknown:[t('Неизвестно излъчване','Broadcast uncertain'),t('Резултатът на излъчването още не е установен.','The broadcast outcome has not yet been established.')],
      included:[t('Включено в блок','Included in block'),t('Очаква необходимите потвърждения.','Awaiting required confirmations.')],
      confirmed:[t('Потвърдено в ROD','Confirmed on ROD'),t('Резултатът е потвърден в блокчейна.','The result is confirmed on-chain.')],
      not_improved:[t('Няма нов рекорд','No new record'),t('Няма строго подобрение; не се изпраща нова транзакция.','No strict improvement; no new transaction is published.')],
      signing_unknown:[t('Подписването е спряно','Signing paused'),t('Провери състоянието по-късно.','Check the status later.')],
      reorged:[t('Проверява се отново','Rechecking'),t('Промяна във веригата; потвърждението се преоценява.','Chain changed; confirmation is being re-evaluated.')],
      session_required:[t('Няма валидна сесия','No valid session'),t('Този резултат не може да бъде публикуван.','This result cannot be published.')],
      invalid_session:[t('Невалидна сесия','Invalid session'),t('Резултатът остава локален.','The result stays local.')]
    };
    return mapping[code] || [t('Статусът не е потвърден','Status unverified'),t('Изпращането може да е прието. Провери статуса по-късно.','The request may have been accepted. Check its status again later.')];
  }
  /** Public score status is separate from confirmed standings; never render backend text as HTML. */
  function showStatus(row,id=null){
    if(id&&currentSubmissionId&&id!==currentSubmissionId)return;
    if(id)currentSubmissionId=id;
    if(!currentSubmission){
      const signed=id&&outbox()[id];
      if(signed)beginSubmission(signed,id);
    }
    if(!currentSubmission)return;
    submissionBox.classList.remove('hidden');
    const [label,note]=statusMessage(row);
    submissionState.textContent=label;
    const confirmations=Number(row?.confirmations);
    submissionNote.textContent=note+((row?.status==='included'||row?.status==='confirmed')&&Number.isSafeInteger(confirmations)&&confirmations>0?' · '+confirmations+' '+t('потвърждения','confirmations'):'');
    if(row?.publication_retryable===false&&['queued','broadcast_unknown','broadcast_pending'].includes(row?.status))
      submissionNote.textContent+=' · '+t('Автоматичното повторно изпращане е недостъпно.','Automatic resubmission is unavailable.');
  }
  /** Refresh is explicit/read-only; no retry or mutation occurs on viewing the leaderboard. */
  async function refreshSubmission(){
    const saved=outbox();
    if(!currentSubmissionId){
      const entries=Object.values(saved).filter(item=>item?.id&&item.player===nickname);
      if(!entries.length)return;
      const last=entries.at(-1);
      beginSubmission(last,last.id);
    }
    if(!/^https?:$/.test(location.protocol)||!currentSubmissionId)return;
    const id=currentSubmissionId;
    try{
      const res=await fetch('/api/submissions/'+encodeURIComponent(id),{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(res.ok&&currentSubmissionId===id)showStatus(await res.json(),id);
    }catch{/* Do not misreport confirmed status after network failure. */}
  }
  /** Time is deliberately not part of hd2, public receipts or score calculation.
      Display it only when the same receipt has a matching record on this device. */
  function localTimeFor(layout, best, signedOutbox, evidence) {
    if(!best || typeof best.receipt_id!=='string')return null;
    const signed=signedOutbox[best.receipt_id], run=signed?.localId&&evidence[signed.localId];
    if(!run || run.l!==layout || run.moves!==best.moves || !Number.isSafeInteger(run.seconds) || run.seconds<0)return null;
    return run.seconds;
  }
  function clock(seconds) {
    const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
    return h>0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${m}:${String(s).padStart(2,'0')}`;
  }
  /** Viewing is walletless. The confirmed public leaderboard is separate from local runs. */
  async function refresh(){
    if(!/^https?:$/.test(location.protocol))return;
    const current=++generation;
    syncLayoutChoices();
    try{
      const params=new URLSearchParams({scope:scope.value});
      if(view.value==='layout')params.set('layout',layoutSelect.value||rankLayout.value||'wings');
      if(scope.value==='week')params.set('week',String(snapshot?.epoch??0));
      const response=await fetch('/api/leaderboard?'+params,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('backend_unavailable');
      const result=await response.json();if(current!==generation)return;
      snapshot=result;HUARONG_PUBLIC_ENABLED=result.available===true;
      window.huarongUpdateRankingPrivacy?.(HUARONG_PUBLIC_ENABLED);
      rows.replaceChildren();pending.replaceChildren();
      const list=Array.isArray(result.rows)?result.rows:[];
      let evidence={};
      try{evidence=JSON.parse(localStorage.getItem(SCORE_STORE_V2_KEY)||'{}').evidence||{};}catch{}
      const signedOutbox=outbox();
      list.forEach((row,i)=>{
        const line=document.createElement('div');line.className='hd1-row'+(i<3?' hd1-podium hd1-rank-'+(i+1):'');
        const place=document.createElement('span');place.className='hd1-position';place.textContent=String(i+1);
        const body=document.createElement('div');body.className='min-w-0 flex-1';
        const name=document.createElement('div');name.className='hd1-row-name';name.textContent=String(row.nickname||t('Играч','Player'));
        if(String(row.nickname||'')===String(nickname||'')){
          line.classList.add('hd1-is-me');
          line.title=t('Това е твоето име (възможно е да има едноименни играчи).',
            'This matches your name (other players may use the same name).');
        }
        const details=document.createElement('div');details.className='hd1-row-sub';
        const bests=Object.entries(row.bests||{}).filter(([,best])=>Number.isSafeInteger(best?.moves)&&best.moves>0);
        const chosen=view.value==='layout'?bests.filter(([layout])=>layout===layoutSelect.value):bests;
        const moveCount=chosen.reduce((count,[,best])=>count+best.moves,0);
        const validMoveCount=chosen.length>0;
        const times=chosen.map(([layout,best])=>localTimeFor(layout,best,signedOutbox,evidence));
        const localSeconds=times.length && times.every(seconds=>seconds!==null)
          ? times.reduce((sum,seconds)=>sum+seconds,0):null;
        const metrics=document.createElement('div');metrics.className='hd1-row-metrics';
        metrics.textContent=t('Ходове: ','Moves: ')+(validMoveCount?moveCount.toLocaleString():'—')+
          ' · '+t('Време: ','Time: ')+(localSeconds===null?'—':clock(localSeconds));
        if(localSeconds!==null)metrics.title=t('Времето е от този браузър; не се публикува и не влияе на точките.',
          'Time is from this browser; it is not published and does not affect points.');
        else metrics.title=t('Времето не е част от публичните записи.', 'Time is not part of public records.');
        details.append(metrics);
        if(view.value==='overall'){
          const count=document.createElement('div');count.className='hd1-row-layouts';
          count.textContent=Number(row.completed||0).toLocaleString()+' '+t('подредби','layouts');
          details.append(count);
        }
        body.append(name,details);
        const amount=document.createElement('div');amount.className='shrink-0';
        const value=document.createElement('div');value.className='hd1-row-score';value.textContent=Number(row.points||0).toLocaleString();
        const unit=document.createElement('div');unit.className='hd1-row-unit';unit.textContent=t('точки','points');
        amount.append(value,unit);line.append(place,body,amount);rows.append(line);
      });
      if(!list.length){const empty=document.createElement('p');empty.className='rounded-xl bg-slate-900/70 border border-slate-700/70 p-4 text-center text-slate-400 text-xs';empty.textContent=t('Все още няма потвърдени резултати.','No confirmed scores yet.');rows.append(empty);}
      if(Array.isArray(result.pending)&&result.pending.length){
        const notice=document.createElement('p');notice.textContent=t('Очакват потвърждение: ','Awaiting confirmation: ')+result.pending.length;
        pending.append(notice);
      }
      const code=result.publisher?.code??result.code;
      status.textContent=!HUARONG_PUBLIC_ENABLED?(code==='issuance_disabled'?t('Публичното изпращане е изключено · локалната игра продължава','Public submission is off · your games stay local'):t('Публичното изпращане не е достъпно · резултатът е локален','Public submission unavailable · your score stays local')):
        result.stale?t('Данните не са актуални · показани са последно известните резултати','Data may be outdated · showing the last known scores'):
        t('Потвърдени записи · независимо преиграни ходове','Confirmed records · independently replayed moves');
      // Only fixed allowlisted codes are ever displayed. Never show backend-provided free text.
      if(!HUARONG_PUBLIC_ENABLED&&['issuer_not_configured','storage_not_configured','rate_secret_not_configured','funding_compression_incompatible','invalid_publisher_configuration','schema_upgrade_required','initial_sync','publisher_stale','provider_timeout','provider_unavailable','publisher_unavailable','funds_unavailable','bootstrap_pin_required','identity_configuration_mismatch','checkpoint_mismatch','history_changed','history_page_gap','wrong_network','conflict_suspected','signing_unknown','retry_exhausted','recovery_required'].includes(code)){
        const reason=document.createElement('span');reason.textContent=' ('+code+')';status.append(reason);
      }
      backup.classList.toggle('hidden',!localStorage.getItem('huarong_rod_identity_v1'));
    }catch{
      if(current!==generation)return;
      HUARONG_PUBLIC_ENABLED=false;
      window.huarongUpdateRankingPrivacy?.(false);
      status.textContent=t('Публичното изпращане не е достъпно · резултатът е локален','Public submission unavailable · your score stays local');
    }
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
            const state=await known.json();if(!consented())return;showStatus(state,signed.id);
            // Publication authority is separate from local consent and legacy claim retryability.
            if(state.publication_retryable===false&&['queued','broadcast_unknown','broadcast_pending'].includes(state.status))return;
            // GET only observes. An explicit consented retry reuses the same signed POST.
            if(!['not_improved','queued','unsigned_preparing','signed_persisted','broadcast_pending','broadcast_unknown'].includes(state.status))return;
          }
          if(!consented())return;
          const headers={'Content-Type':'application/json','Idempotency-Key':signed.id};
          if(signed.witness?.id&&signed.witness?.proof&&signed.witness?.rodAnchor?.hash){
            const w=signed.witness;
            Object.assign(headers,{'X-HD-Session-Id':w.id,'X-HD-Session-Proof':w.proof,
              'X-HD-Session-Seed':w.sessionSeed,'X-HD-Layout-Seed':w.layoutSeed,
              'X-HD-Rules-Digest':w.rulesDigest,'X-HD-Session-Nonce':w.nonce,
              'X-HD-Session-Head':w.head,'X-HD-Session-Input-Digest':w.inputDigest,
              'X-HD-ROD-Block-Hash':w.rodAnchor.hash,'X-HD-ROD-Block-Height':String(w.rodAnchor.height)});
          }
          const response=await fetch('/api/score',{method:'POST',headers,body:signed.bytes,signal:AbortSignal.timeout(15000)});
          if(!consented())return;
          const state=await response.json();if(!consented())return;showStatus(state,signed.id);
          if(state.code==='epoch_changed')setPublicScoreConsent(false);
        }catch(error){if(consented())showStatus({code:error.message},signed.id);}
      }
      // Persisted consent-authorized bytes remain recoverable even when a newer run is chosen.
      for(const signed of Object.values(durable).filter(row=>row.player===player)) {
        if(!consented())return;
        if(!signed.witness?.id||!signed.witness?.proof||!signed.witness?.rodAnchor?.hash)continue; // Historical bytes remain locally durable.
        await retry(signed);
      }
      for(const layout of [...new Set(evidenceRows().map(row=>row.l))]) {
        if(!consented())return;
        const evidence=candidate(layout);if(!evidence?.witness?.id||!evidence?.witness?.proof||!evidence?.witness?.rodAnchor?.hash)continue;
        const previous=Object.values(durable).find(row=>row.localId===evidence.localId&&row.epoch===snapshot.epoch&&row.player===player);
        if(previous){
          if(!previous.witness?.proof){previous.witness=evidence.witness;durable[previous.id]=previous;saveOutbox(durable);await retry(previous);}
          continue;
        }
        try {
          const claim=cryptoModule.createSignedClaim(evidence,player,snapshot.epoch,{consented});
          const signed={...claim,localId:evidence.localId,layout,moves:evidence.moves,epoch:snapshot.epoch,player,witness:evidence.witness};
          durable[claim.id]=signed;saveOutbox(durable);
          beginSubmission(signed,claim.id);
          const expected=window.huarongExpectedSubmission;
          if(expected&&expected.player===player&&expected.layout===layout&&expected.moves===evidence.moves){
            window.huarongExpectedSubmission=null;
            window.huarongOpenSubmissionStatus?.({layout,moves:evidence.moves,player});
          }
          await retry(signed);
        }catch(error){if(consented())showStatus({code:error.message});}
      }
      backup.classList.toggle('hidden',!localStorage.getItem('huarong_rod_identity_v1'));
    }catch(error){showStatus({code:error.message});}
    finally{busy=false;}
  }
  backup.onclick=async()=>{
    try {const module=await import('/leaderboard-client.js');const blob=new Blob([module.exportIdentity()],{type:'application/json'});
      const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='huarong-player-backup.json';link.click();URL.revokeObjectURL(link.href);
    }catch{document.getElementById('nickname-feedback').textContent=t('Архивирането не успя · самоличността не е променена','Backup failed · identity unchanged');}
  };
  scope.onchange=refresh;view.onchange=changeView;
  layoutSelect.onchange=()=>{if(rankLayout.value!==layoutSelect.value){rankLayout.value=layoutSelect.value;rankLayout.dispatchEvent?.(new Event('change'));}refresh();};
  rankLayout.addEventListener('change',()=>{layoutSelect.value=rankLayout.value;refresh();});
  panel.querySelector('#hd1-refresh').addEventListener('click',()=>{refresh();refreshSubmission();});
  document.getElementById('btn-leaderboard').addEventListener('click',()=>{syncLayoutChoices(true);refresh();refreshSubmission();});
  window.addEventListener('online',()=>{refresh();sync();});
  window.hd1UI={candidate,refresh,sync,beginSubmission,refreshSubmission};
  refresh();
})();
