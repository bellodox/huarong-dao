// Portable deterministic probes used by Node tests and the loopback-only workerd fixture.
import { verifyOffline,reconstructOffline,signPlayer,signApp,canonical,receiptId,
  bytesToHex,hexToBytes,buildTransaction,serialize,concat,le,sighash,signTransaction } from '../relay.js';

/** Exercise the same distribution in both engines with public non-funded fixture keys only. */
export function relayProbe(input) {
  try {
    if(input.kind==='verify')return verifyOffline(input.text,input.appKey??null);
    if(input.kind==='reconstruct')return reconstructOffline(input.text,input.bootstrap);
    if(input.kind==='transaction') {
      const transaction=buildTransaction(input.prepared,input.receipt,hexToBytes(input.appKey),hexToBytes(input.markerKey));
      const preimages=transaction.inputs.map((input,index)=>bytesToHex(concat(serialize(transaction,
        transaction.inputs.map((_,i)=>i===index?input.previousScript:new Uint8Array())),le(1,4))));
      const digests=transaction.inputs.map((input,index)=>bytesToHex(sighash(transaction,index,input.previousScript)));
      return {preimages,digests,...signTransaction(transaction,hexToBytes('2'.padStart(64,'0')))};
    }
    if(input.kind==='signatures') {
      const player=signPlayer(input.unsigned,hexToBytes('1'.padStart(64,'0')));
      const receipt=signApp(player,hexToBytes('2'.padStart(64,'0')));
      return {player:canonical(player,7),receipt:canonical(receipt,8),id:receiptId(player)};
    }
    throw Error('unknown_probe');
  }catch(error){return {ok:false,code:error.code||error.message};}
}
