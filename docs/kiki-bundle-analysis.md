# 腾讯云智能助手 KiKi（cloud-h5-assistant-umd.js）逆向分析报告

分析对象：`<项目根目录>\cloud-h5-assistant-umd.js`（4,172,462 字节，1049 行，压缩未加密，UMD，内含 React + html2canvas-pro 1.6.7 + 中/英/日/韩/印尼/葡 i18n）。

结论先行：这个 bundle **同时就是对外接入用的 `web-sdk.js`**。文件末尾在 `window` 上自举 `window.kiki`，见文末证据（`web-sdk.js 重复加载` 告警 + `apiPrefix:"/profile/cloud-h5/api"`）。它实现了一套「截图/无障碍树 → LLM 出文本指令 → 前端执行」的浏览器代理闭环，ref 寻址、风险分级、人工接管、跨页票据接力全在前端。

---

## 一、页面上下文采集（DOM 提取）

### 1.1 入口 `xk(...)`

```js
function xk(e={}){const{doHighlightElements:t=!1,focusHighlightIndex:n=-1,overlaySelectors:r=[]}=e,i=$ne(r);
t&&mv(),bv.clear(),Nte(),zte();const s={url:window.location.href,title:document.title,timestamp:Date.now()},
o=zne(document.body,i);s.hasCaptcha=pre();const a=[],l=c=>{...};
for(const[c,A]of o.elements){const d=A.getBoundingClientRect();if(d.width===0&&d.height===0){l(c);continue}
...const E={index:g,tagName:A.tagName.toLowerCase(),text:Vk(ore(A)),attributes:Are(A),
rect:{top:d.top,left:d.left,width:d.width,height:d.height},isVisible:!0,isDisabled:ure(A),
isNotAllowed:cre(A),xpath:fre(A),inDialog:!1},k=o.nodeByRef.get(c);k&&(k.ref=String(g),v&&(k.occluded=!0),...)};
const u=_ne(o);return{elements:a,pageInfo:s,treeSnapshot:u}}
```

- `pageInfo` 固定三字段 + 时间戳：`{url, title, timestamp, hasCaptcha}`。
- `hasCaptcha = pre()`，靠 class 通配探测：`dre='[class*="captcha" i], [class*="Captcha" i], [class*="CAPTCHA" i]'`，且排除不可见元素。

### 1.2 ref 编号：**纯数字**，靠 DOM 属性持久化

```js
const zf="data-qca-ref",bv=new Map;
function gne(e){const t=e.getAttribute(zf);if(t){const r=parseInt(t,10);if(!isNaN(r))return r>Uv&&(Uv=r),r}
const n=++Uv;return e.setAttribute(zf,String(n)),n}
```

即 ref 是自增整数，写回 `data-qca-ref` 属性，所以同一元素跨多次 snapshot **ref 稳定**（不随 DOM 顺序漂移）。`bv` 是 `ref → Element` 的全局 Map，`wv(ref)` 取元素，动作执行时 `t3(ref)` 用它反查。

注意压缩码里存在**两套**编号：无障碍树内部先用 `"e"+ ++Eu`（`Yne` 里 `const A="e"+ ++Eu`），随后被 `xk` 统一改写成数字 `k.ref=String(g)`；`_ne` 序列化时只认数字：

```js
c.ref&&/^\d+$/.test(c.ref)&&(d+=` [ref=${c.ref}]`)
```

所以最终下发给模型的是 `[ref=12]` 这种形式，不是 `e12`。

### 1.3 采集范围：树覆盖全部可见节点，ref 只给可交互节点

`zne(body, overlay)` 递归构建无障碍树，跳过：

```js
const mne=new Set(["SCRIPT","STYLE","NOSCRIPT","LINK","META","HEAD","PATH","CIRCLE","RECT","LINE","POLYGON","POLYLINE","ELLIPSE"])
```

可见性判定 `Fk`：`display:none/visibility:hidden/opacity:0` 或 `offsetWidth===0&&offsetHeight===0` 即不可见；`Cne` 额外丢弃完全滚出视口的 `absolute/fixed` 元素（记为 occluded）。真正决定"给 ref"的是 `Ik`：

```js
function Ik(e){const t=Sh(e);if(!t)return!1;
if(new Set(["button","link","checkbox","radio","textbox","searchbox","combobox","slider","spinbutton",
"switch","tab","menuitem","menuitemcheckbox","menuitemradio","option","treeitem","gridcell","listbox"]).has(t)
||t==="listitem"&&wne(e)||Bk(e)||Ok(e))return!0;
const r=e.getAttribute("tabindex");return r!==null&&r!=="-1"||e.getAttribute("contenteditable")==="true"}
```

即 **ARIA role 白名单 + `tabindex!=-1` + `contenteditable`**。另有 `Yre` 选择器表供命令校验/候选收集复用（`button,a,div,input,select,textarea,details>summary,[contenteditable],[role=...],[aria-checked],[class*=checkbox],[class*=row-select],[tabindex]...`）。

### 1.4 treeSnapshot：类 browser-use 的缩进文本树

`_ne` 序列化，格式为 `- role "name" [属性]:` 的 YAML 风缩进文本，上限 **15000 行**，name 上限 900 字符：

