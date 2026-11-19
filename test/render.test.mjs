/**
 * 渲染纯函数测试：透明度混合（默认 90% 透明，只保留 10%）。
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

const internals = loaded.get('dsh-pixel-wallpaper').__internals
const { fadeToBackground } = internals

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

test('withDefaults 用默认值补齐旧宿主返回的配置', () => {
  const { withDefaults } = internals
  const merged = withDefaults({
    coverage: { input: true },
    render: { levels: 4, palette: ['#000', '#fff'] },
    algorithm: { id: 'flow' }
  })
  assert.equal(merged.render.levels, 4)
  assert.equal(merged.render.transparency, 90)
  assert.equal(merged.render.background, '#141414')
  assert.equal(merged.coverage.input, true)
  assert.equal(merged.coverage.header, true)
  assert.equal(merged.algorithm.id, 'flow')
  assert.equal(merged.algorithm.seed, 1337)
  // 网格迁移：缺省回退 5/0.8，旧 auto 的 null 也回退，旧 manual 值原样保留。
  assert.deepEqual(merged.grid, { cellWidth: 5, gap: 0.8 })
  assert.deepEqual(withDefaults({ grid: { mode: 'auto', cellWidth: null, gap: null } }).grid, { cellWidth: 5, gap: 0.8 })
  assert.deepEqual(withDefaults({ grid: { mode: 'manual', cellWidth: 9, gap: 1 } }).grid, { cellWidth: 9, gap: 1 })
})

test('resolveInitialConfig：有 live 配置优先，避免挂载时读回旧值', () => {
  const { resolveInitialConfig } = internals
  // 场景：刚把格宽改成 6，PUT 还在防抖中，切回设置页应直接用 live 的 6。
  const live = resolveInitialConfig({ grid: { cellWidth: 6, gap: 0.8 }, render: { levels: 5 } })
  assert.equal(live.needsFetch, false, '有 live 配置时不应再 GET')
  assert.equal(live.config.grid.cellWidth, 6)
  assert.equal(live.config.render.levels, 5)
  assert.equal(live.config.render.transparency, 90, 'live 配置也要用 withDefaults 补齐')

  // 没有 live 配置（画布未启动）时才需要 GET。
  assert.deepEqual(resolveInitialConfig(null), { config: null, needsFetch: true })
})
