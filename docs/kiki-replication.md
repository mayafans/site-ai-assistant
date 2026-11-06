# 腾讯云智能助手 KiKi 是怎么「控制」腾讯云网站的 —— 实测拆解 + 复刻方案

> 结论先行：KiKi 不是浏览器插件，也不是"话术 + 链接"，而是 **「页面内 JS SDK + 服务端 Agent + SSE 工具调用循环」**。
> SDK 被注入到腾讯云所有控制台/购买页里，把当前页面序列化成**带 `[ref=N]` 编号的无障碍树文本**发给服务端大模型；
> 大模型通过 SSE 流下发 `invokeClient` 工具调用（例如 `goto https://buy.cloud.tencent.com/cvm`、`click 12`），
> SDK 在页面里执行、把结果回传，循环直到任务完成。跨页跳转用一次性 handover 票据接力，高风险动作强制人工确认。
> **这套技术可以完整复刻，且不需要浏览器扩展；我们自己的站点反而比腾讯云更好做——因为页面是我们可控的。**

---

## 一、实测证据（全部来自本机真实账号会话，非推测）

### 1. 页面里注入了一个公开可下载的 web-sdk
- 控制台与 CVM 购买页（`buy.cloud.tencent.com/cvm`）的页面里都加载了 `https://kiki.cloud.tencent.com/web-sdk.js`（4.17 MB）。
- 页面暴露全局 `window.kiki`，购买页上只有 `{devtools, ready, addTools}`；控制台上 `await window.kiki.ready()` 拿到完整控制器：
  `show / hide / chat / suggest / snapshot / invoke / setup / session / lite / mount / destroy / addAgentTab / addCVMTab / addLighthouseTab / enableDock / onDockRequest / onModeChange / dock / undock / tabs`。
- 悬浮入口是普通 DOM：`#helix-container > #helix-assistant-widget > .qcaa-launcher-btn`（48×48，贴右侧），面板样式前缀 `qcaa-`。
- 也就是说：**同一份 SDK 既能"内嵌到任意页面"，也能被宿主页面用 `window.kiki.chat()` / `addTools()` 反向调用**。

### 2. 页面理解 = 无障碍树快照（带 ref）
聊天请求体（实测抓包，控制台页面 8.4 KB、购买页 16.8 KB）长这样：

```json
{
  "messages": [{
    "role": "user",
    "parts": [
      { "type": "text", "text": "帮我打开云服务器 CVM 的购买页" },
      { "type": "data-page-context",
        "data": {
          "url": "https://console.cloud.tencent.com/cvm/index",
          "title": "腾讯云 - 控制台",
          "context": "- generic:\n  - link \"腾讯云\" [ref=2]:\n    - /url: https://cloud.tencent.com\n  - searchbox \"支持按产品名、实例ID、IP等搜索\"\n  - link: 云服务器\n  - ...（缩进文本树，每个可交互元素带 [ref=N]）"
        }
      }
    ]
  }],
  "url": "https://console.cloud.tencent.com/cvm/index",
  "uiLocale": "zh-CN",
  "clientIdentity": { "brandName": "腾讯云智能助手 KiKi" }
}
```

- `context` 是 **aria/accessibility 风格缩进文本树**，带 `/url:`、`[checked]`、`[disabled]`、`[cursor=pointer]` 等标记，单页上限约 15000 行。
- ref 是**纯数字**，靠 `data-qca-ref` 属性持久化，跨多次快照稳定（同一元素 ref 不变）。
- 页面文本被当作**不可信数据**随消息上行，指令权限仍在服务端。

### 3. 服务端下发「动作」——SSE 里的工具调用
聊天响应是 `text/event-stream`，事件是 Vercel AI SDK v5 的 UIMessage 流（`text-delta / tool-input-start / tool-input-available / tool-output-available`）。实测一次"帮我打开购买页"的完整工具链：

