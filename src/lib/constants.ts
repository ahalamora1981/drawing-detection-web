// Design tokens from claude-DESIGN.md
export const COLORS = {
  // Brand & Accent
  primary: "#cc785c",
  primaryActive: "#a9583e",
  primaryDisabled: "#e6dfd8",

  // Surface
  canvas: "#faf9f5",
  surfaceSoft: "#f5f0e8",
  surfaceCard: "#efe9de",
  surfaceCreamStrong: "#e8e0d2",
  surfaceDark: "#181715",
  surfaceDarkElevated: "#252320",
  surfaceDarkSoft: "#1f1e1b",

  // Text
  ink: "#141413",
  bodyStrong: "#252523",
  body: "#3d3d3a",
  muted: "#6c6a64",
  mutedSoft: "#8e8b82",
  onPrimary: "#ffffff",
  onDark: "#faf9f5",
  onDarkSoft: "#a09d96",

  // Hairline
  hairline: "#e6dfd8",
  hairlineSoft: "#ebe6df",

  // Semantic
  success: "#5db872",
  warning: "#d4a017",
  error: "#c64545",

  // Accents
  accentTeal: "#5db8a6",
  accentAmber: "#e8a55a",
} as const;

// Dimension type colors (matching visualizer.py)
export const DIMENSION_COLORS: Record<string, string> = {
  linear: "#00a000",
  diameter: "#c80000",
  angle: "#0000c8",
  radius: "#e67800",
  unknown: "#808080",
  review: "#ffa500",
};

export const RADIUS = {
  xs: "4px",
  sm: "6px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  pill: "9999px",
} as const;

export const SPACING = {
  xxs: "4px",
  xs: "8px",
  sm: "12px",
  md: "16px",
  lg: "24px",
  xl: "32px",
  xxl: "48px",
  section: "96px",
} as const;
