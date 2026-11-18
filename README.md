# dsh-pixel-wallpaper

DSH Web 的像素格背景插件：在页面最底层铺一层由算法实时生成的、低饱和灰白像素格。它不替换 DSH 的布局与配色，只在内容背后当“底噪”，顶栏、会话列表、侧栏与输入区仍然是悬浮层。

## 特性

- **六支生成算法**：鸟群（boids）、流场（flow）、反应扩散（reaction）、噪声场（noise）、波干涉（waves）、奇异吸引子（attractor）。算法只负责产生 `cols × rows` 的亮度场，渲染器统一负责调色板、亮度阶梯、gamma、抖动与格子形状。
- **像素格几何可调**：自动模式下按设备像素宽铺约 250 列，首末格贴边、格间留缝；也可手动指定单元格宽与间隔。
- **低饱和灰白**：默认纯黑底 + 黑白双色标，可增删色标做出灰阶；支持 2–16 级亮度阶梯与有序抖动。
- **覆盖范围开关**：顶栏、左栏、侧栏、输入区分别可控；量不到的区域自动跳过，不遮挡内容。
- **设置即生效**：设置页内调整播放/暂停、速度、算法参数、网格与色值，客户端即时重绘并防抖保存。

## 安装（本地 link）

在 web profile 的 `package.json` 中：

```jsonc
{
  "dependencies": {
    "dsh-pixel-wallpaper": "link:E:/path/to/dsh-pixel-wallpaper"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-pixel-wallpaper"]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`，刷新页面（必要时重启 DSH）。设置入口在设置页的「像素背景」一节。

> DSH 跑在 Windows 上时，`link:` 必须是 Windows 的**盘符绝对路径**。DSH 读取插件元信息时用 `file://` 拼接包路径，UNC 路径（`\\wsl.localhost\...`）会抛 `ERR_INVALID_FILE_URL_PATH: File URL path must be absolute`。所以工程在 WSL 里开发时，不要直接 link WSL 或 UNC 路径，而是先 `npm run stage` 把运行时文件同步到 Windows 本地目录（默认 `E:/Workspace/00-a-temp/dsh-pixel-wallpaper`，可用 `PIXEL_WALLPAPER_STAGE` 覆盖），再 `link:` 那个目录。

## 开发

```bash
npm run build   # client/index.js -> client/bundle.js（宿主加载的产物，需入库）
npm run stage   # build 后把 package.json/src/client 等同步到 Windows 暂存目录
npm run check   # node --check 两个入口
npm test        # 网格几何 / 调色板 / 六算法 / 配置读写
```

- 宿主侧 `src/index.js` 注册 `/pixel-wallpaper/api/config` 的 GET/PUT；配置落在 `$DSH_HOME/pixel-wallpaper/config.json`。
- 客户端 `client/index.js` 是全部界面与渲染逻辑，构建脚本把它包成 `window.__ModuleLoader__.load({ id, factory })`。
- 设计契约见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

MIT © 2026 johnshere
