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

test('噪声场：默认映射为主体暗底、亮部少', () => {
  const def = algorithmOf('noise')
  const inst = def.create({ cols: 331, rows: 186, seed: 1337, params: {} })
  let dark = 0
  let bright = 0
  for (let i = 0; i < inst.field.length; i++) {
    const v = inst.field[i]
    assert.ok(Number.isFinite(v), `field[${i}] 不应是 ${v}`)
    if (v < 0.08) dark++
    if (v > 0.5) bright++
  }
  const total = inst.field.length
  const darkRatio = dark / total
  const brightRatio = bright / total
  assert.ok(darkRatio > 0.3, `暗格占比 ${darkRatio.toFixed(3)} 应大于 0.3`)
  assert.ok(brightRatio < 0.15, `亮格占比 ${brightRatio.toFixed(3)} 应小于 0.15`)
})

test('鸟群：默认 80 只、硬上限 200，三个规则权重都可由二级参数覆盖', () => {
  const def = algorithmOf('boids')
  const byKey = new Map(def.schema.map((f) => [f.key, f]))
  assert.equal(byKey.get('agents').default, 80)
  assert.equal(byKey.get('agents').min, 60)
  assert.equal(byKey.get('agents').max, 200)
  for (const key of ['separation', 'alignment', 'cohesion']) {
    assert.ok(byKey.has(key), `schema 应包含 ${key}`)
  }
  assert.equal(byKey.get('separation').default, 1.6)
  assert.equal(byKey.get('alignment').default, 0.9)
  assert.equal(byKey.get('cohesion').default, 0.7)
})

test('鸟群：agents=999 实际只创建 200 只，且每只鸟速度不同', () => {
  const def = algorithmOf('boids')
  const inst = def.create({ cols: COLS, rows: ROWS, seed: 7, params: { agents: 999 } })
  assert.equal(inst.speeds.length, 200, '硬上限 200')
  assert.ok(new Set(inst.speeds).size > 1, '每只鸟速度应不同（可追赶/逃离）')
  for (let i = 0; i < 10; i++) inst.step(1 / 30)
  for (let i = 0; i < inst.field.length; i++) {
    assert.ok(Number.isFinite(inst.field[i]), `field[${i}] 不应是 ${inst.field[i]}`)
  }
})

test('流场：降采样后粒子覆盖 2×2 格，不是单格小点', () => {
  const def = algorithmOf('flow')
  const particles = def.schema.find((f) => f.key === 'particles').default
  assert.equal(particles, 500, '流场粒子默认 500')
  const cols = 331
  const rows = 186
  const fresh = def.create({ cols, rows, seed: 7, params: {} })
  assert.ok(fresh.field.some((v) => v > 0), '初始场应先有点，不能第一帧全黑')
  const inst = def.create({ cols, rows, seed: 7, params: {} })
  for (let i = 0; i < 90; i++) inst.step(1 / 30)

  let nonzero = 0
  let sum = 0
  for (let i = 0; i < inst.field.length; i++) {
    const v = inst.field[i]
    assert.ok(Number.isFinite(v), `field[${i}] 不应是 ${v}`)
    if (v !== 0) nonzero++
    sum += v
  }
  assert.ok(nonzero > particles * 2, `非零格数 ${nonzero} 应明显大于粒子数 ${particles}`)
  assert.ok(
    sum / inst.field.length > 0.05,
    `平均亮度 ${(sum / inst.field.length).toFixed(3)} 过低：拖尾不应被 max 归一化压暗`
  )

  // 最近邻放大：sim 一格对应渲染 2×2 块（右/下边界单列行除外）。
  let mismatch = 0
  let litBlocks = 0
  for (let y = 0; y + 1 < rows; y += 2) {
    for (let x = 0; x + 1 < cols; x += 2) {
      const v = inst.field[y * cols + x]
      if (v > 0) litBlocks++
      if (
        inst.field[y * cols + x + 1] !== v ||
        inst.field[(y + 1) * cols + x] !== v ||
        inst.field[(y + 1) * cols + x + 1] !== v
      ) mismatch++
    }
  }
  assert.equal(mismatch, 0, '2×2 块内亮度应完全相等')
  assert.ok(litBlocks > particles, `亮块数 ${litBlocks} 应超过粒子数`)
})

test('算法实例签名：二级参数改动视为需要重启（重置）', () => {
  const { algorithmSignature } = bundle.__internals
  const base = { id: 'boids', seed: 1, params: { agents: 80, cohesion: 0.7 } }
  assert.equal(algorithmSignature(base), algorithmSignature({ ...base, params: { agents: 80, cohesion: 0.7 } }))
  assert.notEqual(algorithmSignature(base), algorithmSignature({ ...base, params: { agents: 80, cohesion: 1.2 } }))
  assert.notEqual(algorithmSignature(base), algorithmSignature({ ...base, seed: 2 }))
  assert.notEqual(algorithmSignature(base), algorithmSignature({ ...base, id: 'flow' }))
})
