"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import { apiFetch } from "@/lib/api";
import { getSessionId } from "@/lib/session";
import type { GalleryImage, RunSummary } from "@/lib/types";

const MAX_UPLOADS = 5;

function statusOf(run: RunSummary | null): { text: string; color: string } {
  if (!run) return { text: "未检测", color: "var(--color-muted-soft)" };
  switch (run.stage) {
    case "queued":
      return { text: "排队中", color: "var(--color-muted)" };
    case "locating":
      return { text: "正在定位…", color: "var(--color-primary)" };
    case "located":
      return { text: `已定位 ${run.boxCount} 处`, color: "var(--color-body)" };
    case "reading":
      return {
        text: `识别中 ${run.detectedCount}/${run.boxCount}`,
        color: "var(--color-primary)",
      };
    case "done":
      return {
        text:
          run.reviewCount > 0
            ? `已识别 ${run.detectedCount} 条 · ${run.reviewCount} 待复核`
            : `已识别 ${run.detectedCount} 条`,
        color: run.reviewCount > 0 ? "var(--color-warning)" : "var(--color-success)",
      };
    case "error":
      return { text: "上次运行失败 · 可重试", color: "var(--color-error)" };
    default:
      return { text: "未检测", color: "var(--color-muted-soft)" };
  }
}