```js
let d=c.role; c.name&&c.name.length<=900&&(d+=" "+JSON.stringify(c.name));
c.disabled&&(d+=" [disabled]"); ... c.occluded&&!A.parentOccluded&&(d+=" [occluded]");
c.scrollable&&!A.parentScrollable&&(d+=" [scrollable]"); c.cursorPointer&&(d+=" [cursor=pointer]");
c.risk&&(d+=` [risk=${c.risk}]`); c.ref&&/^\d+$/.test(c.ref)&&(d+=` [ref=${c.ref}]`);
...
l=(c,A,d)=>{if(t.length>=15e3)return; const g=A+"- "+ire(o(c,d)) ...
else{t.push(g+":"); for(const[k,F]of Object.entries(c.props))k.startsWith("__")||t.push(A+"  - /"+k+": "+Tv(F));
const E=A+"  "; for(const k of c.children){typeof k=="string"?r(k,E):l(k,E,C)}}}
```

状态标记齐全：`[checked]/[checked=mixed]/[unchecked]/[disabled]/[expanded]/[collapsed]/[level=n]/[pressed]/[selected]/[selectable]/[hasPopup]/[error]/[required]/[readonly]/[risk=...]`。这就允许后端模型只凭这段文本定位元素——**不需要传 HTML、也不需要传 DOM 节点数组**。

### 1.5 overlaySelectors：排除助手自身浮层

默认 5 条（在 `HQe` 里构造）：

```js
const k=[`[${Fu}]`,"[data-cloud-assistant-ui]",'[data-kiki-ignore="true"]',"[data-snapshot-recorder]","#qcportal-kit-feedback-content"];
mre({overlaySelectors:k});
```

`Fu="data-qcloud-lite-root"`（lite 任务容器）；`Cu="qcloud-assistant-highlight-container"`（自己的高亮层，`$ne` 里硬编码判等）：

```js
function $ne(e){const t=Cu;return{isOverlayRoot(n){if(n.id===t)return!0;for(const r of e)try{if(n.matches(r))return!0}catch{}return!1},
isInsideOverlay(n){if(n.id===t)return!0;try{if(n.closest(`#${t}`))return!0}catch{}...}}}
```

否则助手面板/高亮框会被当成"可点元素"，形成自指循环。

### 1.6 截图：html2canvas-pro

```js
async function woe(e=.6){try{const{default:t}=await Promise.resolve().then(()=>$qe),
const n=window.scrollX||window.pageXOffset,r=window.scrollY||window.pageYOffset;
return(await t(document.body,{useCORS:!0,allowTaint:!0,logging:!1,scale:1,x:n,y:r,
width:window.innerWidth,height:window.innerHeight,windowWidth:window.innerWidth,
windowHeight:window.innerHeight,backgroundColor:null})).toDataURL("image/jpeg",e).split(",")[1]||null}catch{return null}}
```

要点：`scale:1` 不放大、`x/y` 取滚动偏移 + `width/height` 取视口 → **裁剪为当前可视区**、`backgroundColor:null` 保留透明、JPEG 质量 0.6、只取 base64 部分（去掉 `data:image/jpeg;base64,`）。截图只在 `screenshot` 动作时作为 `{type:"image-data",data:d,mediaType:"image/jpeg"}` 回填，**不随每次请求上传**。

### 1.7 上下文如何送达后端

`extractDOM` 返回值被裁剪，只取 `treeSnapshot`：

```js
async extractDOM(){await Sne();const{elements:t,pageInfo:n,treeSnapshot:r}=
xk({doHighlightElements:!1,overlaySelectors:this.overlaySelectors});
return{url:n.url,title:n.title,hasCaptcha:n.hasCaptcha,treeSnapshot:r,elementCount:t.length}}
```

调用点（`HQe` 内）只把字符串喂给会话：

```js
const P=async()=>(await F.extractDOM()).treeSnapshot;
...
const T={submit:(re,se)=>{const fe=t.disableContextSnapshot||Kv(Rv)?void 0:P;
return D.submit(re,{...se,context:QQe(fe,se==null?void 0:se.context)})}, ...}
```

最终不是顶层 `context` 字段，而是**塞进 user message 的 parts**：

```js
const F=n==null?void 0:n.context,
U=F!=null?async()=>{try{const Z=typeof F=="string"?F:await Ree(F(),5e3),W=k.parts.find(J=>J.type==="data-page-context");
W?W.data.context=Z:k.parts.push({type:"data-page-context",data:{...g,context:Z}})}catch{}}:void 0
```

即 `{type:"data-page-context", data:{url,...,context:"<treeSnapshot 文本>"}}`，取值有 5s 超时（`Ree(F(),5e3)`）。`elementCount` 未参与传输。

---

## 二、动作指令协议

### 2.1 action 完整枚举（8 个 + 2 别名）

```js
const d8=["snapshot","click","hover","input","select","scroll","goto","screenshot"],
Dre={fill:"input",type:"input"};
function p8(e){const t=e.trim().toLowerCase();return d8.includes(t)?t:Dre[t]??null}
```

没有 `key/press/wait` 独立动作：`wait` 是命令级选项 `waitMs`，回车是 `input` 的 `enterAfterInput`。未知动作报错会回显白名单：

```js
if(!r)return`未知 action：${t[0]}，支持的 action 有：${d8.join(", ")}`
```

命令是**文本行**而非 JSON，由 `qre/E8` 解析（`click 12`、`input 12 "text"`、`goto https://...`、`scroll 12 down 500`），失败统一提示"请参考 navigator 技能返回正确格式"。

### 2.2 每个动作的字段

公共选项解析 `jre`：

```js
function jre(e,t){const n=Gs(t.explanation);n&&(e.explanation=n);const r=Gs(t.planId);r&&(e.planId=r);
const i=Gs(t.resolvedGoal);i&&(e.resolvedGoal=i);const s=mu(t.haltOnError);...
const o=C8(t.timeoutMs);...const a=S8(t.wait);a!==void 0&&(e.waitMs=a);
const l=m8(t.retry,5);...const u=mu(t.confirm);u!==void 0&&(e.confirmRequired=u,u&&(e.confirmSource="model"))}
```

