import JSZip from 'jszip';
import { downloadBlob } from './export';
import { thresholds } from './imageSketch';
import type { SketchSettings } from './imageSketch';
import handUrl from '../../image-whiteboard-builder/assets/hand_marker.png';
import ignoreFile from '../../image-whiteboard-builder/.gitignore?raw';
import workflow from '../../image-whiteboard-builder/.github/workflows/test.yml?raw';

/**
 * Packages the complete offline Python whiteboard builder: all image(s),
 * audio, optional subtitles, the builder source tree, and a ready-run
 * render command.  When `images` has one entry the legacy `--image` flag
 * is used; with multiple images the `--image-dir` flag is used instead.
 */
export async function downloadSketchKit(
  images: File[],
  audio: File | undefined,
  settings: SketchSettings,
  subtitleFile?: File,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new DOMException('Download cancelled', 'AbortError');
  if (!images.length) throw new Error('Add at least one image before downloading the Python builder.');
  const zip = new JSZip();
  const files = import.meta.glob('../../image-whiteboard-builder/**/*.{py,txt,md,json}', { query: '?raw', import: 'default', eager: true });
  for (const [path, text] of Object.entries(files)) zip.file(path.replace('../../', ''), String(text));
  zip.file('image-whiteboard-builder/.gitignore', ignoreFile);
  zip.file('image-whiteboard-builder/.github/workflows/test.yml', workflow);
  const hand = await fetch(handUrl, { signal });
  if (!hand.ok) throw new Error('The marker asset could not be loaded. Please try again.');
  zip.file('image-whiteboard-builder/assets/hand_marker.png', await hand.blob());

  const audioName = audio ? `narration.${audio.name.split('.').pop()!.toLowerCase()}` : 'narration.mp3';
  if (audio) zip.file(`image-whiteboard-builder/${audioName}`, audio);

  /* --- Images --- */
  let imageArg: string;
  if (images.length === 1) {
    const imageName = `input_diagram.${images[0].name.split('.').pop()!.toLowerCase()}`;
    zip.file(`image-whiteboard-builder/${imageName}`, images[0]);
    imageArg = imageName;
  } else {
    const dir = zip.folder('image-whiteboard-builder/images');
    if (!dir) throw new Error('Could not create images directory in the render kit.');
    images.forEach((file, i) => {
      const ext = file.name.split('.').pop()!.toLowerCase();
      /* Zero-pad the index so 2.jpg sorts before 10.jpg in all shells. */
      const padded = String(i).padStart(String(images.length).length, '0');
      dir.file(`${padded}.${ext}`, file);
    });
    imageArg = 'images/';
  }

  /* --- Subtitles --- */
  let subtitleArg = '';
  if (subtitleFile) {
    const ext = subtitleFile.name.split('.').pop()!.toLowerCase();
    const subName = `subtitles.${ext}`;
    zip.file(`image-whiteboard-builder/${subName}`, subtitleFile);
    subtitleArg = ` --subtitles ${subName}`;
  }

  /* --- Render command --- */
  const [low, high] = thresholds[settings.detail];
  const command = `python main.py --image ${imageArg} --audio ${audioName} --output final_video.mp4 --width ${settings.resolution === '1080' ? 1920 : 1280} --height ${settings.resolution === '1080' ? 1080 : 720} --fps ${settings.fps} --sort ${settings.order} --canny-low ${low} --canny-high ${high} --color-mode ${settings.colorMode} --paper "${settings.paper}" --ink "${settings.ink}" --pen-width ${settings.penWidth}${settings.hand ? '' : ' --no-hand'} --save-sketch${subtitleArg}`;

  const summary = images.length === 1
    ? `Your image and audio are included.${subtitleFile ? ' A subtitle file is also included.' : ''} Nothing was uploaded.`
    : `${images.length} images and your audio are included.${subtitleFile ? ' A subtitle file is also included.' : ''} Nothing was uploaded.`;

  zip.file('image-whiteboard-builder/RENDER_MY_SKETCH.txt', `YOUR IMAGE. YOUR VOICE. YOUR WHITEBOARD.\n\n1. Install Python 3.11+ and FFmpeg (including FFprobe).\n2. Open a terminal in this extracted folder.\n3. Run: python setup_builder.py\n4. Run:\n${command}\n\n${audio ? summary + '\n' : 'Add your own images and audio before running the render command.\n'}\nFor verification: python -m unittest discover -s tests -v\n\nBrowser contours are a local JavaScript approximation. The Python renderer uses\nOpenCV, a higher processing resolution, and exact PCM sample timing. Results\nmay differ slightly from the browser preview. See README.md for details.\n`);

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  if (signal?.aborted) throw new DOMException('Download cancelled', 'AbortError');
  downloadBlob(blob, 'image-whiteboard-render-kit.zip');
}