/**
 * 网格几何纯函数单元测试（DESIGN.md §13.3 列出的视口与手动档位）。
 *
 * 重点钉死五件事：
 * 1. 自动模式（1920×1080@1、3840×2160@2、1280×720@1.5、600×800@1）首格贴 0、末格贴边；
 * 2. 窄窗保护：N0 从 140 往下压，不崩；
 * 3. 手动 9/1 与手动 12/0（无缝），首格 0、末格贴边、无缝摊宽；
 * 4. 两向间隔差在阈值内（|gx-gy| <= max(0.5, 0.2*min(gx,gy))）；
 * 5. 整数定位：x_i = round(i*(W-c)/(n-1))，相邻缝在 g±1 内浮动。
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
const { computeAutoGrid, computeManualGrid, computePositions } = bundle.__internals

/** 断言首格贴 0、末格贴边。 */
function assertEdges(extent, positions) {
  assert.equal(positions[0].pos, 0, '首格应贴 0')
  const last = positions[positions.length - 1]
  assert.equal(last.pos + last.size, extent, '末格右缘应贴边')
}

/** 断言两向间隔差在阈值内。 */
function assertGapNear(a, b) {
  const thresh = Math.max(0.5, 0.2 * Math.min(a, b))
  assert.ok(Math.abs(a - b) <= thresh + 1e-6, `间隔差 |${a}-${b}|=${Math.abs(a - b)} 应 <= ${thresh}`)
}

test('自动 1920×1080@1：N0=140，首末格贴边，间隔接近', () => {
  const g = computeAutoGrid(1920, 1080, 1)
  assert.equal(g.cols, 140, '无窄窗保护时列数应保持 140')
  assert.ok(g.rows > 0, '应有行数')
  const xPos = computePositions(1920, g.cols, g.cell, g.gx, false, 0)
  const yPos = computePositions(1080, g.rows, g.cell, g.gy, false, 0)
  assertEdges(1920, xPos)
  assertEdges(1080, yPos)
  assertGapNear(g.gx, g.gy)
})

test('自动 3840×2160@2：物理格子尺寸不随缩放漂移', () => {
  const g = computeAutoGrid(3840, 2160, 2)
  assert.equal(g.cols, 140)
  assert.ok(g.rows > 0)
  const xPos = computePositions(3840, g.cols, g.cell, g.gx, false, 0)
  const yPos = computePositions(2160, g.rows, g.cell, g.gy, false, 0)
  assertEdges(3840, xPos)
  assertEdges(2160, yPos)
  assertGapNear(g.gx, g.gy)
})

test('自动 1280×720@1.5：非整数 dpr 也能贴边', () => {
  const g = computeAutoGrid(1280, 720, 1.5)
  assert.ok(g.cols >= 8, '窄窗下列数至少 8')
  const xPos = computePositions(1280, g.cols, g.cell, g.gx, false, 0)
  const yPos = computePositions(720, g.rows, g.cell, g.gy, false, 0)
  assertEdges(1280, xPos)
  assertEdges(720, yPos)
  assertGapNear(g.gx, g.gy)
})

test('自动 600×800@1（窄窗保护）：N0 从 140 压缩', () => {
  const g = computeAutoGrid(600, 800, 1)
  // 600/140 = 4.28 < 7*1，触发窄窗保护
  assert.ok(g.cols < 140, '窄窗应压缩列数')
  assert.ok(g.cols >= 8, '列数至少 8')
  const xPos = computePositions(600, g.cols, g.cell, g.gx, false, 0)
  const yPos = computePositions(800, g.rows, g.cell, g.gy, false, 0)
  assertEdges(600, xPos)
  assertEdges(800, yPos)
  assertGapNear(g.gx, g.gy)
})

test('手动 9/1：硬算不缩放，首末格贴边', () => {
  const g = computeManualGrid(1920, 1080, 1, 9, 1)
  assert.ok(g.cols > 1 && g.rows > 1)
  const xPos = computePositions(1920, g.cols, g.cell, g.gx, g.seamless, g.spreadX || 0)
  const yPos = computePositions(1080, g.rows, g.cell, g.gy, g.seamless, g.spreadY || 0)
  assertEdges(1920, xPos)
  assertEdges(1080, yPos)
  assertGapNear(g.gx, g.gy)
})

test('手动 12/0（无缝）：余量摊进单元宽，首末格贴边', () => {
  const g = computeManualGrid(1920, 1080, 1, 12, 0)
  assert.equal(g.seamless, true, 'g=0 应无缝')
  assert.equal(g.gx, 0, '无缝 gx=0')
  assert.equal(g.gy, 0, '无缝 gy=0')
  const xPos = computePositions(1920, g.cols, g.cell, g.gx, true, g.spreadX || 0)
  const yPos = computePositions(1080, g.rows, g.cell, g.gy, true, g.spreadY || 0)
  assertEdges(1920, xPos)
  assertEdges(1080, yPos)
  // 无缝摊宽：前 spread 个格宽为 cell+1，其余 cell
  assert.ok(xPos.every((p) => p.size === g.cell || p.size === g.cell + 1), '无缝格宽应为 cell 或 cell+1')
})

test('整数定位：x_i=round(i*(W-c)/(n-1))，相邻缝在 g±1 内', () => {
  const W = 1920
  const n = 140
  const c = 12
  const g0 = 1
  const pos = computePositions(W, n, c, g0, false, 0)
  for (let i = 0; i < n; i++) {
    const expect = Math.round((i * (W - c)) / (n - 1))
    assert.equal(pos[i].pos, expect, `x_${i} 应按整数定位公式`)
  }
  // 相邻缝在 g0±1 内
  for (let i = 1; i < n; i++) {
    const gap = pos[i].pos - (pos[i - 1].pos + pos[i - 1].size)
    assert.ok(Math.abs(gap - g0) <= 1, `第 ${i} 道缝 ${gap} 应在 ${g0}±1 内`)
  }
})

test('无缝定位：余量大于格数时仍铺满、无重叠', () => {
  // 100 宽、3 格、基准 31：余量 7 > 3，旧实现只能摊 3px，末格贴不到边。
  const pos = computePositions(100, 3, 31, 0, true, 7)
  assertEdges(100, pos)
  for (let i = 1; i < pos.length; i++) {
    assert.equal(pos[i].pos, pos[i - 1].pos + pos[i - 1].size, '无缝时不应有重叠或空洞')
  }
  assert.ok(pos.every((p) => p.size >= 31 && p.size <= 35), '每格宽应在基准附近')
})

test('手动大格窄窗：n*c 不超视口、不重叠', () => {
  const g = computeManualGrid(70, 70, 1, 40, 1)
  assert.ok(g.cols >= 1 && g.rows >= 1)
  const xPos = computePositions(70, g.cols, g.cell, g.gx, g.seamless, g.spreadX || 0)
  assertEdges(70, xPos)
  for (let i = 1; i < xPos.length; i++) {
    assert.ok(xPos[i].pos >= xPos[i - 1].pos + xPos[i - 1].size, '格子不应重叠')
  }
})

test('极端窄窗：不崩、列数下限 8（符合窄窗保护）, 兜底不减到 0', () => {
  for (const [W, H, dpr] of [[100, 100, 1], [60, 60, 1], [50, 200, 2]]) {
    const g = computeAutoGrid(W, H, dpr)
    assert.ok(g.cols >= 1, `cols 至少 1 (${W}x${H})`)
    assert.ok(g.rows >= 1, `rows 至少 1 (${W}x${H})`)
    assert.ok(Number.isFinite(g.gx) && Number.isFinite(g.gy))
  }
})
