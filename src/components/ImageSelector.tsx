"use client";

import { useRef, useState } from "react";
import type { TestImage } from "@/lib/types";

interface ImageSelectorProps {
  images: TestImage[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onUpload: (file: File) => void;
  channel: number;
  onChannelChange: (channel: number) => void;
}

const MAX_UPLOADS = 5;

export default function ImageSelector({
  images,
  selectedIndex,
  onSelect,
  onUpload,
  channel,
  onChannelChange,
}: ImageSelectorProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploads = images.filter((img) => img.source === "upload");
  const tests = images.filter((img) => img.source !== "upload");
  const uploadsFull = uploads.length >= MAX_UPLOADS;

  const pickFile = () => {
    if (!uploadsFull) fileInputRef.current?.click();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (uploadsFull) return;
    const file = e.dataTransfer.files?.[0];
    if (file) onUpload(file);
  };

  const renderItem = (img: TestImage, index: number) => {
    const isSelected = index === selectedIndex;
    const hasResult = !!img.result;
    const reviewCount = img.result?.needs_review_count ?? 0;

    return (
      <button
        key={img.filename}
        onClick={() => onSelect(index)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          width: "100%",
          padding: "10px 12px",
          marginBottom: 2,
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
          textAlign: "left",
          backgroundColor: isSelected
            ? "var(--color-surface-cream-strong)"
            : "transparent",
          transition: "background-color 0.15s ease",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = "var(--color-surface-soft)";
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = "transparent";
          }
        }}
      >
        {/* Thumbnail */}
        <div
          style={{
            width: 48,
            height: 36,
            borderRadius: 6,
            overflow: "hidden",
            backgroundColor: "var(--color-surface-soft)",
            flexShrink: 0,
            border: "1px solid var(--color-hairline-soft)",
          }}
        >
          <img
            src={img.thumbnailUrl}
            alt={img.displayName}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: isSelected
                ? "var(--color-ink)"
                : "var(--color-body-strong)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {img.displayName}
            </span>
            {img.source === "upload" && (
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: "var(--color-primary)",
                  backgroundColor: "rgba(204, 120, 92, 0.12)",
                  borderRadius: 4,
                  padding: "1px 5px",
                }}
              >
                Uploaded
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--color-muted-soft)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 2,
            }}
          >
            {hasResult ? (
              <>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor:
                      reviewCount > 0
                        ? "var(--color-warning)"
                        : "var(--color-success)",
                    display: "inline-block",
                  }}
                />
                <span>
                  {img.result!.total_detected} dim
                  {img.result!.total_detected !== 1 ? "s" : ""}
                </span>
                {reviewCount > 0 && (
                  <span style={{ color: "var(--color-warning)" }}>
                    · {reviewCount} review
                  </span>
                )}
              </>
            ) : (
              <span>No results</span>
            )}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div
      style={{
        width: 280,
        minWidth: 280,
        backgroundColor: "var(--color-surface-card)",
        borderRight: "1px solid var(--color-hairline)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Sidebar header */}
      <div
        style={{
          padding: "20px 20px 16px",
          borderBottom: "1px solid var(--color-hairline)",
        }}
      >
        <h2
          style={{
            fontSize: 13,
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--color-muted)",
            margin: 0,
          }}
        >
          Drawings
        </h2>
        <p
          style={{
            fontSize: 13,
            color: "var(--color-muted-soft)",
            margin: "4px 0 0",
          }}
        >
          {tests.length} tests · {uploads.length}/{MAX_UPLOADS} uploads
        </p>
      </div>

      {/* Upload drop zone */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-hairline)" }}>
        <div
          onClick={pickFile}
          onDragOver={(e) => {
            e.preventDefault();
            if (!uploadsFull) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          role="button"
          aria-disabled={uploadsFull}
          style={{
            border: `1.5px dashed ${
              uploadsFull
                ? "var(--color-hairline)"
                : dragOver
                  ? "var(--color-primary)"
                  : "var(--color-hairline-strong, var(--color-muted-soft))"
            }`,
            borderRadius: 10,
            padding: "14px 12px",
            textAlign: "center",
            cursor: uploadsFull ? "not-allowed" : "pointer",
            backgroundColor: dragOver
              ? "rgba(204, 120, 92, 0.08)"
              : "transparent",
            transition: "border-color 0.15s ease, background-color 0.15s ease",
            opacity: uploadsFull ? 0.6 : 1,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: uploadsFull
                ? "var(--color-muted)"
                : dragOver
                  ? "var(--color-primary)"
                  : "var(--color-ink)",
              marginBottom: 3,
            }}
          >
            {uploadsFull ? "Upload limit reached" : dragOver ? "Drop to upload" : "Upload drawing"}
          </div>
          <div style={{ fontSize: 12, color: "var(--color-muted-soft)", lineHeight: 1.5 }}>
            {uploadsFull
              ? "Refresh the page to upload more."
              : "PNG or JPG · max 10 MB · drag & drop or click"}
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            e.target.value = "";
          }}
        />
      </div>

      {/* Image list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px",
        }}
      >
        {tests.map((img, i) => renderItem(img, i))}

        {uploads.length > 0 && (
          <>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--color-muted-soft)",
                padding: "12px 12px 6px",
              }}
            >
              Your Uploads
            </div>
            {uploads.map((img, i) => renderItem(img, tests.length + i))}
          </>
        )}

        {/* LLM channel selector — sits directly below the image list */}
        <div
          style={{
            padding: "12px 12px 4px",
            marginTop: 4,
            borderTop: "1px solid var(--color-hairline)",
          }}
        >
          <select
            id="llm-channel"
            value={channel}
            onChange={(e) => onChannelChange(Number(e.target.value))}
            style={{
              width: "100%",
              padding: "9px 10px",
              fontSize: 14,
              color: "var(--color-ink)",
              backgroundColor: "var(--color-canvas)",
              border: "1px solid var(--color-hairline-strong, var(--color-muted-soft))",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            <option value={2}>LLM（SaaS）</option>
            <option value={1}>LLM（本地）</option>
          </select>
        </div>
      </div>
    </div>
  );
}
