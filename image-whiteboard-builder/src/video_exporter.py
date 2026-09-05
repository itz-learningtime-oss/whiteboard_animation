"""Stream RGB frames and the supplied audio into an atomically published MP4."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

from PIL import Image

from .audio_manager import analyze_audio, plan_timing
from .contour_processor import ContourOptions, process_image
from .sketch_animator import AnimationOptions, SketchAnimator


def verify_video(path: Path, width: int, height: int, frames: int, fps: int, audio_duration: float) -> dict:
    executable = shutil.which("ffprobe")
    if not executable:
        raise RuntimeError("FFprobe is required to verify the finished MP4. Install the full FFmpeg package.")
    result = subprocess.run([executable, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError(f"Could not verify the encoded MP4: {result.stderr[-1000:]}")
    info = json.loads(result.stdout)
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not video or not audio or video.get("codec_name") != "h264" or audio.get("codec_name") != "aac":
        raise RuntimeError("Encoded file does not contain the required H.264 video and AAC audio streams.")
    if (video.get("width"), video.get("height")) != (width, height) or int(video.get("nb_frames", 0)) != frames:
        raise RuntimeError("Encoded dimensions or video frame count do not match the timeline.")
    actual_duration = float(info["format"]["duration"])
    audio_stream_duration = float(audio.get("duration", actual_duration))
    if audio_stream_duration < audio_duration - .03:
        raise RuntimeError("The encoded audio stream is shorter than the supplied narration.")
    if actual_duration < audio_duration - .03 or abs(actual_duration - frames / fps) > max(.06, 1 / fps):
        raise RuntimeError("Encoded duration differs from the sample-timed video plan.")
    return {"video_codec": video["codec_name"], "audio_codec": audio["codec_name"], "duration": actual_duration, "frame_count": frames}


def export_video(image_path: Path, audio_path: Path, output: Path, contour_options: ContourOptions | None = None, animation_options: AnimationOptions | None = None, fps: int = 30, lead: float = 0, hold: float = 0, crf: int = 18, preset: str = "medium", overwrite: bool = False, save_sketch: bool = False, progress: Callable[[float, str], None] | None = None) -> dict:
    contour_options = contour_options or ContourOptions()
    animation_options = animation_options or AnimationOptions()
    contour_options.validate(); animation_options.validate()
    if not 0 <= crf <= 35 or preset not in {"ultrafast", "veryfast", "fast", "medium", "slow"}:
        raise ValueError("Invalid H.264 quality or encoder preset.")
    report = progress or (lambda fraction, message: None)
    output = Path(output).expanduser().resolve()
    if output.suffix.lower() != ".mp4":
        raise ValueError("Output must be an .mp4 file.")
    input_paths = {Path(image_path).resolve(), Path(audio_path).resolve(), Path(animation_options.hand_path).resolve()}
    if output in input_paths:
        raise ValueError("The output must not overwrite an input asset.")
    destinations = [output, output.with_suffix(".manifest.json")]
    if save_sketch:
        destinations += [output.with_suffix(".sketch.png"), output.with_suffix(".edges.png")]
    if any(path in input_paths for path in destinations):
        raise ValueError("A diagnostic output path would overwrite an input asset. Choose a different output name.")
    if not overwrite and any(path.exists() for path in destinations):
        raise FileExistsError("An output or diagnostic file already exists. Choose another name or pass --overwrite.")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not shutil.which("ffprobe"):
        raise RuntimeError("Install FFmpeg and FFprobe and add both commands to PATH.")
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix=".whiteboard-sketch-", dir=output.parent) as folder:
        work = Path(folder)
        report(.01, "Measuring the supplied audio at PCM sample precision")
        audio = analyze_audio(audio_path, work, ffmpeg)
        timing = plan_timing(audio.sample_frames, audio.sample_rate, fps, lead, hold)
        report(.06, "Extracting and ordering image contours")
        drawing = process_image(image_path, contour_options)
        animator = SketchAnimator(drawing, animation_options)
        pending = work / "encoded.mp4"
        log = work / "encoder.log"
        padded_samples = audio.sample_frames + timing.audio_padding_samples
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{drawing.width}x{drawing.height}", "-framerate", str(fps), "-i", "pipe:0", "-protocol_whitelist", "file,pipe", "-i", str(audio.pcm_path), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p", "-frames:v", str(timing.frame_count), "-c:a", "aac", "-b:a", "192k", "-af", f"apad=whole_len={padded_samples}", "-t", f"{timing.video_duration:.12f}", "-movflags", "+faststart", str(pending)]
        with log.open("wb") as error_log:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=error_log)
            timed_out = threading.Event()
            def timeout():
                timed_out.set()
                if process.poll() is None:
                    process.kill()
            timer = threading.Timer(3600, timeout)
            timer.daemon = True
            timer.start()
            try:
                assert process.stdin is not None
                for index, frame in enumerate(animator.frames(timing)):
                    if timed_out.is_set():
                        raise TimeoutError("Rendering exceeded the one-hour safety limit.")
                    process.stdin.write(frame.tobytes())
                    if index % fps == 0 or index == timing.frame_count - 1:
                        report(.1 + .84 * (index + 1) / timing.frame_count, f"Drawing frame {index + 1} of {timing.frame_count}")
                process.stdin.close()
                result = process.wait(timeout=120)
                if result:
                    raise RuntimeError(f"FFmpeg could not encode the video: {log.read_text(errors='replace')[-2000:]}")
            except BaseException as exc:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait()
                if isinstance(exc, BrokenPipeError):
                    raise RuntimeError(f"FFmpeg stopped accepting frames: {log.read_text(errors='replace')[-2000:]}") from exc
                raise
            finally:
                timer.cancel()
                if process.stdin and not process.stdin.closed:
                    try: process.stdin.close()
                    except OSError: pass
        report(.96, "Verifying codecs, frame count, and audio/video duration")
        verification = verify_video(pending, drawing.width, drawing.height, timing.frame_count, fps, audio.duration)
        manifest = {"image": str(Path(image_path).resolve()), "audio": str(audio.source), "output": str(output), "source_size": drawing.source_size, "width": drawing.width, "height": drawing.height, "fps": fps, "frame_count": timing.frame_count, "audio_sample_frames": audio.sample_frames, "audio_sample_rate": audio.sample_rate, "audio_duration": audio.duration, "video_duration": timing.video_duration, "padding_seconds": timing.audio_padding_samples / audio.sample_rate, "contours": len(drawing.paths), "stroke_length_pixels": drawing.total_length, "contour_order": contour_options.sort, "canny_low": contour_options.low_threshold, "canny_high": contour_options.high_threshold, "first_draw_frame": timing.first_draw_frame, "last_draw_frame": timing.last_draw_frame, "hand_tip": [animation_options.tip_x, animation_options.tip_y], "verification": verification, "render_seconds": round(time.monotonic() - started, 3)}
        (work / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        if save_sketch:
            Image.fromarray(drawing.sketch_map).save(work / "sketch.png")
            Image.fromarray(drawing.edge_map).save(work / "edges.png")
            os.replace(work / "sketch.png", output.with_suffix(".sketch.png"))
            os.replace(work / "edges.png", output.with_suffix(".edges.png"))
        os.replace(work / "manifest.json", output.with_suffix(".manifest.json"))
        os.replace(pending, output)
    report(1, "Your audio-synchronized whiteboard sketch is ready")
    return manifest