分支赋值：

```js
function Jre(e,t,n){const r={action:e};switch(jre(r,n),e){
case"click":case"hover":{const i=Uu(n.ref??ku(t[0]));return i?(r.ref=i,r):null}
case"input":case"select":{const i=Uu(n.ref??ku(t[0])),s=g8(t[0])?h8(t[1]):t[1],
  o=e==="select"?Gs(n.selectValue??s):Hx(n.inputValue??s);...
  if(e==="select"?r.selectValue=o:r.inputValue=o,e==="input"){const a=mu(n.enter);a!==void 0&&(r.enterAfterInput=a)}return r}
case"scroll":{const i=Uu(n.ref??ku(t[0]));i!==void 0&&(r.ref=i);
  const s=v8(n.direction??n.scrollDirection);s&&(r.scrollDirection=s);
  const o=y8(n.distance??n.scrollDistance??t[1]);return o!==void 0&&(r.scrollDistance=o),r}
case"goto":{const i=Gs(n.path_or_url??t[0]);return i?(r.navigateUrl=i,r):null}
case"snapshot":case"screenshot":return r;default:return null}}
```

字段全集：`action, ref, inputValue, selectValue, enterAfterInput, scrollDirection(up|down), scrollDistance(1..10000), navigateUrl, explanation, planId, resolvedGoal, haltOnError, timeoutMs(100..120000, 默认30000), waitMs(0..120000), retry(0..5), confirmRequired, confirmSource`。

下发到 DOM 层的归一化结构：

```js
function Eoe(e){return{action:e.action,explanation:e.explanation??e.action,elementIndex:e.ref,
inputValue:e.inputValue??e.selectValue,scrollDirection:e.scrollDirection,scrollDistance:e.scrollDistance,
navigateUrl:e.navigateUrl,timeoutMs:e.timeoutMs,waitMs:e.waitMs,retry:e.retry,
confirmRequired:e.confirmRequired,enterAfterInput:e.enterAfterInput}}
```

### 2.3 风险控制三段式

**(a) `Xv`：只有 click 走 DOM 风险复查**

```js
const Gv=new Set(["snapshot","screenshot"]),Xv=new Set(["click"]),bie=new Set(["goto","snapshot","screenshot"]);
```

- `Gv` = 免等待动作（不执行 `waitForPageReady(500ms)`）。
- `bie` = 不允许出现在 batch 里的动作。

**(b) `Zv(ref)`：沿祖先链读 `data-risk`，最多 10 层**

```js
const qv="data-risk",Zre=10;
function Zv(e){const t=wv(e);if(!t)return{action:"none"};let n=t;
for(let i=0;n&&i<Zre;i++){const s=n.getAttribute(qv)?.toLowerCase();if(s)switch(s){
case"low":return{action:"skip-confirm"};
case"high":return{action:"force-confirm",reason:`目标元素或祖先标记 ${qv}="high"`};
case"manual":return{action:"require-manual",reason:`目标元素或祖先标记 ${qv}="manual"`}}n=n.parentElement}
return{action:"none"}}
```

同一属性也进无障碍树（`sre="data-risk"`，`lre` 上溯 10 层 → `[risk=...]`），所以模型能提前看到风险标记。

**(c) 确认裁决顺序**

```js
t.inputValue).isHighRisk&&(t.confirmRequired=!0);
const s=t.ref!=null&&Xv.has(t.action)?Zv(t.ref):{action:"none"};
switch(s.action){case"skip-confirm":t.confirmRequired=!1;break;
case"force-confirm":t.confirmRequired=!0,t.confirmSource="dom-risk",t.riskLevel="high",t.confirmReason=s.reason;break;
case"require-manual":return await this.runManualAction(t,r,n.signal)}
t.confirmRequired&&!this.skipConfirm&&(r.set({phase:"confirming",command:t,...Bu(t)}),await r.waitForAction("confirm",n.signal))
```

`skip-confirm` 能覆盖模型的 `--confirm`；`force-confirm` 能强制加确认；`require-manual` 直接跳到人工模式，**模型无法绕过**。

另有 shell 高危内容黑名单（对 `input` 的 `inputValue`）：

```js
const zre=[{pattern:/\brm\s+.*-[a-zA-Z]*r/i,reason:"递归删除文件（rm -r/-rf），可能导致数据丢失"},
{pattern:/\bmkfs\b/i,reason:"格式化文件系统（mkfs），将清除分区所有数据"},
{pattern:/\bdd\s+.*\bof=/i,reason:"磁盘级数据覆写（dd），可能破坏磁盘数据"},
{pattern:/\bDROP\s+(?:TABLE|DATABASE)\b/i,...},{pattern:/\bTRUNCATE\s+(?:TABLE\s+)?\S/i,...}]
```

**(d) 人工接管 `runManualAction`**

```js
runManualAction(t,n,r){t.ref&&this.domProvider.highlightElement&&this.domProvider.highlightElement(t.ref),
this.disableUserInteractionMonitor(),this.onSessionEvent?.({type:"interactiveWaitChange",waiting:!0,askType:"wait_for_action"});
try{n.set({phase:"manual-action",command:t,...Bu(t)}),await n.waitForAction("manualComplete",r)}
finally{this.onSessionEvent?.({type:"interactiveWaitChange",waiting:!1}),this.enableUserInteractionMonitor(),
this.domProvider.clearHighlights?.()}
const i={success:!0,message:"用户已手动完成操作"},s=await this.collectStableObservation(t,i,r);return n.set(null),s}
```

