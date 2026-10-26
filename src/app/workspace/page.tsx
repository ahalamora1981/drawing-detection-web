"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import BoxCanvas from "@/components/BoxCanvas";
import DimensionTable from "@/components/DimensionTable";
import StepBar, { type StepState } from "@/components/StepBar";
import { withBasePath } from "@/lib/basePath";
import { apiFetch } from "@/lib/api";
import { getSessionId } from "@/lib/session";
import { DIMENSION_COLORS } from "@/lib/constants";
import type { RunConfig, RunState } from "@/lib/types";

const DEFAULT_CONFIG: RunConfig = {
  scope: "dimensions",
  granularity: "annotation",
  density: "standard",
  excludeTitleBlock: true,
};

const CHANNEL_LABEL = (ch: number) => (ch === 1 ? "LLM（本地）" : "LLM（SaaS）");

function WorkspaceInner() {
  const router = useRouter();
  const search = useSearchParams();
  const runIdParam = search.get("run");
  const imageParam = search.get("image");

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
          if (!res.ok) throw new Error("找不到这次检测记录，可能已过期。");
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
          if (!found) throw new Error("找不到这张图纸，可能已过期，请回到图纸库重试。");
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
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
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
        throw new Error(data.error || "标注定位失败");
      }
      applyRun(data.run);
      setSelectedId(null);
      if (!run) {
        router.replace(`/workspace?run=${encodeURIComponent(data.run.id)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "标注定位失败");
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
      if (!res.ok) throw new Error(data.error || "内容识别失败");
      setRun(data.run);
      setView("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "内容识别失败");
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
        if (!res.ok) throw new Error(data.error || "保存框失败");
        setRun(data.run);
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存框失败");
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
        label: "标注定位",
        state: located ? "done" : run?.stage === "locating" || run?.stage === "queued" ? "active" : "active",
      },
      {
        label: "内容识别",
        state: readDone ? "done" : located ? "active" : "todo",
      },
      {
        label: "复核导出",
        state: readDone ? "active" : "todo",
      },
    ],
    [located, readDone, run?.stage]
  );

  const dimensions = run?.dimensions ?? [];
  const reviewCount = dimensions.filter((d) => d.needs_review).length;
  const boxesForCanvas = run?.boxes ?? [];
  const showResult = view === "result";
  const editable = !!run && !busyStage && !!image;

  const statusText = (() => {
    if (!run) return "选择设置后点击「标注定位」。";
    if (run.stage === "queued")
      return run.queue
        ? `排队中 · 前面还有 ${run.queue.position} 个任务`
        : "排队中…";
    if (run.stage === "locating") return "正在定位标注，请稍候…";
    if (run.stage === "reading")
      return `正在逐条读取 ${run.progress.done}/${run.progress.total}`;
    if (run.stage === "located") return `已框出 ${run.boxes.length} 处，可增删后再识别。`;
    if (run.stage === "done") return "识别完成，可复核并导出。";
    return "上次运行失败，可重试。";
  })();

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
            ← 图纸库
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
          正在加载…
        </div>
      </div>
    );
  }

  return (
    <div className="ws-shell">
      <div className="ws-topbar">
        <Link href="/" className="ws-back">
          ← 图纸库
        </Link>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <h1 className="ws-title font-display">{image?.displayName ?? "图纸"}</h1>
          <span className="ws-file">
            {image?.originalName ?? image?.filename ?? ""}
          </span>
        </div>
        <StepBar steps={steps} />
      </div>

      <div className="ws-body">
        <div className="ws-main">
          <div
            className={`canvas-panel${dimensions.length > 0 ? " canvas-panel--compact" : ""}`}
          >
            <div className="canvas-toolbar">
              <div className="segmented">
                <button
                  className={view === "original" ? "is-active" : ""}
                  onClick={() => setView("original")}
                >
                  原图
                </button>
                <button
                  className={view === "locate" ? "is-active" : ""}
                  onClick={() => setView("locate")}
                  disabled={!run}
                >
                  定位框
                </button>
                <button
                  className={view === "result" ? "is-active" : ""}
                  onClick={() => setView("result")}
                  disabled={dimensions.length === 0}
                >
                  识别结果
                </button>
              </div>

              <span className="canvas-hint">
                {editable
                  ? "深蓝框＝候选位置 · 拖动空白处新增 · 选中后 Delete 删除"
                  : run?.stage === "reading"
                    ? "正在读取，框会逐条上色"
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
                <h2 className="results-title">识别结果</h2>
                <span className="results-meta">
                  {dimensions.length} 条 · {reviewCount} 条待复核
                  {run?.readMs ? ` · 识别耗时 ${(run.readMs / 1000).toFixed(1)}s` : ""}
                </span>
                <span style={{ flex: 1 }} />
                <div className="legend-row" style={{ margin: 0 }}>
                  {(
                    [
                      ["linear", "线性"],
                      ["diameter", "直径"],
                      ["angle", "角度"],
                      ["radius", "半径"],
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
                    待复核
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
                  {run ? "还没有识别结果" : "这张图纸还没有开始"}
                </p>
                <p className="empty-copy">
                  {run
                    ? "确认框的位置无误后，点击右侧「内容识别」，系统会逐条读取每个框里的数值。"
                    : "点击右侧「标注定位」，系统会先把图上的尺寸标注框出来 —— 只框位置，不读数字。"}
                </p>
              </div>
            )
          )}
        </div>

        {/* Right rail */}
        <aside className="ws-rail">
          <div className="rail-card">
            <p className="rail-label">检测设置</p>

            <div className="field">
              <label htmlFor="scope">识别范围</label>
              <select
                id="scope"
                value={config.scope}
                disabled={busyStage}
                onChange={(e) =>
                  setConfig({ ...config, scope: e.target.value as RunConfig["scope"] })
                }
              >
                <option value="dimensions">仅尺寸标注</option>
                <option value="all_text">含技术要求与注释</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="granularity">框选粒度</label>
              <select
                id="granularity"
                value={config.granularity}
                disabled={busyStage}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    granularity: e.target.value as RunConfig["granularity"],
                  })
                }
              >
                <option value="annotation">整条标注</option>
                <option value="value">单个数值</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="density">密集程度</label>
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
                <option value="conservative">保守（少框，少误报）</option>
                <option value="standard">标准</option>
                <option value="aggressive">激进（多框，少漏检）</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="channel">AI 通道</label>
              <select
                id="channel"
                value={channel}
                disabled={busyStage}
                onChange={(e) => setChannel(Number(e.target.value))}
              >
                <option value={2}>LLM（SaaS）· 默认</option>
                <option value={1}>LLM（本地）</option>
              </select>
            </div>

            <label className="switch-row">
              <span>排除标题栏</span>
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
              修改设置后需要重新定位才会生效。
            </p>
          </div>

          <div className="rail-card">
            <p className="rail-label">执行</p>

            <button
              className="btn-primary action-btn"
              onClick={locate}
              disabled={busyStage || !image}
            >
              {run?.stage === "locating" ? (
                <>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  正在定位…
                </>
              ) : located ? (
                "重新定位"
              ) : (
                "标注定位"
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
                  正在识别…
                </>
              ) : readDone ? (
                "重新识别"
              ) : (
                "内容识别"
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
                {run.error}
              </div>
            )}
          </div>

          {run && (
            <div className="rail-card">
              <p className="rail-label">本次运行</p>
              <div className="metric-grid">
                <div className="metric">
                  <div className="metric__label">已框出</div>
                  <div className="metric__value">
                    {run.boxes.length}
                    <small>处</small>
                  </div>
                </div>
                <div className="metric">
                  <div className="metric__label">已识别</div>
                  <div className="metric__value">
                    {dimensions.length}
                    <small>条</small>
                  </div>
                </div>
                <div className="metric">
                  <div className="metric__label">待复核</div>
                  <div
                    className="metric__value"
                    style={{
                      color: reviewCount > 0 ? "var(--color-warning)" : "var(--color-ink)",
                    }}
                  >
                    {reviewCount}
                    <small>条</small>
                  </div>
                </div>
                <div className="metric">
                  <div className="metric__label">通道</div>
                  <div className="metric__value" style={{ fontSize: 15, paddingTop: 6 }}>
                    {run.channelUsed ? CHANNEL_LABEL(run.channelUsed) : CHANNEL_LABEL(run.channel)}
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
                <span>定位 {run.locateMs ? `${(run.locateMs / 1000).toFixed(1)}s` : "—"}</span>
                <span>识别 {run.readMs ? `${(run.readMs / 1000).toFixed(1)}s` : "—"}</span>
                <span>
                  合计{" "}
                  {run.locateMs || run.readMs
                    ? `${(((run.locateMs ?? 0) + (run.readMs ?? 0)) / 1000).toFixed(1)}s`
                    : "—"}
                </span>
              </div>
            </div>
          )}

          {readDone && dimensions.length > 0 && (
            <div className="rail-card">
              <p className="rail-label">导出</p>
              <a
                className="btn-secondary action-btn"
                style={{ textDecoration: "none" }}
                href={withBasePath(
                  `/api/runs/${run!.id}/image?variant=annotated&download=1`
                )}
              >
                下载标注图
              </a>
              <button
                className="btn-secondary action-btn"
                style={{ marginTop: 8 }}
                onClick={exportCsv}
              >
                导出明细 CSV
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

export default function WorkspacePage() {
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
          <div className="spinner" /> 正在加载…
        </div>
      }
    >
      <WorkspaceInner />
    </Suspense>
  );
}
