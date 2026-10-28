"use client";

// Minimal two-language UI layer.
//
// The language is stored in a cookie so the root layout can render the first
// paint in the right language (no flash), and it is shared by both pages.
// Only UI copy lives here — API error codes are translated by the same
// dictionary via the `error.*` keys.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { LANG_COOKIE, type Lang } from "./lang";

export type { Lang };

const zh = {
  "app.title": "图纸尺寸识别 — 标注定位 + 内容识别",
  "app.description": "先定位、再识别：把工程图纸上的尺寸标注逐步转成可复核的结构化清单。",

  "header.library": "图纸库",
  "header.language": "界面语言",
  "header.tagline": "Vision LLM Dimension Extraction",

  "pin.eyebrow": "受保护演示",
  "pin.title": "PIN 验证",
  "pin.copy": "该演示每次运行都会调用视觉大模型。请输入 PIN 解锁，刷新页面后需重新验证。",
  "pin.placeholder": "请输入 PIN",
  "pin.submit": "确认",
  "pin.verifying": "验证中…",
  "pin.empty": "请输入 PIN。",
  "pin.wrong": "PIN 错误。",

  "gallery.title": "图纸库",
  "gallery.subtitle":
    "先定位，再识别。系统先把图上的标注框出来，由你确认范围，再逐条读取数值、公差与类型 —— 每一步都看得见，也都能改。",
  "gallery.flow.locate": "① 标注定位",
  "gallery.flow.read": "② 内容识别",
  "gallery.flow.review": "③ 复核导出",
  "gallery.upload.title": "上传图纸",
  "gallery.upload.full": "本次会话已上传 {n} 张",
  "gallery.upload.busy": "正在上传…",
  "gallery.upload.drop": "松开即可上传",
  "gallery.upload.hint": "拖拽到这里，或点击选择文件 · PNG / JPG · 单张 ≤ 10 MB",
  "gallery.upload.fullHint": "删除一张后可继续上传，刷新页面会重新开始。",
  "gallery.section.uploads": "本次上传",
  "gallery.section.uploadsNote": "仅本次会话可见",
  "gallery.section.tests": "测试图纸",
  "gallery.loading": "加载中…",
  "gallery.stats": "{tests} 张测试图纸 · {uploads} 张本次上传",
  "gallery.badge.session": "本次会话",
  "gallery.card.delete": "删除这张图纸",
  "gallery.card.start": "开始 →",
  "gallery.card.continue": "继续 →",
  "gallery.error.load": "无法加载图纸列表。",
  "gallery.error.loadShort": "加载失败",
  "gallery.error.type": "只支持 PNG 和 JPG 图纸。",
  "gallery.error.size": "单张图纸不能超过 10 MB。",
  "gallery.error.limit": "本次会话最多上传 {n} 张，刷新页面可重新开始。",
  "gallery.error.upload": "上传失败",
  "gallery.error.delete": "删除失败",

  "status.untested": "未检测",
  "status.queued": "排队中",
  "status.locating": "正在定位…",
  "status.located": "已定位 {n} 处",
  "status.reading": "识别中 {done}/{total}",
  "status.done": "已识别 {n} 条",
  "status.doneReview": "已识别 {n} 条 · {m} 待复核",
  "status.failed": "上次运行失败 · 可重试",

  "ws.back": "← 图纸库",
  "ws.loading": "正在加载…",
  "ws.drawingFallback": "图纸",
  "ws.error.runNotFound": "找不到这次检测记录，可能已过期。",
  "ws.error.imageNotFound": "找不到这张图纸，可能已过期，请回到图纸库重试。",
  "ws.error.load": "加载失败",
  "ws.error.locate": "标注定位失败",
  "ws.error.read": "内容识别失败",
  "ws.error.saveBoxes": "保存框失败",
  "ws.error.export": "标注图生成失败，请重试。",
  "ws.error.exportEmpty": "标注图内容为空，请重试。",
  "ws.steps.aria": "检测进度",
  "ws.step.locate": "标注定位",
  "ws.step.read": "内容识别",
  "ws.step.review": "复核导出",
  "ws.view.original": "原图",
  "ws.view.locate": "定位框",
  "ws.view.result": "识别结果",
  "ws.canvas.hint": "深蓝框＝候选位置 · 拖动空白处新增 · 选中后 Delete 删除",
  "ws.canvas.reading": "正在读取，框会逐条上色",
  "ws.canvas.alt": "图纸",
  "ws.canvas.boxTitle": "标注 {n}",
  "ws.canvas.deleteBox": "删除这个框",
  "ws.status.idle": "选择设置后点击「标注定位」。",
  "ws.status.queued": "排队中 · 前面还有 {n} 个任务",
  "ws.status.queuedShort": "排队中…",
  "ws.status.locating": "正在定位标注，请稍候…",
  "ws.status.reading": "正在逐条读取 {done}/{total}",
  "ws.status.located": "已框出 {n} 处，可增删后再识别。",
  "ws.status.done": "识别完成，可复核并导出。",
  "ws.status.failed": "上次运行失败，可重试。",
  "ws.settings.title": "检测设置",
  "ws.settings.scope": "识别范围",
  "ws.settings.scope.dimensions": "仅尺寸标注",
  "ws.settings.scope.all": "含技术要求与注释",
  "ws.settings.density": "密集程度",
  "ws.settings.density.conservative": "保守（少框，少误报）",
  "ws.settings.density.standard": "标准",
  "ws.settings.density.aggressive": "激进（多框，少漏检）",
  "ws.settings.channel": "AI 通道",
  "ws.settings.channel.saas": "LLM（SaaS）· 默认",
  "ws.settings.channel.local": "LLM（本地）",
  "ws.settings.excludeTitle": "排除标题栏",
  "ws.settings.note": "修改设置后需要重新定位才会生效。",
  "ws.actions.title": "执行",
  "ws.actions.locate": "标注定位",
  "ws.actions.relocate": "重新定位",
  "ws.actions.locating": "正在定位…",
  "ws.actions.read": "内容识别",
  "ws.actions.reread": "重新识别",
  "ws.actions.reading": "正在识别…",
  "ws.metrics.title": "本次运行",
  "ws.metrics.boxes": "已框出",
  "ws.metrics.detected": "已识别",
  "ws.metrics.review": "待复核",
  "ws.metrics.channel": "通道",
  "ws.channel.short.saas": "SaaS",
  "ws.channel.short.local": "本地",
  "ws.metrics.unit.box": "处",
  "ws.metrics.unit.dim": "条",
  "ws.metrics.locate": "定位",
  "ws.metrics.read": "识别",
  "ws.metrics.total": "合计",
  "ws.export.title": "导出",
  "ws.export.png": "下载标注图",
  "ws.export.generating": "正在生成…",
  "ws.export.csv": "导出明细 CSV",
  "ws.results.title": "识别结果",
  "ws.results.meta": "{n} 条 · {m} 条待复核",
  "ws.results.metaTime": " · 识别耗时 {s}s",
  "ws.legend.linear": "线性",
  "ws.legend.diameter": "直径",
  "ws.legend.angle": "角度",
  "ws.legend.radius": "半径",
  "ws.legend.review": "待复核",
  "ws.empty.noResult.title": "还没有识别结果",
  "ws.empty.noResult.copy": "确认框的位置无误后，点击右侧「内容识别」，系统会逐条读取每个框里的数值。",
  "ws.empty.noRun.title": "这张图纸还没有开始",
  "ws.empty.noRun.copy": "点击右侧「标注定位」，系统会先把图上的尺寸标注框出来 —— 只框位置，不读数字。",

  "table.empty": "暂无识别结果",
  "table.raw": "原始文字",
  "table.nominal": "公称值",
  "table.tolerance": "公差",
  "table.unit": "单位",
  "table.type": "类型",
  "table.feature": "特征",
  "table.confidence": "置信度",
  "table.status": "状态",
  "table.review": "⚠ 待复核",
  "table.ok": "✓ OK",
  "table.failed": "读取失败",

  "error.pin_required": "PIN 验证已失效，请刷新页面重新输入 PIN。",
  "error.pin_wrong": "PIN 错误。",
  "error.pin_config": "应用 PIN 未配置，请联系管理员。",
  "error.queue_full": "当前排队已满，请稍后再试。",
  "error.quota": "本次会话已达到检测次数上限，刷新页面可重新开始。",
  "error.no_boxes": "还没有可识别的框，请先完成标注定位。",
  "error.busy": "任务正在执行，请稍候。",
  "error.run_not_found": "找不到这次检测记录，可能已过期。",
  "error.image_not_found": "找不到这张图纸，可能已过期，请重新上传。",
  "error.no_results": "还没有识别结果，无法导出标注图。",
  "error.export_failed": "标注图生成失败，请重试。",
  "error.llm_timeout": "AI 通道响应超时，请重试或切换通道。",
  "error.llm_unavailable": "AI 通道暂时不可用，请稍后重试或切换通道。",
  "error.llm_config": "AI 通道配置有误（密钥或模型），请联系管理员。",
  "error.engine_failed": "识别引擎执行失败，请重试。",
  "error.upload_type": "只支持 PNG 和 JPG 图纸。",
  "error.upload_size": "单张图纸不能超过 10 MB。",
  "error.upload_limit": "本次会话最多上传 {n} 张。",
  "error.upload_failed": "上传失败",
  "error.upload_not_found": "这张上传的图纸不存在。",
  "error.invalid_request": "请求无效，请刷新页面重试。",
  "error.generic": "操作失败，请重试。",
} as const;

