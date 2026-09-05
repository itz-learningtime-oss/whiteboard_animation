#!/usr/bin/env python3
"""Optional loopback-only HTTP bridge for the React studio. No cloud required."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from typing import Literal

from run_studio import config_from_settings
from src.nlp_engine import ScriptParser

ROOT = Path(__file__).resolve().parent
JOB_ROOT = ROOT / "assets" / "cache" / "jobs"
LOCAL_ORIGIN = re.compile(r"https?://(?:localhost|127\.0\.0\.1)(?::\d+)?$")
EXTRA_ORIGINS: list[str] = []
JOBS_LOCK = threading.RLock()
PARSER_LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="scribble-render")


@dataclass
class Job:
    id: str
    folder: Path
    title: str
    status: str = "queued"
    progress: float = 0
    message: str = "Queued for your local renderer."
    created: float = 0
    process: subprocess.Popen | None = None


JOBS: dict[str, Job] = {}


def stop_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=10)
        else:
            os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, subprocess.SubprocessError):
        pass


@asynccontextmanager
async def lifespan(_app):
    JOB_ROOT.mkdir(parents=True, exist_ok=True)
    # Old render directories are local temporary artifacts, not permanent projects.
    for path in JOB_ROOT.iterdir():
        if path.is_dir() and time.time() - path.stat().st_mtime > 86400:
            shutil.rmtree(path, ignore_errors=True)
    yield
    with JOBS_LOCK:
        for job in JOBS.values():
            job.status = "cancelled"
            stop_process(job.process)
    EXECUTOR.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Scribble Local Whiteboard Engine", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=EXTRA_ORIGINS, allow_origin_regex=LOCAL_ORIGIN.pattern, allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type"], allow_credentials=False)


@app.middleware("http")
async def protect_local_engine(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and not LOCAL_ORIGIN.fullmatch(origin) and origin not in EXTRA_ORIGINS:
        return JSONResponse({"detail": "This origin is not allowed to use your local renderer."}, status_code=403)
    if request.method == "POST":
        data = await request.body()
        if len(data) > 100_000:
            return JSONResponse({"detail": "Script payload exceeds 100 KB."}, status_code=413)
    return await call_next(request)


@app.get("/health")
def health():
    checks = {"ffmpeg": bool(shutil.which("ffmpeg")), "ffprobe": bool(shutil.which("ffprobe")), "spacy_model": importlib.util.find_spec("en_core_web_sm") is not None, "offline_voice": bool(shutil.which("espeak-ng") or shutil.which("espeak") or sys.platform in {"win32", "darwin"}), "hand": (ROOT / "assets" / "hand_marker.png").is_file()}
    return {"engine": "scribble-whiteboard", "version": "1.0.0", "ready": all(checks.values()), "checks": checks, "offline": True}


class ParseRequest(BaseModel):
    text: str = Field(min_length=1, max_length=30000)
    language: Literal["en", "hi"] = "en"


@app.post("/parse")
def parse_script(payload: ParseRequest):
    try:
        with PARSER_LOCK:
            return ScriptParser(payload.language).parse_text(payload.text).to_dict()
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def run_job(job: Job) -> None:
    with JOBS_LOCK:
        if job.status == "cancelled":
            return
        job.status, job.message = "rendering", "Starting the local renderer."
    log = job.folder / "render.log"
    try:
        with log.open("w", encoding="utf-8") as errors:
            process = subprocess.Popen([sys.executable, str(ROOT / "run_studio.py"), "--json", str(job.folder / "story.json"), "--output", str(job.folder / "video.mp4"), "--offline", "--progress-json"], cwd=ROOT, stdout=subprocess.PIPE, stderr=errors, text=True, encoding="utf-8", start_new_session=os.name != "nt")
            with JOBS_LOCK:
                job.process = process
                if job.status == "cancelled":
                    stop_process(process)
            timer = threading.Timer(1800, lambda: stop_process(process))
            timer.daemon = True; timer.start()
            try:
                assert process.stdout is not None
                for line in process.stdout:
                    try:
                        event = json.loads(line)
                        with JOBS_LOCK:
                            job.progress = min(1, max(0, float(event.get("progress", job.progress))))
                            job.message = str(event.get("message", job.message))[:500]
                    except (ValueError, TypeError):
                        continue
                result = process.wait(timeout=30)
            finally:
                timer.cancel()
                if process.stdout:
                    process.stdout.close()
        with JOBS_LOCK:
            if job.status == "cancelled":
                job.message = "Render cancelled."
            elif result == 0 and (job.folder / "video.mp4").is_file():
                job.status, job.progress, job.message = "complete", 1, "Your narrated MP4 is ready."
            else:
                job.status = "error"
                job.message = log.read_text(encoding="utf-8", errors="replace")[-2000:] or "The renderer stopped or exceeded the 30-minute job limit."
    except Exception as exc:
        stop_process(job.process)
        with JOBS_LOCK:
            if job.status != "cancelled":
                job.status, job.message = "error", str(exc)[:2000]


@app.post("/render", status_code=202)
def start_render(payload: dict):
    try:
        script = ScriptParser().parse_json(payload)
        config = config_from_settings(script.settings)
        config.offline = True
        config.validate()
        if sum(s.duration or max(4, len(s.text.split()) / 2.3) for s in script.scenes) > 1200:
            raise ValueError("The local web service limits each video to 20 minutes. Use the CLI for longer jobs.")
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    with JOBS_LOCK:
        if sum(job.status in {"queued", "rendering"} for job in JOBS.values()) >= 3:
            raise HTTPException(status_code=429, detail="Three renders are already queued. Wait or cancel one before starting another.")
        for key, old in list(JOBS.items()):
            if time.time() - old.created > 86400 and old.status not in {"queued", "rendering"}:
                shutil.rmtree(old.folder, ignore_errors=True); del JOBS[key]
        identity = uuid.uuid4().hex
        folder = JOB_ROOT / identity
        folder.mkdir(parents=True)
        (folder / "story.json").write_text(json.dumps(script.to_dict(), ensure_ascii=False), encoding="utf-8")
        job = Job(identity, folder, script.title, created=time.time())
        JOBS[identity] = job
        EXECUTOR.submit(run_job, job)
    return {"id": identity, "status": "queued"}


def get_job(identity: str) -> Job:
    with JOBS_LOCK:
        job = JOBS.get(identity)
    if job is None:
        raise HTTPException(status_code=404, detail="Render job not found. It may have expired or the engine was restarted.")
    return job


@app.get("/jobs/{identity}")
def job_status(identity: str):
    job = get_job(identity)
    with JOBS_LOCK:
        return {"id": job.id, "status": job.status, "progress": job.progress, "message": job.message}


@app.delete("/jobs/{identity}")
def cancel_job(identity: str):
    job = get_job(identity)
    with JOBS_LOCK:
        if job.status in {"queued", "rendering"}:
            job.status, job.message = "cancelled", "Cancelling the renderer."
            stop_process(job.process)
    return {"status": job.status}


@app.get("/jobs/{identity}/download")
def download(identity: str):
    job = get_job(identity)
    if job.status != "complete" or not (job.folder / "video.mp4").is_file():
        raise HTTPException(status_code=409, detail="This video is not ready for download.")
    name = re.sub(r"[^a-zA-Z0-9_-]+", "-", job.title).strip("-")[:100] or "whiteboard-story"
    return FileResponse(job.folder / "video.mp4", media_type="video/mp4", filename=f"{name}.mp4")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Connect the Scribble web studio to your local Python renderer")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--allow-origin", action="append", default=[], help="Explicit trusted web origin; local origins are already allowed")
    arguments = parser.parse_args()
    for origin in arguments.allow_origin:
        if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(?::\d+)?", origin):
            parser.error("Provide an exact http(s) origin without a path or wildcard.")
        EXTRA_ORIGINS.append(origin)
    uvicorn.run(app, host="127.0.0.1", port=arguments.port, log_level="info")