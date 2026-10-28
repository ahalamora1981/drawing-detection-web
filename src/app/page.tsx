"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import { apiFetch, ApiError, readApiError } from "@/lib/api";
import { getSessionId } from "@/lib/session";
import { errorText, useI18n, type Translate } from "@/lib/i18n";
import type { GalleryImage, RunSummary } from "@/lib/types";

const MAX_UPLOADS = 5;

function statusOf(
  run: RunSummary | null,
  t: Translate
): { text: string; color: string } {
  if (!run) return { text: t("status.untested"), color: "var(--color-muted-soft)" };
  switch (run.stage) {
    case "queued":
      return { text: t("status.queued"), color: "var(--color-muted)" };
    case "locating":
      return { text: t("status.locating"), color: "var(--color-primary)" };
    case "located":
      return { text: t("status.located", { n: run.boxCount }), color: "var(--color-body)" };
    case "reading":
      return {
        text: t("status.reading", { done: run.detectedCount, total: run.boxCount }),
        color: "var(--color-primary)",
      };
    case "done":
      return {
        text:
          run.reviewCount > 0
            ? t("status.doneReview", { n: run.detectedCount, m: run.reviewCount })
            : t("status.done", { n: run.detectedCount }),
        color: run.reviewCount > 0 ? "var(--color-warning)" : "var(--color-success)",
      };
    case "error":
      return { text: t("status.failed"), color: "var(--color-error)" };
    default:
      return { text: t("status.untested"), color: "var(--color-muted-soft)" };
  }
}

export default function GalleryPage() {
  const router = useRouter();
  const { t } = useI18n();
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

  const load = useCallback(
    async (sid: string) => {
      try {
        const res = await apiFetch(
          `/api/images?session=${encodeURIComponent(sid)}`
        );
        if (!res.ok) throw new ApiError(undefined, t("gallery.error.load"));
        const data = await res.json();
        setTests(data.images ?? []);
        setUploads(data.uploads ?? []);
      } catch (err) {
        setError(errorText(t, err as Error, "gallery.error.loadShort"));
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

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
        setError(t("gallery.error.type"));
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(t("gallery.error.size"));
        return;
      }
      if (uploadsFull) {
        setError(t("gallery.error.limit", { n: MAX_UPLOADS }));
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
        if (!res.ok) throw await readApiError(res);
        await load(session);
      } catch (err) {
        setError(errorText(t, err as Error, "gallery.error.upload"));
      } finally {
        setBusy(false);
      }
    },
    [session, uploadsFull, load, t]
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
        if (!res.ok) throw await readApiError(res);
        await load(session);
      } catch (err) {
        setError(errorText(t, err as Error, "gallery.error.delete"));
      }
    },
    [session, load, t]
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

  const heroStats = useMemo(
    () => t("gallery.stats", { tests: tests.length, uploads: uploads.length }),
    [tests.length, uploads.length, t]
  );

  return (
    <div style={{ minHeight: "100vh" }}>
      <Header />

      <div className="page">
        <div className="hero">
          <div>
            <h1 className="hero-title font-display">{t("gallery.title")}</h1>
            <p className="hero-sub">{t("gallery.subtitle")}</p>
          </div>
          <div className="hero-flow">
            <b>{t("gallery.flow.locate")}</b>
            <span className="sep">——</span>
            <b>{t("gallery.flow.read")}</b>
            <span className="sep">——</span>
            <b>{t("gallery.flow.review")}</b>
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
                ? t("gallery.upload.full", { n: MAX_UPLOADS })
                : busy
                  ? t("gallery.upload.busy")
                  : dragOver
                    ? t("gallery.upload.drop")
                    : t("gallery.upload.title")}
            </p>
            <p className="upload-copy">
              {uploadsFull
                ? t("gallery.upload.fullHint")
                : t("gallery.upload.hint")}
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
              <h2 className="section-title">{t("gallery.section.uploads")}</h2>
              <span className="section-count">{uploads.length}</span>
              <span className="section-rule" />
              <span className="section-count" style={{ fontFamily: "Inter" }}>
                {t("gallery.section.uploadsNote")}
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
          <h2 className="section-title">{t("gallery.section.tests")}</h2>
          <span className="section-count">{tests.length}</span>
          <span className="section-rule" />
          <span className="section-count" style={{ fontFamily: "Inter" }}>
            {loading ? t("gallery.loading") : heroStats}
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
  const { t } = useI18n();
  const status = statusOf(image.run, t);
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
        <span className="drawing-card__badge">{t("gallery.badge.session")}</span>
      )}
      {onDelete && (
        <button
          className="drawing-card__delete"
          title={t("gallery.card.delete")}
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
            {image.run ? t("gallery.card.continue") : t("gallery.card.start")}
          </span>
        </div>
      </div>
    </div>
  );
}
