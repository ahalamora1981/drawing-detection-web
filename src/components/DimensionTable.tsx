"use client";

import type { DetectedDimension } from "@/lib/types";
import { DIMENSION_COLORS } from "@/lib/constants";

interface DimensionTableProps {
  dimensions: DetectedDimension[];
}

function confidenceClass(confidence: number): string {
  if (confidence >= 0.9) return "confidence-high";
  if (confidence >= 0.7) return "confidence-medium";
  return "confidence-low";
}

function dimensionTypeBadge(type: string) {
  const color = DIMENSION_COLORS[type] || DIMENSION_COLORS.unknown;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: color,
          display: "inline-block",
        }}
      />
      {type}
    </span>
  );
}

export default function DimensionTable({ dimensions }: DimensionTableProps) {
  if (dimensions.length === 0) {
    return (
      <div
        style={{
          padding: 32,
          textAlign: "center",
          color: "var(--color-muted)",
          fontSize: 14,
        }}
      >
        No dimensions detected
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table className="results-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Raw Text</th>
            <th>Nominal</th>
            <th>Tolerance</th>
            <th>Unit</th>
            <th>Type</th>
            <th>Feature</th>
            <th>Confidence</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {dimensions.map((dim) => (
            <tr key={dim.item_id}>
              <td
                style={{
                  fontFamily: "monospace",
                  fontSize: 13,
                  color: "var(--color-muted)",
                }}
              >
                {dim.item_id}
              </td>
              <td
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--color-ink)",
                }}
              >
                {dim.raw_text}
              </td>
              <td style={{ fontWeight: 500 }}>{dim.nominal_value}</td>
              <td>
                {dim.tolerance !== null ? (
                  <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                    ±{dim.tolerance}
                  </span>
                ) : dim.tolerance_plus !== null && dim.tolerance_minus !== null ? (
                  <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                    +{dim.tolerance_plus} / {dim.tolerance_minus}
                  </span>
                ) : (
                  <span style={{ color: "var(--color-muted-soft)" }}>—</span>
                )}
              </td>
              <td>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    padding: "2px 8px",
                    borderRadius: 4,
                    backgroundColor: "var(--color-surface-soft)",
                    color: "var(--color-body)",
                  }}
                >
                  {dim.unit}
                </span>
              </td>
              <td>{dimensionTypeBadge(dim.dimension_type)}</td>
              <td style={{ fontSize: 13 }}>{dim.feature_classification}</td>
              <td>
                <span className={confidenceClass(dim.confidence)}>
                  {(dim.confidence * 100).toFixed(0)}%
                </span>
              </td>
              <td>
                {dim.needs_review ? (
                  <span className="needs-review">⚠ Review</span>
                ) : (
                  <span
                    style={{
                      color: "var(--color-success)",
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    ✓ OK
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