高亮通过 `highlightSelector: '[data-qca-ref="12"]'` 下发（`Bu(e)`），UI 文案 `strip.manualAction:"请手动点击高亮的元素"`。

### 2.4 batch 约束

```js
validateBatchCommands(t){if(t.length>150)return`batch 命令数量超过上限（最多 150 条，实际 ${t.length} 条）`;
for(let n=0;n<t.length;n++){const r=t[n];if(bie.has(r.action))return`第 ${n+1} 条命令 ${r.action} 不允许在 batch 中使用`;if(r.confirmRequired)return`第 ${n+1} 条命令包含 --confirm，不允许在 batch 中使用`;
if(r.action==="input"&&r.ref&&vv(r.ref))return`...目标是终端（ref=...），终端输入不支持 batch`;
if(r.action==="input"&&r.inputValue&&!Zf(r.inputValue)&&x8(r.inputValue).isHighRisk)return`...包含高危输入内容，不允许 batch`;
if(r.ref!=null&&Xv.has(r.action)){const i=Zv(r.ref);if(i.action==="force-confirm"||i.action==="require-manual")return`...命中 DOM 风险策略（${i.reason}），不允许 batch`}}return null}
```

执行期还会**再查一次** `Zv`（"运行期风险复查：...，batch 中止"），防 DOM 在批次中途变化。首次批量执行前要过一次 `phase:"awaiting-navigation-mode"` 的开关确认。

### 2.5 跨页交接（handover / ticket）

三件事：① 找到"要换页"的信号；② 从后端要一张 ticket；③ 用 query/cookie 载体把它带到新页面。

```js
async performAction(t){ ...
 const s=n.handoverOrchestrator?await n.handoverOrchestrator.prepareNavigation({targetUrl:e.navigateUrl}):{url:e.navigateUrl,ticketInjected:!1};
```

```js
async prepareNavigation(t){const n=t.targetUrl;if(!this.broker)return{url:n,ticketInjected:!1};
const r=await this.broker.acquire({source:"goto",targetUrl:n});if(!r)return{url:n,ticketInjected:!1};
un("orchestrator","direct navigation injection",{ticket:dr(r),targetUrl:n});
const i=Kh(n,r,uU(),this.carriers);try{i.lifecycle?.beforeClickApply?.()}catch{}
return{url:i.url,ticketInjected:!0,ticket:r,disarm:i.lifecycle?.afterClickRollbackBestEffort}}
```

ticket 来源只能是后端（`$oe` broker 的 `requestForkTicket`，在 `HQe` 里注入）：

```js
const A=Goe({enabled:t.prefetchEnabled!==!1}),
d=async re=>{const se=T.getSnapshot().sessionId;if(!se)return null;
try{const fe=new URL(re,window.location.href).origin,{ticket:Se}=await c.createForkTicket(se,fe,"handover_prefetch");return Se}catch{return null}},
g=new $oe(A,d),{orchestrator:v,interceptor:C}=ese({cookiePolicy:n,broker:g});
```

```js
async createForkTicket(t,n,r){const i={sessionId:t,targetOrigin:n};r&&(i.scene=r);
const s=await this.fetcher(`${this.baseUrl}${this.apiPrefix}/fork-ticket`,{method:"POST",credentials:"include",headers:this.buildJsonHeaders(),body:JSON.stringify(i)});...
```

预取 + 缓存策略：`ticketTtlMs` 默认 300000（5 分钟），`refreshAheadMs` 30000，`retryIntervalMs` 30000；broker 按 origin singleflight，命中缓存即用，未命中才现取。

载体 1 —— **query**（`lU`）：

```js
const lU={name:"query",canHandle(){return!0},inject(e,t){const n=Z8(e,t);
return un("query-carrier","append query params",{targetUrl:e,resultUrl:n,ticket:dr(t),modified:n!==e}),{url:n,urlModified:n!==e}}};
function Z8(e,t){try{const n=new URL(e,location.href);return z8(n)?(n.searchParams.set("__qcai_handover",t),n.toString()):e}catch{return e}}
```

载体 2 —— **cookie**（`AU("cookie")`）：为跨域/新窗口场景，在 `beforeunload`/`pagehide` 抢写 cookie：

```js
const AU=e=>{name:"cookie",canHandle(t,n){return n.cookieEnabled},
inject(t,n,r){const i=Wf(r.currentHref,e);let s=!1,o=!1...
 function u(){!s||o||(o=!0,s=!1,un("cookie-carrier","write cookie on page unload",{ticket:dr(n),targetUrl:t,cookieName:i.name,cookieDomain:i.domain,cookiePath:i.path}),hv({ticket:n,targetUrl:t},i))}
 function c(){s||(s=!0,o=!1,a=u,l=u,window.addEventListener("beforeunload",a),window.addEventListener("pagehide",l),...)}
 return{url:t,urlModified:!1,lifecycle:{beforeClickApply:c,afterClickRollbackBestEffort:A,onSessionStop:A}}}}
```

新页面侧反向解析（`Voe`）：从 URL 取 `__qcai_handover` 并**删除该参数**（避免泄漏到 Referer/日志），取不到再回落 cookie：

```js
function Voe(e){try{const t=new URL(e,location.href),n=(t.searchParams.get("__qcai_handover")||"").trim();
return n?(t.searchParams.delete("__qcai_handover"),{ticket:n,cleanedHref:t.href}):{ticket:null}}catch{return{ticket:null}}}
```

另外 URL 里 `aft`、`__qcai_handover` 在展示/比对时会被清掉：

```js
const Cie=["aft","__qcai_handover"]; function Bh(e){...for(const r of Cie)t.searchParams.has(r)&&(t.searchParams.delete(r),n=!0)...}
```

