import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpRight, BookOpen, Check,
  CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clapperboard, Clock3, CloudCheck,
  Code2, Copy, Download, Expand, FileJson, FilePenLine, FileText, Folder, FolderOpen,
  Globe2, GripVertical, Keyboard, Layers3, Leaf, LoaderCircle, LockKeyhole,
  Menu, Mic, Monitor, MoreHorizontal, Paintbrush, Palette, Pause, PenLine, Play, Plus,
  RotateCcw, Search, ShieldCheck, SkipBack, Sparkles, Sprout, Terminal, Trash2,
  Upload, Volume2, VolumeX, WandSparkles, X,
} from 'lucide-react';
import BoardPreview from './components/BoardPreview';
import Modal from './components/Modal';
import { defaultSettings, formatTime, initialScript, newProject, parseScript, safeSettings, scriptJson, templates, uid, visualNames } from './lib/project';
import type { Project, Scene, StudioSettings, Visual } from './lib/project';
import { browserVideoFormat, checkEngine, downloadEngine, downloadProject, recordBrowserVideo, renderLocalVideo } from './lib/export';

type Page = 'studio' | 'projects' | 'library' | 'templates';
type Step = 'script' | 'storyboard' | 'style';
type Dialog = 'new' | 'rename' | 'export' | 'guide' | 'settings' | 'fullscreen' | 'delete' | null;
const STORAGE_KEY = 'scribble.projects.v1';

function loadProjects(): Project[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) {
      const valid = saved.filter(p => p && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.script === 'string' && Array.isArray(p.scenes) && p.scenes.length <= 40 && p.scenes.every((s: Scene) => s && typeof s.id === 'string' && typeof s.text === 'string' && typeof s.title === 'string' && s.visual in visualNames && Number.isFinite(s.duration) && s.duration >= 2 && s.duration <= 120)).map(p => ({ ...p, settings: safeSettings(p.settings) }));
      if (valid.length) return valid;
    }
  } catch { /* A blocked local store should not prevent opening the studio. */ }
  return [newProject('', true)];
}

function Brand() {
  return <div className="brand"><svg viewBox="0 0 42 42" fill="none" aria-hidden="true"><path d="M31 8C21 2 5 15 10 18c4 3 21-11 24-7 4 5-27 13-25 20 3 6 28-13 26-7-1 4-13 12-18 12" stroke="currentColor" strokeWidth="3.7" strokeLinecap="round" strokeLinejoin="round"/></svg><span>scribble<span className="brand-dot">.</span></span></div>;
}

