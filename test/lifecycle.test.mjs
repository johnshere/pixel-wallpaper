/**
 * 卸载残留回归：插件禁用/卸载后，模块级 rendererConfig、runtime.renderer、
 * runtime.observer、runtime.regions 必须复位，否则设置页重挂载会拿到旧 live 配置。
 *
 * startRenderer 全环境较重，这里直接验证 resetRendererState 的复位与幂等；
 * cleanup 里对它的调用由 dpr/lifecycle 的行为测试与实现共同保证。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const fakeReact = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  Fragment: 'f'
}

const loaded = new Map()
globalThis.window = {
  innerWidth: 800,
  innerHeight: 600,
  devicePixelRatio: 1,
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded.set(id, factory((specifier) => (specifier === 'react' ? fakeReact : null)))
    }
  }
}
globalThis.document = {
  body: null,
  addEventListener: () => {},
  removeEventListener: () => {}
}
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.performance = { now: () => 0 }

require('../client/bundle.js')
const client = loaded.get('dsh-pixel-wallpaper')
const internals = client.__internals

const blankRegions = () => ({ header: false, left: false, right: false, input: false })
const renderer = { updateConfig() {}, destroy() {} }
const observer = { disconnect() {} }

test('resetRendererState 清空 renderer / observer / regions / rendererConfig', () => {
  internals.setRuntimeStateForTest({
    renderer,
    observer,
    regions: { header: true, left: true, right: true, input: true },
    rendererConfig: { version: 4, grid: { cellWidth: 5, gap: 0.8 } }
  })

  const before = internals.runtimeState()
  assert.equal(before.renderer, renderer)
  assert.equal(before.observer, observer)
  assert.deepEqual(before.regions, { header: true, left: true, right: true, input: true })
  assert.ok(before.rendererConfig)

  // 快照是副本：改它不能污染运行时
  before.regions.header = false
  assert.equal(internals.runtimeState().regions.header, true)

  internals.resetRendererState()

  const after = internals.runtimeState()
  assert.equal(after.renderer, null, 'runtime.renderer 应复位')
  assert.equal(after.observer, null, 'runtime.observer 应复位')
  assert.equal(after.owner, null, 'runtime.owner 应复位')
  assert.deepEqual(after.regions, blankRegions(), 'runtime.regions 应全 false')
  assert.equal(after.rendererConfig, null, 'rendererConfig 应复位')

  // 幂等：重复清理不抛错、状态保持干净
  assert.doesNotThrow(() => internals.resetRendererState())
  assert.deepEqual(internals.runtimeState(), {
    renderer: null,
    observer: null,
    owner: null,
    regions: blankRegions(),
    rendererConfig: null
  })
})

test('未设置过的运行时状态复位后仍是干净默认值', () => {
  internals.resetRendererState()
  assert.deepEqual(internals.runtimeState(), {
    renderer: null,
    observer: null,
    owner: null,
    regions: blankRegions(),
    rendererConfig: null
  })
})

test('旧 owner 的 cleanup 不清新实例状态；只有当前 owner 能复位', () => {
  const oldOwner = {}
  const newOwner = {}
  const newRenderer = { updateConfig() {}, destroy() {} }
  const newObserver = { disconnect() {} }
  const live = { version: 4, marker: 'new' }

  internals.setRuntimeStateForTest({
    owner: newOwner,
    renderer: newRenderer,
    observer: newObserver,
    regions: { header: true, left: false, right: true, input: false },
    rendererConfig: live
  })

  // 旧实例的 cleanup 晚到：不能动新实例的 renderer / observer / live 配置。
  assert.equal(internals.resetRendererState(oldOwner), false, '旧 owner 不应获准复位')
  let now = internals.runtimeState()
  assert.equal(now.owner, newOwner)
  assert.equal(now.renderer, newRenderer)
  assert.equal(now.observer, newObserver)
  assert.equal(now.rendererConfig, live)
  assert.deepEqual(now.regions, { header: true, left: false, right: true, input: false })

  // 当前 owner 可以复位；之后再以旧 owner 重复调用也不会误伤。
  assert.equal(internals.resetRendererState(newOwner), true, '当前 owner 应获准复位')
  now = internals.runtimeState()
  assert.equal(now.owner, null)
  assert.equal(now.renderer, null)
  assert.equal(now.observer, null)
  assert.equal(now.rendererConfig, null)
  assert.equal(internals.resetRendererState(newOwner), false, '已复位后重复 cleanup 应为 no-op')
})

test('trackConfig：renderer 销毁后迟到的配置不回写 rendererConfig、不调用原函数', () => {
  internals.resetRendererState()
  let calls = 0
  const fake = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    updateConfig() { calls++ }
  }
  internals.trackConfig(fake)

  const live = { version: 4, marker: 'live' }
  fake.updateConfig(live)
  assert.equal(calls, 1, '正常时调用原 updateConfig')
  assert.equal(internals.runtimeState().rendererConfig, live)

  fake.destroyed = true
  fake.updateConfig({ version: 4, marker: 'late' })
  assert.equal(calls, 1, '销毁后不调用原 updateConfig')
  assert.equal(internals.runtimeState().rendererConfig, live, '销毁后不回写 rendererConfig')
})

test('trackConfig：旧 renderer 的迟到配置不覆盖新实例 live 配置', () => {
  internals.resetRendererState()
  const newRenderer = { updateConfig() {}, destroy() {} }
  const live = { version: 4, marker: 'new-live' }
  internals.setRuntimeStateForTest({ renderer: newRenderer, rendererConfig: live })

  let calls = 0
  const oldRenderer = {
    isDestroyed: () => false,
    updateConfig() { calls++ }
  }
  internals.trackConfig(oldRenderer, {})

  oldRenderer.updateConfig({ version: 4, marker: 'old-late' })
  assert.equal(calls, 0, '已不是当前 runtime.renderer 时不应调用原 updateConfig')
  assert.equal(internals.runtimeState().rendererConfig, live, '旧实例不得覆盖新 live 配置')
})

test('debounce.cancel：取消排队中的重测，迟到回调不执行', async () => {
  let calls = 0
  const scheduleMeasure = internals.debounce(() => { calls++ }, 300)
  scheduleMeasure()
  scheduleMeasure.cancel()
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(calls, 0, 'cancel 后排队中的回调不应执行')

  scheduleMeasure()
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(calls, 1, '未取消时仍正常执行')
})
