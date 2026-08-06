"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Header from "@/components/Header";
import ImageSelector from "@/components/ImageSelector";
import ImageComparison from "@/components/ImageComparison";
import DimensionTable from "@/components/DimensionTable";
import { withBasePath } from "@/lib/basePath";
import type { TestImage, DetectionResult } from "@/lib/types";

export default function Home() {
  const [images, setImages] = useState<TestImage[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    try {
      const res = await fetch(withBasePath("/api/detect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: targetFilename }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Detection failed");
      }

      const data = await res.json();

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
  }, [selectedImage, selectedIndex]);

  if (loading) {
    return (
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
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Header />

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Sidebar */}
        <ImageSelector
          images={images}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onUpload={handleUpload}
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
                  </div>

                  <button
                    className="btn-primary"
                    onClick={runDetection}
                    disabled={detecting}
                  >
                    {detecting ? (
                      <>
                        <div className="spinner" style={{ width: 16, height: 16 }} />
                        Detecting…
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
