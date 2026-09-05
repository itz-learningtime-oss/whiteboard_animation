import { downloadBlob } from './export';
import handUrl from '../../image-whiteboard-builder/assets/hand_marker.png';

export type Point = { x: number; y: number };
export type SketchPath = { points: Point[]; length: number; x: number; y: number };
export type ImageInput = { file: File; url: string; pixels: ImageData; originalWidth: number; originalHeight: number };
export type AudioInput = { file: File; url: string; buffer: AudioBuffer; duration: number; peaks: number[] };
export type SketchDrawing = { paths: SketchPath[]; totalLength: number; edgeCount: number };
export type SketchSettings = { detail: 'clean' | 'balanced' | 'detailed'; order: 'spatial' | 'length'; paper: string; ink: string; hand: boolean; penWidth: number; fps: 24 | 30 | 60; resolution: '1080' | '720' };
export const defaultSketchSettings: SketchSettings = { detail: 'balanced', order: 'spatial', paper: '#fcfbf5', ink: '#30362d', hand: true, penWidth: 2.4, fps: 30, resolution: '1080' };
export const thresholds = { clean: [75, 190], balanced: [50, 140], detailed: [22, 70] } as const;
const W = 900, H = 506.25;

export async function readImage(file: File): Promise<ImageInput> {
  if (!/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) throw new Error('Choose a PNG, JPEG, WebP, or BMP image.');
  if (!file.size || file.size > 30 * 1024 * 1024) throw new Error('Choose a non-empty image smaller than 30 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    await image.decode();
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 30000000) throw new Error('Please resize your image to under 30 megapixels.');
    const ratio = Math.min(1, 1100 / image.naturalWidth, 900 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas image processing is not supported by this browser.');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { file, url, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height), originalWidth: image.naturalWidth, originalHeight: image.naturalHeight };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error instanceof Error && !/decode/i.test(error.message) ? error : new Error('This image could not be opened. Try exporting it as a PNG or JPEG.');
  }
}

export async function readAudio(file: File): Promise<AudioInput> {
  if (!/\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff)$/i.test(file.name)) throw new Error('Choose an audio file, such as MP3, WAV, M4A, or FLAC.');
  if (!file.size || file.size > 128 * 1024 * 1024) throw new Error('Choose non-empty audio smaller than 128 MB.');
  if (typeof AudioContext === 'undefined') throw new Error('This browser cannot decode audio. Use the Python builder instead.');
  const probeUrl = URL.createObjectURL(file);
  try {
    const metadataDuration = await new Promise<number>((resolve, reject) => {
      const probe = document.createElement('audio');
      const cleanup = () => { window.clearTimeout(timeout); probe.onloadedmetadata = null; probe.onerror = null; probe.removeAttribute('src'); probe.load(); };
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error('Audio metadata could not be read. Try a WAV or MP3 file.')); }, 12000);
      probe.onloadedmetadata = () => { const value = probe.duration; probe.onloadedmetadata = null; probe.onerror = null; cleanup(); resolve(value); };
      probe.onerror = () => { probe.onerror = null; cleanup(); reject(new Error('Your browser cannot open this audio format. Try WAV or MP3.')); };
      probe.preload = 'metadata'; probe.src = probeUrl;
    });
    if (Number.isFinite(metadataDuration) && (metadataDuration > 600 || metadataDuration < .1)) throw new Error('Audio must be between 0.1 seconds and 10 minutes.');
  } finally { URL.revokeObjectURL(probeUrl); }
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration < .1 || buffer.duration > 600) throw new Error('Audio must be between 0.1 seconds and 10 minutes.');
    const channel = buffer.getChannelData(0);
    const peaks = Array.from({ length: 100 }, (_, i) => {
      const start = Math.floor(i * channel.length / 100), end = Math.floor((i + 1) * channel.length / 100);
      let peak = 0;
      for (let j = start; j < end; j += Math.max(1, Math.floor((end - start) / 150))) peak = Math.max(peak, Math.abs(channel[j]));
      return peak;
    });
    const max = Math.max(.01, ...peaks);
    return { file, buffer, duration: buffer.length / buffer.sampleRate, peaks: peaks.map(p => p / max), url: URL.createObjectURL(file) };
  } catch (error) {
    throw error instanceof Error && /Audio must/.test(error.message) ? error : new Error('Your browser cannot decode this audio. Try WAV or MP3; the Python builder supports more formats.');
  } finally { await context.close(); }
}

