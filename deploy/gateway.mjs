/**
 * 反代注入网关（动态模式：URL 第一段就是目标站点，零配置、无例外）
 * ---------------------------------------------------------------
 *    http://网关:3000/www.example.com/      →  https://www.example.com
 *    http://网关:3000/127.0.0.1:3001/      →  http://127.0.0.1:3001
 *    http://网关:3000/10.0.0.10:17000/     →  http://10.0.0.10:17000
 *
 * 规则只有一条：第一段路径 = 目标地址（域名或 IP，可带端口），后面原样透传。
 * 内外网一视同仁，不需要白名单、不需要提前登记站点。
 *
 * 协议自动判断：带端口且不是 443/8443 → 先试 http；否则先试 https，失败回落另一种。
 * 选中的协议会缓存，后续请求不再试探。
 *
 * 自动处理：
 *   - 前缀改写：href/src/action/poster/srcset、<base>、内联与独立 CSS 的 url()、
 *               指向源站的绝对地址、Location 响应头、set-cookie 的 Path
 *   - 外部资源：页面里其它域名的资源自动走 /_ext/ 通道，带正确 Referer（绕 CDN 防盗链）
 *   - gzip/br 解压再注入、CSP/HSTS 剥离、Cookie Domain 剥离、Origin/Referer 改写、
 *     WebSocket 透传、配置热加载
 *
 * ⚠ 安全：网关等于把「能访问这个端口的人」变成「能访问内网任意 HTTP 服务的人」。
 *   请用防火墙限制来源网段，不要把 3000 直接对公网开放。
 *
 * 用法：
 *   node deploy/gateway.mjs                          # 读同目录 gateway.config.json
 *   node deploy/gateway.mjs --config ./my.json
 *   node deploy/gateway.mjs --probe www.example.com   # 单站点体检
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ 参数 ——
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROBE = argOf("--probe", null);
const CONFIG_PATH = path.resolve(
  argOf("--config", process.env.GW_CONFIG || path.join(__dirname, "gateway.config.json")),
);
const MARK = "__ai_assistant_gateway__";
const LOG_PATH = process.env.GW_LOG || "";
const gwLog = (s) => {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${s}\n`);
  } catch {}
};

// ------------------------------------------------------------ 配置加载 ——
function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  cfg.assistant = cfg.assistant || {};
  // 环境变量优先，方便同一份配置在不同环境部署
  cfg.assistant.base = String(process.env.GW_ASSISTANT_BASE || cfg.assistant.base || "http://127.0.0.1:8820").replace(/\/+$/, "");
  cfg.assistant.widgetPath = cfg.assistant.widgetPath || "/widget.js";
  cfg.defaults = cfg.defaults || {};
  cfg.bind = cfg.bind || "0.0.0.0";
  cfg.port = Number(cfg.port || 3000);
  cfg.publicScheme = cfg.publicScheme || "http";
  cfg.dynamic = cfg.dynamic || {};
  cfg.dynamic.wildcardExt = cfg.dynamic.wildcardExt !== false;
  return cfg;
}

// ------------------------------------------------------------- 注入片段 ——
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function buildSnippet(cfg) {
  const base = String(cfg.assistant.base).replace(/\/+$/, "");
  const g = (k, d) => (cfg.defaults[k] != null ? cfg.defaults[k] : d);
  const attrs = [
    `src="${base}${cfg.assistant.widgetPath}"`,
    `data-api-base="${base}"`,
    `data-site-key="${esc(g("siteKey", "default"))}"`,
    `data-session-key="${esc(g("sessionKey", "aiassist"))}"`,
    `data-title="${esc(g("title", "AI 助手"))}"`,
    g("spa", false) ? 'data-spa="true"' : "",
    "defer",
  ].filter(Boolean);
  return `<script ${MARK} ${attrs.join(" ")}></script>`;
}

// ------------------------------------------------------- SPA 路由前缀修复 ——
// 反代把站点挂在 /<slug> 下，前端路由（React Router / Vue Router）读到的是带前缀的
// location.pathname，路由表匹配不上 → 整页"页面不存在"（夜莺 /10.10.5.2:17000/dashboards
// 就是这样）。修法：文档一进来就把前缀从地址栏摘掉，让路由看到干净的 /dashboards；
// 同时把站点标识以 ?__gw=<slug> 挂回 URL —— SPA 自己 pushState 出来的地址也带着它，
// 刷新、深链接、多站点并存都能从这条 URL 反推出属于哪个站点，不依赖 cookie 猜。
// 只对 SPA 空壳做：普通多页站点靠文档 URL 解析相对路径，摘了前缀反而会把相对链接弄坏。
const SPA_HINT_RE =
  /<div[^>]+id\s*=\s*["'](?:root|app|__next|__nuxt|main-app)["']|__NEXT_DATA__|__NUXT__|data-server-rendered|ng-version\s*=\s*["']/i;

/** 响应体像不像 SPA 空壳（只有这种页面才能安全摘掉路径前缀） */
function looksLikeSpa(html) {
  return SPA_HINT_RE.test(String(html || "").slice(0, 20000));
}

