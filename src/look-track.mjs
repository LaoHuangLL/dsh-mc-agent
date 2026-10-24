/**
 * 跟踪 / 采样 / 等新实体 —— `mc_act {mode:"look"}` 的扩展（2026-10-24）。
 *
 * 为什么单独一层：`camera.mjs` 的 `lookAt()` 是"转一次头就返回"，它答不了这三类问题：
 *   · 「它往哪个方向飞」—— 末影之眼指路要的是**方向**，不是"我看向哪"
 *   · 「它还在动吗 / 多快」—— 箭有没有脱靶、船是被水冲还是自己漂
 *   · 「我刚扔出去的东西生成在哪」—— 眼睛/珍珠是**服务端实体**，扔完才出现
 * 这三件事要的是同一个东西：**在一段时间里反复对准 + 记录目标位置**。
 *
 * 三条设计约束（与 `world-use.mjs` / `movement.mjs` 同一套）：
 *   ① 不 import `core.mjs`，只吃传进来的 `b`；不直接 import mineflayer。
 *   ② **不用 `b.lookAt()`**（物理循环 early return 会挂死，见 `camera.mjs:94`），
 *      一律走 `aimAt()` 直接写 `b.entity.yaw/pitch`。
 *   ③ 代次保护走 `hooks.moveGenOf()` —— 被 `mc_move` / 战斗接管就立刻收手，
 *      绝不在别人掌权时继续改朝向（审计 B 组第 2 条同类问题）。
 */

import { Vec3 } from 'vec3'
import { sleep } from './async-util.mjs'
import { aimAt } from './camera.mjs'

/** 跟踪时多久重新对准一次（毫秒）。100ms = 10Hz，比 tick 稀，但对"方向"够用。 */
export const TRACK_POLL_MS = 100
/** 等新实体时多久扫一遍实体表（毫秒）。25ms ≈ 半个 tick，眼睛生成 1–3 tick 就会到。 */
export const NEW_ENTITY_POLL_MS = 25
/** 前多少毫秒只认"名字对得上"的新实体（之后才放宽到"最近的"），防止同时刷怪时抓错。 */
export const NEW_ENTITY_NAME_WINDOW_MS = 300
/** 新实体离抛出点多远以内才算（格）。太远的多半是别的怪。 */
export const NEW_ENTITY_MAX_DIST = 12

const DIR8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']

/** 方位角（0=北，顺时针）→ 中文八向。 */
export function bearingText (deg) {
  if (deg === null || !Number.isFinite(deg)) return '算不出'
  const d = ((deg % 360) + 360) % 360
  return `${DIR8[Math.round(d / 45) % 8]}（${Math.round(d)}°）`
}

/**
 * 位置序列 → 方向 / 速度。
 * `bearing` 用 Minecraft 的方位习惯：-Z 是北、+X 是东（`atan2(dx, -dz)`）。
 */
