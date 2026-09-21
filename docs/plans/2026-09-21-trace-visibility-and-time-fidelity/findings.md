# Findings（本地源码交叉验证）

> 本文件存放证据。外部/网页内容只记于此。`task_plan.md` 不放外部内容。

## 官方契约（playwright-core 1.59.1，`tests/node_modules`）

`lib/server/trace/recorder/snapshotterInjected.js:360-425` 元素属性写入顺序：

```js
if (nodeName === "CANVAS" || nodeName === "IFRAME" || nodeName === "FRAME") {
  const r = element.getBoundingClientRect();
  attrs[kBoundingRectAttribute] = JSON.stringify({left:r.left,top:r.top,right:r.right,bottom:r.bottom});
}
if (element.popover && element.matches && element.matches(":popover-open")) attrs[kPopoverOpenAttribute] = "true";
if (nodeName === "DIALOG" && element.open) attrs[kDialogOpenAttribute] = element.matches(":modal") ? "modal" : "true";
if (element.scrollTop)  attrs[kScrollTopAttribute]  = "" + element.scrollTop;
if (element.scrollLeft) attrs[kScrollLeftAttribute] = "" + element.scrollLeft;
if ("__playwright_target__" in element) attrs[kTargetAttribute] = element["__playwright_target__"];
```

消费端（`lib/utils/isomorphic/trace/snapshotRenderer.js`）：
- `:305-312` load 时 `element.scrollTop = +getAttribute("__playwright_scroll_top_")`
- `:375-380` `if (!boundingRectAttribute) continue;` ← **无 bbox 直接跳过画布回填**
- `:246-247` `querySelectorAll('[__playwright_target__="${callId}"]')` 画红框；callId 取自快照行自身
- `:60` `closestScreenshot()`：`wallTime && frames[0].frameSwapWallTime ? findClosest(frameSwapWallTime, wallTime) : findClosest(timestamp, timestamp)`

`lib/server/trace/recorder/tracing.js:507` screencast 行：
`width: params.viewportWidth, height: params.viewportHeight, timestamp: monotonicTime(), frameSwapWallTime: params.frameSwapWallTime`

`lib/server/screencast.js:_startScreencast` 默认缩放到 `min(1, 800/max(vw,vh))` → 与自研 `inscribe(...,{800,600})` 同构。

`deviceScaleFactor` 在 viewer 中的**唯一**消费者是设置页展示行
（`assets/defaultSettingsView-*.js`：`device scale:` 文本），**不参与渲染几何**。

## 本 trace 实测（`/Users/yf/Downloads/Recording 10_59_39.zip`）

| 项 | 值 |
|----|----|
| frame-snapshot 行 | 18（before 1 / action 6 / after 11） |
| `__playwright_scroll_top_` / `scroll_left_` | **0** / **0** |
| `__playwright_bounding_rect_` | **0** |
| `__playwright_target__` | **0** |
| screencast 帧 | 6（唯一 sha1） |
| viewport / metadata DSF | 1054×714 / **1** |
| 实际 JPEG 像素 | **2108×1428**（DPR=2） |
| STYLE 节点 | 47，其中 46 页面自有 + 1 第三方扩展 `#atv-styles` |
| 反向引用悬空 | 0（14010 处引用全解析） |

滚动裁剪实证：主内容区 `clientHeight=590 / scrollHeight=1114`（**524px 被裁**，`scrollTop=0`）；
手动置 `scrollTop=524` 后「调用趋势 / 调用次数分布 / 调用次数排行 / 总计：1,049」全部出现。

画布实证：`visactor_window_2/3` 两个 canvas，`display` 正常、尺寸 788×368、`nonBlankPixels=0`、
`__playwright_bounding_rect__ = null`。

## 三档状态表（Issue 1 根因）

action 档抓拍于渲染中态，150ms 后的 after 档才是稳定的：

| callId 尾号 | before | action | after |
|-------------|--------|--------|-------|
| …2230 | DATA | **空** | DATA |
| …3519 | DATA | **空** | **空** |
| …4378 | **空** | DATA | DATA |
| …5266 | DATA | DATA | DATA |
| …5930 | DATA | DATA | DATA |
| …6559 | DATA | loading | DATA |

官方 viewer 默认停在 **Action** 档 → 用户看到的就是那张过渡态。

## 两次自我纠错

1. 「STYLE 47 = 扩展注入污染」**错**：逐节点回溯祖先链后，46/47 为页面自有样式
   （sonner / emotion `data-emotion=acss` / vaul / antd），仅 `#atv-styles` 为第三方扩展注入；
   `grep -rn "atv-styles" src/ build/` 为空 → **非本项目**。且无法可靠判定「谁注入」，
   加过滤会误删页面样式。→ 放弃该项修复。
2. 「祖先 `overflow:hidden` 裁剪」检测出的 5 处命中（模型调用分析/分流/偏好设置/筛选）
   在录屏帧中明明可见，判定不准 → 已剔除，不作为结论。

## 工具环境（已验证）

- `bash build.sh` → `build/`（`build/` 已 gitignore），`diff -rq src build/src` 一致
- `cd tests && ./node_modules/.bin/playwright test e2e/<spec> --reporter=line` → 通过（13.2s）
  - 注意：macOS 无 `timeout` 命令
- Chromium 1217 已安装；`PW_CHROMIUM_ATTACH_TO_OTHER=1` 由 fixtures.ts 设置