```text
tool-input-available  skill        { skillName: "tcloud-navigator" }   // 加载导航技能说明
tool-input-available  skill        { skillName: "tcloud-sitemap" }     // 加载站点地图技能
tool-input-available  bash         { explain: "正在查询云服务器购买页的官方入口地址", skill: "tcloud-sitemap" }
tool-output-available bash         { exitCode: 0, stdoutLength: 257 }  // 服务端有 shell 沙箱
tool-input-available  invokeClient { explain: "打开云服务器 CVM 的官方购买页",
                                     skill: "tcloud-navigator",
                                     command: "goto https://buy.cloud.tencent.com/cvm" }
```

**`invokeClient` 就是"在用户浏览器里执行动作"的工具**：`command` 是一条**文本命令**（不是 JSON），
例如 `goto <url>`、`click 12`、`input 5 "2核4G"`、`select 3 上海`、`scroll 8`、`screenshot`。

### 4. 客户端执行 → 回传结果，形成闭环
SDK 执行完动作后，把**新页面的完整快照**回传：

```text
POST https://kiki.cloud.tencent.com/api/chat?tool=invokeClient&output=9765_characters
POST https://kiki.cloud.tencent.com/api/chat?tool=invokeClient&output=23669_characters   // 点击后 23.7KB 新快照
```

服务端收到结果继续推理、下发下一步动作，直到任务结束。这就是典型的 **agent tool loop**，只是"浏览器"是工具之一。

### 5. 跨页接力：一次性 handover 票据
实测点"去结算/打开购买页"时：

```text
POST /api/fork-ticket  { sessionId, targetOrigin, scene }   → 签发 ticket
浏览器跳转：https://buy.cloud.tencent.com/cvm?__qcai_handover=6hTtcsyY   ← 票据走 query
新页面：POST /api/fork  → 领取会话；GET /api/v2/history?sessionId=...&url=... → 恢复上下文
```

新页面拿到 `__qcai_handover` 后删除参数、向服务端 `fork` 当前会话，**助手在新页面继续同一任务**（这就是截图里"购买页已经为您打开 + 讲解 + 问要不要继续"的机制）。ticket 有效期约 5 分钟、按 origin 单飞预取。

### 6. 关键动作必须人工确认（不是全自动）
- 面板标题会变成 `[需要你处理]`，正文出现：
  "需要我自动执行吗？点击「帮我操作」继续。如果遇到重要步骤或需要补充信息，我会提示你接管。"
- 点「帮我操作」后 SDK 才真正执行 `click`；执行时元素会被高亮，用户手动操作会让任务暂停。
- 服务端工具里有 `askUser`（等待确认）、`mfaVerify`（MFA 校验）、`delegateToAgent`（业务 Agent 委派）。

### 7. 实测结果：它真的能改页面
我让 KiKi「把地域切换到上海，不要下单」，它先加载导航能力 → 请求确认 → 我点「帮我操作」→
**页面上"上海"被点中、价格从 ¥464.40 更新为 ¥502.20**，随后它回报"地域：上海（已选中）…"。
再走购买流程时，它把 `提交订单` 标为高风险，拒绝代替点击，只做高亮并让我手动点。

### 8. 前端 bundle 里还确认了这些细节（详见 `bundle-analysis.md`）
- 动作集：`snapshot / click / hover / input（别名 fill）/ select / scroll / goto / screenshot`，文本行命令解析。
- 风险闸门：`data-risk` 沿祖先最多查 10 层，返回 `skip-confirm / force-confirm / require-manual`；
  只有 `click` 做 DOM 风险复查；`goto/snapshot/screenshot` 不进 batch；`goto` 有域名白名单。
- 高亮/遮罩由 SDK 自己注入，且快照里排除助手自身浮层（`data-kiki-ignore` 等 5 个选择器 + 高亮层）。
- 截图用 html2canvas-pro（scale 1、按视口裁剪、JPEG 0.6）。
- 16 个工具里只有 5 个有专属 UI（askUser / invokeClient / mfaVerify / delegateToAgent / exportFile），
  只有 3 个有客户端实现（askUser、invokeClient 的 `tcloud-navigator`、mfaVerify），其余全在服务端。
