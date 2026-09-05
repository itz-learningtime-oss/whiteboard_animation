"""Unit tests and actual CLI image + audio -> H.264/AAC integration tests."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from fractions import Fraction
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.audio_manager import analyze_audio, plan_timing
from src.contour_processor import ContourDrawing, ContourOptions, ContourPath, load_image, order_contours, process_image
from src.sketch_animator import AnimationOptions, SketchAnimator, load_hand
from src.video_exporter import export_video


def make_diagram(path: Path) -> None:
    image = Image.new("RGB", (600, 400), "white")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((65, 100, 235, 255), 12, outline="black", width=4)
    draw.ellipse((335, 115, 500, 250), outline="black", width=4)
    draw.line((242, 175, 316, 175, 298, 160), fill="black", width=4)
    draw.line((316, 175, 298, 190), fill="black", width=4)
    draw.line((95, 130, 198, 130), fill="black", width=3)
    draw.line((95, 155, 177, 155), fill="black", width=3)
    draw.line((95, 180, 198, 180), fill="black", width=3)
    image.save(path)


def make_audio(path: Path, frames: int = 50001, rate: int = 44100) -> None:
    t = np.arange(frames, dtype=np.float64) / rate
    tone = (np.sin(2 * math.pi * 440 * t) * 9000).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes(tone.tobytes())


class TimingTests(unittest.TestCase):
    def test_exact_sample_frame_count(self):
        for rate, count, fps in ((44100, 50001, 24), (48000, 480001, 30), (44100, 88200, 60), (48000, 5000, 25)):
            with self.subTest(rate=rate, count=count, fps=fps):
                plan = plan_timing(count, rate, fps)
                self.assertEqual(plan.frame_count, math.ceil(Fraction(count * fps, rate)))
                self.assertEqual(plan.progress_at(0), 0)
                self.assertEqual(plan.progress_at(plan.frame_count - 1), 1)
                self.assertGreaterEqual(plan.video_duration, plan.audio_duration)
                self.assertLess(plan.video_duration - plan.audio_duration, 1 / fps + 1e-12)
                self.assertGreaterEqual(plan.audio_padding_samples, 0)

    def test_lead_hold_and_invalid_timing(self):
        plan = plan_timing(480000, 48000, 30, lead=1, hold=1)
        self.assertEqual(plan.progress_at(29), 0)
        self.assertEqual(plan.progress_at(269), 1)
        for options in ((0, 48000, 30, 0, 0), (1000, 48000, 30, 0, 0), (48000, 48000, 17, 0, 0), (48000, 48000, 30, 1, 1), (48000, 48000, 30, math.nan, 0)):
            with self.subTest(options=options), self.assertRaises(ValueError):
                plan_timing(*options)


class ContourTests(unittest.TestCase):
    def test_actual_image_contours_and_aspect_fit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "diagram.png"; make_diagram(path)
            drawing = process_image(path, ContourOptions(width=640, height=360))
            self.assertGreater(len(drawing.paths), 4)
            self.assertGreater(drawing.total_length, 100)
            self.assertEqual(drawing.source_size, (600, 400))
            self.assertEqual(drawing.sketch_map.shape, (360, 640))
            self.assertGreater(int((drawing.sketch_map < 100).sum()), 100)
            points = np.vstack([p.points for p in drawing.paths])
            self.assertGreaterEqual(points.min(), 0)
            self.assertLess(points[:, 0].max(), 640)
            self.assertLess(points[:, 1].max(), 360)
            again = process_image(path, ContourOptions(width=640, height=360))
            for first, second in zip(drawing.paths, again.paths):
                np.testing.assert_array_equal(first.points, second.points)

    def test_no_placeholders_for_blank_image(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "blank.png"
            Image.new("RGB", (320, 180), "white").save(path)
            with self.assertRaisesRegex(ValueError, "No drawable contours"):
                process_image(path)

    def test_alpha_compositing_and_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transparent.png"
            image = Image.new("RGBA", (200, 150), (0, 0, 0, 0))
            ImageDraw.Draw(image).line((30, 50, 180, 70), fill="black", width=5)
            image.save(path)
            loaded = load_image(path)
            self.assertEqual(loaded.getpixel((0, 0)), (255, 255, 255))
            path.write_text("this is not a PNG")
            with self.assertRaises(ValueError):
                load_image(path)

    def test_sorting_is_logical(self):
        a = np.array([[100, 200], [200, 200]], dtype=float)
        b = np.array([[20, 20], [40, 20]], dtype=float)
        c = np.array([[200, 20], [260, 20]], dtype=float)
        spatial = order_contours([a, c, b], "spatial", 300)
        self.assertIs(spatial[0], b); self.assertIs(spatial[1], c)
        longest = order_contours([a, c, b], "length", 300)
        self.assertIs(longest[0], a); self.assertIs(longest[-1], b)

    def test_invalid_options(self):
        for option in (ContourOptions(width=321), ContourOptions(low_threshold=200, high_threshold=20), ContourOptions(blur_size=4), ContourOptions(sort="random")):
            with self.subTest(option=option), self.assertRaises(ValueError):
                option.validate()


class AnimatorTests(unittest.TestCase):
    def drawing(self):
        a = np.array([[30., 40.], [90., 40.]])
        b = np.array([[210., 140.], [280., 140.]])
        return ContourDrawing((ContourPath(a, 60), ContourPath(b, 70)), 320, 180, (320, 180), np.zeros((180, 320), np.uint8), np.full((180, 320), 255, np.uint8))

    def test_pen_lifts_do_not_draw_across_empty_space(self):
        animator = SketchAnimator(self.drawing(), AnimationOptions(hand=False))
        frame = animator.frame(1)
        self.assertLess(frame[40, 60].max(), 180)
        self.assertLess(frame[140, 240].max(), 180)
        self.assertGreater(frame[90, 150].min(), 230)

    def test_tip_follows_actual_segment_and_rewinds(self):
        animator = SketchAnimator(self.drawing(), AnimationOptions(hand=False))
        progress = 30 / animator.total_budget
        middle = animator.frame(progress)
        np.testing.assert_allclose(animator.tip, (60, 40), atol=1e-7)
        self.assertLess(middle[40, 45].max(), 180)
        self.assertGreater(middle[40, 85].min(), 230)
        animator.frame(1)
        rewound = animator.frame(0)
        self.assertTrue((rewound.min(axis=2) > 230).all())

    def test_expected_frames_and_complete_final_frame(self):
        timing = plan_timing(48000, 48000, 24)
        animator = SketchAnimator(self.drawing(), AnimationOptions(hand=False))
        frames = list(animator.frames(timing))
        self.assertEqual(len(frames), 24)
        self.assertGreater(frames[0].min(), 230)
        self.assertLess(frames[-1][140, 260].max(), 180)

    def test_marker_asset_and_background_removal(self):
        marker = load_hand(ROOT / "assets" / "hand_marker.png")
        self.assertEqual(marker.mode, "RGBA")
        self.assertEqual(marker.getpixel((0, 0))[3], 0)
        self.assertGreater(np.asarray(marker)[:, :, 3].mean(), 15)
        with self.assertRaises(ValueError):
            load_hand(ROOT / "assets" / "missing.png")


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Install FFmpeg and FFprobe for real audio/video integration tests")
class IntegrationTests(unittest.TestCase):
    def test_audio_is_measured_from_decoded_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); source = folder / "voice.wav"
            make_audio(source)
            info = analyze_audio(source, folder / "work")
            self.assertAlmostEqual(info.duration, 50001 / 44100, delta=1 / 24000)
            with wave.open(str(info.pcm_path), "rb") as normalized:
                self.assertEqual(normalized.getnframes(), info.sample_frames)
                self.assertEqual(normalized.getframerate(), info.sample_rate)
                self.assertEqual(normalized.getnchannels(), 2)
            self.assertEqual(info.exact_duration, Fraction(info.sample_frames, info.sample_rate))

    def test_cli_renders_real_hd_mp4_with_supplied_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); image = folder / "diagram.png"; audio = folder / "narration.wav"
            make_diagram(image); make_audio(audio)
            output = folder / "finished.mp4"
            command = [sys.executable, str(ROOT / "main.py"), "--image", str(image), "--audio", str(audio), "--output", str(output), "--width", "1280", "--height", "720", "--fps", "24", "--preset", "ultrafast", "--save-sketch", "--progress-json"]
            result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertGreater(output.stat().st_size, 5000)
            manifest = json.loads(output.with_suffix(".manifest.json").read_text())
            self.assertEqual(manifest["verification"]["video_codec"], "h264")
            self.assertEqual(manifest["verification"]["audio_codec"], "aac")
            self.assertEqual(manifest["width"], 1280)
            self.assertLess(manifest["padding_seconds"], 1 / 24 + 1e-6)
            self.assertTrue(output.with_suffix(".sketch.png").exists())
            self.assertTrue(output.with_suffix(".edges.png").exists())
            probe = json.loads(subprocess.check_output([shutil.which("ffprobe"), "-v", "error", "-show_streams", "-of", "json", str(output)], text=True))
            video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
            audio_stream = next(stream for stream in probe["streams"] if stream["codec_type"] == "audio")
            self.assertEqual(int(video["nb_frames"]), manifest["frame_count"])
            self.assertGreaterEqual(float(audio_stream["duration"]), manifest["audio_duration"] - .025)
            capture = cv2.VideoCapture(str(output))
            ok_first, first = capture.read()
            capture.set(cv2.CAP_PROP_POS_FRAMES, manifest["frame_count"] - 1)
            ok_last, last = capture.read(); capture.release()
            self.assertTrue(ok_first and ok_last)
            self.assertLess(int((first.min(axis=2) < 120).sum()), 50)
            self.assertGreater(int((last.min(axis=2) < 120).sum()), 500)
            decoded = folder / "decoded-audio.wav"
            subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-i", str(output), "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", str(decoded)], check=True, capture_output=True)
            with wave.open(str(decoded), "rb") as wav:
                samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(float)
            self.assertGreater(float(np.sqrt(np.mean(samples**2))), 1000)
            middle = samples[5000:35000]
            frequency = np.argmax(np.abs(np.fft.rfft(middle))) * 44100 / len(middle)
            self.assertAlmostEqual(frequency, 440, delta=4)
            events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
            self.assertEqual(events[-1]["status"], "complete")
            existing = output.read_bytes()
            second = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual(output.read_bytes(), existing)
            self.assertFalse(list(folder.glob(".whiteboard-sketch-*")))

    def test_blank_input_fails_without_publishing_video(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); image = folder / "blank.png"; audio = folder / "voice.wav"
            Image.new("RGB", (400, 300), "white").save(image); make_audio(audio)
            with self.assertRaises(ValueError):
                export_video(image, audio, folder / "output.mp4", animation_options=AnimationOptions(hand=False))
            self.assertFalse((folder / "output.mp4").exists())
            self.assertFalse(list(folder.glob(".whiteboard-sketch-*")))

    def test_compressed_audio_input(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); wav = folder / "voice.wav"; mp3 = folder / "voice.mp3"
            make_audio(wav)
            subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-i", str(wav), "-c:a", "libmp3lame", str(mp3)], check=True, capture_output=True)
            info = analyze_audio(mp3, folder / "work")
            self.assertAlmostEqual(info.duration, 50001 / 44100, delta=.03)


if __name__ == "__main__":
    unittest.main()