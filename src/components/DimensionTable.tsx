"use client";

import type { DetectedDimension } from "@/lib/types";
import { DIMENSION_COLORS } from "@/lib/constants";
import { useI18n } from "@/lib/i18n";

interface DimensionTableProps {
  dimensions: DetectedDimension[];
  selectedId?: string | null;
  hoveredId?: string | null;
  onHover?: (id: string | null) => void;
  onSelect?: (id: string | null) => void;
}

function confidenceClass(confidence: number): string {
  if (confidence >= 0.9) return "confidence-high";
  if (confidence >= 0.7) return "confidence-medium";
  return "confidence-low";
}

function dimensionTypeBadge(type: string) {
  const color = DIMENSION_COLORS[type] || DIMENSION_COLORS.unknown;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
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

export default function DimensionTable({
  dimensions,
  selectedId,
  hoveredId,
  onHover,
  onSelect,
}: DimensionTableProps) {
  const { t } = useI18n();

  if (dimensions.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "var(--color-muted)", fontSize: 14 }}>
        {t("table.empty")}
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table className="results-table">
        <thead>
          <tr>
            <th style={{ width: 54 }}>#</th>
            <th>{t("table.raw")}</th>
            <th>{t("table.nominal")}</th>
            <th>{t("table.tolerance")}</th>
            <th>{t("table.unit")}</th>
            <th>{t("table.type")}</th>
            <th>{t("table.feature")}</th>
            <th>{t("table.confidence")}</th>
            <th>{t("table.status")}</th>
          </tr>
        </thead>
        <tbody>
          {dimensions.map((dim, index) => {
            const isSelected = selectedId === dim.item_id;
            const isHovered = hoveredId === dim.item_id;
            const failed = dim.read_failed === true || dim.raw_text === "READ_FAILED";
            return (
              <tr
                key={dim.item_id}
                className={[
                  isSelected ? "is-selected" : "",
                  isHovered ? "is-hovered" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => onHover?.(dim.item_id)}
                onMouseLeave={() => onHover?.(null)}
                onClick={() => onSelect?.(isSelected ? null : dim.item_id)}
                style={{ cursor: "pointer" }}
              >
                <td>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: 22,
                      height: 18,
                      padding: "0 4px",
                      borderRadius: 3,
                      backgroundColor: "var(--color-body-strong)",
                      color: "#fff",
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 10,
                    }}
                  >
                    {index + 1}
                  </span>
                </td>
                <td
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 13,
                    fontWeight: 500,
                    color: failed ? "var(--color-error)" : "var(--color-ink)",
                  }}
                >
                  {failed ? t("table.failed") : dim.raw_text}
                </td>
                <td style={{ fontWeight: 500 }}>
                  {failed ? "—" : dim.nominal_value}
                </td>
                <td>
                  {(() => {
                    const plus = dim.tolerance_plus;
                    const minus = dim.tolerance_minus;
                    const asymmetric =
                      plus !== null &&
                      minus !== null &&
                      Math.abs(plus + minus) > 1e-9;
                    if (asymmetric) {
                      return (
                        <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                          +{plus} / {minus}
                        </span>
                      );
                    }
                    if (dim.tolerance !== null) {
                      return (
                        <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                          ±{dim.tolerance}
                        </span>
                      );
                    }
                    return (
                      <span style={{ color: "var(--color-muted-soft)" }}>—</span>
                    );
                  })()}
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
                    <span className="needs-review">{t("table.review")}</span>
                  ) : (
                    <span
                      style={{
                        color: "var(--color-success)",
                        fontSize: 13,
                        fontWeight: 500,
                      }}
                    >
                      {t("table.ok")}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
