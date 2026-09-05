import JSZip from 'jszip';
import { downloadBlob } from './export';
import { thresholds } from './imageSketch';
import type { SketchSettings } from './imageSketch';
import handUrl from '../../image-whiteboard-builder/assets/hand_marker.png';
import ignoreFile from '../../image-whiteboard-builder/.gitignore?raw';
import workflow from '../../image-whiteboard-builder/.github/workflows/test.yml?raw';

export async function downloadSketchKit(image: File | undefined, audio: File | undefined, settings: SketchSettings, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Download cancelled', 'AbortError');
  const zip = new JSZip();
  const files = import.meta.glob('../../image-whiteboard-builder/**/*.{py,txt,md,json}', { query: '?raw', import: 'default', eager: true });
  for (const [path, text] of Object.entries(files)) zip.file(path.replace('../../', ''), String(text));
  zip.file('image-whiteboard-builder/.gitignore', ignoreFile);
  zip.file('image-whiteboard-builder/.github/workflows/test.yml', workflow);
  const hand = await fetch(handUrl, { signal });
  if (!hand.ok) throw new Error('The marker asset could not be loaded. Please try again.');
  zip.file('image-whiteboard-builder/assets/hand_marker.png', await hand.blob());
  const imageName = image ? `input_image.${image.name.split('.').pop()!.toLowerCase()}` : 'input_diagram.png';
  const audioName = audio ? `narration.${audio.name.split('.').pop()!.toLowerCase()}` : 'narration.mp3';
  if (image) zip.file(`image-whiteboard-builder/${imageName}`, image);
  if (audio) zip.file(`image-whiteboard-builder/${audioName}`, audio);
  const [low, high] = thresholds[settings.detail];
  const command = `python main.py --image ${imageName} --audio ${audioName} --output final_video.mp4 --width ${settings.resolution === '1080' ? 1920 : 1280} --height ${settings.resolution === '1080' ? 1080 : 720} --fps ${settings.fps} --sort ${settings.order} --canny-low ${low} --canny-high ${high} --paper "${settings.paper}" --ink "${settings.ink}" --pen-width ${settings.penWidth}${settings.hand ? '' : ' --no-hand'} --save-sketch`;
  zip.file('image-whiteboard-builder/RENDER_MY_SKETCH.txt', `YOUR IMAGE. YOUR VOICE. YOUR WHITEBOARD.\n\n1. Install Python 3.11+ and FFmpeg (including FFprobe).\n2. Open a terminal in this extracted folder.\n3. Run: python setup_builder.py\n4. Run:\n${command}\n\n${image && audio ? 'Your original image and audio are included. Nothing was uploaded.\n' : 'Add your own image and audio before running the render command.\n'}\nFor verification: python -m unittest discover -s tests -v\n\nBrowser contours are a local JavaScript approximation. The Python renderer uses\nOpenCV, a higher processing resolution, and exact PCM sample timing. Results\nmay differ slightly from the browser preview. See README.md for details.\n`);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  if (signal?.aborted) throw new DOMException('Download cancelled', 'AbortError');
  downloadBlob(blob, 'image-whiteboard-render-kit.zip');
}