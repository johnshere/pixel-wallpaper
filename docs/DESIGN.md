# pixel-wallpaper · 设计文档

- 版本：0.1.0-alpha.2
- 日期：2026-11-19
- 目标宿主：DSH（DeepSeek Harness）Web，`dsh >= 0.2.2-rc.3`（强制）
- 仓库：`johnshere/pixel-wallpaper`

## 1. 一句话

在 DSH Web 的整个窗口底层，铺一层由算法实时生成的灰白像素格背景；唯一入口是设置页里的「像素背景」一节。

## 2. 形态与边界

- **是**：DSH client 插件（浏览器侧画布 + 设置页）＋ 宿主侧一个配置读写端点。
- **不是**：独立站点、Vite 页面、命令行工具、图片导入器。
- **不做**：导出 PNG、URL 状态、分享、独立预览页、命令。
- **不碰宿主**：不重写布局、配色、交互；只注入一块固定画布和「让底层透出来」的最小样式。顶栏、左栏、侧栏、输入区保持悬浮原样。
- 图片 tab **已隐藏，代码保留**（占位文案、`imageTab`、`tab/setTab` 分支都不删；`SHOW_TABS` 改回 `true` 即恢复）。不实现上传与抽样。

## 3. 技术栈与目录

- 纯 CommonJS（宿主侧）+ 浏览器侧 CommonJS 源码；React 由宿主以 `require('react')` 提供。零运行时依赖、零打包器。
- 客户端 `client/index.js` 由 `scripts/build.mjs` 包成 `client/bundle.js`（`window.__ModuleLoader__.load({ id, factory })`），并从客户端注册表生成 `src/algorithm-schemas.js`；两个生成物都入库，源码改后必须重跑 `npm run build`（或 `npm run build -- --assets`）。
- 样式全部由插件自己注入 `<style>`，类名前缀 `pw-`；不改宿主的 CSS Module 类名。

```
package.json
cordis.patch.yml          # bundle patch：insert 宿主插件
src/index.js              # 宿主：cordis 插件 + /pixel-wallpaper/api
src/config.js             # 默认值、校验、原子读写 config.json
src/algorithm-schemas.js  # 由 scripts/build.mjs 从客户端注册表生成
scripts/build.mjs         # client/index.js -> client/bundle.js；--assets 只刷生成物
client/index.js           # 浏览器侧：画布、渲染、算法、设置页（不发布）
client/bundle.js          # 构建产物（发布）
test/*.test.mjs           # node --test：网格/调色板/算法/渲染/DPR/生命周期/发布清单
.github/workflows/ci.yml  # Node 22/24 matrix，跑测试、检查、构建与生成物 diff
docs/DESIGN.md            # 本文档
README.md                 # 安装/升级/卸载/排错/隐私/兼容性
CHANGELOG.md
LICENSE                   # MIT, Copyright (c) 2026 johnshere
```

package.json 关键字段：

```json
{
  "name": "dsh-pixel-wallpaper",
  "version": "0.1.0-alpha.2",
  "main": "src/index.js",
  "type": "commonjs",
  "exports": {
    ".": "./src/index.js",
    "./client": "./client/bundle.js",
    "./package.json": "./package.json"
  },
  "engines": { "node": ">=22.5", "dsh": ">=0.2.2-rc.3" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "files": [
    "src/index.js",
    "src/config.js",
    "src/algorithm-schemas.js",
    "client/bundle.js",
    "cordis.patch.yml",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ],
  "publishConfig": { "access": "public", "tag": "alpha", "registry": "https://registry.npmjs.org/" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "prepack": "node scripts/build.mjs --assets",
    "check": "node --check src/index.js && node --check client/bundle.js",
    "test": "node --test \"test/*.test.mjs\""
  }
}
```

