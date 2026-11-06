# 生产环境部署方案

> 目标：把本仓库的「页面内助手 + 后台管理」放到真实业务站点上，满足安全、稳定、可运维。
> 当前 demo 与生产之间的差距列在最后「生产化差距清单」，按优先级处理。

## 1. 部署拓扑

```
用户浏览器
  │  https://www.example.com
  ▼
IIS / Nginx（TLS 终止、限流、日志）
  ├── /            → 业务站点（PHP/Java/静态）
  ├── /ai/         → 反向代理到 Node 助手服务 127.0.0.1:8820
  │      /ai/widget.js      页面 SDK
  │      /ai/api/*          对话 SSE / 管理 API
  └── /ai/admin    → 管理后台（建议限制内网 IP 或加登录）
```

要点：

- **同源部署**：widget 和业务页面同一个域名，避免 CORS，对话请求直接走 `/ai/api/chat`；
- Node 只监听 `127.0.0.1:8820`，不直接暴露公网；
- widget 可加 `Cache-Control: public, max-age=300`（改动时换版本号），API 一律 `no-store`。

## 2. 服务端部署

### Windows（IIS / 现有服务器）

```powershell
# 1) 安装 Node 20+，把本项目放到 D:\ai-assistant
# 2) 固定管理 token（或后续换成登录）
$env:ADMIN_TOKEN = "<强随机串>"
$env:LLM_PROVIDER = "deepseek"          # 生产建议用独立 key
$env:PORT = "8820"

# 3) 用 NSSM 注册为 Windows 服务（开机自启、崩溃重启）
nssm install aiassistant "C:\Program Files\nodejs\node.exe" "D:\ai-assistant\server.mjs"
nssm set aiassistant AppDirectory "D:\ai-assistant"
nssm set aiassistant AppEnvironmentExtra ADMIN_TOKEN=<强随机串> PORT=8820
nssm start aiassistant
```

### Linux（推荐 systemd）

```ini
# /etc/systemd/system/aiassistant.service
[Unit]
Description=AI Assistant Platform
After=network.target

[Service]
WorkingDirectory=/opt/ai-assistant
Environment=PORT=8820
Environment=ADMIN_TOKEN=<强随机串>
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3
User=aiassistant

[Install]
WantedBy=multi-user.target
```

## 3. 反向代理

### IIS（ARR + URL Rewrite）

```xml
<rewrite>
  <rules>
    <rule name="ai-widget" stopProcessing="true">
      <match url="^ai/widget\.js$" />
      <action type="Rewrite" url="http://127.0.0.1:8820/widget.js" />
      <serverVariables><set name="HTTP_X_FORWARDED_PROTO" value="https" /></serverVariables>
    </rule>
    <rule name="ai-api" stopProcessing="true">
      <match url="^ai/api/(.*)$" />
      <action type="Rewrite" url="http://127.0.0.1:8820/api/{R:1}" />
      <!-- SSE 必须关缓冲：见下方 web.config 的 flush -->
    </rule>
    <rule name="ai-admin" stopProcessing="true">
      <match url="^ai/admin$" />
      <action type="Rewrite" url="http://127.0.0.1:8820/admin" />
      <conditions>
        <!-- 只允许内网访问后台 -->
        <add input="{REMOTE_ADDR}" pattern="^10\.|^192\.168\.|^127\." />
      </conditions>
    </rule>
  </rules>
</rewrite>
```

### Nginx

后台页面会按自身路径自动推导接口前缀（`/ai/admin` → `/ai/api/*`，根路径 `/admin` → `/api/*`），所以挂在 `/ai/` 子路径下也能直接登录。

```nginx
location /ai/ {
    proxy_pass http://127.0.0.1:8820/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # SSE 关键配置
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    chunked_transfer_encoding on;
}
location = /ai/admin {
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://127.0.0.1:8820/admin;
}
```

## 4. 业务站点注入（一处即可）

PHP 公共 header/footer（ThinkPHP 模板同理）：