/** 注入到 SPA 文档最前面的小脚本：摘前缀 + 把站点标识挂回 URL + 之后的路由跳转沿用 */
function buildSpaShim(ctx) {
  const P = JSON.stringify(ctx.prefix);
  const S = JSON.stringify(ctx.slug);
  return (
    `<script ${MARK}-spa>(function(){try{` +
    `var P=${P},S=${S},M="__gw",E=encodeURIComponent(S),op=history.pushState,or=history.replaceState;` +
    `function hasQ(q){return q.indexOf(M+"=")>=0}` +
    `function addQ(q){return hasQ(q)?q:(q?q+"&":"?")+M+"="+E}` +
    `function strip(p){if(/\\.[a-z0-9]{1,8}$/i.test(p))return p;` +
    `if(p===P)return"/";if(p.indexOf(P+"/")===0)return p.slice(P.length);return p}` +
    `function tidy(u){var a;try{a=new URL(String(u),location.href)}catch(e){return u}` +
    `if(a.origin!==location.origin)return u;var p=strip(a.pathname),q=addQ(a.search);` +
    `return(p===a.pathname&&q===a.search)?u:p+q+a.hash}` +
    `function self(){return location.pathname+addQ(location.search)+location.hash}` +
    `var p0=strip(location.pathname),q0=addQ(location.search);` +
    `if(p0!==location.pathname||q0!==location.search){try{or.call(history,history.state,"",p0+q0+location.hash)}catch(e){}}` +
    `history.pushState=function(st,t,u){try{return op.call(history,st,t,(u===undefined||u===null||u==="")?self():tidy(u))}catch(e){return op.call(history,st,t,u)}};` +
    `history.replaceState=function(st,t,u){try{return or.call(history,st,t,(u===undefined||u===null||u==="")?self():tidy(u))}catch(e){return or.call(history,st,t,u)}};` +
    `}catch(e){}})();</script>`
  );
}

function inject(html, ctx) {
  if (html.includes(MARK)) return html;
  const snippet = ctx.snippet;
  const shim = looksLikeSpa(html) ? buildSpaShim(ctx) : "";
  let placed = false;
  if (shim) {
    // 必须排在站点自己的脚本前面：路由初始化之前就要把地址栏洗干净
    const open = html.search(/<head[^>]*>/i);
    if (open >= 0) {
      const end = html.indexOf(">", open);
      if (end >= 0) {
        html = html.slice(0, end + 1) + shim + html.slice(end + 1);
        placed = true;
      }
    }
  }
  const lead = placed ? "" : shim;
  const head = html.search(/<\/head\s*>/i);
  if (head >= 0) return html.slice(0, head) + snippet + html.slice(head);
  const body = html.search(/<body[^>]*>/i);
  if (body >= 0) {
    const end = html.indexOf(">", body);
    if (end >= 0) return html.slice(0, end + 1) + lead + snippet + html.slice(end + 1);
  }
  return lead + snippet + html;
}

// --------------------------------------------------------- 响应体解压 ——
function decodeBody(buf, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf).toString("utf8");
    if (enc.includes("gzip")) return zlib.gunzipSync(buf).toString("utf8");
    if (enc.includes("deflate")) {
      try {
        return zlib.inflateSync(buf).toString("utf8");
      } catch {
        return zlib.inflateRawSync(buf).toString("utf8");
      }
    }
  } catch {}
  return buf.toString("utf8");
}

const DROP_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "x-content-type-options",
  "clear-site-data",
]);

