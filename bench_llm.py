"""Benchmark LLM latency for the drawing detection pipeline."""
import base64
import json
import os
import sys
import time
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "python"))

from openai import OpenAI
from PIL import Image

from drawing_detection.detector import DrawingDetector

ROOT = Path(__file__).parent
TESTS = ROOT / "images" / "tests"

def load_env(path: Path) -> None:
    try:
        from dotenv import load_dotenv
        load_dotenv(path)
    except ImportError:
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

load_env(ROOT / ".env")

API_KEY = os.getenv("LLM_API_KEY")
BASE_URL = os.getenv("LLM_BASE_URL")
MODEL = os.getenv("LLM_MODEL")
print(f"base_url = {BASE_URL}")
print(f"model    = {MODEL}")
print(f"api_key  = {API_KEY[:8]}..." if API_KEY else "api_key  = MISSING")

# ---------------------------------------------------------------- 1. text-only
print("\n=== 1. Text-only chat (raw model latency, 1 token-ish reply) ===")
client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=300, max_retries=0)
t0 = time.perf_counter()
try:
    r = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "Reply with the single word: ok"}],
        temperature=0.0,
        max_tokens=10,
    )
    dt = time.perf_counter() - t0
    print(f"  reply={r.choices[0].message.content!r} elapsed={dt:.2f}s")
except Exception as e:
    print(f"  FAILED after {time.perf_counter()-t0:.2f}s: {type(e).__name__}: {e}")

# ---------------------------------------------------------------- 2. tiny image
print("\n=== 2. Tiny 100x100 image vision call ===")
tiny = Image.new("RGB", (100, 100), (255, 255, 255))
buf = BytesIO()
tiny.save(buf, "PNG")
b64 = base64.b64encode(buf.getvalue()).decode()
t0 = time.perf_counter()
try:
    r = client.chat.completions.create(
        model=MODEL,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                {"type": "text", "text": "What text is in this image? Reply with only EMPTY."},
            ],
        }],
        temperature=0.0,
        max_tokens=10,
    )
    dt = time.perf_counter() - t0
    print(f"  reply={r.choices[0].message.content!r} elapsed={dt:.2f}s")
except Exception as e:
    print(f"  FAILED after {time.perf_counter()-t0:.2f}s: {type(e).__name__}: {e}")

# ---------------------------------------------------------------- 3. full detect
print("\n=== 3. Full detection with per-call timing (test-001.png) ===")
image_path = TESTS / "test-001.png"
print(f"  image: {image_path} ({image_path.stat().st_size/1024:.0f} KB)")
img = Image.open(image_path)
print(f"  size:  {img.size}")
image_b64 = base64.b64encode(image_path.read_bytes()).decode()

detector = DrawingDetector()
orig_call = detector._call_llm
calls = []

def timed_call(image_b64_in, media_type, retry=False, prompt=None, json_mode=True, max_tokens=4096):
    t0 = time.perf_counter()
    out = orig_call(image_b64_in, media_type, retry=retry, prompt=prompt,
                    json_mode=json_mode, max_tokens=max_tokens)
    dt = time.perf_counter() - t0
    tag = "verify-crop" if prompt else ("extract-retry" if retry else "extract")
    calls.append((tag, dt, max_tokens, len(out)))
    print(f"    [{tag:>13}] {dt:6.2f}s  max_tokens={max_tokens:<5} in_image={len(image_b64_in)//1024}KB chars out={len(out)}")
    return out

detector._call_llm = lambda *a, **kw: timed_call(*a, **kw)

t0 = time.perf_counter()
result = detector.detect(image_path)
total = time.perf_counter() - t0
print(f"  TOTAL detection: {total:.2f}s")
print(f"  dimensions={result.total_detected} needs_review={result.needs_review_count}")
total_llm = sum(dt for _, dt, _, _ in calls)
print(f"  LLM wall time across {len(calls)} call(s): {total_llm:.2f}s")
print(f"  non-LLM (CV/parse) overhead: {total-total_llm:.2f}s")