type Dict = typeof zh;
export type TKey = keyof Dict;

const en: Record<TKey, string> = {
  "app.title": "Drawing Dimension Reader — locate, then read",
  "app.description":
    "Locate first, read second: turn the annotations on an engineering drawing into a reviewable, structured list.",

  "header.library": "Library",
  "header.language": "Interface language",
  "header.tagline": "Vision LLM Dimension Extraction",

  "pin.eyebrow": "Protected demo",
  "pin.title": "PIN required",
  "pin.copy":
    "Every run calls a vision model. Enter the PIN to continue — you will be asked again after a refresh.",
  "pin.placeholder": "Enter PIN",
  "pin.submit": "Unlock",
  "pin.verifying": "Verifying…",
  "pin.empty": "Please enter the PIN.",
  "pin.wrong": "Incorrect PIN.",

  "gallery.title": "Drawing library",
  "gallery.subtitle":
    "Locate first, read second. The system boxes every annotation so you can confirm the range, then reads the value, tolerance and type inside each box — every step is visible, and editable.",
  "gallery.flow.locate": "① Locate",
  "gallery.flow.read": "② Read",
  "gallery.flow.review": "③ Review",
  "gallery.upload.title": "Upload a drawing",
  "gallery.upload.full": "Upload limit reached ({n})",
  "gallery.upload.busy": "Uploading…",
  "gallery.upload.drop": "Drop to upload",
  "gallery.upload.hint": "Drag a file here, or click to choose · PNG / JPG · up to 10 MB",
  "gallery.upload.fullHint": "Delete one to upload more; refreshing starts a new session.",
  "gallery.section.uploads": "Uploaded this session",
  "gallery.section.uploadsNote": "Visible in this session only",
  "gallery.section.tests": "Test drawings",
  "gallery.loading": "Loading…",
  "gallery.stats": "{tests} test drawings · {uploads} uploaded",
  "gallery.badge.session": "This session",
  "gallery.card.delete": "Delete this drawing",
  "gallery.card.start": "Start →",
  "gallery.card.continue": "Continue →",
  "gallery.error.load": "Could not load the drawing list.",
  "gallery.error.loadShort": "Load failed",
  "gallery.error.type": "Only PNG and JPG drawings are supported.",
  "gallery.error.size": "Each drawing must be 10 MB or smaller.",
  "gallery.error.limit": "Up to {n} drawings per session; refresh to start over.",
  "gallery.error.upload": "Upload failed",
  "gallery.error.delete": "Delete failed",

  "status.untested": "Not analysed",
  "status.queued": "Queued",
  "status.locating": "Locating…",
  "status.located": "{n} boxes located",
  "status.reading": "Reading {done}/{total}",
  "status.done": "{n} dimensions read",
  "status.doneReview": "{n} read · {m} to review",
  "status.failed": "Last run failed · retry",

  "ws.back": "← Library",
  "ws.loading": "Loading…",
  "ws.drawingFallback": "Drawing",
  "ws.error.runNotFound": "This run could not be found; it may have expired.",
  "ws.error.imageNotFound":
    "This drawing could not be found; go back to the library and try again.",
  "ws.error.load": "Load failed",
  "ws.error.locate": "Locate failed",
  "ws.error.read": "Read failed",
  "ws.error.saveBoxes": "Could not save the boxes",
  "ws.error.export": "Could not render the annotated image — please retry.",
  "ws.error.exportEmpty": "The annotated image came back empty — please retry.",
  "ws.steps.aria": "Progress",
  "ws.step.locate": "Locate",
  "ws.step.read": "Read",
  "ws.step.review": "Review",
  "ws.view.original": "Original",
  "ws.view.locate": "Boxes",
  "ws.view.result": "Results",
  "ws.canvas.hint":
    "Navy boxes are candidates · drag on empty space to add · Delete removes the selected box",
  "ws.canvas.reading": "Reading — boxes colour in one by one",
  "ws.canvas.alt": "Drawing",
  "ws.canvas.boxTitle": "Box {n}",
  "ws.canvas.deleteBox": "Delete this box",
  "ws.status.idle": "Adjust the settings, then click “Locate”.",
  "ws.status.queued": "Queued · {n} ahead",
  "ws.status.queuedShort": "Queued…",
  "ws.status.locating": "Locating annotations…",
  "ws.status.reading": "Reading {done}/{total}",
  "ws.status.located": "{n} boxes found — add or delete, then read.",
  "ws.status.done": "Done — review and export.",
  "ws.status.failed": "Last run failed — retry.",
  "ws.settings.title": "Settings",
  "ws.settings.scope": "Scope",
  "ws.settings.scope.dimensions": "Dimensions only",
  "ws.settings.scope.all": "Include notes & requirements",
  "ws.settings.density": "Density",
  "ws.settings.density.conservative": "Conservative (fewer boxes)",
  "ws.settings.density.standard": "Standard",
  "ws.settings.density.aggressive": "Aggressive (catch more)",
  "ws.settings.channel": "AI channel",
  "ws.settings.channel.saas": "LLM (SaaS) · default",
  "ws.settings.channel.local": "LLM (local)",
  "ws.settings.excludeTitle": "Exclude title block",
  "ws.settings.note": "Changes take effect on the next locate run.",
  "ws.actions.title": "Run",
  "ws.actions.locate": "Locate",
  "ws.actions.relocate": "Re-locate",
  "ws.actions.locating": "Locating…",
  "ws.actions.read": "Read",
  "ws.actions.reread": "Re-read",
  "ws.actions.reading": "Reading…",
  "ws.metrics.title": "This run",
  "ws.metrics.boxes": "Boxes",
  "ws.metrics.detected": "Read",
  "ws.metrics.review": "To review",
  "ws.metrics.channel": "Channel",
  "ws.channel.short.saas": "SaaS",
  "ws.channel.short.local": "Local",
  "ws.metrics.unit.box": "",
  "ws.metrics.unit.dim": "",
  "ws.metrics.locate": "Locate",
  "ws.metrics.read": "Read",
  "ws.metrics.total": "Total",
  "ws.export.title": "Export",
  "ws.export.png": "Download annotated PNG",
  "ws.export.generating": "Rendering…",
  "ws.export.csv": "Export CSV",
  "ws.results.title": "Detected dimensions",
  "ws.results.meta": "{n} dimensions · {m} to review",
  "ws.results.metaTime": " · read in {s}s",
  "ws.legend.linear": "Linear",
  "ws.legend.diameter": "Diameter",
  "ws.legend.angle": "Angle",
  "ws.legend.radius": "Radius",
  "ws.legend.review": "To review",
  "ws.empty.noResult.title": "No results yet",
  "ws.empty.noResult.copy":
    "Once the boxes look right, click “Read” to read the value printed inside each box.",
  "ws.empty.noRun.title": "This drawing has not been analysed",
  "ws.empty.noRun.copy":
    "Click “Locate” to box the dimension annotations first — position only, no numbers.",

  "table.empty": "No dimensions detected",
  "table.raw": "Raw text",
  "table.nominal": "Nominal",
  "table.tolerance": "Tolerance",
  "table.unit": "Unit",
  "table.type": "Type",
  "table.feature": "Feature",
  "table.confidence": "Confidence",
  "table.status": "Status",
  "table.review": "⚠ Review",
  "table.ok": "✓ OK",
  "table.failed": "Read failed",

  "error.pin_required": "PIN verification expired — refresh the page and enter the PIN again.",
  "error.pin_wrong": "Incorrect PIN.",
  "error.pin_config": "No PIN is configured on the server — contact the administrator.",
  "error.queue_full": "The queue is full — please try again shortly.",
  "error.quota": "This session reached its run limit; refresh to start over.",
  "error.no_boxes": "There are no boxes to read — run “Locate” first.",
  "error.busy": "A task is already running — please wait.",
  "error.run_not_found": "This run could not be found; it may have expired.",
  "error.image_not_found": "This drawing could not be found; please upload it again.",
  "error.no_results": "Nothing to export — read the boxes first.",
  "error.export_failed": "Could not render the annotated image — please retry.",
  "error.llm_timeout": "The AI channel timed out — retry or switch channels.",
  "error.llm_unavailable": "The AI channel is unavailable — retry later or switch channels.",
  "error.llm_config": "The AI channel is misconfigured (key or model).",
  "error.engine_failed": "The detection engine failed — please retry.",
  "error.upload_type": "Only PNG and JPG drawings are supported.",
  "error.upload_size": "Each drawing must be 10 MB or smaller.",
  "error.upload_limit": "Up to {n} drawings per session.",
  "error.upload_failed": "Upload failed",
  "error.upload_not_found": "That uploaded drawing no longer exists.",
  "error.invalid_request": "Invalid request — refresh the page and try again.",
  "error.generic": "Something went wrong — please retry.",
};

