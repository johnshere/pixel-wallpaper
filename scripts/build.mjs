#!/usr/bin/env node
/**
 * 构建一个自包含、可直接安装（也可直接 `npm publish`）的包目录。
 *
 * 产物目录（默认 `E:/Workspace/00-a-temp/dsh-pixel-wallpaper`，可用
 * `PIXEL_WALLPAPER_OUT` 覆盖）每次构建都会清空重建，内容只有运行时需要的文件：
 *
 *   package.json      入口指向 lib/ 与 client/，不含 scripts / src
 *   cordis.patch.yml  宿主组合补丁
 *   lib/index.js      宿主侧插件（src/index.js + src/config.js 打成一个文件）
 *   client/bundle.js  客户端 bundle
 *   README.md / LICENSE
 *
 * 仓库里的 `client/bundle.js` 仍然生成一份，供测试直接加载纯函数。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const outDir = resolve(
  process.env.PIXEL_WALLPAPER_OUT ||
    (process.platform === 'win32'
      ? 'E:/Workspace/00-a-temp/dsh-pixel-wallpaper'
      : '/mnt/e/Workspace/00-a-temp/dsh-pixel-wallpaper'),
)

function indent(source) {
  return source
    .replace(/\r\n/g, '\n')
    .trimEnd()
    .split('\n')
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join('\n')
}

const banner = `/*! ${pkg.name} v${pkg.version} | MIT | 构建产物，请勿手改 */`

/* ── 客户端：宿主用 __ModuleLoader__ 注册，factory 只拿到 react ─────────── */

const clientSource = await readFile(join(root, 'client/index.js'), 'utf8')
const clientBundle = `${banner}
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
${indent(clientSource)}
    return module.exports
  }
})
`

/* ── 宿主：把 src/index.js 与 src/config.js 合成一个 CJS 模块 ──────────── */

const hostIndex = await readFile(join(root, 'src/index.js'), 'utf8')
const hostConfig = await readFile(join(root, 'src/config.js'), 'utf8')
const hostBundle = `${banner}
'use strict'

const __hostRequire = require
const __defs = Object.create(null)

__defs['./config'] = function (module, exports, require) {
${indent(hostConfig)}
}

__defs['./index'] = function (module, exports, require) {
${indent(hostIndex)}
}

function __require(id) {
  if (id.charAt(0) !== '.') return __hostRequire(id)
  const def = __defs[id]
  if (!def) throw new Error('[pixel-wallpaper] 未知模块: ' + id)
  const module = { exports: {} }
  def(module, module.exports, __require)
  return module.exports
}

module.exports = __require('./index')
`

// 包装代码写坏了要立刻失败，而不是等宿主加载时才报错。
new Script(clientBundle, { filename: join(root, 'client/bundle.js') })
new Script(hostBundle, { filename: join(outDir, 'lib/index.js') })

const shippedPkg = {
  ...pkg,
  main: 'lib/index.js',
  exports: {
    '.': './lib/index.js',
    './client': './client/bundle.js',
    './package.json': './package.json',
  },
  files: ['lib', 'client', 'cordis.patch.yml', 'README.md', 'LICENSE'],
}
delete shippedPkg.scripts

await rm(outDir, { recursive: true, force: true })
await mkdir(join(outDir, 'lib'), { recursive: true })
await mkdir(join(outDir, 'client'), { recursive: true })

await writeFile(join(root, 'client/bundle.js'), clientBundle, 'utf8')
await writeFile(join(outDir, 'client/bundle.js'), clientBundle, 'utf8')
await writeFile(join(outDir, 'lib/index.js'), hostBundle, 'utf8')
await writeFile(join(outDir, 'package.json'), JSON.stringify(shippedPkg, null, 2) + '\n', 'utf8')

for (const file of ['cordis.patch.yml', 'README.md', 'LICENSE']) {
  await writeFile(join(outDir, file), await readFile(join(root, file)))
}

const size = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(1)}KB`
console.log(`[pixel-wallpaper] 构建完成 -> ${outDir}`)
console.log(`  lib/index.js      ${size(hostBundle)}`)
console.log(`  client/bundle.js  ${size(clientBundle)}`)
