"use client";

import { useState } from "react";

interface ImageComparisonProps {
  originalUrl: string;
  annotatedUrl: string;
  imageName: string;
}

export default function ImageComparison({
  originalUrl,
  annotatedUrl,
  imageName,
}: ImageComparisonProps) {
  const [view, setView] = useState<"annotated" | "original" | "side">(
    "annotated"
  );

  return (
    <div>
      {/* View toggle */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 16,
          backgroundColor: "var(--color-surface-soft)",
          borderRadius: 8,
          padding: 4,
          width: "fit-content",
        }}
      >
        {(
          [
            { key: "annotated", label: "Annotated" },
            { key: "original", label: "Original" },
            { key: "side", label: "Side by Side" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: 500,
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              backgroundColor:
                view === key ? "var(--color-canvas)" : "transparent",
              color:
                view === key ? "var(--color-ink)" : "var(--color-muted)",
              boxShadow:
                view === key ? "0 1px 3px rgba(20,20,19,0.08)" : "none",
              transition: "all 0.15s ease",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Image display */}
      {view === "side" ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--color-muted)",
                marginBottom: 8,
              }}
            >
              Original
            </div>
            <div className="image-viewer">
              <img src={originalUrl} alt={`${imageName} - original`} />
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--color-muted)",
                marginBottom: 8,
              }}
            >
              Annotated
            </div>
            <div className="image-viewer">
              <img src={annotatedUrl} alt={`${imageName} - annotated`} />
            </div>
          </div>
        </div>
      ) : (
        <div className="image-viewer">
          <img
            src={view === "annotated" ? annotatedUrl : originalUrl}
            alt={`${imageName} - ${view}`}
          />
        </div>
      )}
    </div>
  );
}
