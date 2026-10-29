"""Independent offline secp256k1/raw-transaction/receipt/replay oracle. No JS, DB or network."""
import hashlib,json,struct
from pathlib import Path
P=2**256-2**32-977
N=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G=(0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
def add(a,b):
 if a is None:return b
 if b is None:return a
 x,y=a;u,v=b
 if x==u and (y+v)%P==0:return None
 slope=((v-y)*pow(u-x,-1,P) if x!=u else 3*x*x*pow(2*y,-1,P))%P
 z=(slope*slope-x-u)%P
 return z,(slope*(x-z)-y)%P
def multiply(k,a=G):
 result=None
 while k:
  if k&1:result=add(result,a)
  a=add(a,a);k>>=1
 return result
def key_point(key):
 x=int.from_bytes(key[1:],'big');y=pow((x*x*x+7)%P,(P+1)//4,P)
 if y%2!=key[0]%2:y=P-y
 return x,y
def compress(point):return bytes([2+point[1]%2])+point[0].to_bytes(32,'big')
def verify(r,s,digest,key):
 assert 0<r<N and 0<s<=N//2
 inv=pow(s,-1,N);point=add(multiply(int.from_bytes(digest,'big')*inv%N),multiply(r*inv%N,key_point(key)))
 assert point is not None and point[0]%N==r
 return True
def canonical(value):return json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
def recover(domain,value,signature):
 import base64
 raw=base64.urlsafe_b64decode(signature+'=');assert len(raw)==65 and 31<=raw[0]<=34
 r=int.from_bytes(raw[1:33],'big');s=int.from_bytes(raw[33:],'big');recovery=raw[0]-31
 digest=hashlib.sha256(b'huarong/hd1/'+domain.encode()+b'\0'+canonical(value)).digest()
 x=r+(recovery//2)*N;assert x<P
 R=key_point(bytes([2+recovery%2])+x.to_bytes(32,'big'));assert multiply(N,R) is None
 key=compress(multiply(pow(r,-1,N),add(multiply(s,R),multiply((-int.from_bytes(digest,'big'))%N))))
 verify(r,s,digest,key);return key
class Reader:
 def __init__(self,data):self.data=data;self.offset=0
 def take(self,n):
  assert self.offset+n<=len(self.data)
  result=self.data[self.offset:self.offset+n];self.offset+=n;return result
 def num(self,n):return int.from_bytes(self.take(n),'little')
 def compact(self):
  prefix=self.num(1)
  return prefix if prefix<253 else self.num({253:2,254:4,255:8}[prefix])
 def push(self):
  opcode=self.num(1);assert opcode<=77
  return self.take(opcode if opcode<76 else self.num(1 if opcode==76 else 2))
def compact(n):return bytes([n]) if n<253 else b'\xfd'+struct.pack('<H',n) if n<65536 else b'\xfe'+struct.pack('<I',n)
def variable(data):return compact(len(data))+data
def double(data):return hashlib.sha256(hashlib.sha256(data).digest()).digest()
def transaction(raw):
 data=bytes.fromhex(raw);r=Reader(data);version=r.take(4);assert version==b'\x02\0\0\0'
 inputs=[]
 for _ in range(r.compact()):inputs.append((r.take(32),r.take(4),r.take(r.compact()),r.take(4)))
 outputs=[]
 for _ in range(r.compact()):outputs.append((r.take(8),r.take(r.compact())))
 lock=r.take(4);assert r.offset==len(data)
 return {'id':double(data)[::-1].hex(),'version':version,'inputs':inputs,'outputs':outputs,'lock':lock}
def tx_signature(tx,index,previous,key):
 preimage=tx['version']+compact(len(tx['inputs']))
 for i,(txid,vout,script,sequence) in enumerate(tx['inputs']):preimage+=txid+vout+variable(previous if i==index else b'')+sequence
 preimage+=compact(len(tx['outputs']))+b''.join(amount+variable(script) for amount,script in tx['outputs'])+tx['lock']+b'\x01\0\0\0'
 reader=Reader(tx['inputs'][index][2]);signature=reader.push();assert reader.push()==key and signature[-1]==1
 der=Reader(signature[:-1]);assert der.num(1)==0x30 and der.num(1)==len(signature)-3
 assert der.num(1)==2;r=int.from_bytes(der.take(der.num(1)),'big')
 assert der.num(1)==2;s=int.from_bytes(der.take(der.num(1)),'big')
 verify(r,s,double(preimage),key)
def replay(claim,optimum):
 shapes=[(2,2)]+[(1,2)]*4+[(2,1)]+[(1,1)]*4
 state=[claim['b'].index(chr(65+i)) for i in range(10)]
 def grid():
  cells=['.']*20
  for i,(pos,(w,h)) in enumerate(zip(state,shapes)):
   x,y=pos%4,pos//4;assert x>=0 and y>=0 and x+w<=4 and y+h<=5
   for dy in range(h):
    for dx in range(w):
     cell=(y+dy)*4+x+dx;assert cells[cell]=='.';cells[cell]=chr(65+i)
  return ''.join(cells)
 assert grid()==claim['b']
 alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
 for symbol in claim['m']:
  assert state[0]!=13
  action=alphabet.index(symbol);assert action<40
  piece,direction=divmod(action,4);dx,dy=[(0,-1),(1,0),(0,1),(-1,0)][direction]
  x,y=state[piece]%4+dx,state[piece]//4+dy;assert 0<=x<=4-shapes[piece][0] and 0<=y<=5-shapes[piece][1]
  state[piece]=y*4+x;grid()
 assert state[0]==13 and len(claim['m'])>=optimum
 moves=len(claim['m']);return moves,(20*optimum**3+moves**2)//(2*moves**2)
ROOT=Path(__file__).resolve().parent
history=json.loads((ROOT/'fixtures/history.json').read_text())
paths={p['l']:p for p in json.loads((ROOT/'fixtures/paths.json').read_text())}
key=bytes.fromhex(history['bootstrap']['appKey']);marker=bytes.fromhex(history['bootstrap']['markerKey'])
pay=lambda key:b'\x76\xa9\x14'+hashlib.new('ripemd160',hashlib.sha256(key).digest()).digest()+b'\x88\xac'
previous={tx['id']:tx for tx in map(transaction,history['previousTransactions'])};head=None;rows=[];names={}
for observed in sorted(history['transactions'],key=lambda row:(row['height'],row['index'])):
 tx=transaction(observed['raw']);named=[]
 if tx['id']!=history['bootstrap']['txid'] and not any(rawid[::-1].hex()+':'+str(int.from_bytes(index,'little'))==head for rawid,index,_,_ in tx['inputs']):continue
 for index,(amount,script) in enumerate(tx['outputs']):
  if script[0] not in (0x51,0x52):continue
  reader=Reader(script);operation=reader.num(1);name=reader.push();value=reader.push()
  assert name==b'g/huarong-lb' and reader.take(2)==b'\x6d\x75' and reader.take(25)==pay(key)
  named.append((index,value))
 assert len(named)==1 and any(script==pay(marker) for _,script in tx['outputs'])
 for index,(rawid,vout,_,_) in enumerate(tx['inputs']):
  old=previous[rawid[::-1].hex()]['outputs'][int.from_bytes(vout,'little')][1]
  assert old[-25:]==pay(key);tx_signature(tx,index,old,key)
 output,value=named[0];receipt=json.loads(value);assert canonical(receipt)==value and list(receipt)==list('pwlbnmsa')
 app_signature=receipt.pop('a');assert recover('app',receipt,app_signature)==key
 player_signature=receipt.pop('s');player=recover('player',receipt,player_signature).hex()
 assert names.setdefault(player,receipt['n'])==receipt['n'] and receipt['b']==paths[receipt['l']]['b']
 moves,points=replay(receipt,paths[receipt['l']]['optimum'])
 stamps=sorted(h['time'] for h in history['headers'][max(0,observed['height']-10):observed['height']+1]);week=(stamps[(len(stamps)-1)//2]-345600)//604800
 rows.append({'player':player,'layout':receipt['l'],'moves':moves,'points':points,'week':week,'height':observed['height']})
 head=tx['id']+':'+str(output);previous[tx['id']]=tx
assert [row['moves'] for row in rows]==[1536,116]
assert min(rows,key=lambda row:row['moves'])['points']==1160
# Publication can use the authenticated included head before either score is finalized.
for confirmations in range(1,7):
 tip_length=2+confirmations
 included=[row for row in rows if tip_length-row['height']>=1]
 finalized=[row for row in included if tip_length-row['height']>=6]
 assert len(included)==2
 assert len(finalized)==(0 if confirmations<5 else 1 if confirmations==5 else 2)
 assert (rows[1] in finalized)==(confirmations==6)
assert head==transaction(history['transactions'][-1]['raw'])['id']+':0'
print('PASS independent Python: 2 raw lineage transactions, full previous-script DER signatures, 4 compact receipt signatures, actual paths 1536/116, lifetime/week 1160 points; one-confirmation head separate from six-finalized receipts; no Supabase/JS/network')
