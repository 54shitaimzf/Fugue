import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf,innerOf,windowOf} from './frame.ts'
import {frameBudgetOf} from './layout.ts'
import {statusOf} from '../probe/status.ts'
import {setGlyphTier,widthOf,clip,glyphs} from './glyph.ts'

test('actual command and path candidate blocks own title, selected row, count and full capacity; sparse blocks stay beside input; unknown metadata keeps exact legacy frame',()=>{
 let cases=0,sparse=0,dense=0,floors=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [8,16,24,80,120,192])for(const height of [5,6,8,12,24,45,50])
 for(const source of ['cmd','path'] as const)for(const count of [0,1,8,80])for(const wanted of [0,Math.floor(count/2),Math.max(0,count-1)]){
  const rows=Array.from({length:count},(_,i)=>'ITEM-'+i),sel=wanted
  const input={snapshot:statusOf([]),width,height,operationArea:true,view:'progress' as const,
   menu:{source,rows,sel},read:{rows:['COVERED-READER'],top:0,heading:'COVERED-HEADING',footer:'COVERED-POSITION'},
   bottom:{rows:['COVERED-APPROVAL','COVERED-QUEUE'],keep:2,waitingAt:0,waitingCount:1},
   nav:{rows:['COVERED-NAV'],sel:0}}
  const current=frameOf(input),inner=innerOf(width),budget=frameBudgetOf(height).rows
  const win=count===0?null:windowOf(count,sel,Math.min(budget,count))
  const body=count===0?['（没有匹配的）']:[...rows.slice(win!.from,win!.from+win!.count).map((s,i)=>(win!.from+i===sel?glyphs().sel:' ')+' '+s),...(win!.summary?[glyphs().mark+' 还有 '+(win!.above+win!.below)+' 条']:[])]
  assert.equal(current.lines.length,height);assert.ok(current.lines.every(s=>widthOf(s)===width))
  assert.equal(current.roles.length,height);assert.equal(current.columns.right,0)
  assert.ok(!current.lines.some(s=>s.includes('COVERED-')),'only the current candidate query owns foreground content')
  assert.ok(!current.roles.includes('read')&&!current.roles.includes('waiting'))
  const at=current.roles.indexOf('readHeading')
  assert.equal(at,Math.max(0,height-4-body.length),'all sparse whitespace stays outside the complete current block')
  assert.ok(current.lines.slice(0,at).every(s=>s.trim()===''))
  if(width>=16)assert.ok(current.lines[at]!.includes(source==='cmd'?'命令':'文件路径'),'title belongs to the actual candidate source')
  assert.deepEqual(current.roles.slice(at+1,at+1+body.length),body.map((_,i)=>win!==null&&i===sel-win.from?'hit':'overlayBody'),'exactly the selected actual row is emphasized, including middle/last selection')
  for(const [i,s] of body.entries())assert.ok(current.lines[at+1+i]!.includes(clip(s,inner)),'candidate window uses every available row and preserves original visible text')
  const countText=(count===0?0:sel+1)+'/'+count,full=countText+' · 筛选'
  assert.equal(current.footer,clip(widthOf(full)>inner?countText:full,inner),'current count cannot inherit covered reader position')
  assert.equal(current.roles.indexOf('footer'),height-2)
  assert.ok(body.length<=budget)
  if(count>budget)assert.equal(body.length,budget,'dense candidate window keeps the full available capacity including omission count')
  if(at>0)sparse++;else dense++
  const legacy=(o:typeof input)=>frameOf({...o,menu:{...o.menu,source:undefined}})
  for(const bad of [undefined,'keys','command',1,null] as const){
   const o={...input,menu:{...input.menu,source:bad} as never}
   assert.ok(frameOf(o).roles.includes('read'),'unknown source retains the original reader rather than acquiring foreground identity')
   assert.deepEqual(frameOf(o),legacy(o),'unknown source keeps every original frame field');floors++
  }
  for(const bad of [undefined,false,'true',1,null] as const){
   const o={...input,operationArea:bad as never}
   assert.deepEqual(frameOf(o),legacy(o),'unknown/noninteractive operation area keeps original frame');floors++
  }
  for(const bad of ['true',1,null] as const){
   const o={...input,menu:{...input.menu,help:bad} as never}
   assert.deepEqual(frameOf(o),legacy(o),'bad help identity keeps original frame');floors++
  }
  for(const extra of [{help:true},{detail:['KEY','SAY']},{detail:[]},{detailMore:['FULL']}]){
   const o={...input,menu:{...input.menu,...extra}}
   assert.deepEqual(frameOf(o),legacy(o),'help and conflicting detail retain the original help/legacy path');floors++
  }
  assert.deepEqual(frameOf({...input,menu:{...input.menu,help:false}}),current,'explicit ordinary help=false is legitimate')
  cases++
 }
 }}finally{setGlyphTier('box')}
 console.log('ordinary foreground:pure'+cases+';sparse'+sparse+';dense'+dense+';exact metadata floors'+floors+';2sources/3glyph/6width/7height/4counts/3selections;full capacity;selected hit;current count/title;covered reader/approval/nav/queue absent;all frame fields for fallback')
})
