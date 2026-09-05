# Scribble Studio

## Image and Audio Workflow

The studio now opens an image-to-video workspace. Upload your own picture and
audio, extract actual contours, preview the marker tracing with the audio, and
export an audio-backed browser video or a complete offline Python render kit.
The existing script workflow and saved projects remain available in the sidebar.

The standalone refactored Python project is in `image-whiteboard-builder/`:

```bash
cd image-whiteboard-builder
python setup_builder.py
python main.py --image input_diagram.png --audio narration.mp3 --output final_video.mp4
```

It uses sample-exact pydub analysis, OpenCV Canny contours, logical stroke sorting,
an aligned marker hand, and streamed FFmpeg H.264/AAC output. See
`image-whiteboard-builder/README.md` for setup, safety limits, timing guarantees,
and test instructions. Python dependency installation and execution are unavailable
in the current tool environment; the supplied installer and end-to-end tests have
not been run here. The browser production build is checked independently.

## Script Studio

A local-first whiteboard video studio built with React, TypeScript, Vite, and
Tailwind CSS, with a complete modular Python renderer in `whiteboard-engine/`.

The studio includes plain-text and JSON script input, editable and reorderable
scenes, original vector illustrations, stroke-by-stroke preview, an aligned marker
hand, configurable hatching/camera/color, local project storage, templates, language
controls, browser video recording, and downloadable Python render kits.

## Run the Web Studio

```bash
npm install
npm run dev
```

`src/App.tsx` is the entry component. Fonts and default artwork are bundled locally.
No remote AI, authentication, or paid service is used. Projects are saved to browser
localStorage; export JSON backups before clearing browser data.

## Render a Narrated HD MP4

See `whiteboard-engine/README.md` for system dependencies and full instructions.

```bash
cd whiteboard-engine
python setup_engine.py
python run_studio.py --json examples/rainwater.json --offline
```

Use `python serve_studio.py` to connect the frontend to the local Python engine.
The browser-only export is an animated silent preview, not falsely labeled as a
fully narrated render. Its MP4/WebM format depends on actual browser support.
The Python export path supplies the full HD H.264/AAC MP4 with synchronized audio.

## Verification

The Vite production build is checked with the provided build tool. Python unit and
real MP4 integration tests are included in `whiteboard-engine/tests/test_engine.py`.
The current tool environment does not expose Python execution; those tests must
be run on the target machine. Do not interpret included tests as an executed pass.

Scribble's original source is MIT-licensed. See `LICENSE.txt`, the engine's asset
license file, and `public/FONT-LICENSES.txt` for third-party attribution.