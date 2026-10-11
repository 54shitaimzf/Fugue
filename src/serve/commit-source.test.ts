import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { writeFileSync, chmodSync, unlinkSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { openCommitSource } from './commit-source.ts'
const request={round:'r1',base:'a'.repeat(40),commit:'b'.repeat(40)}
test('actual git compares recorded commits rather than current HEAD/disk, handles deletes/types/control filenames and leaves repo unchanged',async()=>{
 const root=tmpDir('fugue-commit-source-'),env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'test',GIT_AUTHOR_EMAIL:'test@localhost',GIT_COMMITTER_NAME:'test',GIT_COMMITTER_EMAIL:'test@localhost'}
 const git=(...args:string[])=>{const p=spawnSync('git',args,{cwd:root,env,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim()}
 git('init','-q','-b','main');for(const p of ['kept.txt','removed.txt','modified.txt','link.txt'])writeFileSync(join(root,p),'base')
 git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD')
 writeFileSync(join(root,'actual.txt'),'new');writeFileSync(join(root,'modified.txt'),'new');unlinkSync(join(root,'removed.txt'));unlinkSync(join(root,'link.txt'));symlinkSync('kept.txt',join(root,'link.txt'))
 const special='strange\n name\t\x1b.txt';writeFileSync(join(root,special),'special');git('add','-A');git('commit','-qm','accepted');const commit=git('rev-parse','HEAD')
 writeFileSync(join(root,'later.txt'),'later');git('add','.');git('commit','-qm','later');writeFileSync(join(root,'actual.txt'),'manual change');const head=git('rev-parse','HEAD'),status=git('status','--porcelain')
 const source=openCommitSource({root})
 try{
  const value=await source.read({round:'r1',base,commit});assert.ok(value);assert.deepEqual(value.files,[
   {kind:'A',path:'actual.txt'},{kind:'T',path:'link.txt'},{kind:'M',path:'modified.txt'},{kind:'D',path:'removed.txt'},{kind:'A',path:special}
  ])
  assert.ok(!value.files.some(f=>f.path==='later.txt'||f.path==='kept.txt'))
  assert.deepEqual((await source.read({round:'r1',base:commit,commit}))!.files,[])
  assert.equal(await source.read({...request,base:'--unsafe'}),null)
  assert.equal(await source.read(request),null,'missing exact objects must not fall back to HEAD')
  assert.equal(git('rev-parse','HEAD'),head);assert.equal(git('status','--porcelain'),status);assert.equal(readFileSync(join(root,'actual.txt'),'utf8'),'manual change')
 }finally{await source.close()}
 assert.equal(await source.read({round:'r1',base,commit}),null)
})
test('missing, failed, malformed, non-UTF8, too large, timed out or cancelled source falls back and closes its child',async()=>{
 const root=tmpDir('fugue-commit-floor-'),file=join(root,'fake-git')
 const script=(body:string)=>{writeFileSync(file,'#!/usr/bin/env node\n'+body);chmodSync(file,0o755)}
 for(const body of [
  "process.stdout.write('A\\0one\\0odd')",
  "process.stdout.write('R100\\0one\\0two\\0')",
  "process.stdout.write(Buffer.from([65,0,255,0]))",
  "process.stdout.write('x'.repeat(1048577))",
  "process.exit(7)",
  "setInterval(()=>{},1000)",
 ]){
  script(body);const source=openCommitSource({root,git:file,timeoutMs:75});assert.equal(await source.read(request),null,body);await source.close()
 }
 const missing=openCommitSource({root,git:join(root,'missing')});assert.equal(await missing.read(request),null);await missing.close()
 script("setInterval(()=>{},1000)")
 const source=openCommitSource({root,git:file,timeoutMs:2000}),ac=new AbortController()
 const pending=source.read(request,ac.signal);ac.abort();assert.equal(await pending,null)
 const close=source.read(request);await source.close();assert.equal(await close,null)
 assert.equal(await source.read(request),null)
 assert.equal(process._getActiveHandles().filter((h:any)=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length,0)
 console.log('commit source: exact objects; disk/HEAD unchanged; seven failure classes; cancel/close children0')
})
