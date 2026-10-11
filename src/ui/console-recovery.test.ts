import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'
import {tmpDir} from '../../test/helpers/tmp.ts'

// Actual Console and its serve child, inside a process-local hard-line host.
// The host owns cursor/rows/history independently; it fails on unknown controls.
// Native XTerm evidence remains separate: this host does not model Unicode reflow.
const actor=String.raw`
import assert from 'node:assert/strict'
const [module,root,geometry,gravity,scenario,initialLines]=process.argv.slice(2)
const {tuiCmd}=await import(module),[initialCols,initialRows]=geometry.split('x').map(Number),direct=scenario.startsWith('direct')
let paintedRows=0,paintEpoch=0,delivered=0,lastReplyFrame=-1,lastReplyGeometry='',lateDelivered=0;const heldReplies=[];let cols=initialCols,rows=initialRows,x=0,y=0,grid=Array.from({length:rows},()=>Array(cols).fill(' ')),history=[],raw=false,queries=0,bytes=0,clears=0,paste=false
const original=Array.from({length:Number(initialLines??67)},(_,i)=>'SHELL'+String(i).padStart(2,'0'))
const text=()=>[...history,...grid.map(r=>r.join('').trimEnd())]
const down=()=>{if(++y>=rows){history.push(grid.shift().join('').trimEnd());grid.push(Array(cols).fill(' '));y=rows-1}}
const reply=s=>{
 queries++;const at=paintEpoch,geometry=cols+'x'+rows
 const deliver=()=>{process.stdin.emit('data',Buffer.from(s));delivered++;if(s.endsWith('R')){lastReplyFrame=at;lastReplyGeometry=geometry}}
 if(scenario==='late')heldReplies.push(deliver);else if(scenario!=='silent')queueMicrotask(deliver)
}
const put=s=>{for(let i=0;i<s.length;){let c=s[i++];if(c==='\x1b'){
 if(s.slice(i).startsWith('P$qr\x1b\\')){i+='P$qr\x1b\\'.length;reply('\x1bP1$r1;'+rows+'r\x1b\\');continue}
 const m=/^\[([0-?]*)([ -/]*)([@-~])/.exec(s.slice(i));assert.ok(m,'unknown control');i+=m[0].length;const a=m[1].split(';').map(Number),n=a[0]||1,end=m[3]
 if(end==='p'&&m[2]==='$'&&['?6','?69'].includes(m[1]))reply('\x1b['+m[1]+';2$y')
 else if(end==='n'&&m[1]==='6')reply('\x1b['+(y+1)+';'+(Math.min(x,cols-1)+1)+'R')
 else if((end==='h'||end==='l')&&m[1]==='?2004')paste=end==='h'
 else if(end==='m'){}
 else if(end==='A')y=Math.max(0,y-n);else if(end==='B')y=Math.min(rows-1,y+n)
 else if(end==='C')x=Math.min(cols-1,x+n);else if(end==='D')x=Math.max(0,x-n)
 else if(end==='H'){y=Math.min(rows-1,(a[0]||1)-1);x=Math.min(cols-1,(a[1]||1)-1)}
 else if(end==='J'){assert.equal(a[0],2,'never erase terminal scrollback');clears++;grid=Array.from({length:rows},()=>Array(cols).fill(' '))}
 else if(end==='K'){assert.equal(a[0],2);grid[y]=Array(cols).fill(' ')}
 else if(end==='M'){const count=Math.min(n,rows-y);grid.splice(y,count);grid.push(...Array.from({length:count},()=>Array(cols).fill(' ')))}
 else assert.fail('unknown CSI '+m[0])
 }else if(c==='\r')x=0;else if(c==='\n')down();else{
 const cp=s.codePointAt(i-1);if(cp>65535){c=String.fromCodePoint(cp);i++}const w=cp>=0x2e80?2:1
 if(x+w>cols){x=0;down()}grid[y][x]=c;if(w===2)grid[y][x+1]='';x+=w
 }}}
if(original.length)put(original.join('\r\n')+'\r\n')
const savedWrite=process.stdout.write.bind(process.stdout)
for(const [key,get] of [['columns',()=>cols],['rows',()=>rows],['isTTY',()=>true]])Object.defineProperty(process.stdout,key,{configurable:true,get})
Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true})
Object.defineProperty(process.stdin,'isRaw',{configurable:true,get:()=>raw})
process.stdin.setRawMode=n=>{raw=n;return process.stdin}
process.stdout.write=(s,encoding,cb)=>{const b=Buffer.isBuffer(s)?s.toString():s;bytes+=Buffer.byteLength(b);if(b&&!b.startsWith(String.fromCharCode(27)+'[?6$p'))paintEpoch++;paintedRows=Math.max(paintedRows,b.split(String.fromCharCode(27)+'[2K').length-1);put(b);const f=typeof encoding==='function'?encoding:cb;if(f)queueMicrotask(f);return true}
const wait=n=>new Promise(r=>setTimeout(r,n))
// Positive recovery scenes wait for observable current-frame receipts; a fixed delay alone is not proof.
const settle=async()=>{
 let previous=bytes,quiet=0
 for(let i=0;i<500;i++){
  await wait(20)
  const complete=queries>=4&&delivered===queries&&lastReplyFrame===paintEpoch&&lastReplyGeometry===cols+'x'+rows
  quiet=complete&&bytes===previous?quiet+1:0;previous=bytes
  if(quiet>=3)return
 }
 assert.fail('current completed Console frame receipts did not settle:'+JSON.stringify({queries,delivered,paintEpoch,lastReplyFrame,lastReplyGeometry,cols,rows}))
}
const proven=scenario==='regular'||scenario==='direct-startup'
const resize=(nextCols,nextRows)=>{
 if(nextRows<rows){const remove=gravity==='south'?Math.max(0,y-nextRows+1):0;if(remove){history.push(...grid.slice(0,remove).map(r=>r.join('').trimEnd()));grid=grid.slice(remove);y-=remove}grid=grid.slice(0,nextRows)}
 else if(nextRows>rows){const restore=gravity==='south'?Math.min(nextRows-rows,history.length):0;if(restore){grid=[...history.splice(history.length-restore).map(s=>Array.from(s)),...grid];y+=restore}while(grid.length<nextRows)grid.push(Array(nextCols).fill(' '))}
 cols=nextCols;rows=nextRows;grid=grid.map(r=>[...r.slice(0,cols),...Array(Math.max(0,cols-r.length)).fill(' ')]);x=Math.min(x,cols-1);y=Math.min(y,rows-1);process.emit('SIGWINCH')
}
const signals=['SIGINT','SIGTERM','SIGHUP','SIGWINCH'],before=signals.map(s=>process.listenerCount(s))
// Keep a nonempty current-task counterexample after the compact empty layout changed the old empty case.
if(scenario==='direct-task'){
 const {pathToFileURL}=await import('node:url'),{openLog}=await import(new URL('../log/log.ts',pathToFileURL(module)))
 const log=openLog(root,{write:'round',clock:false})
 try{await log.append('round',{t:'round/state',round:'r1',from:'Idle',to:'Planning'});await log.append('round',{t:'round/intent',round:'r1',body:'check original history'})}finally{await log.close()}
}
globalThis.fugueBeforeKeys=async()=>{
 for(let i=0;i<500&&paintedRows===0;i++)await wait(20)
 assert.ok(paintedRows>0,'the actual empty source frame precedes raw attachment')
 assert.equal(raw,false);globalThis.fugueFirstUnready={caret:[y,x],regionRows:paintedRows}
}
const done=tuiCmd(root,new Map([['interval','25'],['no-style',true]]))
for(let i=0;i<500&&!raw;i++)await wait(20)
assert.ok(raw,'actual Console attached raw keys')
let firstCaret=null,firstRegionRows=null
if(proven)await settle()
if(scenario==='direct-startup'){
 for(let i=0;i<500&&queries<4;i++)await wait(20)
 await wait(150);firstCaret=[y,x];firstRegionRows=paintedRows
 assert.equal(firstRegionRows,Math.max(8,initialRows-5)+3,'original frame capacity plus current hint and editor stays unchanged')
 assert.equal(y,initialRows-1,'first actual Console editor ends on physical bottom before any edit')
}
// Empty source may paint before raw/probe attachment; a real edit requests the next completed frame.
process.stdin.emit('data',Buffer.from('\x1b[200~check retry\x1b[201~'))
for(let i=0;i<500&&scenario!=='silent'&&queries<4;i++)await wait(20)
if(scenario!=='silent')assert.ok(queries>=4)
await wait(150)
let idles=0
for(const [c,r] of [[24,12],[16,8],...(direct?[]:[[initialCols,initialRows]])]){
 if(proven)await settle()
 resize(c,r)
 if(scenario==='late'&&lateDelivered===0){const old=heldReplies.splice(0,4);assert.equal(old.length,4);for(const deliver of old){deliver();lateDelivered++}}
 await wait(150);if(proven)await settle();if(scenario==='regular'||scenario==='direct-startup')assert.equal(y,r-1,'editor caret stays on current bottom row')
 if(scenario==='direct-startup')assert.equal(grid.map(line=>line.join('').trimEnd()).filter(line=>line.startsWith('按键')).length,r===12?1:0,'only the current hint is visible; short input has no spare hint row')
 const b=bytes;await wait(100);assert.equal(bytes,b,'unchanged Console/source poll emits no bytes');idles++
}
if(!direct)assert.ok(text().join('\n').includes('check retry'),'retained draft is visible after height return')
process.stdin.emit('data',Buffer.from('\x1b'));await wait(150);process.stdin.emit('data',Buffer.from('\x04'))
assert.equal(await done,0);assert.equal(raw,false,'actual Console restores raw mode');assert.equal(paste,false,'bracketed paste restored');assert.deepEqual(signals.map(s=>process.listenerCount(s)),before)
assert.equal(process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length,0,'serve child finished')
const lines=text();while(lines.length&&!lines.at(-1))lines.pop()
const exact=JSON.stringify(lines)===JSON.stringify(original)
if(scenario==='regular'||(direct&&gravity==='north')||scenario==='direct'||scenario==='direct-startup')assert.deepEqual(lines,original,'entire original history, no old or current temporary UI')
else{assert.equal(exact,false,'counterexample remains failure under entire-history gate');for(const s of original)assert.equal(lines.filter(l=>l===s).length,1);if(scenario==='silent'||scenario==='late')assert.equal(clears,0,'no unproved viewport clear')}
savedWrite(JSON.stringify({scenario,geometry,gravity,exact,rows:lines.length,expected:original.length,firstCaret,firstRegionRows,firstUnready:globalThis.fugueFirstUnready??null,delivered,lateDelivered,idles,rawRestored:!raw,serveClosed:true,queries,clears})+'\n')
process.stdin.pause()
`

