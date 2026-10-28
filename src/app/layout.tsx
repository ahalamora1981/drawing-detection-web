import type { Metadata } from "next";
import "./globals.css";
import PinGate from "@/components/PinGate";
import { I18nProvider } from "@/lib/i18n";
import { readLang } from "@/lib/lang.server";

export async function generateMetadata(): Promise<Metadata> {
  const lang = await readLang();
  if (lang === "en") {
    return {
      title: "Drawing Dimension Reader — locate, then read",
      description:
        "Locate first, read second: turn the annotations on an engineering drawing into a reviewable, structured list.",
    };
  }
  return {
    title: "图纸尺寸识别 — 标注定位 + 内容识别",
    description:
      "先定位、再识别：把工程图纸上的尺寸标注逐步转成可复核的结构化清单。",
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The language lives in a cookie so the first paint is already in the
  // right language (no flash when switching between pages).
  const lang = await readLang();

  return (
    <html lang={lang === "en" ? "en" : "zh-CN"}>
      <body>
        <I18nProvider initialLang={lang}>
          <PinGate>{children}</PinGate>
        </I18nProvider>
      </body>
    </html>
  );
}
