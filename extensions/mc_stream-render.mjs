// -*- coding: utf-8 -*-
/**
 * mc_stream-render —— 「AI 视角」一帧的取景 + 渲染 + PNG 编码（mc_stream 的干活件）
 * ============================================================================
 * 单独拆出来是为了：
 *   ① `renderView` / `encodePng` / `ensureAtlas` 这三件事有依赖、也重，
 *      直播叠加层的主逻辑（HTTP、状态条、字幕）不该被它们拖着；
 *   ② 自检可以在**没有真 bot、没有 MC 客户端资源**的情况下测"取景参数算得对不对"。
 *
 * 性能：renderView 是**同步阻塞**的 JS 光栅器（4090 帮不上，纯单核 CPU）。
 *   实测含 PNG 编码：192×108 ≈ 13ms、320×180 ≈ 34ms、480×270 ≈ 76ms。
 *   所以帧率一定要在调用方（mc_stream）用闸门卡住，不要在这里自己定时。
 */
import { renderView } from './mc_view-render.mjs'
import { encodePng } from '../src/png.mjs'
import { ensureAtlas } from '../src/textures.mjs'

export const EYE_HEIGHT = 1.62

/** 贴图图集：第一次要读客户端 jar（几百毫秒），拿到就一直用；拿不到就退回纯色块 */
let atlasPromise = null
function atlasForRender () {
  if (!atlasPromise) {
    atlasPromise = ensureAtlas({ log: () => {} }).catch(() => null)
  }
  return atlasPromise
}

/** 半径内的实体（渲染远近用；太远的一律不画，省时间） */
export function nearEntities (bot, distance = 24) {
  const out = []
  try {
    const p = bot.entity.position
    for (const ent of Object.values(bot.entities ?? {})) {
      if (!ent || ent === bot.entity || !ent.position) continue
      try { if (ent.position.distanceTo(p) <= distance) out.push(ent) } catch { /* 单个实体坏了不影响别人 */ }
    }
  } catch { /* 世界还没加载 */ }
  return out
}

/**
 * 取一帧（PNG Buffer）。
 * @returns {Promise<{png: Buffer, width: number, height: number, renderMs: number} | null>}
 *          `null` = 现在没有可画的画面（没进服 / 区块没加载），调用方回 204 就行。
 */
export async function framePng ({ bot, width = 320, height = null, distance = 24, atlas = true } = {}) {
  if (!bot?.entity?.position || !bot.world) return null
  const w = Math.round(width)
  const h = Math.round(height ?? Math.max(54, (w * 9) / 16))
  const t0 = Date.now()
  let atl = null
  if (atlas) {
    try { atl = await atlasForRender() } catch { atl = null }
  }
  const p = bot.entity.position
  const frame = renderView({
    world: bot.world,
    origin: [p.x, p.y + EYE_HEIGHT, p.z],
    yaw: bot.entity.yaw,
    pitch: bot.entity.pitch,
    width: w,
    height: h,
    crosshair: true,
    entities: nearEntities(bot, distance),
    time: bot.time?.timeOfDay,
    dimension: bot.game?.dimension,
    held: bot.heldItem ?? null,
    atlas: atl,
  })
  if (!frame) return null
  const png = encodePng(w, h, frame.rgba)
  return { png, width: w, height: h, renderMs: Date.now() - t0, stats: frame.stats }
}