交接结果以固定 JSON 回给模型，前端随即清空 UI 状态：

```js
if(l.openedNewContext)return r.set(null),JSON.stringify({handover:!0,message:l.message??"Navigation completed. Page has changed.",url:l.newContextUrl??"",ticket:l.handoverTicket});
if(!l.openedNewContext&&l.deferredNewContext){const d=await P8(l.deferredNewContext,n.signal); ...}
```

`deferredNewContext` 用于 `window.open` 后 URL 异步才就绪（如 `about:blank` → 真地址）的场景，`P8` 轮询后再判定。**接力链条**：page A 上模型 `click`/`goto` → 检测到将换页 → 后端签发 ticket → 注入 URL/cookie → 新页面 `Voe` 取回 → 用 ticket 恢复会话上下文，模型无需重新理解页面。

---

## 三、与宿主页面的集成

### 3.1 工厂与 `window.kiki` API

`pDe(instance, options)` 返回 API 对象；`options` 支持：`uiLocale, navigatorSkillName(默认 "tcloud-navigator"), skillLabels, fullscreen, forceProgramMode, enableModeSwitch, enableFileUpload, enableImageUpload, enableMessageFeedback, imageCompress{maxSizePx:1024,quality:.9,maxRawBytes:20MB,maxBytes:1MB}, extraTabs`。

```js
const z={show:()=>pd(),hide:()=>TAe(),chat:(T,O)=>e.chat(T,O),suggest:T=>e.suggest(T),
snapshot:()=>e.controller.getSnapshot(),
invoke:(T,O)=>{const B=T==="navigator"?{skill:r,command:O}:O;return e.invokeTool(T,B)},
setup:W,session:e.session,lite:{run:(T,O)=>e.runLiteTask(T,O),createTask:T=>e.createLiteTask(T)},
mount:(T,O)=>{...d=Z(pQe(e,B??fDe(),{skillLabels:i,uiLocale:n,branding:e.branding,enableModeSwitch:a,...panelLayout:"floating",forceProgramMode:o,extraTabs:M}),...);z.tabs=h1;return d},
destroy:()=>{k(),F(),z.tabs=void 0;const T=d;if(T){T();return}E()},
addAgentTab:(T,O)=>{...}, addCVMTab:(T,O)=>{...}, addLighthouseTab:(T,O)=>{...},
enableDock:(T=!0)=>IAe(T),onDockRequest:T=>PAe(T),onModeChange:T=>KAe(T),dock:T=>BAe(T),undock:()=>y1()};
return{ready:()=>J,addTools:W.addSkillClientHandlers}}
```

要点：
- 整个 API 是 **async 自举**：`const J=(async()=>{ ... if(!(await e.checkAvailable()).available) return X(); ...})()`，即先探测后端可用性，不可用则返回 null 并自动 `destroy`。宿主须 `await kiki.ready()`。
- `invoke("navigator", "click 12")` 是便捷写法，内部改写为 `{skill:"tcloud-navigator", command:"click 12"}`。
- `mount(container?)` 默认挂到 `#__kiki-root`（不存在则创建并 append 到 `<html>`）。
- `addAgentTab` 要求 `{id,label,mount}`，`mount` 必须返回 `{update,unmount}`；`addCVMTab`/`addLighthouseTab` 是预设业务 Tab。

### 3.2 `setup` 四个扩展点

```js
W={addSkillClientHandlers:X=>e.addSkillClientHandlers(X),
setCodeBlockExecutor:wTe,setIframeEventHandler:$Te,setInputReferenceProvider:zTe}
```

- `addSkillClientHandlers(map)` → `addClientExecTools`：把 `{skillName: handler}` 注册进 `tools.invokeClient`，模型即可通过 `invokeClient` 工具回调**宿主自己的**函数（前端"工具"的扩展位）。

```js
addClientExecTools(t){this.tools.invokeClient||(this.tools.invokeClient={});const n=this.tools.invokeClient;
for(const[r,i]of Object.entries(t))n[r]=new Lee(i),this.dynamicClientToolNames.add(r)}
```

- `setCodeBlockExecutor`：接管代码块"运行"按钮的执行器。
- `setIframeEventHandler`：处理 iframe 预览沙箱回传的事件。
- `setInputReferenceProvider`：`@` 引用选择器的数据源（`inputReference.*` 一整套文案：loading/empty/loadFailed/addResource）。

### 3.3 iframe 宿主通信（postMessage）

宿主 → iframe（`source:"kiki-host"`，带 `channelId` + `nonce`）：

```js
const M={source:"kiki-host",channelId:A,nonce:d,type:"theme",payload:{scheme:s}}; L.postMessage(M,"*");
...
const L={source:"kiki-host",channelId:A,nonce:d,type:"init",payload:{locale:r,scheme:s}};
c.current.forEach(clearTimeout),c.current=t5.map(M=>setTimeout(()=>{...postMessage(L,"*")},M));
```

入站校验要求 `source:"kiki-iframe"` 且 `channelId`/`nonce`/`type` 均为字符串：

```js
function CV(e){return e.source==="kiki-iframe"&&typeof e.channelId=="string"&&typeof e.nonce=="string"&&typeof e.type=="string"}
```

`channelId`/`nonce` 由 `yV("kiki_iframe")`/`yV("nonce")` 生成；`init` 的 payload 是 `{locale,scheme}`（type=init/theme/event）。沙箱 `allow-scripts` 默认开，`allow-forms` 可选。

### 3.4 它本身就是「网站接入 SDK」

文件末尾自举逻辑即 SDK 入口：

