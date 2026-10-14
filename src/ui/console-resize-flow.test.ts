import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'
import {tmpDir} from '../../test/helpers/tmp.ts'

// Real Console/serve/CLI children and git writeback; deterministic model stub.
// Software hard-line host supplies resize/query reports. Native host pixels are
// separately recorded in R95, never inferred from this helper's reset grid.
const actor=String.raw`
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
const [module,root,scenario,strategy='current']=process.argv.slice(2),native=process.env.FUGUE_FLOW_NATIVE==='1'
const cli=join(dirname(dirname(module)),'cli/fugue.ts')
process.argv=[process.execPath,cli]
const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'flow',GIT_AUTHOR_EMAIL:'flow@localhost',GIT_COMMITTER_NAME:'flow',GIT_COMMITTER_EMAIL:'flow@localhost'}
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
git('init','-q','-b','main');writeFileSync(join(root,'keep.txt'),'keep original\n');git('add','keep.txt');git('commit','-qm','base')
let base=git('rev-parse','HEAD');const paths=['alpha.txt','beta.txt']
mkdirSync(join(root,'.fugue'),{recursive:true})
const check="const fs=require('fs');setTimeout(()=>process.exit("+ (scenario==='failure'?'7':"['alpha.txt','beta.txt'].every(p=>fs.readFileSync(p,'utf8').includes('改了 '+p))?0:9")+"),1300)"
writeFileSync(join(root,'checks.cjs'),check)
if(scenario!=='exception'){git('add','checks.cjs');git('commit','-qm','verification command');base=git('rev-parse','HEAD')}
writeFileSync(join(root,'.fugue/config'),JSON.stringify({round:{id:'r1'},actions:{check:{argv:[process.execPath,'checks.cjs'],outputs:[]}},ui:{glyphs:process.env.FUGUE_FLOW_GLYPH||'ascii',images:'off'}}))
const sections=[{kind:'investigate',question:'确认现有文件的保留范围',evidenceRequired:[{note:'保留范围'}],seed:['keep.txt']},...paths.map(p=>({kind:'implement',goal:'更新 '+p,ownedPaths:[p],deliverables:[{path:p,form:'文本文件'}],assertions:[{action:'check',name:'两个文件内容正确'}],seed:[]}))]
const draft=sections.map((s,i)=>'## 第 '+(i+1)+' 项\n\n\x60\x60\x60json\n'+JSON.stringify(s)+'\n\x60\x60\x60').join('\n\n')
const {openLog}=await import(pathToFileURL(join(dirname(module),'../log/log.ts')).href)
const seedPlan=async()=>{
const seed=openLog(root,{write:'round',sync:'each'})
await seed.append('round',{t:'round/intent',round:'r1',base,digest:'d'.repeat(16),body:JSON.stringify({goal:'核查现状并更新两个文件'})})
await seed.append('round',{t:'round/state',round:'r1',from:'Idle',to:'Planning'})
await seed.append('round',{t:'holder/distill',round:'r1',agent:'round',digest:'e'.repeat(16),body:draft})
await seed.close()
}
const {tuiCmd}=await import(module),initialCols=native?process.stdout.columns:192,initialRows=native?process.stdout.rows:50
let cols=initialCols,rows=initialRows,x=0,y=0,grid=Array.from({length:rows},()=>Array(cols).fill(' ')),history=[],raw=native?process.stdin.isRaw:false,queries=0,bytes=0,clears=0,paste=false
const original=Array.from({length:67},(_,i)=>'SHELL'+String(i).padStart(2,'0'))
const text=()=>[...history,...grid.map(r=>r.join('').trimEnd())]
const down=()=>{if(++y>=rows){history.push(grid.shift().join('').trimEnd());grid.push(Array(cols).fill(' '));y=rows-1}}
const reply=s=>{queries++;if(!native)queueMicrotask(()=>process.stdin.emit('data',Buffer.from(s)))}
const put=s=>{for(let i=0;i<s.length;){let c=s[i++];if(c==='\x1b'){
 if(s.slice(i).startsWith('P$qr\x1b\\')){i+='P$qr\x1b\\'.length;reply('\x1bP1$r1;'+rows+'r\x1b\\');continue}
 const m=/^\[([0-?]*)([ -/]*)([@-~])/.exec(s.slice(i));assert.ok(m,'unknown control');i+=m[0].length;const a=m[1].split(';').map(Number),n=a[0]||1,end=m[3]
 if(end==='p'&&m[2]==='$'&&['?6','?69'].includes(m[1]))reply('\x1b['+m[1]+';2$y')
 else if(end==='n'&&m[1]==='6')reply('\x1b['+(y+1)+';'+(Math.min(x,cols-1)+1)+'R')
 else if((end==='h'||end==='l')&&m[1]==='?2004')paste=end==='h'
 else if(end==='m'||(end==='p'&&m[2]==='$'&&m[1]==='?1049')){}
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
if(native)process.stdout.write(original.join('\r\n')+'\r\n');put(original.join('\r\n')+'\r\n')
const savedWrite=process.stdout.write.bind(process.stdout)
process.on('SIGWINCH',()=>{cols=process.stdout.columns;rows=process.stdout.rows;x=0;y=rows-1;grid=Array.from({length:rows},()=>Array(cols).fill(' '))})
if(!native){
for(const [key,get] of [['columns',()=>cols],['rows',()=>rows],['isTTY',()=>true]])Object.defineProperty(process.stdout,key,{configurable:true,get})
Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true})
Object.defineProperty(process.stdin,'isRaw',{configurable:true,get:()=>raw})
process.stdin.setRawMode=n=>{raw=n;return process.stdin}
}
process.stdout.write=(s,encoding,cb)=>{const b=Buffer.isBuffer(s)?s.toString():s;bytes+=Buffer.byteLength(b);put(b);if(native)savedWrite(s,encoding);const f=typeof encoding==='function'?encoding:cb;if(f)queueMicrotask(f);if(native)raw=process.stdin.isRaw;return true}

const wait=n=>new Promise(r=>setTimeout(r,n)),visible=()=>grid.map(r=>r.join('').trimEnd()).join('\n')
const until=async(f,why)=>{for(let i=0;i<2000;i++){if(f())return;await wait(20)}assert.fail(why+'\n'+visible())}
const events=()=>readFileSync(join(root,'.fugue/log/round.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s))
const count=t=>events().filter(e=>e.t===t).length
let snapshots=[],idleSamples=[]
const snap=async(name)=>{
 if(!name.startsWith('running')){await until(()=>process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length===1,'only serve remains at '+name);await wait(100);const b=bytes;await wait(100);assert.equal(bytes,b,'settled '+name+' emits no bytes');idleSamples.push({name,ms:100,bytes:bytes-b})}
 snapshots.push({name,screen:visible()})
 if(native)await observer.ready(name,name.startsWith('running')?undefined:2)
}
const signals=['SIGINT','SIGTERM','SIGHUP','SIGWINCH'],before=signals.map(s=>process.listenerCount(s))
const observer={ready:async()=>{}}
const send=async s=>{process.stdin.emit('data',Buffer.from(s));await wait(160)}
const body=()=>{const lines=visible().split('\n'),at=lines.findLastIndex(s=>s.includes('计划全文'));return at<0?'':(lines[at+1]??'').slice(2).trimStart()}
let resizeSeq=0
const resize=async(w,h)=>{
 resizeSeq++;cols=w;rows=h;x=0;y=rows-1;grid=Array.from({length:rows},()=>Array(cols).fill(' '))
 process.emit('SIGWINCH');await wait(450)
 assert.deepEqual([process.stdout.columns,process.stdout.rows],[w,h])
}


const commandStarts=[],seenChildren=new Set()
const monitor=setInterval(()=>{for(const h of process._getActiveHandles()){
 if(h.constructor.name==='ChildProcess'&&h.pid&&!seenChildren.has(h.pid)){seenChildren.add(h.pid);commandStarts.push({pid:h.pid,args:[...h.spawnargs]})}
}},5)
const done=tuiCmd(root,new Map([['interval','25'],...(native&&process.env.FUGUE_FLOW_STYLE==='style'?[]:[['no-style',true]])]))
await until(()=>visible().includes('按键 Enter 发送')&&raw,'initial actual empty input')
await snap('empty')
await seedPlan()
await until(()=>visible().includes('待确认 3 项任务')&&raw,'mixed gate arrives through actual serve')
await snap('pending');assert.ok(visible().includes('模型 · 任务草案'));assert.ok(!visible().includes('ownedPaths'))
assert.equal(count('round/approve'),0);assert.ok(!existsSync(join(root,paths[0])))
const directBefore=visible();process.stdin.emit('data',Buffer.from('abc'));process.stdin.emit('data',Buffer.from('\x1b[200~DIRECT PASTE\x1b[201~'));await wait(80);
assert.equal(visible(),directBefore,'ordinary typing and bracketed paste cannot edit the covered confirmation area');assert.equal(count('round/approve'),0);
process.stdin.emit('data',Buffer.from('y'));await wait(80)
assert.equal(count('round/approve'),0,'first y must not write approval')
assert.ok(visible().includes('Enter'),'armed confirm is visible')
await snap('armed');assert.equal(count('round/approve'),0,'armed confirmation has not launched a command')
process.stdin.emit('data',Buffer.from('\x12'));await wait(80)
assert.ok(visible().includes('计划全文'));if(initialCols>=120)assert.ok(visible().includes('alpha.txt')&&visible().includes('beta.txt'))
await snap('plan')
await resize(80,24);await snap('plan-narrow')
await send('?');await send('ZZZ');await snap('covered')
await resize(24,12);await snap('covered-tiny')
await send('\x1b');await snap('read-return-tiny')
await resize(120,40);await snap('plan-expanded')
await resize(initialCols,initialRows);await snap('plan-wide')
process.stdin.emit('data',Buffer.from('\x1b'));await wait(80)
process.stdin.emit('data',Buffer.from('\r'));await wait(80)
await until(()=>process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length===1,'no command remains after return Enter');assert.equal(count('round/approve'),0,'read-and-return clears previous approval arm');await snap('planreturn')
process.stdin.emit('data',Buffer.from('y'));await wait(80);process.stdin.emit('data',Buffer.from('\r'))
await until(()=>count('contract/issue')===3&&events().at(-1).to==='Working','actual round go issued same batch')
await until(()=>visible().includes('按键 Enter 发送'),'input returns after actual round go')
const issued=events().filter(e=>e.t==='contract/issue').map(e=>JSON.parse(e.body));assert.deepEqual(issued.map(c=>c.kind),['investigate','implement','implement']);assert.deepEqual(issued.slice(1).map(c=>c.ownedPaths),paths.map(p=>[p]));assert.equal(count('round/approve'),1);assert.ok(paths.every(p=>!existsSync(join(root,p))),'dispatch has not written project files')
await snap('dispatched');assert.ok(visible().includes('这批任务已确认，结果尚未写回。'));assert.ok(!visible().includes('正在处理已确认的任务。'))
assert.ok(visible().includes('模型 · 任务草案'));assert.ok(!visible().includes('ownedPaths'))
process.stdin.emit('data',Buffer.from('\x12'))
await until(()=>visible().includes('当前任务记录')&&(initialCols>=120?visible().includes('ownedPaths'):visible().includes('evidenceRequired')),'raw draft opens through actual Console keys')
if(initialCols>=120)assert.ok(visible().includes('evidenceRequired')&&visible().includes('alpha.txt')&&visible().includes('beta.txt'));else{let all=visible();for(let i=0;i<4;i++){process.stdin.emit('data',Buffer.from('\x1b[6~'));await wait(80);all+='\n'+visible()}assert.ok(['evidenceRequired','ownedPaths','alpha.txt','beta.txt'].every(s=>all.includes(s)),'narrow full draft is reachable with original page keys');process.stdin.emit('data',Buffer.from('\x1b[1;5H'));await wait(80)};await snap('record')
process.stdin.emit('data',Buffer.from('\x1b'))
await until(()=>visible().includes('按键 Enter 发送')&&visible().includes('模型 · 任务草案'),'return restores compact current main')
assert.equal(count('round/approve'),1,'reading raw draft never adds approval');await snap('recordreturn')
process.stdin.emit('data',Buffer.from('\x1b[200~/round work\x1b[201~\r'))
await until(()=>visible().includes('Esc 停止')||visible().includes('正在验收'),'execution is visible')
if(native)await snap('running');else snapshots.push({name:'running',screen:visible()})

await send('\x1b[200~/status\x1b[201~\r')
await send('\x1b[200~/status --metrics\x1b[201~\r')
// The exception scenario's work dies at ~0 ms, so its queued frame and its
// failure frame land inside one 20 ms poll (measured: notice 0 ms, failure 0-21 ms).
// The queued claim holds in the scenarios where work runs long enough to queue behind it.
if(scenario!=='exception')await until(()=>visible().includes('排队 2 条'),'real queued readonly commands are visible while work runs')
await snap('running-queued')
await resize(80,24);await snap('running-narrow')
if(scenario==='exception')await until(()=>visible().includes('执行失败（退出码 1）。'),'actual CLI exception reaches main')
else{
await until(()=>events().some(e=>e.t==='round/state'&&e.from==='Verifying'),'actual work completed')
await until(()=>visible().includes(scenario==='failure'?'未写回':'已写回'),'backend outcome reaches current main face')
}

await until(()=>commandStarts.filter(x=>x.args.includes('status')).length===2,'both queued readonly commands actually launch')
const queueStarts=commandStarts.filter(x=>x.args.includes('status'))
assert.ok(!queueStarts[0].args.includes('--metrics')&&queueStarts[1].args.includes('--metrics'),'actual child spawn order is original FIFO')
await snap('result')
await resize(120,40);await snap('result-expanded')
await resize(initialCols,initialRows);await snap('result-wide')
assert.equal(readFileSync(join(root,'keep.txt'),'utf8'),'keep original\n')
const acceptance=events().find(e=>e.t==='merge/accept')
if(scenario==='failure'||scenario==='exception'){
 assert.ok(paths.every(p=>!existsSync(join(root,p))),'failed verification leaves project files absent');assert.equal(git('rev-parse','HEAD'),base)
 assert.equal(acceptance,undefined);assert.ok(!visible().includes('正在合并结果，尚待验收与写回。'));assert.ok(visible().includes('失败')||visible().includes('未通过'))
}else{
 assert.ok(acceptance);assert.notEqual(git('rev-parse','HEAD'),base)
 for(const p of paths)assert.equal(readFileSync(join(root,p),'utf8'),git('show','HEAD:'+p)+'\n')
 assert.ok(visible().includes('2')&&visible().includes('验收'))
 await until(()=>visible().includes('提交改动（2）')&&paths.every(p=>visible().includes(p)),'actual accepted git paths reach completion summary')
 assert.ok(!visible().includes('keep.txt'),'unchanged seed is absent from actual commit summary')
 await snap('changes')
 process.stdin.emit('data',Buffer.from('下一轮草稿'))
 process.stdin.emit('data',Buffer.from('\x12'))
 await until(()=>visible().includes('当前任务记录')&&visible().includes('本次提交改动'),'completed record opens via original Ctrl-R')
 const full=r=>r.includes('新增：alpha.txt')&&r.includes('新增：beta.txt')
 assert.ok(full(visible()),'all actual accepted paths and operations reachable')
 await snap('changes-read')
 await resize(80,24);await snap('changes-read-narrow')
 await resize(initialCols,initialRows);await snap('changes-read-wide')
 process.stdin.emit('data',Buffer.from('\x1b'))
 await until(()=>visible().includes('下一轮草稿')&&visible().includes('提交改动（2）'),'return keeps complete draft and accepted summary')
 await snap('changes-return')

}
if(scenario==='success')await send('\x15') // The restored draft must be cleared before the original empty-input exit.
process.stdin.emit('data',Buffer.from('\x04'));assert.equal(await done,0)
if(native)raw=process.stdin.isRaw
assert.equal(raw,false);assert.equal(paste,false);assert.deepEqual(signals.map(s=>process.listenerCount(s)),before)
assert.equal(process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length,0,'serve and command children finish')
// Manual resized screen helper cannot prove original terminal history; keep that claim unproved.
clearInterval(monitor)
const report={commandStarts,queueStarts,scenario,seed:'real held log fixture',driver:'CLI default deterministic stub; actual dispatch, merge, verification and writeback',contracts:3,kinds:issued.map(c=>c.kind),ownedPaths:issued.slice(1).map(c=>c.ownedPaths),approvals:count('round/approve'),snapshots,idleSamples,resizes:resizeSeq,base,head:git('rev-parse','HEAD'),rawRestored:!raw,childrenClosed:true}
if(native){await observer.ready('exit',2);report.observer=observer.result();writeFileSync(join(root,'report.json'),JSON.stringify(report));observer.finish()}
if(!native)savedWrite(JSON.stringify(report)+'\n');process.stdin.pause()

`