export function solveTrack (pts) {
  if (!Array.isArray(pts) || pts.length < 2) return { dir: null, bearing: null, speed: null, moved: 0 }
  const a = pts[0]
  const z = pts[pts.length - 1]
  const dx = z.x - a.x
  const dz = z.z - a.z
  const flat = Math.hypot(dx, dz)
  const dt = Math.max(1, z.t - a.t) / 1000
  const r3 = (v) => Number(v.toFixed(3))
  if (flat < 0.5) {
    /* 水平几乎没动：可能是原地悬浮（眼睛在客户端视角里会先"停"一下）、也可能是真卡住了。
     * 这里如实报 moved，让上层自己判断，不要替它猜。 */
    return { dir: null, bearing: null, speed: r3(flat / dt), moved: r3(flat) }
  }
  const bearing = Number((((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360).toFixed(1))
  return { dir: { dx: r3(dx / flat), dz: r3(dz / flat) }, bearing, speed: r3(flat / dt), moved: r3(flat) }
}

function snapshotIds (b) {
  return new Set(Object.keys(b?.entities ?? {}).map(String))
}

/** 当前实体表里"快照之后才出现"的那些，按离 near 的距离升序。 */
function freshEntities (b, before, near, maxDist) {
  const out = []
  for (const e of Object.values(b?.entities ?? {})) {
    if (!e || e === b?.entity) continue
    const id = String(e.id ?? '')
    if (!id || before.has(id)) continue
    let d = 0
    try { d = near ? e.position.distanceTo(near) : 0 } catch { continue }
    if (Number.isFinite(d) && d > maxDist) continue
    out.push({ e, d })
  }
  return out.sort((a, c) => a.d - c.d)
}

/**
 * 等"从现在起 waitMs 内新出现的实体"。
 *
 * 两段筛选（见 `NEW_ENTITY_NAME_WINDOW_MS`）：
 *   前 300ms 只认名字含 `who` 的；之后放宽到"离 near 最近的"。
 * 命中就立刻返回 —— 眼睛生成后 50–150ms 就会到，等满 1 秒纯属浪费。
 *
 * @returns {{ent: object|null, waitedMs: number, seen: Array}}
 */
export async function watchNewEntity (b, opts = {}, hooks = {}) {
  const waitMs = Math.max(0, Math.min(Number(opts.newEntity ?? 0) || 0, 10_000))
  const maxDist = Number(opts.maxDist ?? NEW_ENTITY_MAX_DIST)
  let near = null
  if (opts.x !== undefined && opts.z !== undefined) {
    near = new Vec3(Number(opts.x), Number(opts.y ?? 0), Number(opts.z))
  } else {
    try { near = b?.entity?.position ?? null } catch { near = null }
  }
  const want = opts.who ? String(opts.who).toLowerCase() : null

  /* 🔴 快照必须在"扔"之前 —— 扔完再拍，眼睛已经进实体表了，永远等不到"新的"。
   *    `hooks.useItem` 就是"扔"这一步（由 world-use 传进来，避免这里反向依赖 McBot）。 */
  const before = snapshotIds(b)
  if (hooks.useItem) await hooks.useItem()

  const t0 = Date.now()
  const seen = new Map()
  const others = (exceptId) => [...seen.values()]
    .filter((x) => x.id !== String(exceptId))
    .map(({ id, name, d, atMs }) => ({ id, name, d, atMs }))
  while (Date.now() - t0 < waitMs) {
    const cands = freshEntities(b, before, near, maxDist)
    for (const c of cands) {
      const id = String(c.e.id)
      if (!seen.has(id)) {
        /* 留下实体引用：目标可能在窗口期结束前就飞走/被捡走（眼睛一秒能飞十几格），
         * 那时 `cands` 会变空，但"它确实出现过"这件事不能因此丢掉。 */
        seen.set(id, { id, name: String(c.e.name ?? '?'), d: Number(c.d.toFixed(1)), atMs: Date.now() - t0, e: c.e })
      }
    }
    const named = want ? cands.find((c) => String(c.e.name ?? '').toLowerCase().includes(want)) : null
    if (named) return { ent: named.e, waitedMs: Date.now() - t0, seen: others(named.e.id) }
    if (Date.now() - t0 >= NEW_ENTITY_NAME_WINDOW_MS) {
      /* 名字窗口过了：优先用"此刻还在表里的"（位置最新）；都不在了就退回最早见过的那个，
       * 并标 `stale` —— 上层看到 stale 就知道坐标是最后一次见到的，不是现在的位置。 */
      if (cands.length) return { ent: cands[0].e, waitedMs: Date.now() - t0, seen: others(cands[0].e.id) }
      if (seen.size) {
        const first = [...seen.values()].sort((a, c) => a.atMs - c.atMs)[0]
        return { ent: first.e, waitedMs: Date.now() - t0, seen: others(first.id), stale: true }
      }
    }
    await sleep(NEW_ENTITY_POLL_MS)
  }
  return { ent: null, waitedMs: waitMs, seen: [...seen.values()].map(({ id, name, d, atMs }) => ({ id, name, d, atMs })) }
}

/**
 * 主入口：一次性转头 / 等新实体 / 跟踪采样，三种用法合在一起。
 *
 * @param b      mineflayer bot
 * @param opts   { x,y,z,who, newEntity, track, samples, maxDist }
 * @param hooks  { useItem?: () => Promise, moveGenOf?: () => number }
 */
export async function lookTrack (b, opts = {}, hooks = {}) {
  const trackMs = Math.max(0, Math.min(Number(opts.track ?? 0) || 0, 20_000))
  const wantNew = (Number(opts.newEntity ?? 0) || 0) > 0
  const raw = opts.samples === 'raw'
  const r2 = (v) => Number(Number(v).toFixed(2))

  let ent = null
  let newInfo = null
  if (wantNew) {
    const r = await watchNewEntity(b, opts, hooks)
    ent = r.ent
    newInfo = {
      found: !!ent,
      waitedMs: r.waitedMs,
      ...(ent ? { name: String(ent.name ?? '?') } : {}),
      ...(r.stale ? { stale: true } : {}),
      ...(r.seen.length ? { others: r.seen } : {}),
    }
    if (!ent) {
      const others = r.seen.length
        ? `这期间看到的新实体：${r.seen.map((x) => `${x.name}（${x.d} 格）`).join('、')}`
        : '这期间一个都没出现'
      return {
        text: `⚠ 等了 ${r.waitedMs}ms 没等到新实体（${others}）—— 多半是没扔出去：先确认手上拿着东西（mc_inventory），`
          + '或者把 useItem:true 一起给，让我扔完再等',
        newEntity: newInfo,
      }
    }
  }

  /* 目标解析：新实体 > who > x/y/z */
  let target = null
  let liveEnt = ent
  if (ent) {
    target = ent.position
  } else if (opts.who) {
    const me = b?.entity?.position
    let best = null
    for (const e of Object.values(b?.entities ?? {})) {
      if (!e || e === b?.entity) continue
      if (!String(e.name ?? '').toLowerCase().includes(String(opts.who).toLowerCase())) continue
      let d = Infinity
      try { d = e.position.distanceTo(me) } catch { d = Infinity }
      if (!best || d < best.d) best = { e, d }
    }
    if (best) { liveEnt = best.e; target = best.e.position }
  } else if (opts.x !== undefined && opts.y !== undefined && opts.z !== undefined) {
    target = new Vec3(Number(opts.x), Number(opts.y), Number(opts.z))
  }
  if (!target) {
    throw new Error('要么给 who / x,y,z，要么给 newEntity（等新出现的实体）—— 先 mc_observe 看一眼周围有什么')
  }

  const aimed0 = aimAt(b, target)
  if (!aimed0) throw new Error('算不出要转的角度（位置读不到）—— 先 mc_status 看看我在哪')

  const myEye = { x: b.entity.position.x, y: b.entity.position.y + 1.62, z: b.entity.position.z }

  /* ── 不跟踪：转一次头就返回（= 原来的 look 行为）────────────────── */
  if (trackMs <= 0) {
    const p = liveEnt?.position ?? target
    return {
      lookingAt: { x: r2(target.x), y: r2(target.y), z: r2(target.z) },
      ...(liveEnt ? { targetNow: { x: r2(p.x), y: r2(p.y), z: r2(p.z) } } : {}),
      myEye: { x: r2(myEye.x), y: r2(myEye.y), z: r2(myEye.z) },
      yaw: Number(b.entity.yaw.toFixed(3)),
      pitch: Number(b.entity.pitch.toFixed(3)),
      dist: r2(Math.hypot(p.x - myEye.x, p.y - myEye.y, p.z - myEye.z)),
      ...(newInfo ? { newEntity: newInfo } : {}),
      text: newInfo
        ? `👁 等到了新实体「${newInfo.name}」，已对准（${newInfo.waitedMs}ms 内出现）`
        : `👁 已看向 (${r2(target.x)}, ${r2(target.y)}, ${r2(target.z)})`,
    }
  }

  /* ── 跟踪：每 TRACK_POLL_MS 重新对准一次并记录位置 ───────────────── */
  const gen0 = hooks.moveGenOf ? hooks.moveGenOf() : undefined
  const t0 = Date.now()
  const pts = []
  let lostAt = null
  let preempted = false
  while (Date.now() - t0 < trackMs) {
    /* 目标实体消失（飞出渲染距离 / 被捡走 / 被打死）—— 如实记下什么时候丢的 */
    if (liveEnt) {
      const alive = Object.values(b?.entities ?? {}).some((e) => e === liveEnt)
      if (!alive) { lostAt = Date.now() - t0; break }
    }
    const p = liveEnt?.position ?? target
    if (!p) { lostAt = Date.now() - t0; break }
    if (!aimAt(b, p)) { lostAt = Date.now() - t0; break }
    pts.push({ t: Date.now() - t0, x: r2(p.x), y: r2(p.y), z: r2(p.z) })
    if (gen0 !== undefined && hooks.moveGenOf && hooks.moveGenOf() !== gen0) { preempted = true; break }
    await sleep(TRACK_POLL_MS)
  }

  const solved = solveTrack(pts)
  const head = pts.length ? `👁 跟了 ${((pts[pts.length - 1].t) / 1000).toFixed(1)} 秒（${pts.length} 个点）` : '👁 没采到点'
  const body = solved.bearing !== null
    ? `：朝${bearingText(solved.bearing)}，水平移了 ${solved.moved} 格，约 ${solved.speed} 格/秒`
    : `：水平几乎没动（${solved.moved} 格）`
  const tail = preempted
    ? '；中途被别的动作接管了（跟踪中断）'
    : lostAt !== null
      ? `；${(lostAt / 1000).toFixed(1)} 秒时目标不见了`
      : ''

  return {
    lookingAt: pts.length ? { x: pts[0].x, y: pts[0].y, z: pts[0].z } : null,
    targetNow: pts.length ? { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, z: pts[pts.length - 1].z } : null,
    myEye: { x: r2(myEye.x), y: r2(myEye.y), z: r2(myEye.z) },
    yaw: Number(b.entity.yaw.toFixed(3)),
    pitch: Number(b.entity.pitch.toFixed(3)),
    track: { ms: pts.length ? pts[pts.length - 1].t : 0, points: pts.length, ...(lostAt !== null ? { lostAt } : {}), ...(preempted ? { preempted } : {}) },
    ...(solved.dir ? { dir: solved.dir, bearing: solved.bearing } : {}),
    speed: solved.speed,
    moved: solved.moved,
    ...(newInfo ? { newEntity: newInfo } : {}),
    ...(raw ? { samples: pts } : {}),
    text: head + body + tail,
  }
}
