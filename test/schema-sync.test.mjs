/**
 * 服务端校验用的参数 schema 必须与客户端注册表一致。
 * 两边漂移会导致「设置页能改、保存后被丢弃」。
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

const client = loaded.get('dsh-pixel-wallpaper').__internals
const server = require('../src/config.js')

test('服务端与客户端使用同一份算法参数 schema', () => {
  assert.deepEqual(server.ALGORITHM_IDS.slice().sort(), client.algorithmIds().slice().sort())
  for (const id of client.algorithmIds()) {
    assert.deepEqual(
      server.ALGORITHM_SCHEMAS[id],
      client.algorithmOf(id).schema,
      `${id} 的参数 schema 与服务端不一致（先跑 npm run build）`
    )
  }
})

test('鸟群新参数能通过服务端 sanitize 并保留', () => {
  const out = server.sanitize({
    algorithm: { id: 'boids', seed: 1, params: { agents: 120, separation: 2.4, alignment: 0.4, cohesion: 1.5 } }
  })
  assert.equal(out.algorithm.params.agents, 120)
  assert.equal(out.algorithm.params.separation, 2.4)
  assert.equal(out.algorithm.params.alignment, 0.4)
  assert.equal(out.algorithm.params.cohesion, 1.5)
})
