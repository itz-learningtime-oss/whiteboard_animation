import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDownToLine, ArrowRight, AudioLines, Check, CircleHelp, Download, Expand, FileAudio, FileText, ImagePlus, Layers3, LoaderCircle, LockKeyhole, Monitor, Palette, Pause, PenLine, Play, Plus, RotateCcw, ScanLine, ShieldCheck, SlidersHorizontal, Terminal, Upload, Volume2, VolumeX, X } from 'lucide-react';
import { artworkMarkup } from '../lib/artwork';
import { downloadBlob } from '../lib/export';
import { formatTime } from '../lib/project';
import { defaultSketchSettings, downloadSketchPng, extractContours, loadMarker, MultiSketchPlayer, parseSubtitles, readAudio, readImage, recordSketch, SketchPainter, sketchVideoFormat, splitDurations } from '../lib/imageSketch';
import type { AudioInput, ImageInput, SketchDrawing, SketchSettings, SubtitleCue } from '../lib/imageSketch';
import { downloadSketchKit } from '../lib/sketchKit';
import Modal from './Modal';

type Props = { active: boolean; helpRequest: number; notify: (message: string) => void; onScriptStudio: () => void };

function SketchCanvas({ drawing, settings, progress, marker }: { drawing: SketchDrawing; settings: SketchSettings; progress: number; marker?: HTMLCanvasElement }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const painter = useRef<SketchPainter | null>(null);
  useEffect(() => {
    if (canvas.current) painter.current = new SketchPainter(canvas.current, drawing, settings, marker);
    return () => { painter.current = null; };
  }, [drawing, settings, marker]);
  useEffect(() => { painter.current?.paint(progress); }, [progress, drawing, settings, marker]);
  const isPortrait = settings.aspectRatio === '9:16';
  return <canvas className="sketch-canvas" ref={canvas} width={isPortrait ? 810 : 1440} height={isPortrait ? 1440 : 810} role="img" aria-label="Progressive contour sketch of your uploaded image"/>;
}

/** Renders one drawing at a time across a shared timeline (multi-image preview). */
function MultiSketchCanvas({ drawings, durations, settings, time, marker }: { drawings: SketchDrawing[]; durations: number[]; settings: SketchSettings; time: number; marker?: HTMLCanvasElement }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const player = useRef<MultiSketchPlayer | null>(null);
  useEffect(() => {
    if (canvas.current && drawings.length) player.current = new MultiSketchPlayer(canvas.current, drawings, settings, marker, durations);
    return () => { player.current = null; };
  }, [drawings, settings, marker, durations]);
  useEffect(() => { player.current?.paint(time); }, [time, drawings, settings, marker, durations]);
  const isPortrait = settings.aspectRatio === '9:16';
  return <canvas className="sketch-canvas" ref={canvas} width={isPortrait ? 810 : 1440} height={isPortrait ? 1440 : 810} role="img" aria-label="Progressive contour sketch of your uploaded images"/>;
}

