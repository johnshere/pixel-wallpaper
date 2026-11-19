# dsh-pixel-wallpaper

DSH Web 的像素格背景插件：在页面最底层铺一层由算法实时生成的、低饱和灰白像素格。它不替换 DSH 的布局与配色，只在内容背后当“底噪”，顶栏、会话列表、侧栏与输入区仍然是悬浮层。

## 特性

- **六支生成算法**：鸟群（boids）、流场（flow）、反应扩散（reaction）、噪声场（noise）、波干涉（waves）、奇异吸引子（attractor）。算法只负责产生 `cols × rows` 的亮度场，渲染器统一负责调色板、亮度阶梯、gamma、抖动与格子形状。
- **像素格几何可调**：固定 CSS 像素格宽（默认 5px / 间隔 0.8px），列数随窗口反算，首末格贴边、格间留缝。同一屏幕改变窗口宽度时格子 CSS 尺寸不变（物理尺寸仍取决于屏幕 PPI/系统缩放）。
- **数字输入框失焦或回车后生效**：输入过程不重绘，空值/非法值回退，超范围自动 clamp。
- **低饱和灰白**：默认纯黑底 + 黑白双色标，可增删色标做出灰阶；支持 2–16 级亮度阶梯与有序抖动。
- **覆盖范围开关**：顶栏、左栏、侧栏、输入区分别可控；量不到的区域自动跳过，不遮挡内容。
- **设置提交即生效**：设置页内调整播放/暂停、速度、算法参数、网格与色值；数字输入框失焦/回车提交，其余控件即时重绘，300ms 防抖保存。

## 安装

`npm run build` 会直接在 `E:/Workspace/00-a-temp/dsh-pixel-wallpaper`（可用 `PIXEL_WALLPAPER_OUT` 覆盖）生成一个自包含的包：`package.json` + `cordis.patch.yml` + `lib/index.js` + `client/bundle.js` + `README`。这个目录就是安装目标，也是将来 `npm publish` 的内容，两者完全一致。

在 web profile 的 `package.json` 中：

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

`node_modules` 里用目录联接（junction）指过去即可。之后每次改完源码只要 `npm run build`，安装位置的内容就更新了；客户端改动刷新页面生效，宿主改动需要重启 DSH。设置入口在设置页的「像素背景」一节。

> DSH 跑在 Windows 上时，`link:` 必须是 Windows 的**盘符绝对路径**。DSH 读取插件元信息时用 `file://` 拼接包路径，UNC 路径（`\\wsl.localhost\...`）会抛 `ERR_INVALID_FILE_URL_PATH: File URL path must be absolute`。所以源码在 WSL 里时，构建产物要落到 Windows 本地盘，不要 link WSL 或 UNC 路径。

## 开发

```bash
npm run build   # 打包宿主与客户端，输出到安装目录（同时刷新仓库里的 client/bundle.js 供测试）
npm run check   # node --check 两个入口
npm test        # 网格几何 / 调色板 / 六算法 / 配置读写
```

- 宿主侧 `src/index.js` 注册 `/pixel-wallpaper/api/config` 的 GET/PUT；配置落在 `$DSH_HOME/pixel-wallpaper/config.json`。
- 客户端 `client/index.js` 是全部界面与渲染逻辑，构建脚本把它包成 `window.__ModuleLoader__.load({ id, factory })`；宿主侧两文件合成 `lib/index.js`。
- 设计契约见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

MIT © 2026 johnshere