const breathe = async (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException('Processing cancelled', 'AbortError');
  await new Promise(resolve => window.setTimeout(resolve, 0));
};

export async function extractContours(input: ImageData, settings: SketchSettings, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<SketchDrawing> {
  const { width: w, height: h, data } = input, size = w * h;
  const gray = new Float32Array(size), horizontal = new Float32Array(size), blur = new Float32Array(size);
  for (let i = 0; i < size; i++) gray[i] = .299 * data[i * 4] + .587 * data[i * 4 + 1] + .114 * data[i * 4 + 2];
  const kernel = [1, 4, 6, 4, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let k = -2; k <= 2; k++) n += gray[y * w + Math.max(0, Math.min(w - 1, x + k))] * kernel[k + 2];
      horizontal[y * w + x] = n / 16;
    }
    if (y % 80 === 0) await breathe(signal);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let k = -2; k <= 2; k++) n += horizontal[Math.max(0, Math.min(h - 1, y + k)) * w + x] * kernel[k + 2];
      blur[y * w + x] = n / 16;
    }
    if (y % 80 === 0) await breathe(signal);
  }
  onProgress(.2);
  const magnitude = new Float32Array(size), direction = new Uint8Array(size);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -blur[i-w-1] + blur[i-w+1] - 2*blur[i-1] + 2*blur[i+1] - blur[i+w-1] + blur[i+w+1];
      const gy = -blur[i-w-1] - 2*blur[i-w] - blur[i-w+1] + blur[i+w-1] + 2*blur[i+w] + blur[i+w+1];
      magnitude[i] = Math.hypot(gx, gy);
      const angle = (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180;
      direction[i] = angle < 22.5 || angle >= 157.5 ? 0 : angle < 67.5 ? 1 : angle < 112.5 ? 2 : 3;
    }
    if (y % 80 === 0) await breathe(signal);
  }
  const [low, high] = thresholds[settings.detail];
  const edges = new Uint8Array(size), queue = new Int32Array(size);
  let tail = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y*w+x, d = direction[i], m = magnitude[i];
      const offset = d === 0 ? 1 : d === 1 ? w+1 : d === 2 ? w : w-1;
      if (m >= low && m >= magnitude[i-offset] && m >= magnitude[i+offset]) {
        edges[i] = m >= high ? 2 : 1;
        if (edges[i] === 2) queue[tail++] = i;
      }
    }
    if (y % 80 === 0) await breathe(signal);
  }
  onProgress(.5);
  const offsets = [-w-1,-w,-w+1,-1,1,w-1,w,w+1];
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    for (const offset of offsets) if (edges[i+offset] === 1) { edges[i+offset] = 2; queue[tail++] = i+offset; }
    if (head % 15000 === 0) await breathe(signal);
  }
  const visited = new Uint8Array(size), paths: SketchPath[] = [];
  const scale = Math.min(W*.85/w, H*.85/h), ox = (W-w*scale)/2, oy = (H-h*scale)/2;
  let pointCount = 0;
  for (let root = 0; root < size; root++) {
    if (root % 15000 === 0) { onProgress(.55 + .4*root/size); await breathe(signal); }
    if (edges[root] !== 2 || visited[root]) continue;
    const trace: number[] = [];
    let current = root, previous = -1;
    while (current >= 0) {
      trace.push(current); visited[current] = 1;
      if (trace.length % 12000 === 0) await breathe(signal);
      let next = -1, best = -Infinity;
      const px = current % w, py = Math.floor(current/w);
      for (const offset of offsets) {
        const candidate = current + offset;
        if (edges[candidate] !== 2 || visited[candidate]) continue;
        const dx = candidate%w-px, dy = Math.floor(candidate/w)-py;
        if (Math.abs(dx)>1 || Math.abs(dy)>1) continue;
        const vx = previous < 0 ? 1 : px-previous%w, vy = previous < 0 ? 1 : py-Math.floor(previous/w);
        const alignment = (dx*vx+dy*vy)/Math.hypot(dx,dy);
        if (alignment > best) { best = alignment; next = candidate; }
      }
      previous = current; current = next;
    }
    if (trace.length < (settings.detail === 'detailed' ? 6 : 10)) continue;
    const raw: Point[] = [];
    for (let i=0;i<trace.length;i++) {
      if (i>0 && i<trace.length-1 && trace[i]-trace[i-1] === trace[i+1]-trace[i]) continue;
      raw.push({x:(trace[i]%w)*scale+ox,y:Math.floor(trace[i]/w)*scale+oy});
    }
    if (raw.length<2) continue;
    let length=0;
    for(let i=1;i<raw.length;i++) length+=Math.hypot(raw[i].x-raw[i-1].x,raw[i].y-raw[i-1].y);
    const first = raw[0], last = raw[raw.length - 1];
    const closingLength = Math.hypot(first.x - last.x, first.y - last.y);
    if (raw.length > 3 && closingLength <= scale * 1.5) { raw.push(first); length += closingLength; }
    let minX = Infinity, minY = Infinity;
    for (const point of raw) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); }
    paths.push({ points:raw,length,x:minX,y:minY });
    pointCount+=raw.length;
    if(paths.length>12000 || pointCount>250000) throw new Error('There are too many fine edges. Try the Clean detail setting or use a simpler image.');
  }
  if(!paths.length) throw new Error('No clear lines found. Try Detailed edges or a higher-contrast picture.');
  paths.sort((a,b)=>settings.order==='length' ? b.length-a.length || a.y-b.y : Math.floor(a.y/22)-Math.floor(b.y/22) || a.x-b.x || a.y-b.y);
  onProgress(1);
  return { paths,totalLength:paths.reduce((sum,p)=>sum+p.length,0),edgeCount:tail };
}

