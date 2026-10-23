import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'
import {tmpDir} from '../../test/helpers/tmp.ts'

// Held mixed batch is a seeded fixture. From key input onward, Console uses
// real serve and command children. Only CLI's documented model stub is used.
// The independent hard-line host does not prove native Unicode reflow.
const actor=String.raw`
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
const [module,root,scenario]=process.argv.slice(2),native=process.env.FUGUE_FLOW_NATIVE==='1'
const cli=join(dirname(module),'../cli/fugue.ts')
process.argv=[process.execPath,cli]
const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'flow',GIT_AUTHOR_EMAIL:'flow@localhost',GIT_COMMITTER_NAME:'flow',GIT_COMMITTER_EMAIL:'flow@localhost'}
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
git('init','-q','-b','main');writeFileSync(join(root,'keep.txt'),'keep original\n');git('add','keep.txt');git('commit','-qm','base')
const base=git('rev-parse','HEAD'),paths=['alpha.txt','beta.txt']
mkdirSync(join(root,'.fugue'),{recursive:true})
const check="const fs=require('fs');setTimeout(()=>process.exit("+ (scenario==='failure'?'7':"['alpha.txt','beta.txt'].every(p=>fs.readFileSync(p,'utf8').includes('改了 '+p))?0:9")+"),450)"
writeFileSync(join(root,'.fugue/config'),JSON.stringify({round:{id:'r1'},actions:{check:{argv:[process.execPath,'-e',check],outputs:[]}},ui:{glyphs:native?'box':'ascii',images:'off'}}))
const sections=[{kind:'investigate',question:'确认现有文件的保留范围',evidenceRequired:[{note:'保留范围'}],seed:['keep.txt']},...paths.map(p=>({kind:'implement',goal:'更新 '+p,ownedPaths:[p],deliverables:[{path:p,form:'文本文件'}],assertions:[{action:'check',name:'两个文件内容正确'}],seed:[]}))]
const draft=sections.map((s,i)=>'## 第 '+(i+1)+' 项\n\n\x60\x60\x60json\n'+JSON.stringify(s)+'\n\x60\x60\x60').join('\n\n')
const {openLog}=await import(pathToFileURL(join(dirname(module),'../log/log.ts')).href)
const seed=openLog(root,{write:'round',sync:'each'})
await seed.append('round',{t:'round/intent',round:'r1',base,digest:'d'.repeat(16),body:JSON.stringify({goal:'核查现状并更新两个文件'})})
await seed.append('round',{t:'round/state',round:'r1',from:'Idle',to:'Planning'})
await seed.append('round',{t:'holder/distill',round:'r1',agent:'round',digest:'e'.repeat(16),body:draft})
await seed.close()
const {tuiCmd}=await import(module),initialCols=192,initialRows=50
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
if(native)process.stdout.write(original.join('\r\n')+'\r\n');put(original.join('\r\n')+'\r\n')
const savedWrite=process.stdout.write.bind(process.stdout)
if(!native){
for(const [key,get] of [['columns',()=>cols],['rows',()=>rows],['isTTY',()=>true]])Object.defineProperty(process.stdout,key,{configurable:true,get})
Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true})
Object.defineProperty(process.stdin,'isRaw',{configurable:true,get:()=>raw})
process.stdin.setRawMode=n=>{raw=n;return process.stdin}
}
process.stdout.write=(s,encoding,cb)=>{const b=Buffer.isBuffer(s)?s.toString():s;bytes+=Buffer.byteLength(b);put(b);if(native)savedWrite(s,encoding);const f=typeof encoding==='function'?encoding:cb;if(f)queueMicrotask(f);if(native)raw=process.stdin.isRaw;return true}

const wait=n=>new Promise(r=>setTimeout(r,n)),visible=()=>grid.map(r=>r.join('').trimEnd()).join('\n')
const until=async(f,why)=>{for(let i=0;i<500;i++){if(f())return;await wait(20)}assert.fail(why+'\n'+visible())}
const events=()=>{const t=readFileSync(join(root,'.fugue/log/round.jsonl'),'utf8'),cut=t.lastIndexOf('\n');return cut<0?[]:t.slice(0,cut).split('\n').filter(s=>s).map(s=>JSON.parse(s))}
const count=t=>events().filter(e=>e.t===t).length
let snapshots=[],idleSamples=[]
const snap=async(name)=>{
 if(name!=='running'){await until(()=>process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length===1,'only serve remains at '+name);await wait(100);const b=bytes;await wait(100);assert.equal(bytes,b,'settled '+name+' emits no bytes');idleSamples.push({name,ms:100,bytes:bytes-b})}
 snapshots.push({name,screen:visible()})
 if(native){writeFileSync(join(root,'.fugue/'+name+'.ready'),JSON.stringify({bytes,raw:process.stdin.isRaw}));await until(()=>existsSync(join(root,'.fugue/'+name+'.ack')),'native snapshot acknowledgement')}
}
const signals=['SIGINT','SIGTERM','SIGHUP','SIGWINCH'],before=signals.map(s=>process.listenerCount(s))
const done=tuiCmd(root,new Map([['interval','25'],...(native&&process.env.FUGUE_FLOW_STYLE==='style'?[]:[['no-style',true]])]))
await until(()=>visible().includes('待确认 3 项任务')&&raw,'mixed gate arrives through actual serve')
await until(()=>visible().includes('第一次确认：上一批没有放行记录'),'gate view presents the batch summary without a keypress')
await snap('pending');assert.ok(visible().includes('任务草案'));assert.ok(!visible().includes('ownedPaths'))
assert.equal(count('round/approve'),0);assert.ok(!existsSync(join(root,paths[0])))
// Ordinary selection returns to the existing visible editor, not a hidden query.
for(const [typed,selected] of [['/status','/status '],['@AGENTS.md','@AGENTS.md']]){
 process.stdin.emit('data',Buffer.from('y'));await wait(80)
 process.stdin.emit('data',Buffer.from('\x12'));await wait(80)
 assert.ok(visible().includes('计划全文'),'ordinary choice starts over the actual full-plan reader')
 process.stdin.emit('data',Buffer.from(typed));await wait(80)
 process.stdin.emit('data',Buffer.from('\r'));await wait(80)
 assert.ok(visible().includes(selected.trim()),'selected ordinary input is visible before sending')
 assert.ok(visible().includes('等待你确认整批任务。')&&!visible().includes('正在准备计划。'),'the prepared batch stays waiting after ordinary selection returns to typing')
 assert.ok(visible().includes('Enter 发送'),'the instruction describes actual input')
 assert.ok(!visible().includes('计划全文')&&!visible().includes('返回确认'),'acceptance leaves the reader and its obsolete instruction')
 assert.ok(!visible().includes('y 执行整批'),'the editor has no contradictory confirmation actions')
 assert.equal(count('round/approve'),0);assert.equal(count('contract/issue'),0)
 assert.equal(process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length,1,'menu acceptance starts no command')
 process.stdin.emit('data',Buffer.from('\x1a'));await wait(80)
 process.stdin.emit('data',Buffer.from('g'));await wait(80)
 assert.ok(visible().includes('y 执行整批')&&visible().includes('n 暂不执行'),'undo returns original empty draft; original g reopens the same plan')
 assert.equal(count('round/approve'),0)
}
// A menu changes the foreground context; its return cannot reuse an old arm.
for(const [name,key] of [['keys','\x10'],['cmd','/'],['path','@']])for(const option of ['y','n']){
 process.stdin.emit('data',Buffer.from(option));await wait(80)
 assert.ok(visible().includes('Enter'),'original first key arms before '+name)
 process.stdin.emit('data',Buffer.from(key));await wait(80)
 assert.ok(visible().includes(name==='keys'?'按键帮助':name==='cmd'?'命令':'文件路径'),'actual menu owns foreground')
 process.stdin.emit('data',Buffer.from('\x1b'));await wait(80)
 process.stdin.emit('data',Buffer.from('\r'));await wait(80)
 await until(()=>process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length===1,'no command remains after '+name+' return')
 assert.equal(count('round/approve'),0,'menu return Enter cannot reuse the previous approval arm')
 assert.ok(visible().includes('y 执行整批')&&visible().includes('n 暂不执行'),'menu return Enter cannot reuse rejection or hide the pending batch')
 assert.ok(paths.every(p=>!existsSync(join(root,p))),'menu return has not written project files')
}
process.stdin.emit('data',Buffer.from('y'));await wait(80)
assert.equal(count('round/approve'),0,'first y must not write approval')
assert.ok(visible().includes('Enter'),'armed confirm is visible')
await snap('armed');assert.equal(count('round/approve'),0,'armed confirmation has not launched a command')
process.stdin.emit('data',Buffer.from('\x12'));await wait(80)
assert.ok(visible().includes('计划全文'));assert.ok(visible().includes('alpha.txt')&&visible().includes('beta.txt'))
process.stdin.emit('data',Buffer.from('\x1b'));await wait(80)
process.stdin.emit('data',Buffer.from('\r'));await wait(80)
await until(()=>process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length===1,'no command remains after return Enter');assert.equal(count('round/approve'),0,'read-and-return clears previous approval arm')
process.stdin.emit('data',Buffer.from('y'));await wait(80);process.stdin.emit('data',Buffer.from('\r'))
await until(()=>count('contract/issue')===3&&events().at(-1).to==='Working','actual round go issued same batch')
await until(()=>visible().includes('按键 Enter 发送'),'input returns after actual round go')
const issued=events().filter(e=>e.t==='contract/issue').map(e=>JSON.parse(e.body));assert.deepEqual(issued.map(c=>c.kind),['investigate','implement','implement']);assert.deepEqual(issued.slice(1).map(c=>c.ownedPaths),paths.map(p=>[p]));assert.equal(count('round/approve'),1);assert.ok(paths.every(p=>!existsSync(join(root,p))),'dispatch has not written project files')
await snap('dispatched');assert.ok(visible().includes('这批任务已确认，结果尚未写回。'));assert.ok(!visible().includes('正在处理已确认的任务。'))
assert.ok(visible().includes('任务草案'));assert.ok(!visible().includes('ownedPaths'))
process.stdin.emit('data',Buffer.from('\x12'))
await until(()=>visible().includes('当前任务记录')&&visible().includes('ownedPaths'),'raw draft opens through actual Console keys')
assert.ok(visible().includes('evidenceRequired')&&visible().includes('alpha.txt')&&visible().includes('beta.txt'))
process.stdin.emit('data',Buffer.from('\x1b'))
await until(()=>visible().includes('按键 Enter 发送')&&visible().includes('任务草案'),'return restores compact current main')
assert.equal(count('round/approve'),1,'reading raw draft never adds approval')
process.stdin.emit('data',Buffer.from('\x1b[200~/round work\x1b[201~\r'))
await until(()=>visible().includes('Esc 停止')||visible().includes('正在验收'),'execution is visible')
if(native)await snap('running');else snapshots.push({name:'running',screen:visible()})
await until(()=>events().some(e=>e.t==='round/state'&&e.from==='Verifying'),'actual work completed')
await until(()=>visible().includes(scenario==='failure'?'未写回':'已写回'),'backend outcome reaches current main face')
await snap('result')
assert.equal(readFileSync(join(root,'keep.txt'),'utf8'),'keep original\n')
const acceptance=events().find(e=>e.t==='merge/accept')
if(scenario==='failure'){
 assert.ok(paths.every(p=>!existsSync(join(root,p))),'failed verification leaves project files absent');assert.equal(git('rev-parse','HEAD'),base)
 assert.equal(acceptance,undefined);assert.ok(!visible().includes('正在合并结果，尚待验收与写回。'));assert.ok(visible().includes('失败')||visible().includes('未通过'))
}else{
 assert.ok(acceptance);assert.notEqual(git('rev-parse','HEAD'),base)
 for(const p of paths)assert.equal(readFileSync(join(root,p),'utf8'),git('show','HEAD:'+p)+'\n')
 assert.ok(visible().includes('2')&&visible().includes('验收'))
}
process.stdin.emit('data',Buffer.from('\x04'));assert.equal(await done,0)
if(native)raw=process.stdin.isRaw
assert.equal(raw,false);assert.equal(paste,false);assert.deepEqual(signals.map(s=>process.listenerCount(s)),before)
assert.equal(process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length,0,'serve and command children finish')
const final=text();for(const s of original)assert.equal(final.filter(l=>l===s).length,1,'original history row preserved once')
const report={scenario,seed:'real held log fixture',driver:'CLI default deterministic stub; actual dispatch, merge, verification and writeback',contracts:3,kinds:issued.map(c=>c.kind),ownedPaths:issued.slice(1).map(c=>c.ownedPaths),approvals:count('round/approve'),snapshots,idleSamples,base,head:git('rev-parse','HEAD'),rawRestored:!raw,childrenClosed:true}
if(native)writeFileSync(join(root,'.fugue/report.json'),JSON.stringify(report))
if(!native)savedWrite(JSON.stringify(report)+'\n');process.stdin.pause()

`
for(const lateKeys of [false,true])for(const scenario of ['success','failure'])test('actual Console mixed batch approval, work, verification and '+scenario+' writeback'+(lateKeys?' with keys after first gate':''),()=>{
 const root=tmpDir('fugue-console-flow-'),file=join(root,'.fugue/actor.mjs');mkdirSync(join(root,'.fugue'));writeFileSync(file,actor)
 let module=fileURLToPath(new URL('./console.ts',import.meta.url))
 if(lateKeys){
  const copied=join(root,'.fugue/startup-console.ts')
  let source=readFileSync(module,'utf8').replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g,(_all,quote,relative)=>'from '+quote+new URL(relative,new URL('./console.ts',import.meta.url)).href+quote)
  const mark='km = keymapOf(raw ?? {})';assert.equal(source.split(mark).length,2)
  source=source.replace(mark,mark+'\n      await (globalThis as any).fugueBeforeKeys(ui.tui)')
  writeFileSync(copied,source);module=copied
  const hook="globalThis.fugueBeforeKeys=async(tui)=>{await until(()=>tui.notes.some(line=>line.includes('这一轮打算开 3 个任务')),'gate record precedes keys');await wait(100);globalThis.fugueBeforeKeysResult={raw,hint:visible().includes('当前输入不可用')}}\n"
  const lateActor=actor
   .replace("const cli=join(dirname(module),'../cli/fugue.ts')",'const cli='+JSON.stringify(fileURLToPath(new URL('../cli/fugue.ts',import.meta.url))))
   .replace("pathToFileURL(join(dirname(module),'../log/log.ts'))",'pathToFileURL('+JSON.stringify(fileURLToPath(new URL('../log/log.ts',import.meta.url)))+')')
  const gateReached="await until(()=>visible().includes('待确认 3 项任务')&&raw,'mixed gate arrives through actual serve')"
  assert.equal(lateActor.split(gateReached).length,2)
  const checked=lateActor.replace(gateReached,gateReached+"\nassert.equal(globalThis.fugueBeforeKeysResult?.raw,false,'keys are uninstalled at initial gate')\nassert.equal(globalThis.fugueBeforeKeysResult?.hint,true,'startup hint describes input availability outside configuration catch')")
  assert.equal(checked.split('const done=tuiCmd(').length,2);writeFileSync(file,checked.replace('const done=tuiCmd(',hook+'const done=tuiCmd('))
 }
 const r=spawnSync(process.execPath,[file,module,root,scenario],{encoding:'utf8',env:{...process.env,TERM:'xterm',FUGUE_SYSTEM_DIR:join(root,'system')},timeout:40000})
 assert.equal(r.status,0,r.stderr||String(r.error));const v=JSON.parse(r.stdout)
 assert.equal(v.contracts,3);assert.equal(v.approvals,1);assert.deepEqual(v.kinds,['investigate','implement','implement']);assert.equal(v.idleSamples.length,4);assert.ok(v.idleSamples.every(s=>s.bytes===0));assert.ok(v.rawRestored&&v.childrenClosed)
 console.log('Console flow:'+scenario+(lateKeys?';gate-before-keys':'' )+';actual serve/go/work;held3 mixed;single approval;read clears arm;idle4 bytes0;outcome on main;project '+(scenario==='success'?'matches accepted HEAD':'bytes/head unchanged')+';raw/children restored')
})