// ------------------------------------------------------------ 内容改写 ——
const ATTR_RE = /(\b(?:href|src|action|poster|data-src)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi;
const ABS_ASSET_RE = /(\b(?:src|poster|data-src)\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;
const LINK_HREF_RE = /(<link\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;
const SRCSET_RE = /(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi;
const CSSURL_RE = /url\((\s*)(["']?)(\/(?!\/)[^)"']*)\2(\s*)\)/gi;
const CSSABS_RE = /url\((\s*)(["']?)(https?:\/\/[^)"']+)\2(\s*)\)/gi;

const fixRootPath = (value, prefix) =>
  !value || !prefix || !value.startsWith("/") || value.startsWith("//") ? value : prefix + value;

/** 把任意域名改写到 /_ext/ 通道 */
function toExt(url, ctx) {
  try {
    const u = new URL(url);
    if (u.host === ctx.targetHost) return ctx.prefix + (u.pathname || "/") + (u.search || "");
    return `${ctx.prefix}/_ext/${u.host}${u.pathname || "/"}${u.search || ""}`;
  } catch {
    return url;
  }
}

function rewriteHtml(html, ctx) {
  const { prefix, targetOrigin, targetHost } = ctx;
  // 站点自带 <base> 才需要改写；没有就不要注入——浏览器本来就会按文档 URL 解析相对路径，
  // 文档 URL 已经带着前缀了，硬塞一个 <base href="/prefix/"> 反而会把
  // /prefix/seeyon/xxx.jsp 里的相对链接解析成 /prefix/xxx
  const baseTag = html.match(/<base\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/i);
  if (baseTag) {
    const orig = baseTag[2] || "/";
    let next;
    if (/^https?:\/\//i.test(orig)) next = prefix + "/";
    else if (orig.startsWith("/")) next = prefix + orig;
    else next = prefix + "/" + orig.replace(/^\.\//, "");
    html = html.replace(baseTag[0], `<base href="${next}">`);
  } else {
    html = html.replace(/<base\b[^>]*>/gi, "");
  }
  if (targetOrigin) html = html.split(targetOrigin).join(prefix);
  if (targetHost) html = html.split("//" + targetHost).join(prefix);
  html = html.replace(ATTR_RE, (m, a, q, v) => `${a}${q}${prefix}${v}${q}`);
  if (ctx.wildcardExt) {
    html = html.replace(ABS_ASSET_RE, (m, a, q, v) => `${a}${q}${toExt(v, ctx)}${q}`);
    html = html.replace(LINK_HREF_RE, (m, a, q, v) => `${a}${q}${toExt(v, ctx)}${q}`);
  }
  html = html.replace(SRCSET_RE, (m, a, q, v) => {
    const out = v
      .split(",")
      .map((part) => {
        const t = part.trim();
        if (!t) return t;
        const sp = t.split(/\s+/);
        sp[0] = /^https?:\/\//i.test(sp[0])
          ? ctx.wildcardExt
            ? toExt(sp[0], ctx)
            : sp[0]
          : fixRootPath(sp[0], prefix);
        return sp.join(" ");
      })
      .join(", ");
    return `${a}${q}${out}${q}`;
  });
  return rewriteCss(html, ctx);
}

function rewriteCss(css, ctx) {
  if (ctx.wildcardExt) css = css.replace(CSSABS_RE, (m, s1, q, v, s2) => `url(${s1}${q}${toExt(v, ctx)}${q}${s2})`);
  return css.replace(CSSURL_RE, (m, s1, q, v, s2) => `url(${s1}${q}${ctx.prefix}${v}${q}${s2})`);
}

function rewriteLocation(loc, ctx) {
  if (!loc) return loc;
  const { prefix, targetOrigin, targetHost } = ctx;
  if (targetOrigin && loc.startsWith(targetOrigin)) {
    return fixRootPath(loc.slice(targetOrigin.length) || "/", prefix) || prefix + "/";
  }
  if (targetHost && loc.startsWith("//" + targetHost)) {
    return fixRootPath(loc.slice(("//" + targetHost).length) || "/", prefix) || prefix + "/";
  }
  if (/^https?:\/\//i.test(loc)) return toExt(loc, ctx);
  return fixRootPath(loc, prefix) || prefix + "/";
}

/**
 * Cookie 要同时满足两种请求形态：
 *   带前缀的页面资源 /oa.example.com/seeyon/x.js
 *   站点 JS 拼出的根路径 /seeyon/getAJAXOnlineServlet
 * 所以 Path 统一放宽成 /，否则根路径请求带不上会话 cookie（会被站点判定掉线）。
 * 为了多站点不串会话，cookie 名字统一加站点前缀 gw_<hash>_，上行时再还原。
 */
const siteHash = (slug) => crypto.createHash("sha1").update(slug).digest("hex").slice(0, 8);

function rewriteSetCookie(list, ctx) {
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  const h = siteHash(ctx.slug);
  return arr.map((c) => {
    let out = String(c).replace(/;\s*domain=[^;]*/gi, "");
    // Name=Value 前缀化
    out = out.replace(/^\s*([^=;\s]+)\s*=/, (m, name) => `${SITE_COOKIE}_${h}_${name}=`);
    out = out.replace(/;\s*path=([^;]*)/gi, "; Path=/");
    if (ctx.publicIsHttp) {
      // 明文 http 下 Secure 会被浏览器丢弃；SameSite=None 又必须配 Secure，
      // 只去掉 Secure 而保留 None 会被浏览器整条拒收 → 一起降级
      const hadSecure = /;\s*secure\b/i.test(out);
      out = out.replace(/;\s*secure\b/gi, "");
      if (hadSecure) out = out.replace(/;\s*samesite=none\b/gi, "; SameSite=Lax");
    }
    return out;
  });
}

/** 请求发往上游前，把本站点的 gw_<hash>_X 还原成 X，其它站点的 cookie 丢掉 */
function upstreamCookie(req, ctx) {
  const raw = String((req && req.headers) ? req.headers.cookie || "" : "");
  if (!raw) return "";
  const mine = `${SITE_COOKIE}_${siteHash(ctx.slug)}_`;
  const out = [];
  for (const part of raw.split(";")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    const name = s.slice(0, i);
    const value = s.slice(i + 1);
    if (name === SITE_COOKIE) continue; // 网关自己的
    if (name.startsWith(mine)) out.push(`${name.slice(mine.length)}=${value}`);
    else if (new RegExp(`^${SITE_COOKIE}_[0-9a-f]{8}_`).test(name)) continue; // 其它站点
    else out.push(`${name}=${value}`); // 站点 JS 自己写的 cookie
  }
  return out.join("; ");
}

// ------------------------------------------------------------ 上下文 ——
/** slug → { host, port }；slug 形如 www.example.com 或 127.0.0.1:3001 */
function parseSlug(slug) {
  const s = slug.toLowerCase();
  if (!/^[a-z0-9._-]+(:\d+)?$/.test(s)) return null;
  if (!/[.:]/.test(s) && s !== "localhost") return null;
  return { slug: s };
}

const schemeCache = new Map(); // slug -> "https" | "http"

function schemeOrder(slug) {
  const cached = schemeCache.get(slug);
  if (cached) return [cached];
  const port = slug.includes(":") ? Number(slug.split(":")[1]) : null;
  // 非标准 https 端口就先试 http，省一次失败握手
  if (port && ![443, 8443].includes(port)) return ["http", "https"];
  return ["https", "http"];
}

function makeContext(cfg, slug, scheme) {
  const target = new URL(`${scheme}://${slug}`);
  const isHttps = target.protocol === "https:";
  return {
    cfg,
    slug,
    prefix: "/" + slug,
    target,
    isHttps,
    targetOrigin: `${target.protocol}//${target.host}`,
    targetHost: target.host,
    basePath: "",
    wildcardExt: cfg.dynamic.wildcardExt,
    publicIsHttp: cfg.publicScheme === "http",
    snippet: buildSnippet(cfg),
  };
}

const ctxCache = new Map(); // slug -> ctx

function getContext(cfg, slug) {
  const hit = ctxCache.get(slug);
  if (hit) return hit;
  const ctx = makeContext(cfg, slug, schemeOrder(slug)[0]);
  ctxCache.set(slug, ctx);
  return ctx;
}

// ------------------------------------------------------------ 请求处理 ——
/** 去掉第一段（站点 slug），得到要透传给上游的路径；同时兼容 URL 编码过的 slug */
function stripFirstSegment(url) {
  const q = url.indexOf("?");
  const pathPart = q >= 0 ? url.slice(0, q) : url;
  const qs = q >= 0 ? url.slice(q) : "";
  const second = pathPart.indexOf("/", 1);
  const rest = second >= 0 ? pathPart.slice(second) : "/";
  return { rest: rest || "/", qs };
}

function upstreamPath(ctx, reqUrl) {
  const { rest, qs } = stripFirstSegment(reqUrl);
  return rest + qs;
}

function upstreamHeaders(ctx, req) {
  const headers = { ...req.headers, host: ctx.targetHost };
  const ck = upstreamCookie(req, ctx);
  if (ck) headers.cookie = ck;
  else delete headers.cookie;
  if (headers.origin) headers.origin = ctx.targetOrigin;
  if (headers.referer) {
    try {
      const r = new URL(headers.referer);
      const { rest } = stripFirstSegment(r.pathname || "/");
      headers.referer = ctx.targetOrigin + rest + r.search;
    } catch {
      headers.referer = ctx.targetOrigin + "/";
    }
    headers.referer = dropGwParam(headers.referer);
  }
  return headers;
}

// SPA 会把接口/WebSocket 写成根路径（/socket.io/、/api/…），这些请求没有站点前缀。
// 用 cookie 记住"当前正在用哪个站点"，把这类根路径请求归还给对应站点。
const SITE_COOKIE = "gw_site";
const ROOT_FALLBACK = new Set(["socket.io", "sockjs", "sockjs-node", ".well-known"]);

function cookieSite(req) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SITE_COOKIE) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim()).toLowerCase();
      } catch {
        return null;
      }
    }
  }
  return null;
}

// SPA 摘下路径前缀后，站点标识改走 URL 上的 ?__gw=<slug>：
// 页面自己的地址带着它，XHR/资源请求的 Referer 也带着它，所以根路径请求不再只靠 cookie 猜
// —— 一个浏览器同时开几个站点（几个 cookie 只能留最后一个）也不会串。
const GW_Q = "__gw";

/** 从 URL/Referer 里取 __gw */
function gwParam(s) {
  const i = String(s || "").indexOf(GW_Q + "=");
  if (i < 0) return null;
  let v = s.slice(i + GW_Q.length + 1).split("&")[0].split("#")[0];
  try {
    v = decodeURIComponent(v);
  } catch {}
  v = String(v).toLowerCase();
  return parseSlug(v) ? v : null;
}

/** 转发给上游之前把网关自己的参数摘掉，站点不该看到 __gw */
function dropGwParam(s) {
  const str = String(s || "");
  if (!str.includes(GW_Q + "=")) return str;
  const qi = str.indexOf("?");
  if (qi < 0) return str;
  const hi = str.indexOf("#", qi);
  const path = str.slice(0, qi);
  const query = str
    .slice(qi + 1, hi < 0 ? str.length : hi)
    .split("&")
    .filter((p) => p && !p.startsWith(GW_Q + "="));
  const hash = hi < 0 ? "" : str.slice(hi);
  return path + (query.length ? "?" + query.join("&") : "") + hash;
}

/** 这条根路径请求属于哪个站点：URL 的 __gw → Referer 的 __gw → Referer 里的站点前缀 → cookie */
function resolveSite(req) {
  const fromUrl = gwParam(req.url);
  if (fromUrl) return fromUrl;
  const ref = String((req.headers && req.headers.referer) || "");
  if (ref) {
    const fromRef = gwParam(ref);
    if (fromRef) return fromRef;
    try {
      const u = new URL(ref);
      const seg = decodeURIComponent((u.pathname || "/").split("/")[1] || "").toLowerCase();
      if (parseSlug(seg)) return seg;
    } catch {}
  }
  return cookieSite(req);
}

// /management.html 这类是页面文件，不是站点域名
const FILE_LIKE = /\.(html?|php|aspx?|jsp|do|action|ashx|cgi|json|xml|txt|pdf|png|jpe?g|gif|svg|webp|ico|css|js|map|woff2?|ttf)$/i;

/** 这个首段不该被当作目标站点，应该走"根路径兜底" */
function needsRootFallback(slug) {
  if (!parseSlug(slug)) return true; // 没有点/冒号，不可能是域名
  if (ROOT_FALLBACK.has(slug)) return true;
  return FILE_LIKE.test(slug);
}

function handleRequest(cfg, req, res, attempt = 0) {
  const url = String(req.url || "/");
  const seg = url.split("?")[0].split("/")[1] || "";
  let slug;
  try {
    slug = decodeURIComponent(seg).toLowerCase().replace(/\/+$/, "");
  } catch {
    slug = seg;
  }
  if (!slug) return sendHelp(cfg, res);

  // 裸站点（/www.example.com 没有结尾斜杠）→ 补斜杠
  // 否则页面里所有相对路径都会少解析一层（浏览器把最后一段当成文件名）
  const pathOnly = url.split("?")[0];
  if (!needsRootFallback(slug) && pathOnly.indexOf("/", 1) < 0) {
    const q = url.indexOf("?");
    res.writeHead(301, { location: `/${slug}/${q >= 0 ? url.slice(q) : ""}` });
    return res.end();
  }

  let rest;
  let qs = "";
  if (needsRootFallback(slug)) {
    // 根路径请求：交给当前站点，并把完整路径透传过去
    const site = resolveSite(req);
    if (!site || !parseSlug(site)) return sendHelp(cfg, res, `根路径请求 ${url} 没有可归属的站点`);
    slug = site;
    const q = url.indexOf("?");
    rest = q >= 0 ? url.slice(0, q) : url;
    qs = q >= 0 ? url.slice(q) : "";
    // 页面类请求（/management.html）直接跳到带前缀的地址，让相对路径恢复正常
    if (FILE_LIKE.test(seg) && /text\/html/i.test(String(req.headers.accept || ""))) {
      res.writeHead(302, { location: `/${slug}${rest}${qs}` });
      return res.end();
    }
  } else {
    const s = stripFirstSegment(url);
    rest = s.rest;
    qs = s.qs;
  }
  if (rest.startsWith("/_ext/")) return proxyExt(cfg, slug, rest.slice("/_ext/".length), req, res);

  const ctx = getContext(cfg, slug);
  gwLog(`=> ${req.method} ${url}  [slug=${slug} scheme=${ctx.isHttps ? "https" : "http"} cookie=${req.headers.cookie ? "y" : "n"}]`);
  const upstream = ctx.isHttps ? https : http;
  const opts = {
    protocol: ctx.target.protocol,
    hostname: ctx.target.hostname,
    port: ctx.target.port || (ctx.isHttps ? 443 : 80),
    path: dropGwParam(rest + qs),
    method: req.method,
    headers: upstreamHeaders(ctx, req),
    ...(ctx.isHttps ? { rejectUnauthorized: false } : {}),
  };

  const up = upstream.request(opts, (r) => {
    // 内网老系统常常只开 http：https 打到错误的 vhost 会返回 403/404。
    // 首次请求（GET/HEAD、协议还没定）遇到 4xx/5xx 就换另一种协议再试一次。
    const code = r.statusCode || 0;
    if (attempt === 0 && !schemeCache.has(slug) && (req.method === "GET" || req.method === "HEAD") && code >= 400) {
      r.resume();
      schemeCache.set(slug, otherScheme(ctx));
      ctxCache.delete(slug);
      return handleRequest(cfg, req, res, 1);
    }
    onResponse(ctx, r, res, req);
  });
  up.on("error", (e) => {
    const order = schemeOrder(slug);
    const next = order[attempt + 1] || (attempt === 0 && order.length === 1 ? otherScheme(ctx) : null);
    if (next && next !== (ctx.isHttps ? "https" : "http")) {
      schemeCache.set(slug, next);
      ctxCache.delete(slug);
      return handleRequest(cfg, req, res, attempt + 1);
    }
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`gateway upstream error: ${e.message}\n目标: ${ctx.targetOrigin}\n`);
  });
  req.pipe(up);
}

function otherScheme(ctx) {
  return ctx.isHttps ? "http" : "https";
}

/** 页面导航 vs 数据请求：决定要不要改写 HTML */
function isDocumentRequest(req) {
  const dest = String((req && req.headers["sec-fetch-dest"]) || "").toLowerCase();
  if (dest) return dest === "document" || dest === "iframe" || dest === "frame" || dest === "embed";
  if (req && req.headers["x-requested-with"]) return false;
  const accept = String((req && req.headers.accept) || "");
  if (/text\/html/i.test(accept)) return true;
  if (/application\/json|text\/javascript/i.test(accept)) return false;
  return true; // curl / 老浏览器：兜底按页面处理
}

/** 只有顶层文档才注入助手：iframe 里再起一个面板会出现"两个助手" */
function shouldInject(req) {
  const dest = String((req && req.headers["sec-fetch-dest"]) || "").toLowerCase();
  if (dest) return dest === "document";
  return isDocumentRequest(req);
}

function onResponse(ctx, r, res, req) {
  const ctype = String(r.headers["content-type"] || "");
  try {
    const sc = r.headers["set-cookie"];
    gwLog(
      `<= ${r.statusCode} ${ctx.isHttps ? "https" : "http"}://${ctx.targetHost} ${ctype.split(";")[0]}${sc ? " set-cookie=" + (Array.isArray(sc) ? sc.length : 1) : ""}`,
    );
  } catch {}
  const isHtml = ctype.includes("text/html");
  const isCss = ctype.includes("text/css");

  const docReq = isHtml ? isDocumentRequest(req) : false;
  if ((!isHtml || !docReq) && !isCss) {
    const h = { ...r.headers };
    if (h.location) h.location = rewriteLocation(h.location, ctx);
    if (h["set-cookie"]) h["set-cookie"] = rewriteSetCookie(h["set-cookie"], ctx);
    res.writeHead(r.statusCode || 502, h);
    return r.pipe(res);
  }

  const chunks = [];
  r.on("data", (c) => chunks.push(c));
  r.on("end", () => {
    let text = decodeBody(Buffer.concat(chunks), r.headers["content-encoding"]);
    const ok2xx = (r.statusCode || 0) >= 200 && (r.statusCode || 0) < 300;
    try {
      if (isHtml && docReq) {
        text = rewriteHtml(text, ctx);
        if (ok2xx && shouldInject(req)) text = inject(text, ctx);
      } else if (!isCss) {
        // XHR 拿到的 "text/html" 是数据，原样返回
      } else {
        text = rewriteCss(text, ctx);
      }
    } catch (e) {
      console.error(`[gw:${ctx.slug}] 改写失败:`, e.message);
    }
    const h = {};
    for (const [k, v] of Object.entries(r.headers)) {
      if (DROP_HEADERS.has(k.toLowerCase()) || k.toLowerCase() === "location") continue;
      h[k] = v;
    }
    if (r.headers.location) h.location = rewriteLocation(r.headers.location, ctx);
    if (r.headers["set-cookie"]) h["set-cookie"] = rewriteSetCookie(r.headers["set-cookie"], ctx);
    if (isHtml) {
      // 记住"当前站点"，好让 SPA 的根路径请求（/socket.io/、/api/…）能回到它
      const siteCookie = `${SITE_COOKIE}=${encodeURIComponent(ctx.slug)}; Path=/; SameSite=Lax`;
      const prev = h["set-cookie"];
      h["set-cookie"] = prev ? (Array.isArray(prev) ? [...prev, siteCookie] : [prev, siteCookie]) : [siteCookie];
    }
    h["content-type"] = isHtml ? "text/html; charset=utf-8" : "text/css; charset=utf-8";
    if (isHtml) h["cache-control"] = h["cache-control"] || "no-store";
    const body = Buffer.from(text, "utf8");
    h["content-length"] = body.length;
    res.writeHead(r.statusCode || 200, h);
    res.end(body);
  });
}

/** 外部资源通道：替浏览器带正确 Referer 去取（CDN 防盗链） */
function proxyExt(cfg, slug, rest, req, res) {
  const slash = rest.indexOf("/");
  const extHost = (slash >= 0 ? rest.slice(0, slash) : rest).toLowerCase();
  const extPath = slash >= 0 ? rest.slice(slash) : "/";
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(extHost)) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    return res.end(`gateway: 非法资源域名 ${extHost}\n`);
  }
  const hostOnly = extHost.split(":")[0];
  const port = extHost.includes(":") ? Number(extHost.split(":")[1]) : 443;
  const ctx = getContext(cfg, slug);
  const up = https.request(
    {
      hostname: hostOnly,
      port,
      path: extPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: extHost,
        referer: ctx.targetOrigin + "/",
        ...(req.headers.origin ? { origin: ctx.targetOrigin } : {}),
      },
      rejectUnauthorized: false,
    },
    (r) => {
      const ctype = String(r.headers["content-type"] || "");
      if (!ctype.includes("text/css") && !ctype.includes("text/html")) {
        res.writeHead(r.statusCode || 502, r.headers);
        return r.pipe(res);
      }
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        let text = decodeBody(Buffer.concat(chunks), r.headers["content-encoding"]);
        if (ctype.includes("text/css")) {
          const hostBase = `/${slug}/_ext/${extHost}`;
          text = rewriteCss(text, ctx).replace(CSSURL_RE, (m, s1, q, v, s2) => `url(${s1}${q}${hostBase}${v}${q}${s2})`);
        }
        const h = {};
        for (const [k, v] of Object.entries(r.headers)) {
          if (DROP_HEADERS.has(k.toLowerCase())) continue;
          h[k] = v;
        }
        const body = Buffer.from(text, "utf8");
        h["content-length"] = body.length;
        h["content-type"] = ctype;
        res.writeHead(r.statusCode || 200, h);
        res.end(body);
      });
    },
  );
  up.on("error", (e) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`gateway ext error: ${e.message}\n`);
  });
  req.pipe(up);
}

