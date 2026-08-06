import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Drawing Detection — Vision LLM Dimension Extraction",
  description:
    "Extract dimensions from engineering drawings using Vision LLM with CV-assisted bounding-box refinement.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
