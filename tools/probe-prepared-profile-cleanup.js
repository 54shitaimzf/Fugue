#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanupProfileBenchmark } from './profile-benchmark-cleanup.js'
const original=new Error('primary query failure'),resync=new Error('injected builtin resync failure')
for(const primary of [false,true]) {
 const roots=[mkdtempSync(join(resolve(import.meta.dirname,'..'),'.resync-sentinel-')),mkdtempSync(join(resolve(import.meta.dirname,'..'),'.resync-sentinel-'))]
 let restored=false,attempts=0
 try { await assert.rejects(cleanupProfileBenchmark(()=>{restored=true;throw resync},roots.map(path=>()=>{attempts++;rmSync(path,{recursive:true,force:true})}),{failed:primary,error:original}),error=>error===(primary?original:resync));assert.ok(restored);assert.equal(attempts,2);assert.ok(roots.every(path=>!existsSync(path))) }
 finally {for(const path of roots)rmSync(path,{recursive:true,force:true})}
}
console.log('2/2 injected restore-resync cleanup controls passed')