export default function GalleryPage() {
  const router = useRouter();
  const [session, setSession] = useState("");
  const [tests, setTests] = useState<GalleryImage[]>([]);
  const [uploads, setUploads] = useState<GalleryImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSession(getSessionId());
  }, []);

  const load = useCallback(async (sid: string) => {
    try {
      const res = await apiFetch(
        `/api/images?session=${encodeURIComponent(sid)}`
      );
      if (!res.ok) throw new Error("无法加载图纸列表。");
      const data = await res.json();
      setTests(data.images ?? []);
      setUploads(data.uploads ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    load(session);
  }, [session, load]);

  const uploadsFull = uploads.length >= MAX_UPLOADS;

  const upload = useCallback(
    async (file: File) => {
      if (!file || !session) return;
      const isPng = file.type === "image/png";
      const isJpg = file.type === "image/jpeg";
      if (!isPng && !isJpg) {
        setError("只支持 PNG 和 JPG 图纸。");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError("单张图纸不能超过 10 MB。");
        return;
      }
      if (uploadsFull) {
        setError(`本次会话最多上传 ${MAX_UPLOADS} 张，刷新页面可重新开始。`);
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("session", session);
        const res = await apiFetch("/api/upload", {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "上传失败");
        await load(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : "上传失败");
      } finally {
        setBusy(false);
      }
    },
    [session, uploadsFull, load]
  );

  const removeUpload = useCallback(
    async (filename: string) => {
      if (!session) return;
      setError(null);
      try {
        const res = await apiFetch(
          `/api/upload?name=${encodeURIComponent(filename)}&session=${encodeURIComponent(session)}`,
          { method: "DELETE" }
        );
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "删除失败");
        }
        await load(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : "删除失败");
      }
    },
    [session, load]
  );

  const open = useCallback(
    (image: GalleryImage) => {
      const query = image.run
        ? `run=${encodeURIComponent(image.run.id)}`
        : `image=${encodeURIComponent(image.filename)}`;
      router.push(`/workspace?${query}`);
    },
    [router]
  );

  const totalUploads = uploads.length;
  const heroStats = useMemo(
    () => `${tests.length} 张测试图纸 · ${totalUploads} 张本次上传`,
    [tests.length, totalUploads]
  );

  return (
    <div style={{ minHeight: "100vh" }}>
      <Header />

      <div className="page">
        <div className="hero">
          <div>
            <h1 className="hero-title font-display">图纸库</h1>
            <p className="hero-sub">
              先定位，再识别。系统先把图上的标注框出来，由你确认范围，再逐条读取数值、
              公差与类型 —— 每一步都看得见，也都能改。
            </p>
          </div>
          <div className="hero-flow">
            <b>① 标注定位</b>
            <span className="sep">——</span>
            <b>② 内容识别</b>
            <span className="sep">——</span>
            <b>③ 复核导出</b>
          </div>
        </div>

        {/* Upload */}
        <div
          className={`upload-zone${dragOver ? " upload-zone--over" : ""}${
            uploadsFull ? " upload-zone--full" : ""
          }`}
          onClick={() => {
            if (!uploadsFull && !busy) fileInputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!uploadsFull) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) upload(file);
          }}
          role="button"
          aria-disabled={uploadsFull}
        >
          <div className="upload-icon">
            {busy ? (
              <div className="spinner" style={{ width: 18, height: 18 }} />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"
                  stroke="var(--color-body)"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <p className="upload-title">
              {uploadsFull
                ? `本次会话已上传 ${MAX_UPLOADS} 张`
                : busy
                  ? "正在上传…"
                  : dragOver
                    ? "松开即可上传"
                    : "上传图纸"}
            </p>
            <p className="upload-copy">
              {uploadsFull
                ? "删除一张后可继续上传，刷新页面会重新开始。"
                : "拖拽到这里，或点击选择文件 · PNG / JPG · 单张 ≤ 10 MB"}
            </p>
          </div>
          <div className="section-count">
            {uploads.length}/{MAX_UPLOADS}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            e.target.value = "";
          }}
        />

        {error && (
          <div className="error-banner" style={{ marginTop: 14 }}>
            {error}
          </div>
        )}

        {/* Uploads */}
        {uploads.length > 0 && (
          <>
            <div className="section-head">
              <h2 className="section-title">本次上传</h2>
              <span className="section-count">{uploads.length}</span>
              <span className="section-rule" />
              <span className="section-count" style={{ fontFamily: "Inter" }}>
                仅本次会话可见
              </span>
            </div>
            <div className="gallery-grid">
              {uploads.map((image) => (
                <DrawingCard
                  key={image.filename}
                  image={image}
                  onOpen={open}
                  onDelete={removeUpload}
                />
              ))}
            </div>
          </>
        )}

        {/* Tests */}
        <div className="section-head">
          <h2 className="section-title">测试图纸</h2>
          <span className="section-count">{tests.length}</span>
          <span className="section-rule" />
          <span className="section-count" style={{ fontFamily: "Inter" }}>
            {loading ? "加载中…" : heroStats}
          </span>
        </div>
        <div className="gallery-grid">
          {tests.map((image) => (
            <DrawingCard key={image.filename} image={image} onOpen={open} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DrawingCard({
  image,
  onOpen,
  onDelete,
}: {
  image: GalleryImage;
  onOpen: (image: GalleryImage) => void;
  onDelete?: (filename: string) => void;
}) {
  const status = statusOf(image.run);
  return (
    <div
      className="drawing-card"
      onClick={() => onOpen(image)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(image);
        }
      }}
    >
      {image.source === "upload" && (
        <span className="drawing-card__badge">本次会话</span>
      )}
      {onDelete && (
        <button
          className="drawing-card__delete"
          title="删除这张图纸"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(image.filename);
          }}
        >
          ×
        </button>
      )}
      <div className="drawing-card__thumb">
        <img src={image.thumbnailUrl} alt={image.displayName} />
      </div>
      <div className="drawing-card__body">
        <div className="drawing-card__name">{image.displayName}</div>
        <div className="drawing-card__file">
          {image.originalName ?? image.filename}
        </div>
        <div className="drawing-card__status">
          <span className="dot" style={{ backgroundColor: status.color }} />
          <span>{status.text}</span>
          <span style={{ marginLeft: "auto", color: "var(--color-muted-soft)" }}>
            {image.run ? "继续 →" : "开始 →"}
          </span>
        </div>
      </div>
    </div>
  );
}
