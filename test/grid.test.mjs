/**
 * 网格几何纯函数单元测试（DESIGN.md §13.3 列出的视口与固定格宽档位）。
 *
 * 重点钉死四件事：
 * 1. 1920×1080@1 默认 5px / 0.8px → 331×186、cell 5；2560/3440 宽度的 sanity 数值；
 * 2. dpr 1.25 / 1.5 下 cell/dpr 仍等于配置的 CSS 格宽（不取整）；
 * 3. 定位固定格宽：首格 0、末格贴边、相邻缝恒定；gap=0 时余量自然摊成亚像素缝；
 * 4. count=1 边界：size = min(cell, extent)。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// 直接加载 bundle，用假 __ModuleLoader__ 拿 __internals（纯函数无 DOM 依赖）。
// factory 的 require 只请求 'react'，给一个假实现即可。
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
const { computeManualGrid, computePositions } = bundle.__internals

/** 断言首格贴 0、末格贴边。 */
function assertEdges(extent, positions) {
  assert.ok(Math.abs(positions[0].pos) < 1e-9, '首格应贴 0')
  const last = positions[positions.length - 1]
  assert.ok(Math.abs(last.pos + last.size - extent) < 1e-6, '末格右缘应贴边')
}

test('默认 5px / 0.8px @1920×1080@1：331 × 186、cell 5', () => {
  const g = computeManualGrid(1920, 1080, 1, 5, 0.8)
  assert.equal(g.cols, 331)
  assert.equal(g.rows, 186)
  assert.equal(g.cell, 5)
  assert.ok(g.gx > 0 && g.gy > 0, '实际缝应为正')
  assertEdges(1920, computePositions(1920, g.cols, g.cell))
  assertEdges(1080, computePositions(1080, g.rows, g.cell))
})

test('sanity：2560×1440 → 441 × 248，3440×1440 → 593 × 248', () => {
  const wqhd = computeManualGrid(2560, 1440, 1, 5, 0.8)
  assert.equal(wqhd.cols, 441)
  assert.equal(wqhd.rows, 248)
  const uw = computeManualGrid(3440, 1440, 1, 5, 0.8)
  assert.equal(uw.cols, 593)
  assert.equal(uw.rows, 248)
})

test('dpr 1.25 / 1.5：cell 不取整，cell/dpr 仍等于配置的 5 CSS px', () => {
  for (const dpr of [1.25, 1.5]) {
    const g = computeManualGrid(1920, 1080, dpr, 5, 0.8)
    assert.equal(g.cell, 5 * dpr, `dpr=${dpr} 时 cell 应保留亚像素`)
    assert.equal(g.cell / dpr, 5)
    assertEdges(1920, computePositions(1920, g.cols, g.cell))
    assertEdges(1080, computePositions(1080, g.rows, g.cell))
  }
})

test('固定格宽定位：相邻缝恒等，不被整数栅格量化', () => {
  const g = computeManualGrid(1920, 1080, 1, 5, 0.8)
  const pos = computePositions(1920, g.cols, g.cell)
  const expect = (1920 - g.cols * g.cell) / (g.cols - 1)
  for (let i = 1; i < pos.length; i++) {
    const gap = pos[i].pos - (pos[i - 1].pos + pos[i - 1].size)
    assert.ok(Math.abs(gap - expect) < 1e-9, `缝应恒为 ${expect}，实际 ${gap}`)
    assert.equal(pos[i].size, g.cell, '每格宽应恒为 cell')
  }
})

test('gap=0：整除时无缝，不整除时余量摊成亚像素缝', () => {
  const exact = computeManualGrid(1920, 1080, 1, 5, 0)
  assert.equal(exact.cols, 384)
  assert.equal(exact.gx, 0)
  const exactPos = computePositions(1920, exact.cols, exact.cell)
  assertEdges(1920, exactPos)
  for (let i = 1; i < exactPos.length; i++) {
    assert.ok(Math.abs(exactPos[i].pos - (exactPos[i - 1].pos + exactPos[i - 1].size)) < 1e-9, '整除时应无缝')
  }

  const odd = computeManualGrid(1000, 700, 1, 7, 0)
  assert.equal(odd.cols, 142, 'round(1000/7)=143 会越界，应递减到 142')
  assert.ok(odd.gx > 0, '余量应摊成亚像素缝')
  const oddPos = computePositions(1000, odd.cols, odd.cell)
  assertEdges(1000, oddPos)
  for (let i = 1; i < oddPos.length; i++) {
    assert.ok(oddPos[i].pos >= oddPos[i - 1].pos + oddPos[i - 1].size, '格子不应重叠')
  }
})

test('count=1 边界：size = min(cell, extent)', () => {
  assert.deepEqual(computePositions(100, 1, 5), [{ pos: 0, size: 5 }])
  assert.deepEqual(computePositions(3, 1, 5), [{ pos: 0, size: 3 }])
})

test('大格窄窗：不重叠、不崩', () => {
  const g = computeManualGrid(70, 70, 1, 40, 1)
  assert.ok(g.cols >= 1 && g.rows >= 1)
  const xPos = computePositions(70, g.cols, g.cell)
  if (g.cols > 1) assertEdges(70, xPos)
  else assert.equal(xPos[0].size, Math.min(g.cell, 70))
  for (let i = 1; i < xPos.length; i++) {
    assert.ok(xPos[i].pos >= xPos[i - 1].pos + xPos[i - 1].size, '格子不应重叠')
  }
})
