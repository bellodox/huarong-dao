// Read-only live check of the default provider. No keys, signing, broadcast or writes.
// Usage: node tests/live-provider-probe.js [baseUrl]
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createSpaceXpanseProvider,createTransport,checkHeader,PROVIDER_DEFAULTS } from '../leaderboard/provider.js';
import { parseTransaction } from '../leaderboard/chain.js';
import { bytesToHex,canonical } from '../leaderboard/receipt.js';
import { readFileSync } from 'node:fs';
const baseUrl=process.argv[2]??PROVIDER_DEFAULTS.baseUrl,started=new Date().toISOString(),transport=createTransport({baseUrl});
// Throwaway public keys with no funds and (expectedly) no history.
const key=n=>bytesToHex(secp256k1.getPublicKey(Uint8Array.from({length:32},(_,i)=>i+n)));
const info=await transport.get('/info'),anchorHeight=info.blocks-60;
const anchorRows=await transport.get(`/range/${anchorHeight}?offset=1`),anchor=checkHeader(anchorRows[0],anchorHeight);
const live=createSpaceXpanseProvider({baseUrl,appKey:key(7),markerKey:key(11),anchor:{height:anchor.height,hash:anchor.hash},allowUnprovenNameAbsence:true});
const status=await live.status();
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
// Full stable-tip acquisition (info, marker history, anchored headers, recheck) then funding: expected funds_unavailable.
let prepare;try {await live.prepare({bytes:canonical(playerClaim,7)});prepare='unexpected_success';}catch(error){prepare=error.message;}
// Exercise full anchored header sync + empty marker history through the reconcile path.
let block=null;
for(let height=status.tip.height;height>status.tip.height-60&&!block;height--){const b=await transport.get(`/height/${height}`);if(b.txcount>1)block=b;}
let funding=null;
if(block){const raw=(await transport.get(`/transaction/${block.tx[1]}`)).hex,tx=parseTransaction(raw,{funding:true});funding={txid:tx.txid===block.tx[1],version:tx.version,inputs:tx.inputs.length};}
console.log(JSON.stringify({started,finished:new Date().toISOString(),baseUrl,tip:status.tip,anchor:{height:anchor.height},
  appAddress:status.appAddress,markerAddress:status.markerAddress,prepareOutcome:prepare,fundingParse:funding},null,1));
if(prepare!=='funds_unavailable')process.exitCode=1;