```php
<script src="/ai/widget.js"
        data-api-base=""
        data-api-path="/ai/api/chat"
        data-site-key="www"
        data-session-key="aiassist-www"
        data-spa="false"
        defer></script>
```

- 同源部署时 `data-api-base` 留空即可；
- 多站点/多语言可用不同 `data-site-key`，对话记录按 `data-session-key` 隔离；
- 后台「对话与外观」「技能」「业务请求」改完保存，刷新页面生效，不需要重新发布前端。

### CSP（如果站点有 Content-Security-Policy）

```nginx
add_header Content-Security-Policy "script-src 'self' 'unsafe-inline' https://www.example.com; connect-src 'self' https://www.example.com;";
```

- `script-src` 允许 `/ai/widget.js`；
- `connect-src` 允许 `/ai/api/*`；
- 若用 CDN 托管 widget，把 CDN 域名一并加入。

## 5. 必须改造的生产化项

| 项 | demo 现状 | 生产做法 |
|---|---|---|
| 管理鉴权 | ✅ 已实现：账号+密码 + HttpOnly Cookie + 角色（admin/editor/viewer） | 后续可对接企业微信/LDAP 单点登录 |
| 配置存储 | `data/sites.json` | MySQL/PostgreSQL 表 `sites`、`skills`、`tools`；变更留版本 |
| 会话存储 | 进程内 Map | Redis（`sessionId → 消息栈`），多实例共享、支持重启恢复 |
| 密钥 | 明文 JSON | 环境变量 / KMS 加密字段，接口返回一律脱敏 |
| 业务工具 | 任意 URL | **域名白名单** + 路径白名单 + 禁止内网/元数据地址（SSRF 防护） |
| 限流 | 无 | 每 IP/每会话 QPS + 每日 token 配额 |
| 审计 | 无 | 记录 用户、页面、指令、工具调用、模型输入输出摘要 |
| 内容安全 | 无 | 输入长度/注入过滤、输出敏感词、确认门（提交/支付/删除） |
| 降级 | 无 | 模型超时/失败 → 提示重试 + 脚本化兜底；总开关一键关闭助手 |

## 6. 稳定性与成本

- **SSE 全链路**：Nginx `proxy_buffering off`、IIS `flush`、网关超时 ≥ 120s；心跳间隔 < 60s；
- **超时与重试**：LLM 超时 30s、最多 1 次重试；`max_tokens` 限制 800–1200；
- **成本**：按站点配置模型；命中技能缓存常见问题（问“首页有什么”不必每次调模型）；
- **监控**：`/api/health` 探活；记录 首字延迟、P95、token 消耗、错误率；
- **灰度**：widget 加 `?ai=beta` 或按 cookie 分流；出问题在后台「停用站点」即回滚。

## 7. 上线检查清单

- [ ] Node 服务注册为系统服务，开机自启、崩溃拉起
- [ ] HTTPS 正常，`/ai/widget.js`、`/ai/api/chat` 可访问
- [ ] SSE 不被代理缓冲（浏览器逐字出）
- [ ] 后台仅内网可访问，默认管理员密码已改（admin/admin123 仅为演示）
- [ ] 站点配置（LLM/技能/业务请求/话术）导入并测试
- [ ] 业务接口白名单、确认门、限流、审计已生效
- [ ] 关闭 debug：不返回堆栈、不打印密钥
- [ ] 备份 `sites` 配置与数据库
- [ ] 压测：10 并发对话 × 60s，观察内存/CPU/错误率
- [ ] 回滚预案：移除模板 script 即可下线前端；后台停用站点即停服务

## 8. 生产化差距清单（按优先级）

1. **鉴权与配置存储**（先做，否则不能给多人用）
2. **业务工具白名单 + 审计**（安全红线）
3. **会话 Redis 化 + 多实例**（可用性）
4. **限流与成本控制**（费用可控）
5. **监控告警与灰度开关**（可运维）

