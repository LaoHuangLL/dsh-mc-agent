/**
 * 地图那一层（路线图第 ④ 条第十一刀）：俯视地形（地表图）、地板层视图、字符图、RGBA 像素图。
 *
 * 三条约定：
 *   ① **不反向 import `core.mjs`** —— 缺什么就往下依赖 `block-names.mjs`；
 *   ② 只 import `vec3`（不是 mineflayer）：`bot.blockAt()` 必须喂**真 Vec3**，
 *      传普通 `{x,y,z}` 会在 `prismarine-world` 里报 `pos.floored is not a function`；
 *   ③ **只读、不 await、同步**：整块是同步扫描（`heightmapOf` 自带 2.5 秒软上限，
 *      到点就停并标 `truncated`，见 `tools\check-core-map.mjs` 与审计报告 ⑨）。
 *
 * 2026-10-22（用户要求「把 cave 去掉」）：**洞穴层视图整块删除** —— `isUnderground()`、
 * `caveCell()`、`CAVE_GLYPH` / `CAVE_LABEL`、`heightmap` 的 `mode`/`slab` 参数全没了。
 * `mc_map` 现在只有 `floor`（默认）/ `surface` / `column`。
 *
 * `heightmap` / `static glyphMap` / `mapImage` 在 `core.mjs` 里
 * **留同名薄包装**（它们是公开面：`index.js`、`tools\check-core-map.mjs`、
 * `实机验证\地图\live-map.mjs` 都在用），所以这一刀不需要 re-export。
 */

import { Vec3 } from 'vec3'
import { worldBoundsOf } from './world-observer.mjs'
import { isAir, isLiquid, isPassable, isSolidBlock, glyphOf, colorOf, FLOOR_LABEL, FLOOR_GLYPH } from './block-names.mjs'
import { rgbaOfNames } from './worker-tasks.mjs'
import { runInWorker } from './worker-pool.mjs'

/* ═══════════════════════════════════════════════════════════════════════════
 * 脚下方块那一层（"地板层"视图）—— 2026-10-15 用户需求
 *
 * 地板图问"**这一层本身**是什么、站上去会不会掉"（不是"我这格站不站得下"），
 * 所以判据是"这一层的方块本身 + 往下几格内有没有地板"，不是"我身体那两格有没有被占"。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 从 `fromY` 往下最多 `depth` 格，找第一块**能当地板**的实心方块，返回它的 y。
 * 找不到（下面全是空气/液体，或区块没加载）**一律回 null** —— 未知就是未知，不猜。
 */
function surfaceBelow (b, x, fromY, z, depth) {
  const D = Math.min(Math.max(Number(depth) || 0, 0), 8)
  for (let y = fromY; y >= fromY - D; y--) {
    const blk = b.blockAt(new Vec3(x, y, z))
    if (!blk) return null                      // 未加载 → 未知（不能当成"到底了"）
    if (!isSolidBlock(blk.name)) continue      // 空气/液体/能穿过去的小东西都不是地板
    return y
  }
  return null
}

/**
 * **地板层视图的一格**：`layerY` 这一层在 (x, z) 处是什么、站上去会怎样。
 *
 * 返回（字段名就是用户 2026-10-15 给的结构体）：
 * ```
 * { x, z, y, floor, surfaceY, kind, supported, hazard, loaded }
 * ```
 * · `y`         查询层（默认 = 我脚底下那层 = `feetY - 1`）
 * · `floor`     这一层的方块名；`null` = 区块没加载
 * · `surfaceY`  往脚下最多 `depth` 格能找到的地板高度；**找不到就是 null**（深不见底/未加载）
 * · `kind`      `walkable`（能站）/ `blocked`（这一层实心、但身体那两格被占）/ `drop`（这一层是空的）
 *               / `liquid`（水/岩浆）/ `unknown`（未加载）
 * · `supported` 脚下（`y` 这一格）是不是实心、能不能托住我
 * · `hazard`    `'lava'` / `'water'` / `null`
 * · `loaded`    这格有没有已加载的区块数据
 *
 * 🔴 两条禁令（用户明确要求）：
 *   ① **`blockAt()` 返回 null 绝不能当成空气** —— 那是"区块没加载"，必须如实标 `unknown`，
 *      否则未加载区会被画成"能走"，模型会径直走过去；
 *   ② **"脚下是实心方块"不等于"能站"** —— 还要看身体那两格（`y+1` / `y+2`）有没有被占。
 */
export function floorCell (b, x, layerY, z, { depth = 4 } = {}) {
  const cell = {
    x, z, y: layerY, floor: null, surfaceY: null,
    kind: 'unknown', supported: false, hazard: null, loaded: false,
  }
  const blk = b.blockAt(new Vec3(x, layerY, z))
  if (!blk) {                                  // ① 未加载：如实说"不知道"
    /* 2026-10-23：y 在世界上下界之外同样读成 null —— 那是"根本没有这一层"，
       不是"再等等就加载"，单独标出来。 */
    const bd = worldBoundsOf(b)
    if (!(layerY >= bd.minY && layerY <= bd.maxY)) cell.outOfWorld = true
    return cell
  }
  cell.floor = blk.name
  cell.loaded = true
  const nm = blk.name

  if (isLiquid(nm)) {
    cell.kind = 'liquid'
    cell.hazard = /lava/.test(nm) ? 'lava' : 'water'
    cell.surfaceY = surfaceBelow(b, x, layerY - 1, z, depth)
    return cell
  }

  if (isSolidBlock(nm)) {
    cell.supported = true
    cell.surfaceY = layerY
    // ② 实心 ≠ 能站：身体那两格也得空着（液体不算占位 —— 能游过去）
    let free = true
    for (let y = layerY + 1; y <= layerY + 2; y++) {
      const body = b.blockAt(new Vec3(x, y, z))
      if (!body) {                             // 身体那格读不到 ⇒ 整格退回"未知"，不硬猜
        cell.kind = 'unknown'; cell.loaded = false; cell.supported = false; cell.surfaceY = null
        return cell
      }
      if (!isPassable(body.name) && !isAir(body.name) && !isLiquid(body.name)) { free = false; break }
    }
    cell.kind = free ? 'walkable' : 'blocked'
    return cell
  }

  // ③ 这一层是空的 ⇒ 会掉下去；`surfaceY` 告诉你掉到哪一层（null = 探不到底/未加载）
  cell.kind = 'drop'
  cell.surfaceY = surfaceBelow(b, x, layerY - 1, z, depth)
  return cell
}

/** 格 → 合成名（就是 `FLOOR_GLYPH` 的键，字符图/图例/配色都用它） */
export function floorKeyOf (cell) {
  if (!cell || cell.kind === 'unknown') return 'floor_void'
  if (cell.kind === 'liquid') return cell.hazard === 'lava' ? 'floor_lava' : 'floor_water'
  if (cell.kind === 'walkable') return 'floor_walk'
  if (cell.kind === 'blocked') return 'floor_wall'
  return 'floor_drop'
}