function Github({size = 19}: {size?: number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7M15 22v-3.6c0-1 .1-1.5-.5-2.1 3.3-.4 6.8-1.6 6.8-7.3 0-1.6-.5-2.9-1.5-4 .2-.5.7-2-.2-4 0 0-1.3-.4-4.2 1.5a14.7 14.7 0 0 0-7.6 0C4.9.6 3.6 1 3.6 1c-.9 2-.4 3.5-.2 4-1 1.1-1.5 2.4-1.5 4 0 5.7 3.5 6.9 6.8 7.3-.5.5-.8 1.3-.8 2.2V22" transform="translate(1 1) scale(.91)"/></svg>;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? 'toggle-on' : ''}`} onClick={onChange}><span/></button>;
}

export default function App() {
  const initial = useMemo(loadProjects, []);
  const [projects, setProjects] = useState<Project[]>(initial);
  const projectsRef = useRef(projects); projectsRef.current = projects;
  const [project, setProject] = useState<Project>(initial[0]);
  const previousProjectRef = useRef(project);
  const activeProjectRef = useRef(project); activeProjectRef.current = project;
  const [page, setPage] = useState<Page>('studio');
  const [step, setStep] = useState<Step>('script');
  const [mode, setMode] = useState<'text' | 'json'>('text');
  const [jsonText, setJsonText] = useState('');
  const [selected, setSelected] = useState(0);
  const [saved, setSaved] = useState(true);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [voiceVersion, setVoiceVersion] = useState(0);
  const voiceNoticeShown = useRef(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [nameInput, setNameInput] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [query, setQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [engineUrl, setEngineUrl] = useState('http://127.0.0.1:8765');
  const [engineConnected, setEngineConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [engineMessage, setEngineMessage] = useState('');
  const [exportMode, setExportMode] = useState<'browser' | 'python'>('browser');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMessage, setExportMessage] = useState('');
  const [exportError, setExportError] = useState('');
  const [exportComplete, setExportComplete] = useState(false);
  const exportAbort = useRef<AbortController | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dragId = useRef<string | null>(null);
  const reducedMotion = useReducedMotion();
  const notify = useCallback((message: string) => setToast(message), []);
  const totalDuration = project.scenes.reduce((sum, s) => sum + s.duration, 0);
  const wordCount = project.script.trim() ? project.script.trim().split(/\s+/).length : 0;
  const videoFormat = useMemo(browserVideoFormat, []);
  let timedIndex = 0, timedOffset = 0;
  for (let i = 0; i < project.scenes.length; i++) {
    if (currentTime < timedOffset + project.scenes[i].duration || i === project.scenes.length - 1) { timedIndex = i; break; }
    timedOffset += project.scenes[i].duration;
  }
  const activeIndex = Math.min(playing ? timedIndex : selected, Math.max(0, project.scenes.length - 1));
  const activeScene = project.scenes[activeIndex];
  const sceneOffset = project.scenes.slice(0, activeIndex).reduce((sum, s) => sum + s.duration, 0);
  const progress = !started ? 1 : activeScene ? Math.min(1, Math.max(0, (currentTime - sceneOffset - .15) / (activeScene.duration * .78))) : 0;

  useEffect(() => {
    if (previousProjectRef.current.id !== project.id) {
      const previous = previousProjectRef.current;
      const next = [{ ...previous, updatedAt: Date.now() }, ...projectsRef.current.filter(p => p.id !== previous.id)];
      projectsRef.current = next;
      setProjects(next);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { setStorageAvailable(false); }
    }
    previousProjectRef.current = project;
    setSaved(false);
    const timer = window.setTimeout(() => {
      const next = [{ ...project, updatedAt: Date.now() }, ...projectsRef.current.filter(p => p.id !== project.id)];
      setProjects(next);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setSaved(true); setStorageAvailable(true); }
      catch { setStorageAvailable(false); }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [project]);

  useEffect(() => {
    const flush = () => {
      const current = activeProjectRef.current;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...current, updatedAt: Date.now() }, ...projectsRef.current.filter(p=>p.id!==current.id)])); } catch { /* In-memory editing remains available if storage is blocked. */ }
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 4300); return () => window.clearTimeout(timer); } }, [toast]);
  useEffect(() => {
    if (!playing && !started) setCurrentTime(project.scenes.slice(0, Math.min(selected, project.scenes.length - 1)).reduce((sum, s) => sum + s.duration, 0));
  }, [selected, project.scenes, playing, started]);
  useEffect(() => {
    setCurrentTime(time => Math.min(time, totalDuration));
  }, [totalDuration]);
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const changed = () => { setVoiceVersion(v => v + 1); voiceNoticeShown.current = false; };
    window.speechSynthesis.addEventListener('voiceschanged', changed);
    window.speechSynthesis.getVoices();
    return () => window.speechSynthesis.removeEventListener('voiceschanged', changed);
  }, []);
  useEffect(() => {
    if (!playing) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => { const dt = Math.min((now - last) / 1000, .1); last = now; setCurrentTime(t => Math.min(totalDuration, t + dt)); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, totalDuration]);
  useEffect(() => { if (playing && currentTime >= totalDuration) { setPlaying(false); setSelected(Math.max(0, project.scenes.length - 1)); } }, [currentTime, playing, totalDuration, project.scenes.length]);
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    if (!playing || !project.settings.narration || muted || !activeScene) return;
    const voice = window.speechSynthesis.getVoices().find(v => v.localService && v.lang.startsWith(project.settings.language));
    if (!voice) {
      if (!voiceNoticeShown.current) { notify('This preview is silent: no offline system voice is installed for the selected language. The Python engine can add narration.'); voiceNoticeShown.current = true; }
      return;
    }
    const utterance = new SpeechSynthesisUtterance(activeScene.text);
    utterance.voice = voice; utterance.lang = project.settings.language === 'hi' ? 'hi-IN' : 'en-US';
    utterance.rate = Math.min(1.8, Math.max(.8, activeScene.text.split(/\s+/).length / activeScene.duration / 2.6)) * project.settings.rate;
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [playing, activeScene?.id, project.settings.narration, project.settings.language, project.settings.rate, muted, voiceVersion, notify]);
  useEffect(() => () => { exportAbort.current?.abort(); if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }, []);

  const play = useCallback(() => {
    if (!project.scenes.length) { notify('Write your script and generate a storyboard first.'); return; }
    if (currentTime >= totalDuration) { setCurrentTime(0); setSelected(0); }
    if (playing) setSelected(timedIndex);
    setStarted(true); setPlaying(p => !p);
  }, [project.scenes.length, currentTime, totalDuration, playing, timedIndex, notify]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (dialog || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return;
      if (event.code === 'Space' && page === 'studio' && !['BUTTON', 'A'].includes(target.tagName)) { event.preventDefault(); play(); }
      if (event.key === '?') setDialog('guide');
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [play, dialog, page]);

  const updateSettings = (patch: Partial<StudioSettings>) => setProject(p => ({ ...p, settings: { ...p.settings, ...patch } }));
  const updateScene = (patch: Partial<Scene>) => setProject(p => ({ ...p, scenes: p.scenes.map((s, i) => i === activeIndex ? { ...s, ...patch } : s) }));
  const goToScene = (index: number) => { setPlaying(false); setStarted(false); setSelected(index); setCurrentTime(project.scenes.slice(0, index).reduce((sum, s) => sum + s.duration, 0)); };
  const navigate = (next: Page) => { setPage(next); setQuery(''); setSidebarOpen(false); setPlaying(false); };
  const resetPlayback = () => { setPlaying(false); setStarted(false); setSelected(0); setCurrentTime(0); setError(''); };
  const generate = async () => {
    const sourceProjectId = project.id;
    setError(''); setGenerating(true); setPlaying(false);
    try {
      const input = mode === 'json' ? jsonText : project.script;
      let parsed = parseScript(input, mode);
      if (engineConnected && mode === 'text') {
        const response = await fetch(`${engineUrl}/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: input, language: project.settings.language }), signal: AbortSignal.timeout(30000) });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'The local parser could not read this script.');
        parsed = parseScript(JSON.stringify(data), 'json');
      }
      if (input.trim() === initialScript.trim() && mode === 'text') parsed.scenes = newProject('', true).scenes;
      if (activeProjectRef.current.id !== sourceProjectId) return;
      setProject(p => ({ ...p, title: parsed.title || p.title, scenes: parsed.scenes, settings: mode === 'json' && parsed.settings ? parsed.settings : p.settings, script: mode === 'json' ? parsed.scenes.map(s => s.text).join('\n\n') : p.script }));
      setSelected(0); setCurrentTime(0); setStarted(false);
      notify(`${parsed.scenes.length} scenes, ready to tell your story. Select a scene to make it your own.`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong while reading the script.'); }
    finally { setGenerating(false); }
  };
  const addScene = () => {
    if (project.scenes.length >= 40) { notify('A project can hold up to 40 scenes.'); return; }
    const scene: Scene = { id: uid(), title: 'A new chapter.', text: 'Add your narration here.', visual: 'book', duration: 7, layout: 'centered_illustration_with_heading' };
    setProject(p => ({ ...p, scenes: [...p.scenes, scene] })); setSelected(project.scenes.length); setCurrentTime(totalDuration); setPlaying(false); setStarted(false); setStep('storyboard');
  };
  const reorderScene = (from: number, to: number) => {
    if (to < 0 || to >= project.scenes.length || from === to) return;
    const scenes = [...project.scenes]; const [moved] = scenes.splice(from, 1); scenes.splice(to, 0, moved);
    setProject(p => ({ ...p, scenes })); setSelected(to); setPlaying(false); setStarted(false); setCurrentTime(scenes.slice(0,to).reduce((sum,s)=>sum+s.duration,0));
  };
  const useTemplate = (index: number) => {
    const template = templates[index];
    const next = index === 0 ? newProject('', true) : { ...newProject(template.title), script: template.script, scenes: parseScript(template.script, 'text').scenes };
    setProject(next); resetPlayback(); setMode('text'); setStep('script'); navigate('studio'); notify('Your new story is ready. Make it your own.');
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 100000) throw new Error('Please choose a script smaller than 100 KB.');
      const text = await file.text(); const isJson = file.name.toLowerCase().endsWith('.json');
      const parsed = parseScript(text, isJson ? 'json' : 'text');
      setProject({ ...newProject(parsed.title || file.name.replace(/\.[^.]+$/, '')), script: parsed.scenes.map(s => s.text).join('\n\n'), scenes: parsed.scenes, settings: parsed.settings || { ...defaultSettings } });
      resetPlayback(); navigate('studio'); setMode('text'); setStep('script'); notify('Script imported. Your next story starts here.');
    } catch (err) { notify(err instanceof Error ? err.message : 'This file could not be imported.'); }
    if (uploadRef.current) uploadRef.current.value = '';
  };
  const previewVoice = () => {
    if (!('speechSynthesis' in window)) { notify('Voice preview is not supported in this browser. Use the Python engine for narration.'); return; }
    const voice = window.speechSynthesis.getVoices().find(v => v.localService && v.lang.startsWith(project.settings.language));
    if (!voice) { notify('No offline voice is installed for this language. Add a system voice, or use the Python narration engine.'); return; }
    setPlaying(false); window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(activeScene?.text || 'A little script. A big story.'); utterance.voice = voice; utterance.rate = project.settings.rate; window.speechSynthesis.speak(utterance);
  };
  const openExport = () => {
    if (!project.scenes.length) { notify('Your story needs a scene first. Generate a storyboard to get started.'); return; }
    setPlaying(false); setExportError(''); setExportComplete(false); setExportProgress(0); setDialog('export');
  };
  const runExport = async () => {
    setExportBusy(true); setExportError(''); setExportComplete(false); setExportProgress(0);
    const controller = new AbortController(); exportAbort.current = controller;
    try {
      if (exportMode === 'python' && !engineConnected) { setExportMessage('Packing your story and the Python engine...'); await downloadEngine(project, controller.signal); }
      else if (exportMode === 'python') await renderLocalVideo(project, engineUrl, (p,m) => { setExportProgress(p); setExportMessage(m || 'Rendering your story...'); }, controller.signal);
      else { setExportMessage('Drawing your video. Please keep this tab open.'); await recordBrowserVideo(project, setExportProgress, controller.signal); }
      if (!controller.signal.aborted) { setExportComplete(true); notify(exportMode === 'python' && !engineConnected ? 'Your complete Python render kit has been downloaded.' : 'Your video is ready. Check your downloads.'); }
    } catch (err) { if (!(err instanceof DOMException && err.name === 'AbortError')) setExportError(err instanceof Error ? err.message : 'The export could not be completed.'); }
    finally { setExportBusy(false); exportAbort.current = null; }
  };
  const connectEngine = async () => {
    setConnecting(true); setEngineMessage('');
    try { const result = await checkEngine(engineUrl); setEngineUrl(result.base); setEngineConnected(true); setEngineMessage(result.ready ? 'Connected. Local parsing and HD MP4 rendering are ready.' : 'Connected. Check the terminal for missing model, voice, or FFmpeg dependencies.'); }
    catch (err) { setEngineConnected(false); setEngineMessage(err instanceof Error && !/fetch|abort|timeout/i.test(err.message) ? err.message : 'Cannot reach the engine. Start serve_studio.py locally, then try again.'); }
    finally { setConnecting(false); }
  };
  const copyCommand = async (text: string) => { try { await navigator.clipboard.writeText(text); notify('Command copied.'); } catch { notify('Clipboard access is blocked. Select and copy the command manually.'); } };
  const closeDialog = () => { if (exportBusy) exportAbort.current?.abort(); setDialog(null); };
  const emptyBoard = <div className="empty-board"><PenLine size={45} strokeWidth={1.25}/><h3>A blank page. Endless possibilities.</h3><p>Add your script and let your story take shape.</p><button className="text-button" onClick={()=>useTemplate(0)}>Start with an example <ArrowRight size={15}/></button></div>;
  const nav = [{ id: 'studio' as Page, icon: PenLine, label: 'Create a video' }, { id: 'projects' as Page, icon: FolderOpen, label: 'My projects' }, { id: 'library' as Page, icon: Layers3, label: 'Illustration library' }, { id: 'templates' as Page, icon: Clapperboard, label: 'Templates' }];

  return <div className="app-shell">
    <input ref={uploadRef} type="file" accept=".json,.txt" className="sr-only" aria-label="Import a script" onChange={e=>void importFile(e.target.files?.[0])}/>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={()=>setSidebarOpen(false)}/>}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <button className="brand-button" aria-label="Scribble studio home" onClick={()=>navigate('studio')}><Brand/></button><p className="brand-tagline">a little more human.</p>
      <button className="new-project-button" onClick={()=>{setNameInput('');setDialog('new');}}><Plus size={17}/><span>New project</span><span className="new-project-shortcut">+</span></button>
      <div className="nav-label">YOUR WORKSPACE</div><nav className="side-nav" aria-label="Main navigation">{nav.map(({id,icon:Icon,label})=><button key={id} className={`nav-item ${page===id?'active':''}`} onClick={()=>navigate(id)} aria-current={page===id?'page':undefined}><Icon size={19} strokeWidth={1.7}/><span>{label}</span>{id==='templates' && <span className="new-label">NEW</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-note"><div className="local-note-drawing"><Sprout size={35} strokeWidth={1.2}/><svg viewBox="0 0 35 20" fill="none"><path d="M2 17Q15 2 30 5M23 1l8 3-5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg></div><h4>Big ideas. Small footprint.</h4><p>Free to create.<br/>Yours to keep. Always.</p><button onClick={()=>setDialog('guide')}>Open source, by nature <ArrowUpRight size={13}/></button></div><button className="help-link" onClick={()=>setDialog('guide')}><CircleHelp size={18}/><span>A little help</span><span className="shortcut-key">?</span></button><button className="workspace-profile" onClick={()=>setDialog('settings')}><div className="workspace-avatar">Y<span/></div><div><strong>Your workspace</strong><span>Personal & private</span></div><ChevronDown size={15}/></button></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={()=>setSidebarOpen(true)}><Menu size={21}/></button><div className="breadcrumb"><Folder size={17}/><button onClick={()=>navigate('projects')}>Workspace</button><ChevronRight size={13}/><button className="project-name" onClick={()=>{setNameInput(project.title);setDialog('rename');}}>{project.title}<PenLine size={12}/></button></div><div className="topbar-actions"><span className={`save-status ${!storageAvailable?'save-warning':''}`}><CloudCheck size={16}/>{!storageAvailable?'Not saved: storage unavailable':saved?'All changes saved':'Saving your story...'}</span><span className="topbar-divider"/><button className="guide-button" onClick={()=>setDialog('guide')}><BookOpen size={17}/><span>Quick guide</span></button><a className="icon-button github-button" href="https://github.com/yogendra-yatnalkar/storyboard-ai" target="_blank" rel="noreferrer" aria-label="View the original inspiration on GitHub" title="Project inspiration on GitHub"><Github size={19}/></a></div></header>
      <main className="main-content">
        {page==='studio' ? <motion.div initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} transition={{duration:reducedMotion?0:.45}}>
          <div className="page-heading"><div><h1>A little script. A big story.<span className="heading-spark"><svg viewBox="0 0 35 38" fill="none"><path d="M8 27L5 18M16 19L18 6M24 24L33 16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></svg></span></h1><p>Bring your ideas to life, one hand-drawn scene at a time.</p></div><button className="primary-button export-top" onClick={openExport}><ArrowDownToLine size={17}/><span>Export video</span></button></div>
          <div className="workflow-tabs" role="tablist" aria-label="Studio workflow">{([{id:'script',label:'Your script'},{id:'storyboard',label:'Storyboard'},{id:'style',label:'Make it yours'}] as const).map((item,i)=><div className="workflow-step" key={item.id}><button role="tab" aria-selected={step===item.id} aria-controls="studio-editor" className={step===item.id?'selected':''} onClick={()=>setStep(item.id)}><span className="step-number">0{i+1}</span>{item.label}</button>{i<2 && <span className="step-connector"/>}</div>)}<span className="workflow-aside"><ShieldCheck size={14}/>No API keys. No limits on ideas.</span></div>
          <div className="studio-grid">
            <section id="studio-editor" className="editor-panel" aria-label={step==='script'?'Script editor':step==='style'?'Animation style':'Scene editor'}>
              {step==='script' && <><div className="panel-title-row"><h2><FilePenLine size={18}/>Start with your words</h2><button className="icon-button" title="Import text or JSON" aria-label="Import text or JSON" onClick={()=>uploadRef.current?.click()}><Upload size={16}/></button></div><p className="panel-description">What would you like to explain?</p><div className="input-tabs" role="tablist" aria-label="Script format"><button role="tab" aria-selected={mode==='text'} className={mode==='text'?'active':''} onClick={()=>{setMode('text');setError('');}}><FileText size={14}/>Plain text</button><button role="tab" aria-selected={mode==='json'} className={mode==='json'?'active':''} onClick={()=>{if(mode!=='json')setJsonText(JSON.stringify(scriptJson(project),null,2));setMode('json');setError('');}}><Code2 size={16}/>Structured JSON</button></div><div className={`script-input-wrap ${error?'input-error':''}`}><textarea aria-label={mode==='text'?'Your explanatory script':'Structured JSON script'} className={`script-input ${mode==='json'?'json-input':''}`} placeholder={mode==='text'?'Every great explanation begins with a few words. Add your script here...':'{"title": "My story", "scenes": [{"text": "Your narration", "primary_visual": "leaf"}]}'} value={mode==='text'?project.script:jsonText} maxLength={30000} spellCheck={mode==='text'} onChange={e=>{mode==='text'?setProject(p=>({...p,script:e.target.value})):setJsonText(e.target.value);setError('');}}/><div className="script-meta"><span>{mode==='text'?`${wordCount} words`:'JSON scene control'}</span><span><Clock3 size={12}/>{mode==='text'?`~${formatTime(Math.max(0,Math.ceil(wordCount/2.1)))} min`:`${project.scenes.length} scenes`}</span></div></div>{error && <p className="inline-error" role="alert">{error}</p>}<div className="script-hint"><Sparkles size={13}/><span>A new paragraph makes a new scene.</span><button onClick={()=>navigate('templates')}>Try an example <ArrowUpRight size={12}/></button></div><div className="narration-block"><div className="narration-heading"><label><Mic size={15}/>Narration</label><Toggle checked={project.settings.narration} onChange={()=>updateSettings({narration:!project.settings.narration})} label="Enable narration"/></div><div className="voice-settings"><label className="select-with-icon"><Globe2 size={15}/><select aria-label="Narration language" value={project.settings.language} onChange={e=>updateSettings({language:e.target.value as 'en'|'hi'})}><option value="en">English (US)</option><option value="hi">Hindi (India)</option></select><ChevronDown size={12}/></label><button className="voice-preview" onClick={previewVoice} title="Preview your installed system voice"><Volume2 size={15}/><span>System voice</span><Play size={11}/></button></div></div><div className="editor-bottom"><button className="primary-button generate-button" disabled={generating} onClick={()=>void generate()}>{generating?<LoaderCircle className="spin" size={17}/>:<WandSparkles size={17}/>}<span>{generating?'Finding your story...':'Generate storyboard'}</span><ArrowRight size={17}/></button><p className="privacy-caption"><LockKeyhole size={11}/>Your words stay on your device.</p></div></>}
              {step==='storyboard' && <><div className="panel-title-row"><h2><Clapperboard size={18}/>Shape your scene</h2><span className="subtle-count">{project.scenes.length?activeIndex+1:0} / {project.scenes.length}</span></div><p className="panel-description">The details make the difference.</p>{activeScene ? <div className="scene-editor-fields"><label className="field-label">Scene heading<input value={activeScene.title} maxLength={100} onChange={e=>updateScene({title:e.target.value})}/></label><label className="field-label">Narration<textarea rows={4} value={activeScene.text} maxLength={2000} onChange={e=>updateScene({text:e.target.value})}/></label><div className="field-row"><label className="field-label">Illustration<select value={activeScene.visual} onChange={e=>updateScene({visual:e.target.value as Visual,primaryVisual:undefined})}>{Object.entries(visualNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label className="field-label duration-field">Duration (sec)<input type="number" min={2} max={120} value={activeScene.duration} onChange={e=>{const n=Number(e.target.value);if(n>=2 && n<=120)updateScene({duration:n});}}/></label></div><label className="field-label">Composition<select value={activeScene.layout} onChange={e=>updateScene({layout:e.target.value as Scene['layout']})}><option value="centered_illustration_with_heading">Centered illustration + heading</option><option value="illustration_left">Left-aligned illustration</option></select></label><div className="scene-actions"><button className="secondary-button" disabled={project.scenes.length>=40} onClick={()=>{const next=[...project.scenes];next.splice(activeIndex+1,0,{...activeScene,id:uid()});setProject(p=>({...p,scenes:next}));setSelected(activeIndex+1);setStarted(false);notify('Scene duplicated.');}}><Copy size={14}/>Duplicate</button><button className="icon-button" title="Move scene earlier" aria-label="Move scene earlier" disabled={activeIndex===0} onClick={()=>reorderScene(activeIndex,activeIndex-1)}><ArrowUp size={16}/></button><button className="icon-button" title="Move scene later" aria-label="Move scene later" disabled={activeIndex===project.scenes.length-1} onClick={()=>reorderScene(activeIndex,activeIndex+1)}><ArrowDown size={16}/></button><button className="icon-button danger" title="Delete scene" aria-label="Delete scene" onClick={()=>setDialog('delete')}><Trash2 size={16}/></button></div><p className="editor-tip"><GripVertical size={15}/>Reorder scenes below, or use the arrows.</p></div> : <div className="editor-empty"><Clapperboard size={30}/><p>Your storyboard is a blank slate.</p><button className="secondary-button" onClick={addScene}><Plus size={15}/>Add your first scene</button></div>}</>}
              {step==='style' && <><div className="panel-title-row"><h2><Palette size={18}/>A style of your own</h2><button className="icon-button" aria-label="Reset style" title="Reset style" onClick={()=>{updateSettings({...defaultSettings});notify('Back to the original Scribble style.');}}><RotateCcw size={15}/></button></div><p className="panel-description">Hand-drawn. Never one-size-fits-all.</p><div className="style-fields"><label className="field-label">A little color</label><div className="color-options">{['#648650','#7194ad','#ba885e','#a17799','#434b42'].map(color=><button key={color} style={{background:color}} className={`color-swatch ${project.settings.color===color?'selected':''}`} aria-label={`Use ${color} accent`} aria-pressed={project.settings.color===color} onClick={()=>updateSettings({color})}>{project.settings.color===color&&<Check size={17}/>}</button>)}<label className="custom-color" title="Choose your own accent"><Plus size={17}/><input type="color" aria-label="Custom accent color" value={project.settings.color} onChange={e=>updateSettings({color:e.target.value})}/></label></div><label className="field-label">Your blank canvas</label><div className="paper-options">{[{color:'#fcfbf5',label:'Warm paper'},{color:'#ffffff',label:'Pure white'},{color:'#f0f3ed',label:'Soft sage'}].map(p=><button key={p.color} style={{background:p.color}} className={project.settings.paper===p.color?'selected':''} onClick={()=>updateSettings({paper:p.color})}>{p.label}{project.settings.paper===p.color&&<Check size={13}/>}</button>)}</div><div className="setting-toggle-row"><div><PenLine size={17}/><span><strong>Show the drawing hand</strong><small>A human touch, stroke by stroke.</small></span></div><Toggle label="Show drawing hand" checked={project.settings.hand} onChange={()=>updateSettings({hand:!project.settings.hand})}/></div><div className="setting-toggle-row"><div><Paintbrush size={17}/><span><strong>Hand-colored fills</strong><small>Bring depth with soft hatching.</small></span></div><Toggle label="Enable color hatching" checked={project.settings.hatching} onChange={()=>updateSettings({hatching:!project.settings.hatching})}/></div><div className="setting-toggle-row"><div><Monitor size={17}/><span><strong>Smooth camera</strong><small>Let one scene flow into the next.</small></span></div><Toggle label="Enable camera movements" checked={project.settings.camera} onChange={()=>updateSettings({camera:!project.settings.camera})}/></div><label className="field-label speed-label">Narration pace <span>{project.settings.rate.toFixed(1)}x</span><input type="range" min="0.7" max="1.4" step="0.1" value={project.settings.rate} onChange={e=>updateSettings({rate:Number(e.target.value)})}/></label></div></>}
            </section>
            <section className="preview-panel" aria-label="Whiteboard video preview"><div className="preview-toolbar"><h2><span className="live-dot"/>Your story, taking shape</h2><div><span className="aspect-label"><Monitor size={14}/>16:9</span><span className="preview-toolbar-divider"/><button className="icon-button" title="Expand preview" aria-label="Expand preview" onClick={()=>setDialog('fullscreen')}><Expand size={16}/></button></div></div><div className="preview-surface">{activeScene ? <motion.div key={activeScene.id} initial={reducedMotion||!project.settings.camera?false:{opacity:.6,x:18}} animate={{opacity:1,x:0}} transition={{duration:.55,ease:[.22,1,.36,1]}}><BoardPreview scene={activeScene} settings={project.settings} progress={progress} playing={playing}/></motion.div> : emptyBoard}</div><div className="playback-controls"><button className="play-button" aria-label={playing?'Pause preview':'Play preview'} onClick={play}>{playing?<Pause size={16} fill="currentColor"/>:<Play size={16} fill="currentColor"/>}</button><button className="icon-button restart-button" title="Restart preview" aria-label="Restart preview" onClick={()=>{setCurrentTime(0);setSelected(0);setStarted(true);setPlaying(false);}}><SkipBack size={15}/></button><span className="playback-time">{formatTime(currentTime)} <span>/ {formatTime(totalDuration)}</span></span><input aria-label="Video playhead" className="timeline-scrubber" type="range" min="0" max={totalDuration||1} step="0.05" value={currentTime} style={{'--progress':`${totalDuration?currentTime/totalDuration*100:0}%`} as CSSProperties} onChange={e=>{const t=Number(e.target.value);setCurrentTime(t);setStarted(true);let offset=0,index=0;for(let i=0;i<project.scenes.length;i++){if(t<offset+project.scenes[i].duration||i===project.scenes.length-1){index=i;break;}offset+=project.scenes[i].duration;}setSelected(index);setPlaying(false);}}/><button className="icon-button" aria-label={muted?'Unmute narration':'Mute narration'} title={muted?'Unmute narration':'Mute narration'} onClick={()=>setMuted(!muted)}>{muted?<VolumeX size={17}/>:<Volume2 size={17}/>}</button><button className="playback-speed" title="Change playback narration pace" onClick={()=>{const rates=[.8,1,1.2];const index=rates.indexOf(project.settings.rate);updateSettings({rate:rates[(index+1)%rates.length]});}}>{project.settings.rate}x</button></div><div className="preview-caption"><span><Layers3 size={12}/>{activeScene?`Scene ${String(activeIndex+1).padStart(2,'0')} of ${String(project.scenes.length).padStart(2,'0')}`:'Your canvas is ready'}</span><span>Little lines. Lasting impressions.</span></div></section>
          </div>
          <section className="storyboard-section" aria-label="Scene timeline"><div className="storyboard-heading"><div><h2>The storyboard</h2><span className="scene-count">{project.scenes.length} scenes</span></div><div><span className="drag-hint"><GripVertical size={13}/>Drag to reorder</span><button className="text-button add-scene" onClick={addScene}><Plus size={15}/>Add scene</button></div></div><div className={`scene-strip ${project.scenes.length>4?'scene-strip-scroll':''}`}>{project.scenes.map((scene,index)=><button key={scene.id} className={`scene-tile ${activeIndex===index?'selected':''}`} onClick={()=>{goToScene(index);if(step==='script')setStep('storyboard');}} draggable onDragStart={e=>{dragId.current=scene.id;e.dataTransfer.setData('text/plain',scene.id);e.dataTransfer.effectAllowed='move';}} onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect='move';}} onDrop={e=>{e.preventDefault();const id=e.dataTransfer.getData('text/plain')||dragId.current;const from=project.scenes.findIndex(s=>s.id===id);if(from>=0)reorderScene(from,index);dragId.current=null;}} onDragEnd={()=>{dragId.current=null;}} aria-label={`Edit scene ${index+1}: ${scene.title}`} aria-pressed={activeIndex===index}><div className="scene-thumbnail"><BoardPreview scene={scene} settings={project.settings} thumbnail/><span className="scene-number">{String(index+1).padStart(2,'0')}</span><span className="scene-duration">{scene.duration}s</span>{activeIndex===index&&<span className="scene-selected-check"><Check size={10}/></span>}</div><div className="scene-tile-name"><span>{scene.title.replace(/\.$/,'')}</span><MoreHorizontal size={15}/></div></button>)}{!project.scenes.length && <button className="empty-timeline" onClick={addScene}><Plus size={21}/><span>Your first scene starts here.</span></button>}</div></section><footer className="studio-footer"><span><LockKeyhole size={12}/>Local-first. LLM-free. All yours.</span><span>Made for the way you explain things.<Leaf size={13}/></span></footer>
        </motion.div> : <motion.div key={page} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.3}}>
          <div className="page-heading"><div><h1>{page==='projects'?'Good stories live here.':page==='library'?'A picture is worth a few words.':'A little inspiration goes a long way.'}</h1><p>{page==='projects'?'Your ideas, saved right here on this device.':page==='library'?'Thoughtful line art, ready for your next explanation.':'A starting point for your story. Make every line your own.'}</p></div>{page==='projects'&&<button className="primary-button" onClick={()=>{setNameInput('');setDialog('new');}}><Plus size={16}/>New project</button>}</div><div className="collection-toolbar"><label className="search-input"><Search size={17}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={page==='projects'?'Find a story...':page==='library'?'Find an illustration...':'Find some inspiration...'} aria-label={`Search ${page}`}/>{query&&<button className="icon-button" aria-label="Clear search" onClick={()=>setQuery('')}><X size={13}/></button>}</label><span>{page==='projects'?`${projects.length} saved ${projects.length===1?'story':'stories'}`:page==='library'?'Original, multi-layered vector artwork':'Made to be made your own'}</span>{page==='projects'&&<button className="secondary-button" onClick={()=>uploadRef.current?.click()}><Upload size={15}/>Import script</button>}</div>
          {page==='projects' && <div className="project-collection">{projects.filter(p=>p.title.toLowerCase().includes(query.toLowerCase())).map(p=><article className="project-item" key={p.id}><button className="project-open" onClick={()=>{setProject(p);resetPlayback();setStep('script');setMode('text');navigate('studio');}}>{p.scenes[0]?<BoardPreview scene={p.scenes[0]} settings={p.settings} thumbnail/>:<div className="project-empty-art"><PenLine size={38}/></div>}<div className="project-item-title"><h3>{p.title}</h3><ArrowUpRight size={18}/></div><p>{p.scenes.length} scenes <span/> {formatTime(p.scenes.reduce((n,s)=>n+s.duration,0))} <span/> {new Date(p.updatedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</p></button><button className="project-download icon-button" title="Download project JSON" aria-label={`Download ${p.title} as JSON`} onClick={()=>downloadProject(p)}><Download size={16}/></button></article>)}</div>}
          {page==='templates' && <div className="template-collection">{templates.map((template,index)=>({...template,index})).filter(t=>`${t.title} ${t.category}`.toLowerCase().includes(query.toLowerCase())).map(template=><button key={template.title} className="template-item" onClick={()=>useTemplate(template.index)}><BoardPreview scene={{id:template.title,title:template.title,text:template.description,visual:template.visual,duration:8,layout:'centered_illustration_with_heading'}} settings={defaultSettings} thumbnail/><div className="template-info"><span className="template-category">{template.category}</span><h3>{template.title}<ArrowUpRight size={18}/></h3><p>{template.description}</p><span className="template-use">Make it your own <ArrowRight size={14}/></span></div></button>)}</div>}
          {page==='library' && <><div className="library-collection">{Object.entries(visualNames).filter(([,name])=>name.toLowerCase().includes(query.toLowerCase())).map(([visual,name])=><button className="library-item" key={visual} onClick={()=>{if(!activeScene){const s:Scene={id:uid(),title:name,text:`Explain ${name.toLowerCase()} in your own words.`,visual:visual as Visual,duration:8,layout:'centered_illustration_with_heading'};setProject(p=>({...p,scenes:[...p.scenes,s]}));setSelected(project.scenes.length);}else updateScene({visual:visual as Visual,primaryVisual:undefined});setPlaying(false);setStarted(false);setStep('storyboard');navigate('studio');notify(`${name} added to your scene.`);}}><BoardPreview scene={{id:visual,title:name,text:name,visual:visual as Visual,duration:8,layout:'centered_illustration_with_heading'}} settings={project.settings} thumbnail/><div><h3>{name}</h3><Plus size={17}/></div><span>Outline + detail + color</span></button>)}</div><div className="library-footnote"><Layers3 size={19}/><div><strong>Looking for something more specific?</strong><p>The Python engine also fetches Lucide, Tabler, and Phosphor vectors. Add a custom SVG for detailed subjects.</p></div><button className="text-button" onClick={()=>setDialog('guide')}>See how <ArrowUpRight size={14}/></button></div></>}
          {query && ((page==='projects'&&!projects.some(p=>p.title.toLowerCase().includes(query.toLowerCase())))||(page==='library'&&!Object.values(visualNames).some(n=>n.toLowerCase().includes(query.toLowerCase())))||(page==='templates'&&!templates.some(t=>`${t.title} ${t.category}`.toLowerCase().includes(query.toLowerCase()))))&&<div className="no-results"><Search size={31}/><h3>No matches, yet.</h3><p>Try a different word. There is plenty to explore.</p><button className="secondary-button" onClick={()=>setQuery('')}>Clear search</button></div>}
        </motion.div>}
      </main>
    </div>
    <AnimatePresence>
      {toast&&<motion.div className="toast" role="status" initial={{opacity:0,y:20}} animate={{opacity:1,y:0}} exit={{opacity:0,y:8}}><span className="toast-check"><Check size={14}/></span><span>{toast}</span><button aria-label="Dismiss notification" onClick={()=>setToast('')}><X size={15}/></button></motion.div>}
      {(dialog==='new'||dialog==='rename')&&<Modal title={dialog==='new'?'Every story starts somewhere.':'Give your story a name.'} onClose={closeDialog}><p className="modal-intro">{dialog==='new'?'A fresh canvas for your next big idea.':'Something simple. Something that feels like you.'}</p><form onSubmit={e=>{e.preventDefault();if(!nameInput.trim())return;if(dialog==='new'){setProject(newProject(nameInput.trim()));resetPlayback();setStep('script');setMode('text');navigate('studio');}else setProject(p=>({...p,title:nameInput.trim()}));setDialog(null);}}><label className="field-label">Project name<input autoFocus value={nameInput} onChange={e=>setNameInput(e.target.value)} placeholder="My next big idea" maxLength={100} required/></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" type="submit" disabled={!nameInput.trim()}>{dialog==='new'?'Create project':'Save name'}<ArrowRight size={15}/></button></div></form></Modal>}
      {dialog==='delete'&&<Modal title="Let this scene go?" onClose={closeDialog}><p className="modal-intro">Scene {activeIndex+1}, "{activeScene?.title}", will be removed from this story.</p><div className="modal-actions"><button className="secondary-button" onClick={closeDialog}>Keep scene</button><button className="danger-button" onClick={()=>{setProject(p=>({...p,scenes:p.scenes.filter((_,i)=>i!==activeIndex)}));setSelected(Math.max(0,activeIndex-1));setStarted(false);setCurrentTime(0);setPlaying(false);setDialog(null);notify('Scene removed.');}}><Trash2 size={15}/>Remove scene</button></div></Modal>}
      {dialog==='fullscreen'&&<Modal title={project.title} wide onClose={closeDialog}><div className="fullscreen-board">{activeScene?<BoardPreview scene={activeScene} settings={project.settings} progress={progress} playing={playing}/>:emptyBoard}</div><div className="fullscreen-controls"><button className="primary-button" onClick={play}>{playing?<Pause size={16}/>:<Play size={16}/>} {playing?'Pause':'Play story'}</button><span>{formatTime(currentTime)} / {formatTime(totalDuration)}</span><button className="text-button" onClick={()=>{setCurrentTime(0);setSelected(0);setStarted(true);setPlaying(false);}}><RotateCcw size={15}/>Start over</button></div></Modal>}
      {dialog==='export'&&<Modal title="Let your story out into the world." onClose={closeDialog}><p className="modal-intro">A few little lines. Ready to make a big impression.</p><div className="export-project-summary">{activeScene&&<BoardPreview scene={activeScene} settings={project.settings} thumbnail/>}<div><h3>{project.title}</h3><p>{project.scenes.length} scenes <span/> {formatTime(totalDuration)} <span/> 16:9</p></div></div><div className="export-format-options"><button disabled={exportBusy} className={exportMode==='browser'?'selected':''} onClick={()=>{setExportMode('browser');setExportComplete(false);setExportError('');}}><Monitor size={22}/><strong>Browser video</strong><span>{videoFormat?`.${videoFormat.extension} preview`:'Not supported here'}</span>{exportMode==='browser'&&<Check size={14}/>}</button><button disabled={exportBusy} className={exportMode==='python'?'selected':''} onClick={()=>{setExportMode('python');setExportComplete(false);setExportError('');}}><Terminal size={22}/><strong>Python HD render</strong><span>MP4 + synced narration</span>{exportMode==='python'&&<Check size={14}/>}</button></div><label className="field-label export-resolution">Resolution<select disabled={exportBusy} value={project.settings.resolution} onChange={e=>updateSettings({resolution:e.target.value as '1080'|'720'})}><option value="1080">1080p Full HD (1920 x 1080)</option><option value="720">720p HD (1280 x 720)</option></select></label><div className="export-note"><CircleHelp size={16}/><p>{exportMode==='browser'?'A silent, animated preview recorded on your device. For synchronized voiceover, use the Python HD render. Keep this tab open while exporting.':engineConnected?'Your local Python engine will render the complete MP4 with installed offline narration. No script is sent to an external service.':'Download the complete Python engine with this story included. Run the setup and render commands on your machine to create a narrated HD MP4.'}</p></div>{exportMode==='python'&&!engineConnected&&<div className="code-block compact-code"><code>python setup_engine.py<br/>python run_studio.py --json story.json --offline</code><button className="icon-button" title="Copy render commands" aria-label="Copy render commands" onClick={()=>void copyCommand('python setup_engine.py\npython run_studio.py --json story.json --offline')}><Copy size={15}/></button></div>}{exportBusy&&<div className="export-progress" role="status"><div><LoaderCircle size={16} className="spin"/><span>{exportMessage}</span><strong>{Math.round(exportProgress*100)}%</strong></div><div className="progress-track"><span style={{width:`${exportProgress*100}%`}}/></div></div>}{exportError&&<p className="inline-error" role="alert">{exportError}</p>}{exportComplete&&<div className="export-success"><CheckCheck size={18}/>{exportMode==='python'&&!engineConnected?'Your render kit is in your downloads.':'Your story is in your downloads. Nicely done.'}</div>}<button className="primary-button export-confirm" disabled={exportBusy||(exportMode==='browser'&&!videoFormat)} onClick={()=>void runExport()}>{exportBusy?<LoaderCircle className="spin" size={17}/>:<Download size={17}/>}<span>{exportBusy?'Bringing your story to life...':exportMode==='python'&&!engineConnected?'Download Python render kit':exportMode==='python'?'Render narrated MP4':`Export ${videoFormat?.extension.toUpperCase()||'browser'} preview`}</span></button><div className="export-bottom"><button className="text-button" disabled={exportBusy} onClick={()=>downloadProject(project)}><FileJson size={14}/>Just the script</button>{exportBusy?<button className="text-button danger" onClick={()=>exportAbort.current?.abort()}>Cancel export</button>:<span><LockKeyhole size={12}/>No watermarks. No strings.</span>}</div></Modal>}
      {dialog==='guide'&&<Modal title="A little guidance. A lot of possibility." wide onClose={closeDialog}><div className="guide-layout"><div><p className="modal-intro">Your words, turned into something worth watching.</p><div className="guide-step"><span>01</span><div><h3>Start with what you know.</h3><p>Paste your explanation, or import a text or JSON script. Separate paragraphs become separate scenes. The browser uses local rules; connect Python for spaCy subject, verb, and location analysis.</p></div></div><div className="guide-step"><span>02</span><div><h3>Give it a little character.</h3><p>Choose illustrations, edit narration, reorder scenes, and add a touch of color. Preview actual outline, detail, and hatch strokes as the marker follows each path.</p></div></div><div className="guide-step"><span>03</span><div><h3>Take your story with you.</h3><p>Export a silent browser video or use the included Python engine for narrated HD MP4, continuous-board camera moves, and custom SVG illustrations.</p></div></div><div className="keyboard-hint"><Keyboard size={16}/><span><kbd>Space</kbd> Play / pause <kbd>?</kbd> Open this guide <kbd>Esc</kbd> Close dialog</span></div></div><div className="guide-python"><Terminal size={27}/><h3>Small engine. Big possibilities.</h3><p>100% free. No LLMs or API keys. After setup, use installed voices and cached artwork entirely offline.</p><div className="code-block"><code>python setup_engine.py<br/>python run_studio.py --json story.json --offline</code><button className="icon-button" title="Copy setup commands" aria-label="Copy setup commands" onClick={()=>void copyCommand('python setup_engine.py\npython run_studio.py --json story.json --offline')}><Copy size={15}/></button></div><button className="primary-button" onClick={()=>void downloadEngine(project).then(()=>notify('Python engine downloaded. Follow the included README.')).catch(err=>notify(err.message))}><Download size={16}/>Get the Python engine</button><p className="guide-fineprint">Requires Python 3.11+, FFmpeg, and a system voice. gTTS is optional, free, and keyless, but needs internet. Detailed custom subjects require supplied SVG artwork; icons cannot invent an illustration.</p><button className="text-button" onClick={()=>setDialog('settings')}>Connect your local engine <ArrowRight size={14}/></button></div></div></Modal>}
      {dialog==='settings'&&<Modal title="Your workspace. Your machine." onClose={closeDialog}><p className="modal-intro">Scribble saves projects in this browser. Connect the Python engine when you are ready for the full render.</p><div className="connection-status"><span className={`connection-dot ${engineConnected?'connected':''}`}/><span>{engineConnected?'Local Python engine connected':'Using the browser studio'}</span><ShieldCheck size={17}/></div><label className="field-label">Local engine address<input value={engineUrl} onChange={e=>{setEngineUrl(e.target.value);setEngineConnected(false);}} placeholder="http://127.0.0.1:8765"/></label><div className="code-block"><code>python serve_studio.py</code><button className="icon-button" title="Copy server command" aria-label="Copy server command" onClick={()=>void copyCommand('python serve_studio.py')}><Copy size={14}/></button></div><p className="settings-help">Start this command inside the downloaded engine folder. The server binds to your machine only. Run the web studio locally too if your browser blocks hosted-to-local connections.</p>{engineMessage&&<p className={engineConnected?'connection-message':'inline-error'} role="status">{engineMessage}</p>}<button className="primary-button full-width" disabled={connecting} onClick={()=>void connectEngine()}>{connecting?<LoaderCircle size={16} className="spin"/>:<Terminal size={16}/>} {connecting?'Connecting...':engineConnected?'Check connection':'Connect local engine'}</button><div className="settings-divider"/><button className="settings-link" onClick={()=>void downloadEngine(project).then(()=>notify('Your Python render kit is ready.')).catch(err=>notify(err.message))}><Download size={18}/><div><strong>Download the complete engine</strong><span>Source code, assets, tests, and your story.</span></div><ArrowUpRight size={17}/></button><button className="settings-link" onClick={()=>downloadProject(project)}><FileJson size={18}/><div><strong>Back up this project</strong><span>Keep a portable copy of your script and settings.</span></div><ArrowUpRight size={17}/></button><p className="settings-privacy"><LockKeyhole size={13}/>No accounts, tracking, or cloud storage.</p></Modal>}
    </AnimatePresence>
  </div>;
}
