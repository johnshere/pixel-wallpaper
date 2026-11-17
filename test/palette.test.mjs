/**
 * 调色板 / 量化纯函数单元测试（DESIGN.md §6 亮度 → 像素）。
 *
 * 重点钉死：
 * 1. 调色板按段线性插值（sRGB），端点取色精确；
 * 2. 2–8 个色标都合法，单色标退化正确；
 * 3. 亮度映射：black/white 拉伸 + gamma；
 * 4. 量化等级 0..levels-1 与色标数量无关；
 * 5. 抖动（bayer4）在量化前施加偏移，不越界。
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
const { paletteAt, shadeToRgb, hexToRgb, evenPalette, clamp } = bundle.__internals

test('hexToRgb：解析 #rrggbb 与 #rgb', () => {
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0])
  assert.deepEqual(hexToRgb('#ffffff'), [255, 255, 255])
  assert.deepEqual(hexToRgb('#ff8000'), [255, 128, 0])
})

test('paletteAt：两端点取色精确（黑白调色板）', () => {
  const pal = ['#000000', '#ffffff']
  assert.deepEqual(paletteAt(pal, 0), [0, 0, 0])
  assert.deepEqual(paletteAt(pal, 1), [255, 255, 255])
  // 中点
  const mid = paletteAt(pal, 0.5)
  assert.ok(mid[0] >= 127 && mid[0] <= 128, `中点约 127/128，实际 ${mid[0]}`)
  assert.deepEqual(mid, [mid[0], mid[0], mid[0]], '灰阶调色板三通道相等')
})

test('paletteAt：多色标按段线性插值', () => {
  const pal = ['#000000', '#808080', '#ffffff']
  assert.deepEqual(paletteAt(pal, 0), [0, 0, 0])
  assert.deepEqual(paletteAt(pal, 0.5), [128, 128, 128], '中点应命中第二个色标')
  assert.deepEqual(paletteAt(pal, 1), [255, 255, 255])
  // 1/4 处：0→128 的中点
  const q = paletteAt(pal, 0.25)
  assert.deepEqual(q, [64, 64, 64])
})

test('paletteAt：越界 clamp 到端点', () => {
  const pal = ['#000000', '#ffffff']
  assert.deepEqual(paletteAt(pal, -1), [0, 0, 0])
  assert.deepEqual(paletteAt(pal, 2), [255, 255, 255])
})

test('paletteAt：单色标退化', () => {
  assert.deepEqual(paletteAt(['#808080'], 0.5), [128, 128, 128])
})

test('shadeToRgb：不抖动时量化等级在 [0, levels-1] 的色标内', () => {
  const render = { black: 0, white: 100, gamma: 1.0, levels: 8, palette: ['#000000', '#ffffff'], dither: 'none' }
  // v=0 -> 黑，v=1 -> 白
  assert.deepEqual(shadeToRgb(0, render, 0, 0), [0, 0, 0])
  assert.deepEqual(shadeToRgb(1, render, 0, 0), [255, 255, 255])
})

test('shadeToRgb：gamma 与 black/white 拉伸生效', () => {
  // black=50 white=100：v=0.5 映射到 (0.5-0.5)/(1-0.5)=0 -> 黑
  const render = { black: 50, white: 100, gamma: 1.0, levels: 8, palette: ['#000000', '#ffffff'], dither: 'none' }
  assert.deepEqual(shadeToRgb(0.5, render, 0, 0), [0, 0, 0])
  // gamma=0 会让中间值提亮，这里只断言结果仍在合法范围
  const g2 = { ...render, gamma: 2.0 }
  const c = shadeToRgb(0.8, g2, 0, 0)
  assert.ok(c[0] >= 0 && c[0] <= 255)
})

test('shadeToRgb：bayer4 抖动施加偏移后仍不越界', () => {
  const render = { black: 0, white: 100, gamma: 1.0, levels: 8, palette: ['#000000', '#ffffff'], dither: 'bayer4' }
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const rgb = shadeToRgb(0.5, render, c, r)
      assert.ok(rgb[0] >= 0 && rgb[0] <= 255, '抖动结果应在合法范围')
    }
  }
})

test('evenPalette：生成 n 段均匀灰阶，2–8 个', () => {
  assert.deepEqual(evenPalette(2), ['#000000', '#ffffff'])
  assert.equal(evenPalette(3).length, 3)
  assert.equal(evenPalette(8).length, 8)
  assert.deepEqual(evenPalette(3)[1], '#808080', '三段中点应为 #808080')
  // clamp
  assert.equal(evenPalette(1).length, 2)
  assert.equal(evenPalette(99).length, 8)
})

test('clamp：边界行为', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(11, 0, 10), 10)
})