/**
 * **脚下方块那一层**的地图（2026-10-15 用户需求）：默认 `layer = feetY - 1`。
 *
 * 先统一算出一整片**结构化的格**（`cells`），字符图 / 像素图 / 导航摘要全从它派生 ——
 * 不再各自重新读世界、各自算坐标（用户"第二刀"的明确要求）。
 *
 * 坐标（用户"第三刀"）：`names` 是 `(2R)×(2R)`；行 `i` ↔ 世界 z = `originZ + i*cellSize`，
 * 列 `j` ↔ 世界 x = `originX + j*cellSize`。这里 `cellSize = 1`（一格就是 1 个方块）；
 * 工具层按 `glyphStep` 抽稀时会把它改成**实际步长**，所以换算**必须**走 `gridToWorld()`。
 */
export function floorMapOf (b, { radius = 32, layer = null, depth = 4 } = {}) {
  const R = Math.min(Math.max(Number(radius) || 32, 4), 96)
  const cx = Math.floor(b.entity.position.x)
  const cy = Math.floor(b.entity.position.y)
  const cz = Math.floor(b.entity.position.z)
  /* 🔴 `Number(null) === 0` 且 `Number.isFinite(0)` 为真 —— 只写 `Number.isFinite(Number(layer))`
   *    会把"没传 layer"当成"要看 y=0 那一层"。必须先排掉 null / undefined / 空串。 */
  const layerGiven = layer !== null && layer !== undefined && layer !== '' && Number.isFinite(Number(layer))
  const layerY = layerGiven ? Math.floor(Number(layer)) : cy - 1
  const D = Math.min(Math.max(Number(depth) || 4, 0), 8)

  const cells = []
  const names = []
  const legend = new Map()
  const counts = { walkable: 0, blocked: 0, drop: 0, liquid: 0, unknown: 0 }
  let unloaded = 0
  let truncated = false
  let scannedRows = 0
  const t0 = Date.now()
  const budgetMs = 2_500

  for (let dz = -R; dz < R; dz++) {
    if (Date.now() - t0 > budgetMs) { truncated = true; break }
    const row = []
    const nrow = []
    for (let dx = -R; dx < R; dx++) {
      const cell = floorCell(b, cx + dx, layerY, cz + dz, { depth: D })
      const key = floorKeyOf(cell)
      row.push(cell)
      nrow.push(key)
      counts[cell.kind] = (counts[cell.kind] ?? 0) + 1
      if (cell.kind === 'unknown') unloaded++
      legend.set(key, (legend.get(key) ?? 0) + 1)
    }
    cells.push(row)
    names.push(nrow)
    scannedRows++
  }
  while (names.length < R * 2) {
    names.push(new Array(R * 2).fill('floor_void'))
    cells.push(new Array(R * 2).fill(null))
  }

  const map = {
    mode: 'floor',
    center: { x: cx, y: cy, z: cz },
    layer: { y: layerY, depth: D },
    radius: R,
    cellSize: 1,
    originX: cx - R,
    originZ: cz - R,
    bounds: {
      minX: cx - R, maxX: cx + R - 1,
      minZ: cz - R, maxZ: cz + Math.max(0, scannedRows) - 1,
    },
    names, cells, counts, unloaded, truncated, scannedRows,
    complete: !truncated,
    colors: names.map((row) => row.map(colorOf)),
    legend: [...legend.entries()].sort((a, b2) => b2[1] - a[1])
      .map(([key, count]) => ({ name: FLOOR_LABEL[key] ?? key, key, glyph: FLOOR_GLYPH[key] ?? '?', count })),
    ...(truncated ? { note: `范围太大，只扫了前 ${scannedRows} 行（剩下的行是空的）—— 想看全就调小 radius` } : {}),
  }
  map.hazards = hazardCellsOf(map, { limit: 16 })
  return map
}

/**
 * 格坐标（行/列）↔ 真实世界坐标。`cellSize` 是**实际抽稀步长**（`glyphStep`），
 * 所以**别自己乘** —— 一律用这两个函数换算，否则改了 `glyphStep` 坐标就全错。
 */
/* ═══════════════════════════════════════════════════════════════════════════
 * 竖直剖面（x / z 切片）—— 2026-10-25 用户：「map floor 加 x z all 的功能，默认还是 y」
 *
 * floor 原来是**水平切片**（固定 y，看 x-z 平面）。这里补另外两个方向：
 *   axis="x" ⇒ 固定 x，横轴是 z、纵轴是 y（从 y+up 一路看到 y-down）
 *   axis="z" ⇒ 固定 z，横轴是 x、纵轴是 y
 * 剖面不判断"能不能站"（那是 floor 的语义），只如实报**那一格是什么** ——
 * 挖矿/看洞顶/看有没有落石，需要的就是这个。
 * ═══════════════════════════════════════════════════════════════════════════ */
export const SLICE_GLYPH = { solid: '#', air: '.', liquid: '~', lava: '≈', unknown: '?', me: '@' }
export const SLICE_LABEL = { solid: '实心', air: '空气', liquid: '水', lava: '岩浆', unknown: '未加载', me: '我' }

/** 一格在世界里是什么（剖面用）：solid / air / liquid / lava / unknown */
export function sliceKeyOf (b, x, y, z) {
  let blk = null
  try { blk = b.blockAt(new Vec3(x, y, z)) } catch { return 'unknown' }
  if (!blk) return 'unknown'
  const nm = blk.name
  if (isLiquid(nm)) return /lava/.test(nm) ? 'lava' : 'liquid'
  if (isSolidBlock(nm)) return 'solid'
  return 'air'
}

/**
 * 竖直剖面：固定一条 x（或 z），把 y 从 `cy+up` 到 `cy-down` 逐层扫出来。
 * @returns {{mode:'slice',axis:'x'|'z',fixed:number,radius:number,up:number,down:number,
 *            topY:number,bottomY:number,names:string[][],self:({row:number,col:number}|null),
 *            counts:object,truncated:boolean}}
 */
export function sliceMapOf (b, { axis = 'x', layer = null, radius = 32, up = 20, down = 12 } = {}) {
  const ax = axis === 'z' ? 'z' : 'x'
  const R = Math.min(Math.max(Number(radius) || 32, 4), 96)
  const U = Math.min(Math.max(Number(up) || 20, 1), 64)
  const Dn = Math.min(Math.max(Number.isFinite(Number(down)) ? Number(down) : 12, 0), 64)
  const cx = Math.floor(b.entity.position.x)
  const cy = Math.floor(b.entity.position.y)
  const cz = Math.floor(b.entity.position.z)
  const layerGiven = layer !== null && layer !== undefined && layer !== '' && Number.isFinite(Number(layer))
  const fixed = layerGiven ? Math.floor(Number(layer)) : (ax === 'x' ? cx : cz)
  const topY = cy + U
  const bottomY = cy - Dn
  const names = []
  const counts = { solid: 0, air: 0, liquid: 0, lava: 0, unknown: 0 }
  const t0 = Date.now()
  let truncated = false
  for (let y = topY; y >= bottomY; y--) {
    if (Date.now() - t0 > 2_500) { truncated = true; break }
    const row = []
    for (let d = -R; d < R; d++) {
      const x = ax === 'x' ? fixed : cx + d
      const z = ax === 'x' ? cz + d : fixed
      const k = sliceKeyOf(b, x, y, z)
      row.push(k)
      counts[k] = (counts[k] ?? 0) + 1
    }
    names.push(row)
  }
  /* 自己那一格：只有"固定的那条线"正好穿过我时才有意义 */
  const onLine = ax === 'x' ? (fixed === cx) : (fixed === cz)
  return {
    mode: 'slice', axis: ax, fixed, radius: R, up: U, down: Dn,
    center: { x: cx, y: cy, z: cz },
    topY, bottomY, names, counts, truncated,
    self: onLine ? { row: topY - cy, col: R } : null,
  }
}