function run(geometry:string,gravity:string,scenario:string,initialLines=67,lateKeys=false){
 const root=tmpDir('fugue-console-recovery-'),file=join(root,'actor.mjs')
 mkdirSync(join(root,'.fugue'));writeFileSync(join(root,'.fugue/config'),JSON.stringify({ui:{glyphs:'ascii',images:'off'}}));writeFileSync(file,actor)
 let module=fileURLToPath(new URL('./console.ts',import.meta.url))
 if(lateKeys){
  const copied=join(root,'.fugue/startup-console.ts')
  let source=readFileSync(module,'utf8').replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g,(_all,quote,relative)=>'from '+quote+new URL(relative,new URL('./console.ts',import.meta.url)).href+quote)
  const mark='km = keymapOf(raw ?? {})';assert.equal(source.split(mark).length,2)
  source=source.replace(mark,mark+'\n      await (globalThis as any).fugueBeforeKeys()')
  writeFileSync(copied,source);module=copied
 }

 const r=spawnSync(process.execPath,[file,module,root,geometry,gravity,scenario,String(initialLines)],{encoding:'utf8',env:{...process.env,TERM:'xterm',FUGUE_SYSTEM_DIR:join(root,'system')},timeout:30000})
 assert.equal(r.status,0,r.stderr||String(r.error));return JSON.parse(r.stdout)
}
test('actual Console, raw decoder, scheduled cursor probe and serve compose a history-preserving partial-height return',()=>{
 const cases=[run('192x50','south','regular'),run('80x24','south','regular'),run('192x50','north','regular')]
 assert.ok(cases.every(c=>c.exact&&c.rawRestored&&c.serveClosed));assert.equal(cases.reduce((n,c)=>n+c.idles,0),9)
 console.log('Console recovery:actual tuiCmd/serve;3 geometries/gravities;67 entire original rows exact3/3;short editor bottom9/9;draft visible;idle9 bytes0;raw restored;signals/serve closed')
})
test('actual Console keeps silent-host and direct-short history failures distinct from successful exit and preserves every original line',()=>{
 const cases=[run('192x50','south','silent'),run('192x50','south','direct-task')]
 assert.ok(cases.every(c=>!c.exact&&c.rawRestored&&c.serveClosed));assert.equal(cases[0].clears,0)
 console.log('Console recovery floor:'+JSON.stringify(cases)+';entire-history failures retained;original67 each once is insufficient')
})


