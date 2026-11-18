# pixel-wallpaper · 设计文档

- 版本：0.1（冻结）
- 日期：2026-11-17
- 目标宿主：DSH（DeepSeek Harness）Web，`dsh >= 0.2.2-rc.3`
- 仓库：`johnshere/pixel-wallpaper`（private）

## 1. 一句话

在 DSH Web 的整个窗口底层，铺一层由算法实时生成的灰白像素格背景；唯一入口是设置页里的「像素背景」一节。

## 2. 形态与边界

- **是**：DSH client 插件（浏览器侧画布 + 设置页）＋ 宿主侧一个配置读写端点。
- **不是**：独立站点、Vite 页面、命令行工具、图片导入器。
- **不做**：导出 PNG、URL 状态、分享、独立预览页、命令。
- **不碰宿主**：不重写布局、配色、交互；只注入一块固定画布和「让底层透出来」的最小样式。顶栏、左栏、侧栏、输入区保持悬浮原样。
- 图片 tab 只放占位文案，不实现上传与抽样。

## 3. 技术栈与目录

- 纯 CommonJS（宿主侧）+ 浏览器侧 CommonJS 源码；React 由宿主以 `require('react')` 提供。零运行时依赖、零打包器。
- 客户端 `client/index.js` 由 `scripts/build-client.mjs` 包成 `client/bundle.js`（`window.__ModuleLoader__.load({ id, factory })`），构建产物入库，源码改后必须重跑 `npm run build`。
- 样式全部由插件自己注入 `<style>`，类名前缀 `pw-`；不改宿主的 CSS Module 类名。

```
package.json
cordis.patch.yml          # bundle patch：insert 宿主插件
src/index.js              # 宿主：cordis 插件 + /pixel-wallpaper/api
src/config.js             # 默认值、校验、原子读写 config.json
scripts/build-client.mjs  # client/index.js -> client/bundle.js
client/index.js           # 浏览器侧：画布、渲染、算法、设置页
client/bundle.js          # 构建产物
test/grid.test.mjs        # 网格几何纯函数单测（node --test）
test/palette.test.mjs     # 调色板/量化单测
docs/DESIGN.md            # 本文档
README.md                 # 只有标题与三行命令，不写项目介绍
LICENSE                   # MIT, Copyright (c) 2026 johnshere
.gitignore
```

package.json 关键字段：

```json
{
  "name": "dsh-pixel-wallpaper",
  "version": "0.1.0",
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
  "files": ["src", "client", "cordis.patch.yml", "README.md", "LICENSE"],
  "scripts": {
    "build": "node scripts/build-client.mjs",
    "check": "node --check src/index.js && node --check client/bundle.js",
    "test": "node --test \"test/*.test.mjs\""
  }
}
```

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
- 用户可见的「单元格宽 / 间隔」以 CSS px 展示与保存；内部换算 `device = round(css * dpr)`。
- 这样 Windows 缩放、浏览器缩放、换屏都不会让格子物理尺寸漂移；缩放时格子物理大小不变（不跟随页面缩放）。

### 5.2 自动模式的初始计算（只跑一次，或点「重置为自动」）

```
W_dev, H_dev, dpr
N0 = 250                                  # 横向目标列数
若 W_dev / N0 < 5 * dpr:                   # 窄窗保护
    N0 = max(8, floor(W_dev / (5 * dpr)))
slot = W_dev / N0
g0   = max(1, round(slot * 0.12))          # 目标间隔 = 步距 12%
c    = max(2, slot - g0)                   # 单元格（正方形，宽=高；不取整）
n    = N0
g_x  = (W_dev - n * c) / (n - 1)           # 首格贴 0、末格贴右缘
m    = max(1, round(H_dev / (c + g_x)))    # 高度没有目标行数
g_y  = m > 1 ? (H_dev - m * c) / (m - 1) : g_x
```

