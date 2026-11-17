/**
 * 六支算法的冒烟测试：建实例、推进若干步、检查亮度场有限且落在 [0,1]。
 * 抓的是运行期错误（未定义变量、NaN、长度对不上），不是画面审美。
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

const bundle = loaded.get('dsh-pixel-wallpaper')
const { algorithmIds, algorithmOf } = bundle.__internals

const COLS = 48
const ROWS = 32

for (const id of algorithmIds()) {
  test(`算法 ${id}：推进 10 步后亮度场有限且在 [0,1]`, () => {
    const def = algorithmOf(id)
    const inst = def.create({ cols: COLS, rows: ROWS, seed: 7, params: {} })
    assert.equal(inst.field.length, COLS * ROWS, '场长度应等于 cols*rows')
    for (let i = 0; i < 10; i++) inst.step(1 / 30)
    for (let i = 0; i < inst.field.length; i++) {
      const v = inst.field[i]
      assert.ok(Number.isFinite(v), `field[${i}] 不应是 ${v}`)
      assert.ok(v >= -1e-6 && v <= 1 + 1e-6, `field[${i}]=${v} 应在 [0,1]`)
    }
  })
}

test('噪声场：换种子会换图案', () => {
  const def = algorithmOf('noise')
  const a = def.create({ cols: COLS, rows: ROWS, seed: 1, params: {} })
  const b = def.create({ cols: COLS, rows: ROWS, seed: 2, params: {} })
  let diff = 0
  for (let i = 0; i < a.field.length; i++) diff += Math.abs(a.field[i] - b.field[i])
  assert.ok(diff > 1, `不同种子的噪声场应明显不同（差值 ${diff}）`)
})