```js
function UDe(){const e=window.kiki;return typeof e?.ready=="function"}
function FDe(){console.warn("[KiKi] web-sdk.js 重复加载，已跳过本次初始化")}
function ODe(){TDe()&&Za.setInMiniProgram(!0);const{locale:e,brandName:t,shortBrandName:n}=kDe(),
r=HQe({apiPrefix:"/profile/cloud-h5/api",disableContextSnapshot:!0,backendUrl:"",uiLocale:e,
branding:{name:t,shortName:n}});
Object.assign(window,{kiki:pDe(r,{fullscreen:!0,enableModeSwitch:!1,uiLocale:e})})}
UDe()?FDe():ODe();
```

接入形态明确：`<script src=".../web-sdk.js">` 后自动 `window.kiki`，`fullscreen:true`（全屏面板/超级模式）、`enableModeSwitch:false`（站点方不给用户切"编程模式"）、`disableContextSnapshot:true`（**网站版默认不采集页面结构**，只有控制台内嵌版才开）。`checkAvailable()` 打的是 `POST {baseUrl}{apiPrefix}/available`，body 含 `{url, uiLocale, clientIdentity}`，30s 超时。品牌名/域名按 `LOGIN_INFO.area` 分 domestic/intl：`{domestic:"https://kiki.cloud.tencent.com", intl:"https://kiki.tencentcloud.com"}`。

---

## 四、传输层

### 4.1 聊天请求

```js
const a=Ore(t),l=await this.fetcher(`${this.baseUrl}${this.apiPrefix}/chat${a}`,{
 method:"POST",credentials:"include",headers:this.buildJsonHeaders(),body:JSON.stringify(o),signal:r});
...
const u=l.headers.get(xre)||n||"";if(!l.body)throw new Error("body stream missing");
return{stream:Ere(l.body),sessionId:u}
```

- URL = `{backendUrl}{apiPrefix}/chat` + 查询后缀（用于**成本归因**，不影响语义）：

```js
function Ore(e){const t=e[e.length-1];if(!t)return"";
 if(t.role==="user"){const i=t.parts?.find(s=>s.type==="text")?.text;return`?user=${i?.length??0}_characters`}
 if(t.role==="assistant"){const i=[...t.parts??[]].reverse().find(s=>s.type==="dynamic-tool"&&s.state==="output-available");
  if(i?.toolName){const s=typeof i.output=="string"?i.output:JSON.stringify(i.output);
   return`?tool=${i.toolName}&output=${s.length}_characters`}}return""}
```

- Header 只有 `{...defaultHeaders, "Content-Type":"application/json", "Accept-Language": uiLocale}`（`buildJsonHeaders`）。**`x-vercel-ai-ui-message-stream` 未找到**——协议是 Vercel AI SDK 的 UI message stream 线格式，但没带那个 opt-in 头。
- Body 字段：

```js
const o=this.appendClientIdentityPayload(this.appendLocalePayload({messages:t}));
n&&(o.sessionId=n); i&&i.length>0&&(o.attachments=i); s&&s.length>0&&(o.references=s);
this.chatMode!=="normal"&&(o.mode=this.chatMode); this.channel&&(o.channel=this.channel);
this.disabledTools.length>0&&(o.disabledTools=this.disabledTools);
window.location?.href&&(o.url=window.location.href); this.appendExtraBodyPayload(o);
```

即 `{messages, sessionId?, attachments?, references?, mode?, channel?, disabledTools?, url, uiLocale, clientIdentity}`；`context` 藏在 `messages[].parts` 的 `data-page-context` 里（见 1.7）。

### 4.2 流解析：fetch + ReadableStream，SSE `data:` 行

```js
function Ere(e){const t=new TextDecoder;let n="";return new ReadableStream({async start(r){const i=e.getReader();
for(;;){const{done:s,value:o}=await i.read();if(s)break;n+=t.decode(o,{stream:!0});
const a=n.split("\n");n=a.pop()??"";
for(const l of a){const u=l.trim();if(!(!u||u.startsWith(":"))&&u.startsWith("data: ")){const c=u.slice(6);
if(c==="[DONE]"){r.close();i.releaseLock();return}try{r.enqueue(JSON.parse(c))}catch{}}}} ...
```

无轮询、无 WebSocket；单条 POST + 长连接流。事件类型是 AI SDK v5 UI message chunk：`text-delta`（按 `id` 归并）、`tool-input-start` / `tool-input-available` / `tool-output-available` / `tool-input-error` / `tool-output-error`：

```js
if(n==="tool-input-start"){const a=hi(t.toolCallId)??"",l={type:"dynamic-tool",toolName:hi(t.toolName)??"",toolCallId:a,state:"input-streaming",input:void 0};r.parts.push(l),...}
if(n==="tool-input-available"){...l.state="input-available",l.input=t.input...}
if(n==="tool-output-available"){...l.state="output-available",l.output=t.output,...}
```

### 4.3 会话与 ID 维护

- `sessionId` 优先取响应头 `const xre="X-Session-Id"`，缺省回落本地值。
- 消息 ID 由前端 `Ra()` 现生成（`{id:Ra(),role:"user",parts:Z}`），工具调用 ID 用后端 `toolCallId` 关联。
- 历史：`GET {apiPrefix}/v2/history?sessionId=...&url=...`，返回 `{messages, allowedLinks?, linkRewrites?}`（后两者用于链接白名单与重写）。
- 其他端点：`POST /fork-ticket`、`POST /fork`（`{ticket}`）、`POST /available`、`POST /suggest`。

---

## 五、模式与能力面

### 5.1 三种"模式"