- **两向间隔必须接近**：若 `|g_x - g_y| > max(0.5, 0.2 * min(g_x, g_y))`，在 `m-1 / m / m+1` 中重选，取 `|g_x-g_y|` 最小且 `g_y >= 0.5` 者；仍不满足则接受当前值。
- 兜底：`g_x < 0.5` 时 `n -= 1` 重解（`n >= 1`）；`g_y < 0.5` 时同理动 `m`。
- `c` 是正方形边长；横向、纵向各自解出自己的间隔，不强行相等。
- 极端窄窗下 `n` 可以小于 250，这是预期行为。

### 5.3 手动模式

用户一旦手动改「单元格宽」或「间隔」，进入手动模式：

```
c   = max(2, round(cellWidthCss * dpr))
g   = max(0, round(gapCss * dpr))
n   = max(1, round(W_dev / (c + g)))
m   = max(1, round(H_dev / (c + g)))
g_x = n > 1 ? (W_dev - n * c) / (n - 1) : 0
g_y = m > 1 ? (H_dev - m * c) / (m - 1) : 0
```

- 不再按 N0 反推，也不做比例缩放；用户的值就是基准。
- 定位一律用亚像素坐标（见 5.4），间隔 `g_x/g_y` 是解出来的实数，不再取整。
- `g = 0` 时无缝：`n = max(1, floor(W_dev / c))`，把余量按浮点均摊进单元格宽度（每格 `W_dev/n`），行同理；`g_x = g_y = 0`。
- 两向间隔阈值同 5.2；必要时 `n`、`m` 各 ±1 重解。

### 5.4 亚像素定位（贴边、不切格、缝隙恒定）

`n > 1` 时：

```
step = (W_dev - c) / (n - 1)
x_i  = i * step                             i = 0..n-1
每格宽 = c
```

纵向同理（用 `H_dev`、`m`、`y_i`）。`n = 1` 时单元格铺满整宽；`m = 1` 铺满整高。

性质：首格贴左/上边缘，末格右缘正好 `W_dev`；相邻缝恒等于 `step - c = (W_dev - n*c)/(n-1)`，**不再出现 0/1 交替**（旧实现用 `round` 取整，`g_x < 1` 时缝被量化成 0 或 1，表现为「有的格有缝、有的没有」）。

代价是格子边缘落在半像素上、边缘略软；配合 90% 透明度与低对比色板，肉眼不可见。若需要绝对锐利，可整帧先按 `2x` 绘制再缩半（未实现，暂不需要）。

### 5.6 渲染循环健壮性（防冻结）

- `loop` 用 `try/catch` 包裹单帧：任何一帧抛错只记一次 `console.warn`（5s 节流）并继续排下一帧，不再让 `requestAnimationFrame` 断链。
- 连续 3 帧出错时重建算法实例（自愈）；`field` 长度与 `cols*rows` 不符也重建。
- 看门狗：`setInterval` 每秒检查一次，播放中且页面可见、但 1.5s 没收到 `rAF` 回调时，取消旧帧并重启动画链。
- 监听 canvas 的 `contextlost` / `contextrestored`：恢复时重设 backing store 并重启循环。
- 绘制时值非有限数（NaN/Infinity）按 0 处理，避免非法 `fillStyle` 静默吞掉整帧。

### 5.5 变化响应

- `resize`、`dpr` 变化、字体/缩放变化：自动模式整组重算；手动模式保留 `cellWidthCss/gapCss`，只重算 `n/m/g_x/g_y`。
- 用 `ResizeObserver` 观察 `document.documentElement`，再用 `matchMedia('(resolution: Xdppx)')` 监听跨屏 DPR 变化。
- 重算后重播种策略：**默认重采样**（把旧场按最近邻扩/缩到新尺寸）；只有切算法或改种子才重播种。重采样失败则重播种。

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
- **缝**：不画，直接露出 canvas 底色；底色默认 `#141414`，可配。
- **抖动**：Bayer 4×4 用 `(bayer/16 - 0.5) / levels` 作偏移；误差扩散用 Floyd–Steinberg，误差只在当前帧内传播。
- 画布每帧先铺底色，再画格子；被「影响范围」关掉的矩形最后 `clearRect`（透明，露出宿主底层）。

## 7. 六支算法

统一接口（浏览器侧，纯 JS）：