let markerPromise: Promise<HTMLCanvasElement> | undefined;
export function loadMarker(): Promise<HTMLCanvasElement> {
  if(markerPromise) return markerPromise;
  markerPromise=(async()=>{
    const image=new Image(); image.src=handUrl; await image.decode();
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=Math.round(512*image.height/image.width);
    const ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height), data=pixels.data;
    if(!Array.from({length:canvas.width},(_,i)=>data[i*4+3]).some(a=>a<250)) {
      const size=canvas.width*canvas.height,seen=new Uint8Array(size),queue=new Int32Array(size);let tail=0;
      const visit=(i:number)=>{if(i<0||i>=size||seen[i])return;seen[i]=1;if(Math.min(data[i*4],data[i*4+1],data[i*4+2])>239)queue[tail++]=i;};
      for(let x=0;x<canvas.width;x++){visit(x);visit((canvas.height-1)*canvas.width+x);}
      for(let y=0;y<canvas.height;y++){visit(y*canvas.width);visit(y*canvas.width+canvas.width-1);}
      for(let head=0;head<tail;head++){const i=queue[head];data[i*4+3]=0;visit(i-canvas.width);visit(i+canvas.width);if(i%canvas.width)visit(i-1);if(i%canvas.width<canvas.width-1)visit(i+1);}
      ctx.putImageData(pixels,0,0);
    }
    return canvas;
  })().catch(error=>{markerPromise=undefined;throw error;});
  return markerPromise;
}

