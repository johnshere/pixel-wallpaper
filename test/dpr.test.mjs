/**
 * 回归：DPR 监听必须精确到当前 dpr。
 * 旧实现只监听 `(resolution: 1dppx)`，1.25 → 1.5 这种「非 1x 之间」的变化
 * 不会触发，画面会停在旧 dpr 的网格上。
 *
 * 用 fake matchMedia 记录每次绑定；setDpr 更新 devicePixelRatio 并向旧 mq
 * 派发 change，模拟浏览器行为。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/* ── fake window / document / ResizeObserver / matchMedia ─────────────── */

const mediaQueries = []
const windowListeners = new Map()

function createMediaQuery(query) {
  const listeners = new Set()
  return {
    media: query,
    listeners,
    addEventListener(type, fn) {
      if (type === 'change') listeners.add(fn)
    },
    removeEventListener(type, fn) {
      if (type === 'change') listeners.delete(fn)
    },
    // 老浏览器回退路径也一并支持
    addListener(fn) { listeners.add(fn) },
    removeListener(fn) { listeners.delete(fn) },
    dispatchChange() {
      for (const fn of [...listeners]) fn({ matches: false, media: query })
    }
  }
}

const resizeObservers = []
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = []
    this.disconnected = false
    resizeObservers.push(this)
  }
  observe(target) { this.targets.push(target) }
  disconnect() { this.disconnected = true; this.targets = [] }
}

const fakeReact = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  Fragment: 'f'
}

globalThis.ResizeObserver = FakeResizeObserver
globalThis.window = {
  innerWidth: 800,
  innerHeight: 600,
  devicePixelRatio: 1,
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) {
    if (windowListeners.has(type)) windowListeners.get(type).delete(fn)
  },
  dispatchEvent(event) {
    for (const fn of [...(windowListeners.get(event.type) || [])]) fn(event)
  },
  matchMedia(query) {
    const mq = createMediaQuery(query)
    mediaQueries.push(mq)
    return mq
  },
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded.set(id, factory((specifier) => (specifier === 'react' ? fakeReact : null)))
    }
  }
}
globalThis.document = {
  documentElement: {},
  body: null,
  addEventListener: () => {},
  removeEventListener: () => {}
}
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.performance = { now: () => 0 }

const loaded = new Map()
require('../client/bundle.js')
const client = loaded.get('dsh-pixel-wallpaper')

/** 模拟浏览器 dpr 变化：更新属性，并向与旧 dpr 对应的 mq 派发 change。 */
function setDpr(next) {
  const previous = globalThis.window.devicePixelRatio
  globalThis.window.devicePixelRatio = next
  const old = mediaQueries.find(
    (mq) => mq.media === `(resolution: ${previous}dppx)` && mq.listeners.size > 0
  )
  if (old) old.dispatchChange()
}

const baseConfig = () => ({
  version: 4,
  grid: { cellWidth: 5, gap: 0.8 },
  render: {},
  animation: { playing: true, speed: 1 },
  algorithm: { id: 'boids', seed: 1, params: {} },
  coverage: {}
})

/** 当前仍持有 change 监听的 mq 查询串。 */
const activeQueries = () =>
  mediaQueries.filter((mq) => mq.listeners.size > 0).map((mq) => mq.media)

test('按当前 dpr 绑定，并在 1 → 1.25 → 1.5 → 1 每次变化后重绑 + refresh', () => {
  const counter = { updates: 0 }
  const renderer = { updateConfig: () => { counter.updates++ } }
  const dispose = client.__internals.setupResizeHandlers(renderer, baseConfig())
  assert.equal(typeof dispose, 'function')

  assert.deepEqual(activeQueries(), ['(resolution: 1dppx)'], '启动时绑定当前 dpr')
  assert.equal(counter.updates, 0, '绑定本身不触发重算')

  setDpr(1.25)
  assert.equal(counter.updates, 1, '1 → 1.25 应触发')
  assert.deepEqual(activeQueries(), ['(resolution: 1.25dppx)'])

  setDpr(1.5)
  assert.equal(counter.updates, 2, '1.25 → 1.5 也必须触发（原缺口）')
  assert.deepEqual(activeQueries(), ['(resolution: 1.5dppx)'])

  setDpr(1)
  assert.equal(counter.updates, 3, '1.5 → 1 应触发')
  assert.deepEqual(activeQueries(), ['(resolution: 1dppx)'])

  dispose()
  assert.deepEqual(activeQueries(), [], 'dispose 后不残留 mq 监听')
  assert.equal(windowListeners.get('resize').size, 0, 'dispose 后不残留 window resize 监听')
  assert.equal(resizeObservers.at(-1).disconnected, true, 'dispose 后 ResizeObserver 已断开')

  const before = counter.updates
  setDpr(1.25)
  assert.equal(counter.updates, before, 'dispose 后 dpr 变化不应再触发')

  // 重复清理安全
  assert.doesNotThrow(() => dispose())
})

test('window resize 兜底：只改 dpr、不派发 media change 也能重绑 + refresh', () => {
  const counter = { updates: 0 }
  const renderer = { updateConfig: () => { counter.updates++ } }
  const dispose = client.__internals.setupResizeHandlers(renderer, baseConfig())
  assert.equal(counter.updates, 0)

  // 不派发 mq change，只有 resize 事件（跨屏/缩放的部分浏览器行为）
  globalThis.window.devicePixelRatio = 2
  globalThis.window.dispatchEvent({ type: 'resize' })

  assert.equal(counter.updates, 1, 'resize 时 dpr 变化应重算')
  assert.deepEqual(activeQueries(), ['(resolution: 2dppx)'], '并重绑到新 dpr')

  dispose()
})

test('没有 live 配置时用 seedConfig 重算（seedConfig 不再是死参数）', () => {
  const seen = []
  const renderer = { updateConfig: (config) => { seen.push(config) } }
  const seed = baseConfig()
  const dispose = client.__internals.setupResizeHandlers(renderer, seed)

  setDpr(1.5)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], seed, 'GET 未返回时应使用启动初始配置')

  dispose()
})

test('dispose 取消排队中的 ResizeObserver 重算，不会污染已复位的 live 配置', async () => {
  const counter = { updates: 0 }
  const renderer = { updateConfig: () => { counter.updates++ } }
  client.__internals.setRuntimeStateForTest({ rendererConfig: { marker: 'stale' } })

  const dispose = client.__internals.setupResizeHandlers(renderer, baseConfig())
  const ro = resizeObservers.at(-1)

  // 卸载前已排队一次 300ms 重算；dispose 应取消它。
  ro.callback()
  dispose()
  client.__internals.resetRendererState()
  // 卸载后即使 RO 再回调，refresh 也必须直接返回。
  ro.callback()

  await new Promise((resolve) => setTimeout(resolve, 350))

  assert.equal(counter.updates, 0, 'dispose 后排队/迟到的 RO 回调不应再 updateConfig')
  assert.equal(client.__internals.runtimeState().rendererConfig, null, '不得回写残留配置')
})
