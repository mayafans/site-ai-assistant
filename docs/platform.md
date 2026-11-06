# AI 助手平台（管理端 + 通用 widget）

把「KiKi 式站内助手」打包成可复用服务：**一个后台配站点，一段 script 嵌到任意网站**。

## 组成

| 文件 | 说明 |
|---|---|
| `server.mjs` | 管理 API + 运行时 Agent（SSE）+ 静态页面 |
| `public/admin.html` | 管理后台：站点 / LLM / 技能 / 业务请求 / 话术 / 主题 / 接入代码 |
| `public/widget.js` | 通用页面 SDK（由 `npm run build` 从 `src/sdk.js` 生成，单一源码） |
| `public/demo.html` | 模拟业务页（工单），演示嵌入 |
| `data/sites.json` | 站点配置存储（生产可换 DB） |
| `build-widget.mjs` | 重新生成 widget.js |
| `probe-chat.mjs` | 无浏览器联调（SSE + 工具调用） |

## 运行

```powershell
cd <repo>
node build-widget.mjs                       # 改了 sdk.js 之后重新生成
$env:ADMIN_USER="admin"                     # 首次启动创建管理员，可省略
$env:ADMIN_PASSWORD="换成强密码"            # 省略则随机密码打印在日志里
node server.mjs                             # http://127.0.0.1:8820/admin
```

- 首次启动会创建管理员并写入 `data/users.json`（scrypt 加盐哈希，不存明文）；
- 后台用**用户名 + 密码**登录，登录态是 HttpOnly Cookie（8 小时）；
- 角色：`viewer` 只读 / `editor` 可改站点配置 / `admin` 可改配置 + 管用户；
- 管理员后台可添加用户、重置密码、删除用户（至少保留一个管理员）；
- 匿名访客可直接使用页面助手，按 IP 限流（默认 30 次/分钟，`CHAT_RATE_PER_MIN` 可调）。

默认站点（default）会使用`DEEPSEEK_API_KEY` 环境变量兜底；也可以在每个站点里单独配 LLM。

## 在业务网站接入（一行）

```html
<script src="http://127.0.0.1:8820/widget.js"
        data-api-base="http://127.0.0.1:8820"
        data-site-key="default"
        data-title="业务助手"
        data-theme="#3b6cff"
        defer></script>
```

- `data-site-key` 决定使用后台哪个站点的 LLM / 技能 / 业务工具 / 话术；
- 同源部署时可省略 `data-api-base`；
- 也支持 `window.__AI_ASSISTANT__ = {...}` 在加载前注入配置；
- 跨域部署时后台按站点的「允许来源」返回 CORS 头（`*` 表示全部）。

## 后台能配什么

1. **基础**：站点 ID / 名称 / Key / 允许来源；
2. **LLM**：Base URL、模型、API Key（留空不修改；支持任意 OpenAI 兼容端点）；
3. **对话与外观**：标题、副标题、主题色、欢迎语、建议问题、系统提示词、是否自动展开；
4. **技能**：`name / description / body`，模型需要时用 `skill` 工具加载正文（等价 SKILL.md）；
5. **业务请求**：服务端 HTTP 工具（方法、URL 支持 `{参数}` 占位、Headers、JSON Schema 参数），模型直接调用，密钥不进浏览器；
6. **接入代码**：自动生成嵌入 snippet。

## 运行时协议

- `POST /api/chat?site=<id>`，SSE 返回 `text-delta` / `tool-input-available` / `done`；
- 客户端工具：`invokeClient`（页面动作）、`askUser`（确认）、`readPage`（重读快照）；
- 服务端工具：后台配置的 HTTP 请求，模型调用后由服务端执行并回填结果；
- 会话按 `site + sessionId` 保存在服务端内存（重启丢失，生产需持久化）。

## 接入不同前端

原则：**每个「站点」只需要在公共入口加载一次**，不是每个页面都加。

### 1. 传统多页站（PHP / Thymeleaf / JSP / 静态 HTML）
放在公共 header/footer 模板里一次，所有页面都会注入：