- npm 发布的是**仓库根包**，`files` 白名单只含运行时文件；`client/index.js` 源码、`scripts/`、`test/`、`docs/` 都不进 tarball。
- `npm run build` 仍额外生成 E: 自包含目录（`lib/index.js` + `client/bundle.js`），只用于本地 link 调试，不是发布内容。
- `engines.dsh` 由宿主 app-boot 在导入前强制校验；低于 `0.2.2-rc.3` 的 DSH 会拒绝加载，不要改成 `^` 或加上限。

`cordis.patch.yml` 只做一件事：

```yaml
- insert:
    - id: pixel-wallpaper
      name: dsh-pixel-wallpaper
```

## 4. 视觉基调

- 默认纯灰阶、低饱和、无彩色；格与格之间露出底色，默认 `#141414`，格子最亮 `#c9c9c9`。
- 无渐变、无阴影、无毛玻璃；设置页沿用 DSH 的暗色控件风格，插件只补少量排版样式。
- 背景是「低亮度、低对比」的底层纹理：文字区域之上永远压着宿主自己的面板，不抢阅读。
- 宿主面板靠 CSS 变量透底：`html body[...]` 上覆盖 `--dsw-alias-bg-base`、`--dsw-specific-sidebar-fill`、`--dsw-specific-bubble`（用户消息气泡）为 `transparent !important`；提高选择器优先级以避免主题样式后注入覆盖，且不用运行时写 inline style。

## 5. 网格几何（核心）

### 5.1 单位与画布

- 一切几何以**设备像素**计算：`dpr = window.devicePixelRatio`，`W_dev = round(innerWidth * dpr)`，`H_dev = round(innerHeight * dpr)`。
- 画布 backing store 设为 `W_dev × H_dev`，CSS 尺寸 100%；绘制坐标用**亚像素**（可为小数），由浏览器抗锯齿平滑，不再取整到设备像素栅格。
- 用户可见的「格宽 / 间隔」以 CSS px 展示与保存；内部换算 `cell = cellWidthCss * dpr`、`gap = gapCss * dpr`，**不取整**（5px@1.25 → 6.25），以保留亚像素倍率。
- 这样同一屏幕上改变窗口宽度时，格子 CSS 尺寸不变；但 CSS px 的物理大小仍由屏幕 PPI 与系统缩放决定，跨设备不保证等大（要物理等大只能校准）。浏览器缩放会改变 dpr，格子的 CSS 尺寸仍按配置值，但物理像素数随 dpr 变。

### 5.2 固定 CSS 像素格宽

网格不再有「自动/手动」模式，只有两个用户值：格宽 `cellWidth`（CSS px，默认 5）与间隔 `gap`（CSS px，默认 0.8）。

```
c   = cellWidthCss * dpr        # 不取整：5px@1.25 → 6.25
g   = gapCss * dpr
n   = max(1, round(W_dev / (c + g)))
while n > 1 && n * c + (n - 1) * g > W_dev: n -= 1
m   = max(1, round(H_dev / (c + g)))
while m > 1 && m * c + (m - 1) * g > H_dev: m -= 1
g_x = n > 1 ? (W_dev - n * c) / (n - 1) : 0
g_y = m > 1 ? (H_dev - m * c) / (m - 1) : 0
```

- 先按「格 + 缝」步距反算列数，再递减直到总宽不越界；`g_x/g_y` 是解出的实际缝（可能略大于配置值），保证首格贴 0、末格贴边。
- 格宽与间隔都不取整，Windows 125% / 150% 缩放下 `c / dpr` 恒等于配置值，格子 CSS 尺寸不随窗口变化；物理尺寸仍取决于 PPI/系统缩放。
- 不做「两向间隔近似」重选，也不再有目标列数与窄窗保护；窄窗自然只剩 1–2 列。
- `g = 0` 时余量自然摊成亚像素缝，不需要无缝分支。

### 5.3 定位

定位一律用亚像素坐标（见 5.4），`g_x/g_y` 是实数。

- 横向 `n` 列、纵向 `m` 行各自独立求解，格子始终是正方形 `c × c`。
- `n = 1` 时格宽取 `min(c, W_dev)`（不越界），不再铺满整宽；`m = 1` 同理。

