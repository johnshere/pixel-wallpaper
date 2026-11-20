# dsh-pixel-wallpaper

DSH Web 的像素格背景插件：在页面最底层铺一层由算法实时生成的、低饱和灰白像素格。它不替换 DSH 的布局与配色，只在内容背后当“底噪”，顶栏、会话列表、侧栏与输入区仍然是悬浮层。

## 特性

- **六支生成算法**：鸟群（boids）、流场（flow）、反应扩散（reaction）、噪声场（noise）、波干涉（waves）、奇异吸引子（attractor）。算法只产生 `cols × rows` 的亮度场，渲染器统一负责调色板、亮度阶梯、gamma、抖动与格子形状。
- **像素格几何可调**：固定 CSS 像素格宽（默认 5px / 间隔 0.8px），列数随窗口反算，首末格贴边、格间留缝。
- **数字输入框失焦或回车后生效**：输入过程不重绘，空值/非法值回退，超范围自动 clamp。
- **低饱和灰白**：默认纯黑底 + 黑白双色标，可增删色标做出灰阶；支持 2–16 级亮度阶梯与有序抖动。
- **覆盖范围开关**：顶栏、左栏、侧栏、输入区分别可控；量不到的区域自动跳过，不遮挡内容。
- **设置提交即生效**：数字输入框失焦/回车提交，其余控件即时重绘，提交后串行保存。

## 兼容性

| 项目 | 要求 | 说明 |
|---|---|---|
| DSH | `>=0.2.2-rc.3`（强制） | 宿主 app-boot 在导入插件前按 `package.json` 的 `engines.dsh` 校验；低于此版本会拒绝加载。不要改成 `^` 或加版本上限。 |
| Node.js | `>=22.5` | 宿主运行环境。 |
| 浏览器 | Chromium / Edge / Firefox 当前版本 | 需要 Canvas 2D、`ResizeObserver`、`matchMedia`。Safari 未验证。 |

本插件不依赖任何 `@deepseek-ai/*` 包，宿主侧只用 `ctx.*` 服务。

## 安装

### 从 npm（Alpha，推荐）

包已发布到 npmjs，dist-tag 为 `alpha`：

```bash
dsh plugin --profile web add dsh-pixel-wallpaper@alpha
```

普通 Node 项目也可以直接 `npm install dsh-pixel-wallpaper@alpha`；DSH 用户仍需在 profile 的 `dsh.profile.bundles` 里确认有 `"dsh-pixel-wallpaper"`，然后重启 DSH。

等价的 profile 手动方式：编辑 `$DSH_HOME/profiles/web/package.json`，

```jsonc
{
  "dependencies": {
    "dsh-pixel-wallpaper": "^0.1.0-alpha.2"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-pixel-wallpaper"]
    }
  }
}
```

再执行 `dsh plugin --profile web install`（或在该 profile 目录 `pnpm install`），然后重启 DSH。`dsh.profile.bundles` 缺了包名时，插件不会挂载。

### 从 GitHub tag（备用）

npm 不可用时，也可以直接从 GitHub tag 安装。`dsh plugin` 会把参数转发给 pnpm：

```bash
dsh plugin --profile web add github:johnshere/pixel-wallpaper#v0.1.0-alpha.2
```

pnpm 会拉取该 tag 的仓库并安装；首次安装需要本机有 git 和网络。安装后同样确认 `dsh.profile.bundles`，再重启 DSH。

### 本地开发（link，仅调试）

`npm run build` 会在 `E:/Workspace/00-a-temp/dsh-pixel-wallpaper`（可用 `PIXEL_WALLPAPER_OUT` 覆盖）生成自包含目录，供本地 link 调试，不是 npm 发布内容。在 profile 的 `package.json` 中：

```jsonc
{
  "dependencies": {
    "dsh-pixel-wallpaper": "link:E:/Workspace/00-a-temp/dsh-pixel-wallpaper"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-pixel-wallpaper"]
    }
  }
}
```