type Segment = { a: Point; b: Point; budget: number; draws: boolean };
export class SketchPainter {
  private segments: Segment[]=[];
  private budget=0;
  private index=0;
  private partial=0;
  private consumed=0;
  private ctx: CanvasRenderingContext2D;
  private scratch: HTMLCanvasElement;
  private scratchContext: CanvasRenderingContext2D;
  tip: Point | null=null;
  constructor(private canvas: HTMLCanvasElement, drawing: SketchDrawing, private settings: SketchSettings, private marker?: HTMLCanvasElement) {
    this.ctx=canvas.getContext('2d')!;
    this.scratch=document.createElement('canvas');this.scratch.width=canvas.width;this.scratch.height=canvas.height;
    this.scratchContext=this.scratch.getContext('2d')!;
    let previous:Point|undefined;
    for(const path of drawing.paths){
      if(previous){const budget=Math.hypot(path.points[0].x-previous.x,path.points[0].y-previous.y)*.08;if(budget>1e-8)this.segments.push({a:previous,b:path.points[0],budget,draws:false});}
      for(let i=1;i<path.points.length;i++){const a=path.points[i-1],b=path.points[i],budget=Math.hypot(b.x-a.x,b.y-a.y);if(budget>1e-8)this.segments.push({a,b,budget,draws:true});}
      previous=path.points[path.points.length-1];
    }
    this.budget=this.segments.reduce((sum,s)=>sum+s.budget,0);this.reset();
  }
  private reset(){
    this.index=0;this.partial=0;this.consumed=0;this.tip=null;
    const c=this.scratchContext;c.setTransform(this.canvas.width/W,0,0,this.canvas.height/H,0,0);c.fillStyle=this.settings.paper;c.fillRect(0,0,W,H);
    c.strokeStyle=this.settings.ink;c.lineWidth=this.settings.penWidth*W/1920;c.lineCap='round';c.lineJoin='round';
  }
  paint(fraction:number){
    fraction=Math.max(0,Math.min(1,fraction));const target=fraction*this.budget;
    if(target<this.consumed-1e-8)this.reset();
    const c=this.scratchContext;
    while(this.index<this.segments.length && this.consumed<target-1e-8){
      const s=this.segments[this.index],take=Math.min(target-this.consumed,s.budget-this.partial),start=this.partial/s.budget,end=(this.partial+take)/s.budget;
      const a={x:s.a.x+(s.b.x-s.a.x)*start,y:s.a.y+(s.b.y-s.a.y)*start},b={x:s.a.x+(s.b.x-s.a.x)*end,y:s.a.y+(s.b.y-s.a.y)*end};
      if(s.draws){c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();}
      this.tip=b;this.partial+=take;this.consumed+=take;
      if(this.partial>=s.budget-1e-8){this.index++;this.partial=0;}
    }
    this.ctx.setTransform(1,0,0,1,0,0);this.ctx.drawImage(this.scratch,0,0);
    if(this.settings.hand && this.marker && this.tip && fraction>0 && fraction<1){
      this.ctx.setTransform(this.canvas.width/W,0,0,this.canvas.height/H,0,0);
      const width=W*.28,height=width*this.marker.height/this.marker.width;
      this.ctx.drawImage(this.marker,this.tip.x-width*.279,this.tip.y-height*.278,width,height);
    }
  }
}

// ---------------------------------------------------------------------------
// Multiple images sharing one audio track, and bottom-of-frame subtitles.
// ---------------------------------------------------------------------------

export type SubtitleCue = { start: number; end: number; text: string };

/** Even split of a total duration across N images, unless explicit per-image seconds are given. */
export function splitDurations(totalDuration: number, count: number, explicit?: number[]): number[] {
  if (count <= 0 || totalDuration <= 0) return [];
  if (explicit && explicit.length === count && explicit.every(n => Number.isFinite(n) && n > 0)) {
    const sum = explicit.reduce((a, b) => a + b, 0);
    return explicit.map(n => n / sum * totalDuration);
  }
  return Array.from({ length: count }, () => totalDuration / count);
}

/** Parses an .srt file's contents, or treats plain text as one caption per line spread evenly. */
export function parseSubtitles(raw: string, totalDuration: number): SubtitleCue[] {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  if (/\d{2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{1,3}/.test(text)) {
    const toSeconds = (stamp: string) => {
      const m = stamp.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})/)!;
      return +m[1] * 3600 + +m[2] * 60 + +m[3] + Number((m[4] + '000').slice(0, 3)) / 1000;
    };
    const cues: SubtitleCue[] = [];
    for (const block of text.split(/\n\s*\n/)) {
      const lines = block.split('\n').filter(l => l.trim() !== '');
      if (!lines.length) continue;
      if (/^\d+$/.test(lines[0].trim())) lines.shift();
      const match = lines[0]?.match(/(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/);
      if (!match) continue;
      const start = toSeconds(match[1]), end = toSeconds(match[2]);
      const caption = lines.slice(1).join(' ').trim();
      if (caption && end > start) cues.push({ start, end, text: caption });
    }
    return cues.sort((a, b) => a.start - b.start);
  }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length || totalDuration <= 0) return [];
  const step = totalDuration / lines.length;
  return lines.map((line, i) => ({ start: i * step, end: (i + 1) * step, text: line }));
}