| 概念 | 证据 | 含义 |
|---|---|---|
| `chatMode` | `this.chatMode=t.chatMode??"normal"`；lite 任务用 `chatMode:"lite-task"` | 请求级模式，随 body `mode` 下发 |
| 界面模式 / 编程模式 | `input.uiMode:"界面模式"`、`input.uiModeTooltip:"{brandName}自动代操作界面，所见即所得"`、`input.programMode:"编程模式"`、`input.programModeTooltip:"直接调用云API，操作更灵活快速"` | 用户可切的两种执行形态 |
| Super Mode（超级模式） | `header.exitSuperMode:"退出超级模式"`，渲染为 `qcaa-panel__beta-tag--exit` 按钮 | 全屏沉浸面板态；与 `pDe` 的 `fullscreen` 选项强相关，但二者的直接绑定代码未找到 |

`forceProgramMode` 会锁死编程模式并隐藏切换器（`enableModeSwitch` 自动失效），网站 SDK 即 `enableModeSwitch:false`。`lite` 是**无 UI 的一次性任务**：`kiki.lite.run(task, opts)` → 内部 `createLiteTask` 建 `chatMode:"lite-task"` 的独立 transport（`tools:{}`、关掉追问建议），跑完即 `destroy`；回调 `onUpdate({text,snapshot})`。

### 5.2 「领航」条状态机（`strip.*`）

```js
"strip.manualAction":"请手动点击高亮的元素"
"strip.confirmDefault":"关键操作需要确认后执行。","strip.confirmExecute":"确认并执行"
"strip.paused":"任务已暂停","strip.pausedText":"任务已暂停，请选择继续或终止任务","strip.resuming":"恢复中...",
"strip.continueTask":"继续任务","strip.terminateTask":"终止任务","strip.error":"任务执行出错，请展开面板查看详情。",
"strip.taskError":"任务执行出错","strip.processing":"处理中...","strip.running":"运行中...",
"strip.thinking":"正在规划下一步动作...","strip.answering":"正在回复...",
"strip.expandAria":"展开领航面板","strip.pauseAria":"暂停领航","strip.supplement":"补充","strip.expandStatus":"点击展开查看当前状态"
```

UI 由 `phase` 驱动（`resolveFloatingSlot`）：`awaiting-navigation-mode`（首次批量执行的"开启导航模式"确认）、`confirming`（`Kz` 确认卡）、`manual-action`（高亮 + "请手动点击"）、`executing`、`paused`。竞态处理：用户一旦介入（点击/输入），`userInteractionMonitor` 触发 `{type:"requestPause",reason:"navigator-user-<type>"}` 主动暂停，把控制权交回人类。

### 5.3 工具清单与前端渲染

i18n `tool.name.*` 全集：

```js
"tool.name.navigator":"导航操作","tool.name.skill":"技能调度","tool.name.invokeClient":"客户端动作",
"tool.name.shellExecute":"命令执行","tool.name.bash":"命令执行","tool.name.readFile":"读取文件",
"tool.name.writeFile":"写入文件","tool.name.editFile":"编辑文件","tool.name.exportFile":"导出文件",
"tool.name.browser":"浏览器操作","tool.name.askUser":"等待确认","tool.name.mfaVerify":"MFA 校验",
"tool.name.knowledgeQa":"检索知识库","tool.name.historyQa":"正在回忆","tool.name.webSearch":"联网搜索",
"tool.name.delegateToAgent":"业务 Agent"
```

**只有 5 个工具有专属前端 UI**，其余走通用工具行组件：

```js
const SY=[Mz,Qz,uY,eQe,{toolName:"exportFile",MessageContent:rQe}]
// Mz: askUser, Qz: invokeClient, uY: mfaVerify, eQe: delegateToAgent
```

有客户端实现的只有三个：

```js
function U(){return{askUser:new Ire({onSessionEvent:...,recoveryAnswer:()=>Lu(i,"ask.recoveryPageChanged")}),
invokeClient:{"tcloud-navigator":new Bie({domProvider:F,onSessionEvent:...,onActionStart:...,overlaySelectors:k})},
mfaVerify:new CQe({backendUrl:t.backendUrl??t9,apiPrefix:l,getUiLocale:()=>i})}}
```

- `askUser`（`Ire`）：`createAskHandle` 弹问题卡，字段 `{type, question, options, allowMultiple, questions, answerMode}`，等 `waitForAction("submit")`；支持"页面已变更"式恢复（`ask.recoveryPageChanged`）。
- `invokeClient`（`Bie`）：就是 navigator 的客户端执行器（`tcloud-navigator` 是唯一内置 key），带 `capabilities:{handoverOnRecovery:!0}`、操作历史去重（重复操作会强制重截图）、`navigationModeConfirmed` 门禁。
- `mfaVerify`（`CQe`）：走 `apiPrefix` 后端做 MFA 会话，参数含 `{faceIdToken, hasOpenId, isWeapp}`。
- `shellExecute`/`bash`/`readFile`/`writeFile`/`editFile`/`exportFile`/`browser`/`knowledgeQa`/`historyQa`/`webSearch`：**前端只渲染状态与错误，无本地执行器**（`bash` 仅 `qcaa-structured-message__tool-line` 折叠行）。

### 5.4 `delegateToAgent` / A2A

前端只有渲染层，无协议实现（未找到 A2A 客户端传输代码）：

```js
"tool.name.delegateToAgent":"业务 Agent","a2a.defaultName":"业务 Agent","a2a.working":"{name} 执行中",
"a2a.inputRequired":"{name} 需要补充信息","a2a.completed":"{name} 已完成","a2a.failed":"{name} 执行失败",
"a2a.canceled":"{name} 已取消","a2a.artifacts":"产物","a2a.runningStatus":"业务 Agent 运行中",
"a2a.waitingInput":"业务 Agent 等待补充信息","a2a.dispatching":"任务分派中…","a2a.fullTextLoading":"正在加载完整结果…"
```

