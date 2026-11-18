/**
 * 宿主侧配置模块测试：默认值、clamp、落盘、原子写、apply 不抛。
 * 用临时 DSH_HOME，绝不碰真实配置。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-config-'))
process.env.DSH_HOME = home

const config = require('../src/config.js')
const plugin = require('../src/index.js')

test('默认配置与 DESIGN.md §8 一致', () => {
  const c = config.readConfig()
  assert.equal(c.grid.mode, 'auto')
  assert.equal(c.render.levels, 8)
  assert.deepEqual(c.render.palette, ['#1b1b1b', '#c9c9c9'])
  assert.equal(c.coverage.input, false)
  assert.equal(c.algorithm.id, 'boids')
})

test('sanitize：非法值 clamp、未知键丢弃、颜色归一化', () => {
  const c = config.sanitize({
    render: { levels: 99, gamma: -1, background: '#ABC', palette: ['#fff', 'nope', '#000'], shape: 'weird' },
    grid: { mode: 'manual', cellWidth: 999, gap: -5 },
    algorithm: { id: 'nope', seed: -3, params: { agents: 99999, bad: 1 } },
    junk: true
  })
  assert.equal(c.render.levels, 16)
  assert.equal(c.render.gamma, 0.4)
  assert.equal(c.render.background, '#aabbcc')
  assert.deepEqual(c.render.palette, ['#ffffff', '#000000'])
  assert.equal(c.render.shape, 'square')
  assert.equal(c.grid.cellWidth, 40)
  assert.equal(c.grid.gap, 0)
  assert.equal(c.algorithm.id, 'boids')
  assert.equal(c.algorithm.seed, 0)
  assert.equal(c.algorithm.params.agents, 600)
  assert.equal(c.algorithm.params.bad, undefined)
  assert.equal(c.junk, undefined)
})

test('writeConfig 合并并原子落盘，readConfig 读回一致', () => {
  config.__resetCache()
  const next = config.writeConfig({ render: { ...config.DEFAULT_CONFIG.render, levels: 5 } })
  assert.equal(next.render.levels, 5)
  const file = path.join(home, 'pixel-wallpaper', 'config.json')
  assert.ok(fs.existsSync(file), '配置文件应已落盘')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.render.levels, 5)
  assert.equal(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')).length, 0, '不应残留临时文件')
})

test('损坏的配置文件按默认值处理', () => {
  fs.writeFileSync(path.join(home, 'pixel-wallpaper', 'config.json'), '{oops', 'utf8')
  config.__resetCache()
  const c = config.readConfig()
  assert.equal(c.render.levels, 8)
})

test('宿主插件 apply 在没有 webServer 时不抛', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.doesNotThrow(() => plugin.apply({ inject: () => {}, effect: () => {} }))
})