/** 剖面字符图：行 = y（从上到下），列 = 另一条水平轴（-R..R-1） */
export function sliceMapText (m, { step = 1, compress = false } = {}) {
  const st = Math.min(Math.max(Math.floor(Number(step) || 1), 1), 8)
  const out = []
  for (let r = 0; r < m.names.length; r += st) {
    let line = ''
    for (let c = 0; c < m.names[r].length; c += st) {
      const isSelf = m.self && Math.abs(r - m.self.row) < st && Math.abs(c - m.self.col) < st
      line += isSelf ? SLICE_GLYPH.me : (SLICE_GLYPH[m.names[r][c]] ?? '?')
    }
    out.push(compress ? rleGlyphs(line) : line)
  }
  return out.join('\n')
}

export function gridToWorld (row, col, map) {
  const size = Number(map?.cellSize) || 1
  return {
    x: Number(map?.originX ?? 0) + Number(col) * size,
    z: Number(map?.originZ ?? 0) + Number(row) * size,
  }
}

/** 危险/要留意的一格：岩浆 > 水 > 会掉下去 > 未加载（排序用） */
const HAZARD_RANK = { lava: 0, water: 1, drop: 2, unloaded: 3 }
const HAZARD_KIND = {
  floor_lava: 'lava', floor_water: 'water', floor_drop: 'drop', floor_void: 'unloaded',
  lava: 'lava', water: 'water',
}

/**
 * 从一张地图里挑出**要留意**的格（岩浆/水/深坑/未加载），按"危险程度 + 到中心的距离"排序。
 * 坐标一律走 `gridToWorld()`，所以对抽稀过的字符图也准。
 */
export function hazardCellsOf (map, { limit = 16 } = {}) {
  const out = []
  const names = map?.names ?? []
  const R = Number(map?.radius ?? 0)
  for (let row = 0; row < names.length; row++) {
    const line = names[row] ?? []
    for (let col = 0; col < line.length; col++) {
      const kind = HAZARD_KIND[line[col]]
      if (!kind) continue
      const w = gridToWorld(row, col, map)
      out.push({ x: w.x, z: w.z, kind, d: Math.round(Math.max(Math.abs(col - R), Math.abs(row - R)) * 10) / 10 })
    }
  }
  out.sort((a, b2) => (HAZARD_RANK[a.kind] ?? 9) - (HAZARD_RANK[b2.kind] ?? 9) || a.d - b2.d)
  return out.slice(0, limit)
}

/* Minecraft 的方位：+x = 东，+z = 南（北 = -z）；0° = 北，顺时针 */
const DIR_NAMES = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
function dirName (dx, dz) {
  if (!dx && !dz) return '脚下'
  const ang = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360
  return DIR_NAMES[Math.round(ang / 45) % 8]
}

/** `"x,y,z"` / `"x y z"` / `{x,y,z}` → 点（认不出来就 null） */
export function parsePoint (t) {
  if (t && typeof t === 'object') {
    const x = Number(t.x); const z = Number(t.z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    const y = Number(t.y)
    return { x: Math.round(x), y: Number.isFinite(y) ? Math.round(y) : null, z: Math.round(z) }
  }
  const m = String(t ?? '').match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/)
  if (!m) return null
  return { x: Math.round(Number(m[1])), y: Math.round(Number(m[2])), z: Math.round(Number(m[3])) }
}

/**
 * 目标 → 相对位置。`target` 可以是 `"x,y,z"` / `{x,y,z}` / 它们的数组。
 * 🔴 只算**相对位置**（距离/方位/高差），**不代表路通、也不代表挖得到**。
 */
export function navTargetsOf (map, target) {
  const list = Array.isArray(target) ? target : (target ? [target] : [])
  const out = []
  for (const raw of list) {
    const p = parsePoint(raw)
    if (!p) continue
    const dx = p.x - Number(map?.center?.x ?? 0)
    const dz = p.z - Number(map?.center?.z ?? 0)
    out.push({
      ...p, dx, dz, dir: dirName(dx, dz),
      d: Math.round(Math.hypot(dx, dz) * 10) / 10,
      dy: p.y == null ? null : p.y - Number(map?.layer?.y ?? map?.center?.y ?? 0),
    })
  }
  return out
}

/**
 * 把地图翻成**给模型读的补充摘要**（用户"第一刀"的 `purpose`）。
 *
 * `purpose`：`overview`（不加东西）/ `navigation`（目标相对位置 + 可站占比 + 建议）/
 *            `hazards`（先列岩浆/水/深坑/未加载的坐标）。
 *
 * 🔴 职责边界（用户明确要求）：**目标坐标由 `mc_scan` 提供；地形与危险由地图提供；
 *    真实路线可达性交给 pathfinder；能不能挖由动作工具动手前再验证。**
 *    所以这段文案里**不许**出现"路是通的 / 能挖到"这类地图推不出来的结论。
 */
export function navSummaryOf (map, { purpose = 'overview', target = null } = {}) {
  const lines = []
  const nearbyTargets = navTargetsOf(map, target)
  const cells = map?.radius ? (map.radius * 2) ** 2 : 0
  const c = map?.counts ?? {}

  if (purpose === 'navigation') {
    lines.push(`🧭 覆盖 x ${map?.bounds?.minX}…${map?.bounds?.maxX} · z ${map?.bounds?.minZ}…${map?.bounds?.maxZ}（真实坐标）`
      + ` ｜ 每格 ${map?.cellSize ?? 1} 方块 ｜ 扫描${map?.complete ? '完整' : `被截断（只扫了前 ${map?.scannedRows} 行）`}`)
    if (map?.mode === 'floor') {
      const pct = cells ? Math.round(((c.walkable ?? 0) / cells) * 100) : 0
      lines.push(`可站立 ${c.walkable ?? 0} 格（${pct}%）｜ 墙 ${c.blocked ?? 0} ｜ 会掉下去 ${c.drop ?? 0} ｜ 液体 ${c.liquid ?? 0} ｜ 未加载 ${c.unknown ?? 0}`)
    }
    if (nearbyTargets.length) {
      for (const t of nearbyTargets) {
        lines.push(`🎯 目标 (${t.x}, ${t.y ?? '?'}, ${t.z}) ｜ 直线距离 ${t.d} 格 ｜ 方位 ${t.dir}`
          + `${t.dy == null ? '' : ` ｜ 相对本层 dy=${t.dy >= 0 ? '+' : ''}${t.dy}`}`)
      }
      lines.push('（这只是**坐标和地形**：路通不通要 `mc_move`/pathfinder 真走一次；动手挖之前再 `mc_scan` 复核一眼目标还在不在。）')
    } else {
      lines.push('🎯 没给 target：想算相对方位就把 `mc_scan` 找到的坐标用 `target:"x,y,z"` 传进来。')
    }
  }

  if (purpose === 'hazards') {
    const hz = map?.hazards ?? hazardCellsOf(map, { limit: 16 })
    const NAME = { lava: '岩浆', water: '水', drop: '深坑', unloaded: '未加载' }
    if (!hz.length) {
      lines.push('✅ 扫到的范围里没有岩浆 / 水 / 深坑 / 未加载。')
    } else {
      lines.push(`⚠️ 要留意的格（按危险程度排，最多 8 个）：`
        + hz.slice(0, 8).map((h) => `${NAME[h.kind] ?? h.kind}(${h.x}, ${h.z}) 距 ${h.d}`).join(' ｜ '))
      lines.push(`（共扫到 ${hz.length} 处；深坑 = 这一层空、往下 ${map?.layer?.depth ?? 4} 格内没地板。坐标是真实世界坐标。）`)
    }
  }

  return { lines, nearbyTargets }
}