### 5.4 亚像素定位（贴边、不切格、缝隙恒定）

`n > 1` 时：

```
step = (W_dev - c) / (n - 1)
x_i  = i * step                             i = 0..n-1
每格宽 = c
```

纵向同理（用 `H_dev`、`m`、`y_i`）。`n = 1` 时格宽取 `min(c, W_dev)`；`m = 1` 同理。

性质：`n > 1` 时首格贴左/上边缘，末格右缘正好 `W_dev`，相邻缝恒等于 `step - c = (W_dev - n*c)/(n-1)`；`n = 1` 时只保留一个 `min(c, W_dev)` 的格子，贴左上，不铺满整宽。**不再出现 0/1 交替**（旧实现用 `round` 取整，`g_x < 1` 时缝被量化成 0 或 1，表现为「有的格有缝、有的没有」）。

代价是格子边缘落在半像素上、边缘略软；配合 90% 透明度与低对比色板，肉眼不可见。若需要绝对锐利，可整帧先按 `2x` 绘制再缩半（未实现，暂不需要）。

### 5.6 渲染循环健壮性（防冻结）

- `loop` 用 `try/catch` 包裹单帧：任何一帧抛错只记一次 `console.warn`（5s 节流）并继续排下一帧，不再让 `requestAnimationFrame` 断链。
- 连续 3 帧出错时重建算法实例（自愈）；`field` 长度与 `cols*rows` 不符也重建。
- 看门狗：`setInterval` 每秒检查一次，播放中且页面可见、但 1.5s 没收到 `rAF` 回调时，取消旧帧并重启动画链。
- 监听 canvas 的 `contextlost` / `contextrestored`：恢复时重设 backing store 并重启循环。
- 绘制时值非有限数（NaN/Infinity）按 0 处理，避免非法 `fillStyle` 静默吞掉整帧。

### 5.5 变化响应

- `resize`、`dpr` 变化：保留 `cellWidthCss/gapCss`，重算 `n/m/g_x/g_y`；格宽按 CSS px 固定，窗口变宽只增减列数。
- 用 `ResizeObserver` 观察 `document.documentElement`（缺失时不影响 DPR 监听：两者分在独立的 try 里）。
- DPR 监听**按当前 dpr 精确绑定并动态重绑**：`matchMedia('(resolution: <当前 dpr>dppx)')`，change 后比较 `devicePixelRatio`，变了就重新绑定并重算。因此 `1.25 → 1.5` 这类非 1x 之间的缩放变化也会触发（旧实现只监听 1dppx，会漏掉）。
- `window resize` 作为兜底：部分浏览器切换缩放/跨屏只派发 resize，不派发 media change；resize 时若 dpr 变了同样重绑 + 重算。
- 不使用轮询定时器。重算优先用 live 配置，启动早期 GET 未返回时用初始配置。
- 网格尺寸变化一律**重建算法实例**（从种子重新播种）。亮场是算法实例内部的数组：把 `instance.field` 换成重采样快照，算法仍写自己的数组，绘制就会永远停在那张快照上（画面静止、rAF 照跑，且无报错）。

## 6. 亮度 → 像素

对每个格子的亮度 `v ∈ [0,1]`（行优先 `field[row * cols + col]`）：

```
v = clamp((v - black/100) / (white/100 - black/100), 0, 1)
v = pow(v, gamma)
v += ditherOffset(col, row)          # 抖动：无 / Bayer4 / 误差扩散
level = round(v * (levels - 1))      # 0..levels-1
color = paletteAt(level / (levels - 1))
```

