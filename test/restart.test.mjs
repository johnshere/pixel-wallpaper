/**
 * 二级参数变化必须重建算法实例（= 从种子重置），否则改参数后画面不会重来。
 * 用探针算法直接数 create 调用次数。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const fakeReact = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Fragment: 'f' }
const loaded = new Map()

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
globalThis.document = { body: null, visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null }
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}

globalThis.performance = { now: () => 0 }
require('../client/bundle.js')

const internals = loaded.get('dsh-pixel-wallpaper').__internals

test('二级参数变化重建实例，相同配置不重建', () => {
  let created = 0
  internals.registerAlgorithm({
    id: 'restart-probe',
    label: 'restart-probe',
    desc: '',
    schema: [{ key: 'x', label: 'x', type: 'range', min: 0, max: 10, step: 1, default: 1 }],
    create: ({ cols, rows }) => {
      created++
      return { field: new Float32Array(cols * rows), step() {} }
    }
  })

  const fakeCtx = new Proxy({}, { get: (target, key) => (key === 'canvas' ? canvas : () => {}) })
  const canvas = { width: 0, height: 0, style: {}, getContext: () => fakeCtx, addEventListener: () => {}, removeEventListener: () => {} }
  const base = {
    animation: { playing: true, speed: 1 },
    grid: { mode: 'auto', cellWidth: null, gap: null },
    render: {
      shape: 'square',
      levels: 8,
      palette: ['#1b1b1b', '#c9c9c9'],
      gamma: 1,
      black: 0,
      white: 100,
      dither: 'none',
      background: '#141414',
      transparency: 0
    },
    algorithm: { id: 'restart-probe', seed: 1, params: { x: 1 } },
    coverage: {}
  }

  const renderer = internals.createRenderer(canvas, base)
  assert.equal(created, 1)

  renderer.updateConfig(structuredClone(base))
  assert.equal(created, 1, '配置没变不应重建')

  const changed = structuredClone(base)
  changed.algorithm.params.x = 5
  renderer.updateConfig(changed)
  assert.equal(created, 2, '参数变化应重建实例')

  const seeded = structuredClone(base)
  seeded.algorithm.seed = 99
  renderer.updateConfig(seeded)
  assert.equal(created, 3, '种子变化应重建实例')

  renderer.destroy()
})
