/*! dsh-pixel-wallpaper v0.1.0 | MIT | 构建产物，请勿手改，源码见 client/index.js */
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
     * 自动模式网格（DESIGN.md §5.2）。
     * 入参为设备像素视口，返回 { cols:n, rows:m, cell:c, gx, gy }。
     * 全部整数设备像素；c 为正方形边长。
     * @param {number} Wdev 设备像素宽。
     * @param {number} Hdev 设备像素高。
     * @param {number} dpr 设备像素比。
     * @returns {{cols:number, rows:number, cell:number, gx:number, gy:number}}
     */
    function computeAutoGrid(Wdev, Hdev, dpr) {
      let N0 = 140
      if (Wdev / N0 < 7 * dpr) {
        N0 = Math.max(8, Math.floor(Wdev / (7 * dpr)))
      }
      const slot = Wdev / N0
      const g0 = Math.max(1, Math.round(slot * 0.12))
      const c = Math.max(2, Math.round(slot - g0))

      let n = N0
      let gx = n > 1 ? (Wdev - n * c) / (n - 1) : 0
      // 高度没有目标行数：用算出的横向缝估行数
      let m = Math.max(1, Math.round(Hdev / (c + gx)))
      let gy = m > 1 ? (Hdev - m * c) / (m - 1) : gx

      // 两向间隔阈值：让 gx/gy 尽量接近
      const nearEnough = (a, b) => Math.abs(a - b) <= Math.max(0.5, 0.2 * Math.min(a, b))

      // 先在 m-1/m/m+1 中重选让两向间隔接近
      if (!nearEnough(gx, gy)) {
        let bestM = m
        let bestDiff = Math.abs(gx - gy)
        for (const dm of [-1, 0, 1]) {
          const mm = m + dm
          if (mm < 1) continue
          const gyy = mm > 1 ? (Hdev - mm * c) / (mm - 1) : gx
          if (gyy < 0.5) continue
          // 校验格子不超出视口
          const need = mm * c + (mm - 1) * gyy
          if (need > Hdev + 1) continue
          const diff = Math.abs(gx - gyy)
          if (diff < bestDiff) {
            bestDiff = diff
            bestM = mm
          }
        }
        m = bestM
        gy = m > 1 ? (Hdev - m * c) / (m - 1) : gx
      }

      // 兜底：间隔过小则减列/减行重解
      if (gx < 0.5 && n > 1) {
        n -= 1
        gx = n > 1 ? (Wdev - n * c) / (n - 1) : 0
      }
      if (gy < 0.5 && m > 1) {
        m -= 1
        gy = m > 1 ? (Hdev - m * c) / (m - 1) : (gx >= 0.5 ? gx : 0)
      }

      return { cols: n, rows: m, cell: c, gx, gy }
    }

    /**
     * 手动模式网格（DESIGN.md §5.3）。
     * @param {number} Wdev 设备像素宽。
     * @param {number} Hdev 设备像素高。
     * @param {number} dpr 设备像素比。
     * @param {number} cellCss 单元格宽 CSS px。
     * @param {number} gapCss 间隔 CSS px。
     * @returns {{cols:number, rows:number, cell:number, gx:number, gy:number, seamless:boolean}}
     */
    function computeManualGrid(Wdev, Hdev, dpr, cellCss, gapCss) {
      const c = Math.max(2, Math.round(cellCss * dpr))
      const g = Math.max(0, Math.round(gapCss * dpr))

      if (c <= 0) return { cols: 1, rows: 1, cell: c, gx: 0, gy: 0, seamless: true }

      if (g === 0) {
        // 无缝：把余量摊进单元格宽度（第 i 格宽 c 或 c+1）
        const n = Math.max(1, Math.floor(Wdev / c))
        const m = Math.max(1, Math.floor(Hdev / c))
        return { cols: n, rows: m, cell: c, gx: 0, gy: 0, seamless: true, spreadX: Wdev - n * c, spreadY: Hdev - m * c }
      }

      let n = Math.max(1, Math.round(Wdev / (c + g)))
      let m = Math.max(1, Math.round(Hdev / (c + g)))
      // 防止 n*c 超过视口：那会让首格与次格重叠，缝也算成负数。
      while (n > 1 && n * c > Wdev) n -= 1
      while (m > 1 && m * c > Hdev) m -= 1
      let gx = n > 1 ? (Wdev - n * c) / (n - 1) : 0
      let gy = m > 1 ? (Hdev - m * c) / (m - 1) : 0

      // 两向间隔阈值；必要时 n、m 各 ±1 重解
      const nearEnough = (a, b) => Math.abs(a - b) <= Math.max(0.5, 0.2 * Math.min(a, b))
      if (!nearEnough(gx, gy)) {
        let bestN = n
        let bestM = m
        let bestDiff = Math.abs(gx - gy)
        for (const dn of [-1, 0, 1]) {
          for (const dm of [-1, 0, 1]) {
            const nn = Math.max(1, n + dn)
            const mm = Math.max(1, m + dm)
            const gxx = nn > 1 ? (Wdev - nn * c) / (nn - 1) : 0
            const gyy = mm > 1 ? (Hdev - mm * c) / (mm - 1) : 0
            if (gyy < 0.5) continue
            if (nn * c + (nn - 1) * gxx > Wdev + 1) continue
            if (mm * c + (mm - 1) * gyy > Hdev + 1) continue
            const diff = Math.abs(gxx - gyy)
            if (diff < bestDiff) {
              bestDiff = diff
              bestN = nn
              bestM = mm
            }
          }
        }
        n = bestN
        m = bestM
        gx = n > 1 ? (Wdev - n * c) / (n - 1) : 0
        gy = m > 1 ? (Hdev - m * c) / (m - 1) : 0
      }

      return { cols: n, rows: m, cell: c, gx, gy, seamless: false }
    }

    /**
     * 整数定位（DESIGN.md §5.4）：给定边、格数、边长、缝，返回每格起点。
     * 首格贴 0、末格贴边；相邻缝在 g ± 1 内浮动。
     * @param {number} extent 总长（设备像素）。
     * @param {number} count 格数。
     * @param {number} cell 边长。
     * @param {number} gap 缝（约数）。
     * @param {boolean} seamless 是否把余量摊宽。
     * @param {number} spread 余量（无缝时）。
     * @returns {Array<{pos:number, size:number}>}
     */
    function computePositions(extent, count, cell, gap, seamless, spread) {
      const out = []
      if (count <= 1) {
        out.push({ pos: 0, size: extent })
        return out
      }
      if (seamless) {
        // 无缝：把整段长度平均摊给所有格（余量可能大于格数，不能只加在前 spread 格上）。
        for (let i = 0; i < count; i++) {
          const pos = Math.round((i * extent) / count)
          const end = i === count - 1 ? extent : Math.round(((i + 1) * extent) / count)
          out.push({ pos, size: Math.max(1, end - pos) })
        }
        return out
      }
      for (let i = 0; i < count; i++) {
        const pos = Math.round((i * (extent - cell)) / (count - 1))
        let size = cell
        if (i === count - 1) size = clamp(extent - pos, 1, cell + 1)
        out.push({ pos, size })
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
        { key: 'agents', label: '智能体数量', type: 'range', min: 60, max: 600, step: 10, default: 280 },
        { key: 'speed', label: '速度', type: 'range', min: 0.4, max: 2.4, step: 0.1, default: 1.2 },
        { key: 'trail', label: '拖尾', type: 'range', min: 0.9, max: 0.995, step: 0.005, default: 0.98 }
      ],
      create: createBoids
    })

    /** 鸟群算法：分离/对齐/聚合 + 环形边界 + 空间哈希。 */
    function createBoids({ cols, rows, seed, params }) {
      const rand = mulberry32(seed)
      const p = Object.assign({ agents: 280, speed: 1.2, trail: 0.98 }, params)
      const field = new Float32Array(cols * rows)
      const N = Math.round(p.agents)
      const pos = new Float32Array(N * 2)
      const vel = new Float32Array(N * 2)
      for (let i = 0; i < N; i++) {
        pos[i * 2] = rand() * cols
        pos[i * 2 + 1] = rand() * rows
        const ang = rand() * Math.PI * 2
        vel[i * 2] = Math.cos(ang) * p.speed
        vel[i * 2 + 1] = Math.sin(ang) * p.speed
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
          let sx = 0
          let sy = 0
          let ax = 0
          let ay = 0
          let cx = 0
          let cy = 0
          let cnt = 0
          for (const j of neighborsOf(i)) {
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
            if (d2 < R * R && d2 > 0) {
              const d = Math.sqrt(d2)
              sx += dx / d
              sy += dy / d
              ax += jx
              ay += jy
              cnt++
            }
            cx += dx
            cy += dy
          }
          const n = neighborsOf(i).length
          if (n > 0) {
            ax = (ax + (n - cnt) * ix) / n
            ay = (ay + (n - cnt) * iy) / n
            cx /= n
            cy /= n
          }
          let vx = vel[i * 2]
          let vy = vel[i * 2 + 1]
          // 分离 1.6 / 对齐 0.9 / 聚合 0.7
          vx += sx * 1.6 + (ax - ix) * 0.7
          vy += sy * 1.6 + (ay - iy) * 0.7
          // 对齐：向邻域平均速度靠拢
          let avgVX = 0
          let avgVY = 0
          let vcnt = 0
          for (const j of neighborsOf(i)) {
            avgVX += vel[j * 2]
            avgVY += vel[j * 2 + 1]
            vcnt++
          }
          if (vcnt > 0) {
            avgVX /= vcnt
            avgVY /= vcnt
            vx += (avgVX - vx) * 0.9
            vy += (avgVY - vy) * 0.9
          }
          const len = Math.sqrt(vx * vx + vy * vy) || 1
          const spd = p.speed
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

      return { field, step }
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
     * @param {(arg0: {cols:number, rows:number, cell:number, gx:number, gy:number, mode:string}) => void} onGrid 网格变化回调。
     * @returns {{updateConfig:(c:object)=>void, playPause:(p:boolean)=>void, destroy:()=>void}}
     */
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

      const ctx2d = canvas.getContext('2d')

      // 影响范围探测（由外部设置）
      const geometryOf = {}

      function setCoverageProvider(fn) {
        geometryOf.getRects = fn
      }

      /** 根据视口与配置计算网格。 */
      function computeGrid() {
        const dpr = window.devicePixelRatio || 1
        const Wdev = Math.round(window.innerWidth * dpr)
        const Hdev = Math.round(window.innerHeight * dpr)
        const g = cfg.grid || {}
        if (g.mode === 'manual' && g.cellWidth != null) {
          const mg = computeManualGrid(Wdev, Hdev, dpr, g.cellWidth, g.gap == null ? 0 : g.gap)
          return { ...mg, mode: 'manual', Wdev, Hdev, dpr, cellCss: g.cellWidth, gapCss: g.gap == null ? 0 : g.gap }
        }
        const ag = computeAutoGrid(Wdev, Hdev, dpr)
        return { ...ag, mode: 'auto', Wdev, Hdev, dpr }
      }

      /** 重设画布 backing store 到设备像素尺寸。 */
      function sizeCanvas(g) {
        canvas.width = g.Wdev
        canvas.height = g.Hdev
        canvas.style.width = '100%'
        canvas.style.height = '100%'
      }

      /** 建一支算法实例（seed / 算法 id 变化才重建）。 */
      function makeAlgorithm(g) {
        const def = algorithmOf(cfg.algorithm.id) || algorithmOf('boids')
        const inst = def.create({ cols: g.cols, rows: g.rows, seed: cfg.algorithm.seed, params: cfg.algorithm.params || {} })
        inst._cols = g.cols
        inst._rows = g.rows
        return inst
      }

      /** 最近邻重采样旧场到新尺寸；失败返回 null（触发重播种）。 */
      function resampleField(old, oCols, oRows, nCols, nRows) {
        if (!old || oCols === 0 || oRows === 0 || (oCols === nCols && oRows === nRows)) return old
        const out = new Float32Array(nCols * nRows)
        for (let y = 0; y < nRows; y++) {
          const sy = Math.min(oRows - 1, Math.floor(y * oRows / nRows))
          for (let x = 0; x < nCols; x++) {
            const sx = Math.min(oCols - 1, Math.floor(x * oCols / nCols))
            out[y * nCols + x] = old[sy * oCols + sx]
          }
        }
        return out
      }

      /** 渲染一帧。 */
      function draw() {
        if (destroyed || !grid) return
        // 宿主若重挂 body 子节点导致画布被移除，补回去（只在失联时做一次 DOM 操作）。
        if (typeof document !== 'undefined' && document.body && !canvas.isConnected) {
          document.body.insertBefore(canvas, document.body.firstChild)
        }
        const render = cfg.render
        // 画布不透明时先铺底色；透明化后直接画格子
        const cx = ctx2d
        cx.clearRect(0, 0, grid.Wdev, grid.Hdev)
        cx.fillStyle = render.background
        cx.fillRect(0, 0, grid.Wdev, grid.Hdev)

        const xPos = computePositions(grid.Wdev, grid.cols, grid.cell, grid.gx, grid.seamless, grid.spreadX || 0)
        const yPos = computePositions(grid.Hdev, grid.rows, grid.cell, grid.gy, grid.seamless, grid.spreadY || 0)

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

      function loop(ts) {
        if (destroyed) return
        if (lastTs === 0) lastTs = ts
        let dt = ts - lastTs
        lastTs = ts
        let stepped = false
        if (playing) {
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
        rafId = requestAnimationFrame(loop)
      }

      function updateConfig(c) {
        const prevAlgorithmId = cfg.algorithm && cfg.algorithm.id
        const prevSeed = cfg.algorithm && cfg.algorithm.seed
        const prevGrid = cfg.grid && cfg.grid.mode === 'manual' ? { w: cfg.grid.cellWidth, g: cfg.grid.gap } : 'auto'

        cfg = c
        playing = cfg.animation && cfg.animation.playing !== false

        const g = computeGrid()
        const gridChanged =
          g.cols !== grid.cols || g.rows !== grid.rows || g.mode !== grid.mode ||
          (grid.mode === 'manual' && (g.cell !== grid.cell || g.gx !== grid.gx || g.gy !== grid.gy))

        if (gridChanged) {
          // 重采样（保留旧场），除非算法/种子变化要重播种
          const algChanged = cfg.algorithm.id !== prevAlgorithmId || cfg.algorithm.seed !== prevSeed
          if (algChanged) {
            grid = g
            sizeCanvas(g)
            algorithm = makeAlgorithm(g)
          } else {
            const oldField = algorithm ? algorithm.field : null
            const oCols = grid ? grid.cols : 0
            const oRows = grid ? grid.rows : 0
            grid = g
            sizeCanvas(g)
            const resampled = resampleField(oldField, oCols, oRows, g.cols, g.rows)
            if (resampled) {
              algorithm = makeAlgorithm(g)
              algorithm.field = resampled
            } else {
              algorithm = makeAlgorithm(g)
            }
          }
          if (onGrid) {
            const dpr = g.dpr
            onGrid({
              cols: g.cols,
              rows: g.rows,
              cell: Math.round(g.cell / dpr * 10) / 10,
              gx: Math.round(g.gx / dpr * 10) / 10,
              gy: Math.round(g.gy / dpr * 10) / 10,
              mode: g.mode
            })
          }
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
          gy: Math.round(initial.gy / dpr * 10) / 10,
          mode: initial.mode
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
        destroy: () => { destroyed = true; if (rafId) cancelAnimationFrame(rafId) }
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

    /**
     * 注入最小规则让 html/body 背景透明；运行时探测铺满视口且背景不透明的元素，
     * 只清它的 background-color（探测失败就不清）。
     *
     * 注意：样式只在 apply 里写一次；这里只做 DOM 探测，可以被安全地重复调用。
     */
    function enforceTransparency() {
      if (typeof document === 'undefined') return
      try {
        // 根节点可能带 inline background，直接清掉最稳妥。
        document.documentElement.style.backgroundColor = 'transparent'
        if (document.body) document.body.style.backgroundColor = 'transparent'
        // 探测覆盖视口且背景不透明的元素，清 background-color
        const candidates = document.querySelectorAll('div, section, main, body > *')
        for (const el of candidates) {
          try {
            const r = el.getBoundingClientRect()
            if (r.width < window.innerWidth * 0.9 || r.height < window.innerHeight * 0.9) continue
            const cs = window.getComputedStyle(el)
            const bg = cs.backgroundColor
            if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
              el.style.backgroundColor = 'transparent'
            }
          } catch {
            // 单个元素失败跳过
          }
        }
      } catch {
        // 探测失败：宁可看不见也不破坏宿主
      }
    }

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

    async function getConfig() {
      const res = await fetch(`${API}/config`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`GET ${API}/config -> HTTP ${res.status}`)
      const data = await res.json()
      return data.config
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
    #${CANVAS_ID} { position: fixed; inset: 0; z-index: -1; pointer-events: none; width: 100%; height: 100%; }
    `

    const UI_CSS = `
    .pw-section{display:flex;flex-direction:column;gap:14px;padding:4px 0}
    .pw-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8)}
    .pw-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
    .pw-group{display:flex;flex-direction:column;gap:6px}
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

    /** 数值输入。 */
    function NumberField(props) {
      return h('label', { className: 'pw-row' },
        h('span', { className: 'pw-row-label', style: { flex: 1 } }, props.label),
        h('input', {
          className: 'pw-input',
          type: 'number',
          value: props.value,
          min: props.min,
          max: props.max,
          step: props.step || 1,
          onChange: (e) => props.onChange(Number(e.target.value))
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

      /** 网格信息行。 */
      const stats = gridInfo
        ? `当前 ${gridInfo.cols} × ${gridInfo.rows} 格 · ${gridInfo.cell}px / ${gridInfo.gx}px 间隔（${gridInfo.mode === 'auto' ? '自动' : '手动'}）`
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

      /** 从自动值切到手动：把当前算出的格子宽/缝写进配置。 */
      const toManual = () => {
        if (!gridInfo) return
        const cellWidth = Math.max(2, Math.min(40, Number(gridInfo.cell) || 9))
        const gap = Math.max(0, Math.min(20, Number(gridInfo.gx) || 0))
        patch((p) => ({ ...p, grid: { mode: 'manual', cellWidth, gap } }))
      }

      /** 通用参数区。 */
      const renderParamControls = h('div', { className: 'pw-group' },
        h('div', { className: 'pw-group-label' }, '通用配置'),
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
        h('div', { className: 'pw-group' },
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
              onClick: () => patch((p) => ({ ...p, render: { ...p.render, palette: ['#000000', '#ffffff'] } }))
            }, '灰白')
          )
        ),
        h('label', { className: 'pw-row' },
          h('span', { className: 'pw-row-label' }, '底色'),
          h('input', {
            type: 'color',
            className: 'pw-swatch',
            value: render.background,
            onChange: (e) => patch((p) => ({ ...p, render: { ...p.render, background: e.target.value } }))
          })
        ),
        h(NumberField, { label: '种子', value: algo.seed, min: 0, max: 999999, step: 1, onChange: (v) => patch((p) => ({ ...p, algorithm: { ...p.algorithm, seed: Math.round(v) } })) }),
        // 单元格宽 / 间隔（自动只读，改即转手动）
        (grid.mode === 'auto'
          ? h('div', { className: 'pw-row' },
            h('span', { className: 'pw-row-label' }, '单元格宽（自动）'),
            h('span', { className: 'pw-hint' }, gridInfo ? `${gridInfo.cell}px` : '—'),
            h('button', { className: 'pw-btn pw-btn-mini', disabled: !gridInfo, onClick: toManual }, '调整'))
          : h(NumberField, { label: '单元格宽', value: grid.cellWidth, min: 2, max: 40, onChange: (v) => patch((p) => ({ ...p, grid: { ...p.grid, mode: 'manual', cellWidth: v } })) })),
        (grid.mode === 'auto'
          ? h('div', { className: 'pw-row' },
            h('span', { className: 'pw-row-label' }, '间隔（自动）'),
            h('span', { className: 'pw-hint' }, gridInfo ? `${gridInfo.gx}px` : '—'),
            h('button', { className: 'pw-btn pw-btn-mini', disabled: !gridInfo, onClick: toManual }, '调整'))
          : h(NumberField, { label: '间隔', value: grid.gap, min: 0, max: 20, onChange: (v) => patch((p) => ({ ...p, grid: { ...p.grid, mode: 'manual', gap: v } })) })),
        h('div', { className: 'pw-row' },
          h('button', { className: 'pw-btn', onClick: () => patch((p) => ({ ...p, grid: { mode: 'auto', cellWidth: null, gap: null } })) }, '重置为自动'),
          h('span', { className: 'pw-grid-stats' }, stats)
        )
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
        // tab
        h('div', { className: 'pw-tabs' },
          h('div', { className: `pw-tab${tab === 'algorithm' ? ' pw-tab-active' : ''}`, onClick: () => setTab('algorithm') }, '算法'),
          h('div', { className: `pw-tab${tab === 'image' ? ' pw-tab-active' : ''}`, onClick: () => setTab('image') }, '图片')
        ),
        tab === 'algorithm'
          ? h('div', { className: 'pw-section' },
            renderParamControls,
            playControls,
            h('div', { className: 'pw-divid' }),
            algorithmSelect,
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
        version: 1,
        coverage: { header: true, left: true, right: true, input: false },
        grid: { mode: 'auto', cellWidth: null, gap: null },
        render: { shape: 'square', levels: 8, palette: ['#000000', '#ffffff'], gamma: 1.0, black: 0, white: 100, dither: 'none', background: '#000000' },
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
          // 设置页是后挂载的：补发最近一次网格信息，避免「单元格宽」一直显示 —。
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
      }

      // 启动时 GET 一次配置
      getConfig()
        .then((c) => { renderer.updateConfig(c) })
        .catch(() => { /* 宿主未就绪：用默认值 */ })

      // 可见性变化：隐藏暂停，恢复继续（保留最后一帧）
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
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
        })
      }

      // 区域测量：resize/DOM 变化时节流重测（节流 500ms）
      let lastMeasure = 0
      const scheduleMeasure = () => {
        const now = Date.now()
        if (now - lastMeasure < 500) return
        lastMeasure = now
        refreshRegions()
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('resize', scheduleMeasure)
      }
      if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(debounce(scheduleMeasure, 500))
        observer.observe(document.body, { childList: true, subtree: true })
        runtime.observer = observer
      }

      // ResizeObserver 观察 documentElement；matchMedia 监听 DPR 变化
      setupResizeHandlers(renderer, initialConfig)
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
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      let lastMode = seedConfig.grid && seedConfig.grid.mode
      try {
        const ro = new ResizeObserver(debounce(() => {
          if (rendererConfig) renderer.updateConfig(rendererConfig)
        }, 300))
        ro.observe(document.documentElement)

        // matchMedia 监听跨屏 DPR
        if (typeof window.matchMedia === 'function') {
          const mq = window.matchMedia('(resolution: 1dppx)')
          const handler = () => {
            if (rendererConfig) renderer.updateConfig(rendererConfig)
          }
          if (mq.addEventListener) mq.addEventListener('change', handler)
          else if (mq.addListener) mq.addListener(handler)
        }
      } catch {
        // 观察失败：不阻塞背景
      }
    }

    /**
     * 客户端入口。
     * @param {object} ctx 客户端上下文。
     */
    function apply(ctx) {
      try {
        if (typeof document !== 'undefined') {
          ensureStyle(STYLE_ID).textContent = BASE_CSS + UI_CSS
          enforceTransparency()
          // 客户端插件可能早于应用外壳挂载：延后补两次探测，避免被后挂载的不透明容器盖住。
          setTimeout(enforceTransparency, 300)
          setTimeout(enforceTransparency, 1500)
          startRenderer(ctx)
        }
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
        computeAutoGrid,
        computeManualGrid,
        computePositions,
        paletteAt,
        shadeToRgb,
        hexToRgb,
        clamp,
        registerAlgorithm,
        algorithmOf,
        algorithmIds,
        measureRegions,
        evenPalette,
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
