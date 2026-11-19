/**
 * 发布契约：根包就是 npm 发布内容，不能把源码 / 脚本 / 测试发出去。
 * 同时锁定兼容矩阵里的强制 DSH 版本，防止误改成 `^` 或加上限。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('package.json 兼容矩阵与入口', () => {
  assert.equal(pkg.engines.dsh, '>=0.2.2-rc.3', 'DSH 版本必须是强制下限')
  assert.equal(pkg.main, 'src/index.js')
  assert.equal(pkg.type, 'commonjs')
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './client/bundle.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('发布元数据', () => {
  assert.equal(pkg.version, '0.1.0-alpha.1')
  assert.equal(pkg.author, 'johnshere')
  assert.equal(pkg.repository.url, 'https://github.com/johnshere/pixel-wallpaper.git')
  assert.equal(pkg.homepage, 'https://github.com/johnshere/pixel-wallpaper#readme')
  assert.equal(pkg.bugs.url, 'https://github.com/johnshere/pixel-wallpaper/issues')
  assert.deepEqual(pkg.publishConfig, { access: 'public', tag: 'alpha', registry: 'https://registry.npmjs.org/' })
  for (const keyword of ['dsh', 'dsh-plugin', 'wallpaper', 'canvas', 'pixel']) {
    assert.ok(pkg.keywords.includes(keyword), `缺少 keyword: ${keyword}`)
  }
  assert.equal(pkg.scripts.prepack, 'node scripts/build.mjs --assets')
})

test('files 白名单只含运行时文件', () => {
  const files = pkg.files
  for (const required of [
    'src/index.js',
    'src/config.js',
    'src/algorithm-schemas.js',
    'client/bundle.js',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    'CHANGELOG.md'
  ]) {
    assert.ok(files.includes(required), `files 应包含 ${required}`)
  }
  for (const forbidden of ['client/index.js', 'scripts', 'test', 'docs']) {
    assert.ok(
      !files.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`)),
      `files 不应包含 ${forbidden}`
    )
  }
})

test('npm pack 的 tarball 文件集与 files 一致（不发布源码/脚本/测试）', () => {
  const output = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_loglevel: 'error' }
    }
  )
  const [info] = JSON.parse(output)
  assert.ok(Array.isArray(info.files), 'npm pack --json 应返回文件列表')
  const shipped = new Set(info.files.map((file) => file.path))

  for (const required of [
    'package.json',
    'src/index.js',
    'src/config.js',
    'src/algorithm-schemas.js',
    'client/bundle.js',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    'CHANGELOG.md'
  ]) {
    assert.ok(shipped.has(required), `tarball 应包含 ${required}`)
  }
  for (const forbidden of ['client/index.js', 'scripts/build.mjs', 'test/dpr.test.mjs', 'docs/DESIGN.md']) {
    assert.ok(!shipped.has(forbidden), `tarball 不应包含 ${forbidden}`)
  }
})
