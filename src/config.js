'use strict'

/**
 * 像素背景（pixel-wallpaper）—— 配置存取
 *
 * 与 title-wheel 同样的取舍：不依赖 ctx.settings / schemastery（link 安装时从插件
 * 目录向上找不到 @deepseek-ai 包），直接用一个 JSON 文件做唯一配置源。
 * 宿主侧与浏览器侧各做一次 sanitize，非法值 clamp/回退，绝不抛错。
 *
 * 存储位置：`$DSH_HOME/pixel-wallpaper/config.json`（原子写：临时文件 + rename）。
 *
 * @module pixel-wallpaper/config
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 可选的算法 id。 */
const ALGORITHM_IDS = ['boids', 'flow', 'reaction', 'noise', 'waves', 'attractor']

/** 可选的形状。 */
const SHAPES = ['square', 'rounded', 'dot']

/** 可选的抖动方式。 */
const DITHERS = ['none', 'bayer4', 'floyd']

/** 网格模式。 */
const GRID_MODES = ['auto', 'manual']

/**
 * 默认配置（首次安装值，与 DESIGN.md §8 完全一致）。
 */
const DEFAULT_CONFIG = Object.freeze({
  version: 2,
  coverage: { header: true, left: true, right: true, input: false },
  grid: { mode: 'auto', cellWidth: null, gap: null },
  render: {
    shape: 'square',
    levels: 8,
    palette: ['#1b1b1b', '#c9c9c9'],
    gamma: 1.0,
    black: 0,
    white: 100,
    dither: 'none',
    background: '#141414'
  },
  animation: { playing: true, speed: 1 },
  algorithm: { id: 'boids', seed: 1337, params: {} }
})

/**
 * 数值 / 枚举字段的合法区间（非法一律 clamp / 回退，不抛错）。
 * 与 DESIGN.md §8 的校验表一致。
 */
const LIMITS = Object.freeze({
  cellWidth: [2, 40],
  gap: [0, 20],
  levels: [2, 16],
  gamma: [0.4, 2.0],
  black: [0, 30],
  white: [70, 100],
  speed: [0.25, 2],
  seed: [0, 999999]
})

/** 六支算法的参数 schema（设置页据此自动生成二级参数）。 */
const ALGORITHM_SCHEMAS = Object.freeze({
  boids: Object.freeze([
    { key: 'agents', label: '智能体数量', type: 'range', min: 60, max: 600, step: 10, default: 280 },
    { key: 'speed', label: '速度', type: 'range', min: 0.4, max: 2.4, step: 0.1, default: 1.2 },
    { key: 'trail', label: '拖尾', type: 'range', min: 0.90, max: 0.995, step: 0.005, default: 0.98 }
  ]),
  flow: Object.freeze([
    { key: 'particles', label: '粒子数量', type: 'range', min: 300, max: 3000, step: 100, default: 1200 },
    { key: 'scale', label: '尺度', type: 'range', min: 0.6, max: 6, step: 0.1, default: 1.8 },
    { key: 'trail', label: '拖尾', type: 'range', min: 0.90, max: 0.995, step: 0.005, default: 0.975 }
  ]),
  reaction: Object.freeze([
    { key: 'feed', label: '补给率', type: 'range', min: 0.010, max: 0.080, step: 0.001, default: 0.0367 },
    { key: 'kill', label: '消解率', type: 'range', min: 0.040, max: 0.070, step: 0.001, default: 0.0649 },
    { key: 'steps', label: '步数', type: 'range', min: 1, max: 12, step: 1, default: 4 }
  ]),
  noise: Object.freeze([
    { key: 'scale', label: '尺度', type: 'range', min: 0.6, max: 8, step: 0.1, default: 2.2 },
    { key: 'octaves', label: '八度', type: 'range', min: 2, max: 6, step: 1, default: 4 },
    { key: 'warp', label: '扭曲', type: 'range', min: 0, max: 1, step: 0.05, default: 0.35 },
    { key: 'drift', label: '漂移', type: 'range', min: 0, max: 1, step: 0.05, default: 0.15 }
  ]),
  waves: Object.freeze([
    { key: 'sources', label: '波源数', type: 'range', min: 2, max: 12, step: 1, default: 5 },
    { key: 'freq', label: '频率', type: 'range', min: 0.5, max: 6, step: 0.1, default: 2.2 },
    { key: 'speed', label: '速度', type: 'range', min: 0, max: 2, step: 0.1, default: 0.8 },
    { key: 'decay', label: '衰减', type: 'range', min: 0, max: 1, step: 0.05, default: 0.3 }
  ]),
  attractor: Object.freeze([
    {
      key: 'type',
      label: '吸引子类型',
      type: 'select',
      options: [
        { value: 'Clifford', label: 'Clifford' },
        { value: 'De Jong', label: 'De Jong' }
      ],
      default: 'Clifford'
    },
    { key: 'a', label: '参数 a', type: 'range', min: -3, max: 3, step: 0.1, default: -1.4 },
    { key: 'b', label: '参数 b', type: 'range', min: -3, max: 3, step: 0.1, default: 1.6 },
    { key: 'c', label: '参数 c', type: 'range', min: -3, max: 3, step: 0.1, default: 1.0 },
    { key: 'd', label: '参数 d', type: 'range', min: -3, max: 3, step: 0.1, default: 0.7 },
    { key: 'points', label: '点数', type: 'range', min: 500, max: 6000, step: 100, default: 2500 }
  ])
})

