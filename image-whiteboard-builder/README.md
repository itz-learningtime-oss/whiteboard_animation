# Image Whiteboard Builder

An offline Python pipeline that draws the actual contours of an input image,
follows each stroke with a marker hand, and exports an HD MP4 synchronized with
your supplied audio. No LLMs, AI APIs, generated narration, API keys, image search,
or network access are involved in processing or rendering.

This is the image/audio workflow in Scribble Studio. The existing script-based
`whiteboard-engine/` remains available separately; existing script projects are
not removed or silently migrated.

## Quick Start

Install Python 3.11+ and the system FFmpeg package, including FFprobe. For example,
on Ubuntu/Debian, `sudo apt-get install ffmpeg libgl1 libglib2.0-0` (OpenCV wheels
may need the GL/GLib runtime on minimal Linux systems). On macOS use your package manager;
on Windows add FFmpeg's `bin` directory to PATH. FFmpeg must include `libx264` and
AAC encoders. No spaCy model, system TTS voice, custom fonts, or GPU is needed.

```bash
cd image-whiteboard-builder
python -m venv .venv
source .venv/bin/activate
python setup_builder.py
python main.py --image input_diagram.png --audio narration.mp3 --output final_video.mp4
```

On Windows activate with `.venv\Scripts\activate` instead. `setup_builder.py`
installs the specified OpenCV, NumPy, MoviePy, Pillow, and pydub dependencies, checks
the system encoders, and removes the marker asset's white matte. Python 3.13+ also
gets `audioop-lts` for pydub compatibility. Initial pip installation needs internet
unless you supply an offline wheelhouse. Rendering never downloads anything.

Manual installation is also supported:

```bash
python -m pip install -r requirements.txt
python setup_builder.py --check-only
```

Without `--output`, the filename is `whiteboard_sketch_output.mp4`. A JSON manifest
is written alongside the video. Existing outputs are protected unless you pass
`--overwrite`.

## Modules

```text
image-whiteboard-builder/
  assets/
    hand_marker.png
    hand_marker.json
    LICENSE.md
  src/
    __init__.py
    audio_manager.py
    contour_processor.py
    sketch_animator.py
    video_exporter.py
  tests/test_pipeline.py
  requirements.txt
  main.py
  setup_builder.py
  README.md
  LICENSE.txt
```

`audio_manager.py` decodes the selected audio to a temporary 48 kHz, stereo,
16-bit PCM WAV. It uses pydub to measure the exact decoded sample-frame count,
not `len(AudioSegment)`, which rounds to milliseconds. The normalized PCM used
for measuring is also used for muxing, eliminating container-duration drift.
The original file is never modified. Sample-rate/bit-depth conversion and stereo
downmixing may occur; playback speed and voice content are not changed.

`contour_processor.py` reads and EXIF-orients the image, composites transparent
pixels onto white, converts to grayscale, applies Gaussian blur, runs OpenCV
`Canny`, and extracts `findContours(..., RETR_LIST, CHAIN_APPROX_SIMPLE)` paths.
It filters short noise traces and orders the surviving contours in horizontal
reading bands or by longest stroke first. Aspect ratio is preserved when fitting
the image onto the board. The clean sketch map contains retained image contours,
not a generic substitute illustration. Blank or unprocessable images fail with
an actionable message.

`sketch_animator.py` draws those paths incrementally, using actual arc lengths to
distribute work across the audio timeline. Pen-up transitions have a small timing
budget but never leave connecting lines on the canvas. The marker follows the
active contour coordinates, using the calibrated tip position from the bundled
asset. Completed frames hide the hand so the finished artwork is unobstructed.
Only a persistent drawing canvas and the current frame are retained in memory.

`video_exporter.py` streams raw RGB frames into FFmpeg, muxes the supplied audio,
and produces H.264 video with AAC audio, `yuv420p`, and fast-start metadata.
FFprobe verifies codecs, dimensions, frame count, and duration before the MP4 is
atomically published. Intermediate audio, frames, and failed encodes are cleaned
up. MoviePy is included as requested for extensions; the core uses pydub plus raw
FFmpeg rather than depending on MoviePy version-specific compositing methods.

## Exact Timing

For `S` decoded sample frames, sample rate `R`, and selected FPS `F`:

```text
audio duration = S / R
video frames   = ceil(S * F / R)
video duration = video frames / F
```