// --------------------------------------------------------------- 帮助页 ——
function sendHelp(cfg, res, msg) {
  res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>怎么用</title>
<style>body{font:14px/1.9 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:40px;background:#f5f7fb;color:#1f2937}
h1{font-size:20px;margin:0 0 4px}code{background:#eef2fa;padding:2px 6px;border-radius:6px}
.err{color:#b91c1c;margin:12px 0}.tip{color:#6b7280;margin-top:18px}li{margin:4px 0}</style></head><body>
<h1>直接访问就行</h1>
${msg ? `<div class="err">${msg}</div>` : ""}
<p>把要代理的站点写在第一段路径里，后面原样透传：</p>
<ul>
  <li><code>http://&lt;这台机器&gt;:${cfg.port}/www.example.com/</code> → https://www.example.com</li>
  <li><code>http://&lt;这台机器&gt;:${cfg.port}/127.0.0.1:3001/</code> → http://127.0.0.1:3001</li>
  <li><code>http://&lt;这台机器&gt;:${cfg.port}/10.0.0.10:17000/</code> → http://10.0.0.10:17000</li>
</ul>
<p class="tip">内外网都一样，不需要登记。带端口且不是 443/8443 时自动按 http 访问，其余按 https，失败会自动换协议。</p>
</body></html>`);
}

// ---------------------------------------------------------------- 主流程 ——
let server = null;

function buildServer(cfg) {
  const srv = http.createServer((req, res) => {
    const u = String(req.url || "/").split("?")[0];
    if (u === "/" || u === "/index.html" || u === "/_gw/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(
        JSON.stringify(
          {
            port: cfg.port,
            mode: "dynamic",
            assistant: cfg.assistant.base,
            usage: `http://<host>:${cfg.port}/<domain-or-ip[:port]>/`,
            uptimeSec: Math.round(process.uptime()),
          },
          null,
          2,
        ),
      );
    }
    handleRequest(cfg, req, res);
  });

  srv.on("upgrade", (req, socket, head) => {
    const rawUrl = String(req.url || "/");
    const seg = rawUrl.split("?")[0].split("/")[1] || "";
    let slug;
    try {
      slug = decodeURIComponent(seg).toLowerCase();
    } catch {
      slug = seg;
    }
    let wsPath;
    if (needsRootFallback(slug)) {
      // SPA 的 WebSocket 也走根路径（/socket.io/），同样归还给当前站点
      const site = resolveSite(req);
      if (!site || !parseSlug(site)) return socket.destroy();
      slug = site;
      wsPath = rawUrl;
    } else {
      wsPath = stripFirstSegment(rawUrl).rest + stripFirstSegment(rawUrl).qs;
    }
    const ctx = getContext(cfg, slug);
    const upstream = ctx.isHttps ? https : http;
    const opts = {
      protocol: ctx.target.protocol,
      hostname: ctx.target.hostname,
      port: ctx.target.port || (ctx.isHttps ? 443 : 80),
      path: wsPath,
      method: "GET",
      headers: { ...upstreamHeaders(ctx, req), upgrade: "websocket", connection: "Upgrade" },
      rejectUnauthorized: false,
    };
    const up = upstream.request(opts);
    up.on("upgrade", (r, upSocket, upHead) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          Object.entries(r.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (upHead && upHead.length) socket.write(upHead);
      upSocket.on("data", (d) => socket.write(d));
      socket.on("data", (d) => upSocket.write(d));
      const close = () => {
        upSocket.destroy();
        socket.destroy();
      };
      upSocket.on("close", close);
      socket.on("close", close);
      upSocket.on("error", close);
      socket.on("error", close);
    });
    up.on("error", () => socket.destroy());
    up.end();
  });

  return srv;
}

