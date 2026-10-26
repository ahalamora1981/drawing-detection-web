import type { Metadata } from "next";
import "./globals.css";
import PinGate from "@/components/PinGate";

export const metadata: Metadata = {
  title: "图纸尺寸识别 — 标注定位 + 内容识别",
  description:
    "先定位、再识别：把工程图纸上的尺寸标注逐步转成可复核的结构化清单。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <PinGate>{children}</PinGate>
      </body>
    </html>
  );
}