The first frame is blank and the last frame contains the complete sketch. Default
drawing progress at frame `i` is `i / (video_frames - 1)`. Audio starts at time zero.
At a fixed frame rate, arbitrary audio durations cannot always equal an integral
number of video frames. The video therefore rounds up, adding at most one frame's
worth of tail silence. No narration is trimmed, stretched, or replaced. The
manifest records audio samples, both durations, exact frame count, and padding.
AAC packets can introduce a small codec-level duration difference; verification
allows a bounded tolerance rather than pretending this does not exist.

`--lead` and `--hold` reserve optional blank/finished pauses *within* the audio's
existing duration. They do not append seconds or delay the audio. Impossible
combinations fail validation. Standard FPS options are 24, 25, 30, and 60.

## Tuning the Sketch

```bash
# Spatial progression, slower edge detail, and diagnostic sketch output.
python main.py --image diagram.png --audio voice.wav --sort spatial --save-sketch

# A noisy photograph: increase blur and thresholds to keep prominent edges.
python main.py --image photograph.jpg --audio voice.mp3 \
  --blur 7 --canny-low 75 --canny-high 190 --min-length 20

# Fine line art: lower the thresholds, and trace long strokes first.
python main.py --image drawing.png --audio recording.m4a \
  --canny-low 22 --canny-high 70 --sort length

# A faster 720p test render with no hand.
python main.py --image diagram.png --audio voice.wav \
  --width 1280 --height 720 --fps 24 --preset veryfast --no-hand

# Canvas, pen, and within-audio end pause.
python main.py --image diagram.png --audio voice.wav \
  --paper '#ffffff' --ink '#343c32' --pen-width 3 --hold 0.4
```

`--save-sketch` creates `OUTPUT.sketch.png` and `OUTPUT.edges.png`. The former is
the fitted high-contrast sketch; the latter is the Canny edge map at processing
resolution. Diagnostic line width is standardized; the MP4 respects `--pen-width`.
Use `--processing-limit` (default 1600, maximum 2560) for edge extraction detail.
`--margin` sets a proportional safe margin (default 7.5%).

Edge detection is not semantic understanding. It outlines visible boundaries,
including both sides of some thick lines. Photographs may need stronger blur,
higher thresholds, or preprocessing to avoid excess texture. Small written text
may not survive Canny simplification. No promise is made to recover invisible
details or turn every photograph into illustrator-quality art.

## Multiple Images and Subtitles

`main.py` now accepts more than one image sharing a single audio track, plus
an optional bottom-of-frame subtitle track. This is a CLI-only addition; the
core modules gained `subtitles.py` and `export_multi_image_video` in
`video_exporter.py`, everything else (`contour_processor.py`,
`sketch_animator.py`, `audio_manager.py`) is unchanged.

```bash
# Draw every image in a folder, in natural filename order (1.jpg, 2.jpg, ...
# 10.jpg), across the full length of one narration/audio track.
python main.py --image-dir ../../asset --audio ../../asset/final.mp3 \
  --output final_video.mp4 --subtitles captions.srt

# Explicit image list and per-image seconds instead of an even split.
python main.py --images a.png b.png c.png --audio voice.mp3 \
  --durations "5,8,4" --output final_video.mp4
```

Without `--durations`, the audio is split evenly across the images (using a
largest-remainder rounding so the frame counts sum exactly to the audio
length). Within its own slice, each image behaves like the single-image
pipeline: blank canvas, incremental contour drawing, then the completed
sketch for the remainder of its slice; `--lead`/`--hold` apply per image.

`--subtitles` takes either:
- an `.srt` file (standard `HH:MM:SS,mmm --> HH:MM:SS,mmm` timing + caption
  blocks), or
- a plain `.txt` file with one caption per line, which is spread evenly
  across the full audio duration.

Captions are rendered directly onto the exported frames (not a separate
subtitle stream) as a centered, semi-transparent bar near the bottom edge, so
they show up identically in any player. Tune them with `--subtitle-font`
(path to a `.ttf`/`.otf`; a common system font such as Segoe UI or Arial is
used if omitted), `--subtitle-size`, `--subtitle-color`, `--subtitle-bg`,
`--subtitle-bg-opacity`, and `--subtitle-margin`. `--save-sketch` with
multiple images writes one `OUTPUT.imageN.sketch.png`/`.edges.png` pair per
image instead of a single pair.

**Not yet run on a machine with FFmpeg/OpenCV installed** — same verification
boundary as the rest of this README: install the requirements and run the
commands above (or `python setup_builder.py --test`) before treating this as
production-verified.

