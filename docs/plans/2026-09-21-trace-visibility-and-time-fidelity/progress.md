# Progress Log

## 2026-09-21 — 全部缺陷修复完成

### 目标
修复 trace 在官方 viewer 中「元素看不见」+「录制效果不符」的全部自研缺陷，并建立客观判据。

### 完成情况

| 项 | 状态 | 证据 |
|----|------|------|
| D8 自检工具扩展 | ✅ | 对旧 zip 报 **5 项红**、对新 zip **全绿** |
| D1 滚动标记 | ✅ | viewer 实测 `scrollTop=280`（=400−120）成功还原 |
| D2 canvas 包围盒 | ✅ | 10 处 `bounding_rect`（CANVAS + IFRAME） |
| D3 target / popover / dialog | ✅ | viewer 实测 `BUTTON#dialog-open` 带官方描边 `rgb(0,106,177) solid 2px` |
| D5 渲染中态 settle | ✅ | 真实时长 205–451ms；viewer 显示 407ms |
| D4 wallTime 绝对化 | ✅ | 18/18 绝对；帧配对 1→2 个不同帧 |
| D6 真实时长 | ✅ | 不再恒为 20ms |
| D7 DPR / 帧尺寸 | ✅ | 声明尺寸与实际 JPEG 像素一致 |

### 额外发现并修复的潜伏 bug（F1）

`fill` action 在 400ms 合并窗口内**占据 capture 槽位**，导致 `captureQueueDepth` 虚高，
使 burst 门限误判、剥夺后续 action 的 action 档快照。
→ 改为「仅在真正开始抓拍时才占槽位」，`fill-coalescing` 3/3 通过（修复前 3/3 失败）。

**注意**：该 bug 在原代码上也会触发（只要页面 DOM 足够大）。我最初误判为自己的
settle 改动引入的回归，通过「禁用 settle 仍失败」+「纯基线 3/3 通过」两步实验才定位到
真正变量是**测试 fixture 变大**。这是本次最有价值的一次自我纠错。

### 我自己引入并修复的错误（E1）

在注入的模板字符串的**注释里写了反引号**，提前终止字面量，导致 SW 抛
`SyntaxError: Unexpected identifier 'timestamp'`，整个 `buildDomSnapshotExpr` 失效。
`node --check` 检查不出（截断后仍是合法表达式）。
→ 修复并新增 `tools/check-injected-exprs.mjs` 静态门禁，已验证它能抓到这个具体 bug。

### 测试结果

- 全量 e2e：**11 passed**（2.1m）
- `tools/inspect-trace.mjs`：新产物全绿
- 官方 viewer `show-trace`（localhost:8907）人工/程序化双重验证

### 已知未修（超出本次范围，已记录）

- 画布在「开启 populate canvas from screenshot」前不显示内容 —— 官方默认行为
  （`shouldPopulateCanvasFromScreenshot` 默认 false）。修复后开关可用。
- 第三方扩展注入的 `#atv-styles` 无法与页面自有样式可靠区分 —— 加过滤有误删风险，不加。
