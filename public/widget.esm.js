/**
 * ESM 入口：给 Vue / React / Vite / Nuxt 项目直接 import 用
 *
 *   import { initAssistant } from "https://ai.example.com/widget.esm.js";
 *   await initAssistant({
 *     apiBase: "https://ai.example.com",
 *     siteKey: "www",
 *     sessionKey: "aiassist-www",
 *     spa: true,
 *   });
 *
 * 内部还是会加载 widget.js（同一份 UI/动作代码），只是把配置提前注入。
 */
export function initAssistant(cfg = {}) {
  window.__AI_ASSISTANT__ = { ...(window.__AI_ASSISTANT__ || {}), ...cfg };
  if (window.__kikiDebug) return Promise.resolve(window.__kikiDebug);
  const src = cfg.src || `${cfg.apiBase || ""}/widget.js`;
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find((s) => s.src === new URL(src, location.href).href);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.__kikiDebug));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve(window.__kikiDebug);
    s.onerror = () => reject(new Error("assistant widget 加载失败"));
    document.head.appendChild(s);
  });
}

export default initAssistant;
