"use client";

import type { TestImage } from "@/lib/types";

interface ImageSelectorProps {
  images: TestImage[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

export default function ImageSelector({
  images,
  selectedIndex,
  onSelect,
}: ImageSelectorProps) {
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
          Test Samples
        </h2>
        <p
          style={{
            fontSize: 13,
            color: "var(--color-muted-soft)",
            margin: "4px 0 0",
          }}
        >
          {images.length} drawings
        </p>
      </div>

      {/* Image list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px",
        }}
      >
        {images.map((img, index) => {
          const isSelected = index === selectedIndex;
          const hasResult = !!img.result;
          const reviewCount =
            img.result?.needs_review_count ?? 0;

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
                  e.currentTarget.style.backgroundColor =
                    "var(--color-surface-soft)";
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
                  }}
                >
                  {img.displayName}
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
                          backgroundColor: reviewCount > 0
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
        })}
      </div>
    </div>
  );
}
