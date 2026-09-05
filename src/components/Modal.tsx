import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

export default function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog=useRef<HTMLDivElement>(null);
  const closeRef=useRef(onClose); closeRef.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement | null;
    const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const timer=window.setTimeout(()=>{
      const target=dialog.current?.querySelector<HTMLElement>('input:not([type="hidden"]),textarea,select') || dialog.current?.querySelector<HTMLElement>('button,a[href]');
      target?.focus();
    },50);
    const key=(event: KeyboardEvent)=>{
      if (event.key==='Escape') closeRef.current();
      if(event.key==='Tab') {
        const nodes=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select,textarea,a[href],[tabindex="0"]') || [])];
        const first=nodes[0],last=nodes[nodes.length-1];
        if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    window.addEventListener('keydown',key);
    return()=>{window.clearTimeout(timer);document.body.style.overflow=overflow;window.removeEventListener('keydown',key);previous?.focus();};
  },[]);
  return createPortal(<motion.div className="modal-backdrop" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onMouseDown={e=>{if(e.target===e.currentTarget) onClose();}}>
    <motion.div ref={dialog} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide?'modal-wide':''}`} initial={{opacity:0,y:18,scale:.985}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:10}} transition={{duration:.2}}>
      <div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} title="Close dialog" aria-label="Close dialog"><X size={20}/></button></div>
      {children}
    </motion.div>
  </motion.div>,document.body);
}