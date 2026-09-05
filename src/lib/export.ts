import JSZip from 'jszip';
import { artworkMarkup, boardInk, boardMarkup } from './artwork';
import { scriptJson, slug, visualNames } from './project';
import type { Project, Scene, StudioSettings, Visual } from './project';
import handUrl from '../../whiteboard-engine/assets/hand_marker.png';
import engineWorkflow from '../../whiteboard-engine/.github/workflows/test.yml?raw';
import engineIgnore from '../../whiteboard-engine/.gitignore?raw';

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function downloadProject(project: Project) {
  downloadBlob(new Blob([JSON.stringify(scriptJson(project), null, 2)], { type: 'application/json' }), `${slug(project.title)}.json`);
}

export async function downloadEngine(project: Project, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  const sources = import.meta.glob('../../whiteboard-engine/**/*.{py,txt,md,json,svg,yml}', { query: '?raw', import: 'default', eager: true });
  const zip = new JSZip();
  zip.file('whiteboard-engine/.github/workflows/test.yml', engineWorkflow);
  zip.file('whiteboard-engine/.gitignore', engineIgnore);
  for (const [path, content] of Object.entries(sources)) zip.file(path.replace('../../', ''), String(content));
  for (const visual of Object.keys(visualNames) as Visual[]) {
    zip.file(`whiteboard-engine/assets/illustrations/${visual}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 506" fill="none">${artworkMarkup(visual, { ...project.settings, hatching: true }).replace(/class="art-stroke" /g, '')}</svg>`);
  }
  const image = await fetch(handUrl, { signal });
  if (!image.ok) throw new Error('The drawing-hand asset could not be loaded. Please try again.');
  zip.file('whiteboard-engine/assets/hand_marker.png', await image.blob());
  zip.file('whiteboard-engine/story.json', JSON.stringify(scriptJson(project), null, 2));
  zip.file('whiteboard-engine/RENDER_THIS_STORY.txt', '1. Install Python 3.11+ and FFmpeg.\n2. Run: python setup_engine.py\n3. Run: python run_studio.py --json story.json --offline\n\nFor the web connection: python serve_studio.py\nRead README.md for Hindi fonts, narration, and all options.\n');
  const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  downloadBlob(archive, `${slug(project.title)}-render-kit.zip`);
}

export function browserVideoFormat() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  const types = ['video/mp4;codecs=avc1.42001f', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = types.find(type => MediaRecorder.isTypeSupported(type));
  return mime ? { mime, extension: mime.includes('mp4') ? 'mp4' : 'webm' } : null;
}

type CompiledPath = { points: { x: number; y: number }[]; length: number; color: string; width: number };
function compileScene(scene: Scene, settings: StudioSettings): CompiledPath[] {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:506px;visibility:hidden;pointer-events:none;';
  holder.innerHTML = boardMarkup(scene, settings);
  document.body.append(holder);
  try {
    return [...holder.querySelectorAll<SVGPathElement>('.art-stroke')].flatMap(element => {
      // Bundled artwork uses absolute M commands. Split every pen lift so a
      // sampled canvas path never draws a connecting line across empty space.
      const subpaths = (element.getAttribute('d') || '').match(/M[^M]*/g) || [];
      return subpaths.map(data => {
        const segment = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        segment.setAttribute('d', data);
        holder.querySelector('svg')!.append(segment);
        try {
          const length = segment.getTotalLength();
          const n = Math.max(2, Math.min(3000, Math.ceil(length / 2)));
          const points = Array.from({ length: n + 1 }, (_, i) => {
            const p = segment.getPointAtLength(i / n * length);
            return scene.layout === 'illustration_left' ? { x: p.x * .85 - 73, y: p.y * .85 + 17 } : { x: p.x, y: p.y };
          });
          return { points, length, color: element.getAttribute('stroke') || boardInk, width: Number(element.getAttribute('stroke-width')) || 2 };
        } finally { segment.remove(); }
      }).filter(path => path.length > 1e-8);
    });
  } finally { holder.remove(); }
}

