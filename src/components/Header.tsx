"use client";

import Link from "next/link";

export default function Header() {
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
        <span className="header-tagline">Vision LLM Dimension Extraction</span>
        <span className="header-divider" aria-hidden="true" />
        <Link href="/" className="header-link">
          图纸库
        </Link>
      </nav>
    </header>
  );
}