const DICTS: Record<Lang, Record<string, string>> = { zh, en };

type Vars = Record<string, string | number>;

export type Translate = (key: TKey | string, vars?: Vars) => string;

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue>({
  lang: "en",
  setLang: () => {},
  t: (key) => String(key),
});

export function I18nProvider({
  initialLang,
  children,
}: {
  initialLang: Lang;
  children: React.ReactNode;
}) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    // Persisted in a cookie so the server renders the right language on the
    // next request (no flash of the other language).
    document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => {
      const table = DICTS[lang];
      let text = table[String(key)] ?? DICTS.zh[String(key)] ?? String(key);
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replaceAll(`{${name}}`, String(value));
        }
      }
      return text;
    },
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/** True when the dictionary has a translation for this key. */
export function hasKey(key: string): boolean {
  return key in DICTS.zh;
}

/**
 * Translate a server error. API routes return a stable `code`; anything
 * unknown falls back to the raw message, then to a generic sentence.
 */
export function errorText(
  t: Translate,
  err: { code?: string | null; message?: string | null } | null | undefined,
  fallbackKey: TKey = "error.generic"
): string {
  const key = err?.code ? `error.${err.code}` : "";
  if (key && hasKey(key)) return t(key);
  if (err?.message) return err.message;
  return t(fallbackKey);
}