test('compact empty Console direct short exit now preserves all 67 original rows in the bounded SouthWest hard-line host',()=>{
 const current=run('192x50','south','direct')
 assert.ok(current.exact&&current.rows===67&&current.rawRestored&&current.serveClosed)
 console.log('Console empty direct:'+JSON.stringify(current)+';hard-line host only;native and nonempty task failures remain separate')
})

test('actual Console direct short exit preserves complete history when host gravity keeps the old top in the viewport',()=>{
 const cases=[run('192x50','north','direct'),run('80x24','north','direct')]
 assert.ok(cases.every(c=>c.exact&&c.rows===c.expected&&c.rawRestored&&c.serveClosed))
 assert.equal(cases.reduce((n,c)=>n+c.idles,0),4)
 console.log('Console direct exit:'+JSON.stringify(cases)+';NorthWest history exact2/2;SouthWest counterexample remains separate')
})

test('actual Console books its own blank rows at startup: fresh and one-line terminals keep input on the bottom, shrink without stale hints and preserve whole history',()=>{
 const cases=['192x50','80x40','80x24','24x12'].flatMap(geometry=>[0,1].map(n=>run(geometry,'south','direct-startup',n)))
 for(const c of cases){assert.ok(c.exact&&c.rawRestored&&c.serveClosed);assert.equal(c.rows,c.expected);assert.equal(c.firstCaret[0],Number(c.geometry.split('x')[1])-1)}
 console.log('Console startup:'+JSON.stringify(cases)+';actual raw/serve;initial bottom8/8;two simulated-host SIGWINCH sizes each;whole original history exact8/8;idle16 bytes0')
})

test('actual Console rejects four delayed old-frame reports after resize; unknown current frame cannot erase a viewport or claim whole-history acceptance',()=>{
 const c=run('192x50','south','late')
 assert.equal(c.lateDelivered,4);assert.equal(c.clears,0);assert.equal(c.exact,false);assert.ok(c.rawRestored&&c.serveClosed)
 console.log('Console late old reports:'+JSON.stringify(c)+';old replies4;unproved viewport clears0;full-history failure retained')
})

test('forcing the first empty Console frame before raw attachment keeps the eventual editor on the same physical bottom',()=>{
 const cases=['192x50','80x24'].flatMap(geometry=>[0,1].map(n=>run(geometry,'south','direct-startup',n,true)))
 for(const c of cases){assert.ok(c.firstUnready&&c.exact&&c.rawRestored&&c.serveClosed);assert.equal(c.firstUnready.caret[0],Number(c.geometry.split('x')[1])-1)}
 console.log('Console forced input attachment:'+JSON.stringify(cases)+';source-copy fixture changes only import paths and a before-keys timing barrier;actual serve/raw;bottom4/4;whole original history4/4;idle8 bytes0')
})
