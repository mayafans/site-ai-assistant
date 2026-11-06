/**
 * AI 助手平台（管理端 + 运行时）
 *
 * 一个进程干三件事：
 *   1. /admin            管理页面：按「业务站点」配置 LLM、技能、业务请求(HTTP 工具)、话术、主题
 *   2. /api/admin/*      管理 API（X-Admin-Token 鉴权）
 *   3. /api/chat?site=   运行时 Agent（SSE + 客户端工具 invokeClient/askUser/readPage + 业务 HTTP 工具）
 *
 * 存储：data/sites.json（demo 用，生产可换 DB）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { shouldAutoScreenshot } from "./shared/shot-policy.mjs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const DATA = path.join(__dirname, "data");
const STORE = path.join(DATA, "sites.json");
const PORT = Number(process.env.PORT || 8820);
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = '0.4.1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin-" + crypto.randomBytes(4).toString("hex");

// ------------------------------------------------------------------ 存储 ——
fs.mkdirSync(DATA, { recursive: true });
let sites = {};
try {
  sites = JSON.parse(fs.readFileSync(STORE, "utf8"));
} catch {
  sites = {
    default: {
      id: "default",
      name: "默认站点",
      key: "default",
      origins: ["*"],
      llm: {
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: "",
      },
      ui: {
        title: "AI 助手",
        subtitle: "站点智能助手",
        welcome: "Hi，我是 AI 助手 ~",
        welcomeDesc: "可以问我当前页面上的任何内容",
        suggests: ["这个工单页面怎么填？", "帮我查一下订单的状态", "提交工单前要注意什么"],
        theme: "#3b6cff",
        autoOpen: true,
      },
      prompt: "",
      skills: [],
      tools: [],
      createdAt: new Date().toISOString(),
    },
  };
}
function saveSites() {
  fs.writeFileSync(STORE, JSON.stringify(sites, null, 2));
}
const initialToken = ADMIN_TOKEN;

// ------------------------------------------------------------ 用户与会话 ——
const USERS_FILE = path.join(DATA, "users.json");
let users = [];
try {
  users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
} catch {
  users = [];
}
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString("hex") };
}
function verifyPassword(pw, u) {
  try {
    const h = crypto.scryptSync(String(pw), u.salt, 32);
    return crypto.timingSafeEqual(h, Buffer.from(u.hash, "hex"));
  } catch {
    return false;
  }
}
// 首次启动创建管理员：优先用环境变量，否则随机密码打印一次
if (!users.length) {
  const username = process.env.ADMIN_USER || "admin";
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(4).toString("hex");
  const { salt, hash } = hashPassword(password);
  users.push({ username, salt, hash, role: "admin", createdAt: new Date().toISOString() });
  saveUsers();
  console.log(`[ai-assistant] 已创建管理员：${username} / ${password}（登录后请修改密码）`);
}

const SESSIONS = new Map(); // token -> { username, role, exp }
const SESSION_TTL = 8 * 3600 * 1000;
const COOKIE_NAME = "ai_admin";
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const s = token && SESSIONS.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    SESSIONS.delete(token);
    return null;
  }
  return s;
}
function authCookie(res, token) {
  const secure = process.env.COOKIE_SECURE ? "; Secure" : "";
  res.setHeader(
    "set-cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`,
  );
}
/** 鉴权：cookie 优先，兼容脚本用的 X-Admin-Token；need 为 admin 时要求管理员角色 */
function requireAuth(req, res, need = "any") {
  const user = currentUser(req);
  if (!user) {
    const tok = req.headers["x-admin-token"] || "";
    if (tok && tok === initialToken) {
      const pseudo = { username: "api-token", role: "admin" };
      return need === "admin" && pseudo.role !== "admin" ? (json(res, 403, { error: "forbidden" }), null) : pseudo;
    }
    json(res, 401, { error: "unauthorized" });
    return null;
  }
  if (need === "admin" && user.role !== "admin") {
    json(res, 403, { error: "forbidden" });
    return null;
  }
  if (need === "write" && !["admin", "editor"].includes(user.role)) {
    json(res, 403, { error: "forbidden" });
    return null;
  }
  return user;
}