## Hand Calibration

The shipped 1024x1024 PNG has a nib at approximately (286, 285), normalized to
`(0.279, 0.278)`. The renderer anchors this nib, not the image's top-left corner,
to the active stroke. Transparent assets are respected; opaque white mattes are
removed only where near-white pixels connect to the image boundary.

```bash
python main.py --image diagram.png --audio voice.wav \
  --hand assets/my_hand.png --tip-x 0.28 --tip-y 0.28 --hand-scale 0.28
```

If replacing the asset, calibrate your actual pen tip. A missing hand is an error
unless `--no-hand` is explicitly selected. There are no placeholder cursors posing
as a supplied graphic.

## Limits and Safety

- Images: 30 MB, 30 megapixels; single-page PNG, JPEG, WebP, BMP, or TIFF.
- Audio: 128 MB, 0.1 to 600 seconds; WAV, MP3, M4A, AAC, FLAC, OGG, Opus, or AIFF.
- Output: even dimensions, from 320x180 to 3840x2160.
- Complexity: 12,000 contours and 300,000 retained points by default.
- Audio decoder timeout: three minutes; rendering watchdog: one hour.
- Only local files and FFmpeg pipe protocols are allowed; no network media URLs.
- No shell command interpolation is used, and input paths are not overwritten.

Audio decoding is bounded and disk-backed, but pydub loads the normalized PCM
for analysis. Ten minutes of stereo 48 kHz PCM needs about 115 MB plus library
overhead. Rendering is incremental and does not keep a full video in RAM. Use a
virtual environment and adequate disk space for the temporary PCM and MP4.

## Web Studio

The existing React app opens the new **Image to video** workflow. You can upload
an image and audio, inspect original versus sketch, choose edge detail and order,
preview synchronized drawing, seek the waveform, choose a paper tone, and export.

The browser preview performs local JavaScript grayscale, separable Gaussian blur,
Sobel gradients, non-maximum suppression, hysteresis, and connected-pixel tracing.
It is deliberately labeled a preview, not Python/OpenCV running in a browser.
Contour order/detail can differ from the Python output. Neither path calls AI APIs.

Browser recording routes the *uploaded audio buffer* to a Web Audio media stream
and combines it with the canvas video stream. Unlike the older script workflow's
silent preview, this image workflow exports both audio and drawing. MP4 or WebM
is selected from actual browser codec support. Keep the tab visible during real-
time recording; hidden tabs are stopped with an explanatory error to avoid gaps.
The browser exporter is limited to five minutes and is not frame-accurate offline
rendering. For that, choose the Python render kit.

The render kit includes all source, tests, hand assets, your original files, and
`RENDER_MY_SKETCH.txt` with the exact CLI command and selected settings. Files stay
in this browser session, including when switching between studio views. Reloading
closes the session; download your kit before reloading. Large media is deliberately
not placed into localStorage. Existing text projects retain their prior persistence.

## Verification

```bash
# Install/check requirements and execute every test:
python setup_builder.py --test

# Or run the suite after installation:
python -m unittest discover -s tests -v
```

Tests cover exact sample/frame arithmetic, first and last drawing frames, invalid
timing, edge extraction, alpha compositing, no-contour errors, contour sorting,
pen-tip position, no pen-up connector lines, rewinding, and hand transparency.
Integration tests generate a real diagram and 440 Hz test soundtrack, launch the
CLI, create a 720p MP4, probe H.264/AAC streams and frame counts, decode the first
and last video frames, and verify the exported audio contains the original tone.
They also cover MP3 decoding, protected existing outputs, and cleanup on failure.
Missing FFmpeg/FFprobe produces explicitly marked integration-test skips.

The included CI workflow installs system FFmpeg and runs the actual suite. No
mock success response substitutes for an encoded video.

**Current verification boundary:** Python/pip execution is not exposed by the
implementation environment's tools. Dependencies have been declared and an
installer provided, but they have not been installed or run here. The Python
tests and end-to-end MP4 flow are therefore **not yet verified** on a runtime.
The React/Vite build is verified independently. Run the commands above on your
target machine before treating the render pipeline as production-verified.

## License

Original code is MIT-licensed. See `LICENSE.txt` and `assets/LICENSE.md`. Upload
only images and audio you have the right to use. Dependency and FFmpeg licenses
remain with their respective authors.