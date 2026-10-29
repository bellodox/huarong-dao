import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyClaim,readClaim,checkOrigin } from '../leaderboard/verify.js';
import { canonical,receiptId,signPlayer } from '../leaderboard/receipt.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const text=canonical(playerClaim,7), id=receiptId(playerClaim);
test('Worker independently derives points and player identity',()=>{
  const verified=verifyClaim(text,id);assert.equal(verified.moves,116);assert.equal(verified.points,1160);assert.equal(verified.player.length,66);
});
test('invalid claims have stable errors before admission',()=>{
  for(const [body,key,code] of [[text,'wrong','idempotency_conflict'],[text+' ',id,'malformed'],['a'.repeat(8193),id,'payload_too_large']])
    assert.throws(()=>verifyClaim(body,key),error=>error.code===code);
  const secret=Uint8Array.from([...Array(31).fill(0),1]);
  const {s,...unsigned}=playerClaim;
  const invalid=signPlayer({...unsigned,m:'A'},secret);
  assert.throws(()=>verifyClaim(canonical(invalid,7),receiptId(invalid)),error=>error.code==='invalid_replay');
});
test('origin, content-type, declared and streamed payload bounds precede crypto',async()=>{
  checkOrigin(new Request('https://game.test/api/score',{headers:{origin:'https://game.test'}}));
  assert.throws(()=>checkOrigin(new Request('https://game.test/api/score',{headers:{origin:'https://evil.test'}})));
  await assert.rejects(readClaim(new Request('https://game.test',{method:'POST',body:text})),error=>error.code==='malformed');
  for(const body of [text,'x'.repeat(8193)]) {
    const request=new Request('https://game.test',{method:'POST',headers:{'content-type':'application/json'},body});
    if(body.length>8192)await assert.rejects(readClaim(request),error=>error.code==='payload_too_large');
    else assert.equal(await readClaim(request),text);
  }
});
