"""Streaming diagnostics: TTFB and tokens/sec for the vision extraction call."""
import base64
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "python"))
from openai import OpenAI
from drawing_detection.prompts.extract import EXTRACTION_PROMPT

ROOT = Path(__file__).parent
image_path = ROOT / "images" / "tests" / "test-001.png"

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

client = OpenAI(
    api_key=os.getenv("LLM_API_KEY"),
    base_url=os.getenv("LLM_BASE_URL"),
    timeout=300,
    max_retries=0,
)
model = os.getenv("LLM_MODEL")
b64 = base64.b64encode(image_path.read_bytes()).decode()
print(f"image {image_path.name}: {image_path.stat().st_size/1024:.0f}KB, base64 {len(b64)//1024}KB, json-mode prompt {len(EXTRACTION_PROMPT)} chars")

def stream_call(label, text, max_tokens, json_mode):
    messages = [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            {"type": "text", "text": text},
        ],
    }]
    kwargs = dict(model=model, messages=messages, temperature=0.0, max_tokens=max_tokens, stream=True)
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    t0 = time.perf_counter()
    first_token_at = None
    n_chunks = 0
    n_chars = 0
    content_chunks = []
    finish = None
    try:
        stream = client.chat.completions.create(**kwargs)
        for chunk in stream:
            if first_token_at is None:
                first_token_at = time.perf_counter()
            if chunk.choices and chunk.choices[0].delta.content:
                content_chunks.append(chunk.choices[0].delta.content)
                n_chars += len(chunk.choices[0].delta.content)
            if chunk.choices and chunk.choices[0].finish_reason:
                finish = chunk.choices[0].finish_reason
        total = time.perf_counter() - t0
        body = "".join(content_chunks)
        ttfb = first_token_at - t0 if first_token_at else None
        # estimate tokens from chars (~3.5 chars/token for mixed CJK/ASCII)
        est_tokens = max(1, n_chars / 3.5)
        gen_time = max(total - (ttfb or 0), 1e-9)
        print(f"  {label:<28} total={total:6.2f}s  ttfb={ttfb:6.2f}s  chars={n_chars:6d}  "
              f"est_tok={est_tokens:5.0f}  est_tok/s={est_tokens/gen_time:5.1f}  finish={finish}  n_chunks={n_chunks}")
        return body
    except Exception as e:
        print(f"  {label:<28} FAILED {type(e).__name__}: {e}")
        return ""

print("\n-- A. JSON mode, max_tokens=4096 (current production behavior) --")
body = stream_call("extract-json-4096", EXTRACTION_PROMPT, 4096, True)
print("  out[:120] =", repr(body[:120]))

print("\n-- B. Plain (no json mode), max_tokens=4096 --")
body = stream_call("extract-plain-4096", EXTRACTION_PROMPT, 4096, False)
print("  out[:120] =", repr(body[:120]))

print("\n-- C. JSON mode, max_tokens=1024 (smaller cap) --")
body = stream_call("extract-json-1024", EXTRACTION_PROMPT, 1024, True)
print("  out[:120] =", repr(body[:120]))

print("\n-- D. Text-only (no image), same extraction prompt, max_tokens=200 --")
t0 = time.perf_counter()
r = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "Reply with the single word: ok"}],
    temperature=0.0, max_tokens=10, stream=True,
)
ttfb = None
for chunk in r:
    if ttfb is None:
        ttfb = time.perf_counter() - t0
print(f"  text-only ttfb={ttfb:.2f}s total={time.perf_counter()-t0:.2f}s")