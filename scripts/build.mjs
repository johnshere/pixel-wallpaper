#!/usr/bin/env node
/**
 * 构建一个自包含、可直接安装（也可直接 `npm publish`）的包目录。
 *
 * 产物目录（默认 `E:/Workspace/00-a-temp/dsh-pixel-wallpaper`，可用
 * `PIXEL_WALLPAPER_OUT` 覆盖）每次构建都会清空重建，内容只有运行时需要的文件：
 *
 *   package.json      入口指向 lib/ 与 client/，不含 scripts / src
 *   cordis.patch.yml  宿主组合补丁
 *   lib/index.js      宿主侧插件（src/*.js 合成一个 CJS 文件）
 *   client/bundle.js  客户端 bundle
 *   README.md / LICENSE
 *
 * 另外会从 client/index.js 的注册表生成 `src/algorithm-schemas.js`：
 * 服务端校验与设置页共用同一份参数定义，避免新增二级参数后保存被丢弃。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { Script, runInNewContext } from 'node:vm'
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

/* ── 从客户端注册表提取参数 schema，生成服务端共用的定义 ─────────────── */

const fakeReact = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  Fragment: 'fragment',
}
const sandbox = {
  require: (specifier) => (specifier === 'react' ? fakeReact : null),
  module: { exports: {} },
  exports: {},
  window: {},
  document: {},
  screen: {},
  performance: { now: () => 0 },
  console,
}
runInNewContext(clientSource, sandbox, { filename: 'client/index.js' })

const internals = sandbox.module.exports.__internals
const schemas = {}
for (const id of internals.algorithmIds()) schemas[id] = internals.algorithmOf(id).schema

const generatedSchemas = `'use strict'

/**
 * 六支算法的参数 schema —— 由 scripts/build.mjs 从 client/index.js 生成，勿手改。
 * 服务端 sanitize 与设置页共用同一份定义：新增/调整二级参数只改客户端注册表。
 */

module.exports = ${JSON.stringify(schemas, null, 2)}

`
await writeFile(join(root, 'src/algorithm-schemas.js'), generatedSchemas, 'utf8')

/* ── 宿主：把 src/ 下的本地模块合成一个 CJS 文件 ─────────────────────── */

function resolveLocal(fromFile, specifier) {
  const base = join(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`[pixel-wallpaper] 找不到本地模块 ${specifier}（来自 ${fromFile}）`)
}

/** @returns {Map<string, {file:string, source:string}>} */
function collectLocalModules(entryFile) {
  const modules = new Map()
  const visit = (file, id) => {
    if (modules.has(id)) return
    const source = readFileSync(file, 'utf8')
    modules.set(id, { file, source })
    for (const match of source.matchAll(/require\((['"])(\.[^'"]*)\1\)/g)) {
      visit(resolveLocal(file, match[2]), match[2])
    }
  }
  visit(entryFile, './index')
  return modules
}

const hostModules = collectLocalModules(join(root, 'src/index.js'))
const moduleDefs = [...hostModules]
  .map(
    ([id, mod]) => `__defs[${JSON.stringify(id)}] = function (module, exports, require) {
${indent(mod.source)}
}`,
  )
  .join('\n\n')

const hostBundle = `${banner}
'use strict'

const __hostRequire = require
const __defs = Object.create(null)

${moduleDefs}

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