- **调色板**：一组由暗到亮的色标（2–8 个十六进制颜色），默认 `["#1b1b1b", "#c9c9c9"]`；按段线性插值取色（sRGB 空间）。`levels` 与色标数量无关。
- **形状**：方形（`fillRect`）／圆角（半径 = 边长 × 28%）／圆点（`arc`）。
- **透明度**：`render.transparency`（0–100，默认 90）；格子颜色朝底色混合 `k = 1 - t/100`，视觉等同整层 10% 不透明，画布本身仍不透明。
- **缝**：不画格子；每帧画完格子后用底色重铺，视觉上仍是 canvas 底色（默认 `#141414`，可配）。
- **抖动**：Bayer 4×4 用 `(bayer/16 - 0.5) / levels` 作偏移；误差扩散用 Floyd–Steinberg，误差只在当前帧内传播。
- 整帧重画（首帧 / 网格 / 渲染配置变化 / floyd）先铺底色，再画格子；每帧画完格子后都用底色重铺所有列缝/行缝（冲掉边缘抗锯齿溢出），其余帧只重画色阶变化的格子，底色与未变格子保留。
- 每个色阶的最终颜色（调色板 + 透明度 + 底色）预计算为 LUT；和底色完全相同的色阶在整帧重画时跳过。
- 被「影响范围」关掉的矩形最后 `clearRect`（透明，露出宿主底层）。

## 7. 六支算法

统一接口（浏览器侧，纯 JS）：

```js
create({ cols, rows, seed, params }) -> {
  field: Float32Array,   // 长度 cols*rows，值域 0..1
  step(dt)               // 推进一帧；静态算法可空实现
}
```

- `field` 必须就是 `step()` 内部原地写入的那个数组（同一引用）；渲染器只读它，绝不替换。需要换尺寸时重建实例。
- 随机源只用种子派生的 `mulberry32`；禁止 `Math.random()`（骰子按钮除外）。
- 注册表：`registerAlgorithm(def)`，重复 id 报错；模块加载时注册六支。为将来外部算法预留。
- 参数 schema：`{ key, label, type: 'range'|'select', min, max, step, default, options?, format? }`；设置页据此自动生成二级参数，禁止为单支算法硬编码面板。

| id | 名称 | 参数（默认） | 实现要点 |
|---|---|---|---|
| boids | 鸟群 | `agents` 60–200 (100)、`separation` 0–4 (1.2)、`alignment` 0–2 (0.7)、`cohesion` 0–3 (1)、`speed` 0.4–2.4 (0.8)、`trail` 0.90–0.995 (0.98) | 分离/对齐/聚合三权重均可调；环形边界；空间哈希邻域半径 12 格；每鸟速度在基准的 0.6–1.4 倍间随机（基准 = speed × 15 格/秒，可互相追赶/逃离）；每步 3×3 核打点（中心 .55、四邻 .18、对角 .06）；按 trail 衰减后归一化 |
| flow | 流场 | `particles` 300–3000 (500)、`scale` 0.6–6 (1.8)、`trail` 0.90–0.995 (0.975) | 粒子沿 fBm 噪声旋度场推进，环形边界；每步累积亮度并衰减；场随时间缓慢漂移；必须呈丝状，不能是均匀噪点 |
| reaction | 反应扩散 | `feed` 0.010–0.080 (0.0367)、`kill` 0.040–0.070 (0.0649)、`steps` 1–12 (4) | Gray-Scott，`Du=.16 Dv=.08 dt=1`，9 点拉普拉斯，wrap；初始 10% 斑点；渲染取 B 通道对数归一化；模拟网格超 240 列时先降采样再最近邻放大 |
| noise | 噪声场 | `scale` 0.6–8 (2.2)、`octaves` 2–6 (4)、`warp` 0–1 (0.35)、`drift` 0–1 (0.15) | 值噪声 fBm + 域扭曲；drift 让场随时间平移；默认高阈值三次曲线，主体暗底、亮部少 |
| waves | 波干涉 | `sources` 2–12 (5)、`freq` 0.5–6 (2.2)、`speed` 0–2 (0.8)、`decay` 0–1 (0.3) | 多随机波源 `sin(dist*freq - t*speed)` 叠加，按距离衰减后归一化；莫尔纹/水波 |
| attractor | 奇异吸引子 | `type` select Clifford/De Jong (Clifford)、`a`/`b`/`c`/`d` 各 −3–3（Clifford: −1.4/1.6/1.0/0.7；De Jong: 1.4/−2.3/2.4/−2.1）、`points` 500–6000 (2500) | 点云累加密度图，每帧淡出 2%；对数归一化；切 type 重跑 |