/** 合法十六进制颜色（#rrggbb 或 #rgb）。 */
const HEX_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/

/** DSH 主目录（测试可注入 DSH_HOME 覆盖）。 */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 配置文件绝对路径。 */
function configFile() {
  return path.join(dshHome(), 'pixel-wallpaper', 'config.json')
}

/**
 * 夹一个数值字段。
 * @param {unknown} value 输入值。
 * @param {string} key LIMITS 的键。
 * @param {number} fallback 非法时的回退值。
 * @param {boolean} integer 是否取整。
 * @returns {number} 合法数值。
 */
function clampNumber(value, key, fallback, integer) {
  const range = LIMITS[key]
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const bounded = range ? Math.min(range[1], Math.max(range[0], n)) : n
  return integer ? Math.round(bounded) : bounded
}

/** 归一化颜色为 #rrggbb（#rgb 展开；非法返回 null）。 */
function normalizeHex(value) {
  const s = String(value || '').trim()
  if (!HEX_RE.test(s)) return null
  if (s.length === 4) {
    // #rgb -> #rrggbb
    const r = s[1]
    const g = s[2]
    const b = s[3]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return s.toLowerCase()
}

/** 校验并归一化调色板（2–8 个合法颜色，不足回退默认）。 */
function sanitizePalette(value) {
  const def = DEFAULT_CONFIG.render.palette.slice()
  if (!Array.isArray(value)) return def
  const out = []
  for (const item of value) {
    const c = normalizeHex(item)
    if (c) out.push(c)
    if (out.length >= 8) break
  }
  if (out.length < 2) return def
  return out
}

/** 校验并归一化网格配置。 */
function sanitizeGrid(value) {
  const def = DEFAULT_CONFIG.grid
  const src = value && typeof value === 'object' ? value : {}
  const mode = GRID_MODES.includes(src.mode) ? src.mode : def.mode
  const cellWidth = src.cellWidth === null || src.cellWidth === undefined ? null : clampNumber(src.cellWidth, 'cellWidth', def.cellWidth, false)
  const gap = src.gap === null || src.gap === undefined ? null : clampNumber(src.gap, 'gap', def.gap, false)
  // 自动模式必须为空；手动模式无效值回退默认。
  const out = { mode }
  if (mode === 'auto') {
    out.cellWidth = null
    out.gap = null
  } else {
    out.cellWidth = cellWidth === null ? 9 : cellWidth
    out.gap = gap === null ? 1 : gap
  }
  return out
}

/** 按某算法 schema 夹参数；未知键丢弃。 */
function sanitizeParams(id, value) {
  const schema = ALGORITHM_SCHEMAS[id]
  const out = {}
  if (!schema) return out
  const src = value && typeof value === 'object' ? value : {}
  for (const field of schema) {
    const raw = src[field.key]
    if (raw === undefined) {
      out[field.key] = field.default
      continue
    }
    if (field.type === 'select') {
      const options = (field.options || []).map((o) => o.value)
      out[field.key] = options.includes(raw) ? raw : field.default
    } else {
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        out[field.key] = field.default
      } else {
        const bounded = Math.min(field.max, Math.max(field.min, n))
        out[field.key] = Number(bounded.toFixed(6))
      }
    }
  }
  return out
}