/**
 * 俯视地形（**地表图**）：返回 { names（二维字符数组）, legend, center, unloaded, mode }
 *
 * 2026-10-22（用户要求「把 cave 去掉」）：**洞穴层视图已删除**，没有 `mode` / `slab`
 * 参数了，返回的 `mode` 恒为 `'surface'`。默认层仍是地板层视图 `floorMapOf()`；
 * 这条只有 `mc_map {mode:"surface"}` 显式要走时才走到。
 *
 * 2026-10-15：补上 `originX/originZ/cellSize/bounds/complete`，让"字符图第几行第几列"
 * 能换算回真实坐标（`gridToWorld()`）。
 */
export function heightmapOf (b, { radius = 32, yTop = 10, yBottom = -24 } = {}) {
  const R = Math.min(Math.max(radius, 4), 96)
  const cx = Math.floor(b.entity.position.x)
  const cz = Math.floor(b.entity.position.z)
  const cy = Math.floor(b.entity.position.y)
  const names = []
  const legend = new Map()
  let unloaded = 0
  /* 🔴 2026-10-08 第五份审计报告 ⑨：`heightmap`/`mapImage` 全是**同步**代码、内部没有任何
   *    `msLeft()` 检查 ⇒ radius=96 + surface 约 3.7 万格 × 最多 34 次 `blockAt`（百万级调用）
   *    会**阻塞事件循环**数秒（物理/看门狗/其它工具全停），11 秒约定形同虚设。
   *    现在给自己一个 2.5 秒的软上限：到点就停，剩下的行填 null（几何不变，标记 `truncated`）。 */
  const t0 = Date.now()
  const budgetMs = 2_500
  let truncated = false

  let scannedRows = 0
  for (let dz = -R; dz < R; dz++) {
    if (Date.now() - t0 > budgetMs) { truncated = true; break }
    const row = []
    for (let dx = -R; dx < R; dx++) {
      let nm = null
      for (let y = cy + yTop; y >= cy + yBottom; y--) {
        const blk = b.blockAt(new Vec3(cx + dx, y, cz + dz))
        if (!blk) { nm = null; break }
        if (!isAir(blk.name)) { nm = blk.name; break }
      }
      if (nm === null) unloaded++
      legend.set(nm ?? 'unloaded', (legend.get(nm ?? 'unloaded') ?? 0) + 1)
      row.push(nm)
    }
    names.push(row)
    scannedRows++
  }
  while (names.length < R * 2) names.push(new Array(R * 2).fill(null))
  return {
    center: { x: cx, y: cy, z: cz }, radius: R, unloaded, names, mode: 'surface', truncated, scannedRows,
    colors: names.map((row) => row.map(colorOf)),
    originX: cx - R, originZ: cz - R, cellSize: 1,
    bounds: { minX: cx - R, maxX: cx + R - 1, minZ: cz - R, maxZ: cz + Math.max(0, scannedRows) - 1 },
    complete: !truncated,
    ...(truncated ? { note: '范围太大，只扫了一部分（剩下的行是空的）—— 想看全就调小 radius' } : {}),
    legend: [...legend.entries()].sort((a, b2) => b2[1] - a[1]).map(([name, count]) => ({ name, count })),
  }
}

/** 行内游程压缩：同一字符连续 ≥4 个写成 `X*n`（`*` 不是任何 glyph，所以不会歧义）。
 *  2026-10-23 审计：一次 mc_map 的 84% 字符量都在这张图上，实测 1055 → 613。
 *  🔴 2026-10-23 晚（用户 m05002：「map · surface 的输出怎么这么奇怪」）：**默认不再压缩**。
 *  开阔地整行同字符 ⇒ 一行变成 `"*16` 这种串，**看不出任何形状**（只报了数量），
 *  模型拿它没法判断"哪边能走"。省下的 400 来字符（≈250 token）不值。
 *  现在只有调用方显式要 `compress:true` 才走这里。 */
export function rleGlyphs (line) {
  let out = ''
  let i = 0
  while (i < line.length) {
    const c = line[i]
    let n = 1
    while (i + n < line.length && line[i + n] === c) n++
    out += n >= 4 ? c + '*' + n : c.repeat(n)
    i += n
  }
  return out
}

/** 字符地形图（无视觉也能读） */
export function glyphMapText (names, step = 2, selfIndex = null, { compress = false } = {}) {
  const out = []
  for (let y = 0; y < names.length; y += step) {
    let line = ''
    for (let x = 0; x < names[y].length; x += step) {
      /* 2026-10-23 审计：`x`/`y` 是**按 step 递增**的原始下标，而 selfIndex 用的是 radius；
       * 以前要求严格相等 ⇒ radius 不是 step 整数倍时永远画不出 `@`（字符图变无锚点地图）。
       * 改成「落在自己那格半径 step 内」。 */
      const isSelf = selfIndex && Math.abs(y - selfIndex.y) < step && Math.abs(x - selfIndex.x) < step
      line += isSelf ? '@' : glyphOf(names[y][x])
    }
    out.push(compress ? rleGlyphs(line) : line)
  }
  return out.join('\n')
}

/**
 * 俯视地形 → RGBA 像素图（需求 7：视觉模型看图像比看字符强）。
 *
 * 字符图仍是默认（当前模型无视觉）；本方法给"有视觉的模型 / 要发给用户看"用。
 * 每格放大 scale 倍（最近邻），并在自己所在格画一个白框方便定位。
 *
 * @returns {{width:number,height:number,rgba:Uint8Array,center:object,radius:number,unloaded:number,legend:Array}}
 */
