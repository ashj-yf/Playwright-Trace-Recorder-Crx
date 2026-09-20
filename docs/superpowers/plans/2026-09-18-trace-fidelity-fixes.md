# 0.2.0 录制成果物样式丢失与录制丢失修复 — 实施计划

## Context

0.2.0 产物 `Recording 16_42_54.zip`（trace v6，77.6s / 45 action / 119 快照）经官方
playwright-core 1.59.1 viewer 源码交叉验证，确认 5 类根因（4 类已实证 + 1 类用户追加）：

1. **样式丢失**：DOM 快照序列化器原样复制 content 属性（`src/service_worker.js:942`），
   27 个 stylesheet LINK 的 href 全为 root-relative，而资源表/`resourceOverrides` 是绝对 URL。
   viewer 机制（sw.bundle.js `serveResource`→`resourceByUrl`）：快照文档是 SW 受控 client，
   其子资源请求被路由到 SW，按 URL **精确字符串等值**匹配 `trace.network` 的 `request.url`
   （http URL 原样放行，1.59.1 无 `pw-` 前缀改写）；相对 URL 解析到 viewer origin → 真实
   fetch → 404。产物另实证 1 处内联 style 相对 `url(/v/design-platform/assets/bg.*.png)`。
   IMG 缺 `__playwright_current_src__`（懒加载图实际地址，官方字段名）。
2. **快照丢失**：`maxQueuedCaptures=4` + 入队时一次性 `withSnapshots` 判定
   （service_worker.js:1251-1252），突发 567ms/8 action 被整段拒拍 action+after 快照，
   且导出端无条件写 input 行指向不存在的快照（悬空 inputSnapshot）。
3. **SPA 导航丢失**：CDP 白名单（service_worker.js:1561-1665）无 `Page.*` 分支；
   `rec.url` 仅在空时回填（1345-1348/1362-1365）；时间线零导航事件。
4. **交互缺口**：仅监听 click/keydown/scroll/input/change（content.js:69-73）；
   bpmn 画布拖拽（mousedown/mouseup）不录；无 dblclick/contextmenu；checkbox 一次点击
   产出 click+input+change 三条 action；click 的 x/y 采集了但 SW 未透传（viewer 红圈 point）。
5. **iframe 交互丢失**（用户确认纳入）：content script 仅注入顶层 frame
   （manifest.json:27 `all_frames:false` + content.js:3-5 顶层守卫）。iframe 内点击/输入
   无事件来源。**注意**：快照与 action 三档快照本来就是全帧 map
   （`captureDomSnapshot` 遍历 `refreshFrames` 全部 frame），事件无需归属帧——放开注入即闭环，
   SW/导出端零改动。

**Goal**：同场景重新录制后，官方 viewer 中样式完整、每个 action 都有 after 快照、SPA 路由
切换可见、双击/右键/拖拽可录、勾选单条 action 且显示点击点、iframe 内交互可录。

**Tech Stack**：MV3 扩展（无构建转译，`bash build.sh` 原样拷贝 src/→build/）；CDP via
chrome.debugger；IndexedDB（src/traceStore.js）；测试 Playwright 1.59.1（tests/，
加载未打包扩展）。

## Global Constraints

- 改任何 `src/` 后必须 `bash build.sh`（测试加载 `build/`，manifest 版本当前 0.2.0）。
- 测试命令：`cd tests && npx playwright test e2e/<spec>`（workers:1；tests 不得依赖外网）。
- 官方 viewer 兼容是验收基准：断言用官方 `SnapshotStorage`（tests/node_modules/
  playwright-core/lib/utils/isomorphic/trace/snapshotStorage）做资源匹配 oracle。
- 复用既有设施：`logEvent`（SW:1174）、`enqueueRequestTask`（SW:1408）、`frameIdForNetwork`
  （SW:1400-1406）、`captureDomSnapshot`（SW:1102）、`getElementSelector`（content.js:244）、
  `readEntry/listEntries`（tests/e2e/support/recorder.ts:115-122）、`renderSnapshots`
  （tests/e2e/support/snapshotOracle.ts）。