- 场尺寸 = 当前 `cols × rows`；算法不感知像素尺寸、缝隙、形状、调色板。
- 默认算法 `boids`；切换算法保留通用配置与种子。

## 8. 配置模型

存储：`$DSH_HOME/pixel-wallpaper/config.json`（宿主侧原子写）。默认值即首次安装值。

```json
{
  "version": 4,
  "coverage": { "header": true, "left": true, "right": true, "input": false },
  "grid": { "cellWidth": 5, "gap": 0.8 },
  "render": {
    "shape": "square",
    "levels": 8,
    "palette": ["#1b1b1b", "#c9c9c9"],
    "gamma": 1.0,
    "black": 0,
    "white": 100,
    "dither": "none",
    "background": "#141414",
    "transparency": 90
  },
  "animation": { "playing": true, "speed": 1 },
  "algorithm": { "id": "boids", "seed": 1337, "params": {} }
}
```

校验（宿主与前端各做一次，非法值 clamp/回退，不抛错）：

| 字段 | 范围 |
|---|---|
| cellWidth / gap | 3–20 / 0–8 CSS px（默认 5 / 0.8；缺失或非有限数回退默认） |
| levels | 2–16 |
| palette | 2–8 个合法 `#rrggbb`；不足回退默认 |
| gamma | 0.4–2.0 |
| black / white | 0–30 / 70–100，且 black < white |
| dither | none / bayer4 / floyd |
| shape | square / rounded / dot |
| speed | 0.25–2 |
| seed | 0–999999 整数 |
| algorithm.id | 六选一 |
| params | 按该算法 schema clamp，未知键丢弃 |

## 9. 设置页

在 DSH 设置里新增一节，导航名为「像素背景」，`order` 取一个不与现有项冲突的值（如 96），组件整体用 try/catch 包住。

结构：

```
像素背景
├─ 背景范围
│   顶栏 [开关]  左栏 [开关]  侧栏 [开关]  输入区 [开关]
├─ 插件通用配置（两列排布）
│   网格   格宽（CSS px）/ 间隔（CSS px）  当前 331 × 186 格 · 5.0px / 0.8px 间隔
│   外观   形状 / 层数 / gamma / 黑场 / 白场 / 抖动 / 透明度
│   色值   调色板 + 底色
└─ 算法内容（tab 条已隐藏）
    算法下拉（名称 — 描述）/ 播放暂停 · 速度 / 种子 / 二级参数
```

行为：

- 分组：**插件通用配置**（网格、外观、色值/底色）在背景范围与算法内容之间。
- 插件通用：网格（格宽/间隔两个数字输入框，CSS px）；外观（形状/层数/gamma/黑场/白场/抖动/透明度）；色值（调色板 + 底色）。
- 算法内容：算法下拉（每项「名称 — 描述」）、播放/暂停、速度、种子、二级参数（按 schema 生成）。
- 「算法 / 图片」tab 条默认整条隐藏（`SHOW_TABS = false`），直接显示算法内容；`tab` state、`setTab`、`imageTab` 与分支代码保留，改常量即可恢复。
- 任何已提交的改动即时作用到画布（本地状态），立即 `PUT /pixel-wallpaper/api/config`（串行，不并发乱序）；保存失败提示但不回滚画面。
- 算法 id、种子、二级参数、网格尺寸任一变化都重建算法实例并重绘（参数与 `cols/rows` 在 `create` 时读取）；不做跨尺寸重采样。
- 插件通用配置两列排布：`.pw-fields` 用 `grid-template-columns:1fr 1fr`，字段不足两列时自然留空。
- 「影响范围」四个开关：开 = 背景延伸进该区域；关 = 该矩形不绘制（露出宿主底色）。默认顶栏/左栏/侧栏开，输入区关。
- 数字输入框（格宽、间隔、种子、透明度等）都在失焦或回车后提交：输入过程只改本地草稿；空值/非法值回退当前值，超范围 clamp；Escape 回退。避免每敲一个字符就重建算法、闪烁。
- 只读行显示当前列×行、实际格宽与横向间隔（CSS px，一位小数）。
- 图片 tab 已隐藏、代码保留：占位文案「图片」「预留：把任意图片抽样为同一套单元格亮度场」仍在，无上传控件、无逻辑。
- 开关与控件沿用 DSH 的暗色风格；插件只补 `pw-` 前缀样式。
- 保存结构里不写运行时计算值（cols/rows/g_x/g_y 不落盘）。

