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

## SPA：路由前缀、根路径接口和 WebSocket

单页应用有两类东西网关改不了：打包文件里写死的根路径接口（`fetch("/api/x")`、`/socket.io/`），
以及前端路由自己 `pushState` 出来的地址。而路径前缀代理会把这两样都顶歪：

- 前端路由读到的是 `/10.10.5.2:17000/dashboards`，路由表里只有 `/dashboards`，直接白屏或「页面不存在」（夜莺就是）
- 根路径请求 `/api/n9e/...` 首段不是域名，网关不知道该发给谁

处理方式（只对 SPA 空壳生效，识别标志：`<div id="root">`、`__NEXT_DATA__`、`ng-version` 等）：

1. 网关在 `<head>` 最前面注入一小段脚本，**赶在站点自己的脚本之前**执行：
   把地址栏里的路径前缀摘掉（`/10.10.5.2:17000/dashboards` → `/dashboards`），
   同时把站点标识挂成 `?__gw=<slug>`。前端路由拿到的就是干净路径，页面正常渲染。
2. 之后路由自己 `pushState`/`replaceState` 的地址也会自动带上 `?__gw=`，所以
   **刷新、深链接、分享出去的地址**都能反推出属于哪个站点，不靠 cookie 猜。
3. 凡是落在根路径上的请求（首段不是域名，或首段是 `socket.io` / `sockjs` / `.well-known`），
   网关按这个顺序认领：URL 的 `__gw` → `Referer` 的 `__gw` → `Referer` 里的站点前缀 → `gw_site` cookie。
   一个浏览器同时开几个站点也不会串（Referer 是本标签页的，cookie 才是全局的）。
4. `__gw` 只给网关自己看，转发上游前会摘掉，站点看不到这个参数。

经典多页站点（OA、老管理系统）**不会**被执行第 1 步：它们靠文档 URL 解析相对路径，摘前缀会弄坏相对链接，
这类站点继续用「根路径按 cookie/Referer 归还」的方式。

WebSocket 升级请求浏览器不带 Referer，只能落到 cookie 这一层；所以浏览器里最后打开的那个站点优先。

实测：Uptime Kuma 经 `/10.0.0.10:3001/` 访问，登录页正常、socket 连接正常；
夜莺 `/10.10.5.2:17000/dashboards` 深链接直接打开、仪表盘列表正常渲染。

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

先看首段路径是不是被当成域名了。SPA 白屏（「页面不存在」）是前端路由读到了带前缀的 `location.pathname`——
现在网关会自动摘前缀，如果还白屏，说明这个页面没被识别成 SPA（没有 `<div id="root">` 之类的标志），
把它的空壳 HTML 发给网关维护者加识别规则即可。

接口 404 则是运行时字符串拼接的根路径：`Referer` 和 `gw_site` cookie 都认不出来时才会掉到帮助页，
在 Network 里看那条请求带的 `Referer` 就能定位。

**登录不进去**

看 cookie 的 `Domain`/`Secure`/`Path`。网关已剥 Domain、补 Path；如果是 `SameSite=None; Secure`，需要把网关放到 https 后面。

**内网系统打不开**

先确认 `${网关}/10.x.x.x:端口/` 的目标地址和端口没写错；再从网关所在机器 `curl` 一下那个地址，排除是目标本身不通。

## 安全提示

- 网关不分内外网，**能访问 3000 的人就能访问你内网所有 HTTP 服务**。务必用防火墙把来源限制在内网网段，不要直接对公网开放。
- 任何能访问网关端口的人都能访问被代理的站点，请配防火墙限制来源网段。
- 助手服务本身要开限流（`CHAT_RATE_PER_MIN`），否则等于给内网开了个免费 LLM 入口。