/** 校验并归一化算法配置。 */
function sanitizeAlgorithm(value) {
  const def = DEFAULT_CONFIG.algorithm
  const src = value && typeof value === 'object' ? value : {}
  const id = ALGORITHM_IDS.includes(src.id) ? src.id : def.id
  return {
    id,
    seed: clampNumber(src.seed, 'seed', def.seed, true),
    params: sanitizeParams(id, src.params)
  }
}

/** 校验并归一化影响范围开关。 */
function sanitizeCoverage(value) {
  const def = DEFAULT_CONFIG.coverage
  const src = value && typeof value === 'object' ? value : {}
  const keys = ['header', 'left', 'right', 'input']
  const out = {}
  for (const key of keys) {
    out[key] = Object.prototype.hasOwnProperty.call(src, key) ? Boolean(src[key]) : def[key]
  }
  return out
}

/** 校验并归一化渲染配置。 */
function sanitizeRender(value) {
  const def = DEFAULT_CONFIG.render
  const src = value && typeof value === 'object' ? value : {}
  const shape = SHAPES.includes(src.shape) ? src.shape : def.shape
  const dither = DITHERS.includes(src.dither) ? src.dither : def.dither
  // black < white 约束：先各自 clamp，再保证间距。
  let black = clampNumber(src.black, 'black', def.black, false)
  let white = clampNumber(src.white, 'white', def.white, false)
  if (black >= white) {
    black = 0
    white = 100
  }
  return {
    shape,
    levels: clampNumber(src.levels, 'levels', def.levels, true),
    palette: sanitizePalette(src.palette),
    gamma: clampNumber(src.gamma, 'gamma', def.gamma, false),
    black,
    white,
    dither,
    background: normalizeHex(src.background) || def.background
  }
}

/** 校验并归一化动画配置。 */
function sanitizeAnimation(value) {
  const def = DEFAULT_CONFIG.animation
  const src = value && typeof value === 'object' ? value : {}
  return {
    playing: Object.prototype.hasOwnProperty.call(src, 'playing') ? Boolean(src.playing) : def.playing,
    speed: clampNumber(src.speed, 'speed', def.speed, false)
  }
}

/**
 * 把任意输入洗成完整合法配置；未知键丢弃，非法值 clamp/回退，绝不抛错。
 * @param {unknown} input 原始配置片段。
 * @returns {object} 完整配置对象。
 */
function sanitize(input) {
  const src = input && typeof input === 'object' ? input : {}
  const render = sanitizeRender(src.render)
  // v1 的默认调色板是纯黑/纯白，换成灰白默认；只迁移一次，不覆盖之后的选择。
  if (Number(src.version) === 1) {
    render.palette = DEFAULT_CONFIG.render.palette.slice()
    render.background = DEFAULT_CONFIG.render.background
  }
  return {
    version: 2,
    coverage: sanitizeCoverage(src.coverage),
    grid: sanitizeGrid(src.grid),
    render,
    animation: sanitizeAnimation(src.animation),
    algorithm: sanitizeAlgorithm(src.algorithm)
  }
}

/** 从磁盘读原始 JSON；文件缺失 / 损坏一律当空配置。 */
function readFile() {
  try {
    const text = fs.readFileSync(configFile(), 'utf8')
    if (!text.trim()) return {}
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** 原子写：先写临时文件再 rename，避免读到半截 JSON。 */
function persist(value) {
  try {
    const file = configFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    // 写盘失败不影响本次运行：内存 cache 已是新值。
  }
}

/** 模块级缓存。 */
let cache = null

/** 读当前配置（带缓存），返回副本。 */
function readConfig() {
  if (!cache) cache = sanitize(readFile())
  return JSON.parse(JSON.stringify(cache))
}

/** 写入配置片段并落盘，返回合并后的完整配置。 */
function writeConfig(patch) {
  const merged = sanitize({ ...readConfig(), ...(patch && typeof patch === 'object' ? patch : {}) })
  cache = merged
  persist(merged)
  return JSON.parse(JSON.stringify(merged))
}

/** 清空缓存（测试用）。 */
function __resetCache() {
  cache = null
}

module.exports = {
  ALGORITHM_IDS,
  ALGORITHM_SCHEMAS,
  DEFAULT_CONFIG,
  LIMITS,
  SHAPES,
  DITHERS,
  GRID_MODES,
  dshHome,
  configFile,
  normalizeHex,
  sanitize,
  sanitizePalette,
  sanitizeGrid,
  sanitizeRender,
  sanitizeCoverage,
  sanitizeAnimation,
  sanitizeAlgorithm,
  sanitizeParams,
  readConfig,
  writeConfig,
  __resetCache
}