export function mapImageOf (b, { radius = 32, scale = 4, yTop = 10, yBottom = -24, markSelf = true, mode = 'surface', layer = null, depth = 4 } = {}) {
  /* 2026-10-15：`mode:'floor'`（脚下方块那一层）也出图 —— 两条路的返回形状一样
   * （names/colors/center/radius/unloaded/legend），下面一行都不用改。
   * 2026-10-22：`cave` 删了，这里只剩 `'floor'` 和 `'surface'` 两种（默认 surface）。 */
  const hm = mode === 'floor'
    ? floorMapOf(b, { radius, layer, depth })
    : heightmapOf(b, { radius, yTop, yBottom })
  const h = hm.names.length
  const w = h > 0 ? hm.names[0].length : 0
  if (!w || !h) throw new Error('地形数据为空（区块可能还没加载）')

  const s = Math.min(Math.max(Number(scale) || 4, 1), 16)
  const img = rgbaOfNames(pixelPayloadOf(hm, { scale: s, markSelf }))

  return {
    width: img.width, height: img.height, rgba: img.rgba,
    center: hm.center, radius: hm.radius, unloaded: hm.unloaded,
    legend: hm.legend.slice(0, 15),
    scale: s,
  }
}

/**
 * `mapImageOf` 的**异步版**：把"字符网格 → 像素"这段纯计算交给 Worker 线程池
 * （`DSH_MC_AGENT_WORKERS` 开着才会真搬；关着 / 活太小 / 起不了线程 ⇒ 原地算，结果一样）。
 *
 * 2026-10-15 实测：`radius:96, scale:16` ⇒ 943 万像素，纯循环 28.2ms、整条 36.1ms ——
 * 这是**唯一**一个既超过 30ms 阈值、又不需要 bot 对象的候选，所以只搬这一段。
 * 扫地形那部分（`blockAt` 百万次）在主线程跑，搬不动。
 *
 * @returns {Promise<object>} 形状与 `mapImageOf()` 一致，另带 `via`/`workerMs`
 */
export async function mapImageOfAsync (b, opts = {}) {
  const { radius = 32, scale = 4, yTop = 10, yBottom = -24, markSelf = true, mode = 'surface', layer = null, depth = 4 } = opts
  const hm = mode === 'floor'
    ? floorMapOf(b, { radius, layer, depth })
    : heightmapOf(b, { radius, yTop, yBottom })
  const h = hm.names.length
  const w = h > 0 ? hm.names[0].length : 0
  if (!w || !h) throw new Error('地形数据为空（区块可能还没加载）')

  const s = Math.min(Math.max(Number(scale) || 4, 1), 16)
  const payload = pixelPayloadOf(hm, { scale: s, markSelf })
  /* 粗略估一下：每格 s² 个像素，每个像素几纳秒 —— 只用来决定"值不值得搬" */
  const estMs = (w * h * s * s * 4) / 4e6
  const r = await runInWorker('rgbaOfNames', payload, { estMs, transfer: [payload.idx.buffer] })
  const img = r.value
  return {
    width: img.width, height: img.height, rgba: img.rgba,
    center: hm.center, radius: hm.radius, unloaded: hm.unloaded,
    legend: hm.legend.slice(0, 15),
    scale: s,
    via: r.via, workerMs: r.ms,
    ...(r.workerError ? { workerError: r.workerError } : {}),
  }
}

/**
 * 把 `heightmapOf`/`floorMapOf` 的字符网格压成"调色板 + 下标数组"。
 *
 * 为什么不直接把 `names`（二维字符串数组）丢给线程：结构化克隆 3.7 万个字符串很贵，
 * 而方块名一般只有几种。压成 `Uint16Array` + 小 `palette` 之后，
 * 下标数组还能**零拷贝转移**过去。
 */
export function pixelPayloadOf (hm, { scale = 4, markSelf = true } = {}) {
  const names = hm.names
  const h = names.length
  const w = h > 0 ? names[0].length : 0
  const palette = []
  const seen = new Map()
  const idx = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = names[y]
    for (let x = 0; x < w; x++) {
      const nm = row[x]
      const key = nm === null || nm === undefined ? '\u0000null' : String(nm)
      let k = seen.get(key)
      if (k === undefined) {
        k = palette.length
        if (k > 65535) k = 0            // 不会发生（方块名就那几百种），保险起见
        else { seen.set(key, k); palette.push(key === '\u0000null' ? null : String(nm)) }
      }
      idx[y * w + x] = k
    }
  }
  return { idx, palette, width: w, height: h, scale, markSelf }
}


/* ───────────── 竖列图（2026-10-15 用户需求：让 AI 知道脚底下有没有空的） ───────────── */

/** 竖列图每格的字形（与地板图/地表图刻意不同：这里 `#` 就是"实心"，不掺"能不能站人"） */
export const COLUMN_GLYPH = { solid: '#', air: '.', water: '~', lava: '≈', unloaded: '?' }
export const COLUMN_LABEL = { solid: '实心', air: '空腔', water: '水', lava: '岩浆', unloaded: '未加载' }
/** 一次最多往下看几格（再深就该用 mc_scan 或 mc_move 了） */
export const COLUMN_MAX = 96
/** 头顶一次最多往上看几格（默认 40） */
export const COLUMN_UP_DEFAULT = 40
export const COLUMN_UP_MAX = 96

/**
 * 一格方块在"会不会托住你"这个意义上的分类。
 *
 * `isSolidBlock` = 不是空气、不是液体、也不是可穿过的（草/雪层/梯子/火把…）——
 * 正好是"站上去不会掉"的判据。**故意不用 `isAir`**：雪层和草也是"空的"，
 * 但它们托不住你，报成"空腔"才对。
 */
export function columnKindOf (name) {
  if (name === null || name === undefined) return 'unloaded'
  if (isLiquid(name)) return /lava/.test(String(name)) ? 'lava' : 'water'
  return isSolidBlock(name) ? 'solid' : 'air'
}

/** `"12,-4"` / `"12,63,-4"` / `{x,z}` 都认（竖列只要 x/z） */
export function parseXZ (t) {
  if (t && typeof t === 'object') {
    const x = Number(t.x); const z = Number(t.z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    return { x: Math.round(x), z: Math.round(z) }
  }
  const m = String(t ?? '').match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*(?:[, ]\s*(-?\d+(?:\.\d+)?))?/)
  if (!m) return null
  /* 给了三个数 ⇒ 最后一个当 z（"x,y,z"）；只给两个 ⇒ 当 "x,z" */
  return m[3] === undefined
    ? { x: Math.round(Number(m[1])), z: Math.round(Number(m[2])) }
    : { x: Math.round(Number(m[1])), z: Math.round(Number(m[3])) }
}

/**
 * 竖着看一格：从**脚底那一格**往下，每一层是什么、哪里有空的。
 *
 * 回答的就是"我往下挖会不会掉下去"：脚底往下连续几格实心、第一处空腔在哪、空腔多高、
 * 空腔底下是什么。
 *
 * @returns {{x:number,z:number,feetY:number,from:number,to:number,layers:Array,runs:Array,
 *            solidRun:number,firstGap:object|null,gaps:Array,unloaded:number,complete:boolean,
 *            here:object,above:object}}
 */
/* 🔴 2026-10-23（用户 m00855「不是有 map 的竖轴吗」）：竖列图的纵向窗口一直是以**我脚下**为基准的
 *    （`from = 脚 y - 1`、头顶从 `脚 y + 2` 往上）。所以它能回答"我这一层上下那一列是什么"，
 *    却回答不了"**远处那一列的地表在多高**"。要回答后者，得先把那一列的地表扫出来 —— 就是下面这个。 */