## 10. 影响范围与区域测量

- 画布固定在 `position: fixed; inset: 0; pointer-events: none; z-index: -1`（垫在内容之下），作为 `body` 第一个子节点；宿主内容自然盖在它上面。
- 让底层透出：只用 CSS，不改宿主 DOM 的 inline style（避免 React 重渲染后失效）。基础规则把 `html/body` 设为透明，并把 DSH 设计 token `--dsw-alias-bg-base`、`--dsw-specific-sidebar-fill` 在 `body`、`body[data-ds-dark-theme]`、`body[data-ds-light-theme]` 上覆盖为 `transparent !important`；面板与弹层仍走 elevated token，保持不透明可读。
- 区域矩形在 `resize`/DOM 变化后 300ms debounce 重测（最后一次变化后重测，避免连续拖拽时抖动）；取候选元素的 `getBoundingClientRect()`：
  - 顶栏：`header` 或带 `topBar` 后缀的稳定类名；
  - 左栏：最左侧 `aside`/`nav`（含会话列表）；
  - 侧栏：右侧 `aside`（如 dsh-better-sidebar）；
  - 输入区：composer 容器（`textarea` 向上找最近的固定/粘性容器）。
- 任一区域量不到：该开关视为无效（不遮），并在设置页该行显示「未识别」；绝不因此隐藏整个背景。
- 开关关闭时只对矩形做 `clearRect`，不改变宿主布局与配色。
- 矩形统一外扩 2 CSS px，避免边缘漏一条。

## 11. 宿主侧

`src/index.js`：

```js
module.exports = {
  name: 'pixel-wallpaper',
  inject: [],
  apply(ctx) { /* 注册 webServer 路由 */ }
}
```

- 路由：`ctx.inject(['webServer'], webCtx => webServer.register({ kind: 'prefix', path: '/pixel-wallpaper/api', handler }))`，等 `webServer` 就绪再注册。
- `GET /pixel-wallpaper/api/config` → `{ config }`
- `PUT /pixel-wallpaper/api/config` → 校验后写盘，返回 `{ config }`
- 请求体上限 64KB；未知路径 404；错误统一 JSON，不抛到宿主。
- 配置读写：`src/config.js` 提供 `DEFAULT_CONFIG`、`sanitize()`、`readConfig()`、`writeConfig(patch)`；原子写（临时文件 + rename），损坏文件按默认值处理。
- 宿主侧不 import 任何 `@deepseek-ai/*` 包（link 安装时解析不到）。

## 12. 客户端侧

`client/index.js` 的 `apply(ctx)`：