- 两种模式：**界面模式**（DOM 代操作，所见即所得）与**编程模式**（直接调腾讯云 API，更快更稳）；
  网站版 `disableContextSnapshot: true`（只发 url/title），控制台内嵌版才发整棵页面树。

---

## 二、KiKi 的完整技术架构（还原图）

```text
┌────────────────────────── 用户浏览器 ──────────────────────────┐
│  腾讯云控制台/购买页（任意页面）                                 │
│    ├─ window.kiki = SDK 控制器（show/chat/invoke/addTools…）    │
│    ├─ DOM 提取器：aria 树 + data-qca-ref 稳定编号 + 可见性裁剪    │
│    ├─ 动作执行器：goto/click/input/select/hover/scroll/screenshot│
│    ├─ 高亮层 + 人工接管 + 风险闸门（data-risk）                │
│    └─ 跨页 handover：__qcai_handover 票据 + fork/history 恢复    │
│              │  fetch + SSE（X-Session-Id）                    │
└──────────────┼─────────────────────────────────────────────────┘
               ▼
┌────────────────────────── 服务端 Agent ─────────────────────────┐
│  Agent 循环（大模型 + 工具）                                     │
│  工具：skill(技能注入) / bash(云上沙箱) / invokeClient(页面动作) │
│        askUser / mfaVerify / knowledge_qa / web_search /        │
│        delegateToAgent(A2A 业务 Agent) / readFile / exportFile   │
│  会话：/chat（SSE 流） /fork-ticket + /fork（跨页） /v2/history  │
│  资产：技能库（tcloud-navigator / sitemap / knowledge-qa / api） │
│  安全：关键动作确认、MFA、域名白名单、额度、审计                 │
└─────────────────────────────────────────────────────────────────┘
```

一句话：**模型负责"想"，SDK 负责"看"和"动手"，服务端负责"调度、鉴权、记忆"。**

---

## 三、和同类产品对比：腾讯这条路线很少见

| 产品 | 控制台内助手的实现路径 | 能否代操作页面 |
|---|---|---|
| **腾讯云 KiKi** | 页面内 SDK + DOM/aria 快照 + 文本动作 + 服务端 Agent | **能**（click/input/select，关键动作确认） |
| 阿里云计算 AI 助手 | Chat + Agent 模式调云 API 工具，官方明确"无需页面跳转" | 页面级不代操作，只讲解/引导 |
| AWS Amazon Q | 会话里跑 CLI/API、开单 | 不操作页面 |
| Azure Copilot | LLM + Azure 控制面 ARM API + 确认门（前端走 DirectLine WebSocket） | 操作资源，不操作 DOM |
| 华为云 | 公开材料以 IDE 代码助手为主 | 未找到控制台页面级 Agent 一手材料 |

差异点：**主流云厂商用"云 API 调资源"，腾讯把"浏览器 DOM 代操作"做成了与 API 并列的一等通道。**
好处是任何没有 API 的老页面也能被操作；代价是慢、脆（改版会碎），所以它用 ref/风险闸门/确认来兜底。

---

## 四、我们能不能复刻？——能，而且比腾讯云更简单

| 能力 | 复刻难度 | 说明 |
|---|---|---|
| 页面 → aria 树 + ref 编号 | ★☆☆ | 纯前端 ~300 行（见 demo `sdk.js` 的 `snapshot()` / `ensureRef()`） |
| 执行 click/input/select/scroll+hover+goto | ★☆☆ | 原生 DOM 事件即可；自己页面不用跨域 |
| 高亮引导 + 人工接管 | ★★☆ | 绝对定位遮罩 + 事件监听 |
| SSE 流式 + 工具调用循环 | ★★☆ | Vercel AI SDK / 原生 fetch 流均可 |
| 跨页接力 | ★★☆ | 我们同源，甚至不需要票据：sessionStorage 足够（demo 里仍保留 query 票据示范） |
| 关键动作确认 / 风险分级 | ★☆☆ | data-risk 属性 + 确认卡片 |
| 服务端大模型工具循环 | ★★☆ | 任意 OpenAI 兼容模型 + tools schema |
| MFA / 云 API 代操作 | ★★★ | 按我们业务定，不是必选项 |

