"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export default function Header() {
  const { lang, setLang, t } = useI18n();

  return (
    <header className="app-header">
      <Link href="/" className="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 2L13.5 10.5L22 12L13.5 13.5L12 22L10.5 13.5L2 12L10.5 10.5L12 2Z"
            fill="var(--color-ink)"
          />
        </svg>
        <span className="brand-name font-display">Drawing Detection</span>
      </Link>

      <div style={{ flex: 1 }} />

      <nav className="header-nav">
        <span className="header-tagline">{t("header.tagline")}</span>
        <span className="header-divider" aria-hidden="true" />

        <div className="lang-switch" role="group" aria-label="Language">
          <button
            type="button"
            className={lang === "zh" ? "is-active" : ""}
            aria-pressed={lang === "zh"}
            onClick={() => setLang("zh")}
          >
            中文
          </button>
          <button
            type="button"
            className={lang === "en" ? "is-active" : ""}
            aria-pressed={lang === "en"}
            onClick={() => setLang("en")}
          >
            EN
          </button>
        </div>

        <Link href="/" className="header-link">
          {t("header.library")}
        </Link>
      </nav>
    </header>
  );
}
