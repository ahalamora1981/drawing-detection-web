"""Step-by-step latency diagnosis for LLM channel 1 (LLM_1_* env vars).

Isolates where time is spent, from bottom up:
  Step 0: DNS / TCP / TLS handshake
  Step 1: text-only chat, tiny reply        (pure model/queueing latency)
  Step 2: tiny 100x100 image vision call    (+ image upload/processing cost)
  Step 3: real drawing image, trivial question (+ large-payload cost)
  Step 4: real drawing image, full object/dimension recognition (production shape)

Each streaming call reports connect, TTFB and generation time separately.
"""
import base64
import io
import json
import os
import socket
import ssl
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT / "python"))

from openai import OpenAI
from PIL import Image

from drawing_detection.prompts.extract import EXTRACTION_PROMPT

# ------------------------------------------------------------------ env load
def load_env(path: Path) -> None:
    try:
        from dotenv import load_dotenv
        load_dotenv(path)
    except ImportError:
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()

load_env(ROOT / ".env")

API_KEY = os.getenv("LLM_1_API_KEY")
BASE_URL = os.getenv("LLM_1_BASE_URL")
MODEL = os.getenv("LLM_1_MODEL")
print("=" * 72)
print(f"LLM 通道一诊断   base_url = {BASE_URL}")
print(f"                 model    = {MODEL}")
print(f"                 api_key  = {API_KEY[:8]}..." if API_KEY else "api_key MISSING")
print("=" * 72)

parsed = urlparse(BASE_URL)
HOST, PORT = parsed.hostname, parsed.port or 443

TIMEOUT = float(os.getenv("BENCH_TIMEOUT", "120"))


def ts() -> str:
    return time.strftime("%H:%M:%S")


# ------------------------------------------------------------------ Step 0
print(f"\n[{ts()}] === Step 0: DNS + TCP + TLS 握手 (3 次) ===")
for i in range(1, 4):
    t0 = time.perf_counter()
    try:
        infos = socket.getaddrinfo(HOST, PORT, socket.AF_INET, socket.SOCK_STREAM)
        t_dns = time.perf_counter() - t0
        t0 = time.perf_counter()
        sock = socket.create_connection((infos[0][4][0], PORT), timeout=15)
        t_tcp = time.perf_counter() - t0
        t0 = time.perf_counter()
        ctx = ssl.create_default_context()
        ssock = ctx.wrap_socket(sock, server_hostname=HOST)
        t_tls = time.perf_counter() - t0
        ssock.close()
        print(f"  #{i}  dns={t_dns*1000:6.1f}ms  tcp={t_tcp*1000:7.1f}ms  tls={t_tls*1000:7.1f}ms")
    except Exception as e:
        print(f"  #{i}  FAILED after {time.perf_counter()-t0:.2f}s: {type(e).__name__}: {e}")

client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=TIMEOUT, max_retries=0)


# ------------------------------------------------------------------ helpers
def stream_call(label: str, content, max_tokens: int, json_mode=False) -> None:
    """Streaming call; prints connect/ttfb/gen breakdown."""
    kwargs = dict(
        model=MODEL,
        messages=[{"role": "user", "content": content}],
        temperature=0.0,
        max_tokens=max_tokens,
        stream=True,
    )
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}

    t0 = time.perf_counter()
    ttfb = gen_start = None
    n_chunks = n_chars = 0
    parts = []
    finish = None
    err = None
    try:
        stream = client.chat.completions.create(**kwargs)
        for chunk in stream:
            now = time.perf_counter()
            if ttfb is None:
                ttfb = now - t0
            if chunk.choices and chunk.choices[0].delta.content:
                if gen_start is None:
                    gen_start = now - t0
                parts.append(chunk.choices[0].delta.content)
                n_chars += len(chunk.choices[0].delta.content)
            if chunk.choices and chunk.choices[0].finish_reason:
                finish = chunk.choices[0].finish_reason
            n_chunks += 1
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
    total = time.perf_counter() - t0

    if err:
        print(f"  {label:<26} FAILED @{total:7.2f}s  {err}")
        return
    body = "".join(parts)
    gen_time = max(total - (gen_start or total), 1e-9)
    est_tok_s = (max(n_chars, 1) / 3.5) / gen_time if n_chars else 0.0
    print(
        f"  {label:<26} total={total:7.2f}s  ttfb={ttfb:6.2f}s  "
        f"gen={total-(gen_start or 0):6.2f}s  chars={n_chars:6d}  "
        f"tok/s~{est_tok_s:5.1f}  finish={finish}"
    )
    preview = body[:90].replace("\n", "\\n")
    print(f"  {'':<26} out[:90] = {preview!r}")


