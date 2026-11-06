# 反代注入网关

`deploy/gateway.mjs` 给任意网站套一层透明反向代理，并在返回的 HTML 里注入站内 AI 助手。
目标站点**不用改一行代码**，也不需要源码。

**动态模式**：URL 第一段就是目标域名，不用提前配置。

```
http://<网关>:3000/www.example.com/      →  https://www.example.com
http://<网关>:3000/m.example.com/        →  https://m.example.com
http://<网关>:3000/127.0.0.1:3001/      →  http://127.0.0.1:3001
http://<网关>:3000/10.0.0.10:17000/     →  http://10.0.0.10:17000
```

内外网一视同仁，没有白名单、没有例外。

## 三步跑起来

```bash
cd site-ai-assistant
cp deploy/gateway.config.json deploy/gateway.config.local.json   # 只需改助手地址
node deploy/gateway.mjs --config deploy/gateway.config.local.json
```

浏览器打开 `http://127.0.0.1:3000/www.example.com/`，站点原样显示，右下角出现助手。

> 一个进程就够，所有站点共享 3000 端口，路径区分。

## 配置

```json
{
  "assistant": { "base": "http://10.0.0.10:8820" },   // 唯一的必填项
  "port": 3000,
  "bind": "0.0.0.0",
  "defaults": { "title": "站点助手", "siteKey": "default", "sessionKey": "aiassist" }
}
```

| 字段 | 说明 |
| --- | --- |
| `assistant.base` | 助手服务地址，注入的 script 从这里加载 |
| `port` / `bind` | 监听端口与地址 |
| `defaults.title/siteKey/sessionKey/spa` | 注入进 script 的参数（标题、对应后台哪个站点、SPA 模式） |
| `dynamic.wildcardExt` | 默认 `true`，页面里的外部资源（CDN）自动走 `_ext` 通道 |

改完配置**约 1 秒自动生效**，不用重启。

## 协议怎么定

一条规则，不需要配：

- 目标带端口且不是 443/8443 → 先按 `http` 访问
- 其它情况 → 先按 `https` 访问，失败自动回落 `http`
- 选定结果会缓存，后续请求不再试探

所以 `127.0.0.1:3001`（Kuma）、`10.0.0.10:17000`（夜莺）这类内网服务直接写就行。

## 它替你做了什么

| 改写对象 | 例子 |
| --- | --- |
| HTML 属性 | `href="/a.css"` → `href="/www.example.com/a.css"` |
| `srcset` | 逐项加前缀 |
| 内联 `<style>` / 独立 CSS 的 `url()` | `url(/img/a.png)` → `url(/www.example.com/img/a.png)` |
| 指向源站的绝对地址 | `https://www.example.com/x` → `/www.example.com/x` |
| 其它域名的资源（CDN） | `https://cdn.example.com/x` → `/www.example.com/_ext/cdn.example.com/x` |
| `<base>` | 站点自带 base 就加前缀；没有就不注入（注入反而会把相对链接带偏） |
| `Location` 响应头 | 302 到源站或 CDN 都收回到网关 |
| `set-cookie` | 去掉 `Domain`，`Path` 统一放宽成 `/`，名字加 `gw_site_<站点哈希>_` 前缀（多站点不串会话，根路径请求也能带上） |

外加：gzip/br/deflate 先解压再注入、剥掉 CSP/HSTS/content-length、改写 `Origin`/`Referer`、WebSocket 透传。

## iframe 页面

OA、部分后台系统会用 iframe 打开表单。网关**只给顶层文档注入助手**（按 `Sec-Fetch-Dest` 判断），
iframe 里的 HTML 照样做前缀改写，但不再插入脚本——否则父子文档各起一个面板，会出现"两个助手"。
前端 SDK 里也有一层同样的保护（`window.top !== window.self` 直接退出）。

## 会话 cookie 怎么处理

目标站点通常把 `JSESSIONID` 这类会话 cookie 挂在 `Path=/seeyon` 这样的子路径上，但经前缀代理后：
带前缀的请求是 `/oa.example.com/seeyon/...`，站点自己拼出的根路径请求是 `/seeyon/...`，两条路都要能带上会话。

所以网关把 `set-cookie` 统一改成：

- 去掉 `Domain`
- `Path` 放宽为 `/`
- 名字加 `gw_site_<站点哈希>_` 前缀，例如 `gw_site_f361f96f_SESS`

发往上游前再把本站点的 cookie 名字还原、丢掉其它站点的 cookie，既保证会话可用，又不会多站点串登录态。

## SPA：根路径接口和 WebSocket

单页应用会把接口和实时连接写成根路径（`/socket.io/`、`/api/...`），这些字符串在打包文件里，网关改不了。
处理方式：网关给每个返回的 HTML 页面下发一个 `gw_site=<slug>` cookie，之后凡是**根路径**上的请求（首段不是域名，或首段是 `socket.io` / `sockjs` / `.well-known`），
自动归还给这个站点，并把完整路径透传过去。WebSocket 升级请求同样带 cookie，所以 `socket.io` 也能连上。

实测：Uptime Kuma 经 `/10.0.0.10:3001/` 访问，登录页正常、socket 连接正常。

注意：cookie 只有一个，**同一浏览器同时开两个不同站点的标签**时，根路径请求会归到最后打开的那个站点。
遇到这种互相干扰，关掉不用的标签页即可。

## CDN 防盗链

很多站点的静态资源走 CDN 且校验 `Referer`，浏览器经代理访问时 Referer 变成网关地址，CDN 会 403。

`dynamic.wildcardExt`（默认开）会把页面里**资源类**引用（`src`/`srcset`/`poster`/`<link href>`/CSS `url()`）的其它域名自动收进 `_ext` 通道，
网关再用正确的 `Referer: <目标源站>` 去取。**不需要为每个站点写 CDN 域名**；`<a href>` 和 `<form action>` 不会被改写，站外链接照常。

## 自带探针

```
GET /_gw/status                 → 网关状态（端口、助手地址、用法）
GET /<域名>/_gw/status          → 该站点的路由信息
node deploy/gateway.mjs --probe www.example.com    → 单站点体检（像浏览器一样请求一次，看有没有注入）
```

## 常见问题

**页面出来了但没样式**

先看浏览器 Network 里 403 的请求。如果是不在 `_ext` 通道里的外部域名，说明它不在资源类引用里（比如 JS 里动态加载）—— 这种情况路径模式天生搞不定，需要看是哪个脚本。

**白屏 / 接口 404**

站点 JS 里写死了根路径（`fetch("/api/x")`）。代理无法可靠改写运行时的字符串拼接，这类站点只能在源站前面做真正的反向代理（不改路径）。

**登录不进去**

看 cookie 的 `Domain`/`Secure`/`Path`。网关已剥 Domain、补 Path；如果是 `SameSite=None; Secure`，需要把网关放到 https 后面。

**内网系统打不开**

先确认 `${网关}/10.x.x.x:端口/` 的目标地址和端口没写错；再从网关所在机器 `curl` 一下那个地址，排除是目标本身不通。

## 安全提示

- 网关不分内外网，**能访问 3000 的人就能访问你内网所有 HTTP 服务**。务必用防火墙把来源限制在内网网段，不要直接对公网开放。
- 任何能访问网关端口的人都能访问被代理的站点，请配防火墙限制来源网段。
- 助手服务本身要开限流（`CHAT_RATE_PER_MIN`），否则等于给内网开了个免费 LLM 入口。
