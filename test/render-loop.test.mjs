/**
 * 渲染循环健壮性测试（DESIGN.md §5.6）。
 *
 * 用假的 rAF / setInterval / canvas 驱动 createRenderer，钉死三件事：
 * 1. 单帧抛错不会让动画链断掉（旧实现会永久冻结在最后一帧）；
 * 2. 看门狗在长时间收不到帧时能重启动画链；
 * 3. destroy 会清掉帧与定时器，不留下后台循环。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/* ── 假环境（必须在加载 bundle 前就位） ─────────────────────────────── */

const fakeReact = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  Fragment: 'fragment'
}

let clock = 0
let nextRafId = 1
const pendingFrames = new Map()
let intervalCallback = null
let intervalCleared = false

globalThis.performance = { now: () => clock }
globalThis.requestAnimationFrame = (cb) => {
  const id = nextRafId++
  pendingFrames.set(id, cb)
  return id
}
globalThis.cancelAnimationFrame = (id) => {
  pendingFrames.delete(id)
}
globalThis.setInterval = (fn) => {
  intervalCallback = fn
  return 77
}
globalThis.clearInterval = () => {
  intervalCleared = true
  intervalCallback = null
}

const loaded = new Map()
globalThis.window = {
  innerWidth: 1920,
  innerHeight: 1080,
  devicePixelRatio: 1,
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded.set(id, factory((specifier) => (specifier === 'react' ? fakeReact : null)))
    }
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
const { createRenderer } = loaded.get('dsh-pixel-wallpaper').__internals

/* ── 假 canvas ─────────────────────────────────────────────────────── */

function makeCanvas() {
  const stats = { fills: 0, throwOnce: true }
  const ctx = {
    _fillStyle: '#000000',
    get fillStyle() {
      return this._fillStyle
    },
    set fillStyle(v) {
      if (typeof v !== 'string' || v.includes('NaN')) throw new Error('非法 fillStyle: ' + v)
      this._fillStyle = v
    },
    clearRect: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    roundRect: () => {},
    fillRect: () => {
      stats.fills++
      // 第 3 次填充抛一次：模拟渲染中途出错
      if (stats.throwOnce && stats.fills === 3) {
        stats.throwOnce = false
        throw new Error('boom')
      }
    }
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

const CONFIG = {
  grid: { mode: 'auto' },
  render: {
    palette: ['#1b1b1b', '#c9c9c9'],
    background: '#141414',
    levels: 8,
    gamma: 1,
    black: 0,
    white: 100,
    dither: 'none',
    shape: 'square',
    transparency: 90
  },
  animation: { playing: true, speed: 1 },
  algorithm: { id: 'boids', seed: 1337, params: {} },
  coverage: { header: true, left: true, right: true, input: true }
}

/** 跑一帧：取最早排队的回调并推进 16ms。 */
function runFrame(dt = 16) {
  clock += dt
  const first = pendingFrames.entries().next()
  if (first.done) return false
  const [id, cb] = first.value
  pendingFrames.delete(id)
  cb(clock)
  return true
}

/* ── 用例 ─────────────────────────────────────────────────────────── */

test('单帧抛错后动画链不断：后续帧仍会排上并继续绘制', () => {
  const { canvas, stats } = makeCanvas()
  const renderer = createRenderer(canvas, CONFIG, () => {})
  try {
    assert.ok(runFrame(), '首帧应可运行')
    assert.ok(stats.throwOnce === false, '测试应已触发一次渲染异常')
    assert.ok(pendingFrames.size >= 1, '异常帧之后必须继续排下一帧')
    const before = stats.fills
    assert.ok(runFrame(), '异常之后的下一帧应照常执行')
    assert.ok(stats.fills > before, '下一帧应继续填充像素')
  } finally {
    renderer.destroy()
  }
})

test('看门狗：长时间收不到帧会重启动画链', () => {
  const { canvas } = makeCanvas()
  const renderer = createRenderer(canvas, CONFIG, () => {})
  try {
    assert.ok(typeof intervalCallback === 'function', '应注册看门狗')
    // 停掉当前排队的帧（视为 rAF 被掐断），但不通知渲染器
    pendingFrames.clear()
    clock += 5000
    intervalCallback()
    assert.ok(pendingFrames.size >= 1, '看门狗应重新排帧')
    assert.ok(runFrame(), '重启后的帧应可运行')
  } finally {
    renderer.destroy()
  }
})

test('destroy 清理帧与定时器', () => {
  const { canvas } = makeCanvas()
  const renderer = createRenderer(canvas, CONFIG, () => {})
  renderer.destroy()
  assert.equal(pendingFrames.size, 0, 'destroy 后不应残留帧')
  assert.equal(intervalCleared, true, 'destroy 应清掉看门狗')
})
