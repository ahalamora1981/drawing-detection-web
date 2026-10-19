"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Header from "@/components/Header";
import ImageSelector from "@/components/ImageSelector";
import ImageComparison from "@/components/ImageComparison";
import DimensionTable from "@/components/DimensionTable";
import { withBasePath } from "@/lib/basePath";
import type { TestImage, DetectionResult } from "@/lib/types";

// The whole app is gated by a PIN. The PIN is checked SERVER-SIDE
// (APP_PIN in .env): the client validates it once per page load via
// /api/verify-pin and keeps the result in memory only, so every page
// refresh shows the PIN pop-up again.
//
// Feature flag: set to true to re-enable the PIN gate pop-up.
const PIN_VERIFICATION_ENABLED = false;

// Display name for an LLM channel (1 = local STG server, 2 = SaaS API).
const channelName = (ch: number) => (ch === 2 ? "LLM（SaaS）" : "LLM（本地）");

export default function Home() {
  const [images, setImages] = useState<TestImage[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Default to the SaaS API; the user can switch to the local server in
  // the sidebar selector.
  const [channel, setChannel] = useState<number>(2);
  // App-wide PIN gate: verified once per page load via /api/verify-pin.
  // The result lives only in memory, so every page refresh shows the
  // PIN pop-up again. Wrong/cancelled PIN keeps the gate closed.
  const [unlocked, setUnlocked] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown when the backend automatically failed over to the other LLM
  // channel because the selected one was too slow.
  const [channelNote, setChannelNote] = useState<string | null>(null);

  // Live timer value (0.1s precision) while a detection is running.
  const [elapsed, setElapsed] = useState(0);

  // Final detection time recorded per sample (filename -> seconds). Each
  // sample keeps its own timer: switching samples never wipes another
  // sample's recorded time. A page refresh clears everything.
  const [timings, setTimings] = useState<Record<string, number>>({});

  // Filename currently being detected (survives sample switches mid-run).
  const [detectingFilename, setDetectingFilename] = useState<string | null>(null);

  const timerStartRef = useRef<number | null>(null);

  // Session id lives only in JS memory (no cookie/localStorage), so a page
  // refresh starts a fresh session and clears the user's uploads from view.
  const sessionRef = useRef<string | null>(null);
  if (!sessionRef.current) {
    sessionRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const uploadedCount =
    images.filter((img) => img.source === "upload").length;

  // Channel switch handler: both channels are freely selectable now (the
  // PIN gate protects the whole page, not a single channel).
  const handleChannelChange = useCallback((value: number) => {
    setChannel(value);
  }, []);

  const submitPin = async () => {
    const entered = pinInput.trim();
    if (!entered) {
      setPinError("请输入 PIN。");
      return;
    }
    setVerifying(true);
    setPinError(null);
    try {
      const res = await fetch(withBasePath("/api/verify-pin"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: entered }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "PIN 错误。");
      }
      // Success is memory-only: a page refresh re-arms the gate.
      setUnlocked(true);
      setPinInput("");
      setPinError(null);
    } catch (err) {
      // Wrong PIN: keep the gate closed, allow retry.
      setPinError(err instanceof Error ? err.message : "PIN 错误。");
      setPinInput("");
    } finally {
      setVerifying(false);
    }
  };

  // Upload a single image (click-to-browse or drag & drop).
  const handleUpload = useCallback(
    async (file: File) => {
      if (!file) return;
      const isPng = file.type === "image/png";
      const isJpg = file.type === "image/jpeg";
      if (!isPng && !isJpg) {
        setError("Only PNG and JPG images are allowed.");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError("Image must be 10 MB or smaller.");
        return;
      }
      if (uploadedCount >= 5) {
        setError(
          "Maximum 5 uploads per session. Refresh the page to upload more."
        );
        return;
      }

      setError(null);
      const form = new FormData();
      form.append("file", file);
      form.append("session", sessionRef.current!);

      try {
        const res = await fetch(withBasePath("/api/upload"), {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Upload failed");
        }
        // Append the new image and auto-select it.
        setImages((prev) => {
          const updated = [...prev, data.image];
          setSelectedIndex(updated.length - 1);
          return updated;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    },
    [uploadedCount]
  );

  // Tick the live timer while a detection is running; stopped on completion.
  useEffect(() => {
    if (!detecting) return;
    const start = Date.now();
    timerStartRef.current = start;
    const interval = setInterval(() => {
      setElapsed((Date.now() - start) / 1000);
    }, 100);
    return () => {
      clearInterval(interval);
      timerStartRef.current = null;
    };
  }, [detecting]);

  // Fetch image list on mount
  useEffect(() => {
    async function fetchImages() {
      try {
        const res = await fetch(
          withBasePath(`/api/images?session=${sessionRef.current}`)
        );
        if (!res.ok) throw new Error("Failed to load images");
        const data = await res.json();
        setImages(data.images);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load images");
      } finally {
        setLoading(false);
      }
    }
    fetchImages();
  }, []);

  const selectedImage = images[selectedIndex];
  const result: DetectionResult | null = selectedImage?.result ?? null;

  // Show the live ticking timer only for the sample currently being detected;
  // otherwise show that sample's last recorded detection time.
  const isDetectingThisSample =
    detecting && !!selectedImage && detectingFilename === selectedImage.filename;
  const displayElapsed = isDetectingThisSample
    ? elapsed
    : selectedImage
      ? (timings[selectedImage.filename] ?? 0)
      : 0;

  // Run detection on current image
  const runDetection = useCallback(async () => {
    if (!selectedImage) return;
    // Capture the target now so the elapsed time is recorded on this sample
    // even if the user switches to another sample while detection runs.
    const targetFilename = selectedImage.filename;
    setDetecting(true);
    setDetectingFilename(targetFilename);
    setElapsed(0);
    setError(null);
    setChannelNote(null);

    try {
      const res = await fetch(withBasePath("/api/detect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: targetFilename,
          channel,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Detection failed");
      }

      const data = await res.json();

      if (
        typeof data.channelUsed === "number" &&
        data.channelUsed !== channel
      ) {
        setChannelNote(
          `已自动切换到 ${channelName(data.channelUsed)}（所选通道响应过慢）。`
        );
      } else {
        setChannelNote(null);
      }

      // Cache-bust: ensure the annotated image URL changes so the browser
      // fetches the freshly drawn bounding boxes instead of a cached copy.
      const baseUrl =
        data.annotatedUrl ||
        withBasePath(`/api/annotated?name=${encodeURIComponent(selectedImage.filename)}`);
      const freshAnnotatedUrl = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;

      // Update the image data with new results
      setImages((prev) => {
        const updated = [...prev];
        updated[selectedIndex] = {
          ...updated[selectedIndex],
          result: data.result,
          annotatedUrl: freshAnnotatedUrl,
        };
        return updated;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Detection failed");
    } finally {
      // Record the precise final elapsed time on this sample
      const finalTime =
        timerStartRef.current !== null
          ? (Date.now() - timerStartRef.current) / 1000
          : 0;
      setTimings((prev) => ({ ...prev, [targetFilename]: finalTime }));
      setDetectingFilename(null);
      setDetecting(false);
    }
  }, [selectedImage, selectedIndex, channel]);

  // App-wide PIN pop-up: shown on every page refresh until verified. The
  // underlying app is inert while locked, so it cannot be interacted with.
  const pinGate = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(20, 20, 19, 0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        style={{
          width: 360,
          maxWidth: "90vw",
          backgroundColor: "var(--color-surface-card)",
          borderRadius: 12,
          border: "1px solid var(--color-hairline)",
          padding: 24,
          boxShadow: "0 16px 48px rgba(0, 0, 0, 0.2)",
        }}
      >
        <h3
          id="pin-dialog-title"
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: "var(--color-ink)",
            margin: "0 0 8px",
          }}
        >
          PIN 验证
        </h3>
        <p
          style={{
            fontSize: 13,
            color: "var(--color-muted)",
            lineHeight: 1.6,
            margin: "0 0 16px",
          }}
        >
          该页面受 PIN 保护。请输入 PIN 解锁；每次刷新页面后需重新验证。
        </p>
        <input
          type="password"
          autoFocus
          value={pinInput}
          onChange={(e) => setPinInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitPin();
          }}
          placeholder="请输入 PIN"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            fontSize: 16,
            letterSpacing: "0.2em",
            color: "var(--color-ink)",
            backgroundColor: "var(--color-canvas)",
            border: `1px solid ${
              pinError
                ? "var(--color-error)"
                : "var(--color-hairline-strong, var(--color-muted-soft))"
            }`,
            borderRadius: 8,
            outline: "none",
          }}
        />
        {pinError && (
          <p
            style={{
              fontSize: 13,
              color: "var(--color-error)",
              margin: "8px 0 0",
            }}
          >
            {pinError}
          </p>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 20,
          }}
        >
          <button
            className="btn-primary"
            onClick={submitPin}
            disabled={verifying}
          >
            {verifying ? "验证中…" : "确认"}
          </button>
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <>
        <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
          <Header />
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div className="spinner" style={{ width: 32, height: 32 }} />
          <span style={{ color: "var(--color-muted)", fontSize: 14 }}>
            Loading test samples…
          </span>
        </div>
      </div>

      {/* App-wide PIN pop-up — shows on every page refresh. */}
      {PIN_VERIFICATION_ENABLED && !unlocked && pinGate}
      </>
    );
  }

  return (
    <>
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
        inert={PIN_VERIFICATION_ENABLED && !unlocked}
      >
        <Header />

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Sidebar */}
        <ImageSelector
          images={images}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onUpload={handleUpload}
          channel={channel}
          onChannelChange={handleChannelChange}
        />

        {/* Main content */}
        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 32,
          }}
        >
          {selectedImage && (
            <div className="animate-fade-in" key={selectedImage.filename}>
              {/* Page title */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 24,
                }}
              >
                <div>
                  <h1
                    className="font-display"
                    style={{
                      fontSize: 28,
                      color: "var(--color-ink)",
                      margin: 0,
                      letterSpacing: "-0.3px",
                    }}
                  >
                    {selectedImage.displayName}
                  </h1>
                  <p
                    style={{
                      fontSize: 14,
                      color: "var(--color-muted)",
                      margin: "4px 0 0",
                    }}
                  >
                    {selectedImage.filename}
                  </p>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 24,
                  }}
                >
                  {/* Timer + expected duration hint (left of the button) */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: 4,
                    }}
                  >
                    {/* Detection timer (0.1s precision) */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontFamily: '"JetBrains Mono", monospace',
                        fontSize: 24,
                        fontWeight: 500,
                        letterSpacing: "-0.5px",
                        lineHeight: 1,
                        color: isDetectingThisSample
                          ? "var(--color-primary)"
                          : "var(--color-muted)",
                      }}
                    >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <circle
                          cx="8"
                          cy="8"
                          r="6.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        />
                        <path
                          d="M8 4.5V8l2.5 1.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                      {displayElapsed.toFixed(1)}s
                    </div>

                    {/* Expected duration hint */}
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--color-muted-soft)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Detection may take 10&ndash;20 seconds, it may take longer for the first run.
                    </div>

                    {/* Automatic channel failover note */}
                    {channelNote && (
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--color-warning)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {channelNote}
                      </div>
                    )}
                  </div>

                  <button
                    className="btn-primary"
                    onClick={runDetection}
                    disabled={detecting}
                  >
                    {detecting ? (
                      <>
                        <div className="spinner" style={{ width: 16, height: 16 }} />
                        {`正在连接 ${channelName(channel)}…`}
                      </>
                    ) : (
                      <>
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 16 16"
                          fill="none"
                        >
                          <path
                            d="M8 2v12M2 8h12"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                        Run Detection
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Error banner */}
              {error && (
                <div
                  style={{
                    backgroundColor: "rgba(198, 69, 69, 0.08)",
                    border: "1px solid rgba(198, 69, 69, 0.2)",
                    borderRadius: 8,
                    padding: "12px 16px",
                    marginBottom: 24,
                    fontSize: 14,
                    color: "var(--color-error)",
                  }}
                >
                  {error}
                </div>
              )}

              {/* Summary cards */}
              {result && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 16,
                    marginBottom: 24,
                  }}
                >
                  <SummaryCard
                    label="Dimensions Found"
                    value={result.total_detected}
                    color="var(--color-primary)"
                  />
                  <SummaryCard
                    label="Needs Review"
                    value={result.needs_review_count}
                    color={
                      result.needs_review_count > 0
                        ? "var(--color-warning)"
                        : "var(--color-success)"
                    }
                  />
                  <SummaryCard
                    label="Image Size"
                    value={`${result.image_width}×${result.image_height}`}
                    color="var(--color-muted)"
                  />
                  <SummaryCard
                    label="Avg Confidence"
                    value={
                      result.dimensions.length > 0
                        ? `${(
                            (result.dimensions.reduce(
                              (sum, d) => sum + d.confidence,
                              0
                            ) /
                              result.dimensions.length) *
                            100
                          ).toFixed(0)}%`
                        : "—"
                    }
                    color="var(--color-accent-teal)"
                  />
                </div>
              )}

              {/* Image comparison */}
              <div
                style={{
                  backgroundColor: "var(--color-surface-card)",
                  borderRadius: 12,
                  padding: 24,
                  marginBottom: 24,
                }}
              >
                <ImageComparison
                  originalUrl={selectedImage.fullUrl}
                  annotatedUrl={selectedImage.annotatedUrl || selectedImage.fullUrl}
                  imageName={selectedImage.displayName}
                />
              </div>

              {/* Detection results */}
              {result && (
                <div
                  style={{
                    backgroundColor: "var(--color-surface-card)",
                    borderRadius: 12,
                    padding: 24,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 16,
                    }}
                  >
                    <h2
                      style={{
                        fontSize: 18,
                        fontWeight: 500,
                        color: "var(--color-ink)",
                        margin: 0,
                      }}
                    >
                      Detected Dimensions
                    </h2>
                    <div
                      style={{
                        display: "flex",
                        gap: 12,
                        fontSize: 12,
                        color: "var(--color-muted)",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            backgroundColor: "var(--dim-linear)",
                          }}
                        />
                        Linear
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            backgroundColor: "var(--dim-diameter)",
                          }}
                        />
                        Diameter
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            backgroundColor: "var(--dim-angle)",
                          }}
                        />
                        Angle
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            backgroundColor: "var(--dim-radius)",
                          }}
                        />
                        Radius
                      </span>
                    </div>
                  </div>

                  <DimensionTable dimensions={result.dimensions} />
                </div>
              )}

              {/* Empty state */}
              {!result && !detecting && (
                <div
                  style={{
                    backgroundColor: "var(--color-surface-card)",
                    borderRadius: 12,
                    padding: 64,
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: "50%",
                      backgroundColor: "var(--color-surface-soft)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      margin: "0 auto 16px",
                    }}
                  >
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <path
                        d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                        stroke="var(--color-muted)"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                  <h3
                    style={{
                      fontSize: 16,
                      fontWeight: 500,
                      color: "var(--color-body-strong)",
                      margin: "0 0 8px",
                    }}
                  >
                    No detection results
                  </h3>
                  <p
                    style={{
                      fontSize: 14,
                      color: "var(--color-muted)",
                      margin: "0 0 20px",
                    }}
                  >
                    Click &ldquo;Run Detection&rdquo; to analyze this drawing.
                  </p>
                  <button className="btn-primary" onClick={runDetection}>
                    Run Detection
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

    </div>

    {/* App-wide PIN pop-up — shows on every page refresh. */}
    {PIN_VERIFICATION_ENABLED && !unlocked && pinGate}
    </>
  );
}

// Summary card component
function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div
      style={{
        backgroundColor: "var(--color-surface-card)",
        borderRadius: 12,
        padding: "16px 20px",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--color-muted)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 400,
          fontFamily: '"Cormorant Garamond", serif',
          color,
          letterSpacing: "-0.5px",
        }}
      >
        {value}
      </div>
    </div>
  );
}