1. `try { ... } catch` 整体兜住，任何失败只丢背景，不能白屏。
2. 注入画布与样式；启动渲染器。
3. `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'pixel-wallpaper', order: 96, label: () => '像素背景', inject: () => ({}) }, SettingsSection))`；若 `slots.inject` 不存在则退回 `ctx.effect`。
4. 监听 `pixel-wallpaper:config` 自定义事件（设置页保存后派发）即时应用；启动时 `GET` 一次配置。
5. 页面隐藏（`visibilitychange`）暂停动画；恢复时继续。
6. 动画：`requestAnimationFrame` + 固定步长累加器，目标 24fps；速度倍率作用于模拟步长，不改帧率；暂停时保留最后一帧。
7. 插件禁用/卸载（`ctx.effect` 的 cleanup）：移除画布、样式、事件监听、ResizeObserver 与动画；取消排队中的区域测量与 DPR 去抖重算。每次挂载生成独立 owner：`resetRendererState(owner)` 只复位属于该实例的 `rendererConfig`、`runtime.renderer/observer/owner/regions`；canvas、`<style>` 与 `onConfigSaved` 也只由对应 owner 清理，旧 cleanup 晚于新挂载执行时不会摘掉新实例的 DOM/样式或覆盖新回调。`trackConfig(renderer, owner)` 同时校验 `runtime.renderer === renderer`，旧实例迟到的 `GET`/resize/config 不会回写新 live 配置。新 mount 会先 destroy 上一个 renderer，避免重叠挂载时两套动画同画一块画布；destroy 幂等。即使 `startRenderer` 启动失败，也会在 `apply` 的 cleanup 里清一次。

## 13. 构建、安装、自检

构建：

```
npm run build                    # 生成两个入库生成物，并输出 E: 自包含目录
npm run build -- --assets        # 只刷新 client/bundle.js + src/algorithm-schemas.js
npm run check                    # node --check 两个入口
npm test                         # 全部 node --test（含 DPR / 生命周期 / 发布清单）
npm pack --dry-run --ignore-scripts  # 检查 npm tarball 文件集
```

发布：

1. 根包即 npm 发布内容（`files` 白名单），不是 E: 自包含目录；
2. `prepack` 先跑 `node scripts/build.mjs --assets`，生成物过期会被 CI 的 `git diff --exit-code` 拦住；
3. `npm publish` 带 `publishConfig.tag=alpha`，并按 `publishConfig.registry` 固定发到 npmjs（本机 install registry 可仍是镜像）；需维护者已在 npmjs `npm login`；子代理不发布。当前 npm 账号不可用，Alpha 先以 GitHub tag `v0.1.0-alpha.2` 分发（`dsh plugin ... add github:johnshere/pixel-wallpaper#v0.1.0-alpha.2`），npm 包待账号恢复后补发。

安装（用户侧）：

- GitHub tag（当前 Alpha）：`dsh plugin --profile web add github:johnshere/pixel-wallpaper#v0.1.0-alpha.2`，在 `dsh.profile.bundles` 加入包名，重启 DSH；
- npm alpha（补发后）：`dsh plugin --profile web add dsh-pixel-wallpaper@alpha` 后在 `dsh.profile.bundles` 加入包名，重启 DSH；
- 本地 link 调试：web profile 的 dependencies 增加 `"dsh-pixel-wallpaper": "link:<Windows 盘符路径>"`，`bundles` 加入包名，profile 目录 `pnpm install`，刷新页面/重启 DSH。

自检（执行者必须跑）：

1. `npm test && npm run check && npm run build` 全绿；`node scripts/build.mjs --assets` 可独立跑通。
2. 用 Node 直接 `require` 宿主侧模块，确认 `apply` 是函数、config 读写往返一致。
3. 网格几何单测覆盖：1920×1080@1 → 331×186、2560×1440 → 441×248、3440×1440 → 593×248；dpr 1.25 / 1.5 下 `cell/dpr === 5`；`computePositions` 首格 0、末格贴边、缝恒定、gap=0 亚像素缝、count=1 边界。
4. DPR 单测覆盖 1→1.25→1.5→1（含 1.25→1.5 原缺口）、resize 兜底、dispose 后不再触发。
5. 发布清单单测断言 `engines.dsh`、`main`、`files` 与 `npm pack --dry-run` 文件集。
6. 不执行任何 git 写操作；不安装到 profile；不重启 DSH。

## 14. 非目标（本期明确不做）

- 导入图片 / 图片抽样（tab 已隐藏，占位代码保留）。
- 导出 PNG、壁纸尺寸选择、URL 参数。
- 命令、快捷键、独立窗口。
- 多套主题、彩色方案、动画导出。
- 移动端布局适配（桌面 Web 优先，窄窗只保证不崩）。
