/**
 * 渲染纯函数测试：透明度混合（默认 80% 透明，只保留 20%）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const fakeReact = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Fragment: 'fragment' }
const loaded = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded.set(id, factory((specifier) => (specifier === 'react' ? fakeReact : null)))
    }
  }
}
require('../client/bundle.js')

const { fadeToBackground } = loaded.get('dsh-pixel-wallpaper').__internals

test('透明度 0：颜色不变', () => {
  assert.deepEqual(fadeToBackground([201, 201, 201], [20, 20, 20], 0), [201, 201, 201])
})

test('透明度 80：只保留 20%，朝底色混合', () => {
  const rgb = fadeToBackground([201, 201, 201], [20, 20, 20], 80)
  // 20 + (201-20)*0.2 = 56.2 -> 56
  assert.deepEqual(rgb, [56, 56, 56])
  assert.ok(rgb[0] > 20 && rgb[0] < 80, '仍应比底色亮，但远低于原色')
})

test('透明度 100：完全等于底色；越界被 clamp', () => {
  assert.deepEqual(fadeToBackground([255, 255, 255], [20, 20, 20], 100), [20, 20, 20])
  assert.deepEqual(fadeToBackground([255, 255, 255], [20, 20, 20], 999), [20, 20, 20])
})