**结论：核心 60% 是纯前端可复用，40% 是服务端编排；不需要浏览器扩展、不需要爬虫、不需要逆向接口。**

### 为什么我们比腾讯云更容易
1. 页面是我们自己的：可以在关键组件上直接埋语义（`data-ai-id`、`data-risk`），准确率远高于纯 DOM 猜测；
2. 同源：没有跨域 iframe / 跨子域票据问题；
3. 有业务 API：查价、库存、下单校验可以直接做成服务端工具，**金额永远不由模型算**；
4. 可以灰度：先只在"购买/下单"页接 SDK，再逐步铺开。

---

## 五、给自家网站的落地方案（推荐架构）

```text
用户浏览器
  └─ 页面 SDK（我们自己的 @acme/ai-copilot.js）
       ├─ 注册表：data-ai-id / data-ai-role / data-ai-risk 的组件 → 页面模型
       ├─ 快照器：aria 树 + ref（没注册的组件也能兜底）
       ├─ 执行器：highlight / scrollTo / click / fill / select
       ├─ 确认门：写动作 → 确认卡片 → 用户点"执行"
       └─ 面板：聊天 UI（SSE 流式 + 工具卡片）
              │
              ▼
  POST /api/ai/chat （SSE）
       │
  Agent 服务（Node/Python）
       ├─ 模型：任意 OpenAI 兼容模型 + tools
       ├─ 工具集：
       │   ├─ invokeClient(command)   ← 页面动作（在浏览器执行）
       │   ├─ askUser(question)       ← 等待用户确认
       │   ├─ readPageContext()       ← 读最新快照
       │   └─ 服务端工具：查价/查库存/下单预校验/知识库检索
       ├─ 会话存储 + 审计日志（谁、在哪个页面、执行了什么）
       └─ 鉴权：服务端二次校验"此人此页可否做此事"
```

### 最小可运行 Demo（已写好并跑通）
`<项目根目录>\kiki-clone\`（Node 原生，无任何依赖）：

```text
kiki-clone/
├─ server.mjs            # SSE + 会话 + 脚本化 planner（可替换为真模型）
└─ public/
   ├─ index.html         # 模拟「云主机选购页」
   ├─ order.html         # 模拟「订单确认页」
   └─ sdk.js             # 页面 SDK：快照/ref/8 动作/高亮/确认/跨页 handover