之后每次改完源码 `npm run build`，刷新页面即可（宿主侧改动需重启 DSH）。

> DSH 跑在 Windows 上时，`link:` 必须是 Windows 盘符绝对路径。UNC 路径（`\\wsl.localhost\...`）会抛 `ERR_INVALID_FILE_URL_PATH`；源码在 WSL 时，构建产物要落到 Windows 本地盘。

## 升级

```bash
# npm（推荐）
dsh plugin --profile web add dsh-pixel-wallpaper@alpha
# 或 dsh plugin --profile web update dsh-pixel-wallpaper

# GitHub tag 备用
dsh plugin --profile web add github:johnshere/pixel-wallpaper#v0.1.0-alpha.2
```

重启 DSH。alpha 版本可能包含不兼容改动，升级前看一眼 [CHANGELOG.md](CHANGELOG.md)。

## 卸载

1. 从 profile 的 `dsh.profile.bundles` 中删掉 `"dsh-pixel-wallpaper"`；
2. `dsh plugin --profile web remove dsh-pixel-wallpaper`；
3. 重启 DSH。

插件禁用/卸载时会移除画布、样式、监听器并复位运行时状态，不会留下背景层。配置仍保留在 `$DSH_HOME/pixel-wallpaper/config.json`，不需要时可手动删除。

## 排错

| 现象 | 处理 |
|---|---|
| DSH 启动时提示插件被拒绝 / 不兼容 | `dsh --version` 确认 `>=0.2.2-rc.3`；宿主按 `engines.dsh` 强制校验，旧版无法加载。 |
| 设置页有「像素背景」但页面无背景 | 检查浏览器控制台；确认画布未被子元素覆盖、透明度/底色不是同色、影响范围开关没有全部关掉。 |
| 设置页一直「加载中…」或「读取配置失败」 | 宿主侧 `/pixel-wallpaper/api/config` 未就绪，重启 DSH；确认插件在 `bundles` 里。 |
| 改系统缩放后格子尺寸不对 | 0.1.0-alpha.1 起按当前 dpr 动态重绑，1.25 → 1.5 也会触发重算；`resize` 兜底。若仍异常，刷新页面并反馈浏览器版本。 |
| 背景在切换页面/禁用插件后仍残留 | 属于 bug；卸载清理会复位状态，请附控制台与 DSH 版本反馈。 |

## 隐私

- 配置只写本机 `$DSH_HOME/pixel-wallpaper/config.json`，不上传、不联网、无遥测。
- 不读取会话内容；只测量顶栏/侧栏/输入区等容器的几何位置用于挖空背景。
- 不加任何第三方脚本、字体或 CDN 资源。

## 开发

```bash
npm run build                 # 生成 client/bundle.js、src/algorithm-schemas.js，并输出 E: 自包含目录
node scripts/build.mjs --assets  # 只刷新两个入库生成物，不碰 E: 输出（prepack / CI 用）
npm run check                 # node --check 两个入口
npm test                      # 网格/调色板/算法/渲染/DPR/生命周期/发布清单
```

- 宿主侧 `src/index.js` 注册 `/pixel-wallpaper/api/config` 的 GET/PUT；配置读写见 `src/config.js`。
- 客户端 `client/index.js` 是全部界面与渲染逻辑；`client/bundle.js` 与 `src/algorithm-schemas.js` 是生成物，改源码后必须重跑 `npm run build -- --assets` 或 `npm run build`，不要手改。
- 设计契约见 [docs/DESIGN.md](docs/DESIGN.md)。

## 发布（维护者）

```bash
npm test && npm run check
npm publish          # publishConfig: registry=npmjs, access=public, tag=alpha
```

`prepack` 会先执行 `node scripts/build.mjs --assets` 刷新生成物；发布的是仓库根包（`files` 白名单），不是 E: 自包含目录。发布前需已 `npm login`。

## License

MIT © 2026 johnshere
