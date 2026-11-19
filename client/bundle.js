/*! dsh-pixel-wallpaper v0.1.0 | MIT | 构建产物，请勿手改 */
window.__ModuleLoader__.load({
  id: "dsh-pixel-wallpaper",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    /**
     * 像素背景（pixel-wallpaper）—— 客户端
     *
     * 三件事：
     * 1. **画布层**：在 document 注入一块全窗画布（z-index 0、pointer-events none、
     *    body 第一个子节点），铺上算法实时生成的灰白像素格。让 html/body 背景透底，
     *    并把「影响范围」开关对应的区域用 clearRect 挖成透明。
     * 2. **六支算法**：统一接口 `create({cols,rows,seed,params}) -> {field, step}`，
     *    只产出 cols×rows 的 Float32Array 亮度场，不碰颜色/形状/缝隙。
     * 3. **设置页**：配置读写走 /pixel-wallpaper/api/config，任何改动即时作用于画布，
     *    300ms 防抖 PUT，保存失败提示但不回滚。
     *
     * 全部逻辑套在 try/catch 里：任何失败只丢背景，绝不白屏、绝不拖垮设置页其它节。
     * 类名前缀 pw-；宿主只提供 require('react')。
     *
     * @module pixel-wallpaper/client
     */

    const React = require('react')
    const h = React.createElement

    const PLUGIN_ID = 'pixel-wallpaper'
    const API = '/pixel-wallpaper/api'
    const STYLE_ID = 'pixel-wallpaper-style'
    const CANVAS_ID = 'pixel-wallpaper-canvas'
    const CONFIG_EVENT = 'pixel-wallpaper:config'

    /** 固定步长累计器：目标 30fps。 */
    const FRAME_MS = 1000 / 30

    /* ────────────────────────────────────────────────────────────────────────
     * 纯函数：随机源（种子 → mulberry32）
     * ──────────────────────────────────────────────────────────────────────── */

    /**
     * mulberry32：由 32 位种子派生的可复现伪随机源。
     * @param {number} seed 种子（整数）。
     * @returns {() => number} [0,1) 均匀随机函数。
     */
    function mulberry32(seed) {
      let a = seed >>> 0
      return function () {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 纯函数：网格几何（DESIGN.md §5，一切以设备像素计）
     * ──────────────────────────────────────────────────────────────────────── */

    /** 夹到 [lo, hi]。 */
    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v
    }

    /**
     * 固定 CSS 像素格宽网格（DESIGN.md §5.2）。
     * 设备像素空间计算，但 cell / gap 由 CSS px 乘 dpr 得到，**不取整**：
     * 5px@1.25 = 6.25、@1.5 = 7.5 都保留，保证不同缩放下单元格 CSS 尺寸不变。
     * @param {number} Wdev 设备像素宽。
     * @param {number} Hdev 设备像素高。
     * @param {number} dpr 设备像素比。
     * @param {number} cellCss 单元格宽 CSS px。
     * @param {number} gapCss 间隔 CSS px。
     * @returns {{cols:number, rows:number, cell:number, gx:number, gy:number}}
     */
    function computeManualGrid(Wdev, Hdev, dpr, cellCss, gapCss) {
      const cell = cellCss * dpr
      const gap = gapCss * dpr
      if (!(cell > 0)) return { cols: 1, rows: 1, cell: 0, gx: 0, gy: 0 }

      const slot = cell + gap
      let n = Math.max(1, Math.round(Wdev / slot))
      let m = Math.max(1, Math.round(Hdev / slot))
      // round 可能让格子越过视口（尤其窗口刚好在半个步距附近）：逐个递减到放得下。
      while (n > 1 && n * cell + (n - 1) * gap > Wdev) n -= 1
      while (m > 1 && m * cell + (m - 1) * gap > Hdev) m -= 1

      const gx = n > 1 ? (Wdev - n * cell) / (n - 1) : 0
      const gy = m > 1 ? (Hdev - m * cell) / (m - 1) : 0
      return { cols: n, rows: m, cell, gx, gy }
    }

    /**
     * 亚像素定位（DESIGN.md §5.4）：给定边、格数、边长，返回每格起点。
     * 首格贴 0、末格贴边；每格宽恒为 cell，余量自然摊成亚像素缝。
     * @param {number} extent 总长（设备像素）。
     * @param {number} count 格数。
     * @param {number} cell 边长。
     * @returns {Array<{pos:number, size:number}>}
     */
    function computePositions(extent, count, cell) {
      const out = []
      if (count <= 1) {
        out.push({ pos: 0, size: Math.min(cell, extent) })
        return out
      }
      const step = (extent - cell) / (count - 1)
      for (let i = 0; i < count; i++) {
        out.push({ pos: i * step, size: cell })
      }
      return out
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 纯函数：调色板 / 量化（DESIGN.md §6）
     * ──────────────────────────────────────────────────────────────────────── */

    /** 解析 #rrggbb 为 [r,g,b]。 */
    function hexToRgb(hex) {
      const s = String(hex).replace('#', '')
      const full = s.length === 3 ? s.split('').map((x) => x + x).join('') : s
      return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
    }

    /**
     * 由一组色标（暗→亮）在 sRGB 空间按段线性插值取色。
     * @param {Array<string>} palette 2–8 个 #rrggbb。
     * @param {number} t [0,1] 位置。
     * @returns {[number,number,number]} RGB。
     */
    function paletteAt(palette, t) {
      const stops = palette.map(hexToRgb)
      const n = stops.length
      const tt = clamp(t, 0, 1)
      if (n === 1) return stops[0]
      const scaled = tt * (n - 1)
      const i = Math.floor(scaled)
      if (i >= n - 1) return stops[n - 1]
      const frac = scaled - i
      const a = stops[i]
      const b = stops[i + 1]
      return [
        Math.round(a[0] + (b[0] - a[0]) * frac),
        Math.round(a[1] + (b[1] - a[1]) * frac),
        Math.round(a[2] + (b[2] - a[2]) * frac)
      ]
    }

    /** 4×4 Bayer 抖动矩阵（除以 16）。 */
    const BAYER4 = [
      0, 8, 2, 10,
      12, 4, 14, 6,
      3, 11, 1, 9,
      15, 7, 13, 5
    ]

    /**
     * 亮度场 → 像素级量化（DESIGN.md §6），返回每格的 RGB 与量化等级。
     * 只依据 render 配置做亮度映射、gamma、抖动（bayer4 单格子偏移）。
     * floyd 误差扩散需要整帧状态，在 renderer 里按帧推进。
     * @param {number} v 亮度 [0,1]。
     * @param {object} render 渲染配置。
     * @param {number} col 列。
     * @param {number} row 行。
     * @returns {[number,number,number]} RGB。
     */
    function shadeToRgb(v, render, col, row) {
      let x = clamp((v - render.black / 100) / (render.white / 100 - render.black / 100), 0, 1)
      x = Math.pow(x, render.gamma)
      if (render.dither === 'bayer4') {
        const bayer = BAYER4[((row & 3) << 2) | (col & 3)]
        x += (bayer / 16 - 0.5) / render.levels
      }
      x = clamp(x, 0, 1)
      const level = Math.round(x * (render.levels - 1))
      return paletteAt(render.palette, level / (render.levels - 1))
    }

    /**
     * 把格子颜色按「透明度」朝底色混合：视觉等同整层 opacity，但画布仍不透明，
     * 不会把宿主底色透出来，行为确定。
     * @param {[number,number,number]} rgb 格子颜色。
     * @param {[number,number,number]} bgRgb 底色。
     * @param {number} transparency 0–100，越大越透。
     * @returns {[number,number,number]} 混合后的颜色。
     */
    function fadeToBackground(rgb, bgRgb, transparency) {
      const t = clamp(Number(transparency) || 0, 0, 100) / 100
      if (t <= 0) return rgb
      const k = 1 - t
      return [
        Math.round(bgRgb[0] + (rgb[0] - bgRgb[0]) * k),
        Math.round(bgRgb[1] + (rgb[1] - bgRgb[1]) * k),
        Math.round(bgRgb[2] + (rgb[2] - bgRgb[2]) * k)
      ]
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 算法注册表（DESIGN.md §7）
     * ──────────────────────────────────────────────────────────────────────── */

    /** 算法注册表：id → def。 */
    const algorithmRegistry = new Map()

    /** 注册一支算法；重复 id 报错。 */
    function registerAlgorithm(def) {
      if (algorithmRegistry.has(def.id)) {
        throw new Error(`${PLUGIN_ID}: 算法 id "${def.id}" 重复注册`)
      }
      algorithmRegistry.set(def.id, def)
    }

    /** 取算法定义。 */
    function algorithmOf(id) {
      return algorithmRegistry.get(id)
    }

    /** 列出全部算法 id。 */
    function algorithmIds() {
      return [...algorithmRegistry.keys()]
    }

    /** 数值噪声：值噪声 + 平滑插值，带网格（fBm 用）。 */
    function valueNoise2(rand, x, y) {
      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      const fx = x - x0
      const fy = y - y0
      const sx = fx * fx * (3 - 2 * fx)
      const sy = fy * fy * (3 - 2 * fy)
      const v = (ix, iy) => {
        // 用确定性 hash（种子无关，但由 rand 派生一个局部随机不好做——直接用 hash）
        const h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263)
        let t = Math.imul(h, 1274126177)
        t = t ^ (t >>> 15)
        return ((t >>> 0) / 4294967296)
      }
      const a = v(x0, y0)
      const b = v(x0 + 1, y0)
      const c = v(x0, y0 + 1)
      const d = v(x0 + 1, y0 + 1)
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
    }

    /** fBm（分形布朗运动）值噪声。 */
    function fbm2(scaleX, scaleY, octaves, x, y, time) {
      let amp = 1
      let freq = 1
      let sum = 0
      let norm = 0
      for (let o = 0; o < octaves; o++) {
        sum += amp * valueNoise2(null, x * scaleX * freq + time * 0.3, y * scaleY * freq)
        norm += amp
        amp *= 0.5
        freq *= 2
      }
      return sum / norm
    }

    /* —— 算法：boids（鸟群） —— */
    registerAlgorithm({
      id: 'boids',
      label: '鸟群',
      desc: '分离/对齐/聚合的智能体，拖尾留下纹理。',
      schema: [
        { key: 'agents', label: '智能体数量', type: 'range', min: 60, max: 200, step: 10, default: 80 },
        { key: 'separation', label: '分离权重', type: 'range', min: 0, max: 4, step: 0.1, default: 1.6 },
        { key: 'alignment', label: '对齐权重', type: 'range', min: 0, max: 2, step: 0.05, default: 0.9 },
        { key: 'cohesion', label: '聚合权重', type: 'range', min: 0, max: 3, step: 0.1, default: 0.7 },
        { key: 'speed', label: '速度', type: 'range', min: 0.4, max: 2.4, step: 0.1, default: 1.2 },
        { key: 'trail', label: '拖尾', type: 'range', min: 0.9, max: 0.995, step: 0.005, default: 0.98 }
      ],
      create: createBoids
    })

    /** 鸟群速度缩放：1.0 的 speed 对应 15 格/秒（原先 1.2 相当于 1.2 格/秒，太慢）。 */
    const SPEED_SCALE = 15

    /** 鸟群算法：分离/对齐/聚合 + 环形边界 + 空间哈希。 */
    function createBoids({ cols, rows, seed, params }) {
      const rand = mulberry32(seed)
      const p = Object.assign({ agents: 80, speed: 1.2, trail: 0.98, separation: 1.6, alignment: 0.9, cohesion: 0.7 }, params)
      const field = new Float32Array(cols * rows)
      // 硬上限 200：参数层已 clamp，这里再兜一层，避免旧配置或直接调用撑爆内存。
      const N = Math.min(200, Math.max(1, Math.round(p.agents)))
      const pos = new Float32Array(N * 2)
      const vel = new Float32Array(N * 2)
      // 每只鸟的速度在基准值上下 ±40% 浮动（0.6–1.4），可互相追赶/逃离。
      const speeds = new Float32Array(N)
      for (let i = 0; i < N; i++) {
        const ang = rand() * Math.PI * 2
        speeds[i] = p.speed * SPEED_SCALE * (0.6 + rand() * 0.8)
        pos[i * 2] = rand() * cols
        pos[i * 2 + 1] = rand() * rows
        vel[i * 2] = Math.cos(ang) * speeds[i]
        vel[i * 2 + 1] = Math.sin(ang) * speeds[i]
      }

      // 空间哈希邻域半径 12 格
      const R = 12
      const cellSize = R

      function stamp(cx, cy, weight) {
        const x = Math.round(cx)
        const y = Math.round(cy)
        if (x < 0 || y < 0 || x >= cols || y >= rows) return
        field[y * cols + x] += 0.55 * weight
        // 四邻 0.18，对角 0.06
        const nb = [
          [1, 0, 0.18], [-1, 0, 0.18], [0, 1, 0.18], [0, -1, 0.18],
          [1, 1, 0.06], [1, -1, 0.06], [-1, 1, 0.06], [-1, -1, 0.06]
        ]
        for (const [dx, dy, w] of nb) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          field[ny * cols + nx] += w * weight
        }
      }

      function step(dt) {
        // 归一化场
        for (let i = 0; i < field.length; i++) field[i] *= p.trail
        // 空间哈希
        const gx = Math.max(1, Math.ceil(cols / cellSize))
        const hash = new Map()
        for (let i = 0; i < N; i++) {
          const cx = Math.floor(pos[i * 2] / cellSize)
          const cy = Math.floor(pos[i * 2 + 1] / cellSize)
          const key = cy * gx + cx
          if (!hash.has(key)) hash.set(key, [])
          hash.get(key).push(i)
        }
        const neighborsOf = (i) => {
          const cx = Math.floor(pos[i * 2] / cellSize)
          const cy = Math.floor(pos[i * 2 + 1] / cellSize)
          const out = []
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const key = (cy + dy) * gx + (cx + dx)
              const bucket = hash.get(key)
              if (bucket) for (const j of bucket) if (j !== i) out.push(j)
            }
          }
          return out
        }

        for (let i = 0; i < N; i++) {
          const ix = pos[i * 2]
          const iy = pos[i * 2 + 1]
          // 每只鸟只取一次邻居，分离/对齐/聚合共用同一组 d2 <= R*R 的邻居。
          const neighbors = neighborsOf(i)
          let sx = 0
          let sy = 0
          let ax = 0
          let ay = 0
          let avx = 0
          let avy = 0
          let cnt = 0
          for (const j of neighbors) {
            const jx = pos[j * 2]
            const jy = pos[j * 2 + 1]
            let dx = ix - jx
            let dy = iy - jy
            // 环形边界下的最短距离
            if (dx > cols / 2) dx -= cols
            if (dx < -cols / 2) dx += cols
            if (dy > rows / 2) dy -= rows
            if (dy < -rows / 2) dy += rows
            const d2 = dx * dx + dy * dy
            if (d2 <= R * R && d2 > 0) {
              const d = Math.sqrt(d2)
              sx += dx / d
              sy += dy / d
              // 聚合：朝邻居平均位置（wrapped 方向）
              ax -= dx
              ay -= dy
              avx += vel[j * 2]
              avy += vel[j * 2 + 1]
              cnt++
            }
          }
          let vx = vel[i * 2]
          let vy = vel[i * 2 + 1]
          if (cnt > 0) {
            // 分离 / 聚合（对齐在下面合并）
            vx += sx * p.separation + (ax / cnt) * p.cohesion
            vy += sy * p.separation + (ay / cnt) * p.cohesion
            // 对齐：向邻域平均速度靠拢
            vx += (avx / cnt - vx) * p.alignment
            vy += (avy / cnt - vy) * p.alignment
          }
          const len = Math.sqrt(vx * vx + vy * vy) || 1
          const spd = speeds[i]
          vx = (vx / len) * spd
          vy = (vy / len) * spd
          vel[i * 2] = vx
          vel[i * 2 + 1] = vy
          let nx = ix + vx * dt
          let ny = iy + vy * dt
          // 环形边界
          nx = ((nx % cols) + cols) % cols
          ny = ((ny % rows) + rows) % rows
          pos[i * 2] = nx
          pos[i * 2 + 1] = ny
          stamp(nx, ny, 1)
        }
        // 归一化亮度场到 [0,1]
        let max = 0
        for (let i = 0; i < field.length; i++) if (field[i] > max) max = field[i]
        if (max > 0) for (let i = 0; i < field.length; i++) field[i] /= max
      }

      // 初始打点
      for (let i = 0; i < N; i++) stamp(pos[i * 2], pos[i * 2 + 1], 1)
      let max = 0
      for (let i = 0; i < field.length; i++) if (field[i] > max) max = field[i]
      if (max > 0) for (let i = 0; i < field.length; i++) field[i] /= max

      return { field, step, speeds }
    }

    /* —— 算法：flow（流场） —— */
    registerAlgorithm({
      id: 'flow',
      label: '流场',
      desc: '粒子沿 fBm 噪声旋度场推进，呈丝状。',
      schema: [
        { key: 'particles', label: '粒子数量', type: 'range', min: 300, max: 3000, step: 100, default: 1200 },
        { key: 'scale', label: '尺度', type: 'range', min: 0.6, max: 6, step: 0.1, default: 1.8 },
        { key: 'trail', label: '拖尾', type: 'range', min: 0.9, max: 0.995, step: 0.005, default: 0.975 }
      ],
      create: createFlow
    })

    /** 流场算法：粒子沿旋度场推进，累积亮度并衰减。 */
    function createFlow({ cols, rows, seed, params }) {
      const rand = mulberry32(seed)
      const p = Object.assign({ particles: 1200, scale: 1.8, trail: 0.975 }, params)
      const field = new Float32Array(cols * rows)
      const N = Math.round(p.particles)
      const px = new Float32Array(N)
      const py = new Float32Array(N)
      for (let i = 0; i < N; i++) {
        px[i] = rand() * cols
        py[i] = rand() * rows
      }
      // 旋度场：用 fbm 的 x/y 偏导近似（值噪声差分）
      const s = p.scale
      // 种子偏移：否则所有种子的噪声图案完全一样（valueNoise2 是纯 hash，不用 rand）。
      const ox = ((seed >>> 0) % 997) * 0.37
      const oy = ((seed >>> 0) % 991) * 0.53
      let time = 0

      function curl(x, y, t) {
        // 用两个相位噪声差近似旋度
        const e = 0.5
        const ddx = (fbm2(s, s, 3, (x + e) / cols + ox, y / rows + oy, t) - fbm2(s, s, 3, (x - e) / cols + ox, y / rows + oy, t)) / (2 * e)
        const ddy = (fbm2(s, s, 3, x / cols + ox, (y + e) / rows + oy, t) - fbm2(s, s, 3, x / cols + ox, (y - e) / rows + oy, t)) / (2 * e)
        // 旋度分量：vx = ddy, vy = -ddx
        return [ddy * 3, -ddx * 3]
      }

      function step(dt) {
        for (let i = 0; i < field.length; i++) field[i] *= p.trail
        time += dt
        for (let i = 0; i < N; i++) {
          const [vx, vy] = curl(px[i], py[i], time)
          let nx = px[i] + vx * dt * 4
          let ny = py[i] + vy * dt * 4
          nx = ((nx % cols) + cols) % cols
          ny = ((ny % rows) + rows) % rows
          px[i] = nx
          py[i] = ny
          const xi = Math.round(nx)
          const yi = Math.round(ny)
          if (xi >= 0 && yi >= 0 && xi < cols && yi < rows) field[yi * cols + xi] += 1
        }
        let max = 0
        for (let i = 0; i < field.length; i++) if (field[i] > max) max = field[i]
        if (max > 0) for (let i = 0; i < field.length; i++) field[i] /= max
      }

      return { field, step }
    }

    /* —— 算法：reaction（反应扩散 Gray-Scott） —— */
    registerAlgorithm({
      id: 'reaction',
      label: '反应扩散',
      desc: 'Gray-Scott 反应扩散，取 B 通道对数归一化。',
      schema: [
        { key: 'feed', label: '补给率', type: 'range', min: 0.01, max: 0.08, step: 0.001, default: 0.0367 },
        { key: 'kill', label: '消解率', type: 'range', min: 0.04, max: 0.07, step: 0.001, default: 0.0649 },
        { key: 'steps', label: '步数', type: 'range', min: 1, max: 12, step: 1, default: 4 }
      ],
      create: createReaction
    })

    /** 反应扩散（Gray-Scott）。 */
    function createReaction({ cols, rows, seed, params }) {
      const rand = mulberry32(seed)
      const p = Object.assign({ feed: 0.0367, kill: 0.0649, steps: 4 }, params)
      const Du = 0.16
      const Dv = 0.08
      const dt = 1
      const F = p.feed
      const k = p.kill
      // 超 240 列先降采样
      const down = cols > 240 ? 2 : 1
      const W = Math.ceil(cols / down)
      const H = Math.ceil(rows / down)
      let A = new Float32Array(W * H)
      let B = new Float32Array(W * H)
      for (let i = 0; i < A.length; i++) A[i] = 1
      // 初始 10% 斑点
      for (let i = 0; i < W * H * 0.1; i++) {
        const x = Math.floor(rand() * W)
        const y = Math.floor(rand() * H)
        if (rand() < 0.5) {
          A[y * W + x] = 0
          B[y * W + x] = 1
        }
      }
      const field = new Float32Array(cols * rows)

      function lap(arr, x, y) {
        // 9 点拉普拉斯，wrap
        const xm1 = (x - 1 + W) % W
        const xp1 = (x + 1) % W
        const ym1 = (y - 1 + H) % H
        const yp1 = (y + 1) % H
        const c = arr[y * W + x]
        return (
          arr[y * W + xp1] + arr[y * W + xm1] + arr[ym1 * W + x] + arr[yp1 * W + x] +
          0.5 * (arr[ym1 * W + xp1] + arr[ym1 * W + xm1] + arr[yp1 * W + xp1] + arr[yp1 * W + xm1]) -
          6 * c
        )
      }

      function step(dtStep) {
        const steps = Math.round(p.steps)
        for (let s = 0; s < steps; s++) {
          const nA = new Float32Array(W * H)
          const nB = new Float32Array(W * H)
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const i = y * W + x
              const a = A[i]
              const b = B[i]
              const abb = a * b * b
              nA[i] = a + (Du * lap(A, x, y) - abb + F * (1 - a)) * dt
              nB[i] = b + (Dv * lap(B, x, y) + abb - (F + k) * b) * dt
            }
          }
          A = nA
          B = nB
        }
        // 渲染取 B 对数归一化（最近邻放大到 cols×rows）
        let mn = Infinity
        let mx = -Infinity
        for (let i = 0; i < B.length; i++) {
          const v = Math.log(1 + Math.abs(B[i]))
          if (v < mn) mn = v
          if (v > mx) mx = v
        }
        const range = mx - mn || 1
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const bx = Math.min(W - 1, Math.floor(x / down))
            const by = Math.min(H - 1, Math.floor(y / down))
            field[y * cols + x] = (Math.log(1 + Math.abs(B[by * W + bx])) - mn) / range
          }
        }
      }

      return { field, step }
    }

    /* —— 算法：noise（噪声场） —— */
    registerAlgorithm({
      id: 'noise',
      label: '噪声场',
      desc: 'fBm 值噪声 + 域扭曲，云层/地形感。',
      schema: [
        { key: 'scale', label: '尺度', type: 'range', min: 0.6, max: 8, step: 0.1, default: 2.2 },
        { key: 'octaves', label: '八度', type: 'range', min: 2, max: 6, step: 1, default: 4 },
        { key: 'warp', label: '扭曲', type: 'range', min: 0, max: 1, step: 0.05, default: 0.35 },
        { key: 'drift', label: '漂移', type: 'range', min: 0, max: 1, step: 0.05, default: 0.15 }
      ],
      create: createNoise
    })

    /** 噪声场：fBm + 域扭曲 + 漂移。 */
    function createNoise({ cols, rows, seed, params }) {
      const p = Object.assign({ scale: 2.2, octaves: 4, warp: 0.35, drift: 0.15 }, params)
      const field = new Float32Array(cols * rows)
      const s = p.scale
      const octaves = Math.round(p.octaves)
      const ox = ((seed >>> 0) % 997) * 0.61
      const oy = ((seed >>> 0) % 983) * 0.47
      let time = 0

      function render() {
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const nx = x / cols + ox
            const ny = y / rows + oy
            // 域扭曲
            const wx = fbm2(s, s, 2, nx, ny, time) * p.warp
            const wy = fbm2(s, s, 2, nx + 10, ny + 10, time) * p.warp
            const v = fbm2(s, s, octaves, nx + wx, ny + wy, time)
            field[y * cols + x] = clamp((v * 0.5 + 0.5), 0, 1)
          }
        }
      }

      function step(dt) {
        time += dt * p.drift * 5
        render()
      }

      render()
      return { field, step }
    }

    /* —— 算法：waves（波干涉） —— */
    registerAlgorithm({
      id: 'waves',
      label: '波干涉',
      desc: '多随机波源干涉，莫尔纹/水波。',
      schema: [
        { key: 'sources', label: '波源数', type: 'range', min: 2, max: 12, step: 1, default: 5 },
        { key: 'freq', label: '频率', type: 'range', min: 0.5, max: 6, step: 0.1, default: 2.2 },
        { key: 'speed', label: '速度', type: 'range', min: 0, max: 2, step: 0.1, default: 0.8 },
        { key: 'decay', label: '衰减', type: 'range', min: 0, max: 1, step: 0.05, default: 0.3 }
      ],
      create: createWaves
    })

    /** 波干涉：多随机波源 sin(dist*freq - t*speed) 叠加，按距离衰减归一化。 */
    function createWaves({ cols, rows, seed, params }) {
      const rand = mulberry32(seed)
      const p = Object.assign({ sources: 5, freq: 2.2, speed: 0.8, decay: 0.3 }, params)
      const field = new Float32Array(cols * rows)
      const N = Math.max(2, Math.round(p.sources))
      const sources = []
      for (let i = 0; i < N; i++) {
        sources.push({
          x: rand() * cols,
          y: rand() * rows,
          phase: rand() * Math.PI * 2
        })
      }
      let time = 0
      const cx = cols / 2
      const cy = rows / 2
      const maxDist = Math.sqrt(cx * cx + cy * cy)

      function render() {
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            let sum = 0
            for (const src of sources) {
              const d = Math.sqrt((x - src.x) * (x - src.x) + (y - src.y) * (y - src.y))
              sum += Math.sin(d * p.freq * 0.1 - time * p.speed * 5 + src.phase) / (1 + d * p.decay * 0.1)
            }
            field[y * cols + x] = clamp((sum / N) * 0.5 + 0.5, 0, 1)
          }
        }
      }

      function step(dt) {
        time += dt
        render()
      }

      render()
      return { field, step }
    }

    /* —— 算法：attractor（奇异吸引子） —— */
    registerAlgorithm({
      id: 'attractor',
      label: '奇异吸引子',
      desc: '点云累加密度图，每帧淡出，对数归一化。',
      schema: [
        { key: 'type', label: '吸引子类型', type: 'select', options: [{ value: 'Clifford', label: 'Clifford' }, { value: 'De Jong', label: 'De Jong' }], default: 'Clifford' },
        { key: 'a', label: '参数 a', type: 'range', min: -3, max: 3, step: 0.1, default: -1.4 },
        { key: 'b', label: '参数 b', type: 'range', min: -3, max: 3, step: 0.1, default: 1.6 },
        { key: 'c', label: '参数 c', type: 'range', min: -3, max: 3, step: 0.1, default: 1.0 },
        { key: 'd', label: '参数 d', type: 'range', min: -3, max: 3, step: 0.1, default: 0.7 },
        { key: 'points', label: '点数', type: 'range', min: 500, max: 6000, step: 100, default: 2500 }
      ],
      create: createAttractor
    })

    /** 奇异吸引子（Clifford / De Jong）。 */
    function createAttractor({ cols, rows, seed, params }) {
      const p = Object.assign({ type: 'Clifford', a: -1.4, b: 1.6, c: 1.0, d: 0.7, points: 2500 }, params)
      const field = new Float32Array(cols * rows)
      const density = new Float32Array(cols * rows)
      const N = Math.round(p.points)
      const points = new Float32Array(N * 2)
      const rand = mulberry32(seed)
      let x = rand() * 2 - 1
      let y = rand() * 2 - 1
      // 预热
      for (let i = 0; i < 100; i++) {
        if (p.type === 'Clifford') {
          const nx = Math.sin(p.a * y) + p.c * Math.cos(p.a * x)
          const ny = Math.sin(p.b * x) + p.d * Math.cos(p.b * y)
          x = nx
          y = ny
        } else {
          const nx = Math.sin(p.a * y) - Math.cos(p.b * x)
          const ny = Math.sin(p.c * x) - Math.cos(p.d * y)
          x = nx
          y = ny
        }
      }
      let idx = 0
      function next() {
        if (p.type === 'Clifford') {
          const nx = Math.sin(p.a * y) + p.c * Math.cos(p.a * x)
          const ny = Math.sin(p.b * x) + p.d * Math.cos(p.b * y)
          x = nx
          y = ny
        } else {
          const nx = Math.sin(p.a * y) - Math.cos(p.b * x)
          const ny = Math.sin(p.c * x) - Math.cos(p.d * y)
          x = nx
          y = ny
        }
        // 映射到格子坐标
        const gx = Math.floor((x * 0.5 + 0.5) * cols)
        const gy = Math.floor((y * 0.5 + 0.5) * rows)
        points[idx] = clamp(gx, 0, cols - 1)
        points[idx + 1] = clamp(gy, 0, rows - 1)
        idx = (idx + 2) % points.length
      }
      // 初始填充
      for (let i = 0; i < N; i++) next()

      function renderDensity() {
        // 每帧淡出 2%
        for (let i = 0; i < density.length; i++) density[i] *= 0.98
        for (let i = 0; i < N; i++) {
          const px = points[i * 2]
          const py = points[i * 2 + 1]
          density[py * cols + px] += 1
        }
        // 对数归一化
        let mx = 0
        for (let i = 0; i < density.length; i++) if (density[i] > mx) mx = density[i]
        const scale = mx > 0 ? Math.log(1 + mx) : 1
        for (let i = 0; i < field.length; i++) field[i] = Math.log(1 + density[i]) / scale
      }

      function step(dt) {
        for (let i = 0; i < N; i++) next()
        renderDensity()
      }

      renderDensity()
      return { field, step }
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 渲染器（把亮度场画到画布）
     * ──────────────────────────────────────────────────────────────────────── */

    /**
     * 构建并启动渲染器。
     * @param {HTMLCanvasElement} canvas 画布。
     * @param {object} config 当前配置。
     * @param {(arg0: {cols:number, rows:number, cell:number, gx:number, gy:number}) => void} onGrid 网格变化回调。
     * @returns {{updateConfig:(c:object)=>void, playPause:(p:boolean)=>void, destroy:()=>void}}
     */
    /**
     * 算法实例签名：算法 id、种子、二级参数任一变化都要重建实例。
     * 二级参数在 create 时读取，改动后必须重播种，效果等同于一次重置。
     * @param {{id?:string,seed?:number,params?:object}|null|undefined} algorithm
     * @returns {string}
     */
    function algorithmSignature(algorithm) {
      const a = algorithm || {}
      return `${a.id || ''}|${a.seed == null ? '' : a.seed}|${JSON.stringify(a.params || {})}`
    }

    function createRenderer(canvas, config, onGrid) {
      let cfg = config
      let rafId = null
      let lastTs = 0
      let acc = 0
      let algorithm = null
      let grid = null
      let destroyed = false
      let coverageRects = null // 由外部注入
      let playing = cfg.animation && cfg.animation.playing !== false
      let dirty = true // 只有推进过模拟或配置变化才重绘，避免 120Hz 屏空转
      let lastFrameAt = 0 // 最近一次 rAF 回调时间（看门狗用）
      let frameErrors = 0
      let lastErrorLog = 0
      let lastRestartLog = 0
      let watchdog = null

      const ctx2d = canvas.getContext('2d')

      // 影响范围探测（由外部设置）
      const geometryOf = {}

      function setCoverageProvider(fn) {
        geometryOf.getRects = fn
      }

      /** 根据视口与配置计算网格（固定 CSS 像素格宽，列数随窗口反算）。 */
      function computeGrid() {
        const dpr = window.devicePixelRatio || 1
        const Wdev = Math.round(window.innerWidth * dpr)
        const Hdev = Math.round(window.innerHeight * dpr)
        const g = cfg.grid || {}
        const cellCss = g.cellWidth == null ? 5 : g.cellWidth
        const gapCss = g.gap == null ? 0.8 : g.gap
        const mg = computeManualGrid(Wdev, Hdev, dpr, cellCss, gapCss)
        return { ...mg, Wdev, Hdev, dpr, cellCss, gapCss }
      }

      /** 重设画布 backing store 到设备像素尺寸。 */
      function sizeCanvas(g) {
        canvas.width = g.Wdev
        canvas.height = g.Hdev
        canvas.style.width = '100%'
        canvas.style.height = '100%'
      }

      /** 建一支算法实例（seed / 算法 id / 二级参数变化才重建）。 */
      function makeAlgorithm(g) {
        const def = algorithmOf(cfg.algorithm.id) || algorithmOf('boids')
        const inst = def.create({ cols: g.cols, rows: g.rows, seed: cfg.algorithm.seed, params: cfg.algorithm.params || {} })
        inst._cols = g.cols
        inst._rows = g.rows
        return inst
      }

      /** 渲染一帧。 */
      function draw() {
        if (destroyed || !grid || !algorithm || !algorithm.field) return
        // 宿主若重挂 body 子节点导致画布被移除，补回去（只在失联时做一次 DOM 操作）。
        if (typeof document !== 'undefined' && document.body && !canvas.isConnected) {
          document.body.insertBefore(canvas, document.body.firstChild)
        }
        const render = cfg.render
        // 画布不透明时先铺底色；透明化后直接画格子
        const cx = ctx2d
        const bgRgb = hexToRgb(render.background)
        cx.clearRect(0, 0, grid.Wdev, grid.Hdev)
        cx.fillStyle = render.background
        cx.fillRect(0, 0, grid.Wdev, grid.Hdev)

        const xPos = computePositions(grid.Wdev, grid.cols, grid.cell)
        const yPos = computePositions(grid.Hdev, grid.rows, grid.cell)

        // floyd 误差扩散：整帧内传播
        const floyd = render.dither === 'floyd'
        let errorBuf = null
        if (floyd) errorBuf = new Float32Array(grid.cols * grid.rows)

        for (let r = 0; r < grid.rows; r++) {
          const y = yPos[r].pos
          const hgt = yPos[r].size
          for (let cIdx = 0; cIdx < grid.cols; cIdx++) {
            const x = xPos[cIdx].pos
            const wdt = xPos[cIdx].size
            let v = algorithm.field[r * grid.cols + cIdx]
            if (!Number.isFinite(v)) v = 0
            if (floyd) {
              v += errorBuf[r * grid.cols + cIdx]
            }
            let rgb
            if (floyd) {
              // 计算量化值与误差
              let xl = clamp((v - render.black / 100) / (render.white / 100 - render.black / 100), 0, 1)
              xl = Math.pow(xl, render.gamma)
              const level = Math.round(xl * (render.levels - 1))
              rgb = paletteAt(render.palette, level / (render.levels - 1))
              // 传播误差到邻格（右、下、左下、右下）
              const quant = level / (render.levels - 1)
              const err = xl - quant
              const push = (rr, cc, w) => {
                if (rr >= 0 && rr < grid.rows && cc >= 0 && cc < grid.cols) errorBuf[rr * grid.cols + cc] += err * w
              }
              push(r, cIdx + 1, 7 / 16)
              push(r + 1, cIdx - 1, 3 / 16)
              push(r + 1, cIdx, 5 / 16)
              push(r + 1, cIdx + 1, 1 / 16)
            } else {
              rgb = shadeToRgb(v, render, cIdx, r)
            }
            rgb = fadeToBackground(rgb, bgRgb, render.transparency)
            cx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
            drawShape(cx, x, y, wdt, hgt, render.shape)
          }
        }

        // 影响范围：关掉的矩形 clearRect 挖成透明
        if (geometryOf.getRects) {
          const rects = geometryOf.getRects()
          for (const key of ['header', 'left', 'right', 'input']) {
            if (cfg.coverage && cfg.coverage[key] === false) {
              const rect = rects[key]
              if (rect) {
                const dpr = grid.dpr
                cx.clearRect(rect.x * dpr, rect.y * dpr, rect.w * dpr, rect.h * dpr)
              }
            }
          }
        }
      }

      /** 按形状画一个格子。 */
      function drawShape(cx, x, y, w, hgt, shape) {
        if (shape === 'dot') {
          const d = Math.min(w, hgt)
          cx.beginPath()
          cx.arc(x + w / 2, y + hgt / 2, d / 2, 0, Math.PI * 2)
          cx.fill()
        } else if (shape === 'rounded') {
          const r = Math.min(w, hgt) * 0.28
          cx.beginPath()
          cx.roundRect(x, y, w, hgt, r)
          cx.fill()
        } else {
          cx.fillRect(x, y, w, hgt)
        }
      }

      /** 推进模拟并重绘；由 loop 捕获异常，单帧出错不会再让整条动画链断掉。 */
      function frame(ts) {
        if (lastTs === 0) lastTs = ts
        const dt = ts - lastTs
        lastTs = ts
        let stepped = false
        if (playing) {
          // 网格/算法失配（宿主改尺寸、重采样失败等）时自愈重建。
          if (!algorithm || !algorithm.field || !grid || algorithm.field.length !== grid.cols * grid.rows) {
            algorithm = makeAlgorithm(grid)
            dirty = true
          }
          acc += dt
          const speed = cfg.animation && cfg.animation.speed != null ? cfg.animation.speed : 1
          // 固定步长累计器：每次推进一个 FRAME_MS 步长，乘速度倍率
          let steps = 0
          while (acc >= FRAME_MS && steps < 4) {
            if (algorithm && algorithm.step) algorithm.step((FRAME_MS / 1000) * speed)
            acc -= FRAME_MS
            steps++
            stepped = true
          }
        }
        if (stepped) dirty = true
        if (dirty) {
          draw()
          dirty = false
        }
      }

      /** 重启动画链（rAF 丢失、异常堆积、上下文恢复时调用）。 */
      function restartLoop(reason) {
        if (destroyed) return
        if (rafId != null) cancelAnimationFrame(rafId)
        rafId = null
        lastTs = 0
        acc = 0
        dirty = true
        const now = Date.now()
        if (reason && now - lastRestartLog > 10000) {
          lastRestartLog = now
          console.warn('[pixel-wallpaper] 动画帧停摆，已自动重启：' + reason)
        }
        rafId = requestAnimationFrame(loop)
      }

      function loop(ts) {
        if (destroyed) return
        rafId = null
        lastFrameAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
        try {
          frame(ts)
          frameErrors = 0
        } catch (err) {
          // 记录但不打断：下一帧继续画，连续出错则重建算法实例。
          frameErrors++
          if (Date.now() - lastErrorLog > 5000) {
            lastErrorLog = Date.now()
            console.warn('[pixel-wallpaper] 渲染帧异常（已跳过，动画继续）：', err)
          }
          if (frameErrors >= 3) {
            frameErrors = 0
            try { algorithm = makeAlgorithm(grid) } catch { /* 下一帧再试 */ }
          }
          dirty = true
        } finally {
          if (!destroyed) rafId = requestAnimationFrame(loop)
        }
      }

      // 看门狗：rAF 被浏览器/宿主意外掐断时（页面仍在播放状态），1s 内无帧就重启。
      if (typeof setInterval === 'function') {
        watchdog = setInterval(() => {
          if (destroyed || !playing) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
          if (now - lastFrameAt > 1500) restartLoop('超过 1.5s 未收到动画帧')
        }, 1000)
      }

      // 上下文丢失（GPU 复位等）后重新分配 backing store，否则画布会永久停在最后一帧。
      function onContextLost(e) { if (e && e.preventDefault) e.preventDefault() }
      function onContextRestored() {
        try { if (grid) sizeCanvas(grid) } catch { /* 忽略 */ }
        restartLoop('canvas 上下文已恢复')
      }
      if (canvas && typeof canvas.addEventListener === 'function') {
        canvas.addEventListener('contextlost', onContextLost)
        canvas.addEventListener('contextrestored', onContextRestored)
      }

      function updateConfig(c) {
        const prevSignature = algorithmSignature(cfg.algorithm)

        cfg = c
        playing = cfg.animation && cfg.animation.playing !== false
        // 算法、种子或任一二级参数变化都重建实例：从种子重新播种，等同重置。
        const algChanged = algorithmSignature(cfg.algorithm) !== prevSignature

        const g = computeGrid()
        const gridChanged =
          g.cols !== grid.cols || g.rows !== grid.rows || g.cell !== grid.cell ||
          g.gx !== grid.gx || g.gy !== grid.gy ||
          g.cellCss !== grid.cellCss || g.gapCss !== grid.gapCss

        if (gridChanged) {
          // 网格尺寸变了必须重建实例：亮场是算法实例内部的数组，只替换 instance.field
          // 只会让绘制读到一张静止快照（算法仍写旧数组），画面就永远不再更新。
          grid = g
          sizeCanvas(g)
          algorithm = makeAlgorithm(g)
          if (onGrid) {
            const dpr = g.dpr
            onGrid({
              cols: g.cols,
              rows: g.rows,
              cell: Math.round(g.cell / dpr * 10) / 10,
              gx: Math.round(g.gx / dpr * 10) / 10,
              gy: Math.round(g.gy / dpr * 10) / 10
            })
          }
        } else if (algChanged) {
          // 网格没变但算法/种子/参数变了：换实例并立刻重绘
          algorithm = makeAlgorithm(grid)
          dirty = true
        }

        draw()
      }

      rafId = requestAnimationFrame(loop)
      const initial = computeGrid()
      sizeCanvas(initial)
      algorithm = makeAlgorithm(initial)
      grid = initial
      if (onGrid) {
        const dpr = initial.dpr
        onGrid({
          cols: initial.cols,
          rows: initial.rows,
          cell: Math.round(initial.cell / dpr * 10) / 10,
          gx: Math.round(initial.gx / dpr * 10) / 10,
          gy: Math.round(initial.gy / dpr * 10) / 10
        })
      }

      return {
        updateConfig,
        setCoverageProvider,
        playPause: (next) => {
          playing = Boolean(next)
          lastTs = 0
          acc = 0
          draw()
        },
        destroy: () => {
          destroyed = true
          if (watchdog != null) clearInterval(watchdog)
          watchdog = null
          if (rafId) cancelAnimationFrame(rafId)
          rafId = null
          if (canvas && typeof canvas.removeEventListener === 'function') {
            canvas.removeEventListener('contextlost', onContextLost)
            canvas.removeEventListener('contextrestored', onContextRestored)
          }
        }
      }
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 影响范围测量（DESIGN.md §10）
     * ──────────────────────────────────────────────────────────────────────── */

    /**
     * 测量四个影响范围矩形（CSS px）。任一测不到返回 null。
     * @returns {{header:?, left:?, right:?, input:?}}
     */
    function measureRegions() {
      const result = { header: null, left: null, right: null, input: null, rightClosed: false }
      try {
        // 顶栏：header 或带 topBar 后缀
        const headerEl = document.querySelector('header') || document.querySelector('[class*="topBar"]') || document.querySelector('[class*="topbar"]')
        if (headerEl) result.header = rectOf(headerEl)

        // 左栏：DSH 主布局的 sidebarCol（回退最左侧 aside/nav）
        const leftEl = document.querySelector('[class*="sidebarCol"]')
          || document.querySelector('[class*="sidebarCol" i]')
        if (leftEl) {
          result.left = rectOf(leftEl)
        } else {
          result.left = findLeft(document.querySelectorAll('aside, nav'))
        }

        // 侧栏：右侧 rightbarCol；宽度为 0 表示面板未打开（仍算识别，不算未识别）
        const rightEl = document.querySelector('[class*="rightbarCol"]')
          || document.querySelector('[class*="rightbarCol" i]')
        if (rightEl) {
          const r = rightEl.getBoundingClientRect()
          if (r.width >= 10 && r.height >= 10) result.right = rectOf(rightEl)
          else result.rightClosed = true
        } else {
          result.right = findRight(document.querySelectorAll('aside'), result.left)
        }

        // 输入区：DSH 输入框是 contenteditable（不再有 textarea），优先取输入卡片容器
        const editor = document.querySelector('[contenteditable="true"][role="textbox"]')
          || document.querySelector('[contenteditable="true"]')
          || document.querySelector('textarea')
        if (editor) {
          const container = editor.tagName === 'TEXTAREA'
            ? findComposerContainer(editor)
            : findComposerBox(editor)
          result.input = rectOf(container || editor)
        }
      } catch {
        // 测量失败：全部视为未识别，不影响背景整体
      }
      return result
    }

    /** 找 contenteditable 输入框所在的卡片容器。 */
    function findComposerBox(editor) {
      const card = editor.closest('[data-composer-card]')
      if (card) return card
      const er = editor.getBoundingClientRect()
      let node = editor.parentElement
      let candidate = editor
      let depth = 0
      while (node && depth < 8) {
        const r = node.getBoundingClientRect()
        if (r.height > window.innerHeight * 0.5) break
        if (r.width >= er.width && r.height >= er.height) candidate = node
        if (/composer/i.test(typeof node.className === 'string' ? node.className : '')) {
          candidate = node
          break
        }
        node = node.parentElement
        depth++
      }
      return candidate
    }

    /** 元素的 getBoundingClientRect，外扩 2 CSS px。 */
    function rectOf(el) {
      const r = el.getBoundingClientRect()
      return { x: r.left - 2, y: r.top - 2, w: r.width + 4, h: r.height + 4 }
    }

    /** 取左侧的 aside/nav（x 最小且宽 > 0）。 */
    function findLeft(elements) {
      let best = null
      for (const el of elements) {
        const r = el.getBoundingClientRect()
        if (r.width < 10 || r.height < 10) continue
        if (!best || r.left < best.rect.left) best = { el, rect: r }
      }
      return best ? rectOf(best.el) : null
    }

    /** 取右侧 aside（x 最大的 aside）。 */
    function findRight(asides, leftRect) {
      let best = null
      for (const el of asides) {
        if (el.tagName !== 'ASIDE') continue
        const r = el.getBoundingClientRect()
        if (r.width < 10 || r.height < 10) continue
        if (leftRect && Math.abs(r.left - (leftRect.x + 2)) < 5) continue // 视为同左栏
        if (!best || r.left > best.rect.left) best = { el, rect: r }
      }
      return best ? rectOf(best.el) : null
    }

    /** 找 textarea 最近的固定/粘性容器。 */
    function findComposerContainer(textarea) {
      let node = textarea.parentElement
      let depth = 0
      while (node && depth < 10) {
        const style = window.getComputedStyle(node)
        if (style.position === 'fixed' || style.position === 'sticky') return node
        node = node.parentElement
        depth++
      }
      // 退回 textarea 自身所在的一块容器（向上取一个较大的块）
      node = textarea.parentElement
      depth = 0
      while (node && depth < 6) {
        const r = node.getBoundingClientRect()
        if (r.height < window.innerHeight * 0.6) return node
        node = node.parentElement
        depth++
      }
      return textarea.parentElement
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 底层透底（DESIGN.md §10）
     * ──────────────────────────────────────────────────────────────────────── */

    /** 确保一个 style 节点存在并返回它。 */
    function ensureStyle(id) {
      if (typeof document === 'undefined') return null
      let node = document.getElementById(id)
      if (!node) {
        node = document.createElement('style')
        node.id = id
        document.head.appendChild(node)
      }
      return node
    }

    /* ────────────────────────────────────────────────────────────────────────
     * HTTP 客户端
     * ──────────────────────────────────────────────────────────────────────── */

    /** 宿主可能是旧版本，返回的配置缺字段时用客户端默认值补齐。 */
    function withDefaults(raw) {
      const src = raw || {}
      const base = {
        version: 4,
        coverage: { header: true, left: true, right: true, input: false },
        grid: { cellWidth: 5, gap: 0.8 },
        render: { shape: 'square', levels: 8, palette: ['#1b1b1b', '#c9c9c9'], gamma: 1.0, black: 0, white: 100, dither: 'none', background: '#141414', transparency: 90 },
        animation: { playing: true, speed: 1 },
        algorithm: { id: 'boids', seed: 1337, params: {} }
      }
      const out = { ...base, ...src }
      for (const key of ['coverage', 'render', 'animation']) {
        out[key] = { ...base[key], ...(src[key] || {}) }
      }
      // 旧版 auto 配置的 grid 是 { mode, cellWidth:null, gap:null }：丢弃 mode，空值回退 5/0.8。
      const srcGrid = src.grid && typeof src.grid === 'object' ? src.grid : {}
      out.grid = {
        cellWidth: srcGrid.cellWidth == null ? base.grid.cellWidth : srcGrid.cellWidth,
        gap: srcGrid.gap == null ? base.grid.gap : srcGrid.gap
      }
      out.algorithm = { ...base.algorithm, ...(src.algorithm || {}) }
      out.algorithm.params = { ...((src.algorithm && src.algorithm.params) || {}) }
      return out
    }

    async function getConfig() {
      const res = await fetch(`${API}/config`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`GET ${API}/config -> HTTP ${res.status}`)
      const data = await res.json()
      return withDefaults(data.config)
    }

    async function putConfig(config) {
      const res = await fetch(`${API}/config`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config })
      })
      if (!res.ok) throw new Error(`PUT ${API}/config -> HTTP ${res.status}`)
      const data = await res.json()
      return data.config
    }

    /** 去抖。 */
    function debounce(fn, wait) {
      let timer = null
      return (...args) => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          fn(...args)
        }, wait)
      }
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 设置页
     * ──────────────────────────────────────────────────────────────────────── */

    /** 底层样式：画布与透明化。只在 apply 里写一次。 */
    const BASE_CSS = `
    html, body { background: transparent !important; }
    html body, html body[data-ds-dark-theme], html body[data-ds-light-theme] {
      --dsw-alias-bg-base: transparent !important;
      --dsw-specific-sidebar-fill: transparent !important;
      --dsw-specific-bubble: transparent !important;
    }
    #${CANVAS_ID} { position: fixed; inset: 0; z-index: -1; pointer-events: none; width: 100%; height: 100%; }
    `

    const UI_CSS = `
    .pw-section{display:flex;flex-direction:column;gap:14px;padding:4px 0}
    .pw-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8)}
    .pw-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
    .pw-group{display:flex;flex-direction:column;gap:6px}
    .pw-fields{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;align-items:center}
    .pw-general{display:flex;flex-direction:column;gap:12px}
    .pw-group-label{font-size:12px;color:var(--dsw-alias-label-secondary,#aaa)}
    .pw-coverage-row{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;gap:16px}
    .pw-coverage-row .pw-row{flex:0 0 auto}
    .pw-coverage-row .pw-row-label{flex:0 0 auto}
    .pw-row{display:flex;align-items:center;gap:8px}
    .pw-row-label{font-size:13px;color:var(--dsw-alias-label-primary,#e8e8e8);flex:1}
    .pw-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}
    .pw-input{box-sizing:border-box;width:80px;background:var(--dsw-alias-button-elevated-fill,#2a2a2a);border:.5px solid var(--dsw-alias-border-l4,#444);border-radius:6px;color:inherit;padding:4px 8px;font-size:13px;outline:none}
    .pw-select{box-sizing:border-box;background:var(--dsw-alias-button-elevated-fill,#2a2a2a);border:.5px solid var(--dsw-alias-border-l4,#444);border-radius:6px;color:inherit;padding:4px 8px;font-size:13px;outline:none}
    .pw-tabs{display:flex;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l3,#333)}
    .pw-tab{padding:6px 14px;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-secondary,#aaa);border-bottom:2px solid transparent}
    .pw-tab-active{color:var(--dsw-alias-label-primary,#e8e8e8);border-bottom-color:var(--dsw-alias-border-brand,#5788ff)}
    .pw-card{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
    .pw-algo{display:flex;flex-direction:column;gap:2px;padding:8px;border:.5px solid var(--dsw-alias-border-l4,#444);border-radius:8px;cursor:pointer}
    .pw-algo-selected{border-color:var(--dsw-alias-border-brand,#5788ff)}
    .pw-algo-name{font-size:13px;color:var(--dsw-alias-label-primary,#e8e8e8)}
    .pw-algo-desc{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#999)}
    .pw-btn{border:.5px solid var(--dsw-alias-border-l4,#444);border-radius:6px;background:var(--dsw-alias-button-elevated-fill,#2a2a2a);color:inherit;padding:5px 12px;font-size:13px;cursor:pointer}
    .pw-grid-stats{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}
    .pw-note{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);min-height:16px}
    .pw-note-err{color:var(--dsw-alias-label-danger,#ff6b6b)}
    .pw-divid{height:1px;background:var(--dsw-alias-border-l3,#333)}
    .pw-placeholder{display:flex;align-items:center;justify-content:center;gap:8px;min-height:120px;border:1px dashed var(--dsw-alias-border-l4,#555);border-radius:8px;flex-direction:column}
    .pw-palette{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .pw-swatch{width:30px;height:22px;padding:0;border:.5px solid var(--dsw-alias-border-l4,#444);border-radius:5px;background:none;cursor:pointer}
    .pw-btn-mini{padding:2px 8px;font-size:12px}
    .pw-btn:disabled{opacity:.4;cursor:default}
    `

    /** 一行开关（复选框）。 */
    function Toggle(props) {
      return h('label', { className: 'pw-row', style: { cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: Boolean(props.checked), onChange: (e) => props.onChange(e.target.checked) }),
        h('span', { className: 'pw-row-label' }, props.label),
        props.hint ? h('span', { className: 'pw-hint' }, props.hint) : null
      )
    }

    /**
     * 归一化数字输入草稿（失焦 / 回车时调用）。
     * 空串、NaN、非有限数回退 fallback；其余 clamp 到 [min, max]。
     * @param {string|number} draft 输入框里的原始文本。
     * @param {number} fallback 当前生效值（非法输入时回退）。
     * @param {number} min 下限。
     * @param {number} max 上限。
     * @returns {number} 合法数值。
     */
    function normalizeNumberInput(draft, fallback, min, max) {
      const text = typeof draft === 'string' ? draft.trim() : draft
      if (text === '' || text === null || text === undefined) return fallback
      const n = Number(text)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    }

    /** 数值输入：输入过程中只改本地草稿，失焦 / 回车才提交。 */
    function NumberField(props) {
      const [draft, setDraft] = React.useState(props.value == null ? '' : String(props.value))

      // 外部值变化（保存后回填、切换到别的算法等）时同步草稿。
      React.useEffect(() => {
        setDraft(props.value == null ? '' : String(props.value))
      }, [props.value])

      const commit = () => {
        const next = normalizeNumberInput(draft, props.value, props.min, props.max)
        setDraft(String(next))
        if (next !== props.value) props.onChange(next)
      }

      return h('label', { className: 'pw-row' },
        h('span', { className: 'pw-row-label', style: { flex: 1 } }, props.label),
        h('input', {
          className: 'pw-input',
          type: 'number',
          value: draft,
          min: props.min,
          max: props.max,
          step: props.step || 1,
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              setDraft(props.value == null ? '' : String(props.value))
            }
          }
        })
      )
    }

    /** 下拉选择。 */
    function SelectField(props) {
      return h('label', { className: 'pw-row' },
        h('span', { className: 'pw-row-label', style: { flex: 1 } }, props.label),
        h('select', { className: 'pw-select', value: props.value, onChange: (e) => props.onChange(e.target.value) },
          (props.options || []).map((o) => h('option', { value: o.value, key: o.value }, o.label)))
      )
    }

    /**
     * 设置页主体。
     * @returns {object} React 元素。
     */
    function SettingsSection() {
      const [config, setConfig] = React.useState(null)
      const [gridInfo, setGridInfo] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [saveNote, setSaveNote] = React.useState('')
      const [tab, setTab] = React.useState('algorithm')
      const [regions, setRegions] = React.useState({ header: true, left: true, right: true, input: true })
      const [closed, setClosed] = React.useState({})

      React.useEffect(() => {
        let alive = true
        getConfig()
          .then((c) => { if (alive) setConfig(c) })
          .catch((err) => { if (alive) setLoadError(`读取配置失败：${err.message}`) })
        // 监听区域测量结果
        const onRegions = (e) => {
          if (!alive || !e.detail) return
          setRegions(e.detail.regions || {})
          setClosed(e.detail.closed || {})
        }
        window.addEventListener('pixel-wallpaper:regions', onRegions)
        return () => { alive = false; window.removeEventListener('pixel-wallpaper:regions', onRegions) }
      }, [])

      // 去抖保存
      const saveDebounced = React.useRef(null)
      React.useEffect(() => {
        saveDebounced.current = debounce((c) => {
          putConfig(c)
            .then((result) => { setSaveNote('已保存') })
            .catch((err) => { setSaveNote(`保存失败：${err.message}（画面不回滚）`) })
        }, 300)
        return () => { if (saveDebounced.current) saveDebounced.current = null }
      }, [])

      // 网格信息回调
      React.useEffect(() => {
        const onGrid = (e) => { if (e.detail) setGridInfo(e.detail) }
        window.addEventListener('pixel-wallpaper:grid', onGrid)
        return () => window.removeEventListener('pixel-wallpaper:grid', onGrid)
      }, [])

      if (!config) {
        return h('div', { className: 'pw-section' }, h('div', { className: 'pw-note' }, loadError || '加载中…'))
      }

      /** 改配置 + 派发即时应用事件 + 去抖保存（不落盘运行时值）。 */
      const patch = (updater) => {
        setConfig((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
          // 派发事件让画布即时应用
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail: { config: next } }))
          }
          // 去抖保存（剥掉运行时计算值，由 sanitize 处理）
          if (saveDebounced.current) saveDebounced.current(next)
          return next
        })
      }

      const cov = config.coverage || {}
      const grid = config.grid || {}
      const render = config.render || {}
      const anim = config.animation || {}
      const algo = config.algorithm || {}

      /** 网格信息行（实际列×行与实际格宽/间隔，CSS px 保留一位小数）。 */
      const stats = gridInfo
        ? `当前 ${gridInfo.cols} × ${gridInfo.rows} 格 · ${Number(gridInfo.cell).toFixed(1)}px / ${Number(gridInfo.gx).toFixed(1)}px 间隔`
        : ''

      /** 影响范围是否未识别。 */
      const regionUnrecognized = (key) => regions && regions[key] === false
      /** 区域未识别的原因文案（面板没开 / 找不到容器）。 */
      const regionSuffix = (key) => {
        if (!regionUnrecognized(key)) return ''
        return closed && closed[key] ? '（未打开）' : '（未识别）'
      }
      const coverageLabels = {
        header: '顶栏',
        left: '左栏',
        right: '侧栏',
        input: '输入区'
      }

      /** 当前算法的 schema。 */
      const algoDef = algorithmOf(algo.id) || algorithmOf('boids')

      /** 网格（插件通用）：固定 CSS 像素格宽与间隔，列数随窗口反算。 */
      const gridControls = h('div', { className: 'pw-group' },
        h('div', { className: 'pw-group-label' }, '网格'),
        h('div', { className: 'pw-fields' },
          h(NumberField, {
            label: '格宽（CSS px）',
            value: grid.cellWidth,
            min: 3,
            max: 20,
            step: 0.5,
            onChange: (v) => patch((p) => ({ ...p, grid: { ...p.grid, cellWidth: v } }))
          }),
          h(NumberField, {
            label: '间隔（CSS px）',
            value: grid.gap,
            min: 0,
            max: 8,
            step: 0.1,
            onChange: (v) => patch((p) => ({ ...p, grid: { ...p.grid, gap: v } }))
          })
        ),
        h('div', { className: 'pw-row' },
          h('span', { className: 'pw-grid-stats' }, stats)
        )
      )

      /** 外观（插件通用）。 */
      const appearanceControls = h('div', { className: 'pw-group' },
        h('div', { className: 'pw-group-label' }, '外观'),
        h('div', { className: 'pw-fields' },
          h(SelectField, {
            label: '形状',
            value: render.shape,
            options: [{ value: 'square', label: '方形' }, { value: 'rounded', label: '圆角' }, { value: 'dot', label: '圆点' }],
            onChange: (v) => patch((p) => ({ ...p, render: { ...p.render, shape: v } }))
          }),
          h(NumberField, { label: '层数', value: render.levels, min: 2, max: 16, onChange: (v) => patch((p) => ({ ...p, render: { ...p.render, levels: v } })) }),
          h(NumberField, { label: 'gamma', value: render.gamma, min: 0.4, max: 2, step: 0.1, onChange: (v) => patch((p) => ({ ...p, render: { ...p.render, gamma: v } })) }),
          h(NumberField, { label: '黑场', value: render.black, min: 0, max: 30, onChange: (v) => patch((p) => ({ ...p, render: { ...p.render, black: v } })) }),
          h(NumberField, { label: '白场', value: render.white, min: 70, max: 100, onChange: (v) => patch((p) => ({ ...p, render: { ...p.render, white: v } })) }),
          h(SelectField, {
            label: '抖动',
            value: render.dither,
            options: [{ value: 'none', label: '无' }, { value: 'bayer4', label: 'Bayer 4×4' }, { value: 'floyd', label: '误差扩散' }],
            onChange: (v) => patch((p) => ({ ...p, render: { ...p.render, dither: v } }))
          }),
          h(NumberField, {
            label: '透明度（%）',
            value: render.transparency,
            min: 0,
            max: 100,
            step: 5,
            onChange: (v) => patch((p) => ({ ...p, render: { ...p.render, transparency: Math.round(v) } }))
          })
        )
      )

      /** 色值与底色（插件通用）。 */
      const paletteControls = h('div', { className: 'pw-group' },
        h('div', { className: 'pw-group-label' }, '色值'),
        h('div', { className: 'pw-palette' },
          (render.palette || []).map((color, index) => h('input', {
            key: `${index}-${color}`,
            type: 'color',
            className: 'pw-swatch',
            title: `色标 ${index + 1}`,
            value: color,
            onChange: (e) => {
              const next = (render.palette || []).slice()
              next[index] = e.target.value
              patch((p) => ({ ...p, render: { ...p.render, palette: next } }))
            }
          })),
          h('button', {
            className: 'pw-btn pw-btn-mini',
            disabled: (render.palette || []).length >= 8,
            onClick: () => patch((p) => ({ ...p, render: { ...p.render, palette: [...p.render.palette, '#808080'] } }))
          }, '+'),
          h('button', {
            className: 'pw-btn pw-btn-mini',
            disabled: (render.palette || []).length <= 2,
            onClick: () => patch((p) => ({ ...p, render: { ...p.render, palette: p.render.palette.slice(0, -1) } }))
          }, '−'),
          h('button', {
            className: 'pw-btn pw-btn-mini',
            onClick: () => patch((p) => ({ ...p, render: { ...p.render, palette: ['#1b1b1b', '#c9c9c9'] } }))
          }, '灰白')
        ),
        h('label', { className: 'pw-row' },
          h('span', { className: 'pw-row-label' }, '底色'),
          h('input', {
            type: 'color',
            className: 'pw-swatch',
            value: render.background,
            onChange: (e) => patch((p) => ({ ...p, render: { ...p.render, background: e.target.value } }))
          })
        )
      )

      /** 插件通用配置：放在背景范围与 Tab 之间。 */
      const generalControls = h('div', { className: 'pw-general' },
        gridControls,
        appearanceControls,
        paletteControls
      )

      /** 二级参数（按当前算法 schema）。 */
      const schemaControls = h('div', { className: 'pw-group' },
        h('div', { className: 'pw-group-label' }, '二级参数'),
        (algoDef.schema || []).map((f) => {
          if (f.type === 'select') {
            return h(SelectField, {
              key: f.key,
              label: f.label,
              value: (algo.params || {})[f.key] != null ? (algo.params || {})[f.key] : f.default,
              options: f.options,
              onChange: (v) => patch((p) => ({ ...p, algorithm: { ...p.algorithm, params: { ...p.algorithm.params, [f.key]: v } } }))
            })
          }
          return h(NumberField, {
            key: f.key,
            label: f.label,
            value: (algo.params || {})[f.key] != null ? (algo.params || {})[f.key] : f.default,
            min: f.min,
            max: f.max,
            step: f.step,
            onChange: (v) => patch((p) => ({ ...p, algorithm: { ...p.algorithm, params: { ...p.algorithm.params, [f.key]: v } } }))
          })
        })
      )

      /** 种子（算法级）。 */
      const seedControl = h(NumberField, {
        label: '种子',
        value: algo.seed,
        min: 0,
        max: 999999,
        step: 1,
        onChange: (v) => patch((p) => ({ ...p, algorithm: { ...p.algorithm, seed: Math.round(v) } }))
      })

      /** 算法下拉：每个选项 = 名称 + 一句说明。 */
      const algorithmSelect = h('div', { className: 'pw-group' },
        h('div', { className: 'pw-group-label' }, '算法'),
        h('select', {
          className: 'pw-select',
          style: { width: '100%' },
          value: algo.id,
          onChange: (e) => patch((p) => ({ ...p, algorithm: { ...p.algorithm, id: e.target.value } }))
        },
          algorithmIds().map((id) => {
            const def = algorithmOf(id)
            return h('option', { key: id, value: id }, `${def.label} — ${def.desc}`)
          })
        ),
        h('div', { className: 'pw-hint', style: { lineHeight: '16px' } }, algoDef.desc)
      )

      /** 播放/暂停 + 速度。 */
      const playControls = h('div', { className: 'pw-row' },
        h('button', { className: 'pw-btn', onClick: () => patch((p) => ({ ...p, animation: { ...p.animation, playing: !p.animation.playing } })) }, anim.playing ? '暂停' : '播放'),
        h(NumberField, { label: '速度', value: anim.speed, min: 0.25, max: 2, step: 0.05, onChange: (v) => patch((p) => ({ ...p, animation: { ...p.animation, speed: v } })) })
      )

      /** 背景范围四个开关（同一行）。 */
      const coverageControls = h('div', { className: 'pw-group' },
        h('div', { className: 'pw-group-label' }, '背景范围'),
        h('div', { className: 'pw-coverage-row' },
          ['header', 'left', 'right', 'input'].map((key) =>
            h(Toggle, {
              key,
              label: coverageLabels[key] + regionSuffix(key),
              checked: Boolean(cov[key]),
              onChange: (v) => patch((p) => ({ ...p, coverage: { ...p.coverage, [key]: v } }))
            })
          )
        )
      )

      /** 图片 tab 占位。 */
      const imageTab = h('div', { className: 'pw-placeholder' },
        h('div', { className: 'pw-title', style: { fontSize: 13 } }, '图片'),
        h('div', { className: 'pw-hint' }, '预留：把任意图片抽样为同一套单元格亮度场')
      )

      return h('div', { className: 'pw-section' },
        h('div', { className: 'pw-title' }, '像素背景'),
        // 影响范围
        coverageControls,
        h('div', { className: 'pw-divid' }),
        // 插件通用配置：网格、外观、色值
        generalControls,
        h('div', { className: 'pw-divid' }),
        // tab：算法 / 图片
        h('div', { className: 'pw-tabs' },
          h('div', { className: `pw-tab${tab === 'algorithm' ? ' pw-tab-active' : ''}`, onClick: () => setTab('algorithm') }, '算法'),
          h('div', { className: `pw-tab${tab === 'image' ? ' pw-tab-active' : ''}`, onClick: () => setTab('image') }, '图片')
        ),
        tab === 'algorithm'
          ? h('div', { className: 'pw-section' },
            algorithmSelect,
            playControls,
            seedControl,
            schemaControls
          )
          : imageTab,
        h('span', { className: `pw-note${saveNote.startsWith('保存失败') ? ' pw-note-err' : ''}` }, saveNote)
      )
    }

    /** 生成一个 n 段的均匀灰阶调色板（占位，为将来多色预留）。 */
    function evenPalette(n) {
      const out = []
      const count = Math.max(2, Math.min(8, Number(n) || 2))
      for (let i = 0; i < count; i++) {
        const v = Math.round((i / (count - 1)) * 255)
        out.push(`#${v.toString(16).padStart(2, '0').repeat(3)}`)
      }
      return out
    }

    /** 注册设置页 slot。 */
    function registerSettings(ctx) {
      const spec = {
        name: 'settings.section',
        id: PLUGIN_ID,
        order: 96,
        label: () => '像素背景',
        inject: () => ({})
      }
      const live = () => ctx.slots.register(spec, SettingsSection)
      if (typeof ctx.slots.inject === 'function') ctx.slots.inject('settings.section', live)
      else if (typeof ctx.effect === 'function') ctx.effect(live, `${PLUGIN_ID}: settings section`)
      else live()
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 入口
     * ──────────────────────────────────────────────────────────────────────── */

    /** 客户端运行时状态（供测试探视，不参与生产逻辑）。 */
    const runtime = {
      renderer: null,
      regions: { header: false, left: false, right: false, input: false }
    }

    /**
     * 启动画布与渲染器，维护配置事件与可见性。
     */
    function startRenderer(ctx) {
      if (typeof document === 'undefined') return

      // 注入画布
      let canvas = document.getElementById(CANVAS_ID)
      if (!canvas) {
        canvas = document.createElement('canvas')
        canvas.id = CANVAS_ID
        canvas.setAttribute('aria-hidden', 'true')
        document.body.insertBefore(canvas, document.body.firstChild)
      }

      const initialConfig = {
        version: 4,
        coverage: { header: true, left: true, right: true, input: false },
        grid: { cellWidth: 5, gap: 0.8 },
        render: { shape: 'square', levels: 8, palette: ['#1b1b1b', '#c9c9c9'], gamma: 1.0, black: 0, white: 100, dither: 'none', background: '#141414', transparency: 90 },
        animation: { playing: true, speed: 1 },
        algorithm: { id: 'boids', seed: 1337, params: {} }
      }

      let lastGridInfo = null
      const onGrid = (info) => {
        lastGridInfo = info
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('pixel-wallpaper:grid', { detail: info }))
        }
      }

      const renderer = createRenderer(canvas, initialConfig, onGrid)
      runtime.renderer = renderer
      trackConfig(renderer)
      const teardown = []

      // 影响范围：测量开销大，缓存矩形，只在启动 / resize / DOM 变化时刷新。
      let cachedRects = { header: null, left: null, right: null, input: null }
      const refreshRegions = () => {
        cachedRects = measureRegions()
        const recognized = {
          header: Boolean(cachedRects.header),
          left: Boolean(cachedRects.left),
          right: Boolean(cachedRects.right),
          input: Boolean(cachedRects.input)
        }
        runtime.regions = recognized
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('pixel-wallpaper:regions', {
            detail: { regions: recognized, closed: { right: Boolean(cachedRects.rightClosed) } }
          }))
          // 设置页是后挂载的：补发最近一次网格信息，避免「格宽/间隔」一直显示 —。
          if (lastGridInfo) window.dispatchEvent(new CustomEvent('pixel-wallpaper:grid', { detail: lastGridInfo }))
        }
      }
      renderer.setCoverageProvider(() => cachedRects)
      refreshRegions()

      // 配置事件：设置页保存后即时应用
      const onConfig = (e) => {
        if (e.detail && e.detail.config) {
          try {
            renderer.updateConfig(e.detail.config)
          } catch {
            // 单次配置应用失败：保留上一帧
          }
        }
      }
      if (typeof window !== 'undefined') {
        window.addEventListener(CONFIG_EVENT, onConfig)
        teardown.push(() => window.removeEventListener(CONFIG_EVENT, onConfig))
      }

      // 启动时 GET 一次配置
      getConfig()
        .then((c) => { renderer.updateConfig(c) })
        .catch(() => { /* 宿主未就绪：用默认值 */ })

      // 可见性变化：隐藏暂停，恢复继续（保留最后一帧）
      if (typeof document !== 'undefined') {
        const onVisibility = () => {
          try {
            if (document.hidden) {
              renderer.playPause(false)
            } else {
              const wantPlay = !rendererConfig || !rendererConfig.animation || rendererConfig.animation.playing !== false
              renderer.playPause(wantPlay)
            }
          } catch {
            // 暂停/恢复失败：忽略
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        teardown.push(() => document.removeEventListener('visibilitychange', onVisibility))
      }

      // 区域测量：resize/DOM 变化时防抖重测；防抖保证最后一次变化一定被测量，
      // 不会因为「节流窗口内被丢弃」而永远停在启动时的旧结果。
      const scheduleMeasure = debounce(refreshRegions, 300)
      if (typeof window !== 'undefined') {
        window.addEventListener('resize', scheduleMeasure)
        teardown.push(() => window.removeEventListener('resize', scheduleMeasure))
      }
      if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(scheduleMeasure)
        observer.observe(document.body, { childList: true, subtree: true })
        runtime.observer = observer
        teardown.push(() => observer.disconnect())
      }
      // 页面刚加载时 composer 往往晚于插件挂载：补测一次。
      const lateMeasure = setTimeout(refreshRegions, 1200)
      teardown.push(() => clearTimeout(lateMeasure))

      // ResizeObserver 观察 documentElement；matchMedia 监听 DPR 变化
      const disposeResize = setupResizeHandlers(renderer, initialConfig)
      if (disposeResize) teardown.push(disposeResize)

      // 插件被禁用/卸载时，把画布、监听器与动画帧全部撤掉，恢复宿主默认背景。
      return () => {
        for (const fn of teardown) {
          try { fn() } catch { /* 单个清理失败继续 */ }
        }
        try { renderer.destroy() } catch { /* 忽略 */ }
        try { if (canvas.parentNode) canvas.parentNode.removeChild(canvas) } catch { /* 忽略 */ }
        runtime.renderer = null
      }
    }

    /** 当前生效配置（供可见性切换使用）。 */
    let rendererConfig = null

    /** 记录 renderer 的最新配置。 */
    function trackConfig(renderer) {
      const orig = renderer.updateConfig
      renderer.updateConfig = (c) => {
        rendererConfig = c
        return orig(c)
      }
    }

    /**
     * 监听 resize / dpr 变化，触发整组重算（自动）或保留手动参数重算（手动）。
     */
    function setupResizeHandlers(renderer, seedConfig) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return null
      let ro = null
      let mq = null
      let handler = null
      try {
        ro = new ResizeObserver(debounce(() => {
          if (rendererConfig) renderer.updateConfig(rendererConfig)
        }, 300))
        ro.observe(document.documentElement)

        // matchMedia 监听跨屏 DPR
        if (typeof window.matchMedia === 'function') {
          mq = window.matchMedia('(resolution: 1dppx)')
          handler = () => {
            if (rendererConfig) renderer.updateConfig(rendererConfig)
          }
          if (mq.addEventListener) mq.addEventListener('change', handler)
          else if (mq.addListener) mq.addListener(handler)
        }
      } catch {
        // 观察失败：不阻塞背景
      }
      return () => {
        try { if (ro) ro.disconnect() } catch { /* 忽略 */ }
        try {
          if (mq && handler) {
            if (mq.removeEventListener) mq.removeEventListener('change', handler)
            else if (mq.removeListener) mq.removeListener(handler)
          }
        } catch { /* 忽略 */ }
      }
    }

    /**
     * 客户端入口。
     * @param {object} ctx 客户端上下文。
     */
    function apply(ctx) {
      try {
        // 背景层用 ctx.effect 托管：插件被禁用/卸载时 DSH 会调用返回的清理函数，
        // 画布、样式、监听器一起撤销，不留下「关了还在生效」的孤儿层。
        const startBackground = () => {
          if (typeof document === 'undefined') return () => {}
          ensureStyle(STYLE_ID).textContent = BASE_CSS + UI_CSS
          const disposeRenderer = startRenderer(ctx)
          return () => {
            try { if (disposeRenderer) disposeRenderer() } catch { /* 忽略 */ }
            try {
              const style = document.getElementById(STYLE_ID)
              if (style && style.parentNode) style.parentNode.removeChild(style)
            } catch { /* 忽略 */ }
          }
        }
        if (typeof ctx.effect === 'function') ctx.effect(startBackground, `${PLUGIN_ID}: background layer`)
        else startBackground()
        registerSettings(ctx)
      } catch (error) {
        // 任何失败只丢背景，不白屏
        if (typeof console !== 'undefined') console.error(`[${PLUGIN_ID}] client side failed`, error)
      }
    }

    module.exports = {
      name: PLUGIN_ID,
      inject: ['slots'],
      apply,
      __internals: {
        mulberry32,
        createRenderer,
        computeManualGrid,
        computePositions,
        normalizeNumberInput,
        paletteAt,
        shadeToRgb,
        fadeToBackground,
        withDefaults,
        hexToRgb,
        clamp,
        registerAlgorithm,
        algorithmOf,
        algorithmIds,
        measureRegions,
        evenPalette,
        algorithmSignature,
        createBoids,
        createFlow,
        createReaction,
        createNoise,
        createWaves,
        createAttractor
      }
    }
    return module.exports
  }
})