def img_b64(img_or_path) -> tuple[str, int]:
    """Return (base64 png data url body, raw bytes size)."""
    if isinstance(img_or_path, Path):
        raw = img_or_path.read_bytes()
    else:
        buf = io.BytesIO()
        img_or_path.save(buf, "PNG")
        raw = buf.getvalue()
    return base64.b64encode(raw).decode(), len(raw)


# ------------------------------------------------------------------ Step 1
print(f"\n[{ts()}] === Step 1: 纯文本最简提示词 (max_tokens=8, 3 次取波动) ===")
for i in range(1, 4):
    stream_call(f"text-only #{i}", "Reply with the single word: ok", 8)

# ------------------------------------------------------------------ Step 2
print(f"\n[{ts()}] === Step 2: 100x100 白图 vision 调用 (max_tokens=16) ===")
tiny_b64, tiny_size = img_b64(Image.new("RGB", (100, 100), (255, 255, 255)))
print(f"  payload: PNG {tiny_size} B, base64 {len(tiny_b64)//1024} KB")
stream_call(
    "vision-tiny",
    [
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{tiny_b64}"}},
        {"type": "text", "text": "What do you see? Reply with one short word."},
    ],
    16,
)

# ------------------------------------------------------------------ Step 3
print(f"\n[{ts()}] === Step 3: 真实图纸 test-001.png + 简单问题 (max_tokens=64) ===")
img_path = ROOT / "images" / "tests" / "test-001.png"
real_b64, real_size = img_b64(img_path)
im = Image.open(img_path)
print(f"  payload: {img_path.name} {real_size//1024} KB ({im.size[0]}x{im.size[1]}), base64 {len(real_b64)//1024} KB")
stream_call(
    "vision-real-simple",
    [
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{real_b64}"}},
        {"type": "text", "text": "Describe this image in one sentence."},
    ],
    64,
)

# ------------------------------------------------------------------ Step 4
print(f"\n[{ts()}] === Step 4: 真实图纸物体/尺寸识别 (生产 EXTRACTION_PROMPT, max_tokens=4096) ===")
print(f"  prompt chars: {len(EXTRACTION_PROMPT)}")
stream_call(
    "extract-full",
    [
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{real_b64}"}},
        {"type": "text", "text": EXTRACTION_PROMPT},
    ],
    4096,
)

# ------------------------------------------------------------------ Step 5
print(f"\n[{ts()}] === Step 5: 同上但非流式 (对照：是否流式导致挂起) ===")
t0 = time.perf_counter()
try:
    r = client.chat.completions.create(
        model=MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{real_b64}"}},
                    {"type": "text", "text": "List every dimension annotation you can find, as plain JSON."},
                ],
            }
        ],
        temperature=0.0,
        max_tokens=2048,
        stream=False,
    )
    dt = time.perf_counter() - t0
    out = r.choices[0].message.content or ""
    print(f"  non-stream-extract          total={dt:7.2f}s  chars={len(out)}  finish={r.choices[0].finish_reason}")
    print(f"  out[:90] = {out[:90]!r}")
except Exception as e:
    print(f"  non-stream-extract          FAILED @{time.perf_counter()-t0:.2f}s  {type(e).__name__}: {e}")

print(f"\n[{ts()}] === 完成 ===")
