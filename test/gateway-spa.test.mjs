/**
 * 网关 SPA 路由前缀修复的回归测试
 * ---------------------------------------------------------------
 *   node test/gateway-spa.test.mjs
 *
 * 用一个本地 fixture 站（SPA 空壳 + 经典多页页面 + echo 接口）当上游，
 * 拉起真网关，检查：
 *   1. SPA 页面被注入「摘前缀」小脚本，且脚本排在站点自己的脚本前面
 *   2. 根路径深链接 /dashboards?__gw=<slug> 能落到正确站点（不靠 cookie）
 *   3. __gw 不会漏给上游站点
 *   4. Referer 里带 __gw 的根路径请求也能归位
 *   5. 经典多页站点不摘前缀（相对链接不能坏）
 *   6. cookie 兜底仍然有效；完全无线索时给帮助页
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MARK = "__ai_assistant_gateway__";

let failures = 0;
function check(name, ok, extra = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? `  ← ${extra}` : ""}`);
  }
}

const SPA_SHELL = `<!doctype html><html><head><title>spa</title><script src="/assets/app.js"></script></head><body><div id="root"></div></body></html>`;
const CLASSIC_PAGE = `<!doctype html><html><head><title>classic</title></head><body><a href="page2.html">下一页</a></body></html>`;

/** 上游 fixture：记录收到的请求，供断言 __gw 是否被摘掉 */
const seen = [];
const fixture = http.createServer((req, res) => {
  const url = String(req.url || "/");
  seen.push({ url, referer: req.headers.referer || "", cookie: req.headers.cookie || "" });
  if (url.startsWith("/api/echo")) {
    const body = Buffer.from(
      JSON.stringify({ url, referer: req.headers.referer || "", cookie: req.headers.cookie || "" }),
      "utf8",
    );
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    return res.end(body);
  }
  if (url.startsWith("/classic")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(CLASSIC_PAGE);
  }
  // 其余一律当 SPA：任何路由都回同一个空壳（前端路由接管）
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(SPA_SHELL);
});

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把注入的摘前缀脚本抠出来，在假 location/history 里跑一遍：直接验证"到底有没有摘掉前缀" */
function runShim(html, docUrl) {
  const m = html.match(new RegExp(`<script ${MARK}-spa>([\\s\\S]*?)</script>`));
  if (!m) return null;
  const start = new URL(docUrl);
  const location = { href: docUrl, origin: start.origin, pathname: start.pathname, search: start.search, hash: start.hash };
  const apply = (url) => {
    if (url == null) return;
    const n = new URL(String(url), docUrl);
    location.href = n.href;
    location.pathname = n.pathname;
    location.search = n.search;
    location.hash = n.hash;
  };
  const history = {
    state: null,
    calls: [],
    pushState(state, t, url) {
      this.calls.push(url);
      apply(url);
    },
    replaceState(state, t, url) {
      this.calls.push(url);
      apply(url);
    },
  };
  const ctx = vm.createContext({ location, history, URL, encodeURIComponent, decodeURIComponent, console });
  vm.runInContext(m[1], ctx, { timeout: 2000 });
  return { location, history };
}