```js
const mY="delegateToAgent"; const eQe={toolName:mY,MessageContent:_Pe,resolveFloatingSlot({snapshot:e}){...}}
```

判断依据 `$Pe` 找"最后一个未完成的 delegateToAgent 工具调用"来挂浮动卡。**委派协议、Agent 注册、产物拉取均在后端**（`a2a.fullTextLoading` 说明有独立的全文拉取接口，但端点未找到）。

### 5.5 技能映射

```js
const uDe={"tcloud-navigator":"skill.tcloudNavigator","tcloud-query":"skill.tcloudQuery",
"tcloud-knowledge-qa":"skill.tcloudKnowledgeQa","tcloud-sitemap":"skill.tcloudSitemap",
"tcloud-sitemap-intl":"skill.tcloudSitemap","tcloud-history-qa":"skill.tcloudHistoryQa",
"tcloud-api":"skill.tcloudApi"};
```

文案依次为「正在为操作做准备 / 正在为查询做准备 / 准备知识库 / 正在查看站点信息 / 正在回忆 / 正在准备执行」。只有 `tcloud-navigator` 有前端实现（`Bie` + `pDe` 的 `navigatorSkillName` 可改名）；`tcloud-query`、`tcloud-knowledge-qa`、`tcloud-sitemap`、`tcloud-history-qa`、`tcloud-api` 均为后端技能，前端仅显示进度标签。

---

## 六、可复刻性判断

### 纯前端可复用（约 60%，可直接抄思路）

| 组件 | 证据 | 说明 |
|---|---|---|
| 无障碍树提取 + 文本序列化 | `zne` / `_ne` / `Yne` | 最大价值件。role 白名单、occluded/scrollable 标记、15000 行截断，browser-use 同类，可独立复用 |
| ref 寻址 | `data-qca-ref` + `bv` Map + `gne` | 属性持久化保证跨快照稳定，比"数组下标"健壮得多，属关键设计 |
| 高亮层 | `dk` / `Cu="qcloud-assistant-highlight-container"` + `z-index:2147483647` | 纯 CSS/DOM，无依赖 |
| overlay 自排除 | `$ne` + 5 条选择器 | 必做，否则自指 |
| 动作执行器 | `ioe` / `doe` / `sU` / `Soe` / `coe` | 滚动居中 + 稳定检测（`soe` 700ms 内连续 2 次命中）+ 视口可见率 0.4 阈值，工程细节扎实 |
| 风险分级 + 人工接管 | `Zv` / `Xv` / `x8` / `runManualAction` | `data-risk` 三值协议 + 高危命令黑名单 + `phase:"manual-action"` 等待 `manualComplete` |
| 确认 UI 状态机 | `phase:"confirming"` / `awaiting-navigation-mode` | 与后端解耦 |
| 截图 | `woe`（html2canvas-pro，视口裁剪 + JPEG 0.6） | 有 CORS/taint 限制，canvas 无法采样时返回 null |
| 宿主 API + 扩展点 | `pDe` / `W` / `addAgentTab` | Tab 注册、`update/unmount` 生命周期可照搬 |
| iframe postMessage | `kiki-host` / `channelId` / `nonce` | 三消息类型 + nonce 校验，模式简单可抄 |
| batch 校验 | `validateBatchCommands` | 上限 150、禁 goto/snapshot/screenshot、禁 `--confirm`、运行期复查 |

### 必须后端配合（约 40%）

| 组件 | 证据 | 为什么前端做不了 |
|---|---|---|
| Agent 工具循环 / 决策 | 前端只解析 `data:` 流 | 模型编排、上下文裁剪、重试都在服务端 |
| 传输协议 | `/chat` + `X-Session-Id` + AI SDK UI message stream | 需服务端产出同格式 chunk |
| 历史与链接治理 | `/v2/history` 返回 `allowedLinks` / `linkRewrites` | 白名单必须服务端下发，前端自审无意义 |
| 跨页 handover ticket | `/fork-ticket`（`sessionId + targetOrigin + scene`），5min TTL | 签发/校验/一次性消费必须服务端；`/fork` 用 ticket 换新会话 |
| MFA | `mfaVerify` → `apiPrefix` | 人脸/OpenID 校验 |
| A2A 委派 | `delegateToAgent` / `a2a.*` | 前端只有卡片，无协议 |
| 后端技能 | `tcloud-query/sitemap/api/...` | 仅 label |
| 额度与品牌 | `quota.warning/exhausted`、`checkAvailable`、`branding` | 服务端配置 |

### 最小可复刻清单

1. `extractDOM()`：`zne`（树）+ `_ne`（文本）+ `data-qca-ref`（ref）——**约 300 行，最高性价比**。
2. `overlaySelectors` 自排除 + 高亮容器双保险。
3. 8 动作执行器（去掉 goto 的 handover 分支即可纯前端跑）。
4. `data-risk` + `Xv/Zv` + `runManualAction` 的三级风险闸门。
5. 一个 SSE 客户端，认 `data: ` / `[DONE]` / `tool-input-*` / `tool-output-*`。
6. 后端补：`/chat`、`/fork-ticket`、`/v2/history`、工具循环。

**一句话结论**：KiKi 的前端是一个"无障碍树 + 数字 ref + 风险闸门 + 票据接力"的浏览器代理外壳，DOM 侧几乎全部可独立复刻（treeSnapshot 与 ref 持久化是最值得抄的两处）；真正的护城河在 `/chat` 的模型循环与 `/fork-ticket` 的跨页会话接力，这两块前端只是消费者。
