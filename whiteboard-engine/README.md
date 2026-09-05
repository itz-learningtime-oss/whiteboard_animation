# Scribble Whiteboard Engine

A free, open-source Python engine for layered educational whiteboard videos.
Write a script, choose illustrations, and render a narrated H.264/AAC MP4 with
real path tracing, clipped color hatching, and a continuous moving canvas.

Inspired by the pipeline idea in
[storyboard-ai](https://github.com/yogendra-yatnalkar/storyboard-ai), but this is
a separate, deterministic implementation. It does not use that project's Gemini,
image-generation, agent, or SAM dependencies. No LLM, AI service, account, payment,
GPU, or API key is needed to run this engine.

## What Is Actually Offline?

- Script parsing uses the installed spaCy `en_core_web_sm` model locally.
- Default narration uses installed system voices or eSpeak NG, locally.
- Eight original multi-layered illustrations and document/help/droplet SVGs are bundled.
- `--offline` prevents network asset fetching and rejects the online `gtts` backend.
- Iconify fetching and optional gTTS require internet. Keyless does not mean offline.
- Initial dependency, model, and font setup requires internet, unless those files are provisioned manually.

This engine animates existing vector artwork. It cannot invent accurate complex
illustrations from arbitrary prose. For specific people, cultural subjects,
detailed machinery, or scientific diagrams, provide a licensed custom SVG.
The Mahashivratri example intentionally requires `shiva_parvati_lineart.svg`.

## Quick Start

Use Python 3.11 or 3.12 and install FFmpeg, including FFprobe. On Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install ffmpeg espeak-ng libespeak1 libcairo2 libraqm0 fonts-dejavu-core
cd whiteboard-engine
python -m venv .venv
source .venv/bin/activate
python setup_engine.py
python run_studio.py --json examples/rainwater.json --offline
```

On Windows, activate with `.venv\Scripts\activate` and install FFmpeg with its
`bin` directory on PATH. Windows SAPI5 voices are accessed through pyttsx3.
On macOS, install FFmpeg and Cairo with your package manager and use an installed
macOS voice or eSpeak NG. Voice quality depends on the installed voice. eSpeak
is reliable and offline, but should not be mistaken for a studio-quality neural
voice. pyttsx3 drivers must support file export on your platform.

`setup_engine.py` installs `requirements.txt`, automatically downloads the spaCy
model if missing, obtains open fonts with their licenses, removes the marker
image's white matte, and checks FFmpeg. It never installs system packages with
elevated privileges. A reported missing system dependency needs to be installed
by you. Setup can be safely rerun.

The default output is `output_hd_explainer.mp4`. A neighboring
`output_hd_explainer.manifest.json` records actual timings, source licenses,
fallback usage, drawing-layer counts, and encoder dimensions.

## CLI Examples

```bash
# Raw text: spaCy detects sentence boundaries and subject nouns.
python run_studio.py --text "Rainwater harvesting collects water for agriculture. Trucks move goods to market."

# Completely offline after initial setup, including narration.
python run_studio.py --json examples/rainwater.json --offline --tts local

# Hindi: installed Hindi voice and Noto Sans Devanagari font required.
python run_studio.py --json examples/hindi.json --lang hi --offline

# Online, free, keyless Google narration. This explicitly sends text to Google.
python run_studio.py --json examples/rainwater.json --tts gtts --lang en

# Fast local visual smoke test.
python run_studio.py --json examples/rainwater.json --offline --tts none \
  --width 640 --height 360 --fps 24 --preset ultrafast --output smoke.mp4

# Structured script validation, with no rendering or network calls.
python run_studio.py --json examples/rainwater.json --dry-run

# Require an accurate custom cultural illustration, not a generic substitution.
python run_studio.py --json examples/custom-illustration.json --offline --strict-assets

# Appearance and performance controls.
python run_studio.py --json examples/rainwater.json --accent '#7194ad' \
  --paper '#ffffff' --no-hand --no-camera --no-hatching --crf 20 --preset fast
```

Blank lines in raw text create explicit scenes. Without blank lines, spaCy splits
sentences. Subjects prioritize syntactic subjects, then other nouns; actions use
verb lemmas; locations combine named entities and locative prepositional objects.
An explicit `--allow-rule-fallback` permits basic sentence splitting when the
English model is missing. This fallback is reported and is not mislabeled as
full NLP. Hindi raw-text segmentation is rule-based because the requested English
model is not a Hindi dependency parser; structured visual control is recommended.

## Structured Input

```json
{
  "title": "Water Harvesting",
  "settings": {
    "language": "en",
    "resolution": "1080",
    "color": "#648650",
    "paper": "#fcfbf5",
    "hand": true,
    "hatching": true,
    "camera": true,
    "narration": true,
    "rate": 1
  },
  "scenes": [
    {
      "text": "Khadin captures run-off water in farmland.",
      "heading": "Every drop counts.",
      "primary_visual": "rainwater",
      "layout": "centered_illustration_with_heading",
      "duration": 7,
      "camera": "auto"
    },
    {
      "text": "Vehicles transport crops from fields.",
      "heading": "From farm to market.",
      "primary_visual": "truck",
      "layout": "illustration_left",
      "camera": "pan_right"
    }
  ]
}
```

`icon` is accepted as an alias for `primary_visual`. Scene `title` is accepted as
an alias for `heading`. `duration` is a requested minimum, never an instruction
to truncate speech. Actual duration extends to include narration, camera lead-in,
and a final reading pause. All durations are quantized to whole video frames.
Captions are laid out and paginated by the scene timeline; individual word-level
forced alignment is not claimed.

Supported camera values are `auto`, `pan_right`, `pan_down`, `zoom_in`, `zoom_out`,
and `none`. Layouts are centered-illustration-with-heading and illustration-left.
The board starts at (0, 0), moves to (1920, 0) at Full HD, then follows a serpentine
grid by default. Explicit pan directions place the next tile accordingly. Four
default scenes occupy a 3840x2160 virtual board. Only visible tiles are loaded;
the engine does not allocate a huge video-sized canvas for every frame.

## Vector Sources and Safety

Resolution order is local custom SVG, bundled illustration, named fallback,
validated cache, explicitly registered provider URL, Iconify, then the reported
`file-text` fallback. `--strict-assets` turns missing artwork into an actionable
error. Cached SVG metadata records origin, license, and SHA-256.

Supported Iconify prefixes are Lucide, Tabler, and Phosphor. The documented URL
form is `https://api.iconify.design/lucide/droplet.svg?color=%23343c32`.
Stroke widths are normalized in our renderer; `stroke-width` is not a supported
Iconify SVG query parameter. Phosphor uses its light variant when appropriate.
These APIs provide icons, not automatically detailed illustrations of any topic.

For SVG Repo or Public Domain Vectors, download a properly licensed SVG into
`assets/custom/`, or register a direct SVG HTTPS URL and verified license:

```json
{
  "my-diagram": {
    "url": "https://www.svgrepo.com/path-to-a-verified-direct-download.svg",
    "license": "The exact license you verified on the asset page"
  }
}
```

That URL is an example format, not a promised provider endpoint. There is no
invented SVG Repo search API. Remote hosts are allowlisted, redirects disabled,
responses capped at 2 MB, requests timed out and retried, and SVG XML parsed with
defusedxml. Custom scripts, event handlers, network references, filters, CSS,
raster images, and unresolved clones are rejected. Flatten complex assets to
passive paths in an SVG editor first. See `assets/custom/README.md`.

Paths, cubic/quadratic Beziers, arcs, lines, polygons, polylines, rectangles,
circles, ellipses, group inheritance, and nested affine transforms are supported.
The engine samples paths into arc-length-measured strokes, traces outlines first,
adds finer detail second, then draws clipped hatch strokes. Even-odd and non-zero
winding scans preserve concavities and holes. Disconnected intervals require a
pen lift; they are never joined with a visible diagonal outside the fill region.

Use `data-layer="outline|detail|hatch"` and `data-hatch="true|false"` for exact
author control. Layer classification without metadata is a deterministic
geometry heuristic, not semantic understanding. Unusual SVG winding or dense
multi-object art may need manual layer annotations for the best result.

## Connect the Web Studio

```bash
python serve_studio.py
```

The optional FastAPI bridge binds only to `127.0.0.1:8765`. In the studio, open
Your Workspace, then Connect Local Engine. Running the frontend locally is the
most portable option; hosted sites may be blocked from local HTTP by browser
mixed-content or private-network policies. If needed, explicitly allow a trusted
hosted origin with `--allow-origin https://your-studio.example`.

- `GET /health`: installed dependency and readiness checks.
- `POST /parse`: local spaCy script analysis.
- `POST /render`: validate and queue a strictly offline render.
- `GET /jobs/{id}`: real render progress and errors.
- `DELETE /jobs/{id}`: cancel the worker and its renderer processes.
- `GET /jobs/{id}/download`: completed MP4 download.

The service allows three pending jobs, serializes rendering, enforces a 20-minute
requested-video limit and 30-minute worker limit, and removes expired job folders
on startup. It is a trusted single-user local service, not a public multi-tenant
production API. Do not bind it to a public interface without adding authentication,
rate limiting, isolated workers, and an appropriate deployment threat model.

The standalone browser preview uses bundled illustrations and deterministic
sentence/keyword rules, not spaCy running in JavaScript. It can export an animated,
silent MP4 or WebM depending on the browser's MediaRecorder support. Browser speech
preview uses available local system voices; that speech cannot be captured by the
canvas recorder. Browser recordings are limited to five minutes to bound encoder
memory; the Python renderer streams longer videos. Use Python for the narrated final deliverable. Browser estimates,
font sizing, and scene durations can differ from the audio-measured Python render.

## Tests and Verification

```bash
python -m unittest discover -s tests -v
```

The test suite checks JSON validation, optional full spaCy noun/verb extraction,
sentence segmentation, active-SVG rejection, entity protection, affine transforms,
compound fill holes, layer ordering, fallback handling, camera continuity, exact
PCM timing, hand-alpha extraction, and output constraints.

With FFmpeg installed it also launches the real CLI, renders two scenes, probes
H.264/AAC streams, checks dimensions, frame counts and duration, and decodes a
non-blank video frame. With eSpeak installed it repeats the full render with
offline narration and synthesizes a Hindi sample. These tests genuinely execute
the renderer; they are not mocked success responses. Missing system tools cause
clearly marked skips. The supplied GitHub Actions workflow installs those tools.

**Verification status:** The Python tests and renders are supplied but have not
been executed in the web-only implementation environment. Run this suite on the
target machine before treating the engine as production-verified. Live Iconify
and gTTS behavior, OS-specific voice export, and Hindi font shaping need validation
in that environment. The web application's production build is verified separately.

## Project Layout

```text
whiteboard-engine/
  assets/
    hand_marker.png
    illustrations/       # Eight original, multi-layered drawings
    fallbacks/           # Explicit offline Lucide backups
    fonts/               # Populated by one-time setup
    custom/              # Your subject-specific SVGs
    cache/               # Validated SVGs, PCM speech, and temporary jobs
    asset_manifest.json
    LICENSE.md
  src/
    __init__.py
    nlp_engine.py
    vector_manager.py
    canvas_camera.py
    tts_audio.py
    renderer.py
  examples/
  tests/test_engine.py
  requirements.txt
  setup_engine.py
  run_studio.py
  serve_studio.py
  LICENSE.txt
  README.md
```

Rendering uses raw FFmpeg streaming, so it does not retain a list of full frames
in memory. MoviePy and CairoSVG are included for extensions, but the core pipeline
does not depend on MoviePy version-specific compositing APIs. Generated MP4s are
written to a temporary file and only atomically published on successful encoding.
Intermediate tiles and PCM assemblies are cleaned up on success or failure.

## Troubleshooting

Missing model: rerun setup or `python -m spacy download en_core_web_sm`.
Missing voice: install a system voice, install eSpeak NG, or explicitly select
`--tts none` for a silent render. An unavailable voice is an error, not silent
pretend narration. Missing Hindi glyphs: install the bundled Noto Devanagari font
and verify `PIL.features.check_feature('raqm')` is true. Fetch failure: use a cached
or local asset; inspect the manifest for a reported fallback. Slow render: test at
720p or 640x360, reduce FPS to 24, and use `--preset fast` or `veryfast`.

No accuracy guarantee is implied by a fetched keyword icon. Review your script,
illustrations, pronunciation, scene layout, and finished video before publishing.