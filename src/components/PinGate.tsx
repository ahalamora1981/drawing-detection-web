"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/basePath";
import { onPinRequired } from "@/lib/pinSignal";

/**
 * App-wide PIN gate.
 *
 * The PIN is verified SERVER-SIDE (APP_PIN in .env) and the answer is kept in
 * memory only, so every page refresh re-arms the gate. This exists because the
 * demo is publicly reachable and every run spends real LLM credits.
 */
export default function PinGate({ children }: { children: React.ReactNode }) {
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
      setError("请输入 PIN。");
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
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "PIN 错误。");
      setUnlocked(true);
      setPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "PIN 错误。");
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
            <div className="pin-eyebrow">受保护演示</div>
            <h2 id="pin-title" className="pin-title font-display">
              PIN 验证
            </h2>
            <p className="pin-copy">
              该演示每次运行都会调用视觉大模型。请输入 PIN 解锁，刷新页面后需重新验证。
            </p>
            <input
              type="password"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="请输入 PIN"
              className={`pin-input${error ? " pin-input--error" : ""}`}
            />
            {error && <p className="pin-error">{error}</p>}
            <div className="pin-actions">
              <button className="btn-primary" onClick={submit} disabled={verifying}>
                {verifying ? "验证中…" : "确认"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