```js
create({ cols, rows, seed, params }) -> {
  field: Float32Array,   // 长度 cols*rows，值域 0..1
  step(dt)               // 推进一帧；静态算法可空实现
}
```

- 随机源只用种子派生的 `mulberry32`；禁止 `Math.random()`（骰子按钮除外）。
- 注册表：`registerAlgorithm(def)`，重复 id 报错；模块加载时注册六支。为将来外部算法预留。
- 参数 schema：`{ key, label, type: 'range'|'select', min, max, step, default, options?, format? }`；设置页据此自动生成二级参数，禁止为单支算法硬编码面板。

| id | 名称 | 参数（默认） | 实现要点 |
|---|---|---|---|
| boids | 鸟群 | `agents` 60–600 (280)、`speed` 0.4–2.4 (1.2)、`trail` 0.90–0.995 (0.98) | 分离/对齐/聚合，权重 1.6/0.9/0.7；环形边界；空间哈希邻域半径 12 格；每步 3×3 核打点（中心 .55、四邻 .18、对角 .06）；按 trail 衰减后归一化 |
| flow | 流场 | `particles` 300–3000 (1200)、`scale` 0.6–6 (1.8)、`trail` 0.90–0.995 (0.975) | 粒子沿 fBm 噪声旋度场推进，环形边界；每步累积亮度并衰减；场随时间缓慢漂移；必须呈丝状，不能是均匀噪点 |
| reaction | 反应扩散 | `feed` 0.010–0.080 (0.0367)、`kill` 0.040–0.070 (0.0649)、`steps` 1–12 (4) | Gray-Scott，`Du=.16 Dv=.08 dt=1`，9 点拉普拉斯，wrap；初始 10% 斑点；渲染取 B 通道对数归一化；模拟网格超 240 列时先降采样再最近邻放大 |
| noise | 噪声场 | `scale` 0.6–8 (2.2)、`octaves` 2–6 (4)、`warp` 0–1 (0.35)、`drift` 0–1 (0.15) | 值噪声 fBm + 域扭曲；drift 让场随时间平移；云层/地形感 |
| waves | 波干涉 | `sources` 2–12 (5)、`freq` 0.5–6 (2.2)、`speed` 0–2 (0.8)、`decay` 0–1 (0.3) | 多随机波源 `sin(dist*freq - t*speed)` 叠加，按距离衰减后归一化；莫尔纹/水波 |
| attractor | 奇异吸引子 | `type` select Clifford/De Jong (Clifford)、`a`/`b`/`c`/`d` 各 −3–3（Clifford: −1.4/1.6/1.0/0.7；De Jong: 1.4/−2.3/2.4/−2.1）、`points` 500–6000 (2500) | 点云累加密度图，每帧淡出 2%；对数归一化；切 type 重跑 |

- 场尺寸 = 当前 `cols × rows`；算法不感知像素尺寸、缝隙、形状、调色板。
- 默认算法 `boids`；切换算法保留通用配置与种子。

## 8. 配置模型

存储：`$DSH_HOME/pixel-wallpaper/config.json`（宿主侧原子写）。默认值即首次安装值。

```json
{
  "version": 3,
  "coverage": { "header": true, "left": true, "right": true, "input": false },
  "grid": { "mode": "auto", "cellWidth": null, "gap": null },
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
| cellWidth / gap | 2–40 / 0–20 CSS px（手动模式）；null = 自动 |
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
│   网格   单元格宽 / 间隔（自动值旁「调整」转手动）  [重置为自动] 当前 250 × 144 格
│   外观   形状 / 层数 / gamma / 黑场 / 白场 / 抖动 / 透明度
│   色值   调色板 + 底色
└─ [算法] [图片]                      ← tab
    算法 Tab：算法下拉（名称 — 描述）/ 播放暂停 · 速度 / 种子 / 二级参数
```

行为：

