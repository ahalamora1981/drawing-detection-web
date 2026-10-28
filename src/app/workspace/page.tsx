"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import BoxCanvas from "@/components/BoxCanvas";
import DimensionTable from "@/components/DimensionTable";
import StepBar, { type StepState } from "@/components/StepBar";
import { withBasePath } from "@/lib/basePath";
import { apiFetch, ApiError, readApiError } from "@/lib/api";
import { getSessionId } from "@/lib/session";
import { DIMENSION_COLORS } from "@/lib/constants";
import { errorText, useI18n, type Translate } from "@/lib/i18n";
import type { RunConfig, RunState } from "@/lib/types";

const DEFAULT_CONFIG: RunConfig = {
  scope: "dimensions",
  density: "standard",
  excludeTitleBlock: true,
};

const channelLabel = (ch: number, t: Translate) =>
  ch === 1 ? t("ws.settings.channel.local") : t("ws.settings.channel.saas");

const channelShort = (ch: number, t: Translate) =>
  ch === 1 ? t("ws.channel.short.local") : t("ws.channel.short.saas");

function WorkspaceInner() {
  const router = useRouter();
  const search = useSearchParams();
  const runIdParam = search.get("run");
  const imageParam = search.get("image");

  const { t } = useI18n();
  const [session, setSession] = useState("");
  const [run, setRun] = useState<RunState | null>(null);
  const [image, setImage] = useState<{
    filename: string;
    originalName: string | null;
    displayName: string;
    fullUrl: string;
  } | null>(null);
  const [config, setConfig] = useState<RunConfig>(DEFAULT_CONFIG);
  const [channel, setChannel] = useState(2);
  const [view, setView] = useState<"original" | "locate" | "result">("locate");
  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const initialized = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSession(getSessionId());
  }, []);

  const applyRun = useCallback((next: RunState) => {
    setRun(next);
    setConfig(next.config);
    setChannel(next.channel);
    setImage({
      filename: next.filename,
      originalName: next.originalName ?? null,
      displayName: next.displayName,
      fullUrl: withBasePath(`/api/image?name=${encodeURIComponent(next.filename)}`),
    });
  }, []);

  // Initial load: either an existing run (?run=) or a fresh drawing (?image=).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (runIdParam) {
          const res = await apiFetch(`/api/runs/${runIdParam}`);
          if (!res.ok) throw await readApiError(res);
          const data = await res.json();
          if (cancelled) return;
          applyRun(data.run);
          setView(data.run.dimensions.length > 0 ? "result" : "locate");
        } else if (imageParam) {
          const res = await apiFetch(
            `/api/images?session=${encodeURIComponent(session)}`
          );
          const data = await res.json();
          const all = [...(data.uploads ?? []), ...(data.images ?? [])];
          const found = all.find(
            (item: { filename: string }) => item.filename === imageParam
          );
          if (!found) throw new ApiError("image_not_found", "");
          if (found.run?.id) {
            router.replace(`/workspace?run=${encodeURIComponent(found.run.id)}`);
            return;
          }
          if (cancelled) return;
          setImage({
            filename: found.filename,
            originalName: found.originalName ?? null,
            displayName: found.displayName,
            fullUrl: found.fullUrl,
          });
          setView("locate");
        } else {
          router.replace("/");
          return;
        }
        initialized.current = true;
      } catch (err) {
        if (!cancelled) setError(errorText(t, err as Error, "ws.error.load"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, runIdParam, imageParam]);

  const refresh = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/runs/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setRun(data.run);
    } catch {
      /* transient poll failure: the next tick retries */
    }
  }, []);

  const busyStage =
    !!run &&
    (run.stage === "queued" ||
      run.stage === "locating" ||
      run.stage === "reading" ||
      !!run.queue);

  // Poll while a stage is running. The Python side writes progress.json; the
  // API folds it into the run so the table fills in row by row.
  useEffect(() => {
    if (!run || !busyStage) return;
    const id = run.id;
    const timer = setInterval(() => refresh(id), 800);
    return () => clearInterval(timer);
  }, [run?.id, busyStage, refresh]);

  // Follow the stage with the view toggle: located → boxes, reading/done →
  // coloured results.
  const prevStage = useRef<string | null>(null);
  useEffect(() => {
    if (!run) return;
    if (prevStage.current === run.stage) return;
    prevStage.current = run.stage;
    if (run.stage === "located") setView("locate");
    if (run.stage === "reading") setView("result");
    if (run.stage === "done") setView("result");
  }, [run]);

  // When the read stage finishes, bring the table into view: otherwise the
  // canvas fills the screen and the new rows are easy to miss.
  useEffect(() => {
    if (run?.stage === "done") {
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [run?.stage]);

  const locate = useCallback(async () => {
    if (!image || !session) return;
    setError(null);
    try {
      const res = await apiFetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session,
          filename: image.filename,
          config,
          channel,
          runId: run?.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.run) applyRun(data.run);
        throw new ApiError(data.code, data.error);
      }
      applyRun(data.run);
      setSelectedId(null);
      if (!run) {
        router.replace(`/workspace?run=${encodeURIComponent(data.run.id)}`);
      }
    } catch (err) {
      setError(errorText(t, err as Error, "ws.error.locate"));
    }
  }, [image, session, config, channel, run, router, applyRun]);

  const read = useCallback(async () => {
    if (!run) return;
    setError(null);
    try {
      const res = await apiFetch(`/api/runs/${run.id}/read`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new ApiError(data.code, data.error);
      setRun(data.run);
      setView("result");
    } catch (err) {
      setError(errorText(t, err as Error, "ws.error.read"));
    }
  }, [run]);

  const saveBoxes = useCallback(
    async (boxes: RunState["boxes"]) => {
      if (!run) return;
      try {
        const res = await apiFetch(`/api/runs/${run.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boxes }),
        });
        const data = await res.json();
        if (!res.ok) throw new ApiError(data.code, data.error);
        setRun(data.run);
      } catch (err) {
        setError(errorText(t, err as Error, "ws.error.saveBoxes"));
      }
    },
    [run]
  );

  const addBox = useCallback(
    (box: { x: number; y: number; w: number; h: number }) => {
      if (!run) return;
      saveBoxes([...run.boxes, { id: "", ...box }]);
    },
    [run, saveBoxes]
  );

  const deleteBox = useCallback(
    (id: string) => {
      if (!run) return;
      setSelectedId((current) => (current === id ? null : current));
      saveBoxes(run.boxes.filter((b) => b.id !== id));
    },
    [run, saveBoxes]
  );

  // Delete key removes the selected box (never while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!selectedId || busyStage) return;
      e.preventDefault();
      deleteBox(selectedId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, busyStage, deleteBox]);

  const located =
    !!run &&
    (run.boxes.length > 0 ||
      run.locateMs !== null ||
      ["located", "reading", "done"].includes(run.stage));
  const readDone = !!run && run.stage === "done";

  const steps: StepState[] = useMemo(
    () => [
      {
        label: t("ws.step.locate"),
        state: located ? "done" : run?.stage === "locating" || run?.stage === "queued" ? "active" : "active",
      },
      {
        label: t("ws.step.read"),
        state: readDone ? "done" : located ? "active" : "todo",
      },
      {
        label: t("ws.step.review"),
        state: readDone ? "active" : "todo",
      },
    ],
    [located, readDone, run?.stage, t]
  );

  const dimensions = run?.dimensions ?? [];
  const reviewCount = dimensions.filter((d) => d.needs_review).length;
  const boxesForCanvas = run?.boxes ?? [];
  const showResult = view === "result";
  const editable = !!run && !busyStage && !!image;

  const statusText = (() => {
    if (!run) return t("ws.status.idle");
    if (run.stage === "queued")
      return run.queue
        ? t("ws.status.queued", { n: run.queue.position })
        : t("ws.status.queuedShort");
    if (run.stage === "locating") return t("ws.status.locating");
    if (run.stage === "reading")
      return t("ws.status.reading", {
        done: run.progress.done,
        total: run.progress.total,
      });
    if (run.stage === "located")
      return t("ws.status.located", { n: run.boxes.length });
    if (run.stage === "done") return t("ws.status.done");
    return t("ws.status.failed");
  })();

  // Fetch the rendered PNG and save it as a blob: this way a server-side
  // failure surfaces as a message instead of silently handing back the
  // original drawing.
  const downloadAnnotated = useCallback(async () => {
    if (!run) return;
    setExporting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/runs/${run.id}/image?variant=annotated`);
      if (!res.ok) throw await readApiError(res);
      const blob = await res.blob();
      if (blob.size === 0) throw new ApiError("export_failed", "");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(run.displayName || "drawing")
        .toLowerCase()
        .replace(/\s+/g, "-")}-annotated.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorText(t, err as Error, "ws.error.export"));
    } finally {
      setExporting(false);
    }
  }, [run, t]);

  const exportCsv = () => {
    if (!run || dimensions.length === 0) return;
    const header = [
      "id",
      "raw_text",
      "nominal_value",
      "tolerance",
      "tolerance_plus",
      "tolerance_minus",
      "unit",
      "dimension_type",
      "feature",
      "confidence",
      "needs_review",
    ];
    const rows = dimensions.map((d) =>
      [
        d.item_id,
        `"${d.raw_text.replace(/"/g, '""')}"`,
        d.nominal_value,
        d.tolerance ?? "",
        d.tolerance_plus ?? "",
        d.tolerance_minus ?? "",
        d.unit,
        d.dimension_type,
        `"${d.feature_classification}"`,
        d.confidence,
        d.needs_review ? "yes" : "no",
      ].join(",")
    );
    const blob = new Blob([[header.join(","), ...rows].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(run.displayName || "drawing").toLowerCase().replace(/\s+/g, "-")}-dimensions.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="ws-shell">
        <div className="ws-topbar">
          <Link href="/" className="ws-back">
            {t("ws.back")}
          </Link>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            color: "var(--color-muted)",
            fontSize: 14,
          }}
        >
          <div className="spinner" />
          {t("ws.loading")}
        </div>
      </div>
    );
  }

  return (
    <div className="ws-shell">
      <div className="ws-topbar">
        <Link href="/" className="ws-back">
          {t("ws.back")}
        </Link>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <h1 className="ws-title font-display">{image?.displayName ?? t("ws.drawingFallback")}</h1>
          <span className="ws-file">
            {image?.originalName ?? image?.filename ?? ""}
          </span>
        </div>
        <StepBar steps={steps} />
      </div>

      <div className="ws-body">
        <div className="ws-main">
          <div className="canvas-panel">
            <div className="canvas-toolbar">
              <div className="segmented">
                <button
                  className={view === "original" ? "is-active" : ""}
                  onClick={() => setView("original")}
                >
                  {t("ws.view.original")}
                </button>
                <button
                  className={view === "locate" ? "is-active" : ""}
                  onClick={() => setView("locate")}
                  disabled={!run}
                >
                  {t("ws.view.locate")}
                </button>
                <button
                  className={view === "result" ? "is-active" : ""}
                  onClick={() => setView("result")}
                  disabled={dimensions.length === 0}
                >
                  {t("ws.view.result")}
                </button>
              </div>

              <span className="canvas-hint">
                {editable
                  ? t("ws.canvas.hint")
                  : run?.stage === "reading"
                    ? t("ws.canvas.reading")
                    : ""}
              </span>

              <div className="zoom-group">
                {[1, 1.5, 2, 3].map((z) => (
                  <button
                    key={z}
                    className={`zoom-btn${zoom === z ? " is-active" : ""}`}
                    onClick={() => setZoom(z)}
                  >
                    {z}×
                  </button>
                ))}
              </div>
            </div>

            {image && (
              <BoxCanvas
                imageUrl={image.fullUrl}
                imageWidth={run?.imageWidth ?? 0}
                imageHeight={run?.imageHeight ?? 0}
                boxes={view === "original" ? [] : boxesForCanvas}
                dimensions={showResult ? dimensions : []}
                mode={showResult ? "result" : "locate"}
                zoom={zoom}
                editable={editable && view !== "original"}
                selectedId={selectedId}
                hoveredId={hoveredId}
                onSelect={setSelectedId}
                onHover={setHoveredId}
                onAdd={addBox}
                onDelete={deleteBox}
              />
            )}
          </div>

          {error && (
            <div className="error-banner" style={{ marginTop: 14 }}>
              {error}
            </div>
          )}

          {dimensions.length > 0 ? (
            <div className="results-card" ref={resultsRef}>
              <div className="results-head">
                <h2 className="results-title">{t("ws.results.title")}</h2>
                <span className="results-meta">
                  {t("ws.results.meta", { n: dimensions.length, m: reviewCount })}
                  {run?.readMs
                    ? t("ws.results.metaTime", { s: (run.readMs / 1000).toFixed(1) })
                    : ""}
                </span>
                <span style={{ flex: 1 }} />
                <div className="legend-row" style={{ margin: 0 }}>
                  {(
                    [
                      ["linear", t("ws.legend.linear")],
                      ["diameter", t("ws.legend.diameter")],
                      ["angle", t("ws.legend.angle")],
                      ["radius", t("ws.legend.radius")],
                    ] as const
                  ).map(([key, label]) => (
                    <span key={key} className="legend-item">
                      <span
                        className="dot"
                        style={{ backgroundColor: DIMENSION_COLORS[key] }}
                      />
                      {label}
                    </span>
                  ))}
                  <span className="legend-item">
                    <span
                      className="dot"
                      style={{
                        backgroundColor: "transparent",
                        border: "1.5px dashed var(--dim-review)",
                      }}
                    />
                    {t("ws.legend.review")}
                  </span>
                </div>
              </div>
              <DimensionTable
                dimensions={dimensions}
                selectedId={selectedId}
                hoveredId={hoveredId}
                onHover={setHoveredId}
                onSelect={setSelectedId}
              />
            </div>
          ) : (
            !busyStage && (
              <div className="empty-state">
                <p className="empty-title">
                  {run ? t("ws.empty.noResult.title") : t("ws.empty.noRun.title")}
                </p>
                <p className="empty-copy">
                  {run
                    ? t("ws.empty.noResult.copy")
                    : t("ws.empty.noRun.copy")}
                </p>
              </div>
            )
          )}
        </div>

        {/* Right rail */}
        <aside className="ws-rail">
          <div className="rail-card">
            <p className="rail-label">{t("ws.settings.title")}</p>

            <div className="field">
              <label htmlFor="scope">{t("ws.settings.scope")}</label>
              <select
                id="scope"
                value={config.scope}
                disabled={busyStage}
                onChange={(e) =>
                  setConfig({ ...config, scope: e.target.value as RunConfig["scope"] })
                }
              >
                <option value="dimensions">{t("ws.settings.scope.dimensions")}</option>
                <option value="all_text">{t("ws.settings.scope.all")}</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="density">{t("ws.settings.density")}</label>
              <select
                id="density"
                value={config.density}
                disabled={busyStage}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    density: e.target.value as RunConfig["density"],
                  })
                }
              >
                <option value="conservative">{t("ws.settings.density.conservative")}</option>
                <option value="standard">{t("ws.settings.density.standard")}</option>
                <option value="aggressive">{t("ws.settings.density.aggressive")}</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="channel">{t("ws.settings.channel")}</label>
              <select
                id="channel"
                value={channel}
                disabled={busyStage}
                onChange={(e) => setChannel(Number(e.target.value))}
              >
                <option value={2}>{t("ws.settings.channel.saas")}</option>
                <option value={1}>{t("ws.settings.channel.local")}</option>
              </select>
            </div>

            <label className="switch-row">
              <span>{t("ws.settings.excludeTitle")}</span>
              <input
                type="checkbox"
                checked={config.excludeTitleBlock}
                disabled={busyStage}
                onChange={(e) =>
                  setConfig({ ...config, excludeTitleBlock: e.target.checked })
                }
              />
            </label>

            <p className="field-hint" style={{ marginTop: 8 }}>
              {t("ws.settings.note")}
            </p>
          </div>

          <div className="rail-card">
            <p className="rail-label">{t("ws.actions.title")}</p>

            <button
              className="btn-primary action-btn"
              onClick={locate}
              disabled={busyStage || !image}
            >
              {run?.stage === "locating" ? (
                <>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  {t("ws.actions.locating")}
                </>
              ) : located ? (
                t("ws.actions.relocate")
              ) : (
                t("ws.actions.locate")
              )}
            </button>

            <button
              className="btn-secondary action-btn"
              style={{ marginTop: 8 }}
              onClick={read}
              disabled={busyStage || !located || boxesForCanvas.length === 0}
            >
              {run?.stage === "reading" ? (
                <>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  {t("ws.actions.reading")}
                </>
              ) : readDone ? (
                t("ws.actions.reread")
              ) : (
                t("ws.actions.read")
              )}
            </button>

            <div className="rail-divider" style={{ margin: "12px 0" }} />

            <div className="status-line">
              {busyStage && <div className="spinner" style={{ width: 12, height: 12 }} />}
              <span>{statusText}</span>
            </div>

            {run?.stage === "reading" && run.progress.total > 0 && (
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{
                    width: `${(run.progress.done / run.progress.total) * 100}%`,
                  }}
                />
              </div>
            )}

            {run?.error && (
              <div className="error-banner" style={{ marginTop: 10 }}>
                {errorText(t, { code: run.errorCode, message: run.error })}
              </div>
            )}
          </div>

          {run && (
            <div className="rail-card">
              <p className="rail-label">{t("ws.metrics.title")}</p>
              <div className="metric-grid">
                <div className="metric">
                  <div className="metric__label">{t("ws.metrics.boxes")}</div>
                  <div className="metric__value">
                    {run.boxes.length}
                    <small>{t("ws.metrics.unit.box")}</small>
                  </div>
                </div>
                <div className="metric">
                  <div className="metric__label">{t("ws.metrics.detected")}</div>
                  <div className="metric__value">
                    {dimensions.length}
                    <small>{t("ws.metrics.unit.dim")}</small>
                  </div>
                </div>
                <div className="metric">
                  <div className="metric__label">{t("ws.metrics.review")}</div>
                  <div
                    className="metric__value"
                    style={{
                      color: reviewCount > 0 ? "var(--color-warning)" : "var(--color-ink)",
                    }}
                  >
                    {reviewCount}
                    <small>{t("ws.metrics.unit.dim")}</small>
                  </div>
                </div>
                <div className="metric">
                  <div className="metric__label">{t("ws.metrics.channel")}</div>
                  <div className="metric__value" style={{ fontSize: 15, paddingTop: 6 }}>
                    {channelShort(run.channelUsed ?? run.channel, t)}
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: 12,
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 11,
                  color: "var(--color-muted)",
                }}
              >
                <span>
                  {t("ws.metrics.locate")}{" "}
                  {run.locateMs ? `${(run.locateMs / 1000).toFixed(1)}s` : "—"}
                </span>
                <span>
                  {t("ws.metrics.read")}{" "}
                  {run.readMs ? `${(run.readMs / 1000).toFixed(1)}s` : "—"}
                </span>
                <span>
                  {t("ws.metrics.total")}{" "}
                  {run.locateMs || run.readMs
                    ? `${(((run.locateMs ?? 0) + (run.readMs ?? 0)) / 1000).toFixed(1)}s`
                    : "—"}
                </span>
              </div>
            </div>
          )}

          {readDone && dimensions.length > 0 && (
            <div className="rail-card">
              <p className="rail-label">{t("ws.export.title")}</p>
              <button
                className="btn-secondary action-btn"
                onClick={downloadAnnotated}
                disabled={exporting}
              >
                {exporting ? (
                  <>
                    <div className="spinner" style={{ width: 14, height: 14 }} />
                    {t("ws.export.generating")}
                  </>
                ) : (
                  t("ws.export.png")
                )}
              </button>
              <button
                className="btn-secondary action-btn"
                style={{ marginTop: 8 }}
                onClick={exportCsv}
              >
                {t("ws.export.csv")}
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

export default function WorkspacePage() {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <div
          style={{
            height: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: "var(--color-muted)",
          }}
        >
          <div className="spinner" /> {t("ws.loading")}
        </div>
      }
    >
      <WorkspaceInner />
    </Suspense>
  );
}