export const COLUMN_SCAN_TOP = 320
export const COLUMN_SCAN_BOTTOM = -64

/**
 * 某一列的**地表**在第几格（自上而下第一个不是空气的方块）。
 * @returns {{x:number,z:number,y:number|null,name:string|null,kind:string,loaded:boolean}}
 *   `loaded:false` = 那一列的区块**没加载**（`blockAt` 返回 null）—— 这时 y 是"不知道"，不是"没有"。
 */
export function surfaceYOf (b, { x = null, z = null, yTop = COLUMN_SCAN_TOP, yBottom = COLUMN_SCAN_BOTTOM } = {}) {
  const ok = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
  const fx = ok(x) ? Math.floor(Number(x)) : Math.floor(b?.entity?.position?.x ?? 0)
  const fz = ok(z) ? Math.floor(Number(z)) : Math.floor(b?.entity?.position?.z ?? 0)
  /* 🔴 2026-10-23 踩过的坑：y=320 在 1.18+ 已经是世界外（-64..319），而 `blockAt` 对**世界外**也返回 null ——
   *    照 COLUMN_SCAN_TOP=320 起扫，第一格就是 null，会被当成"区块没加载"直接报"读不到"。
   *    所以起点先按当前维度的高度夹回来（mineflayer 的 `bot.game` 里有 minY / height）。 */
  const dimTop = (Number.isFinite(b?.game?.minY) && Number.isFinite(b?.game?.height))
    ? Number(b.game.minY) + Number(b.game.height) - 1
    : COLUMN_SCAN_TOP
  const top = Math.floor(ok(yTop) ? Math.min(Number(yTop), dimTop) : dimTop)
  const bot = Math.floor(ok(yBottom) ? Number(yBottom) : COLUMN_SCAN_BOTTOM)
  for (let y = top; y >= bot; y--) {
    const blk = b?.blockAt?.(new Vec3(fx, y, fz))
    if (blk == null) return { x: fx, z: fz, y: null, name: null, kind: 'unloaded', loaded: false }
    const kind = columnKindOf(blk.name)
    if (kind === 'air') continue
    return { x: fx, z: fz, y, name: blk.name, kind, loaded: true }
  }
  /* 整根扫完全是空气：世界高度范围内没有地面（虚空）—— 仍然是"读到了"，只是没有地表 */
  return { x: fx, z: fz, y: null, name: null, kind: 'air', loaded: true }
}

export function columnOf (b, { x = null, z = null, yTop = null, yBottom = -24, maxDepth = COLUMN_MAX, up = null, anchorY = null } = {}) {
  const feet = b?.entity?.position
  /* 🔴 2026-10-15（踩过的坑）：**`Number(null)` 是 `0`，而 `Number.isFinite(0)` 为真** ——
   *    直接写 `Number.isFinite(Number(x))` 会让"没传"变成"传了 0"：不传 x/z 时永远看 (0,0)、
   *    不传 yTop 时永远从 y=0 开始扫（`mc_map` 的 `layer` 栽过一模一样的跟头）。所以先判 `!= null`。 */
  const given = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
  const fx = given(x) ? Math.floor(Number(x)) : Math.floor(feet?.x ?? 0)
  const fz = given(z) ? Math.floor(Number(z)) : Math.floor(feet?.z ?? 0)
  /* 🔴 2026-10-23：`anchorY` 给了就把它当"脚"（查**别的列**时 = 那一列地表上面那一格），
   *    这样往下扫的起点就是"那一列的地表"，而不是我脚下 —— 否则远程查列只会看到我自己这一层。 */
  const fy = given(anchorY) ? Math.floor(Number(anchorY)) : Math.floor(feet?.y ?? 0)
  /* 默认从**脚底那一格**（`fy - 1`，也就是托着你的那块）开始往下 —— 从 `fy` 开始的话
   * 第一格永远是你自己站的空气，看着像"脚底下就是空的"。 */
  const from = given(yTop) ? Math.floor(Number(yTop)) : fy - 1
  const depth = Math.max(4, Math.min(Math.abs(Math.floor(given(yBottom) ? Number(yBottom) : -24)) || 24, maxDepth))
  const to = from - depth + 1

  const layers = []
  for (let y = from; y >= to; y--) {
    const blk = b?.blockAt?.(new Vec3(fx, y, fz))
    const name = blk ? blk.name : null
    const kind = columnKindOf(name)
    layers.push({ y, name, kind, glyph: COLUMN_GLYPH[kind] })
  }

  /* 把连续的同类压成"段"，省得 AI 一格一格读 */
  const runs = []
  for (const l of layers) {
    const last = runs[runs.length - 1]
    if (last && last.kind === l.kind) { last.to = l.y; last.n++; if (l.name && !last.names.includes(l.name)) last.names.push(l.name) }
    else runs.push({ kind: l.kind, from: l.y, to: l.y, n: 1, names: l.name ? [l.name] : [] })
  }

  const unloaded = layers.filter((l) => l.kind === 'unloaded').length
  /* 脚底往下连续实心几格（第一段就是实心才算；第一段是空/未加载 ⇒ 0） */
  const solidRun = runs[0]?.kind === 'solid' ? runs[0].n : 0
  /* 所有"托不住你"的段（空腔 / 水 / 岩浆） */
  const gaps = runs.filter((r) => r.kind === 'air' || r.kind === 'water' || r.kind === 'lava')
    .map((r) => ({ y: r.from, to: r.to, thickness: r.n, kind: r.kind, glyph: COLUMN_GLYPH[r.kind] }))
  const firstGap = gaps.length ? { ...gaps[0], below: runs[runs.indexOf(runs.find((r) => r.from === gaps[0].y)) + 1]?.names?.[0] ?? null } : null

  /* 水 / 岩浆单独拎出来：它们和"空腔"都托不住你，但后果差着量级（掉下去 vs 淹死 vs 烧死） */
  const hazards = {
    lava: gaps.filter((g) => g.kind === 'lava').map((g) => ({ y: g.y, to: g.to, thickness: g.thickness })),
    water: gaps.filter((g) => g.kind === 'water').map((g) => ({ y: g.y, to: g.to, thickness: g.thickness })),
  }

  /* 你自己站的这一格（`fy`）**不在往下扫的范围里**（扫的是 `fy-1` 往下），
   * 但它决定"你现在处在什么环境里" —— 尤其是泡在水里 / 岩浆里的时候。
   * 🔴 2026-10-17 实机（用户报）：机器人在水坑里（脚那一格是水、人一直在游、游不动），
   *    报告却说「往下 24 格全是实心 —— **可以放心往下挖**」。话没说错，但**一个字没提"你正泡在水里"**；
   *    AI 的思考记录里紧接着就写「simplest: **dig down**! The column says all solid, no caves」——
   *    照着挖下去，水就灌进坑里了。所以这一格必须单独报出来。 */
  const hereName = b?.blockAt?.(new Vec3(fx, fy, fz))?.name ?? null
  const here = { y: fy, name: hereName, kind: columnKindOf(hereName) }

  /* ── 头顶：往上扫（2026-10-18 用户需求：「map竖井模式加上头上有什么」）──
   * 往下扫回答"挖下去会不会掉"；往上扫回答另外三个问题：**跳不跳得起来**、
   * **头顶是什么封着 / 封在哪一格**、**上面是不是水或岩浆**。
   * 🔴 起算点是 `fy + 2`：`fy` 是脚、`fy + 1` 是脑袋 —— 从 `fy + 1` 起算就把自己的头算成方块了。
   * 这条补的是 `PATHFINDER.md` 里的已知缺口「竖井里**必须先能跳**（头顶要有空位）才垫得动」：
   * 以前竖列图只报脚下，AI 不知道头顶被板子封死，于是拿"垫脚"去试一个不可能的动作。 */
  const upN = Math.max(1, Math.min(given(up) ? Math.floor(Number(up)) : COLUMN_UP_DEFAULT, COLUMN_UP_MAX))
  const headFrom = fy + 2
  const headLayers = []
  for (let y = headFrom; y < headFrom + upN; y++) {
    const blk = b?.blockAt?.(new Vec3(fx, y, fz))
    const name = blk ? blk.name : null
    const kind = columnKindOf(name)
    headLayers.push({ y, name, kind, glyph: COLUMN_GLYPH[kind] })
  }
  const headRuns = []
  for (const l of headLayers) {
    const last = headRuns[headRuns.length - 1]
    if (last && last.kind === l.kind) { last.to = l.y; last.n++; if (l.name && !last.names.includes(l.name)) last.names.push(l.name) }
    else headRuns.push({ kind: l.kind, from: l.y, to: l.y, n: 1, names: l.name ? [l.name] : [] })
  }
  /* 头顶连续"不挡路"几格：实心挡路；**未加载是"不知道"，也停下**（别替世界下结论） */
  let headroom = 0
  for (const l of headLayers) {
    if (l.kind === 'solid' || l.kind === 'unloaded') break
    headroom++
  }
  const headSolid = headLayers.find((l) => l.kind === 'solid') ?? null
  const above = {
    from: headFrom,
    to: headFrom + upN - 1,
    head: { y: headFrom, name: headLayers[0]?.name ?? null, kind: headLayers[0]?.kind ?? 'unloaded' },
    headroom,
    ceiling: headSolid ? { y: headSolid.y, name: headSolid.name } : null,
    /* 看到上限还没碰到实心 ⇒ 只能说"这一段是空的"，**不能说"通天"** */
    truncated: !headSolid,
    unloaded: headLayers.filter((l) => l.kind === 'unloaded').length,
    hazards: {
      lava: headRuns.filter((r) => r.kind === 'lava').map((r) => ({ y: r.from, to: r.to, thickness: r.n })),
      water: headRuns.filter((r) => r.kind === 'water').map((r) => ({ y: r.from, to: r.to, thickness: r.n })),
    },
    runs: headRuns,
    layers: headLayers,
  }

  return {
    x: fx, z: fz, feetY: fy, from, to, layers, runs,
    solidRun,
    firstGap,
    gaps,
    hazards,
    here,
    above,
    unloaded,
    complete: unloaded === 0,
    mode: 'column',
    ...(given(anchorY) ? { anchorY: fy } : {}),
  }
}

