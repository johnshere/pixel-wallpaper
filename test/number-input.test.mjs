/**
 * 数字输入框提交逻辑（normalizeNumberInput）单元测试。
 * 空串 / NaN 回退当前值，超范围 clamp，正常小数原样保留。
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

const { normalizeNumberInput } = loaded.get('dsh-pixel-wallpaper').__internals

test('normalizeNumberInput：空串 / 空白 / NaN 回退当前值', () => {
  assert.equal(normalizeNumberInput('', 5, 3, 20), 5)
  assert.equal(normalizeNumberInput('   ', 5, 3, 20), 5)
  assert.equal(normalizeNumberInput('abc', 5, 3, 20), 5)
  assert.equal(normalizeNumberInput(NaN, 5, 3, 20), 5)
})

test('normalizeNumberInput：超范围 clamp 到 min / max', () => {
  assert.equal(normalizeNumberInput('999', 5, 3, 20), 20)
  assert.equal(normalizeNumberInput('0', 5, 3, 20), 3)
  assert.equal(normalizeNumberInput('-1', 0.8, 0, 8), 0)
})

test('normalizeNumberInput：正常小数与整数原样通过', () => {
  assert.equal(normalizeNumberInput('5.5', 5, 3, 20), 5.5)
  assert.equal(normalizeNumberInput('0.8', 0.8, 0, 8), 0.8)
  assert.equal(normalizeNumberInput('12', 5, 3, 20), 12)
  assert.equal(normalizeNumberInput(7.25, 5, 3, 20), 7.25)
})
