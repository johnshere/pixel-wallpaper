'use strict'

/**
 * 像素背景（pixel-wallpaper）—— DSH 宿主侧插件
 *
 * 一件事：注册 `/pixel-wallpaper/api/config` 的 GET/PUT 端点，作为设置页与画布
 * 之间共享配置的唯一持久化通道。配置实际读写交给 src/config.js（原子写）。
 *
 * 依赖策略：**只用 `ctx.*` 服务，不 import 任何 @deepseek-ai 包**（link 安装时
 * 从插件目录向上找不到宿主的 node_modules，裸 import 必失败）。
 *
 * @module pixel-wallpaper
 */

const { DEFAULT_CONFIG, readConfig, writeConfig } = require('./config')

const PLUGIN_ID = 'pixel-wallpaper'
const API_PREFIX = '/pixel-wallpaper/api'

/** HTTP 请求体上限（64KB）。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 安全取一个可选服务（webServer 必须走 ctx.get，见 file 底部说明）。
 * @param {object} ctx 插件上下文。
 * @param {string} name 服务名。
 * @returns {any} 服务实例或 undefined。
 */
function serviceOf(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    // ctx.get 不存在或运行时未就绪：退回直接取属性
  }
  try {
    return ctx ? ctx[name] : undefined
  } catch {
    return undefined
  }
}

/**
 * 插件主体。
 * @param {object} ctx cordis 上下文。
 */
function apply(ctx) {
  const sendJson = (res, status, payload) => {
    try {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body)
      })
      res.end(body)
    } catch {
      // 响应写出失败：能做的只有尽量不抛到宿主
      try {
        res.end()
      } catch {
        /* 忽略 */
      }
    }
  }

  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          const err = new Error(`${PLUGIN_ID}: 请求体超过 ${MAX_BODY_BYTES} 字节`)
          reject(err)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (!text) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })

  /**
   * HTTP 处理入口。
   * @param {object} req 请求。
   * @param {object} res 响应。
   */
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()

    try {
      if (pathname === `${API_PREFIX}/config`) {
        if (method === 'GET') {
          sendJson(res, 200, { config: readConfig() })
          return
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req)
          const config = writeConfig(body && body.config ? body.config : body)
          sendJson(res, 200, { config })
          return
        }
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: String((error && error.message) || error) })
    }
  }

  // 挂 HTTP 路由必须等 webServer 就绪（它的 init 是异步的），不能在此一次性 ctx.get。
  const registerRoutes = (webCtx) => {
    const webServer = serviceOf(webCtx, 'webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    try {
      webCtx.effect(
        () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle }),
        `${PLUGIN_ID}: http routes`
      )
    } catch {
      // 注册失败：降级为无 API（客户端会提示读取失败，但不影响宿主）
    }
  }
  try {
    ctx.inject(['webServer'], registerRoutes)
  } catch {
    // inject 失败（宿主无 webServer）：无 HTTP，静默跳过
  }
}

module.exports = {
  name: PLUGIN_ID,
  inject: [],
  apply,
  __internals: { DEFAULT_CONFIG, readConfig, writeConfig }
}