/* 托不住的三种东西，警告级别不一样：空腔是"掉下去"、水是"淹/冲"、岩浆是"会死" */
const GAP_WARN = { air: '⚠️', water: '🌊', lava: '🔥' }

/** 一段"托不住你"的东西，各说各的后果 */
function gapAdvice (g, feetY) {
  const at = `挖到 y=${g.y + 1} `
  if (g.kind === 'lava') return `${at}就**挖穿到岩浆**了 —— **掉进去会死，别挖**。`
  if (g.kind === 'water') return `${at}就**挖进水**了 —— 水会灌下来，你可能被冲走或淹死。`
  const drop = feetY - (g.to - 1)
  return `${at}再往下就会掉下去（落差 ${drop > 0 ? drop : g.thickness} 格）。`
}

const hazardSpan = (h) => (h.y === h.to ? `y=${h.y}` : `y=${h.y}..${h.to}`)

/**
 * 头顶那几行 —— "我跳不跳得起来 / 头上封着的是什么 / 上面是不是水或岩浆"（2026-10-18 用户需求）。
 *
 * 三件事必须分开说，因为后果不一样：**跳不起来**会让"垫脚往上爬"变成不可能的动作
 * （`PATHFINDER.md` 那个已知缺口：1×1 竖井 + 头顶 jungle_planks ⇒ 出不来），
 * **封着的是什么 / 在第几格**决定要挖多久，**水 / 岩浆**决定要不要立刻停手。
 */
function aboveLines (col) {
  const a = col.above
  if (!a || !a.layers?.length) return []
  const out = []
  /* `above` 本身用 `from`，`hazards` 里的段用 `y`（和下面那串 hazards 同一个形状）—— 两个都认 */
  const span = (r) => {
    const y0 = r.y ?? r.from
    return y0 === r.to ? `y=${y0}` : `y=${y0}..${r.to}`
  }
  /* ① 头顶第一格就不知道 ⇒ 只说"不知道"，既别说"空"，也别说"能跳" */
  if (a.head?.kind === 'unloaded') {
    out.push(`  ? 头顶那一格（y=${a.from}）**没加载**（是"不知道"，不是"空的"）—— 挪一步再看。`)
  } else if (!a.ceiling) {
    /* ② 扫到上限都没碰到实心：能跳、也能垫；但**只看到这儿**，别当成"上面一路通天" */
    out.push(a.unloaded
      ? `  ☁️ 头顶 ${a.layers.length} 格（${span(a)}）里没碰到实心，不过其中有 ${a.unloaded} 格没加载（"不知道"，不是"空的"）。`
      : `  ☁️ 头顶 ${a.layers.length} 格（${span(a)}）没有实心方块 —— 能跳、也能垫脚往上；**再往上没扫**（不代表通天）。`)
  } else if (a.headroom === 0) {
    /* ③ 头顶那一格就是实心 ⇒ 跳不起来（这就是"垫了也上不去"的那个原因） */
    out.push(`  🧱 头顶那一格（y=${a.ceiling.y}）就是 **${a.ceiling.name}** —— **跳不起来**。`
      + '要往上只能先挖掉它（或从旁边绕），**别在原地试垫脚**。')
  } else {
    /* 只空 1 格时别写成 `y=66..66` */
    const roomSpan = a.headroom === 1 ? `y=${a.from}` : `y=${a.from}..${a.from + a.headroom - 1}`
    out.push(`  ☁️ 头顶连续 ${a.headroom} 格没有实心（${roomSpan}），`
      + `再往上 y=${a.ceiling.y} 是 **${a.ceiling.name}** —— 能跳；但上面封住了，想上去得挖开或垫脚。`)
  }
  /* ④ 头顶的水 / 岩浆：和"空腔"不是一回事 —— "从上面浇下来"比"往下掉"更难救 */
  for (const h of a.hazards?.lava ?? []) {
    out.push(`  🔥 头顶上方是**岩浆**（${span(h)}，${h.thickness} 格）—— **别往上挖**：挖开岩浆就浇下来。`)
  }
  for (const h of a.hazards?.water ?? []) {
    out.push(`  🌊 头顶上方有**水**（${span(h)}，${h.thickness} 格）—— 你在水的下面；往上挖会灌下来。`)
  }
  if (a.unloaded && a.head?.kind !== 'unloaded') out.push(`  ? 头顶有 ${a.unloaded} 格没加载 —— 那几格是"不知道"，不是"空"。`)
  return out
}

