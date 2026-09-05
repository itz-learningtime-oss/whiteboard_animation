"""Deterministic unit tests plus real FFmpeg and local-narration integration tests."""

from __future__ import annotations

import importlib.util
import json
import math
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.canvas_camera import CameraPose, CanvasCamera, smootherstep
from src.nlp_engine import ScriptParser
from src.renderer import RenderConfig, load_hand
from src.tts_audio import AudioGenerator, assemble_audio, write_silence
from src.vector_manager import VectorManager, hatch_region, parse_svg, sanitize_svg, transform_matrix


class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.parser = ScriptParser(allow_rule_fallback=True)

    def test_structured_visual_control(self):
        script = self.parser.parse_json({"title": "Water", "scenes": [{"text": "Water helps farms.", "primary_visual": "droplet", "layout": "illustration_left", "duration": 4}]})
        self.assertEqual(script.scenes[0].primary_visual, "droplet")
        self.assertEqual(script.scenes[0].layout, "illustration_left")
        self.assertEqual(script.scenes[0].duration, 4)

    def test_paragraphs_and_sentences(self):
        self.assertEqual(len(self.parser.parse_text("Rain falls. Crops grow.").scenes), 2)
        self.assertEqual(len(self.parser.parse_text("Rain falls. Water flows.\n\nTrucks move goods.").scenes), 2)

    def test_invalid_scripts(self):
        for value in ("{", [], {"scenes": []}, {"scenes": [{"text": ""}]}, {"scenes": [{"text": "Hello", "duration": -1}]}, {"scenes": [{"text": "Hello", "duration": math.nan}]}, {"scenes": [{"text": "Hello", "primary_visual": "../../secret"}]}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.parser.parse_json(value)

    def test_hindi_explicit_visual(self):
        script = self.parser.parse_file(ROOT / "examples" / "hindi.json")
        self.assertEqual(script.settings["language"], "hi")
        self.assertIn("\u0939\u0930", script.scenes[0].heading)

    @unittest.skipUnless(importlib.util.find_spec("en_core_web_sm"), "Install en_core_web_sm to test dependency extraction")
    def test_spacy_subject_action_location(self):
        scene = ScriptParser().parse_text("Trucks transport crops in Delhi.").scenes[0]
        self.assertIn("truck", scene.subjects)
        self.assertIn("transport", scene.actions)
        self.assertIn("Delhi", scene.locations)


class VectorTests(unittest.TestCase):
    def test_reject_active_svg_and_entities(self):
        assets = [b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', b'<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg><title>&xxe;</title><path d="M0 0L1 1"/></svg>', b'<svg><path d="M0 0L1 1" onclick="bad()"/></svg>', b'<svg><use href="https://example.com/a.svg"/></svg>']
        for data in assets:
            with self.subTest(data=data), self.assertRaises(ValueError):
                sanitize_svg(data)

    def test_transform_composition(self):
        point = transform_matrix("translate(10 20) scale(2)") @ np.array([3, 4, 1])
        np.testing.assert_allclose(point, [16, 28, 1])
        rotated = transform_matrix("rotate(90 5 5)") @ np.array([6, 5, 1])
        np.testing.assert_allclose(rotated, [5, 6, 1], atol=1e-8)

    def test_compound_hatching_respects_holes(self):
        outside = np.array([[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]])
        hole = np.array([[5, 5], [5, 15], [15, 15], [15, 5], [5, 5]])
        for fill_rule in ("evenodd", "nonzero"):
            hatches = hatch_region([outside, hole], spacing=1.2, angle=-35, fill_rule=fill_rule)
            self.assertGreater(len(hatches), 15)
            for line in hatches:
                for t in np.linspace(.05, .95, 9):
                    x, y = line[0] * (1 - t) + line[1] * t
                    self.assertTrue(-1e-7 <= x <= 20 + 1e-7 and -1e-7 <= y <= 20 + 1e-7)
                    self.assertFalse(5 < x < 15 and 5 < y < 15)

    def test_real_illustration_layer_order(self):
        drawing = parse_svg(ROOT / "assets" / "illustrations" / "rainwater.svg")
        layers = [stroke.layer for stroke in drawing.strokes]
        self.assertIn("outline", layers); self.assertIn("detail", layers); self.assertIn("hatch", layers)
        self.assertEqual(layers, sorted(layers, key={"outline": 0, "detail": 1, "hatch": 2}.get))
        self.assertGreater(len(drawing.line_segments()), 100)
        fitted = drawing.fit(100, 100, 800, 500)
        points = np.vstack([stroke.points for stroke in fitted.strokes])
        self.assertGreaterEqual(points[:, 0].min(), 100 - 1e-7)
        self.assertLessEqual(points[:, 0].max(), 900 + 1e-7)
        self.assertLessEqual(points[:, 1].max(), 600 + 1e-7)

    def test_no_hatching_mode(self):
        drawing = parse_svg(ROOT / "assets" / "illustrations" / "leaf.svg", hatching=False)
        self.assertNotIn("hatch", {stroke.layer for stroke in drawing.strokes})

    def test_local_fallback_and_strict_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            assets = Path(folder)
            shutil.copytree(ROOT / "assets" / "fallbacks", assets / "fallbacks")
            manager = VectorManager(assets=assets, offline=True)
            try:
                self.assertTrue(manager.get_svg("no-such-illustration").fallback)
                manager.strict = True
                with self.assertRaises(ValueError):
                    manager.get_svg("no-such-illustration")
            finally:
                manager.close()

    def test_svg_primitives_and_nested_transform(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "transformed.svg"
            path.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none"><g transform="translate(10 20)"><g transform="scale(2)"><rect x="0" y="0" width="10" height="10" rx="2"/><circle cx="15" cy="15" r="2"/></g></g></svg>')
            drawing = parse_svg(path, hatching=False)
            self.assertAlmostEqual(drawing.bounds[0], 10)
            self.assertAlmostEqual(drawing.bounds[1], 20)
            self.assertAlmostEqual(drawing.bounds[2], 44, places=4)


class CameraAudioTests(unittest.TestCase):
    def test_camera_endpoints_and_virtual_canvas(self):
        camera = CanvasCamera(4)
        self.assertEqual(camera.origins[:2], [(0, 0), (1920, 0)])
        self.assertEqual(camera.virtual_size, (3840, 2160))
        self.assertEqual(CameraPose.interpolate(camera.pose(0), camera.pose(1), 0), camera.pose(0))
        self.assertEqual(CameraPose.interpolate(camera.pose(0), camera.pose(1), 1), camera.pose(1))
        values = [smootherstep(t) for t in np.linspace(0, 1, 50)]
        self.assertEqual(values, sorted(values))
        previous = camera.at(0, 5, 5)
        next_start = camera.at(1, 0, 5)
        self.assertAlmostEqual(previous.x, next_start.x)
        self.assertAlmostEqual(previous.width, next_start.width)

    def test_tile_composition(self):
        camera = CanvasCamera(2, 320, 180, enabled=False)
        colors = [Image.new("RGB", (320, 180), "red"), Image.new("RGB", (320, 180), "blue")]
        frame = camera.composite(camera.pose(1), lambda index: colors[index], 1)
        self.assertEqual(frame.getpixel((160, 90)), (0, 0, 255))

    def test_audio_exact_timing(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            clip = write_silence(folder / "clip.wav", 1)
            assemble_audio([(clip, .25, 2), (clip, .8, 3)], folder / "timeline.wav")
            with wave.open(str(folder / "timeline.wav"), "rb") as audio:
                self.assertEqual(audio.getnframes(), 5 * 48000)
            with self.assertRaises(ValueError):
                assemble_audio([(clip, .8, 1)], folder / "short.wav")

    def test_hand_matte_is_removed(self):
        hand = load_hand(ROOT / "assets" / "hand_marker.png")
        self.assertEqual(hand.mode, "RGBA")
        self.assertEqual(hand.getpixel((0, 0))[3], 0)
        self.assertGreater(np.asarray(hand)[:, :, 3].mean(), 20)

    def test_render_validation(self):
        for config in (RenderConfig(width=321), RenderConfig(fps=17), RenderConfig(accent="red"), RenderConfig(tts="gtts", offline=True)):
            with self.subTest(config=config), self.assertRaises(ValueError):
                config.validate()


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Install FFmpeg and FFprobe to run actual MP4 integration tests")
class PipelineIntegrationTests(unittest.TestCase):
    def render_sample(self, backend: str):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            assets = folder / "assets"
            shutil.copytree(ROOT / "assets", assets, ignore=shutil.ignore_patterns("cache"))
            script = {"title": "Water matters", "scenes": [{"text": "Save every drop.", "heading": "Every drop counts.", "primary_visual": "rainwater", "duration": 3}, {"text": "Help our farms grow.", "heading": "A greener tomorrow.", "primary_visual": "growth", "duration": 3}]}
            source = folder / "story.json"
            source.write_text(json.dumps(script), encoding="utf-8")
            output = folder / "sample.mp4"
            command = [sys.executable, str(ROOT / "run_studio.py"), "--json", str(source), "--output", str(output), "--assets", str(assets), "--width", "640", "--height", "360", "--fps", "24", "--offline", "--tts", backend, "--preset", "ultrafast", "--progress-json"]
            result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertGreater(output.stat().st_size, 5000)
            info = json.loads(subprocess.check_output([shutil.which("ffprobe"), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)], text=True))
            video = next(s for s in info["streams"] if s["codec_type"] == "video")
            audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
            self.assertEqual((video["width"], video["height"]), (640, 360))
            self.assertEqual(video["codec_name"], "h264")
            self.assertEqual(audio["codec_name"], "aac")
            manifest = json.loads(output.with_suffix(".manifest.json").read_text())
            self.assertEqual(int(video["nb_frames"]), manifest["frames"])
            self.assertAlmostEqual(float(info["format"]["duration"]), manifest["duration"], delta=.15)
            self.assertFalse(any(s["fallback"] for s in manifest["scenes"]))
            capture = cv2.VideoCapture(str(output))
            capture.set(cv2.CAP_PROP_POS_MSEC, 2400)
            ok, frame = capture.read(); capture.release()
            self.assertTrue(ok)
            self.assertGreater(int((frame.min(axis=2) < 130).sum()), 150)
            events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
            self.assertEqual(events[-1]["status"], "complete")

    def test_full_pipeline_silent(self):
        self.render_sample("none")

    @unittest.skipUnless(shutil.which("espeak-ng") or shutil.which("espeak"), "Install eSpeak NG to test offline narrated MP4")
    def test_full_pipeline_with_offline_narration(self):
        self.render_sample("local")

    @unittest.skipUnless(shutil.which("espeak-ng") or shutil.which("espeak"), "Install eSpeak NG for local speech synthesis")
    def test_hindi_local_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            clip = AudioGenerator(Path(folder), language="hi", backend="local", offline=True).generate("\u0939\u0930 \u092c\u0942\u0902\u0926 \u0905\u0928\u092e\u094b\u0932 \u0939\u0948\u0964")
            self.assertGreater(clip.duration, .5)


if __name__ == "__main__":
    unittest.main()