"use client";

import { useI18n } from "@/lib/i18n";

export interface StepState {
  label: string;
  state: "todo" | "active" | "done";
}

/** Always-visible three-step indicator: "there is one more step" is the point. */
export default function StepBar({ steps }: { steps: StepState[] }) {
  const { t } = useI18n();
  return (
    <div className="stepper" aria-label={t("ws.steps.aria")}>
      {steps.map((step, i) => (
        <div key={step.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {i > 0 && <span className="step-line" aria-hidden="true" />}
          <div
            className={[
              "step",
              step.state === "active" ? "step--active" : "",
              step.state === "done" ? "step--done" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className="step__num">{step.state === "done" ? "✓" : i + 1}</span>
            <span>{step.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