test('actual Console without a raw-input capability keeps the readable permanent stream and never hides records behind unavailable controls',()=>{
 const root=tmpDir('fugue-console-readonly-'),file=join(root,'.fugue/actor.mjs');mkdirSync(join(root,'.fugue'))
 let s=actor
 const raw="process.stdin.setRawMode=n=>{raw=n;return process.stdin}";assert.equal(s.split(raw).length,2);s=s.replace(raw,"delete process.stdin.setRawMode")
 const start="await until(()=>visible().includes('待确认 3 项任务')&&raw,'mixed gate arrives through actual serve')"
 assert.equal(s.split(start).length,2)
 s=s.replace(start,`
await until(()=>visible().includes('进展：准备计划')&&visible().includes('当前输入不可用'),'read-only Console keeps permanent state visible')
await until(()=>visible().includes('这一轮打算开 3 个任务'),'read-only conclusion stays in permanent stream')
assert.equal(raw,false);assert.equal(paste,false);assert.equal(count('round/approve'),0)
process.emit('SIGINT');assert.equal(await done,0)
assert.equal(process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length,0)
assert.deepEqual(signals.map(s=>process.listenerCount(s)),before)
for(const line of original)assert.equal(text().filter(s=>s===line).length,1)
savedWrite(JSON.stringify({raw:false,approval:0,permanent:true,childrenClosed:true})+'\\n');process.stdin.pause()
if(false){
`)
 s+='}\n';writeFileSync(file,s)
 const r=spawnSync(process.execPath,[file,fileURLToPath(new URL('./console.ts',import.meta.url)),root,'success'],{encoding:'utf8',env:{...process.env,TERM:'xterm',FUGUE_SYSTEM_DIR:join(root,'system')},timeout:40000})
 assert.equal(r.status,0,r.stderr||String(r.error));assert.deepEqual(JSON.parse(r.stdout),{raw:false,approval:0,permanent:true,childrenClosed:true})
 console.log('readonly Console:stdout TTY/stdin self-reported TTY/no setRawMode;permanent progress and conclusion visible;approval0;raw/paste/serve/signals restored')
})