function start(cfg) {
  ctxCache.clear();
  schemeCache.clear();
  const srv = buildServer(cfg);
  srv.on("error", (e) => console.error(`[gw] 监听 ${cfg.port} 失败: ${e.message}`));
  srv.listen(cfg.port, cfg.bind, () => {
    console.log(`[gw] http://${cfg.bind}:${cfg.port}/   动态模式，无白名单`);
    console.log(`[gw]   用法  http://<网关>:${cfg.port}/www.example.com/`);
    console.log(`[gw]         http://<网关>:${cfg.port}/127.0.0.1:3001/`);
    console.log(`[gw]   助手  ${cfg.assistant.base}${cfg.assistant.widgetPath}`);
  });
  return srv;
}

async function probe(cfg, slug) {
  const url = `http://127.0.0.1:${cfg.port}/${encodeURIComponent(slug)}/`;
  const { status, body } = await new Promise((resolve, reject) => {
    const req = http.get(
      url,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
          host: slug.split(":")[0],
        },
        timeout: 25000,
      },
      (r) => {
        const c = [];
        r.on("data", (d) => c.push(d));
        r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
  const ok = body.includes(MARK);
  console.log(`${ok ? "OK  " : "FAIL"} /${slug}/  status=${status} injected=${ok} len=${body.length}`);
  return ok ? 0 : 1;
}

const cfg0 = loadConfig();
if (PROBE) {
  server = start(cfg0);
  await new Promise((r) => setTimeout(r, 400));
  const bad = await probe(cfg0, PROBE);
  server.close();
  process.exit(bad);
} else {
  server = start(cfg0);
  console.log(`[gw] 配置: ${CONFIG_PATH}`);
  fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    try {
      const next = loadConfig();
      const old = server;
      server = start(next);
      setTimeout(() => old && old.close(), 200);
      console.log("[gw] 配置已重载");
    } catch (e) {
      console.error("[gw] 配置重载失败，继续用旧配置:", e.message);
    }
  });
  const shutdown = () => {
    console.log("[gw] 退出");
    server && server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