- 分组：**插件通用配置**（网格、外观、色值/底色）在背景范围与 Tab 之间；算法 Tab 内只放算法下拉、播放/速度、种子、二级参数。
- 插件通用：网格（单元格宽/间隔，自动值旁「调整」转手动、重置为自动）；外观（形状/层数/gamma/黑场/白场/抖动/透明度）；色值（调色板 + 底色）。
- 算法 Tab：算法下拉（每项「名称 — 描述」）、播放/暂停、速度、种子、二级参数（按 schema 生成）。
- 任何改动即时作用到画布（本地状态），300ms 防抖后 `PUT /pixel-wallpaper/api/config`；保存失败提示但不回滚画面。
- 算法 id、种子或二级参数任一变化都重建算法实例并重绘（参数在 `create` 时读取）；仅网格变化时重采样旧场。
- 插件通用配置两列排布：`.pw-fields` 用 `grid-template-columns:1fr 1fr`，字段不足两列时自然留空。
- 「影响范围」四个开关：开 = 背景延伸进该区域；关 = 该矩形不绘制（露出宿主底色）。默认顶栏/左栏/侧栏开，输入区关。
- 单元格宽/间隔在自动模式下显示计算值并标「自动」；一旦手动编辑转手动模式并写盘。点「重置为自动」回到自动计算。
- 只读行显示当前列×行与两个实际间隔（CSS px，一位小数）。
- 图片 tab：居中虚线框，两行文案「图片」「预留：把任意图片抽样为同一套单元格亮度场」；无上传控件、无逻辑。
- 开关与控件沿用 DSH 的暗色风格；插件只补 `pw-` 前缀样式。
- 保存结构里不写运行时计算值（cols/rows/g_x/g_y 不落盘）。

## 10. 影响范围与区域测量

- 画布固定在 `position: fixed; inset: 0; pointer-events: none; z-index: -1`（垫在内容之下），作为 `body` 第一个子节点；宿主内容自然盖在它上面。
- 让底层透出：只用 CSS，不改宿主 DOM 的 inline style（避免 React 重渲染后失效）。基础规则把 `html/body` 设为透明，并把 DSH 设计 token `--dsw-alias-bg-base`、`--dsw-specific-sidebar-fill` 在 `body`、`body[data-ds-dark-theme]`、`body[data-ds-light-theme]` 上覆盖为 `transparent !important`；面板与弹层仍走 elevated token，保持不透明可读。
- 区域矩形每 500ms 或 `resize`/DOM 变化时节流重测；取候选元素的 `getBoundingClientRect()`：
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
6. 动画：`requestAnimationFrame` + 固定步长累加器，目标 30fps；速度倍率作用于模拟步长，不改帧率；暂停时保留最后一帧。

## 13. 构建、安装、自检

构建：

```
npm run build     # client/index.js -> client/bundle.js
npm run check     # node --check 两个入口
npm test          # 网格/调色板纯函数单测
```

安装（由主进程执行，子代理不做）：

1. web profile 的 `package.json` dependencies 增加 `"dsh-pixel-wallpaper": "link:<Windows 可见路径>"`（工程在 WSL 时，先建指向 `\\wsl.localhost\<发行版>\...` 的目录符号链接，link 该链接）；
2. `dsh.profile.bundles` 增加 `dsh-pixel-wallpaper`；
3. profile 目录 `pnpm install`；
4. 刷新页面 / 重启 DSH 生效。

自检（执行者必须跑）：

1. `npm run build && npm run check && npm test` 全绿。
2. 用 Node 直接 `require` 宿主侧模块，确认 `apply` 是函数、config 读写往返一致。
3. 网格几何单测覆盖：1920×1080@1、3840×2160@2、1280×720@1.5、600×800@1、手动 9/1、手动 12/0，断言首格 0、末格贴边、无缝、两向间隔差在阈值内。
4. 不执行任何 git 写操作；不安装到 profile；不重启 DSH。

## 14. 非目标（本期明确不做）

- 导入图片 / 图片抽样（只留 tab 占位）。
- 导出 PNG、壁纸尺寸选择、URL 参数。
- 命令、快捷键、独立窗口。
- 多套主题、彩色方案、动画导出。
- 移动端布局适配（桌面 Web 优先，窄窗只保证不崩）。