export default function ImageStudio({ active, helpRequest, notify, onScriptStudio }: Props) {
  const [images, setImages] = useState<ImageInput[]>([]);
  const [audio, setAudio] = useState<AudioInput>();
  const [drawings, setDrawings] = useState<SketchDrawing[]>([]);
  const [subtitle, setSubtitle] = useState<{ file: File; text: string; cues: SubtitleCue[] } | undefined>();
  const [settings, setSettings] = useState<SketchSettings>(defaultSketchSettings);
  const [marker, setMarker] = useState<HTMLCanvasElement>();
  const [loadingImage, setLoadingImage] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [view, setView] = useState<'sketch' | 'original'>('sketch');
  const [dragOver, setDragOver] = useState<'image' | 'audio' | 'subtitle' | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'export' | 'help' | 'full' | null>(null);
  const [exportMode, setExportMode] = useState<'browser' | 'python'>('browser');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportError, setExportError] = useState('');
  const [exportResult, setExportResult] = useState<Blob>();
  const [kitDownloaded, setKitDownloaded] = useState(false);
  const imageUpload = useRef<HTMLInputElement>(null), audioUpload = useRef<HTMLInputElement>(null), subtitleUpload = useRef<HTMLInputElement>(null);
  const audioElement = useRef<HTMLAudioElement>(null);
  const imageTicket = useRef(0), audioTicket = useRef(0);
  const processingAbort = useRef<AbortController | null>(null), exportAbort = useRef<AbortController | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  const recordingFormat = sketchVideoFormat();
  const duration = audio?.duration || 0;
  const totalFrames = audio ? Math.ceil(audio.buffer.length * settings.fps / audio.buffer.sampleRate) : 0;
  const fraction = !started ? 1 : duration ? Math.min(1, time / Math.max(.001, (totalFrames - 1) / settings.fps)) : 0;

  useEffect(() => { if (helpRequest > 0) setDialog('help'); }, [helpRequest]);

  useEffect(() => {
    let alive = true;
    void loadMarker().then(value => { if (alive) setMarker(value); }).catch(() => { if (alive) { setSettings(s=>({...s,hand:false})); notify('The marker image could not load. Sketching is available without the hand.'); } });
    return () => { alive = false; };
  }, [notify]);
  useEffect(() => () => { images.forEach(img => URL.revokeObjectURL(img.url)); }, [images]);
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);
  useEffect(() => () => { processingAbort.current?.abort(); exportAbort.current?.abort(); imageTicket.current++; audioTicket.current++; }, []);
  const pause = useCallback(() => { audioElement.current?.pause(); setPlaying(false); }, []);
  useEffect(() => { if (!active) pause(); }, [active, pause]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => { if (audioElement.current) setTime(audioElement.current.currentTime); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [playing]);

  const play = useCallback(async () => {
    if (!audio || !drawings.length || !audioElement.current) { notify('Add images and audio, then create a sketch to preview it.'); return; }
    if (playing) { pause(); return; }
    if (time >= audio.duration - .01) { audioElement.current.currentTime = 0; setTime(0); }
    setStarted(true); setView('sketch');
    try { await audioElement.current.play(); setPlaying(true); }
    catch { notify('Playback could not start. Try again, or import a WAV or MP3 file.'); }
  }, [audio, drawings, notify, pause, playing, time]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement).tagName;
      if (!active || document.querySelector('[role="dialog"]') || ['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(tag)) return;
      if (event.code === 'Space') { event.preventDefault(); void play(); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [active, play]);

  const resetPlay = () => { pause(); setTime(0); setStarted(false); if (audioElement.current) audioElement.current.currentTime=0; };
  const invalidateDrawing = () => { processingAbort.current?.abort(); setProcessing(false); setDrawings([]); setExportResult(undefined); resetPlay(); };
  const updateSettings = (patch: Partial<SketchSettings>) => {
    setSettings(s=>({...s,...patch})); setExportResult(undefined);
    if (patch.detail !== undefined || patch.order !== undefined) invalidateDrawing();
  };

  const pickImages = async (files?: FileList | File[] | undefined) => {
    if (!files || !files.length || exportBusy) return;
    const ticket = ++imageTicket.current;
    setLoadingImage(true);setError('');invalidateDrawing();
    try {
      const fileArray = Array.from(files);
      const loaded = await Promise.all(fileArray.map(f => readImage(f)));
      if (ticket !== imageTicket.current) { loaded.forEach(l => URL.revokeObjectURL(l.url)); return; }
      setImages(loaded); setView('original');
    } catch (err) { if (ticket === imageTicket.current) setError(err instanceof Error ? err.message : 'Could not read this image.'); }
    finally { if (ticket === imageTicket.current) setLoadingImage(false); if (imageUpload.current) imageUpload.current.value = ''; }
  };
  const pickAudio = async (file?: File) => {
    if (!file || exportBusy) return;
    const ticket=++audioTicket.current;setLoadingAudio(true);setError('');resetPlay();setExportResult(undefined);
    try {
      const loaded=await readAudio(file);
      if(ticket!==audioTicket.current){URL.revokeObjectURL(loaded.url);return;}
      setAudio(loaded);
   }catch(err){if(ticket===audioTicket.current)setError(err instanceof Error?err.message:'Could not read the audio.');}
   finally{if(ticket===audioTicket.current)setLoadingAudio(false);if(audioUpload.current)audioUpload.current.value='';}
  };
  const pickSubtitle = async (file?: File) => {
    if (!file || exportBusy) return;
    try {
      const text = await file.text();
      const cues = parseSubtitles(text, audio?.duration || 60);
      setSubtitle({ file, text, cues });
      notify(`Loaded ${cues.length} subtitle cue${cues.length === 1 ? '' : 's'}.`);
    } catch {
      setError('Could not read the subtitle file.');
    } finally { if (subtitleUpload.current) subtitleUpload.current.value = ''; }
  };
  const removeSubtitle = () => { setSubtitle(undefined); notify('Subtitle file removed.'); };
  const drop = (event: DragEvent, type: 'image' | 'audio') => {
    event.preventDefault();setDragOver(null);
    if (type === 'image') {
      const files = Array.from(event.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      if (files.length) void pickImages(files);
      else setError('Drop at least one image file.');
      return;
    }
    if (event.dataTransfer.files.length !== 1) { setError('Drop one audio file at a time.'); return; }
    void pickAudio(event.dataTransfer.files[0]);
  };
  const createSketch = async () => {
    if (!images.length) { imageUpload.current?.click(); return; }
    processingAbort.current?.abort();const controller=new AbortController();processingAbort.current=controller;
    resetPlay();setError('');setProcessing(true);setProcessingProgress(0);setExportResult(undefined);
    try {
      const results: SketchDrawing[] = [];
      for (let i = 0; i < images.length; i++) {
        if (controller.signal.aborted) return;
        const result = await extractContours(images[i].pixels, settings, controller.signal, progress => setProcessingProgress((i + progress) / images.length));
        if (controller.signal.aborted) return;
        results.push(result);
      }
      if (controller.signal.aborted) return;
      setDrawings(results); setView('sketch');
      const totalStrokes = results.reduce((sum, r) => sum + r.paths.length, 0);
      notify(`${totalStrokes.toLocaleString()} strokes, traced across ${images.length} images. ${audio ? 'Ready to play with your audio.' : 'Add audio to bring your sketch to life.'}`);
    } catch(err) { if (!(err instanceof DOMException && err.name === 'AbortError')) setError(err instanceof Error ? err.message : 'Could not extract contours.'); }
    finally { if (processingAbort.current === controller) { setProcessing(false); processingAbort.current = null; } }
  };
  const sample = async () => {
    try {
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="80 110 740 340"><rect x="80" y="110" width="740" height="340" fill="white"/>${artworkMarkup('rainwater',{color:'#486539',hatching:false})}</svg>`;
      const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
      try{
        const source=new Image();source.src=url;await source.decode();
        const canvas=document.createElement('canvas');canvas.width=1480;canvas.height=680;
        canvas.getContext('2d')!.drawImage(source,0,0,1480,680);
        const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));
        if(blob)await pickImages([new File([blob],'rainwater-diagram.png',{type:'image/png'})]);
      }finally{URL.revokeObjectURL(url);}
    }catch{setError('The sample could not be loaded. Try uploading your own image.');}
  };

  const openExport = () => {
    if (!images.length || !audio || !drawings.length) { notify('Add your images and audio, then create a sketch before exporting.'); return; }
    resetPlay();setExportError('');setKitDownloaded(false);setDialog('export');
  };
  const startExport = async () => {
    setExportBusy(true);setExportError('');setExportProgress(0);setKitDownloaded(false);
    const controller=new AbortController();exportAbort.current=controller;
    try {
      if (exportMode==='python') {
        await downloadSketchKit(images.map(img => img.file), audio?.file, settings, subtitle?.file, controller.signal);
        setKitDownloaded(true);
        notify('Your images, audio, and Python engine are in the render kit.');
      } else {
        if (!audio) throw new Error('Add audio before recording.');
        if (!drawings.length) throw new Error('Create a sketch before recording.');
        const durations = splitDurations(audio.duration, drawings.length);
        const cues = subtitle?.cues || [];
        const result = await recordSketch(drawings, durations, audio, settings, marker, cues, setExportProgress, controller.signal);
        if (controller.signal.aborted) return;
        setExportResult(result);
        downloadBlob(result, `whiteboard-sketch.${recordingFormat?.extension || 'webm'}`);
        notify('Your sketch video includes your uploaded audio. Check your downloads.');
      }
    } catch(err) { if (!(err instanceof DOMException && err.name === 'AbortError')) setExportError(err instanceof Error ? err.message : 'The export could not be completed.'); }
    finally { setExportBusy(false); exportAbort.current = null; }
  };
  const close = () => { exportAbort.current?.abort();setDialog(null); };
  const renderPreview = () => {
    if (processing) return <div className="sketch-processing"><ScanLine size={42} strokeWidth={1.3}/><h3>Finding the story in your lines.</h3><p>Tracing edges, then putting each stroke in its place.</p><div className="processing-track"><span style={{width:`${processingProgress*100}%`}}/></div><span>{Math.round(processingProgress*100)}%</span><button className="text-button" onClick={()=>{processingAbort.current?.abort();setProcessing(false);}}>Cancel</button></div>;
    const previewDurations = audio ? splitDurations(audio.duration, drawings.length) : Array(drawings.length).fill(3);
    if (view === 'original' && images.length) return <div className="original-image-plane" style={{background: settings.paper}}><img src={images[0].url} alt="Original uploaded image"/></div>;
    if (drawings.length > 1) return <MultiSketchCanvas drawings={drawings} durations={previewDurations} settings={settings} time={time} marker={marker}/>;
    if (drawings.length === 1) return <SketchCanvas drawing={drawings[0]} settings={settings} progress={fraction} marker={marker}/>;
    if (images.length) return <div className="original-image-plane" style={{background: settings.paper}}><img src={images[0].url} alt="Uploaded images, ready for contour extraction"/></div>;
    return <div className="sketch-empty-plane"><div className="empty-line-drawing" aria-hidden="true"><svg viewBox="0 0 200 120" fill="none"><path d="M52 90V36q0-6 6-6h84q6 0 6 6v54q0 6-6 6H58q-6 0-6-6Z" stroke="currentColor" strokeWidth="1.6" strokeDasharray="5 5"/><path d="m57 88 28-26 21 19 17-15 20 21M115 48a7 7 0 1 0 14 0a7 7 0 1 0-14 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><path d="m153 59 23-20 6 7-23 20-10 2 4-9ZM172 43l6 7" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M30 49h7M33 45v8M164 91h8M168 87v8" stroke="currentColor" strokeLinecap="round"/></svg></div><h3>Your pictures have stories to tell.</h3><p>Bring images. Add your voice. We will draw the rest.</p><button className="text-button" onClick={()=>void sample()}>Try a sample image <ArrowRight size={14}/></button></div>;
  };

  return <motion.div className="image-studio" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.35}}>
    <input className="sr-only" ref={imageUpload} type="file" accept=".png,.jpg,.jpeg,.webp,.bmp,.tiff,.tif,.jfif,.heic,.webp" multiple aria-label="Upload images" onChange={e=>void pickImages(e.target.files || undefined)}/>
    <input className="sr-only" ref={audioUpload} type="file" accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.aiff,.aif" aria-label="Upload narration audio" onChange={e=>void pickAudio(e.target.files?.[0])}/>
    <input className="sr-only" ref={subtitleUpload} type="file" accept=".srt,.txt,.vtt" aria-label="Upload subtitle file" onChange={e=>void pickSubtitle(e.target.files?.[0])}/>
    <audio ref={audioElement} src={audio?.url} muted={muted} onEnded={()=>{setPlaying(false);setTime(duration);}} onError={()=>{pause();if(audio)setError('The audio player could not open this file. Try a WAV or MP3 recording.');}} preload="auto"/>
    <div className="page-heading"><div><h1>Your picture. Your voice. Your story.<span className="heading-spark"><svg viewBox="0 0 35 38" fill="none"><path d="M8 27L5 18M16 19L18 6M24 24L33 16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></svg></span></h1><p>Turn an image into a hand-drawn video, in time with your own audio.</p></div><button className="primary-button export-top" onClick={openExport}><ArrowDownToLine size={17}/><span>Export video</span></button></div>
    <div className="workflow-tabs image-workflow" aria-label="Image to video workflow"><div className="workflow-step"><button className={!images.length?'selected':''} onClick={()=>imageUpload.current?.click()}><span className="step-number">{images.length?<Check size={12}/>:'01'}</span>Your images</button><span className="step-connector"/></div><div className="workflow-step"><button className={images.length&&!audio?'selected':''} onClick={()=>audioUpload.current?.click()}><span className="step-number">{audio?<Check size={12}/>:'02'}</span>Your audio</button><span className="step-connector"/></div><div className="workflow-step"><button className={images.length&&audio?'selected':''} onClick={()=>controls.current?.scrollIntoView({behavior:'smooth',block:'center'})}><span className="step-number">03</span>Make it a sketch</button></div><span className="workflow-aside"><ShieldCheck size={14}/>Your files never leave your device.</span></div>
    <div className="studio-grid image-studio-grid">
      <section className="editor-panel image-input-panel" aria-label="Image and audio inputs">
        <div className="panel-title-row"><h2><ImagePlus size={18}/>Start with something yours</h2><button className="icon-button" aria-label="How image sketching works" title="How it works" onClick={()=>setDialog('help')}><CircleHelp size={16}/></button></div><p className="panel-description">Two simple ingredients. One memorable video.</p>
         <div className="upload-field-heading"><label htmlFor="choose-sketch-image">Your images</label><span>PNG, JPG, WebP, and more</span></div>
         <div className={`media-drop ${images.length?'has-file':''} ${dragOver==='image'?'dragging':''}`} onDragOver={e=>{e.preventDefault();setDragOver('image');}} onDragLeave={()=>setDragOver(null)} onDrop={e=>drop(e,'image')}>
            {images.length?<div className="image-gallery"><div className="image-gallery-inner">
{images.map((img, idx)=>
  <div key={idx} className="image-gallery-item" draggable
       onDragStart={(e)=>{e.dataTransfer.setData('text/plain',String(idx));e.dataTransfer.effectAllowed='move';}}
       onDragOver={(e)=>{e.preventDefault();e.dataTransfer.dropEffect='move';}}
       onDrop={(e)=>{e.preventDefault();const from=Number(e.dataTransfer.getData('text/plain'));const to=idx;if(from>=0&&to>=0&&from!==to){const next=[...images];const[moved]=next.splice(from,1);next.splice(to,0,moved);setImages(next);}}}>
    <img src={img.url} alt={`Image ${idx+1}: ${img.file.name}`} className="image-gallery-thumb" loading="lazy"/>
    <div className="image-gallery-overlay"><span className="image-number">{idx+1}</span><button className="icon-button remove-file" title={`Remove image ${idx+1}`} aria-label={`Remove image ${idx+1}`} onClick={()=>{imageTicket.current++;setImages(images.filter((_,i)=>i!==idx));invalidateDrawing();setError('');}}><X size={12}/></button></div>
  </div>
)}
<button className="gallery-add-button" type="button" aria-label="Add more images" title="Add more images" onClick={()=>imageUpload.current?.click()}><Plus size={16}/></button></div><div className="uploaded-file-info"><strong>{images.length} image{images.length>1?'s':''} selected</strong><span>{images.reduce((sum,img)=>sum+img.originalWidth*img.originalHeight,0).toLocaleString()} total pixels</span><button className="text-button" onClick={()=>imageUpload.current?.click()}>Add more images</button></div></div>:<button id="choose-sketch-image" className="drop-target" disabled={loadingImage} onClick={()=>imageUpload.current?.click()}>{loadingImage?<LoaderCircle className="spin" size={24}/>:<ImagePlus size={25} strokeWidth={1.4}/>}<strong>{loadingImage?'Opening your pictures...':'Drop images here, or browse'}</strong><span>Diagrams, photographs, or your artwork. Pick one or several.</span></button>}

         </div>
         <div className="upload-field-heading"><label htmlFor="choose-sketch-audio">Your audio</label><span>MP3, WAV, M4A + more</span></div>
         <div className={`media-drop audio-drop ${audio?'has-file':''} ${dragOver==='audio'?'dragging':''}`} onDragOver={e=>{e.preventDefault();setDragOver('audio');}} onDragLeave={()=>setDragOver(null)} onDrop={e=>drop(e,'audio')}>
           {audio&&!loadingAudio?<><span className="audio-file-icon"><AudioLines size={24}/></span><div className="uploaded-file-info"><strong title={audio.file.name}>{audio.file.name}</strong><span>{audio.duration.toFixed(2)} seconds <span className="dot-separator"/> {(audio.buffer.sampleRate/1000).toFixed(1)} kHz</span><button className="text-button" onClick={()=>audioUpload.current?.click()}>Replace audio</button></div><button className="icon-button remove-file" title="Remove audio" aria-label="Remove audio" onClick={()=>{audioTicket.current++;resetPlay();setAudio(undefined);setExportResult(undefined);setError('');}}><X size={14}/></button></>:<button id="choose-sketch-audio" className="drop-target" disabled={loadingAudio} onClick={()=>audioUpload.current?.click()}>{loadingAudio?<LoaderCircle className="spin" size={23}/>:<FileAudio size={24} strokeWidth={1.4}/>}<strong>{loadingAudio?'Measuring your audio...':'Add a voice to your picture'}</strong><span>Upload a recording. We will match its timing.</span></button>}
         </div>
         <div className="upload-field-heading"><label htmlFor="choose-sketch-subtitle">Subtitles (optional)</label><span>SRT, TXT</span></div>
         <div className={`media-drop subtitle-drop ${subtitle?'has-file':''} ${dragOver==='subtitle'?'dragging':''}`} onDragOver={e=>{e.preventDefault();setDragOver('subtitle');}} onDragLeave={()=>setDragOver(null)} onDrop={e=>{e.preventDefault();setDragOver(null);if(e.dataTransfer.files.length===1){const f=e.dataTransfer.files[0];if(f.type==='text/plain'||/\.srt$|\.vtt$/i.test(f.name))void pickSubtitle(f);else setError('Drop an SRT or TXT file.');}else setError('Drop one subtitle file at a time.');}}>
           {subtitle?<><span className="subtitle-file-icon"><FileText size={20}/></span><div className="uploaded-file-info"><strong title={subtitle.file.name}>{subtitle.file.name}</strong><span>{subtitle.cues.length} cue{subtitle.cues.length===1?'':'s'}</span><button className="text-button" onClick={()=>subtitleUpload.current?.click()}>Replace</button></div><button className="icon-button remove-file" title="Remove subtitle file" aria-label="Remove subtitle file" onClick={removeSubtitle}><X size={14}/></button></>:<button id="choose-sketch-subtitle" className="drop-target" onClick={()=>subtitleUpload.current?.click()}><FileText size={24} strokeWidth={1.4}/><strong>Drop a subtitle file, or browse</strong><span>SRT or plain text. Captions are burned into the video.</span></button>}
         </div>
        <div className="sketch-options" ref={controls}><div className="sketch-options-heading"><SlidersHorizontal size={14}/><span>A few finishing touches</span></div><div className="field-row"><label className="field-label">Line detail<select value={settings.detail} onChange={e=>updateSettings({detail:e.target.value as SketchSettings['detail']})}><option value="clean">Clean & simple</option><option value="balanced">Balanced</option><option value="detailed">Fine details</option></select></label><label className="field-label">Drawing order<select value={settings.order} onChange={e=>updateSettings({order:e.target.value as SketchSettings['order']})}><option value="spatial">Top to bottom</option><option value="length">Longest lines first</option></select></label></div><div className="sketch-hand-setting"><label><PenLine size={14}/>Show the drawing hand</label><button className={`toggle ${settings.hand?'toggle-on':''}`} role="switch" aria-checked={settings.hand} aria-label="Show the drawing hand" onClick={()=>updateSettings({hand:!settings.hand})}><span/></button></div><div className="sketch-color-setting"><label><Palette size={14}/>Use image colors</label><button className={`toggle ${settings.colorMode==='colorful'?'toggle-on':''}`} role="switch" aria-checked={settings.colorMode==='colorful'} aria-label="Use image colors" onClick={()=>updateSettings({colorMode:settings.colorMode==='colorful'?'monochrome':'colorful'})}><span/></button></div><div className={`sketch-color-preservation ${settings.colorMode==='monochrome'?'disabled':''}`}><label className="preservation-label"><Layers3 size={14}/>Original color strength</label><input type="range" min="0" max="100" step="5" value={settings.colorPreservation} onChange={e=>updateSettings({colorPreservation:parseInt(e.target.value)})} className="preservation-slider"/><div className="preservation-values"><span>0%</span><span className="preservation-current">{settings.colorPreservation}%</span><span>100%</span></div></div><label className="field-label sketch-aspect-select">Canvas format<select value={settings.aspectRatio} onChange={e=>updateSettings({aspectRatio:e.target.value as SketchSettings['aspectRatio']})}><option value="16:9">16:9 landscape</option><option value="9:16">9:16 portrait</option></select></label><div className="sketch-fit-setting"><label><Expand size={14}/>Sketch size</label><input type="range" min="25" max="100" step="5" value={settings.fitScale} onChange={e=>updateSettings({fitScale:parseInt(e.target.value)})} className="fit-slider"/><span className="fit-value">{settings.fitScale}%</span></div><label className="field-label sketch-reveal-select"><span>Color reveal</span><select value={settings.fillMethod} onChange={e=>updateSettings({fillMethod:e.target.value as SketchSettings['fillMethod']})} disabled={settings.colorPreservation===0}><option value="sweep">Sweep brush</option><option value="wipe-top">Top-down wipe</option></select></label></div>
        {error&&<p className="inline-error" role="alert">{error}</p>}
        <div className="editor-bottom"><button className="primary-button generate-button" disabled={processing||loadingImage||loadingAudio} onClick={()=>void createSketch()}>{processing?<LoaderCircle className="spin" size={17}/>:<ScanLine size={17}/>}<span>{processing?'Tracing your picture...':drawings.length?'Recreate sketch':'Create sketch'}</span><ArrowRight size={17}/></button><p className="privacy-caption"><LockKeyhole size={11}/>No AI. No API keys. Just your creativity.</p></div>
      </section>
      <section className="preview-panel image-preview-panel" aria-label="Image sketch preview"><div className="preview-toolbar"><h2><span className="live-dot"/>Your picture, taking shape</h2><div><span className="aspect-label"><Monitor size={14}/>16:9</span><span className="preview-toolbar-divider"/><button className="icon-button" aria-label="Expand sketch preview" title="Expand preview" onClick={()=>setDialog('full')}><Expand size={16}/></button></div></div><div className="image-preview-stage">{renderPreview()}</div><div className="image-preview-switches"><div className="preview-mode-switch"><button disabled={!drawings.length} className={view==='sketch'?'active':''} onClick={()=>setView('sketch')}><PenLine size={12}/>Sketch</button><button disabled={!images.length} className={view==='original'?'active':''} onClick={()=>{pause();setView('original');}}><ImagePlus size={12}/>Original</button></div><div className="paper-mini-options" aria-label="Canvas background">{[{color:'#fcfbf5',name:'Warm paper'},{color:'#ffffff',name:'Pure white'},{color:'#f0f3ed',name:'Soft sage'}].map(p=><button key={p.color} title={p.name} aria-label={`Use ${p.name.toLowerCase()} canvas`} aria-pressed={settings.paper===p.color} style={{background:p.color}} className={settings.paper===p.color?'selected':''} onClick={()=>updateSettings({paper:p.color})}>{settings.paper===p.color&&<Check size={9}/>}</button>)}</div></div><div className="playback-controls"><button className="play-button" aria-label={playing?'Pause sketch preview':'Play sketch with audio'} title={audio&&drawings.length?'Play your pictures with audio':'Add images and audio to preview'} disabled={!audio||!drawings.length} onClick={()=>void play()}>{playing?<Pause size={14} fill="currentColor"/>:<Play size={14} fill="currentColor"/>}</button><button className="icon-button restart-button" aria-label="Restart sketch" title="Restart sketch" onClick={()=>{pause();if(audioElement.current)audioElement.current.currentTime=0;setTime(0);setStarted(true);setView('sketch');}}><RotateCcw size={14}/></button><span className="playback-time">{formatTime(time)} <span>/ {formatTime(duration)}</span></span><input className="timeline-scrubber" aria-label="Sketch playback position" type="range" min={0} max={duration||1} value={time} step={.01} disabled={!audio||!drawings.length} style={{'--progress':`${duration?time/duration*100:0}%`} as CSSProperties} onChange={e=>{pause();const value=Number(e.target.value);setStarted(true);setView('sketch');setTime(value);if(audioElement.current)audioElement.current.currentTime=value;}}/><button className="icon-button" aria-label={muted?'Unmute supplied audio':'Mute supplied audio'} title={muted?'Unmute audio':'Mute audio'} onClick={()=>setMuted(!muted)}>{muted?<VolumeX size={16}/>:<Volume2 size={16}/>}</button></div><div className="preview-caption"><span><Layers3 size={12}/>{drawings.length?`${drawings.reduce((sum,d)=>sum+d.paths.length,0).toLocaleString()} strokes across ${images.length} image${images.length>1?'s':''}`:'Your canvas is ready'}</span><span>A picture, one little line at a time.</span></div></section>
    </div>
    <section className="audio-timeline-section" aria-label="Audio-synchronized drawing timeline"><div className="storyboard-heading"><div><h2>Your story, in sync</h2><span className="scene-count">{audio?`${duration.toFixed(2)} seconds`:'Waiting for your audio'}</span></div><button className="text-button" disabled={!drawings.length} onClick={()=>{if(drawings.length)downloadSketchPng(drawings[0],settings);}}><Download size={13}/>Save sketch</button></div><div className={`sketch-audio-timeline ${audio?'has-audio':''}`}><div className="timeline-track-icon"><AudioLines size={21} strokeWidth={1.3}/><span>Audio</span></div>{audio?<button className="waveform-track" aria-label="Seek within your supplied audio" disabled={!drawings.length} onClick={e=>{const bounds=e.currentTarget.getBoundingClientRect();const value=Math.max(0,Math.min(duration,(e.clientX-bounds.left)/bounds.width*duration));pause();setTime(value);setStarted(true);if(audioElement.current)audioElement.current.currentTime=value;}}><div className="waveform-bars">{audio.peaks.map((peak,i)=><span key={i} style={{height:`${Math.max(5,peak*78)}%`,background: i/100<time/duration?'#6d8955':undefined}}/>)}</div><div className="audio-playhead" style={{left:`${time/duration*100}%`}}/><span className="waveform-zero">0:00</span><span className="waveform-end">{formatTime(duration)}</span></button>:<button className="timeline-add-audio" onClick={()=>audioUpload.current?.click()}><Upload size={15}/><span>Your audio sets the pace. Add a recording to get started.</span></button>}<div className="timeline-frame-info"><strong>{audio?totalFrames.toLocaleString():'--'}</strong><span>frames at {settings.fps} fps</span></div></div><p className="timeline-footnote">{audio?'Drawing speed adapts to your audio. No voice generation, stretching, or trimmed endings.':'Your original audio will be included in both browser and Python video exports.'}</p></section>
    <footer className="studio-footer"><span><LockKeyhole size={12}/>Local-first. LLM-free. All yours.</span><button className="text-button" onClick={onScriptStudio}>Prefer starting with words? <ArrowRight size={12}/></button></footer>
    <AnimatePresence>
      {dialog==='full'&&<Modal title="Your picture, one line at a time." wide onClose={close}><div className="fullscreen-board">{renderPreview()}</div><div className="fullscreen-controls"><button className="primary-button" disabled={!audio||!drawings.length} onClick={()=>void play()}>{playing?<Pause size={15}/>:<Play size={15}/>} {playing?'Pause':'Play with audio'}</button><span>{formatTime(time)} / {formatTime(duration)}</span><button className="text-button" onClick={()=>{resetPlay();setStarted(true);}}>Start over <RotateCcw size={14}/></button></div></Modal>}
             {dialog==='help'&&<Modal title="Your images are the starting point." onClose={close}><p className="modal-intro">No generated substitutes. The lines come from the pictures you choose.</p><div className="image-help-steps"><div><span>01</span><div><h3>Find the lines.</h3><p>Grayscale, Gaussian blur, and edge detection turn your image into high-contrast strokes. Clear diagrams and illustrations usually work best.</p></div></div><div><span>02</span><div><h3>Let your audio lead.</h3><p>Upload your own narration or soundtrack. Its decoded duration sets the drawing pace. The marker follows the contours, lifting between separate strokes.</p></div></div><div><span>03</span><div><h3>Choose your finish.</h3><p>Export an audio-backed browser recording, or download the Python kit for OpenCV processing and an HD MP4 verified with FFprobe. Subtitles can be burned in too. Both run locally.</p></div></div></div><p className="sketch-runtime-note">Browser edge tracing is a JavaScript approximation. The Python renderer uses OpenCV at higher resolution and exact decoded audio sample counts.</p><button className="primary-button full-width" onClick={()=>void downloadSketchKit(images.map(img=>img.file),audio?.file,settings,subtitle?.file).then(()=>notify('Your images, audio, and Python engine are in the render kit.')).catch(err=>notify(err.message))}><Terminal size={16}/>Download the Python builder</button></Modal>}
      {dialog==='export'&&<Modal title="Picture this. Ready to share." onClose={close}><p className="modal-intro">Your lines and your voice, together in one little video.</p><div className="sketch-export-summary">{images.length>0&&<img src={images[0].url} alt="Your source image"/>}<div><strong>{images[0]?.file.name}</strong>{images.length>1&&<span className="image-count-badge">{images.length} images</span>}<span><AudioLines size={12}/>{audio?.file.name}</span>{subtitle&&<span><FileText size={12}/>{subtitle.file.name} · {subtitle.cues.length} cue{subtitle.cues.length===1?'':'s'}</span>}<small>{duration.toFixed(2)} seconds <span/> {totalFrames.toLocaleString()} frames <span/> 16:9</small></div></div><div className="export-format-options"><button className={exportMode==='browser'?'selected':''} disabled={exportBusy} onClick={()=>{setExportMode('browser');setExportError('');}}><Monitor size={21}/><strong>Browser video</strong><span>{recordingFormat?`${recordingFormat.extension.toUpperCase()} with your audio`:'Not supported here'}</span>{exportMode==='browser'&&<Check size={14}/>}</button><button className={exportMode==='python'?'selected':''} disabled={exportBusy} onClick={()=>{setExportMode('python');setExportError('');}}><Terminal size={21}/><strong>Python render kit</strong><span>Precise, offline HD MP4</span>{exportMode==='python'&&<Check size={14}/>}</button></div><div className="field-row sketch-export-fields"><label className="field-label">Resolution<select disabled={exportBusy} value={settings.resolution} onChange={e=>updateSettings({resolution:e.target.value as SketchSettings['resolution']})}><option value="1080">1080p Full HD</option><option value="720">720p HD</option></select></label><label className="field-label">Frame rate<select disabled={exportBusy} value={settings.fps} onChange={e=>updateSettings({fps:Number(e.target.value) as SketchSettings['fps']})}><option value={24}>24 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option></select></label></div><div className="export-note"><CircleHelp size={16}/><p>{exportMode==='browser'?'Your uploaded audio is included. Recording happens in real time, so keep this tab visible until it finishes. For frame-accurate offline output, use Python.':'Includes the complete engine, your original image and audio, and a ready-to-run command. Run it locally with Python and FFmpeg to create a verified H.264/AAC MP4.'}</p></div>{exportMode==='python'&&<div className="code-block compact-code"><code>python setup_builder.py<br/>python main.py --image input_image.png<br/>&nbsp; --audio narration.mp3 --output final_video.mp4</code></div>}{exportBusy&&<div className="export-progress" role="status"><div><LoaderCircle size={15} className="spin"/><span>{exportMode==='python'?'Packing your picture, audio, and engine...':'Recording your sketch and audio...'}</span>{exportMode==='browser'&&<strong>{Math.round(exportProgress*100)}%</strong>}</div><div className="progress-track"><span style={{width:`${exportMode==='python'?45:exportProgress*100}%`}}/></div></div>}{exportError&&<p className="inline-error" role="alert">{exportError}</p>}{((exportResult&&exportMode==='browser')||(kitDownloaded&&exportMode==='python'))&&!exportBusy&&<div className="export-success"><Check size={17}/>{exportMode==='python'?'Your render kit is in your downloads.':'Your video and audio are ready to share.'}</div>}<button className="primary-button export-confirm" disabled={exportBusy||(exportMode==='browser'&&!recordingFormat)} onClick={()=>void startExport()}>{exportBusy?<LoaderCircle className="spin" size={17}/>:<Download size={17}/>}<span>{exportBusy?'A little patience. A lot of lines.':exportMode==='python'?'Download image + audio render kit':`Export ${recordingFormat?.extension.toUpperCase()||'video'} with audio`}</span></button><div className="export-bottom">{exportResult&&exportMode==='browser'&&!exportBusy?<button className="text-button" onClick={()=>downloadBlob(exportResult,`whiteboard-sketch.${recordingFormat?.extension||'webm'}`)}><Download size={13}/>Download again</button>:<span><LockKeyhole size={12}/>Private, local, and watermark-free.</span>}{exportBusy&&<button className="text-button danger" onClick={()=>exportAbort.current?.abort()}>Cancel</button>}</div></Modal>}
    </AnimatePresence>
  </motion.div>;
}