function get(port, pathAndQuery, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: pathAndQuery, headers, timeout: 8000 },
      (r) => {
        const c = [];
        r.on("data", (d) => c.push(d));
        r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function waitReady(port) {
  for (let i = 0; i < 100; i++) {
    try {
      await get(port, "/");
      return true;
    } catch {
      await sleep(100);
    }
  }
  return false;
}

const main = async () => {
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const upstreamPort = fixture.address().port;
  const slug = `127.0.0.1:${upstreamPort}`;

  const gwPort = await freePort();
  const cfgPath = path.join(os.tmpdir(), `gw-spa-test-${Date.now()}.json`);
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ port: gwPort, bind: "127.0.0.1", assistant: { base: "http://127.0.0.1:1", widgetPath: "/widget.js" }, defaults: {}, dynamic: { wildcardExt: true } }),
    "utf8",
  );

  const gw = spawn(process.execPath, [path.join(ROOT, "deploy", "gateway.mjs"), "--config", cfgPath], {
    cwd: ROOT,
    env: { ...process.env, GW_ASSISTANT_BASE: "http://127.0.0.1:1", GW_LOG: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gw.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s) console.log(`  [gw] ${s}`);
  });

  try {
    if (!(await waitReady(gwPort))) throw new Error("网关没起来");
    const q = encodeURIComponent(slug);

    console.log("SPA 页面：注入摘前缀脚本");
    const spa = await get(gwPort, `/${slug}/`, { accept: "text/html" });
    check("注入助手脚本", spa.body.includes(MARK));
    check("注入摘前缀脚本", spa.body.includes(`${MARK}-spa`));
    const shimAt = spa.body.indexOf(`${MARK}-spa`);
    const appAt = spa.body.indexOf(`/${slug}/assets/app.js`);
    check("脚本排在站点自己的脚本之前", shimAt >= 0 && appAt > shimAt, `shim=${shimAt} app=${appAt}`);
    check("带上站点标识参数", spa.body.includes("__gw"));

    console.log("摘前缀脚本本身的行为（在假 location/history 里真跑一遍）");
    const sim = runShim(spa.body, `http://127.0.0.1:${gwPort}/${slug}/dashboards`);
    check("能抠出脚本并执行", !!sim);
    check("文档地址被摘掉前缀", sim && sim.location.pathname === "/dashboards", sim && sim.location.pathname);
    check(
      "摘完仍带着站点标识",
      sim && sim.location.search.includes(`__gw=${encodeURIComponent(slug)}`),
      sim && sim.location.search,
    );
    if (sim) sim.history.pushState(null, "", `/${slug}/metrics`);
    check("路由 pushState 也摘前缀", sim && sim.location.pathname === "/metrics", sim && sim.location.pathname);
    if (sim) sim.history.pushState(null, "", "/event-pipelines");
    check(
      "干净路径的 pushState 会补上 __gw",
      sim && sim.location.pathname === "/event-pipelines" && sim.location.search.includes("__gw="),
      sim && sim.location.pathname + sim.location.search,
    );
    if (sim) sim.history.pushState(null, "", "page2.html");
    check("带扩展名的地址不动", sim && sim.location.pathname.endsWith("page2.html"), sim && sim.location.pathname);

    console.log("根路径深链接：URL 带 __gw（不靠 cookie）");
    const deep = await get(gwPort, `/dashboards?__gw=${q}`, { accept: "text/html" });
    check("深链接返回 SPA 页面而不是帮助页", deep.status === 200 && deep.body.includes('id="root"'), `status=${deep.status}`);
    check("深链接也注入了助手", deep.body.includes(MARK));

    console.log("__gw 不能漏给上游");
    seen.length = 0;
    const echo = await get(gwPort, `/api/echo?__gw=${q}&x=1`, { accept: "application/json" });
    check("接口能归位到站点", echo.status === 200 && echo.body.includes('"/api/echo'), `body=${echo.body.slice(0, 80)}`);
    check("上游收到的路径没有 __gw", seen.length > 0 && !seen[0].url.includes("__gw"), `url=${seen[0] && seen[0].url}`);

    console.log("Referer 带 __gw 的根路径请求");
    seen.length = 0;
    const viaRef = await get(gwPort, `/api/echo`, {
      accept: "application/json",
      referer: `http://127.0.0.1:${gwPort}/dashboards?__gw=${q}`,
    });
    check("按 Referer 归位", viaRef.status === 200 && viaRef.body.includes('"/api/echo'));
    check("上游 Referer 已摘掉 __gw", seen.length > 0 && !seen[0].referer.includes("__gw"), `ref=${seen[0] && seen[0].referer}`);

    console.log("经典多页站点：不能摘前缀");
    const classic = await get(gwPort, `/${slug}/classic`, { accept: "text/html" });
    check("经典页面仍注入助手", classic.body.includes(MARK));
    check("经典页面不注入摘前缀脚本", !classic.body.includes(`${MARK}-spa`));

    console.log("cookie 兜底 & 无线索时的帮助页");
    const viaCookie = await get(gwPort, `/api/echo`, { accept: "application/json", cookie: `gw_site=${q}` });
    check("cookie 兜底仍然有效", viaCookie.status === 200 && viaCookie.body.includes('"/api/echo'));
    const orphan = await get(gwPort, `/dashboards`, { accept: "text/html" });
    check("完全无线索时返回帮助页", orphan.status === 404 && orphan.body.includes("直接访问就行"), `status=${orphan.status}`);
  } finally {
    gw.kill();
    fixture.close();
    try {
      fs.unlinkSync(cfgPath);
    } catch {}
  }

  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
};

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});