```html
<script src="https://ai.example.com/widget.js"
        data-api-base="https://ai.example.com"
        data-site-key="www"
        data-session-key="aiassist-www"
        defer></script>
```

### 2. Vue 3 + Vite（SPA）
`index.html` 里加一次；SPA 路由切换不会重新加载脚本，助手不会消失、对话不断：

```html
<script src="https://ai.example.com/widget.js"
        data-api-base="https://ai.example.com"
        data-site-key="www"
        data-session-key="aiassist-www"
        data-spa="true"
        defer></script>
```

- `data-spa="true"`：站内 `<a>` 不再被拦截，交给 vue-router；
- 路由切换（pushState/replaceState/popstate）时会清空旧 ref 缓存，避免点到已卸载的组件；
- 每次提问仍会带最新页面快照。

不想写死在 HTML 里，也可以在 `main.ts` 动态加载：

```ts
const api = import.meta.env.VITE_AI_API;
if (api) {
  const s = document.createElement("script");
  s.src = `${api}/widget.js`;
  Object.assign(s.dataset, {
    apiBase: api,
    siteKey: "www",
    sessionKey: "aiassist-www",
    spa: "true",
  });
  s.defer = true;
  document.head.appendChild(s);
}
```

### 3. Nuxt 3
`nuxt.config.ts`：

```ts
export default defineNuxtConfig({
  app: {
    head: {
      script: [{
        src: "https://ai.example.com/widget.js",
        defer: true,
        "data-api-base": "https://ai.example.com",
        "data-site-key": "www",
        "data-session-key": "aiassist-www",
        "data-spa": "true",
      }],
    },
  },
});
```

### 4. React（CRA / Vite）
`public/index.html` 加同一段脚本，或在根组件 `useEffect` 里动态注入。

### 5. ESM 方式（任意框架）
```ts
import { initAssistant } from "https://ai.example.com/widget.esm.js";
await initAssistant({
  apiBase: "https://ai.example.com",
  siteKey: "www",
  sessionKey: "aiassist-www",
  spa: true,
});
```

## 说明

- 同一页面重复加载会被 `window.__kikiDemo` 防重，不会出现两个助手；
- 对话记录按 `data-session-key` 存在 localStorage，同域共享；不同站点用不同 key 隔离；
- 后台「允许来源」决定 `/api/*` 的 CORS；widget 静态文件允许任意来源加载。

## 图片与截图

助手现在能“看图”，两条通道都走供应商的多模态接口（DeepSeek `deepseek-chat` 实测可直接吃图）：

| 通道 | 触发方式 | 说明 |
|---|---|---|
| 用户上传 / 粘贴 | 输入框左下角 🖼，或 `Ctrl+V` 粘贴、图片拖入面板 | 最多 3 张；浏览器内缩到长边 1280px / JPEG 0.82 再发；可只发图 |
| 模型主动截图 | 模型下发 `invokeClient {command:"screenshot"}` | html2canvas-pro 截**当前视口**（jpeg 0.6），排除助手浮窗；图片作为紧随其后的用户消息附给模型 |
| 重复操作兜底 | 连续 3 次相同动作 | 服务端自动下发一次 `screenshot`，提示模型“结合截图判断页面状态、换思路” |

实现位置：

- 前端：`src/sdk.js`（`captureScreenshot()`、`postToolResult()` 的 `images` 字段）；
- 服务端：本文件 `handleChat` 的 tool 分支（`normalizeImages` / `pendingShot` / 截图用户消息）；
- 策略：`shared/shot-policy.mjs`（含单测 `test/shot-policy.test.mjs`，13 条用例）。

注意：

- `screenshot` 只是**视口**，看不到的部分要先 `scroll`/跳转再截；
- 跨域图片可能让 canvas 污染导致截图失败，此时返回失败信息让模型改读文本；
- 成本：一张 1280px 图约 800–1500 token；截图按视口大小计，视口越大越贵。