- 不改动 fill 合并机制（service_worker.js:1219-1247）；新事件类型全部走非 fill 分支，
  `settlePendingFill('interrupt')` 自动生效。
- 提交遵循 Conventional Commits（如 `fix: ...`/`feat: ...`），每任务一提交。
- 计划文件本身在本轮批准后同步拷贝到 `docs/superpowers/plans/2026-09-18-trace-fidelity-fixes.md`。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/service_worker.js` | 序列化器绝对化（891-1019）、快照分级（1212-1366）、CDP 导航分支（~1644）、params 透传（1326-1330） |
| `src/content.js` | 交互监听（69-112）、checkbox 守卫（197/222）、拖拽/双击/右键 handler、顶层守卫放开（3-11） |
| `src/traceGeneratorExtension.js` | input 行守卫+point（393-397）、navigation 导出分支（~497） |
| `manifest.json` | `all_frames:true`（:27） |
| `tests/e2e/support/testPage.ts` | fixture 扩展（相对 URL 资源、SPA 路由、burst 按钮、交互元素） |
| `tests/e2e/support/snapshotOracle.ts` | 新增 `buildResourceOracle` |
| `tests/e2e/*.spec.ts` | 4 个新 spec + snapshot-fidelity 增强 |

---

## Task 1：资源 URL 绝对化（含内联 style url()）

**Files**: Modify `src/service_worker.js`（buildDomSnapshotExpr 891-1019）、
`tests/e2e/support/testPage.ts`、`tests/e2e/support/snapshotOracle.ts`、
`tests/e2e/url-absolutization.spec.ts`（新建）

- [ ] **Step 1.1 fixture + oracle + 失败断言**：testPage.ts `buildPage()` body 追加
  （全部复用已有路由 /small.png、/big.css，避免 memory-bounded 的 `cssEntries ≤ 2` 超限）：
  `<a id="rel-link" href="/frame.html">`、`<img id="srcset-img" srcset="/small.png 1x, /small.png 2x">`、
  `<video ... poster="/small.png">`（改现有 video 标签）、
  `<svg width="20" height="20"><use href="#sym"/></svg><svg><image href="/small.png" width="10" height="10"/></svg>`、
  `<embed src="/small.png" type="image/png">`、`<object data="/small.png" type="image/png">`、
  `<a href="javascript:alert(1)" id="js-link">`、
  `<div id="inline-bg" style="background:url(/small.png)"></div>`。
  snapshotOracle.ts 追加（官方 SnapshotStorage 即 SW serveResource 内部同一实现）：
  ```ts
  export function buildResourceOracle(frameSnapshotLines: any[], networkLines: any[]) {
    const { SnapshotStorage } = require(`${corePath}/lib/utils/isomorphic/trace/snapshotStorage`);
    const storage = new SnapshotStorage();
    for (const line of networkLines) storage.addResource('context@test', line.snapshot);
    const renderers = frameSnapshotLines.map(l => storage.addFrameSnapshot('context@test', l.snapshot, []));
    storage.finalize();
    return {
      renderers,
      resourceByUrl: (idx: number, url: string, method = 'GET') => renderers[idx].resourceByUrl(url, method)
    };
  }
  ```
  新 spec `url-absolutization.spec.ts`：复用 snapshot-fidelity 的骨架（startServer → goto →
  openSidePanel → Start Recording → 少量交互 → stopAndDownload → readEntry 解析），断言：
  ```ts
  const rawMain = snapshots.filter(s => s.snapshot.frameId === mainFrameId).map(s => JSON.stringify(s.snapshot.html));
  for (const json of rawMain) {
    expect(json).toContain('"href":"http://localhost:8153/big.css"');
    expect(json).toContain('"src":"http://localhost:8153/small.png"');
  }
  expect(rawMain[0]).toContain('"__playwright_current_src__":"http://localhost:8153/small.png"');
  expect(rawMain[0]).toContain('url(http://localhost:8153/small.png)');   // 内联 style url()
  expect(rawMain[0]).toContain('"srcset":"http://localhost:8153/small.png 1x');
  expect(rawMain[0]).not.toMatch(/"(?:href|src|poster|srcset)":"\//);
  expect(rawMain[0]).toContain('"href":""');                              // javascript: 置空
  // 官方资源匹配 oracle：
  const networkLines = readEntry(zipPath, 'trace.network').toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const oracle = buildResourceOracle(frameSnapshotLines, networkLines);
  const cssRes = oracle.resourceByUrl(mainIdx, 'http://localhost:8153/big.css');
  expect(cssRes).toBeTruthy();
  expect(cssRes.response.content._sha1).toBeTruthy();
  expect(oracle.resourceByUrl(mainIdx, 'http://localhost:8153/small.png')).toBeTruthy();
  expect(listEntries(zipPath)).toContain('resources/' + cssRes.response.content._sha1);
  ```
- [ ] **Step 1.2 跑测确认失败**：`cd tests && npx playwright test e2e/url-absolutization.spec.ts`（应 FAIL：相对路径仍在）
- [ ] **Step 1.3 实现绝对化**：buildDomSnapshotExpr 模板内 `function s(n,d)`（929 行）之前插入
  页面内工具（骨架来自官方 snapshotterInjected 对齐）：
  ```js
  var KEEP_URL = /^(https?:|data:|blob:|about:|mailto:|tel:|sftp:|ftp:|ws:|wss:)/i;
  var JS_URL = /^\s*(?:javascript|vbscript):/i;
  function sanitizeUrl(u){ if(u==null) return u; u=String(u); return JS_URL.test(u)?'':u; }
  function absolutize(u, base){
    if(u==null) return u; u=String(u).trim(); if(!u) return u;
    if(u.charAt(0)==='#') return u;
    if(KEEP_URL.test(u)) return sanitizeUrl(u);
    try{ return new URL(u, base).href; }catch(e){ return sanitizeUrl(u); }
  }
  function absolutizeSrcSet(v, base){
    if(!v) return v;
    return v.split(',').map(function(part){
      var t=part.trim(); if(!t) return '';
      var sp=t.lastIndexOf(' ');
      return sp===-1 ? absolutize(t,base) : absolutize(t.slice(0,sp),base)+t.slice(sp);
    }).join(', ');
  }
  function absolutizeCssUrls(text, base){   // 内联 style 文本与 style 属性
    return String(text).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function(m,q,u){
      return 'url(' + absolutize(u, base) + ')';
    });
  }
  function idlUrl(n){   // 只接受字符串型 IDL（HTML 天然绝对；SVG SVGAnimatedString 走 absolutize）
    try{
      var v = n.href !== undefined ? n.href : (n.src !== undefined ? n.src : (n.data !== undefined ? n.data : null));
      if(typeof v === 'string' && v) return v;
    }catch(e){}
    return null;
  }
  ```
  942 行属性循环改为：
  ```js
  var URL_ATTRS = { href:1, src:1, srcset:1, poster:1, data:1, 'xlink:href':1 };
  for(i = 0; i < n.attributes.length; i++){
    var an = n.attributes[i].name, av = n.attributes[i].value;
    if (an === 'style' && av && av.indexOf('url(') >= 0) { a[an] = absolutizeCssUrls(av, n.baseURI || document.baseURI); continue; }
    if (tn === 'IFRAME' || tn === 'FRAME') { a[an] = av; continue; }  // src 由导出端 #frameId/name 覆盖
    if (!URL_ATTRS[an]) { a[an] = av; continue; }
    if (an === 'srcset') a[an] = absolutizeSrcSet(av, n.baseURI || document.baseURI);
    else if (an === 'xlink:href') a[an] = absolutize(av, n.baseURI || document.baseURI);
    else { var idl = idlUrl(n); a[an] = sanitizeUrl(idl != null ? idl : absolutize(av, n.baseURI || document.baseURI)); }
  }
  ```
  循环后（applyLiveState 953 行附近）加：
  ```js
  if(tn === 'IMG' || tn === 'PICTURE'){
    var cs=''; try{ cs = n.currentSrc || ''; }catch(e){}
    a['__playwright_current_src__'] = sanitizeUrl(cs);
  }
  ```
  STYLE 文本出口（949-951 行）改为先 `absolutizeCssUrls(css, document.baseURI)` 再返回。
  跳过项：`on*` 保持现状（官方置空为可选增强，不属本次）、SCRIPT（944 行已提前 return）。
- [ ] **Step 1.4 `bash build.sh` → 跑新 spec 通过**
- [ ] **Step 1.5 回归**：`npx playwright test e2e/snapshot-fidelity.spec.ts`（注意体积比率断言
  `median/firstSize`、`spread < 1.5`；绝对化仅增加少量字节，若超限在断言处放宽并在提交说明中注明）
- [ ] **Step 1.6 Commit**：`fix: 绝对化快照资源 URL 以命中 viewer 资源表`

## Task 2：after 快照必拍 + 导出 input 行守卫与 point 透传

**Files**: Modify `src/service_worker.js`（211-214、1212-1366、1326-1330）、
`src/traceGeneratorExtension.js`（393-397）、`tests/e2e/burst-actions.spec.ts`（新建）、
`tests/e2e/support/testPage.ts`（burst 按钮）

- [ ] **Step 2.1 fixture + 失败断言**：buildPage() 加 8 个 `<button class="burst" id="burst-0..7">`。
  spec：录制开始后 `await page.evaluate(() => document.querySelectorAll('.burst').forEach(b => b.click()))`
  （一个宏任务全部入队，复现 567ms/8action 突发）→ `waitForTimeout(10_000)` 排空 → stopAndDownload。
  断言：
  ```ts
  const clicks = befores.filter(b => b.method === 'click');
  expect(clicks).toHaveLength(8);
  expect(afters).toHaveLength(befores.length);
  for (const a of afters) expect(a.afterSnapshot).toBeTruthy();      // 全部有 after
  const names = new Set(frameSnapshotLines.map(l => l.snapshot.snapshotName));
  for (const a of afters) expect(names.has(a.afterSnapshot)).toBe(true);
  const inputs = lines.filter(l => l.type === 'input');
  expect(inputs.length).toBeGreaterThanOrEqual(4);                   // 前 4 个有 action 档
  expect(inputs.length).toBeLessThanOrEqual(8);                      // 被抑制的不再悬空
  for (const inp of inputs) expect(names.has(inp.inputSnapshot)).toBe(true);
  ```
- [ ] **Step 2.2 跑测确认失败**（当前实现 8 连击后 5 个无 after）
- [ ] **Step 2.3 实现分级**：service_worker.js——
  `createRecording` 的 `dropped` 增加 `actionSnapshots:0`；`enqueueAction` 1249-1257 与
  `recordFillAction` 1267-1269 的 `withSnapshots` 改名 `withActionSnapshot`（判定式不变，
  语义注释改为"action 档快照闸门"）；`recordAction(rec, event, opts)` 第三参改对象：
  ```js
  let actionSnapshotIds = {};
  if (opts.withActionSnapshot) {
    actionSnapshotIds = flatSnapshotIds(await captureDomSnapshot(rec));
    if (rec !== activeRecording) return;
  } else { rec.dropped.actionSnapshots++; }
  ```
  after 快照段（1338-1351）去掉 `withSnapshots &&` 前置，只保留 `rec.debuggeeTabId` 条件；
  150ms sleep 保留（异步 DOM 稳定窗口）。rec.url 回填行（1345-1348）保留 viewport 部分。
  **params 透传**（1326-1330）：
  ```js
  params: {
    selector: event.selector || '',
    ...(event.value != null ? { value: event.value } : {}),
    ...(event.key != null ? { key: event.key } : {}),
    ...(event.sourceSelector ? { sourceSelector: event.sourceSelector } : {}),
    ...(Number.isFinite(event.x) && Number.isFinite(event.y)
        ? { point: { x: Math.round(event.x), y: Math.round(event.y) } } : {})
  },
  ```
  并删除 1362-1365 的 `if (!rec.url && event.url)` 兜底（rec.url 由 Task 3 的导航 handler 拥有；
  本任务先留 302-311 初始回填兜底）。
- [ ] **Step 2.4 导出端 input 行**：traceGeneratorExtension.js 393-397 改为
  ```js
  if (actionLines.length > 0) {
    yield JSON.stringify({
      type: 'input', callId: actionId, inputSnapshot: actionName,
      ...(event.params && event.params.point ? { point: event.params.point } : {})
    }) + '\n';
  }
  ```
- [ ] **Step 2.5 `bash build.sh` → 新 spec 通过 → 回归 fill-coalescing + snapshot-fidelity**
- [ ] **Step 2.6 Commit**：`fix: 突发操作保证 after 快照并消除悬空 input 引用`

## Task 3：SPA/整页导航事件

**Files**: Modify `src/service_worker.js`（~1644 新分支、rec.url）、
`src/traceGeneratorExtension.js`（351 附近去重表、~497 新分支）、
`tests/e2e/navigation-events.spec.ts`（新建）、`tests/e2e/support/testPage.ts`（SPA 路由）

- [ ] **Step 3.1 fixture + 失败断言**：server 加 `case '/spa-route': return send('text/html; charset=utf-8', buildPage())`；
  buildPage() 加 `<button id="spa-push" onclick="history.pushState(null,'','/spa-route')">` 与
  `<a id="hash-link" href="#/hash-route">`。spec：开始录制 → 点 `#spa-push` →
  `page.goto('http://localhost:8153/frame.html')`（整页导航，主 frame 换 id）→ 停止。断言：
  ```ts
  const navs = lines.filter(l => l.type==='event' && l.class==='Frame' && l.method==='navigated');
  expect(navs.length).toBeGreaterThanOrEqual(3);                    // 初始合成 + pushState + 整页
  expect(navs.some(n => n.params.url.endsWith('/spa-route'))).toBe(true);
  expect(navs.some(n => n.params.url.endsWith('/frame.html'))).toBe(true);
  expect(navs.every(n => typeof n.params.name === 'string')).toBe(true);
  const urls = navs.map(n => n.params.url);
  expect(new Set(urls).size).toBe(urls.length);                     // 同 frame 连续同 URL 去重
  expect(JSON.parse(readEntry(zipPath,'metadata.json').toString()).pages[0].url)
    .toContain('/frame.html');                                      // rec.url 最终 URL（行为变更：原为首 URL）
  ```
- [ ] **Step 3.2 跑测确认失败**
- [ ] **Step 3.3 SW 实现**：onEvent 白名单 Network 段之前（~1644）插入：
  ```js
  if (method === 'Page.frameNavigated' || method === 'Page.navigatedWithinDocument') {
    const cdpFrameId = params.frame ? params.frame.id : params.frameId;
    if (cdpFrameId) enqueueRequestTask(rec, async () => {
      if (!rec.frames.has(cdpFrameId)) await syncFrameTree(rec);
      const frameId = frameIdForNetwork(rec, sessionId, { frameId: cdpFrameId });
      const url = (params.frame && params.frame.url) || params.url || '';
      const name = (params.frame && params.frame.name) || '';
      if (!url) return;
      const entry = rec.frames.get(cdpFrameId);
      if (entry) entry.url = url;
      if (frameId === rec.mainFrameId && url !== rec.url) { rec.url = url; persistSession(rec); }
      await logEvent(rec, { type: 'navigation', frameId, url, name: name || '', timestamp: Date.now() });
    });
    return;
  }
  ```
  （主 session 与 OOPIF flatten session 的 frameId 均由 `rec.frames`/`frameBySession` 覆盖；
  worker target 不 enable Page，无噪声。）
- [ ] **Step 3.4 导出实现**：初始合成导航（339-349）后种 `const lastNavigatedUrl = new Map()`
  并 `lastNavigatedUrl.set(mainFrameId, recording.url)`；事件循环与 console 分支并列加：
  ```js
  } else if (event.type === 'navigation') {
    if (lastNavigatedUrl.get(event.frameId) === event.url) continue;
    lastNavigatedUrl.set(event.frameId, event.url);
    yield JSON.stringify({
      type: 'event', time: relTime(eventTime), class: 'Frame', method: 'navigated',
      params: { url: event.url, name: event.name || '' }, pageId, internal: {}
    }) + '\n';
  }
  ```
  （`name` 为 CDP frame name/iframe name 属性，非文档 title——官方 frameDispatcher 语义。）
- [ ] **Step 3.5 `bash build.sh` → 新 spec 通过 → 回归 fill-coalescing**
- [ ] **Step 3.6 Commit**：`feat: 录制 SPA 与整页导航事件`

## Task 4：交互补全（dblclick/contextmenu/dragTo/checkbox 合并）

**Files**: Modify `src/content.js`、`tests/e2e/interactions.spec.ts`（新建）、
`tests/e2e/support/testPage.ts`

- [ ] **Step 4.1 fixture + 失败断言**：buildPage() 加 `#dbl-target` 按钮、`#ctx-target` div、
  `#drag-source`/`#drop-zone`（100×100 定位 div）、`#check2` checkbox。spec 用真实鼠标：
  `page.dblclick('#dbl-target')` → `page.click('#ctx-target', {button:'right'})` →
  mouse.down/move(steps:5)/up 拖 `#drag-source`→`#drop-zone` → `page.click('#check2')`。断言：
  ```ts
  expect(methods).toContain('dblclick');
  expect(methods).toContain('contextmenu');
  expect(methods).toContain('dragTo');
  const dbl = befores.find(b => b.method === 'dblclick');
  expect(befores.filter(b => b.method === 'click' && b.params.selector === dbl.params.selector))
    .toHaveLength(1);                          // 第二击 click 被吞，仅余首击
  const drag = befores.find(b => b.method === 'dragTo');
  expect(drag.params.sourceSelector).toBeTruthy();
  expect(drag.params.point).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  expect(befores.filter(b => b.params.selector === '#check2')).toHaveLength(1);  // 只剩一条 click
  expect(befores.some(b => b.method === 'input' && b.params.selector === '#check2')).toBe(false);
  const inputLine = lines.find(l => l.type === 'input' && l.callId === click.callId);
  expect(inputLine.point).toBeTruthy();        // viewer 红圈
  ```
- [ ] **Step 4.2 跑测确认失败**
- [ ] **Step 4.3 实现**：content.js——
  监听注册（69-73）追加 `dblclick`/`contextmenu`/`mousedown`/`mouseup`（capture），stopRecording
  （86-90）镜像移除。模块状态：`let dragGesture=null; let suppressClickUntil=0; const DRAG_MIN_DISTANCE=6;`。
  handleClick 改造（96-112）：
  ```js
  if (event.detail >= 2) return;                    // 双击第二击由 dblclick 事件表达
  if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; }  // 拖拽后的随附 click
  ```
  （**不引入 350ms click 延迟**——保持事件时序零变化。）新 handler：
  ```js
  function handleDblclick(event){
    if (!isRecording || isReplaying) return;
    sendEventToBackground({ type: 'dblclick', selector: getElementSelector(event.target),
      x: event.clientX, y: event.clientY });
  }
  function handleContextmenu(event){
    if (!isRecording || isReplaying) return;
    sendEventToBackground({ type: 'contextmenu', selector: getElementSelector(event.target),
      x: event.clientX, y: event.clientY });
  }
  function handleMouseDown(event){
    if (!isRecording || isReplaying) return;
    dragGesture = { selector: getElementSelector(event.target), x: event.clientX, y: event.clientY };
  }
  function handleMouseUp(event){
    if (!isRecording || isReplaying) { dragGesture = null; return; }
    const g = dragGesture; dragGesture = null;
    if (!g) return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    if (dx*dx + dy*dy < DRAG_MIN_DISTANCE * DRAG_MIN_DISTANCE) return;  // 普通点击
    suppressClickUntil = Date.now() + 100;
    sendEventToBackground({ type: 'dragTo', sourceSelector: g.selector,
      selector: getElementSelector(event.target), x: event.clientX, y: event.clientY });
  }
  ```
  checkbox/radio 合并——`isTextEditable`（117-126）旁加：
  ```js
  function isToggleControl(el){
    if (!el || el.tagName !== 'INPUT') return false;
    const t = (el.getAttribute('type') || '').toLowerCase();
    return t === 'checkbox' || t === 'radio';
  }
  ```
  handleInput（197）与 handleChange（222）开头各加 `if (isToggleControl(event.target)) return;`
  （勾选态由快照 `__playwright_checked_` 表达，applyLiveState 已有；click 的 method 保持
  `'click'`，不改 `'check'`——`Page.check` 非真实协议 API，语义存文本即可）。
  SW 端 params 透传已在 Task 2 Step 2.3 完成（sourceSelector/point）。
- [ ] **Step 4.4 `bash build.sh` → 新 spec 通过 → 回归 fill-coalescing**
- [ ] **Step 4.5 Commit**：`feat: 录制双击/右键/拖拽并合并 checkbox 三连事件`

## Task 5：iframe 内交互

**Files**: Modify `manifest.json`（:27）、`src/content.js`（3-11、320-327 对应兜底）、
`tests/e2e/iframe-interactions.spec.ts`（新建）

- [ ] **Step 5.1 失败断言**：fixture 已有 `/frame.html` + `#frame-btn`。spec：录制开始 →
  `page.frameLocator('#childFrame').locator('#frame-btn').click()` → 停止。断言：
  ```ts
  expect(befores.some(b => b.method === 'click' && b.params.selector === '#frame-btn')).toBe(true);
  ```
- [ ] **Step 5.2 跑测确认失败**（当前 iframe 无监听）
- [ ] **Step 5.3 实现**：manifest.json:27 `"all_frames": false` → `true`；content.js 3-5 顶层
  守卫块删除（`window._ventriloquistInjected` 检查保留，per-window 幂等）；service_worker.js
  320-327 兜底 executeScript 两处 target 加 `allFrames: true`。**SW/导出端零改动**
  （快照与三档 idsMap 本就是全帧 map；RECORDING_STARTED/STOPPED 的 `tabs.sendMessage`
  无 frameId 时天然广播所有帧）。
- [ ] **Step 5.4 `bash build.sh` → 新 spec 通过 → 回归 snapshot-fidelity**
  （fixture 的 iframe 点击会新增 action，确认无计数类断言被打破）
- [ ] **Step 5.5 Commit**：`feat: 录制 iframe 内用户交互`

## Task 6：全量回归与真实验证

- [ ] **Step 6.1**：`cd tests && npx playwright test e2e/url-absolutization.spec.ts e2e/burst-actions.spec.ts e2e/navigation-events.spec.ts e2e/interactions.spec.ts e2e/iframe-interactions.spec.ts e2e/snapshot-fidelity.spec.ts e2e/fill-coalescing.spec.ts e2e/memory-bounded.spec.ts` 全绿（github-* 依赖外网不跑）
- [ ] **Step 6.2（需要用户配合）**：加载新 build/ 扩展，在原问题页
  （http://172.16.52.168/v/manager/micro，含 bpmn 画布）重录同类操作，导出 zip 用
  `npx playwright show-trace <zip>` 或 trace.playwright.dev 打开，人工确认：
  样式完整（外链 CSS/背景图/内联 url）、每个 action 有 after 状态、路由切换可见、
  画布拖拽/双击/右键可录、checkbox 单条且有点击红圈。
- [ ] **Step 6.3**：确认无误后按用户意愿提升 manifest 版本（如 0.2.1）并 `bash build.sh`。

## 验证摘要

- 每任务 TDD：先写 spec（断言引用官方 SnapshotStorage/JSONL 结构）确认失败 → 实现 →
  `bash build.sh` → `cd tests && npx playwright test e2e/<spec>` 通过 → 回归相邻 spec → 提交。
- 端到端资源命中由 `buildResourceOracle` 保证与 viewer `serveResource` 同一实现路径。
- 已知行为变更（有意）：`metadata.pages[0].url` 为最终 URL；双击记为首击 click+dblclick 两条；
  checkbox/radio 不再产出 input/change 动作。
- 已知残留（本次不修，提交说明注明）：CSS-in-JS 动态插入的 adoptedStyleSheet/CSSOM
  文本中的相对 url() 已随 STYLE 文本绝对化覆盖，但跨快照引用节点（back-reference）指向的
  历史文本不回溯改写（与官方一致）；字体资源若录制期未发生真实请求仍无 body。