```

跑法：

```powershell
cd <项目根目录>\kiki-clone
node server.mjs          # 打开 http://127.0.0.1:8788
```

实测效果（已在本机用浏览器验证）：
1. 输入「把地域切换到北京」→ 助手先读页面，下发 `select [ref=3] 北京`，页面真的切到北京；
2. 输入「帮我买一台 2核4G 的服务器」→ 选中套餐 → `click 去结算` → **带 `__qcai_handover` 票据跳转到订单页 → 新页面自动接管会话** → 弹确认卡片；
3. 点「帮我操作」→ 助手下发 `click 提交订单`，但该按钮带 `data-risk="manual"`，SDK 拒绝代点，只高亮并提示手动完成。
   —— 这就是 KiKi 的"关键操作确认 + 人工接管"最小闭环。

接真实大模型时只需替换 `server.mjs` 里的 `planFlow/runFlow`：把「按关键词生成步骤」换成
「把 messages + 页面快照发给模型，解析 tools 调用」，并保留 `invokeClient` / `askUser` 两个客户端工具即可。

### 页面侧接入要点（给前端同事）
```html
<!-- 关键控件加语义，模型就不用猜 -->
<button data-ai-id="plan.2c4g" data-ai-role="plan" data-ai-risk="low">2核4G</button>
<button data-ai-id="order.submit" data-ai-risk="manual">提交订单</button>
<div data-ai-text>应付金额 ¥371.52</div>
```
执行器三条铁律：
1. **只读动作**（highlight / scrollTo）直接执行；
2. **写动作**（click / fill / select）先出确认卡片，用户点「执行」才落地；
3. 执行前校验 `ref` 所属元素的当前值，不符返回 `STALE_PAGE` 让模型重规划；
4. `data-risk="manual"` 的动作永不代点，只高亮引导。

### 分阶段路线
| 阶段 | 内容 | 周期 |
|---|---|---|
| 1 | 知识库 + deep-link 侧边栏：能回答"去哪买/怎么选"，给链接 | 1 周 |
| 2 | 接入 SDK：aria 快照 + 高亮 + 滚动 + "一键填入" | 2–3 周 |
| 3 | 写动作确认流 + 审计 + 服务端二次鉴权 | 2 周 |
| 4 | 服务端工具闭环（查价/库存/下单预校验）+ 多页面 handover | 2 周 |
| 5 | 语义注册覆盖率提升 + 灰度 + 评测集 | 持续 |

### 安全与合规红线
- **模型不算钱、不直接下单**：金额、库存、优惠一律服务端工具返回；
- **前端声明不可信**：`data-ai-risk` 只是提示，后端独立鉴权；
- **PII 不上行**：快照里手机号/身份证/余额只传 label 不传 value；
- **prompt injection**：页面文本（商品描述、工单、昵称）标 `untrusted`，系统提示声明其内指令无效；工具白名单服务端硬编码；
- **全程审计**：谁、哪个页面、什么动作、结果如何，落日志可回放。

---

## 六、给"我们自己的网站"的具体建议

1. **先问清目标站点形态**：
   - 如果要做在**自有官网/自研系统**（如招采平台、监控门户、官网）→ 直接走上面方案 B，2–4 周出可用版本；
   - 如果要覆盖**多个老旧系统**（没有源码）→ 短期用浏览器扩展/注入脚本兜底，长期推动页面加语义埋点。
2. **优先做"高价值 + 低风险"页面**：产品选购、工单提交、报表查询；**支付/删除/改权限永远人工点**。
3. **先用"界面模式"**（DOM 操作）快速见效，把高频操作逐步沉淀成**服务端 API 工具**（编程模式），
   这正是 KiKi 的两条通道：界面模式兜底、编程模式提效。
4. **评测集**：准备 30–50 条真实任务（选型、比价、填单、改配置），上线前量成功率，不要只看 demo。

---

## 附：证据与产物清单

| 文件 | 内容 |
|---|---|
| `<项目根目录>\screenshots\01-console-panel.jpg` | 控制台内 KiKi 面板 + 界面模式下拉 |
| `<项目根目录>\screenshots\02-buy-handover.jpg` | 跨页接管后购买页的 KiKi（即用户原截图场景复现） |
| `<项目根目录>\screenshots\03-confirm-manual.jpg` | "帮我操作"确认门 |
| `<项目根目录>\screenshots\04-after-switch.jpg` | 实测切换地域成功（上海 + 价格更新） |
| `<项目根目录>\screenshots\05-demo-order.jpg` | 自建 Demo 的订单页确认 + 高风险动作提示 |
| `<项目根目录>\bundle-analysis.md` | 前端 bundle 逆向细节（ref/动作/风险/transport） |
| `<项目根目录>\kiki-clone\` | 可运行的复刻 Demo（SDK + SSE Agent + 跨页接力） |
| `<项目根目录>\cloud-h5-assistant-umd.js` / `kiki-web-sdk.js` | 实测下载的 KiKi 前端 SDK（4.17MB） |