// 对话限流：每个 IP 每分钟/每天上限，避免被刷爆 token
const RATE = new Map();
function checkRate(ip, limitPerMin = Number(process.env.CHAT_RATE_PER_MIN || 30)) {
  const now = Date.now();
  const slot = RATE.get(ip) || { start: now, count: 0 };
  if (now - slot.start > 60_000) {
    slot.start = now;
    slot.count = 0;
  }
  slot.count++;
  RATE.set(ip, slot);
  return slot.count <= limitPerMin;
}

// ---------------------------------------------------------------- 工具 ——
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 12 * 1024 * 1024) return reject(new Error("body too large"));
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
function serveStatic(url, res) {
  let p = url.pathname;
  if (p === "/") p = "/admin.html";
  if (p === "/admin") p = "/admin.html";
  if (p === "/demo") p = "/demo.html";
  const file = path.join(PUBLIC, p.replace(/^\/+/, ""));
  const rel = path.relative(PUBLIC, file);
  if (rel.startsWith("..") || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

// 本地兜底 key：只从环境变量读取，避免依赖任何本机凭据文件
function fallbackKey() {
  return process.env.DEEPSEEK_API_KEY || "";
}

// ------------------------------------------------------------- 站点配置 ——
function maskSite(site) {
  const copy = JSON.parse(JSON.stringify(site));
  if (copy.llm?.apiKey) copy.llm.apiKey = copy.llm.apiKey.slice(0, 6) + "******";
  return copy;
}

// --------------------------------------------------------------- Agent ——
const sessions = new Map(); // `${site}:${sessionId}` -> {llm, pending}

function systemPrompt(site) {
  const skillCatalog = (site.skills || []).length
    ? site.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
    : "（暂无技能）";
  const toolCatalog = (site.tools || []).length
    ? site.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")
    : "（暂无业务请求工具）";
  return (
    site.prompt ||
    `你是嵌入在网站页面里的 AI 助手，可以读取当前页面并直接操作页面控件。

当前页面会被序列化成缩进文本树，每个可交互元素带 [ref=N]（例如：- button "去结算" [ref=11]）。
\`- text [ref=N]: 内容\` 是页面正文（段落、表格单元格、新闻/公告全文），可直接引用和总结，不要声称“正文读不到”。
用户可能随消息附上 1~3 张图片（截图或照片），它们会作为 image_url 一起发给你，请直接看图回答，不要说你无法查看图片。
用 invokeClient 工具执行动作命令：goto <url> / click <ref> / hover <ref|css> / input <ref> "<文本>" / select <ref> <值> / scroll <ref> / highlight <ref> / screenshot
\`hover\` 把鼠标悬停到元素上，专治「悬停才出现」的东西：卡片/面板右上角的工具栏、表格行的操作按钮、hover 展开的下拉菜单。
悬停会自动从给定元素往上逐层试到容器，执行完的新快照会自动跟回来——看到新出现的菜单项（复制、删除、更多…）直接 click 它的 ref 即可。
没有 ref 的容器可以在 hover 后面直接给 CSS 选择器，例如 hover .ant-card。
\`screenshot\` 截取当前视口，截图会作为图片附在后续消息里给你看：正文是图片/图表、结构信息不足、或连续操作没进展时用它；看不到的部分先 scroll 再截。

规则：
1. 先看页面快照再决定动作；ref 只对当前快照有效。
2. 关键操作（提交、支付、删除）先 askUser 确认。
3. 一次只做一个动作，等结果再继续。
4. 需要业务数据时调用对应的业务工具，不要编造。
5. 找不到「复制/编辑/更多」这类入口时先别下结论说做不到：大概率是 hover 才出现，用 hover 悬停它所在的面板/行/卡片，再看新快照。
6. click 返回「页面没有变化」时，下一步优先试 hover 同一个元素或其父容器，而不是重复 click。
7. 回答用中文、简洁，可用 markdown。

可用技能（需要时先调 skill 加载完整说明）：
${skillCatalog}

可用业务工具（服务端执行，直接调用）：
${toolCatalog}`
  );
}

const CLIENT_TOOLS = new Set(["invokeClient", "askUser", "readPage"]);

function toolsFor(site) {
  const tools = [
    {
      type: "function",
      function: {
        name: "skill",
        description: "加载一个技能的完整说明，需要某类能力时先调用",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    },
    {
      type: "function",
      function: {
        name: "invokeClient",
        description: "在当前页面执行动作：goto/click/hover/input/select/scroll/highlight/screenshot。hover 用于悬停才出现的菜单入口（卡片右上角工具栏、行操作、hover 下拉），可传 ref 或 CSS 选择器",
        parameters: {
          type: "object",
          properties: { command: { type: "string" }, explain: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "askUser",
        description: "关键操作前请用户确认",
        parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
      },
    },
    {
      type: "function",
      function: {
        name: "readPage",
        description: "重新读取当前页面快照",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  for (const t of site.tools || []) {
    if (!t.name) continue;
    tools.push({
      type: "function",
      function: {
        name: t.name,
        description: t.description || t.name,
        parameters: t.params || { type: "object", properties: {} },
      },
    });
  }
  return tools;
}

async function llmChat(site, messages, tools) {
  const key = site.llm?.apiKey || fallbackKey();
  if (!key) throw new Error("该站点未配置 LLM API Key");
  const base = (site.llm?.baseURL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({
      model: site.llm?.model || "deepseek-chat",
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 1200,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).choices?.[0]?.message || {};
}

async function runHttpTool(site, name, args) {
  const tool = (site.tools || []).find((t) => t.name === name);
  if (!tool) return `没有名为 ${name} 的工具`;
  let url = String(tool.url || "");
  // {arg} 占位替换（query/path）
  url = url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(args?.[k] ?? ""));
  const headers = { "content-type": "application/json", ...(tool.headers || {}) };
  let body;
  if (tool.method && tool.method.toUpperCase() !== "GET") {
    body = JSON.stringify(args || {});
  }
  try {
    const res = await fetch(url, { method: (tool.method || "GET").toUpperCase(), headers, body });
    const txt = await res.text();
    return `HTTP ${res.status}\n${txt.slice(0, 4000)}`;
  } catch (e) {
    return `请求失败：${e.message}`;
  }
}

async function streamText(res, text, size = 14) {
  for (let i = 0; i < text.length; i += size) {
    sseSend(res, { type: "text-delta", delta: text.slice(i, i + size) });
    await new Promise((r) => setTimeout(r, 8));
  }
}
function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function endSse(res) {
  sseSend(res, { type: "done" });
  res.end();
}
function truncate(s, n = 6000) {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  return str.length > n ? str.slice(0, n) + "\n…(截断)" : str;
}

async function agentStep(ctx, res) {
  try {
    for (;;) {
      const msg = await llmChat(ctx.site, ctx.messages, toolsFor(ctx.site));
      const assistant = { role: "assistant", content: msg.content || "" };
      if ("reasoning_content" in msg) assistant.reasoning_content = msg.reasoning_content || "";
      if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
      ctx.messages.push(assistant);
      if (msg.content) await streamText(res, msg.content);

      const calls = msg.tool_calls || [];
      if (!calls.length) return endSse(res);

      let pending = null;
      for (const call of calls) {
        const name = call.function?.name;
        const args = (() => {
          try {
            return JSON.parse(call.function?.arguments || "{}");
          } catch {
            return {};
          }
        })();
        if (name === "skill") {
          const s = (ctx.site.skills || []).find((x) => x.name === args.name);
          ctx.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: s ? truncate(s.body, 8000) : `没有名为「${args.name}」的技能`,
          });
          continue;
        }
        if (name === "readPage") {
          ctx.messages.push({ role: "tool", tool_call_id: call.id, content: truncate(ctx.latestCtx, 12000) });
          continue;
        }
        if (CLIENT_TOOLS.has(name)) {
          pending = call;
          break;
        }
        // 业务 HTTP 工具：服务端执行
        const out = await runHttpTool(ctx.site, name, args);
        ctx.messages.push({ role: "tool", tool_call_id: call.id, content: truncate(out, 4000) });
      }
      if (pending) {
        const args = (() => {
          try {
            return JSON.parse(pending.function.arguments || "{}");
          } catch {
            return {};
          }
        })();
        if (pending.function.name === "invokeClient" && args.command) {
          ctx.cmds = (ctx.cmds || []).concat(String(args.command)).slice(-20);
        }
        ctx.pending = { callId: pending.id, name: pending.function.name };
        sseSend(res, {
          type: "tool-input-available",
          toolCallId: pending.id,
          toolName: pending.function.name,
          input: args,
        });
        return endSse(res);
      }
    }
  } catch (e) {
    console.error("[agent]", e);
    sseSend(res, { type: "text-delta", delta: `\n[模型调用失败] ${e.message}` });
    return endSse(res);
  }
}

function buildMessages(site, payload, userText) {
  const messages = [{ role: "system", content: systemPrompt(site) }];
  const history = Array.isArray(payload.messages) ? payload.messages.slice(0, -1).slice(-8) : [];
  for (const m of history) {
    if (m.role === "user" || m.role === "assistant") messages.push({ role: m.role, content: String(m.content || "") });
    else messages.push({ role: "assistant", content: `[工具] ${m.content}` });
  }
  const text = `[用户消息]\n${userText || "（用户只发了图片，请说明你看到了什么）"}\n\n[当前页面快照]\n${
    payload.pageContext || "（未获取）"
  }`;
  const images = normalizeImages(payload.images);
  messages.push({
    role: "user",
    content: images.length
      ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
      : text,
  });
  return messages;
}

/** 只接受前端缩放后的 dataURL 图片，限制张数与体积 */
function normalizeImages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const it of raw.slice(0, 4)) {
    const url = typeof it === "string" ? it : it && (it.dataUrl || it.url);
    if (typeof url !== "string") continue;
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(url)) continue;
    if (url.length > 4 * 1024 * 1024) continue;
    out.push(url);
  }
  return out;
}

async function handleChat(req, res, url) {
  const body = await readBody(req);
  const siteId = url.searchParams.get("site") || "default";
  const site = sites[siteId] || sites[Object.keys(sites)[0]];
  if (!site) return json(res, 404, { error: "site not found" });

  // 匿名访客限流（按 IP），防止被刷 token
  const ip =
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  if (!checkRate(ip)) {
    return json(res, 429, { error: "请求太频繁，请稍后再试" });
  }

  // CORS
  const origin = req.headers.origin || "*";
  const allow = (site.origins || ["*"]).includes("*") ? "*" : origin;
  res.setHeader("access-control-allow-origin", allow);
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("vary", "origin");
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  const sessionId = body.sessionId || "default";
  const key = `${site.id}:${sessionId}`;
  let ctx = sessions.get(key);

  const toolName = url.searchParams.get("tool");
  if (toolName) {
    if (!ctx) {
      sseSend(res, { type: "text-delta", delta: "会话已失效，请重新提问。" });
      return endSse(res);
    }
    if (body.pageContext) ctx.latestCtx = body.pageContext;
    const images = normalizeImages(body.images);
    sseSend(res, {
      type: "tool-output-ack",
      toolCallId: body.toolCallId,
      ok: body.output && body.output.ok !== false,
    });
    // 服务端自动注入的截图（打断重复操作循环）
    if (ctx.pendingShot && body.toolCallId === ctx.pendingShot.callId) {
      ctx.pendingShot = null;
      ctx.cmds = [];
      ctx.messages.push({
        role: "user",
        content: images.length
          ? [
              {
                type: "text",
                text: "（系统附上当前页面截图：你刚才连续重复了同一个操作。请结合截图判断页面真实状态，换一条思路继续，不要再重复同一动作。）",
              },
              ...images.map((url) => ({ type: "image_url", image_url: { url } })),
            ]
          : "（系统提示：你刚才连续重复了同一个操作，截图失败，请换一条思路继续，不要再重复同一动作。）",
      });
      return agentStep(ctx, res);
    }
    const callId =
      !body.toolCallId || body.toolCallId === "handover" ? ctx.pending?.callId || body.toolCallId : body.toolCallId;
    ctx.messages.push({ role: "tool", tool_call_id: callId, content: truncate(body.output || {}, 4000) });
    ctx.pending = null;
    if (images.length) {
      ctx.messages.push({
        role: "user",
        content: [
          { type: "text", text: "（上一步 screenshot 的页面截图已附上，请结合图片观察页面实际内容，再决定下一步。）" },
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      });
    }
    if (shouldAutoScreenshot(ctx.cmds)) {
      const shotCallId = "shot_" + Math.random().toString(36).slice(2, 8);
      ctx.pendingShot = { callId: shotCallId };
      sseSend(res, {
        type: "tool-input-available",
        toolCallId: shotCallId,
        toolName: "invokeClient",
        input: { command: "screenshot", explain: "检测到重复操作，自动截图确认页面状态" },
      });
      return endSse(res);
    }
    return agentStep(ctx, res);
  }

  if (!ctx) {
    ctx = { site, messages: [], pending: null, latestCtx: "", cmds: [], pendingShot: null };
    sessions.set(key, ctx);
  }
  ctx.site = site;
  if (body.pageContext) ctx.latestCtx = body.pageContext;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userText = String([...messages].reverse().find((m) => m.role === "user")?.content || "").slice(0, 4000);
  ctx.messages = buildMessages(site, { ...body, pageContext: ctx.latestCtx }, userText);
  ctx.pending = null;
  ctx.cmds = [];
  ctx.pendingShot = null;
  return agentStep(ctx, res);
}

// ------------------------------------------------- OpenAI 兼容代理 ——
// 页面内 Agent（page-agent）自己用 fetch 调 `${baseURL}/chat/completions`。
// Key 绝不能进页面，所以 baseURL 指向这里，由服务端统一注入上游 Key。
// 顺带做上游差异收敛：DeepSeek 之类不认 parallel_tool_calls / 具名 tool_choice。
function sanitizeUpstreamBody(body, base) {
  const out = { ...body };
  const isDeepSeek = /deepseek/i.test(base);
  if (isDeepSeek) {
    delete out.parallel_tool_calls;
    if (out.tool_choice && typeof out.tool_choice === "object") out.tool_choice = "required";
    delete out.temperature; // deepseek 的思考模型不认
  }
  if (!out.max_tokens) out.max_tokens = 1500;
  return out;
}

async function handleLlmProxy(req, res, url) {
  // 页面来源和助手服务不同源，必须放宽 CORS
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  const parts = url.pathname.split("/").filter(Boolean); // v1 [site] chat completions
  const siteSeg = parts.length >= 4 ? decodeURIComponent(parts[1]) : url.searchParams.get("site");
  const idOrKey = siteSeg || "default";
  const site = sites[idOrKey] || Object.values(sites).find((s) => s.key === idOrKey) || sites[Object.keys(sites)[0]];
  if (!site) return json(res, 404, { error: "site not found" });
  const key = site.llm?.apiKey || fallbackKey();
  if (!key) return json(res, 500, { error: "该站点未配置 LLM API Key" });

  const ip =
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  if (!checkRate(ip)) return json(res, 429, { error: { message: "请求太频繁，请稍后再试" } });

  const raw = await readBody(req);
  const base = (site.llm?.baseURL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  // 模型以后台站点配置为准，页面侧传什么都覆盖掉，避免被人替换成贵的模型
  const body = sanitizeUpstreamBody({ ...raw, model: site.llm?.model || raw.model || "deepseek-chat" }, base);
  try {
    let up = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let text = await up.text();
    // 个别上游不认 tool_choice:"required"，降级成 auto 再试一次
    if (up.status === 400 && /tool_choice|tool call/i.test(text)) {
      const relaxed = { ...body, tool_choice: "auto" };
      up = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify(relaxed),
      });
      text = await up.text();
    }
    res.writeHead(up.status, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  } catch (e) {
    json(res, 502, { error: { message: "上游调用失败：" + e.message } });
  }
}

// ---------------------------------------------------------- 用户管理 API ——
async function handleUsers(req, res, name) {
  const safe = (u) => ({ username: u.username, role: u.role, createdAt: u.createdAt });
  if (req.method === "GET" && !name) {
    return json(res, 200, { users: users.map(safe) });
  }
  if (req.method === "POST" && !name) {
    const b = await readBody(req);
    const username = String(b.username || "").trim();
    const password = String(b.password || "");
    if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) {
      return json(res, 400, { error: "用户名需为 2-32 位字母、数字或 _.-" });
    }
    if (password.length < 6) return json(res, 400, { error: "密码至少 6 位" });
    if (users.some((u) => u.username === username)) return json(res, 409, { error: "用户已存在" });
    const { salt, hash } = hashPassword(password);
    users.push({
      username,
      salt,
      hash,
      role: ["admin", "editor", "viewer"].includes(b.role) ? b.role : "viewer",
      createdAt: new Date().toISOString(),
    });
    saveUsers();
    return json(res, 200, { ok: true });
  }
  if (req.method === "PUT" && name) {
    const u = users.find((x) => x.username === name);
    if (!u) return json(res, 404, { error: "not found" });
    const b = await readBody(req);
    if (b.password) {
      if (String(b.password).length < 6) return json(res, 400, { error: "密码至少 6 位" });
      const { salt, hash } = hashPassword(b.password);
      u.salt = salt;
      u.hash = hash;
      // 改密码后踢掉该用户已有会话
      for (const [t, s] of SESSIONS) if (s.username === u.username) SESSIONS.delete(t);
    }
    if (b.role && ["admin", "editor", "viewer"].includes(b.role)) {
      if (u.role === "admin" && b.role !== "admin" && users.filter((x) => x.role === "admin").length <= 1) {
        return json(res, 400, { error: "至少保留一个管理员" });
      }
      u.role = b.role;
    }
    saveUsers();
    return json(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && name) {
    const idx = users.findIndex((x) => x.username === name);
    if (idx < 0) return json(res, 404, { error: "not found" });
    if (users[idx].role === "admin" && users.filter((x) => x.role === "admin").length <= 1) {
      return json(res, 400, { error: "至少保留一个管理员" });
    }
    for (const [t, s] of SESSIONS) if (s.username === name) SESSIONS.delete(t);
    users.splice(idx, 1);
    saveUsers();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "unknown users api" });
}

// -------------------------------------------------------------- 路由 ——
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    // /v1/* 的预检交给 handleLlmProxy：它会按需声明 authorization 等头
    if (url.pathname.startsWith("/v1/")) return await handleLlmProxy(req, res, url);
    res.writeHead(204, {
      "access-control-allow-origin": origin || "*",
      "access-control-allow-headers": "content-type,x-admin-token",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    return res.end();
  }

  try {
    if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res, url);

    // page-agent（页面内 Agent）的 OpenAI 兼容入口，Key 在服务端注入
    // baseURL 形如 /v1/<siteKey>，客户端自行拼上 /chat/completions
    if (/^\/v1(\/[^/]+)?\/chat\/completions\/?$/.test(url.pathname))
      return await handleLlmProxy(req, res, url);

    // ---- 账号登录（多人共用后台）----
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const b = await readBody(req);
      const u = users.find((x) => x.username === String(b.username || ""));
      if (!u || !verifyPassword(b.password, u)) return json(res, 401, { error: "用户名或密码错误" });
      const token = crypto.randomBytes(24).toString("hex");
      SESSIONS.set(token, { username: u.username, role: u.role, exp: Date.now() + SESSION_TTL });
      authCookie(res, token);
      return json(res, 200, { ok: true, user: { username: u.username, role: u.role } });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const token = parseCookies(req)[COOKIE_NAME];
      if (token) SESSIONS.delete(token);
      res.setHeader("set-cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const u = currentUser(req);
      if (!u) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, { user: { username: u.username, role: u.role } });
    }

    // 站点公开配置（给 widget 用：话术/主题，不含任何密钥和工具）
    if (req.method === "GET" && url.pathname.startsWith("/api/site/")) {
      const key = decodeURIComponent(url.pathname.slice("/api/site/".length));
      const site = sites[key] || Object.values(sites).find((s) => s.key === key);
      if (!site) return json(res, 404, { error: "site not found" });
      res.setHeader(
        "access-control-allow-origin",
        (site.origins || ["*"]).includes("*") ? "*" : req.headers.origin || "*",
      );
      return json(res, 200, { name: site.name, ui: site.ui || {} });
    }

    if (url.pathname === "/api/health") {
      return json(res, 200, { ok: true, version: VERSION, sites: Object.keys(sites).length, users: users.length });
    }

    if (url.pathname.startsWith("/api/admin/")) {
      const parts = url.pathname.split("/").filter(Boolean); // api admin users|sites ...
      const seg = parts[2] || "";
      const need = req.method === "GET" ? "any" : "write";
      const me = requireAuth(req, res, seg === "users" ? "admin" : need);
      if (!me) return;
      if (seg === "users") return await handleUsers(req, res, parts[3]);
      if (seg === "sites") {
        const id = parts[3];
        const action = parts[4];
        if (req.method === "GET" && !id) {
          return json(res, 200, {
            me,
            sites: Object.values(sites).map(maskSite),
          });
        }
        if (req.method === "GET" && id) {
          if (!sites[id]) return json(res, 404, { error: "not found" });
          return json(res, 200, maskSite(sites[id]));
        }
        if (req.method === "POST" && !id) {
          const body = await readBody(req);
          const newId = body.id || "site-" + crypto.randomBytes(3).toString("hex");
          sites[newId] = {
            id: newId,
            name: body.name || newId,
            key: body.key || newId,
            origins: body.origins || ["*"],
            llm: body.llm || { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "" },
            ui: body.ui || {},
            prompt: body.prompt || "",
            skills: body.skills || [],
            tools: body.tools || [],
            createdAt: new Date().toISOString(),
          };
          saveSites();
          return json(res, 200, maskSite(sites[newId]));
        }
        if (req.method === "PUT" && id) {
          if (!sites[id]) return json(res, 404, { error: "not found" });
          const body = await readBody(req);
          sites[id] = { ...sites[id], ...body, id };
          // 前端留空的 apiKey 表示不修改
          if (body.llm && (body.llm.apiKey === "" || body.llm.apiKey?.includes("******"))) {
            sites[id].llm.apiKey = sites[id].llm.apiKey || "";
          }
          saveSites();
          return json(res, 200, maskSite(sites[id]));
        }
        if (req.method === "DELETE" && id) {
          delete sites[id];
          saveSites();
          return json(res, 200, { ok: true });
        }
      }
      if (seg === "test-llm" && req.method === "POST") {
        const body = await readBody(req);
        const site = sites[body.id];
        if (!site) return json(res, 404, { error: "not found" });
        try {
          const msg = await llmChat({ ...site, llm: { ...site.llm, ...(body.llm || {}) } }, [
            { role: "user", content: "只回复：ok" },
          ], []);
          return json(res, 200, { ok: true, reply: msg.content || "" });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message });
        }
      }
      return json(res, 404, { error: "unknown admin api" });
    }

    if (req.method === "GET" && serveStatic(url, res)) return;
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[server]", e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ai-assistant] http://127.0.0.1:${PORT}/admin`);
  console.log(`[ai-assistant] 登录用户：${users.map((u) => u.username + "(" + u.role + ")").join(", ")}`);
});