/** 竖列图 → 人话（AI 真正要读的就是这几行） */
export function columnText (col) {
  if (!col || !col.layers?.length) return '🕳 竖列图：这一列一格都没读到（区块没加载？）'
  const where = (col.x === undefined) ? '' : `(${col.x}, ${col.z})`
  /* 🔴 2026-10-23：查**别的列**时，"脚底"这个词会骗人 —— 那不是你的脚，是那一列的地表。 */
  const mine = col.mine !== false
  const footWord = mine ? '脚底那一格' : '那一列地表那一格'
  /* 抬头里把"往上也看了"写出来 —— 只报脚下的时候，AI 会以为这就是全部信息 */
  const upSpan = col.above?.layers?.length ? `，头顶看 y=${col.above.from}..${col.above.to}` : ''
  const out = [mine
    ? `🕳 竖列 ${where}：脚底 y=${col.feetY}，从 y=${col.from} 往下扫到 y=${col.to}${upSpan}`
    : `🕳 竖列 ${where}：**那一列的地表在 y=${col.surfaceY}**（不是你的脚下），从 y=${col.from} 往下扫到 y=${col.to}${upSpan}`]
  if (!mine && col.surfaceY != null) {
    out.push(`  📍 要落上去就 ` + '`' + `mc_move {x: ${col.x}, y: ${col.surfaceY + 1}, z: ${col.z}}` + '`' + `（站到地表上面那一格）—— 这就是"该给哪个 y"的答案。`)
  }
  /* 先说你**自己**那一格是什么 —— 它不在下面那串 runs 里（扫的是脚底往下），
   * 但"泡在水里/岩浆里"和"站在空气里"完全是两回事，不说清就会得出"可以放心往下挖"。 */
  const hk = col.here?.kind
  if (hk === 'lava' || hk === 'water') {
    out.push(hk === 'lava'
      ? `  🔥 你现在**这一格（y=${col.here.y}）就是岩浆** —— 先出来，别在这挖。`
      : `  🌊 你现在**这一格（y=${col.here.y}）是水**（人正泡在水里）—— 往下挖水会灌进坑，`
        + '可能把你冲下去或淹死；要挖就先想清楚水往哪流，或者先离开水面。')
  }
  for (const r of col.runs) {
    const names = r.names.length ? `（${r.names.slice(0, 4).join('、')}${r.names.length > 4 ? '…' : ''}）` : ''
    const span = r.from === r.to ? `y=${r.from}` : `y=${r.from}..${r.to}`
    out.push(`  ${COLUMN_GLYPH[r.kind]} ${span} ${COLUMN_LABEL[r.kind]} ${r.n} 格${names}`)
  }
  /* `unloaded` 与"空"是两回事：没加载 = **不知道**，不能说成"托不住你"（那是断言世界的样子） */
  const top = col.runs?.[0]
  if (top?.kind === 'unloaded') {
    out.push(`  ⚠️ ${footWord}**没加载**（不是"空的"）—— 先等一下区块 / 挪一步再看，别凭这个下判断。`)
  } else if (col.solidRun === 0) {
    /* 脚底那格本身就托不住：也要点名是空的 / 水 / 岩浆 —— "掉下去"和"掉进岩浆"不是一回事 */
    const k = top?.kind ?? 'air'
    const what = k === 'lava' ? '**岩浆**' : k === 'water' ? '**水**' : '**空的**'
    /* 已经在泡水的时候，"水会灌下来"是句废话 —— 该说的是"你先出去"。 */
    const tail = k === 'lava' ? '**先挪一步，别在这上面挖**。'
      : k === 'water' ? (col.here?.kind === 'water' ? '**你自己就在水里** —— 先游出去，别在这往下挖。' : '别往下挖，水会灌下来。')
        : '别往下挖，先挪一步。'
    out.push(`  ${GAP_WARN[k] ?? '⚠️'} ${footWord}是 ${what}，托不住你 —— ${tail}`)
  } else if (!col.firstGap) {
    /* 🔴 判"可以放心往下挖"之前先看你自己站在哪 —— 泡在水里 / 岩浆里时这句话会把人坑死。 */
    const inLava = col.here?.kind === 'lava'
    const inWater = col.here?.kind === 'water'
    out.push(col.unloaded
      ? `  ✅ 往下 ${col.solidRun} 格是实心，这一段没探到空腔；但更深处有 ${col.unloaded} 格没加载 —— 挖到那里**先停下再看一次**。`
      : inLava
        ? `  ✅ 往下 ${col.solidRun} 格是实心 —— 但**你人就在岩浆里**，先出来再说。`
        : inWater
          ? `  ✅ 往下 ${col.solidRun} 格是实心（**不会掉下去**）—— 但**你人泡在水里**，挖开之后水会灌进坑；`
            + '先把水堵上/排掉，或者换个地方挖。'
          : `  ✅ 往下 ${col.solidRun} 格全是实心，这一段没探到空腔 —— 可以放心往下挖。`)
  } else {
    const g = col.firstGap
    const span = g.y === g.to ? `y=${g.y}` : `y=${g.y}..${g.to}`
    const under = g.below ? `，再往下 y=${g.to - 1} 是 ${g.below}` : ''
    out.push(`  ${GAP_WARN[g.kind] ?? '⚠️'} 脚底往下 **${col.solidRun} 格是实心**，然后 ${span} 是 **${g.thickness} 格${COLUMN_LABEL[g.kind]}**${under}`)
    out.push(`     ⇒ ${gapAdvice(g, col.feetY)}${col.gaps.length > 1 ? `（下面还有 ${col.gaps.length - 1} 处托不住的）` : ''}`)
  }
  /* 再往下的水 / 岩浆单独点名：上面那层就算只是普通空腔，底下有岩浆也够呛 */
  const firstY = col.firstGap?.y
  const deepLava = (col.hazards?.lava ?? []).filter((h) => h.y !== firstY)
  const deepWater = (col.hazards?.water ?? []).filter((h) => h.y !== firstY)
  if (deepLava.length) out.push(`  🔥 再往下还有 **岩浆**（${deepLava.map(hazardSpan).join('、')}）—— 上面那层挖开了也够呛。`)
  if (deepWater.length) out.push(`  🌊 再往下还有 **水**（${deepWater.map(hazardSpan).join('、')}）。`)
  if (col.unloaded) out.push(`  ? 有 ${col.unloaded} 格没加载，那几行是"不知道"，不是"实心"。`)
  /* 最后说头顶：先说自己、再说下面、最后说上面 —— 读的人从"我"往外推 */
  out.push(...aboveLines(col))
  return out.join('\n')
}