export async function recordBrowserVideo(project: Project, onProgress: (value: number) => void, signal: AbortSignal) {
  const format = browserVideoFormat();
  if (!format) throw new Error('This browser cannot record canvas video. Download the Python render kit instead.');
  if (!project.scenes.length) throw new Error('Generate a storyboard first.');
  if (project.scenes.reduce((sum, scene) => sum + scene.duration, 0) > 300) throw new Error('Browser previews are limited to five minutes to protect your device memory. Use the streaming Python renderer for longer stories.');
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = project.settings.resolution === '1080' ? 1920 : 1280;
  canvas.height = project.settings.resolution === '1080' ? 1080 : 720;
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.captureStream) throw new Error('Canvas recording is unavailable. Please use the Python render kit.');
  const compiled = project.scenes.map(s => compileScene(s, project.settings));
  const totals = compiled.map(paths => paths.reduce((sum, p) => sum + p.length, 0));
  const image = new Image(); image.src = handUrl;
  await image.decode().catch(() => undefined);
  const total = project.scenes.reduce((sum, scene) => sum + scene.duration, 0);

  const paint = (index: number, progress: number, offset = 0) => {
    ctx.save(); ctx.translate(offset, 0);
    ctx.fillStyle = project.settings.paper; ctx.fillRect(0, 0, 900, 507);
    ctx.fillStyle = boardInk; ctx.textAlign = 'center';
    ctx.font = `600 ${project.scenes[index].title.length > 35 ? 34 : 43}px Caveat, 'Noto Sans Devanagari', cursive`;
    ctx.fillText(project.scenes[index].title, 450, 85, 790);
    ctx.beginPath(); ctx.moveTo(343,98); ctx.quadraticCurveTo(450,92,557,97);
    ctx.strokeStyle=project.settings.color; ctx.lineWidth=2.2; ctx.stroke();
    let remaining = totals[index]*progress;
    let tip: { x: number; y: number } | undefined;
    for (const path of compiled[index]) {
      if (remaining <= 0) break;
      const fraction = Math.min(1, remaining/path.length);
      const end = fraction*(path.points.length-1);
      ctx.beginPath(); ctx.moveTo(path.points[0].x,path.points[0].y);
      for (let i=1; i<=Math.floor(end); i++) ctx.lineTo(path.points[i].x,path.points[i].y);
      const low = path.points[Math.floor(end)], high = path.points[Math.min(path.points.length-1,Math.ceil(end))];
      tip = { x: low.x+(high.x-low.x)*(end%1), y: low.y+(high.y-low.y)*(end%1) };
      ctx.lineTo(tip.x,tip.y); ctx.strokeStyle=path.color; ctx.lineWidth=path.width; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.stroke();
      remaining -= path.length;
    }
    if (project.settings.hand && tip && progress < .99 && image.complete && image.naturalWidth) {
      ctx.globalCompositeOperation='multiply'; ctx.drawImage(image,tip.x-55,tip.y-81,320,320); ctx.globalCompositeOperation='source-over';
    }
    ctx.restore();
  };

  const stream = canvas.captureStream(30);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 6000000 });
  } catch {
    stream.getTracks().forEach(track => track.stop());
    throw new Error('The browser cannot start this encoder. Try 720p or use the Python render kit.');
  }
  const chunks: Blob[] = [];
  let raf=0;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled=false;
      const cancel=() => { if (settled) return; settled=true; cancelAnimationFrame(raf); if (recorder.state !== 'inactive') recorder.stop(); reject(new DOMException('Export cancelled','AbortError')); };
      signal.addEventListener('abort',cancel,{ once:true });
      recorder.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
      recorder.onerror=()=>{ signal.removeEventListener('abort',cancel); settled=true; reject(new Error('Your browser could not encode the video. Try 720p or the Python render kit.')); };
      recorder.onstop=()=>{ signal.removeEventListener('abort',cancel); if (!settled) { settled=true; resolve(); } };
      if (signal.aborted) { cancel(); return; }
      ctx.fillStyle=project.settings.paper; ctx.fillRect(0,0,canvas.width,canvas.height);
      recorder.start(500);
      const start=performance.now();
      const frame=()=>{
        if (signal.aborted || settled) return;
        const time=Math.min(total,(performance.now()-start)/1000);
        let index=0, local=time;
        while (index<project.scenes.length-1 && local>=project.scenes[index].duration) { local-=project.scenes[index].duration; index++; }
        const progress=Math.min(1,Math.max(0,(local-.25)/(project.scenes[index].duration*.75)));
        ctx.setTransform(canvas.width/900,0,0,canvas.height/506,0,0);
        if (project.settings.camera && index>0 && local<.8) {
          const t=local/.8, eased=t*t*(3-2*t);
          paint(index-1,1,-900*eased); paint(index,progress,900*(1-eased));
        } else paint(index,progress);
        onProgress(time/total);
        if (time>=total) recorder.stop(); else raf=requestAnimationFrame(frame);
      };
      frame();
    });
    downloadBlob(new Blob(chunks,{ type:format.mime }),`${slug(project.title)}-preview.${format.extension}`);
  } finally {
    cancelAnimationFrame(raf);
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach(track=>track.stop());
  }
}

export function normalizeEngineUrl(value: string) {
  const url=new URL(value);
  if (!['http:','https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Use a local engine address, such as http://127.0.0.1:8765.');
  return url.origin;
}

export async function checkEngine(value: string) {
  const base=normalizeEngineUrl(value);
  const response=await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('The local engine did not respond.');
  const data=await response.json();
  if (data.engine !== 'scribble-whiteboard') throw new Error('This address is not a Scribble engine.');
  return { base, ...data };
}

export async function renderLocalVideo(project: Project, engine: string, onProgress: (value: number, message?: string) => void, signal: AbortSignal) {
  const base=normalizeEngineUrl(engine);
  const response=await fetch(`${base}/render`,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(scriptJson(project)),signal });
  const result=await response.json();
  if (!response.ok) throw new Error(typeof result.detail==='string' ? result.detail : 'The engine could not start this render.');
  const cancel=()=>{ void fetch(`${base}/jobs/${result.id}`,{method:'DELETE'}).catch(()=>undefined); };
  signal.addEventListener('abort',cancel,{once:true});
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Export cancelled','AbortError');
      const status=await fetch(`${base}/jobs/${result.id}`,{signal});
      if (!status.ok) throw new Error('The render job could not be found.');
      const job=await status.json();
      onProgress(job.progress || 0,job.message);
      if (job.status==='error' || job.status==='cancelled') throw new Error(job.message || 'Rendering stopped.');
      if (job.status==='complete') {
        const file=await fetch(`${base}/jobs/${result.id}/download`,{signal});
        if (!file.ok) throw new Error('The rendered video could not be downloaded.');
        downloadBlob(await file.blob(),`${slug(project.title)}.mp4`); return;
      }
      await new Promise(resolve=>window.setTimeout(resolve,1000));
    }
  } finally { signal.removeEventListener('abort',cancel); }
}