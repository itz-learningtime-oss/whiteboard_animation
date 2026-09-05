import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { boardMarkup } from '../lib/artwork';
import type { Scene, StudioSettings } from '../lib/project';
import handUrl from '../../whiteboard-engine/assets/hand_marker.png';

type Props = { scene: Scene; settings: StudioSettings; progress?: number; thumbnail?: boolean; playing?: boolean };

export default function BoardPreview({ scene, settings, progress = 1, thumbnail = false, playing = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const paths = useRef<{ element: SVGPathElement; length: number }[]>([]);
  const [tip, setTip] = useState({ x: 633, y: 364 });
  const markup = useMemo(() => boardMarkup(scene, settings, thumbnail), [scene.title, scene.visual, scene.layout, settings.color, settings.paper, settings.hatching, thumbnail]);

  useLayoutEffect(() => {
    if (!ref.current || thumbnail) return;
    paths.current = [...ref.current.querySelectorAll<SVGPathElement>('.art-stroke')].map(element => ({ element, length: element.getTotalLength() }));
  }, [markup, thumbnail]);

  useEffect(() => {
    if (thumbnail) return;
    const items = paths.current;
    const total = items.reduce((sum, item) => sum + item.length, 0);
    let remaining = total * Math.min(1, Math.max(0, progress));
    let active: { element: SVGPathElement; at: number } | undefined;
    for (const item of items) {
      const visible = Math.max(0, Math.min(remaining, item.length));
      item.element.style.strokeDasharray = `${item.length} ${item.length}`;
      item.element.style.strokeDashoffset = `${item.length - visible}`;
      item.element.style.visibility = visible > 0 ? 'visible' : 'hidden';
      if (remaining > 0 && remaining <= item.length) active = { element: item.element, at: remaining };
      remaining -= item.length;
    }
    if (active) {
      const point = active.element.getPointAtLength(active.at);
      if (scene.layout === 'illustration_left') setTip({ x: point.x*.85-73, y: point.y*.85+17 });
      else setTip({ x: point.x, y: point.y });
    } else if (progress >= 1) setTip({ x: 633, y: 364 });
  }, [progress, markup, thumbnail, scene.layout]);

  return <div className={`whiteboard ${thumbnail ? 'whiteboard-thumb' : ''}`} style={{ background: settings.paper }}>
    <div ref={ref} className="whiteboard-svg" dangerouslySetInnerHTML={{ __html: markup }} />
    {!thumbnail && settings.hand && <img
      className={`drawing-hand ${playing ? 'is-drawing' : ''}`}
      src={handUrl} alt="" aria-hidden="true" draggable={false}
      style={{ left: `${(tip.x-55)/9}%`, top: `${(tip.y-81)/5.06}%`, opacity: progress > 0.008 ? 1 : 0 }}
    />}
    {!thumbnail && <div className="paper-grain" aria-hidden="true" />}
  </div>;
}