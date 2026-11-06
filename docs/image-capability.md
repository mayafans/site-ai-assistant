# 追加：图片能力（原版 KiKi 实证，2026-11-04）

问题：原版 KiKi 支持“正文图片”（页面里的 `<img>`）吗？

## 结论

**不自动读 `<img>`**；它靠两条独立通道“看图”：

1. **模型主动截图**：动作 `screenshot` 返回多模态工具结果 `[{type:"text"},{type:"image-data",mediaType:"image/jpeg"}]`；
2. **重复操作时自动附截图**：循环检测触发后，工具结果里自动带上当前页面截图。

另外**用户上传图片**（登录后可用）是另一条通道。

## 证据（`kiki-web-sdk.js`，偏移量为字符位置）

### 1. 动作列表里有 screenshot

```js
// @439003
const d8 = ["snapshot","click","hover","input","select","scroll","goto","screenshot"];
```

### 2. 截图实现：html2canvas-pro 1.6.7，截当前视口，jpeg q0.6

```js
// @489422
async function xoe(e=.6){
  const n = window.scrollX||window.pageXOffset, r = window.scrollY||window.pageYOffset;
  return (await html2canvas(document.body,{useCORS:!0,allowTaint:!0,logging:!1,scale:1,
    x:n,y:r,width:window.innerWidth,height:window.innerHeight,
    windowWidth:window.innerWidth,windowHeight:window.innerHeight,backgroundColor:null}))
    .toDataURL("image/jpeg",e).split(",")[1]||null;
}
```

bundle 里同时带 `/*! html2canvas-pro 1.6.7 ... MIT License */`（@3915287）。

### 3. 截图结果升级为多模态工具结果

```js
// @466774
if (t.action === "screenshot" && this.domProvider.captureScreenshot) {
  const d = await this.domProvider.captureScreenshot();
  if (d) return [{ type: "text", text: u },
                 { type: "image-data", data: d, mediaType: "image/jpeg" }];
}
```

→ `image-data` 这个类型说明**服务端模型是多模态的，真的能看截图**。

### 4. 重复操作循环 → 自动附截图 + 提示

```js
// @466774 附近 M8()
if (n) { const i = await n(); if (i) return [{type:"text",text:r},{type:"image-data",data:i,mediaType:"image/jpeg"}] }

// @461160 L8()/R8() 生成提示文案
"上方附有当前页面截图，请结合截图判断页面实际状态。"
"本次未附带截图，请优先依据页面结构信息判断当前状态；必要时可主动执行 screenshot 再决策。"
```

循环检测 `L8(e,t=O8,n=B8)`：`O8=3`（同一动作序列重复次数阈值）、`B8=4`（最大循环长度）。

### 5. 快照本身不含图片像素

`xk()`（@约 230k）产出 `treeSnapshot` 文本树；元素信息只有 `index/tagName/text/attributes/rect/isVisible/...`；
跳过集合 `vne` 里没有 IMG，但**全 bundle `role:"image"` 出现 0 次**，也没有任何 `image-data` 进入快照路径。

→ 页面里的图片，模型最多只能拿到 alt / 周边文字，**像素不会进快照**。

### 6. 用户上传图片（登录后）

```js
// @3690438 附近：输入组件 props
function KMe(e,t){ const n=[]; e&&n.push("image/*"); t&&n.push(xz.join(",")); return n.join(",") }
const xz=[".xlsx",".xls",".csv",".md",".txt"], kz=10*1024*1024;   // 单文件 10MB 上限

// @568662 文案
"anon.imageOnlyNotAllowed": "未登录状态下暂不支持发送图片，登录后即可使用。"
"input.imageLoginRequired": "登录后即可上传图片"
"fileDrop.title": "将文件拖拽至此处即可发送给{brandName}"
```

图片压缩：canvas 缩放 + jpeg 质量二分逼近字节预算（`F0/A5/TBe`，@3480818）。

## 与我们的复刻对照

| 能力 | 原版 KiKi | 我们的实现 |
|---|---|---|
| 自动读页面 `<img>` 像素 | ❌ | ❌（同） |
| 模型主动 `screenshot` → 图片给模型 | ✅ | ✅（html2canvas-pro 内联进 sdk，服务端把图片作为用户消息附上） |
| 连续重复操作自动附截图 | ✅（阈值 3 次） | ✅（`shared/shot-policy.mjs`，阈值 3 次，单测 13 条） |
| 用户上传/粘贴图片提问 | ✅（登录后，≤10MB） | ✅（免登录，≤3 张，长边 1280 / q0.82） |
| 上传 Excel/CSV 等文件 | ✅ | ❌ 未做 |

## 复刻要点（截图通道）

- 浏览器 SDK：`captureScreenshot()` 用 html2canvas-pro 截**视口**（不是整页），jpeg 0.6，排除助手浮窗本身；
- 传输：截图 base64 不放进 tool 输出（会被服务端 4000 字符截断），单独放 `images` 字段回传；
- 服务端：`tool` 消息只能放文本，所以**图片作为紧随其后的一条 `user` 消息**附上（`image_url` part）；
- 循环兜底：服务端记录最近命令，连续 3 次相同 → 主动下发 `invokeClient{screenshot}`，拿到图片后提示模型换思路。
