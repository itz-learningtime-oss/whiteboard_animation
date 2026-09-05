"""Stream RGB frames and the supplied audio into an atomically published MP4.

Supports a single image (``export_video``) or an ordered sequence of images
sharing one audio track (``export_multi_image_video``), each with an optional
bottom-of-frame subtitle track.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Iterable, Iterator

import numpy as np
from PIL import Image

from .audio_manager import analyze_audio, plan_timing
from .contour_processor import ContourOptions, process_image
from .sketch_animator import AnimationOptions, SketchAnimator
from .subtitles import SubtitleOptions, active_text, burn_subtitle, load_subtitle_cues


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


def _validate_common(crf: int, preset: str) -> None:
    if not 0 <= crf <= 35 or preset not in {"ultrafast", "veryfast", "fast", "medium", "slow"}:
        raise ValueError("Invalid H.264 quality or encoder preset.")


def _prepare_output(output: Path, input_paths: set[Path], extra_outputs: list[Path], overwrite: bool) -> tuple[Path, list[Path]]:
    output = Path(output).expanduser().resolve()
    if output.suffix.lower() != ".mp4":
        raise ValueError("Output must be an .mp4 file.")
    destinations = [output, output.with_suffix(".manifest.json")] + extra_outputs
    if output in input_paths:
        raise ValueError("The output must not overwrite an input asset.")
    if any(path in input_paths for path in destinations):
        raise ValueError("A diagnostic output path would overwrite an input asset. Choose a different output name.")
    if not overwrite and any(path.exists() for path in destinations):
        raise FileExistsError("An output or diagnostic file already exists. Choose another name or pass --overwrite.")
    output.parent.mkdir(parents=True, exist_ok=True)
    return output, destinations


def _ffmpeg_binary() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not shutil.which("ffprobe"):
        raise RuntimeError("Install FFmpeg and FFprobe and add both commands to PATH.")
    return ffmpeg


def _encode_command(ffmpeg: str, width: int, height: int, fps: int, pcm_path: Path, frame_count: int, padded_samples: int, video_duration: float, crf: int, preset: str, pending: Path) -> list[str]:
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24",
            "-video_size", f"{width}x{height}", "-framerate", str(fps), "-i", "pipe:0",
            "-protocol_whitelist", "file,pipe", "-i", str(pcm_path), "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-frames:v", str(frame_count), "-c:a", "aac", "-b:a", "192k",
            "-af", f"apad=whole_len={padded_samples}", "-t", f"{video_duration:.12f}",
            "-movflags", "+faststart", str(pending)]


def _stream_frames(command: list[str], frames: Iterable[np.ndarray], frame_count: int, fps: int, log: Path, report: Callable[[float, str], None], progress_floor: float, progress_span: float, message: str) -> None:
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
            for index, frame in enumerate(frames):
                if timed_out.is_set():
                    raise TimeoutError("Rendering exceeded the one-hour safety limit.")
                process.stdin.write(frame.tobytes())
                if index % fps == 0 or index == frame_count - 1:
                    report(progress_floor + progress_span * (index + 1) / frame_count, f"{message} {index + 1} of {frame_count}")
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
                    process.kill()
                    process.wait()
            if isinstance(exc, BrokenPipeError):
                raise RuntimeError(f"FFmpeg stopped accepting frames: {log.read_text(errors='replace')[-2000:]}") from exc
            raise
        finally:
            timer.cancel()
            if process.stdin and not process.stdin.closed:
                try:
                    process.stdin.close()
                except OSError:
                    pass


def _split_frame_counts(total_frames: int, weights: list[float], minimum: int) -> list[int]:
    if any((not math.isfinite(w)) or w <= 0 for w in weights):
        raise ValueError("Per-image durations/weights must be positive finite numbers.")
    n = len(weights)
    if total_frames < minimum * n:
        raise ValueError(f"Audio is too short to give every image at least {minimum} frames. Shorten --lead/--hold, use fewer images, or use longer audio.")
    total_weight = sum(weights)
    raw = [total_frames * w / total_weight for w in weights]
    counts = [max(minimum, math.floor(r)) for r in raw]
    deficit = total_frames - sum(counts)
    order = sorted(range(n), key=lambda i: raw[i] - math.floor(raw[i]), reverse=True)
    i = 0
    while deficit > 0:
        counts[order[i % n]] += 1
        deficit -= 1
        i += 1
    while deficit < 0:
        idx = max(range(n), key=lambda i: counts[i])
        if counts[idx] <= minimum:
            raise ValueError("Could not fit per-image frame counts without violating the minimum. Reduce image count or lengthen audio.")
        counts[idx] -= 1
        deficit += 1
    return counts


def export_video(image_path: Path, audio_path: Path, output: Path, contour_options: ContourOptions | None = None, animation_options: AnimationOptions | None = None, fps: int = 30, lead: float = 0, hold: float = 0, crf: int = 18, preset: str = "medium", overwrite: bool = False, save_sketch: bool = False, subtitle_path: Path | None = None, subtitle_options: SubtitleOptions | None = None, progress: Callable[[float, str], None] | None = None) -> dict:
    contour_options = contour_options or ContourOptions()
    animation_options = animation_options or AnimationOptions()
    contour_options.validate()
    animation_options.validate()
    _validate_common(crf, preset)
    subtitle_options = subtitle_options or SubtitleOptions()
    if subtitle_path is not None:
        subtitle_options.validate()
    report = progress or (lambda fraction, message: None)
    image_path = Path(image_path).expanduser().resolve()
    audio_path = Path(audio_path).expanduser().resolve()
    hand_path = Path(animation_options.hand_path).expanduser().resolve()
    input_paths = {image_path, audio_path, hand_path}
    if subtitle_path is not None:
        input_paths.add(Path(subtitle_path).expanduser().resolve())
    output = Path(output).expanduser().resolve()
    extra_outputs = [output.with_suffix(".sketch.png"), output.with_suffix(".edges.png")] if save_sketch else []
    output, destinations = _prepare_output(output, input_paths, extra_outputs, overwrite)
    ffmpeg = _ffmpeg_binary()
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix=".whiteboard-sketch-", dir=output.parent) as folder:
        work = Path(folder)
        report(.01, "Measuring the supplied audio at PCM sample precision")
        audio = analyze_audio(audio_path, work, ffmpeg)
        timing = plan_timing(audio.sample_frames, audio.sample_rate, fps, lead, hold)
        report(.06, "Extracting and ordering image contours")
        drawing = process_image(image_path, contour_options)
        animator = SketchAnimator(drawing, animation_options)
        cues = load_subtitle_cues(subtitle_path, audio.duration) if subtitle_path is not None else []

        def frames() -> Iterator[np.ndarray]:
            for index in range(timing.frame_count):
                frame = animator.frame(timing.progress_at(index))
                if cues:
                    text = active_text(cues, index / fps)
                    if text:
                        frame = burn_subtitle(frame, text, subtitle_options)
                yield frame

        pending = work / "encoded.mp4"
        log = work / "encoder.log"
        padded_samples = audio.sample_frames + timing.audio_padding_samples
        command = _encode_command(ffmpeg, drawing.width, drawing.height, fps, audio.pcm_path, timing.frame_count, padded_samples, timing.video_duration, crf, preset, pending)
        _stream_frames(command, frames(), timing.frame_count, fps, log, report, .1, .84, "Drawing frame")

        report(.96, "Verifying codecs, frame count, and audio/video duration")
        verification = verify_video(pending, drawing.width, drawing.height, timing.frame_count, fps, audio.duration)
        manifest = {"image": str(image_path), "audio": str(audio.source), "output": str(output), "source_size": drawing.source_size, "width": drawing.width, "height": drawing.height, "fps": fps, "frame_count": timing.frame_count, "audio_sample_frames": audio.sample_frames, "audio_sample_rate": audio.sample_rate, "audio_duration": audio.duration, "video_duration": timing.video_duration, "padding_seconds": timing.audio_padding_samples / audio.sample_rate, "contours": len(drawing.paths), "stroke_length_pixels": drawing.total_length, "contour_order": contour_options.sort, "canny_low": contour_options.low_threshold, "canny_high": contour_options.high_threshold, "color_mode": contour_options.color_mode, "first_draw_frame": timing.first_draw_frame, "last_draw_frame": timing.last_draw_frame, "hand_tip": [animation_options.tip_x, animation_options.tip_y], "subtitle_cues": len(cues), "verification": verification, "render_seconds": round(time.monotonic() - started, 3)}
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


def export_multi_image_video(image_paths: list[Path], audio_path: Path, output: Path, contour_options: ContourOptions | None = None, animation_options: AnimationOptions | None = None, fps: int = 30, durations: list[float] | None = None, lead: float = 0, hold: float = 0, crf: int = 18, preset: str = "medium", overwrite: bool = False, save_sketch: bool = False, subtitle_path: Path | None = None, subtitle_options: SubtitleOptions | None = None, progress: Callable[[float, str], None] | None = None) -> dict:
    """Draw an ordered sequence of images across one shared audio track.

    Each image gets a slice of the total video timeline (equal by default, or
    weighted by ``durations`` seconds, one value per image). Within its own
    slice every image behaves like the single-image pipeline: blank canvas,
    incremental contour drawing, optional lead/hold pause, completed artwork.
    """
    image_paths = [Path(p).expanduser().resolve() for p in image_paths]
    if not image_paths:
        raise ValueError("Provide at least one image.")
    contour_options = contour_options or ContourOptions()
    animation_options = animation_options or AnimationOptions()
    contour_options.validate()
    animation_options.validate()
    _validate_common(crf, preset)
    weights = list(durations) if durations is not None else [1.0] * len(image_paths)
    if len(weights) != len(image_paths):
        raise ValueError("Provide exactly one duration per image, in the same order as the images.")
    subtitle_options = subtitle_options or SubtitleOptions()
    if subtitle_path is not None:
        subtitle_options.validate()

    report = progress or (lambda fraction, message: None)
    audio_path = Path(audio_path).expanduser().resolve()
    hand_path = Path(animation_options.hand_path).expanduser().resolve()
    input_paths = set(image_paths) | {audio_path, hand_path}
    if subtitle_path is not None:
        input_paths.add(Path(subtitle_path).expanduser().resolve())

    output = Path(output).expanduser().resolve()
    extra_outputs: list[Path] = []
    if save_sketch:
        for index in range(len(image_paths)):
            extra_outputs += [output.with_name(f"{output.stem}.image{index + 1}.sketch.png"), output.with_name(f"{output.stem}.image{index + 1}.edges.png")]
    output, destinations = _prepare_output(output, input_paths, extra_outputs, overwrite)
    ffmpeg = _ffmpeg_binary()
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix=".whiteboard-sketch-", dir=output.parent) as folder:
        work = Path(folder)
        report(.01, "Measuring the supplied audio at PCM sample precision")
        audio = analyze_audio(audio_path, work, ffmpeg)
        timing = plan_timing(audio.sample_frames, audio.sample_rate, fps, 0, 0)
        minimum_frames = max(2, math.ceil(lead * fps) + math.ceil(hold * fps) + 1)
        segment_frames = _split_frame_counts(timing.frame_count, weights, minimum_frames)
        cues = load_subtitle_cues(subtitle_path, audio.duration) if subtitle_path is not None else []

        report(.05, "Extracting and ordering contours for every image")
        drawings = []
        for index, path in enumerate(image_paths):
            drawings.append(process_image(path, contour_options))
            report(.05 + .1 * (index + 1) / len(image_paths), f"Analyzed image {index + 1} of {len(image_paths)}: {path.name}")

        def all_frames() -> Iterator[np.ndarray]:
            global_index = 0
            for drawing, count in zip(drawings, segment_frames):
                animator = SketchAnimator(drawing, animation_options)
                local_first = min(count - 1, math.ceil(lead * fps))
                local_last = max(local_first + 1, count - 1 - math.ceil(hold * fps))
                for local_index in range(count):
                    fraction = min(1.0, max(0.0, (local_index - local_first) / (local_last - local_first)))
                    frame = animator.frame(fraction)
                    if cues:
                        text = active_text(cues, global_index / fps)
                        if text:
                            frame = burn_subtitle(frame, text, subtitle_options)
                    yield frame
                    global_index += 1

        pending = work / "encoded.mp4"
        log = work / "encoder.log"
        padded_samples = audio.sample_frames + timing.audio_padding_samples
        command = _encode_command(ffmpeg, contour_options.width, contour_options.height, fps, audio.pcm_path, timing.frame_count, padded_samples, timing.video_duration, crf, preset, pending)
        _stream_frames(command, all_frames(), timing.frame_count, fps, log, report, .16, .78, "Drawing frame")

        report(.96, "Verifying codecs, frame count, and audio/video duration")
        verification = verify_video(pending, contour_options.width, contour_options.height, timing.frame_count, fps, audio.duration)
        manifest = {"images": [str(p) for p in image_paths], "audio": str(audio.source), "output": str(output), "width": contour_options.width, "height": contour_options.height, "fps": fps, "frame_count": timing.frame_count, "per_image_frame_counts": segment_frames, "audio_sample_frames": audio.sample_frames, "audio_sample_rate": audio.sample_rate, "audio_duration": audio.duration, "video_duration": timing.video_duration, "padding_seconds": timing.audio_padding_samples / audio.sample_rate, "contour_order": contour_options.sort, "canny_low": contour_options.low_threshold, "canny_high": contour_options.high_threshold, "color_mode": contour_options.color_mode, "subtitle_cues": len(cues), "verification": verification, "render_seconds": round(time.monotonic() - started, 3)}
        (work / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        if save_sketch:
            for index, drawing in enumerate(drawings):
                sketch_name = f"{output.stem}.image{index + 1}.sketch.png"
                edges_name = f"{output.stem}.image{index + 1}.edges.png"
                Image.fromarray(drawing.sketch_map).save(work / sketch_name)
                Image.fromarray(drawing.edge_map).save(work / edges_name)
                os.replace(work / sketch_name, output.with_name(sketch_name))
                os.replace(work / edges_name, output.with_name(edges_name))
        os.replace(work / "manifest.json", output.with_suffix(".manifest.json"))
        os.replace(pending, output)
    report(1, "Your multi-image, audio-synchronized whiteboard sketch is ready")
    return manifest
