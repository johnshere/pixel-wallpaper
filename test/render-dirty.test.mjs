/**
 * 脏渲染与 24fps：只重画色阶变化的格子，且 24fps 的固定步长不被 30fps 误触发。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const fakeReact = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Fragment: 'f' }
const loaded = new Map()

let clock = 0
let nextRafId = 1
const pendingFrames = new Map()

globalThis.performance = { now: () => clock }
globalThis.requestAnimationFrame = (cb) => {
  const id = nextRafId++
  pendingFrames.set(id, cb)
  return id
}
globalThis.cancelAnimationFrame = (id) => pendingFrames.delete(id)
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}

globalThis.window = {
  innerWidth: 20,
  innerHeight: 20,
  devicePixelRatio: 1,
  __ModuleLoader__: {
    load: ({ id, factory }) => loaded.set(id, factory((specifier) => (specifier === 'react' ? fakeReact : null)))
  }
}
globalThis.document = {
  body: null,
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null
}

require('../client/bundle.js')
const internals = loaded.get('dsh-pixel-wallpaper').__internals

function makeCanvas() {
  const stats = { fills: 0, clears: 0, fillStyles: 0 }
  const ctx = {
    _fillStyle: '#000000',
    get fillStyle() { return this._fillStyle },
    set fillStyle(v) {
      if (typeof v !== 'string' || v.includes('NaN')) throw new Error('非法 fillStyle: ' + v)
      stats.fillStyles++
      this._fillStyle = v
    },
    clearRect: () => { stats.clears++ },
    fillRect: () => { stats.fills++ },
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    roundRect: () => {}
  }
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    isConnected: true,
    getContext: () => ctx,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  return { canvas, stats }
}

function runFrame(dt) {
  clock += dt
  const first = pendingFrames.entries().next()
  if (first.done) return false
  pendingFrames.delete(first.value[0])
  first.value[1](clock)
  return true
}

const CONFIG = {
  grid: { cellWidth: 5, gap: 0.8 },
  render: {
    palette: ['#111111', '#ffffff'],
    background: '#000000',
    levels: 2,
    gamma: 1,
    black: 0,
    white: 100,
    dither: 'none',
    shape: 'square',
    transparency: 0
  },
  animation: { playing: true, speed: 1 },
  algorithm: { id: 'dirty-probe', seed: 1, params: {} },
  coverage: { header: true, left: true, right: true, input: true }
}

test('脏渲染只重画变化格；24fps 下 40ms 不推进，42ms 才推进', () => {
  let created = 0
  internals.registerAlgorithm({
    id: 'dirty-probe',
    label: 'dirty-probe',
    desc: '',
    schema: [],
    create: ({ cols, rows }) => {
      created++
      const field = new Float32Array(cols * rows)
      return { field, step() { field[4] = 1 } }
    }
  })

  const { canvas, stats } = makeCanvas()
  const renderer = internals.createRenderer(canvas, CONFIG, () => {})
  try {
    assert.equal(created, 1)
    assert.ok(runFrame(1), '首帧应绘制')
    // 3×3 格：底色 1 次 + 9 个格子；level 0 不是底色，不能跳过。
    assert.equal(stats.fills, 10)
    const fullFills = stats.fills
    const fullClears = stats.clears

    // 24fps 一帧 41.67ms：40ms 不应推进/重画；30fps 会在 40ms 推进。
    assert.ok(runFrame(40))
    assert.equal(stats.fills, fullFills, '40ms 时不应推进模拟')
    assert.equal(stats.clears, fullClears, '无变化时不应整帧清屏')

    // 再 2ms 达到 42ms，推进一次；只有第 5 格改变，只重画 1 格。
    assert.ok(runFrame(2))
    assert.equal(stats.fills, fullFills + 1, '只重画变化的格子')
    assert.equal(stats.clears, fullClears, '脏渲染不应清整屏')
  } finally {
    renderer.destroy()
  }
})


test('覆盖矩形变化时强制整帧重画，避免旧透明区留下洞', () => {
  internals.registerAlgorithm({
    id: 'coverage-probe',
    label: 'coverage-probe',
    desc: '',
    schema: [],
    create: ({ cols, rows }) => {
      const field = new Float32Array(cols * rows)
      return { field, step() { field[4] = 1 } }
    }
  })
  const { canvas, stats } = makeCanvas()
  let rects = {
    header: { x: 0, y: 0, w: 5, h: 5 },
    left: null,
    right: null,
    input: null,
    rightClosed: false
  }
  const cfg = { ...CONFIG, coverage: { ...CONFIG.coverage, header: false }, algorithm: { id: 'coverage-probe', seed: 1, params: {} } }
  const renderer = internals.createRenderer(canvas, cfg, () => {})
  renderer.setCoverageProvider(() => rects)
  try {
    assert.ok(runFrame(1))
    const fullFills = stats.fills
    assert.equal(fullFills, 10)
    // 区域移动后，旧透明区必须用整帧重画补回，而不是只画变化格。
    rects = { ...rects, header: { x: 5, y: 0, w: 5, h: 5 } }
    assert.ok(runFrame(42))
    assert.equal(stats.fills, fullFills + 10)
  } finally {
    renderer.destroy()
  }
})

test('buildColorTable：level 0 与底色完全相同时才可跳过', () => {
  const { buildColorTable } = internals
  const table = buildColorTable({
    levels: 2,
    palette: ['#000000', '#ffffff'],
    background: '#000000',
    transparency: 0
  })
  assert.equal(table.colors[0], table.bgColor)
  assert.equal(table.colors[1], 'rgb(255,255,255)')

  const faded = buildColorTable({
    levels: 2,
    palette: ['#1b1b1b', '#c9c9c9'],
    background: '#141414',
    transparency: 90
  })
  assert.notEqual(faded.colors[0], faded.bgColor, '默认 90% 透明度下 level 0 不等于纯底色')
})
