# Trace 可见性 + 时间语义保真修复 — 实施计划

## Goal

修复 trace 在官方 viewer 中「元素看不见」与「录制效果与页面不符」的全部**自研缺陷**，
并为每一项建立**客观可复现的判据**（自检工具 + e2e），使 `tools/inspect-trace.mjs`
能从「全部通过」变为能真正发现这类问题。

约束：
- 不修改官方 viewer / playwright-core 语义（只对齐其契约）。
- 区分「官方固有行为」与「自研缺陷」，不修不属于我们的东西。
- 改动后必须 `bash build.sh`，e2e 从 `build/` 加载。

## 缺陷清单（经源码交叉验证）

| ID | 缺陷 | 位置 | 级别 |
|----|------|------|------|
| D1 | 不写 `__playwright_scroll_top_/_left_`，viewer 无法还原滚动位置 → 折叠在可视区外的内容「看不见」 | `src/service_worker.js` 序列化器 | P0 |
| D2 | CANVAS/IFRAME/FRAME 不写 `__playwright_bounding_rect_` → 即便开启 `shouldPopulateCanvasFromScreenshot`，viewer `continue` 跳过绘制，画布**永远**回填不出来 | 同上 | P0 |
| D3 | 不写 `__playwright_target__`（被点元素红框）与 popover/dialog 开启态 | 同上 | P1 |
| D4 | `frame-snapshot.wallTime` 写成相对 ms（官方为绝对 epoch）→ 18 个快照全部 `findClosest` 到第 1 个 screencast 帧 | `src/traceGeneratorExtension.js` | P0 |
| D5 | action 档快照**同步抓拍、无 settle**，抓到 SPA 渲染中态；而 viewer 默认展示 Action 档 → 「与页面不符」 | `src/service_worker.js` `recordAction` | P0 |
| D6 | action 时长硬编码 `endTime = startTime + 20` | 同上 | P1 |
| D7 | `metadata.deviceScaleFactor` 恒为 1（真实 DPR=2）；screencast 声明 1054×714 而实际 2108×1428 | `src/traceGeneratorExtension.js` / `src/service_worker.js` | P2 |
| D8 | `tools/inspect-trace.mjs` 只校验样式表截断与反向引用，对 D1–D7 **全盲** | `tools/inspect-trace.mjs` | P1 |
| F1 | `fill` action 在 400ms 合并窗口内**空占** capture 槽位 → `captureQueueDepth` 虚高 → burst 门限误判，剥夺后续 action 的 action 档快照（**潜伏 bug，原代码亦存在**） | `src/service_worker.js` `enqueueAction`/`recordFillAction` | P0 |

## 已修正的**非**缺陷（原分析有误，不修）

- **C1**「快照 STYLE 47 个 = 扩展注入污染」**错误**：47 个里 46 个是页面自有
  （sonner / emotion-antd / vaul），仅 `#atv-styles` 属**第三方**扩展（非本项目，repo 内
  无此标识），且无法可靠区分「页面自有」与「第三方注入」。→ 仅记录，不加过滤（避免误删页面样式）。
- **C2** 画布空白本身**部分是官方行为**：`shouldPopulateCanvasFromScreenshot` 默认 false；
  且该 trace 录制时真实页面也是骨架屏。D2 才是真正的自研缺陷（开关打开也回填不了）。

## 阶段

### P0 建立判据（先能度量，再改代码）
- [ ] 扩展 `tools/inspect-trace.mjs`：对 D1–D7 逐项输出 ✅/❌ 并给出计数
- [ ] e2e fixture 补齐：可滚动容器、canvas、popover/dialog、滚动后交互场景
- [ ] 用**现有** zip 跑一次 → 确认新自检**能红**（RED 证据）

### P1 快照标记完整性（D1/D2/D3）
- [ ] 序列化器补 `scrollTop/scrollLeft`（仅非 0 时写，对齐官方）
- [ ] 序列化器补 CANVAS/IFRAME/FRAME `boundingRect`
- [ ] 补 popover/dialog 开启态
- [ ] action 档给目标元素打 `__playwright_target__ = callId`

### P2 时间语义（D4/D6/D7）
- [ ] `frame-snapshot.wallTime` 改绝对（`timestamp` 保持相对）
- [ ] action 时长改真实耗时
- [ ] 记录真实 DPR；`metadata.deviceScaleFactor` 用真实值；screencast 尺寸按设备像素缩放

### P3 渲染中态（D5）
- [ ] 页内 MutationObserver + rAF 静默等待（有上限），用于 action / after 两档抓拍

### P4 验证
- [ ] `bash build.sh`
- [ ] `tools/inspect-trace.mjs` 对新产物全绿
- [ ] 新 e2e spec 通过；全量 8+ spec 回归通过
- [ ] 官方 viewer 实测：滚动位置还原、canvas 可回填、快照↔截屏帧一一对应

## 退出判据

1. 新自检对**旧** zip 至少 5 项报红、对**新** zip 全绿；
2. 全量 e2e 通过；
3. viewer 中滚动容器内容可见、Action 档不再显示过渡态。

## 设计原则（skill: coding-principles）

- 一处改动服务多个缺陷（DPR 同时供 metadata 与 screencast 尺寸），避免重复。
- 不引入新依赖；序列化器内仅用标准 DOM API。
- 仅在非零/必要时写属性，避免快照体积膨胀。