for(const scenario of ['success','failure','exception'])test('actual Console mixed approval/read/resize and FIFO through '+scenario+' verification',()=>{
 const root=tmpDir('fugue-console-resize-'),file=join(root,'.fugue/actor.mjs')
 mkdirSync(join(root,'.fugue'));writeFileSync(file,actor)
 const run=spawnSync(process.execPath,[file,fileURLToPath(new URL('./console.ts',import.meta.url)),root,scenario],{
  encoding:'utf8',env:{...process.env,TERM:'xterm',FUGUE_SYSTEM_DIR:join(root,'system'),FUGUE_FLOW_NATIVE:'0'},timeout:90000,
 })
 assert.equal(run.status,0,run.stderr||String(run.error));const report=JSON.parse(run.stdout)
 assert.equal(report.approvals,1);assert.equal(report.contracts,3);assert.equal(report.resizes,scenario==='success'?9:7)
 assert.deepEqual(report.kinds,['investigate','implement','implement'])
 assert.deepEqual(report.ownedPaths,[['alpha.txt'],['beta.txt']])
 assert.equal(report.queueStarts.length,2)
 assert.ok(!report.queueStarts[0].args.includes('--metrics')&&report.queueStarts[1].args.includes('--metrics'))
 assert.ok(report.rawRestored&&report.childrenClosed)
 assert.ok(report.idleSamples.every(s=>s.bytes===0))
 assert.equal(report.head===report.base,scenario!=='success')
 console.log(JSON.stringify({scenario,phases:report.snapshots.length,resizes:report.resizes,approvals:report.approvals,
  contracts:report.contracts,FIFO:report.queueStarts.map(s=>s.args.slice(-2)),idle:report.idleSamples,
  rawRestored:report.rawRestored,childrenClosed:report.childrenClosed,headChanged:report.head!==report.base}))
})
