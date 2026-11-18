/**
 * 回归：窗口宽度变化后背景不能「继续跑帧但画面静止」。
 * 用假画布累计每帧绘制校验和：画面如果在动，相邻帧增量应不断变化；
 * 如果绘制读到的是一张被替换进去的静止快照，每帧增量会完全一致。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const fakeReact = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Fragment: 'f' }
const loaded = new Map()
const rafQueue = []

globalThis.window = {
  innerWidth: 800,
  innerHeight: 600,
  devicePixelRatio: 1,
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded.set(id, factory((specifier) => (specifier === 'react' ? fakeReact : null)))
    }
  }
}
globalThis.document = {
  body: { insertBefore() {}, firstChild: null },
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {}
}
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length }
globalThis.cancelAnimationFrame = () => {}
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
globalThis.performance = { now: () => Date.now() }

require('../client/bundle.js')
const internals = loaded.get('dsh-pixel-wallpaper').__internals

const MOD = 1000000007
const styleHash = (s) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0
  return h
}

function makeCanvas() {
  const state = { frameSig: 0, fills: 0, fillStyle: '#000' }
  const ctx = {
    canvas: null,
    get fillStyle() { return state.fillStyle },
    set fillStyle(v) { state.fillStyle = v },
    clearRect() { state.frameSig = 0 },
    fillRect(x, y, w, h) {
      state.fills++
      const sh = styleHash(String(state.fillStyle))
      state.frameSig = (state.frameSig * 31 + Math.round(x) * 7 + Math.round(y) * 13 + Math.round(w) * 3 + Math.round(h) + sh) % MOD
    },
    beginPath() {},
    arc() {},
    fill() {},
    roundRect() {}
  }
  const canvas = { width: 0, height: 0, style: {}, isConnected: true, getContext: () => ctx, addEventListener() {}, removeEventListener() {} }
  ctx.canvas = canvas
  return { canvas, state }
}

const baseConfig = () => ({
  version: 3,
  coverage: { header: true, left: true, right: true, input: true },
  grid: { mode: 'auto', cellWidth: null, gap: null },
  render: { shape: 'square', levels: 8, palette: ['#1b1b1b', '#c9c9c9'], gamma: 1, black: 0, white: 100, dither: 'none', background: '#141414', transparency: 0 },
  animation: { playing: true, speed: 1 },
  algorithm: { id: 'boids', seed: 1337, params: { agents: 150 } }
})

test('窗口尺寸变化后画面仍在更新（绘制场不是静止快照）', () => {
  const { canvas, state } = makeCanvas()
  const renderer = internals.createRenderer(canvas, baseConfig())

  let ts = 0
  const frame = () => {
    ts += 33
    const cb = rafQueue.shift()
    assert.ok(cb, '动画链不应断')
    cb(ts)
  }
  const signatures = (n) => {
    const out = []
    for (let i = 0; i < n; i++) {
      frame()
      out.push(state.frameSig)
    }
    return out
  }

  for (let i = 0; i < 12; i++) frame() // 等场稳定
  const before = signatures(8)
  assert.ok(new Set(before).size > 1, '正常情况下每帧绘制结果应变化')

  // 模拟打开 DevTools：宽度变小 → 网格变化 → updateConfig
  globalThis.window.innerWidth = 640
  renderer.updateConfig(baseConfig())
  assert.equal(canvas.width, 640, '网格应跟随窗口宽度重算')

  const after = signatures(8)
  assert.ok(new Set(after).size > 1, '改变窗口宽度后画面必须继续更新')

  renderer.destroy()
})
