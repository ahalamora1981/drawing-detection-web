"use client";

import { useEffect, useState } from "react";
import { ApiError, readApiError } from "@/lib/api";
import { withBasePath } from "@/lib/basePath";
import { onPinRequired } from "@/lib/pinSignal";
import { errorText, useI18n } from "@/lib/i18n";

/**
 * App-wide PIN gate.
 *
 * The PIN is verified SERVER-SIDE (APP_PIN in .env) and the answer is kept in
 * memory only, so every page refresh re-arms the gate. This exists because the
 * demo is publicly reachable and every run spends real LLM credits.
 */
export default function PinGate({ children }: { children: React.ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [checking, setChecking] = useState(false);

  // Any 401 from the API re-arms the gate (cookie expired / server restarted).
  useEffect(() => onPinRequired(() => setUnlocked(false)), []);

  // If the server has no APP_PIN configured, don't lock the app out.
  useEffect(() => {
    let cancelled = false;
    fetch(withBasePath("/api/verify-pin"), { method: "GET" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.required === false) setUnlocked(true);
      })
      .catch(() => {
        /* keep the gate closed; the POST will explain */
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    setChecking(true);
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    const entered = pin.trim();
    if (!entered) {
      setError(t("pin.empty"));
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/verify-pin"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: entered }),
      });
      if (!res.ok) throw await readApiError(res);
      const data = await res.json();
      if (!data.ok) throw new ApiError("pin_wrong", "");
      setUnlocked(true);
      setPin("");
    } catch (err) {
      setError(errorText(t, err as Error, "pin.wrong"));
      setPin("");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      <div inert={!unlocked} style={{ height: "100%" }}>
        {children}
      </div>

      {!unlocked && !checking && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pin-title"
          className="pin-overlay"
        >
          <div className="pin-card">
            <div className="pin-eyebrow">{t("pin.eyebrow")}</div>
            <h2 id="pin-title" className="pin-title font-display">
              {t("pin.title")}
            </h2>
            <p className="pin-copy">{t("pin.copy")}</p>
            <input
              type="password"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder={t("pin.placeholder")}
              className={`pin-input${error ? " pin-input--error" : ""}`}
            />
            {error && <p className="pin-error">{error}</p>}
            <div className="pin-actions">
              <div className="lang-switch" role="group" aria-label={t("header.language")}>
                <button
                  type="button"
                  aria-pressed={lang === "zh"}
                  className={lang === "zh" ? "is-active" : ""}
                  onClick={() => setLang("zh")}
                >
                  中文
                </button>
                <button
                  type="button"
                  aria-pressed={lang === "en"}
                  className={lang === "en" ? "is-active" : ""}
                  onClick={() => setLang("en")}
                >
                  EN
                </button>
              </div>
              <button className="btn-primary" onClick={submit} disabled={verifying}>
                {verifying ? t("pin.verifying") : t("pin.submit")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
