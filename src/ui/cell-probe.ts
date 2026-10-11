// Terminal reports arrive through the same raw decoder as keys, outside paste.
// Protocol: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
// DA advertises Sixel (attribute 4); CSI 16t reports actual character-cell pixels.
// DECSDM must already anchor at the cursor, and palettes must be private.
// XTSMGRAPHICS reads actual color-register capacity and graphic pixel limits; all six reports are one result.
// We only query these modes; missing/invalid reports keep text. Expired requests stay in FIFO until consumed:
// an unidentified late reply can never be promoted to a newer request's result.
import type { WaitFn } from './keymap.ts'
import { MAX_IMAGE_PIXELS } from './image-codec.ts'

export interface CellPixels { readonly width: number; readonly height: number }
export interface SixelCells extends CellPixels { readonly colors: number; readonly maxWidth: number; readonly maxHeight: number }
export const CELL_WAIT_MS = 200
export const MAX_CELL_PIXELS = 512
export const MAX_CELL_REQUESTS = 16

interface Request {
  done: boolean
  attributes?: boolean
  pixels?: CellPixels | null
  anchored?: boolean
  privatePalette?: boolean
  colors?: number | null
  graphics?: CellPixels | null
}

export function openCellProbe(o: {
  readonly write: (bytes: string) => void
  readonly changed: () => void
  readonly wait?: WaitFn
}) {
  const wait: WaitFn = o.wait ?? ((ms, fn) => { const t=setTimeout(fn,ms); return ()=>clearTimeout(t) })
  const attributes: Request[] = [],pixels: Request[] = [],anchors: Request[] = [],palettes: Request[] = [],colors: Request[] = [],graphics: Request[] = []
  let current: Request | undefined,cell: SixelCells | null = null,closed=false,stop:(()=>void)|undefined
  const set=(next:SixelCells|null):void=>{
    if(cell?.width===next?.width && cell?.height===next?.height && cell?.colors===next?.colors && cell?.maxWidth===next?.maxWidth && cell?.maxHeight===next?.maxHeight)return
    cell=next;o.changed()
  }
  const finish=(r:Request):void=>{
    if(r.done || r!==current || r.attributes===undefined || r.pixels===undefined || r.anchored===undefined || r.privatePalette===undefined || r.colors===undefined || r.graphics===undefined)return
    r.done=true;stop?.();stop=undefined
    set(r.attributes && r.anchored && r.privatePalette && r.pixels && r.colors !== null && r.graphics ? {...r.pixels, colors:r.colors, maxWidth:r.graphics.width, maxHeight:r.graphics.height} : null)
  }
  return {
    get cell():SixelCells|null{return cell},
    start():void {
      if(closed)return
      stop?.();stop=undefined
      if(current)current.done=true
      set(null)
      if(Math.max(attributes.length,pixels.length,anchors.length,palettes.length,colors.length,graphics.length)>=MAX_CELL_REQUESTS)return
      const r:Request={done:false};current=r;attributes.push(r);pixels.push(r);anchors.push(r);palettes.push(r);colors.push(r);graphics.push(r)
      stop=wait(CELL_WAIT_MS,()=>{if(r!==current||r.done)return;stop=undefined;r.done=true;set(null)})
      o.write('\x1b[c\x1b[16t\x1b[?80$p\x1b[?1070$p\x1b[?1;1;0S\x1b[?2;1;0S')
    },
    receive(bytes:string):void {
      if(closed)return
      const da=/^\x1b\[\?([0-9;]{1,64})c$/.exec(bytes)
      if(da){
        const r=attributes.shift();if(!r||r.done)return
        const values=da[1]!.split(';').map(Number)
        r.attributes=values.length>1&&[62,63,64,65].includes(values[0]!)&&values.slice(1).includes(4);finish(r);return
      }
      const mode=/^\x1b\[\?(80|1070);([0-4])\$y$/.exec(bytes)
      if(mode){
        const r=(mode[1]==='80'?anchors:palettes).shift();if(!r||r.done)return
        const value=Number(mode[2])
        if(mode[1]==='80')r.anchored=value===2||value===4
        else r.privatePalette=value===1||value===3
        finish(r);return
      }
      const capacity=/^\x1b\[\?1;([0-3])(?:;([0-9]{1,6}))?S$/.exec(bytes)
      if(capacity){
        const r=colors.shift();if(!r||r.done)return
        const value=Number(capacity[2])
        r.colors=capacity[1]==='0' && Number.isSafeInteger(value) && value>=2 ? Math.min(value,256) : null
        finish(r);return
      }
      const geometry=/^\x1b\[\?2;([0-3])(?:;([0-9]{1,6});([0-9]{1,6}))?S$/.exec(bytes)
      if(geometry){
        const r=graphics.shift();if(!r||r.done)return
        const width=Number(geometry[2]),height=Number(geometry[3])
        r.graphics=geometry[1]==='0' && ((width>0 && height>0) || (width===0 && height===0))
          ? {width:Math.min(width || MAX_IMAGE_PIXELS,MAX_IMAGE_PIXELS),height:Math.min(height || MAX_IMAGE_PIXELS,MAX_IMAGE_PIXELS)} : null
        finish(r);return
      }
      const size=/^\x1b\[6;([0-9]{1,6});([0-9]{1,6})t$/.exec(bytes)
      if(size){
        const r=pixels.shift();if(!r||r.done)return
        const height=Number(size[1]),width=Number(size[2])
        r.pixels=height>0&&width>0&&height<=MAX_CELL_PIXELS&&width<=MAX_CELL_PIXELS?{width,height}:null
        finish(r)
      }
    },
    close():void {
      if(closed)return
      closed=true;stop?.();stop=undefined
      if(current)current.done=true
      attributes.length=0;pixels.length=0;anchors.length=0;palettes.length=0;colors.length=0;graphics.length=0;cell=null
    },
  }
}


/** Read actual alternate-plane ownership after entry/resize, without setting host modes.
 * Only a set, resettable mode (1) grants ownership: permanent-set (3) cannot be restored on exit.
 * Unidentified expired replies keep their FIFO place, just like the six capability reports above.
 */
export function openAlternateProbe(o: {
  readonly write: (bytes: string) => void
  readonly changed: () => void
  readonly wait?: WaitFn
}) {
  const wait: WaitFn = o.wait ?? ((ms, fn) => { const t=setTimeout(fn,ms);return ()=>clearTimeout(t) })
  const pending: {done:boolean}[] = []
  let current: {done:boolean}|undefined,owned=false,closed=false,stop:(()=>void)|undefined
  const set=(next:boolean):void=>{if(owned===next)return;owned=next;o.changed()}
  return {
    get owned():boolean{return owned},
    start():void {
      if(closed)return
      stop?.();stop=undefined
      if(current)current.done=true
      set(false)
      if(pending.length>=MAX_CELL_REQUESTS)return
      const r={done:false};current=r;pending.push(r)
      stop=wait(CELL_WAIT_MS,()=>{if(r!==current||r.done)return;stop=undefined;r.done=true;set(false)})
      o.write('\x1b[?1049$p')
    },
    receive(bytes:string):void {
      if(closed)return
      const mode=/^\x1b\[\?1049;([0-4])\$y$/.exec(bytes)
      if(!mode)return
      const r=pending.shift();if(!r||r.done||r!==current)return
      r.done=true;stop?.();stop=undefined;set(mode[1]==='1')
    },
    close():void {
      if(closed)return
      closed=true;stop?.();stop=undefined
      if(current)current.done=true
      pending.length=0;owned=false
    },
  }
}


/** Kitty uses natural pixels after fitting into actual cells; a missing report keeps text.
 * Expired FIFO entries retain ownership of late reports, including across resizes.
 */
export function openPixelProbe(o: {
  readonly write: (bytes: string) => void
  readonly changed: () => void
  readonly wait?: WaitFn
}) {
  const wait: WaitFn = o.wait ?? ((ms, fn) => { const t=setTimeout(fn,ms);return ()=>clearTimeout(t) })
  const pending: {done:boolean}[] = []
  let current: {done:boolean}|undefined,cell:CellPixels|null=null,closed=false,stop:(()=>void)|undefined
  const set=(next:CellPixels|null):void=>{if(cell?.width===next?.width && cell?.height===next?.height)return;cell=next;o.changed()}
  return {
    get cell():CellPixels|null{return cell},
    start():void {
      if(closed)return
      stop?.();stop=undefined
      if(current)current.done=true
      set(null)
      if(pending.length>=MAX_CELL_REQUESTS)return
      const r={done:false};current=r;pending.push(r)
      stop=wait(CELL_WAIT_MS,()=>{if(r!==current||r.done)return;stop=undefined;r.done=true;set(null)})
      o.write('\x1b[16t')
    },
    receive(bytes:string):void {
      if(closed)return
      const size=/^\x1b\[6;([0-9]{1,6});([0-9]{1,6})t$/.exec(bytes)
      if(!size)return
      const r=pending.shift();if(!r||r.done||r!==current)return
      r.done=true;stop?.();stop=undefined
      const height=Number(size[1]),width=Number(size[2])
      set(height>0&&width>0&&height<=MAX_CELL_PIXELS&&width<=MAX_CELL_PIXELS?{width,height}:null)
    },
    close():void {
      if(closed)return
      closed=true;stop?.();stop=undefined
      if(current)current.done=true
      pending.length=0;cell=null
    },
  }
}


/** CPR locates a completed text frame only with absolute origin and full margins.
 * Expired reports retain their FIFO slots. Callbacks record coordinates without
 * redraw; a host missing any report keeps the original text path.
 */
export function openCursorProbe(o: {
  readonly write: (bytes: string) => void
  readonly wait?: WaitFn
}) {
  const wait: WaitFn = o.wait ?? ((ms, fn) => { const t=setTimeout(fn,ms); return ()=>clearTimeout(t) })
  interface CursorRequest {
    done: boolean
    rows: number
    accept: (row: number, column: number) => void
    position?: readonly [number, number] | null
    origin?: boolean
    horizontal?: boolean
    margins?: boolean
  }
  const positions:CursorRequest[]=[],origins:CursorRequest[]=[],horizontals:CursorRequest[]=[],margins:CursorRequest[]=[]
  let closed=false,stop:(()=>void)|undefined,current:CursorRequest|undefined
  const finish=(r:CursorRequest):void=>{
    if(r.done || r!==current || r.position===undefined || r.origin===undefined || r.horizontal===undefined || r.margins===undefined)return
    r.done=true;stop?.();stop=undefined
    if(r.position && r.origin && r.horizontal && r.margins)r.accept(...r.position)
  }
  let queued:{rows:number,accept:(row:number,column:number)=>void}|null=null,flushing=false
  const start=(rows:number,accept: (row: number, column: number) => void): void => {
      queued=null
      if(closed)return
      stop?.();stop=undefined
      if(current)current.done=true
      if(!Number.isSafeInteger(rows) || rows<1 || Math.max(positions.length,origins.length,horizontals.length,margins.length)>=MAX_CELL_REQUESTS)return
      const r:CursorRequest={done:false,rows,accept};current=r;positions.push(r);origins.push(r);horizontals.push(r);margins.push(r)
      stop=wait(CELL_WAIT_MS,()=>{if(r!==current||r.done)return;stop=undefined;r.done=true})
      o.write('\x1b[?6$p\x1b[?69$p\x1bP$qr\x1b\\\x1b[6n')
  }
  return {
    start,
    /** Coalesce one synchronous paint burst; emitted replies retain their FIFO slots. */
    schedule(rows:number,accept:(row:number,column:number)=>void):void {
      if(closed)return
      stop?.();stop=undefined;if(current)current.done=true
      queued={rows,accept}
      if(flushing)return
      flushing=true
      queueMicrotask(()=>{
        flushing=false
        const next=queued;queued=null
        if(next!==null)start(next.rows,next.accept)
      })
    },
    receive(bytes:string):void {
      if(closed)return
      const mode=/^\x1b\[\?(6|69);([0-4])\$y$/.exec(bytes)
      if(mode){const r=(mode[1]==='6'?origins:horizontals).shift();if(!r||r.done)return
        const reset=mode[2]==='2'||mode[2]==='4';if(mode[1]==='6')r.origin=reset;else r.horizontal=reset;finish(r);return}
      const region=/^\x1bP([01])\$r(.*?)\x1b\\$/.exec(bytes)
      if(region && (region[1]==='0' || region[2]!.endsWith('r'))){const r=margins.shift();if(!r||r.done)return
        r.margins=region[1]==='1' && region[2]===`1;${r.rows}r`;finish(r);return}
      const position=/^\x1b\[([0-9]{1,6});([0-9]{1,6})R$/.exec(bytes)
      if(position){const r=positions.shift();if(!r||r.done)return
        const row=Number(position[1])-1,column=Number(position[2])-1
        r.position=row>=0&&row<r.rows&&column>=0?[row,column]:null;finish(r)}
    },
    close():void { if(closed)return;closed=true;queued=null;stop?.();stop=undefined;if(current)current.done=true;positions.length=0;origins.length=0;horizontals.length=0;margins.length=0 },
  }
}
