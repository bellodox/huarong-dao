/* Ranked hd2 witness. The browser supplies untrusted gesture data; the relay
 * independently replays moves and commits to ordered, fresh checkpoints.
 * No per-move network calls and no randomization of the frozen game layouts.
 */
(() => {
  'use strict';
  const INTERVAL=40,MAX=1260,DOMAIN='huarong/ranked-session/v1';
  const HEX=/^[0-9a-f]{64}$/;
  const TOKEN=/^[A-Za-z0-9_-]{43}$/;
  let active=null;
  const digest=async (...parts)=>{
    const data=new TextEncoder().encode(JSON.stringify([DOMAIN,...parts]));
    const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',data));
    return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  };
  const post=async (url,data)=>{
    const response=await fetch(url,{method:'POST',cache:'no-store',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
    const body=await response.json();
    if(!response.ok||!body||body.code)throw Error(body?.code||'session_unavailable');
    return body;
  };
  function reset(){active=null;}
  async function start(layout,board){
    if(typeof layout!=='string'||typeof board!=='string'||['training','first_steps','next_steps'].includes(layout)){
      reset();return;
    }
    const s={layout,board,status:'pending',moves:'',trace:[],seq:0,token:null,id:null,
      began:performance.now(),queue:Promise.resolve(),proof:null,nonce:null,head:null,
      rulesDigest:null,layoutSeed:null,sessionSeed:null,rodAnchor:null};
    active=s;
    try{
      let ticket;
      try{ticket=await post('/api/session/start',{layout});}
      catch(error){
        if(error.message!=='anchor_changed')throw error;
        ticket=await post('/api/session/start',{layout});
      }
      if(active!==s||s.status!=='pending')return;
      if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ticket.id)||!TOKEN.test(ticket.token)||
        !HEX.test(ticket.nonce)||!HEX.test(ticket.head)||!HEX.test(ticket.rulesDigest)||
        !HEX.test(ticket.layoutSeed)||!HEX.test(ticket.sessionSeed)||
        !ticket.rodAnchor||!HEX.test(ticket.rodAnchor.hash)||
        !Number.isSafeInteger(ticket.rodAnchor.height)||ticket.rodAnchor.height<0||
        ticket.board!==board||
        !Number.isSafeInteger(ticket.optimum)||ticket.optimum<1||ticket.interval!==INTERVAL)
        throw Error('invalid_ticket');
      if(await digest('layout',layout,board,ticket.optimum,ticket.rulesDigest)!==ticket.layoutSeed||
         await digest('session',ticket.layoutSeed,ticket.id,ticket.nonce,
           ticket.rodAnchor.height,ticket.rodAnchor.hash)!==ticket.sessionSeed||
         await digest('chain-initial',ticket.sessionSeed)!==ticket.head)
        throw Error('seed_mismatch');
      if(active!==s||s.status!=='pending')return;
      Object.assign(s,{id:ticket.id,token:ticket.token,nonce:ticket.nonce,head:ticket.head,
        rulesDigest:ticket.rulesDigest,layoutSeed:ticket.layoutSeed,sessionSeed:ticket.sessionSeed,
        rodAnchor:ticket.rodAnchor,status:'ready'});
    }catch{
      if(active===s)s.status='invalid';
    }
  }
  function invalidate(){if(active)active.status='invalid';}
  function record(symbol,gesture){
    const s=active;
    const event=gesture?.event;
    // A real pointer event is required in the normal application. This is NOT
    // a cryptographically authenticated input origin against modified browsers.
    if(!s||s.status!=='ready'||typeof symbol!=='string'||symbol.length!==1||!gesture||
      !event||event.isTrusted!==true||typeof PointerEvent==='undefined'||!(event instanceof PointerEvent)||
      !['pointermove','pointerup'].includes(event.type)||event.clientX!==gesture.x1||event.clientY!==gesture.y1||
      !gesture.rect||gesture.rect.width<=0||gesture.rect.height<=0){invalidate();return;}
    const r=gesture.rect;
    const pos=(x,base,width,mult)=>Math.round((x-base)*mult/width);
    const entry=[gesture.kind,Math.max(0,Math.round(performance.now()-s.began)),
      pos(gesture.x0,r.left,r.width,4000),pos(gesture.y0,r.top,r.height,5000),
      pos(gesture.x1,r.left,r.width,4000),pos(gesture.y1,r.top,r.height,5000)];
    if(entry.some(x=>!Number.isSafeInteger(x))||s.moves.length>=MAX){invalidate();return;}
    s.moves+=symbol;s.trace.push(entry);
    if(s.moves.length%INTERVAL===0){
      const captured={moves:s.moves,trace:s.trace.map(x=>x.slice())};
      s.queue=s.queue.then(async()=>{
        if(s.status!=='ready')throw Error('invalid_session');
        const result=await post('/api/session/checkpoint',{
          id:s.id,layout:s.layout,seq:s.seq,token:s.token,nonce:s.nonce,
          rulesDigest:s.rulesDigest,layoutSeed:s.layoutSeed,sessionSeed:s.sessionSeed,
          rodAnchor:s.rodAnchor,head:s.head,...captured
        });
        if(result.seq!==s.seq+1||!TOKEN.test(result.token)||!HEX.test(result.head))
          throw Error('invalid_checkpoint');
        s.seq=result.seq;s.token=result.token;s.head=result.head;
      }).catch(()=>{s.status='invalid';});
    }
  }
  async function finish(fullMoves){
    const s=active;
    if(!s||s.status!=='ready'||s.moves!==fullMoves)return null;
    await s.queue;
    if(s.status!=='ready'||s.seq<2||active!==s)return null;
    try{
      const result=await post('/api/session/finish',{
        id:s.id,layout:s.layout,seq:s.seq,token:s.token,nonce:s.nonce,
        rulesDigest:s.rulesDigest,layoutSeed:s.layoutSeed,sessionSeed:s.sessionSeed,
        rodAnchor:s.rodAnchor,head:s.head,moves:s.moves,trace:s.trace
      });
      const traceHash=await digest('trace',s.trace);
      const localHead=await digest('chain-advance',s.head,s.sessionSeed,s.seq,'finish',s.moves,traceHash);
      const localInput=await digest('input-final',s.sessionSeed,s.moves,traceHash);
      if(result.id!==s.id||!TOKEN.test(result.proof)||result.head!==localHead||
        result.inputDigest!==localInput||result.sessionSeed!==s.sessionSeed||
        result.rulesDigest!==s.rulesDigest||result.layoutSeed!==s.layoutSeed||result.nonce!==s.nonce||
        result.rodAnchor?.hash!==s.rodAnchor.hash||result.rodAnchor?.height!==s.rodAnchor.height)
        throw Error('invalid_proof');
      if(active!==s)return null;
      s.status='sealed';
      s.proof={id:s.id,proof:result.proof,layoutSeed:s.layoutSeed,rulesDigest:s.rulesDigest,
        sessionSeed:s.sessionSeed,nonce:s.nonce,head:result.head,inputDigest:localInput,
        rodAnchor:s.rodAnchor};
      return s.proof;
    }catch{s.status='invalid';return null;}
  }
  const isPending=()=>active?.status==='pending';
  window.hdRanked={start,reset,record,finish,invalidate,isPending};
})();
