import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpDir} from '../../test/helpers/tmp.ts'
const cli=fileURLToPath(new URL('../cli/fugue.ts',import.meta.url)),consoleURL=new URL('./console.ts',import.meta.url).href
// Fixed opaque 192x96 PNG, shared by raw-source/native fixtures; no image dependency.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAABgCAYAAABLwH3pAAABeUlEQVR4nO3csYkCURRA0XExF1nNDGzEUuxhS9keLGVbMROxBLeGjw6K95z4DzwGLi/5M4vVZn+fIOrr1QPAKwmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQthx9YL3dzTMJPMHtch46bwOQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApA1/D/D98zfPJLyl6+9h+mQ2AGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQNnwb9NNvB9JiA5AmANIEQJoASBMAaQIgTQCkCYA0AZAmANIEQNr4n+FOx3kmYcj1ePLGnsAGIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSFqvN/j7ywHq7m28aeNDtch46bwOQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApC3nvm8N78wGIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmAqewfzfoTxQC888oAAAAASUVORK5CYII=','base64')
function driver(root:string,full:boolean,expected:boolean,mode=1,size=true,once=false):string{return `
import assert from 'node:assert/strict'
import {tuiCmd} from ${JSON.stringify(consoleURL)}
let raw='',screen=false,sent=false,closed=false,readAt=0
for(const stream of [process.stdout,process.stdin])Object.defineProperty(stream,'isTTY',{value:${!once},configurable:true})
Object.defineProperty(process.stdout,'columns',{value:40,configurable:true});Object.defineProperty(process.stdout,'rows',{value:24,configurable:true})
process.stdin.setRawMode=()=>process.stdin
const write=process.stdout.write.bind(process.stdout)
process.stdout.write=(chunk,...args)=>{
 const s=typeof chunk==='string'?chunk:chunk.toString();raw+=s
 if(s.includes('\\x1b[?1049h'))screen=${mode===1};if(s.includes('\\x1b[?1049l'))screen=false
 const responses=[['\\x1b[c','\\x1b[?62;4;22c'],['\\x1b[16t',${size?JSON.stringify('\x1b[6;20;10t'):'null'}],['\\x1b[?80$p','\\x1b[?80;2$y'],['\\x1b[?1070$p','\\x1b[?1070;1$y'],['\\x1b[?1;1;0S','\\x1b[?1;0;256S'],['\\x1b[?2;1;0S','\\x1b[?2;0;1000;1000S'],['\\x1b[?1049$p','\\x1b[?1049;'+(screen?1:${mode===1?2:mode})+'$y']]
 for(const [q,r] of responses)if(r&&s.includes(q))queueMicrotask(()=>process.stdin.emit('data',r))
 return write(chunk,...args)
}
const timer=setInterval(()=>{
 if(!sent&&raw.includes('\\x1b[?2004h')&&raw.includes('现有记录已载入。')){sent=true;readAt=Date.now();process.stdin.emit('data','\\x12')}
 if(sent&&!closed&&(${expected}?raw.includes('\\x1bP0;1;0q'):Date.now()-readAt>600)){closed=true;process.stdin.emit('data','\\x04')}
},20);timer.unref()
const limit=setTimeout(()=>{process.stderr.write(JSON.stringify({screen,sent,raw:raw.slice(-4500)})+String.fromCharCode(10));assert.fail('configured full Sixel PNG did not reach actual console output')},7000);limit.unref()
const flags=new Map([['interval','20'],${full?"['full',true],":''}${once?"['once',true],":''}])
const rc=await tuiCmd(${JSON.stringify(root)},flags);clearInterval(timer);clearTimeout(limit);assert.equal(rc,0)
`}
test('actual console source and raw report wiring: full PNG transfers; normal/off/unknown ownership/missing cells/headless stay text',()=>{
 const root=tmpDir('fugue-console-sixel-'),system=tmpDir('fugue-console-sixel-system-'),env={...process.env,FUGUE_SYSTEM_DIR:system,TERM:'xterm-sixel',COLORTERM:'truecolor',TERM_PROGRAM:''}
 for(const k of ['KITTY_WINDOW_ID','TMUX','STY','NO_COLOR'])delete env[k]
 const run=(args:string[],input:Buffer|string='')=>{const r=spawnSync(process.execPath,[cli,'--root',root,...args],{env,input,encoding:'utf8',maxBuffer:1<<22,timeout:15000});assert.equal(r.status,0,r.stderr);return r.stdout}
 const git=spawnSync('git',['init','-q',root],{encoding:'utf8'});assert.equal(git.status,0,git.stderr)
 run(['--agent','agent/r1/1','write','preview.png','--stdin'],png)
 const cases=[{name:'full',full:true,pixels:true},{name:'normal',full:false,pixels:false},{name:'rejected',full:true,pixels:false,mode:2},{name:'missing-cell',full:true,pixels:false,size:false},{name:'off',full:true,pixels:false,off:true},{name:'headless',full:true,pixels:false,once:true}]
 for(const c of cases){
  run(['config','set','ui.images',c.off?'off':'auto'])
  const file=join(system,'console-driver.mjs');writeFileSync(file,driver(root,c.full,c.pixels,c.mode??1,c.size??true,c.once??false))
  const r=spawnSync(process.execPath,[file],{env,input:'',encoding:'utf8',maxBuffer:1<<22,timeout:12000})
  assert.equal(r.status,0,c.name+' '+r.stderr);const count=(r.stdout.match(/\x1bP0;1;0q/g)??[]).length
  assert.equal(count,c.pixels?1:0,c.name+' actual PNG source→stage→Term')
  if(c.off||c.once)assert.equal((r.stdout.match(/\x1b\[\?1049\$p|\x1b\[c/g)??[]).length,0,c.name+' probes off')
  if(c.once)assert.ok(!r.stdout.includes('\x1b'),'headless ANSI0')
  if(c.pixels)assert.ok(r.stdout.includes('\x1b[?1049l'),'full PNG exit restores normal plane')
  console.log('console Sixel',c.name,'transfers',count,'exit',r.status)
 }
})