export function activeSubtitle(cues: SubtitleCue[], time: number): string | undefined {
  return cues.find(cue => time >= cue.start && time < cue.end)?.text;
}

/** Draws a centered, semi-transparent caption bar near the bottom of the canvas, in physical pixels. */
export function drawSubtitle(ctx: CanvasRenderingContext2D, width: number, height: number, text: string) {
  const size = Math.max(10, Math.round(42 * width / 1920));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `600 ${size}px 'DM Sans', system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const maxWidth = width * .86;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = []; let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || ctx.measureText(candidate).width <= maxWidth) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  if (!lines.length) return;
  const lineHeight = size * 1.32;
  const blockHeight = lines.length * lineHeight;
  const bottom = height * .94, top = bottom - blockHeight;
  const padX = size * .6, padY = size * .4;
  const widest = Math.max(...lines.map(line => ctx.measureText(line).width));
  const boxX = width / 2 - widest / 2 - padX, boxY = top - padY, boxW = widest + padX * 2, boxH = blockHeight + padY * 2, radius = size * .3;
  ctx.beginPath();
  ctx.moveTo(boxX + radius, boxY);
  ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, radius);
  ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, radius);
  ctx.arcTo(boxX, boxY + boxH, boxX, boxY, radius);
  ctx.arcTo(boxX, boxY, boxX + boxW, boxY, radius);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
  ctx.fillStyle = '#ffffff';
  let y = top + size;
  for (const line of lines) { ctx.fillText(line, width / 2, y); y += lineHeight; }
}

/** Sequences several SketchPainter instances across one shared timeline, one active image at a time. */
export class MultiSketchPlayer {
  private painters: SketchPainter[];
  private bounds: { start: number; end: number }[];
  constructor(canvas: HTMLCanvasElement, drawings: SketchDrawing[], settings: SketchSettings, marker: HTMLCanvasElement | undefined, durations: number[]) {
    this.painters = drawings.map(drawing => new SketchPainter(canvas, drawing, settings, marker));
    let t = 0;
    this.bounds = durations.map(duration => { const bound = { start: t, end: t + duration }; t += duration; return bound; });
  }
  paint(time: number) {
    if (!this.painters.length) return;
    let index = this.bounds.findIndex(bound => time < bound.end);
    if (index === -1) index = this.bounds.length - 1;
    const { start, end } = this.bounds[index];
    const fraction = end > start ? Math.max(0, Math.min(1, (time - start) / (end - start))) : 1;
    this.painters[index].paint(fraction);
  }
}

export function sketchVideoFormat(){
  if(typeof MediaRecorder==='undefined'||typeof MediaRecorder.isTypeSupported!=='function')return null;
  const mime=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
  return mime?{mime,extension:mime.includes('mp4')?'mp4':'webm'}:null;
}

/**
 * Records one or more images, drawn in sequence across a shared timeline, together with
 * the supplied audio and optional bottom-of-frame subtitle cues, into a downloadable video blob.
 */
export async function recordSketch(drawings:SketchDrawing[],durations:number[],audio:AudioInput,settings:SketchSettings,marker:HTMLCanvasElement|undefined,cues:SubtitleCue[],onProgress:(n:number)=>void,signal:AbortSignal):Promise<Blob>{
  const format=sketchVideoFormat();if(!format)throw new Error('Video recording is unavailable in this browser. Use the Python render kit.');
  if(audio.duration>300)throw new Error('For audio longer than five minutes, use the streaming Python renderer.');
  if(settings.hand&&!marker)throw new Error('The drawing hand is still loading. Try again or switch it off.');
  if(!drawings.length)throw new Error('Add at least one image before exporting.');
  const context=new AudioContext();const canvas=document.createElement('canvas');canvas.width=settings.resolution==='1080'?1920:1280;canvas.height=settings.resolution==='1080'?1080:720;
  const ctx=canvas.getContext('2d')!;
  let stream:MediaStream|undefined,recorder:MediaRecorder|undefined,raf=0,finishTimer=0;const chunks:Blob[]=[];let source:AudioBufferSourceNode|undefined;
  try{
    await context.resume();
    if(signal.aborted)throw new DOMException('Export cancelled','AbortError');
    const player=new MultiSketchPlayer(canvas,drawings,settings,marker,durations);
    player.paint(0);
    const destination=context.createMediaStreamDestination();source=context.createBufferSource();source.buffer=audio.buffer;source.connect(destination);
    stream=canvas.captureStream(settings.fps);for(const track of destination.stream.getAudioTracks())stream.addTrack(track);
    recorder=new MediaRecorder(stream,{mimeType:format.mime,videoBitsPerSecond:settings.resolution==='1080'?6500000:4000000,audioBitsPerSecond:192000});
    const recording=recorder,player_=source;
    await new Promise<void>((resolve,reject)=>{
      let settled=false;
      const cleanup=()=>{signal.removeEventListener('abort',cancel);document.removeEventListener('visibilitychange',visibility);};
      const fail=(error:Error)=>{if(settled)return;settled=true;cleanup();reject(error);};
      const cancel=()=>fail(new DOMException('Export cancelled','AbortError'));
      const visibility=()=>{if(document.hidden)fail(new Error('Export stopped because the tab was hidden. Keep this tab visible, or use the offline Python renderer.'));};
      signal.addEventListener('abort',cancel,{once:true});document.addEventListener('visibilitychange',visibility);
      recording.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      recording.onerror=()=>fail(new Error('The browser encoder stopped. Try 720p, or use the Python render kit.'));
      recording.onstop=()=>{if(!settled){settled=true;cleanup();resolve();}};
      recording.onstart=()=>{
        if(signal.aborted){cancel();return;}
        const start=context.currentTime;
        const frame=()=>{
          if(settled)return;
          try{
            const time=Math.min(audio.duration,context.currentTime-start);
            player.paint(time);
            if(cues.length){const text=activeSubtitle(cues,time);if(text)drawSubtitle(ctx,canvas.width,canvas.height,text);}
            onProgress(time/audio.duration);raf=requestAnimationFrame(frame);
          }
          catch{fail(new Error('The browser could not draw the next frame. Try 720p or the Python renderer.'));}
        };
        player_.onended=()=>{if(settled)return;cancelAnimationFrame(raf);player.paint(audio.duration);if(cues.length){const text=activeSubtitle(cues,audio.duration-1e-3);if(text)drawSubtitle(ctx,canvas.width,canvas.height,text);}onProgress(1);finishTimer=window.setTimeout(()=>{if(recording.state!=='inactive')recording.stop();},1000/settings.fps);};
        try{player_.start(start);frame();}catch{fail(new Error('The audio stream could not start. Try exporting again.'));}
      };
      try{recording.start(500);}catch{fail(new Error('Could not start the browser video encoder. Try a different resolution or the Python render kit.'));}
    });
    if(!chunks.length)throw new Error('The browser produced an empty recording.');
    return new Blob(chunks,{type:format.mime});
  }finally{
    cancelAnimationFrame(raf);window.clearTimeout(finishTimer);
    if(recorder&&recorder.state!=='inactive')recorder.stop();
    if(source){try{source.stop();}catch{/* Source may already have ended. */}source.disconnect();}
    stream?.getTracks().forEach(track=>track.stop());await context.close();
  }
}

export function downloadSketchPng(drawing:SketchDrawing,settings:SketchSettings){
  const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
  new SketchPainter(canvas,drawing,{...settings,hand:false}).paint(1);
  canvas.toBlob(blob=>{if(blob)downloadBlob(blob,'whiteboard-sketch.png');},'image/png');
}
