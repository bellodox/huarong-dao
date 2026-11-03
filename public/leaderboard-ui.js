/* Same-origin versioned leaderboard UI. Network failure never blocks local play. */
(() => {
  'use strict';
  const OUTBOX_KEY='huarong_hd1_outbox_v1';
  const DISMISSED_RECEIPT_KEY='huarong_hd1_dismissed_receipt_v1';
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
    <div class="hd1-filters">
      <label class="hd1-filter block text-[11px] text-slate-300 font-semibold" for="hd1-scope">Период
        <select id="hd1-scope" class="block mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-2.5 text-slate-100 text-xs">
          <option value="lifetime">Всички времена</option><option value="week">Текуща седмица</option>
        </select>
      </label>
      <label class="hd1-filter block text-[11px] text-slate-300 font-semibold" for="hd1-view">Класиране
        <select id="hd1-view" class="block mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-2.5 text-slate-100 text-xs">
          <option value="overall">Общо точки</option><option value="layout">По подредба</option>
        </select>
      </label>
      <label id="hd1-layout-wrap" class="hd1-filter block text-[11px] text-slate-300 font-semibold" for="hd1-layout">Подредба
        <select id="hd1-layout" class="block mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-2.5 text-slate-100 text-xs" disabled></select>
      </label>
    </div>
    <p id="hd1-status" role="status" aria-live="polite" class="text-[11px] text-slate-400 mb-3 hd1-rank-note"></p>
    <div id="hd1-rows" class="space-y-1" aria-live="polite"></div>
    <div id="hd1-pending" class="mt-2 text-[11px] text-amber-200"></div>
    <details class="mt-3 pt-3 border-t border-slate-800 text-[11px] text-slate-400 hd1-rank-note">
      <summary class="cursor-pointer text-slate-300">Правила и проверка</summary>
      <p class="mt-2">Точките зависят от броя ходове и сложността на подредбата. При равен брой ходове в една подредба по-бързото прието време определя реда. За общото класиране важат общите точки. Времето се пази в класацията, но не и в публичната разписка; по-старите записи може да са без време. Ходовете се преиграват и потвърждават в блокчейна.</p>
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
  function syncTimeRules(){
    const rule=panel.querySelector('details p');
    if(rule)rule.textContent=t(
      'Точките зависят от ходовете и сложността. Само при равни ходове в една подредба по-бързото прието време решава класирането. Общото класиране остава по точки. Времето не е част от публичната разписка; старите записи може да са без време.',
      'Points depend on moves and layout complexity. Only when moves tie within the same layout does faster accepted time determine order. Overall ranking remains points-based. Time is not in the public receipt; older records may have no time.');
  }
  syncTimeRules();
  document.getElementById('btn-language')?.addEventListener('click',syncTimeRules);
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
    layoutSelect.disabled=view.value!=='layout';
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
  document.getElementById('ranking-submission-anchor')?.append(submissionBox);
  const submissionHeading=submissionBox.querySelector('#hd1-submission-heading');
  const submissionState=submissionBox.querySelector('#hd1-submission-state');
  const submissionScore=submissionBox.querySelector('#hd1-submission-score');
  const submissionNote=submissionBox.querySelector('#hd1-submission-note');
  let currentSubmissionId=null,currentSubmission=null;
  let latestConfirmations=0,settledShown=false,suppressedReceipt=null;
  let dismissedReceipt=null,lastModalClosedAt=0;
  try {const saved=localStorage.getItem(DISMISSED_RECEIPT_KEY);if(/^[a-f0-9]{64}$/.test(saved||''))dismissedReceipt=saved;}catch{}
  function onModalOpened(){
    if(currentSubmissionId && currentSubmissionId===dismissedReceipt){
      submissionBox.classList.add('hidden');return;
    }
    // Six confirmations end the transient notice only on the NEXT modal opening.
    if(latestConfirmations>=6 && settledShown && currentSubmissionId){
      suppressedReceipt=currentSubmissionId;
      submissionBox.classList.add('hidden');
    }else if(latestConfirmations>=6&&currentSubmissionId&&!suppressedReceipt){
      // First viewing of a completed result still shows its publication outcome.
      submissionBox.classList.remove('hidden');settledShown=true;
    }
  }
  function dismissReceipt(id){
    if(!id)return;
    dismissedReceipt=id;
    suppressedReceipt=id;
    submissionBox.classList.add('hidden');
    try{localStorage.setItem(DISMISSED_RECEIPT_KEY,id);}catch{}
  }
  function onModalClosed(){
    lastModalClosedAt=Date.now();
    dismissReceipt(currentSubmissionId);
  }
  // Explicit user actions, not DOM mutation observation (also works in Node.js fixtures).
  document.getElementById('btn-close-leaderboard')?.addEventListener('click',onModalClosed);
  const leaderboardModal=document.getElementById('leaderboard-modal');
  leaderboardModal?.addEventListener('click',event=>{
    if(event.target===leaderboardModal)onModalClosed();
  });
  leaderboardModal?.addEventListener('keydown',event=>{
    if(event.key==='Escape')onModalClosed();
  });
  function beginSubmission(run,id=null){
    if(!run)return;
    const layout=run.layout||run.l||'',player=run.player||nickname;
    // The game opens the status view with a run object, after signing supplies an ID.
    // Keep that ID rather than resetting the same receipt to an anonymous notice.
    const sameRun=currentSubmission&&currentSubmission.layout===layout&&
      currentSubmission.moves===run.moves&&currentSubmission.player===player;
    const receiptId=id||(sameRun?currentSubmissionId:null);
    if(receiptId!==currentSubmissionId){
      latestConfirmations=0;settledShown=false;suppressedReceipt=null;
    }
    currentSubmission={layout,moves:run.moves,player};
    currentSubmissionId=receiptId;
    submissionBox.classList.toggle('hidden',!!receiptId&&receiptId===dismissedReceipt);
    submissionHeading.textContent=t('Последен резултат','Latest result');
    const option=Array.from(rankLayout.options||[]).find(x=>x.value===currentSubmission.layout);
    const layoutNames={
      wings:['Класическа','Classic'],heng_dao_li_ma:['Четирима войници в редица','Four Pawns in a Row'],
      rear_guard:['Задна охрана','Rear Guard'],small_obstacle:['Уверено командване','Command with Ease'],
      ambush:['Засада','Ambush'],fayaa_sideBySide:['Рамо до рамо','Advance Side by Side'],
      fayaa_threeRoads:['Три пътя','Troops Along Three Routes'],fayaa_peach:['Сред прасковените цветове','Peach Blossom Garden'],
      fayaa_rain2:['Осемте формации на Джуге',"Zhuge's Eight Formations"],
      fayaa_cannotStop:['Невъзможно е да спреш','Hard to Stop'],fayaa_highRisk:['Без друг избор','No Other Choice']
    };
    const layoutName=layoutNames[currentSubmission.layout]?.[document.documentElement.lang==='en'?1:0]
      ||option?.textContent||currentSubmission.layout;
    submissionScore.textContent=layoutName+(Number.isSafeInteger(currentSubmission.moves)?' · '+currentSubmission.moves+' '+t('хода','moves'):'');
    submissionState.textContent=t('Подготовка…','Preparing…');
    submissionNote.textContent=t('Резултатът още не е приет от сървъра.','The server has not accepted this result yet.');
  }
  function statusMessage(row){
    const code=row?.status||row?.code;
    const mapping={
      queued:[t('Прието · на опашка','Accepted · queued'),t('Резултатът е приет. Очаква публикуване.','The result was accepted. Awaiting publication.')],
      unsigned_preparing:[t('Прието · подготвя се','Accepted · preparing'),t('Транзакцията се подготвя.','Transaction preparation is in progress.')],
      signed_persisted:[t('Подписано · непотвърдено','Signed · unconfirmed'),t('Транзакцията е запазена за публикуване.','The transaction is stored for publication.')],
      broadcast_pending:[t('Изпратено · непотвърдено','Broadcast · unconfirmed'),t('Изпратено; очаква потвърждения.','Sent; awaiting confirmations.')],
      broadcast_unknown:[t('Неизвестно излъчване','Broadcast uncertain'),t('Резултатът на излъчването още не е установен.','The broadcast outcome has not yet been established.')],
      included:[t('Включено в блок','Included in block'),t('Очаква необходимите потвърждения.','Awaiting required confirmations.')],
      confirmed:[t('Потвърдено','Confirmed'),t('Резултатът е потвърден в блокчейна.','The result is confirmed on-chain.')],
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
    const code=row?.status||row?.code;
    const confirmations=Number(row?.confirmations);
    const [label,note]=statusMessage(row);
    const count=Number.isSafeInteger(confirmations)&&confirmations>0?confirmations:0;
    latestConfirmations=code==='confirmed'&&count>=6?count:0;
    const shortLabels={
      queued:t('Прието','Queued'),unsigned_preparing:t('Подготовка','Preparing'),
      signed_persisted:t('Подписано','Signed'),broadcast_pending:t('Изпратено','Broadcast'),
      broadcast_unknown:t('Проверява се','Checking'),included:t('В блок','Included'),
      confirmed:t('Потвърдено','Confirmed'),not_improved:t('Без нов рекорд','No new record'),
      signing_unknown:t('Спряно','Paused'),reorged:t('Проверява се','Rechecking'),
      session_required:t('Невалидна сесия','No session'),invalid_session:t('Невалидна сесия','Invalid session')
    };
    const short=shortLabels[code]||t('Проверка','Checking');
    submissionState.textContent=(code==='confirmed'?'✓ ':'')+short+
      (count&&['included','confirmed'].includes(code)?' · '+count:'');
    submissionNote.textContent=note+(count?' · '+count+' '+t('потвърждения','confirmations'):'');
    submissionBox.title=label+' · '+submissionScore.textContent+' · '+submissionNote.textContent;
    submissionBox.setAttribute('aria-label',submissionBox.title);
    if(currentSubmissionId && (currentSubmissionId===dismissedReceipt ||
        (latestConfirmations>=6 && currentSubmissionId===suppressedReceipt))){
      submissionBox.classList.add('hidden');return;
    }
    submissionBox.classList.remove('hidden');
    if(latestConfirmations>=6 && !document.getElementById('leaderboard-modal')?.classList.contains('hidden'))
      settledShown=true;
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
  // The public per-layout tie-breaker is the accepted duration joined to its
  // confirmed receipt. Never reconstruct public time from this device's history.
  function timedClock(deciseconds) {
    const hours=Math.floor(deciseconds/36000),minutes=Math.floor(deciseconds%36000/600);
    const secs=Math.floor(deciseconds%600/10),tenths=deciseconds%10;
    const section=String(secs).padStart(2,'0')+'.'+tenths;
    return hours>0?`${hours}:${String(minutes).padStart(2,'0')}:${section}`:`${minutes}:${section}`;
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
      // Readable confirmed scores do not imply new-publication readiness.
      window.huarongLeaderboardReachable=true;
      snapshot=result;HUARONG_PUBLIC_ENABLED=result.available===true;
      window.huarongUpdateRankingPrivacy?.(HUARONG_PUBLIC_ENABLED);
      rows.replaceChildren();pending.replaceChildren();
      const list=Array.isArray(result.rows)?result.rows:[];
      const signedOutbox=outbox();
      list.forEach((row,i)=>{
        const line=document.createElement('div');line.className='hd1-row'+(i<3?' hd1-rank-'+(i+1):'');
        const place=document.createElement('span');place.className='hd1-position';place.textContent=String(i+1)+'.';
        const name=document.createElement('div');name.className='hd1-row-name';name.textContent=String(row.nickname||t('Играч','Player'));
        // A matching local receipt is stronger evidence than a display name, which is not unique.
        const ownedReceipt=Object.values(row.bests||{}).some(best=>
          typeof best?.receipt_id==='string'&&signedOutbox[best.receipt_id]?.player===nickname);
        const sameNickname=String(row.nickname||'')===String(nickname||'');
        if(ownedReceipt || sameNickname){
          line.classList.add('hd1-is-me');
          const mine=document.createElement('span');
          mine.className='hd1-me-marker';mine.textContent=t('Ти','You');
          name.append(mine);
          line.title=ownedReceipt?t('Този резултат съвпада със запис на това устройство.',
            'This score matches a record on this device.'):
            t('Това име съвпада с твоето; имената не са уникални.',
              'This name matches yours; names are not unique.');
        }
        const bests=Object.entries(row.bests||{}).filter(([,best])=>Number.isSafeInteger(best?.moves)&&best.moves>0);
        const chosen=view.value==='layout'?bests.filter(([layout])=>layout===layoutSelect.value):bests;
        const moveCount=chosen.reduce((count,[,best])=>count+best.moves,0);
        const validMoveCount=chosen.length>0;
        const isLayout=view.value==='layout';
        const publicDs=isLayout&&chosen.length===1&&
          Number.isSafeInteger(chosen[0][1].duration_ds)&&chosen[0][1].duration_ds>=0
          ?chosen[0][1].duration_ds:null;
        const metrics=document.createElement('span');metrics.className='hd1-row-metrics';
        const moves=validMoveCount?moveCount.toLocaleString():'—';
        metrics.textContent=moves+' '+t('хода','moves');
        metrics.title=t('Ходове: ','Moves: ')+moves;
        if(isLayout){
          const displayTime=publicDs===null?'—':timedClock(publicDs);
          metrics.textContent+=' · '+t('Време: ','Time: ')+displayTime;
          metrics.title+=' · '+t('Време: ','Time: ')+displayTime+' · '+(publicDs===null
            ?t('За този запис няма публично време.','No public time is available for this record.')
            :t('Времето е прието от сървъра; Блокчейнът потвърждава ходовете, не времето.',
               'Server-accepted time; The blockchain confirms moves, not elapsed time.'));
        }else{
          metrics.title+=' · '+Number(row.completed||0).toLocaleString()+' '+t('подредби','layouts');
        }
        const body=document.createElement('div');body.className='hd1-row-body';
        body.append(name,metrics);
        const amount=document.createElement('div');amount.className='shrink-0';
        const value=document.createElement('div');value.className='hd1-row-score';value.textContent=Number(row.points||0).toLocaleString()+' '+t('т.','pts');
        amount.append(value);line.append(place,body,amount);rows.append(line);
      });
      if(!list.length){const empty=document.createElement('p');empty.className='rounded-xl bg-slate-900/70 border border-slate-700/70 p-4 text-center text-slate-400 text-xs';empty.textContent=t('Все още няма потвърдени резултати.','No confirmed scores yet.');rows.append(empty);}
      if(Array.isArray(result.pending)&&result.pending.length){
        const notice=document.createElement('p');notice.textContent=t('Очакват потвърждение: ','Awaiting confirmation: ')+result.pending.length;
        pending.append(notice);
      }
      const code=result.publisher?.code??result.code;
      status.textContent=!HUARONG_PUBLIC_ENABLED?(code==='issuance_disabled'?t('Новите изпращания са изключени · наличните публични записи остават видими','New submissions are off · existing public scores remain visible'):t('Новите изпращания временно не са достъпни · показани са публичните записи','New submissions temporarily unavailable · displaying public scores')):
        result.stale?t('Данните не са актуални · показани са последно известните резултати','Data may be outdated · showing the last known scores'):
        t('Потвърдени записи · независимо преиграни ходове','Confirmed records · independently replayed moves');
      // Only fixed allowlisted codes are ever displayed. Never show backend-provided free text.
      if(!HUARONG_PUBLIC_ENABLED&&['issuer_not_configured','storage_not_configured','rate_secret_not_configured','funding_compression_incompatible','invalid_publisher_configuration','schema_upgrade_required','initial_sync','publisher_stale','provider_timeout','provider_unavailable','publisher_unavailable','funds_unavailable','bootstrap_pin_required','identity_configuration_mismatch','checkpoint_mismatch','history_changed','history_page_gap','wrong_network','conflict_suspected','signing_unknown','retry_exhausted','recovery_required'].includes(code)){
        const reason=document.createElement('span');reason.textContent=' ('+code+')';status.append(reason);
      }
      backup.classList.toggle('hidden',!localStorage.getItem('huarong_rod_identity_v1'));
    }catch{
      if(current!==generation)return;
      window.huarongLeaderboardReachable=false;
      HUARONG_PUBLIC_ENABLED=false;
      window.huarongUpdateRankingPrivacy?.(false);
      status.textContent=t('Връзката с класацията не е достъпна · опитай с обновяване','Could not load the leaderboard · try refreshing');
      if(!rows.childElementCount){
        const notice=document.createElement('p');
        notice.className='rounded-xl border border-slate-700 bg-slate-900/70 p-3 text-slate-400 text-xs text-center';
        notice.textContent=t('Публичните резултати временно не могат да се заредят.','Public scores are temporarily unavailable.');
        rows.append(notice);
      }
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
          const expected=window.huarongExpectedSubmission;
          const newRun=expected&&expected.player===player&&
            expected.layout===layout&&expected.moves===evidence.moves;
          const closedBeforeSigning=newRun&&lastModalClosedAt&&Number(expected.at)<=lastModalClosedAt;
          if(closedBeforeSigning)dismissReceipt(claim.id);
          beginSubmission(signed,claim.id);
          if(newRun){
            window.huarongExpectedSubmission=null;
            // Only the new run may open a modal; an older dismissed run cannot.
            if(!closedBeforeSigning)
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
  window.hd1UI={candidate,refresh,sync,beginSubmission,refreshSubmission,onModalOpened};
  refresh();
})();
