"use client";

export default function Header() {
  return (
    <header
      style={{
        height: 64,
        backgroundColor: "var(--color-canvas)",
        borderBottom: "1px solid var(--color-hairline)",
        display: "flex",
        alignItems: "center",
        padding: "0 32px",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Anthropic spike-mark glyph */}
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M12 2L13.5 10.5L22 12L13.5 13.5L12 22L10.5 13.5L2 12L10.5 10.5L12 2Z"
            fill="var(--color-ink)"
          />
        </svg>
        <span
          style={{
            fontFamily: '"Cormorant Garamond", "EB Garamond", serif',
            fontSize: 20,
            fontWeight: 400,
            color: "var(--color-ink)",
            letterSpacing: "-0.3px",
          }}
        >
          Drawing Detection
        </span>
      </div>

      <div style={{ flex: 1 }} />

      <nav style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: "var(--color-muted)",
          }}
        >
          Vision LLM Dimension Extraction
        </span>
      </nav>
    </header>
  );
}
