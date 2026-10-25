/**
 * 自己算抛物线 —— hawkeye 解不出来时的兜底。
 *
 * 🔴 为什么需要它（2026-10-19 实机，用户 Bluezi）：
 *   末影龙飞到 y≈85 的时候，我站在地面（y≈63）往上看是 40°~70° 的仰角。
 *   hawkeye 的 `getMasterGrade()` 只要"落点误差 > 4 格"就返回 `undefined`，
 *   而它自己的求解器在这种**大仰角 / 远距离**下几乎一定解不出来 —— 实机表现是：
 *     `算不出弹道：目标 31.1 格、角度也刁 —— hawkeye 要求落点误差 ≤ 4 格`
 *   于是"低处往高处打"这条路整个被堵死了（用户要的正是这个）。
 *   这里用 Minecraft 箭的真实运动模型（每 tick：位置 += 速度；速度 *= 0.99；v.y -= 0.05）
 *   暴力扫一遍仰角，挑落点离目标最近的那条。
 *
 * 纯函数、不 import 任何 mineflayer 依赖：`tools/check-ballistics.mjs` 直接跑。
 */

/** 满拉弓的初速（格 / tick）。1 格/tick = 20 格/秒 ⇒ 3.0 = 60 格/秒 */
export const ARROW_SPEED_FULL = 3.0
/** 每 tick 从速度里扣掉的重力 */
export const ARROW_GRAVITY = 0.05
/** 每 tick 的速度衰减 */
export const ARROW_DRAG = 0.99
/** 最多模拟多少 tick（1 秒 20 tick，200 tick = 10 秒，够飞到 100+ 格） */
export const MAX_TICKS = 200

const DEG = Math.PI / 180

/**
 * 拉弓多少毫秒之后放，箭有多快。
 *
 * 照原版 `BowItem.releaseUsing` 的算法：`t = min(useTicks, 20) / 20`，
 * `charge = (t² + 2t) / 3`，速度 = `charge × 3.0`，**封顶 3.0**。
 * 0.35 秒（7 tick）≈ 1.0 格/tick，1 秒（20 tick）才满。
 */
export function arrowSpeedFor (ms, { full = ARROW_SPEED_FULL } = {}) {
  const ticks = Math.max(0, Math.min(20, Number(ms) / 50 || 0))
  const t = ticks / 20
  const charge = (t * t + 2 * t) / 3
  return Math.max(0.05, Math.min(1, charge) * full)
}

/** 点到线段的最近距离（模拟是一 tick 一步的折线，落点误差就这么算） */
function segDist (a, b, p) {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const vz = b.z - a.z
  const wx = p.x - a.x
  const wy = p.y - a.y
  const wz = p.z - a.z
  const vv = vx * vx + vy * vy + vz * vz
  let t = vv > 0 ? (wx * vx + wy * vy + wz * vz) / vv : 0
  t = Math.max(0, Math.min(1, t))
  const dx = a.x + vx * t - p.x
  const dy = a.y + vy * t - p.y
  const dz = a.z + vz * t - p.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * 从 `from` 按 `pitch` 飞出去，量**它与 `to` 的最近距离**。
 *
 * @returns {{err:number, ticks:number, y:number}} `err` = 最近距离（格）；`ticks` = 那一刻用了几个 tick
 */
export function traceArrow ({
  from, to, ux, uz, pitch,
  speed = ARROW_SPEED_FULL, gravity = ARROW_GRAVITY, drag = ARROW_DRAG, maxTicks = MAX_TICKS,
} = {}) {
  const c = Math.cos(pitch)
  let v = { x: ux * c * speed, y: Math.sin(pitch) * speed, z: uz * c * speed }
  let p = { x: from.x, y: from.y, z: from.z }
  let best = { err: Infinity, ticks: 0, y: p.y }
  for (let tk = 1; tk <= maxTicks; tk++) {
    const prev = p
    p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
    v = { x: v.x * drag, y: v.y * drag - gravity, z: v.z * drag }
    const err = segDist(prev, p, to)
    if (err < best.err) best = { err, ticks: tk, y: p.y }
    /* 已经在往下掉、而且掉到目标下面一大截了 ⇒ 再模拟也没意义 */
    if (v.y < 0 && p.y < to.y - 8) break
  }
  return best
}

/**
 * 解仰角：暴力扫 `lo`~`hi` 度，挑落点离目标最近的那条。
 *
 * @returns {{yaw:number, pitch:number, err:number, ticks:number, deg:number}|null}
 *   `yaw` / `pitch` 是 **mineflayer 内部弧度量**（`bot.look` 直接吃这个），
 *   约定和 `bot.lookAt` 一致：`yaw = atan2(-dx, -dz)`、`pitch` 正 = 往上看。
 */
export function scanArrowCandidates ({
  from, to, speed = ARROW_SPEED_FULL, lo = -85, hi = 85, step = 0.5,
  gravity = ARROW_GRAVITY, drag = ARROW_DRAG, maxTicks = MAX_TICKS,
} = {}) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const h = Math.hypot(dx, dz)
  if (!(h > 1e-3) || !Number.isFinite(dy)) return null
  const ux = dx / h
  const uz = dz / h
  const cands = []
  for (let deg = lo; deg <= hi + 1e-9; deg += step) {
    const pitch = deg * DEG
    const r = traceArrow({ from, to, ux, uz, pitch, speed, gravity, drag, maxTicks })
    cands.push({ err: r.err, ticks: r.ticks, pitch, deg })
  }
  if (!cands.length) return null
  /* 按落点误差升序 —— 第一个就是"最准的那条"（平射/高抛都可能） */
  cands.sort((a, c) => a.err - c.err)
  return { yaw: Math.atan2(-dx, -dz), cands }
}

/**
 * 解出**全部**候选（按落点误差升序）。
 *
 * 🔴 为什么需要（用户 2026-10-25「现在弓箭只会平射，不会抛射」）：
 *   同一段距离往往有两条解 —— 平射（低仰角）和高抛（大仰角）。
 *   `preferLow` 一律挑平射，于是**平射路径上有方块挡着**（墙、台阶、树叶、地形起伏）时，
 *   箭全撞在方块上，看起来就是"只会平射、不会抛射"。
 *   把候选交出去，让调用方（`shoot.mjs`）按"这条轨迹撞不撞方块"来挑。
 */
export function solveArrowAll (opts = {}) {
  return scanArrowCandidates(opts)
}

export function solveArrow ({
  from, to, speed = ARROW_SPEED_FULL, lo = -85, hi = 85, step = 0.5,
  gravity = ARROW_GRAVITY, drag = ARROW_DRAG, maxTicks = MAX_TICKS,
  /* 🔴 用户 2026-10-19「优先平射」：同一段距离往往有**两条**解（平射 / 高抛），
   *    实机拿静止的末影水晶当靶验证过 —— 22 格高抛解（pitch 83.5°）打短 4 格（箭落在 z=16，靶在 z=20），
   *    19.7 格平射解（pitch 3.9°）一发命中。所以宁可要"稍差一点的平射"也不要高抛。
   * 🔴 2026-10-20（用户：「鸡打不中」）：容差原来是 0.35 格 —— 实测它会把 4 格外的 0.014 精度换成 0.336，
   *    而鸡的半高只有 0.35 格 ⇒ 一律擦过去。降到 0.15：平射仍优先，但精度不许赔进去。 */
  preferLow = false, lowTol = 0.15,
} = {}) {
  const scan = scanArrowCandidates({ from, to, speed, lo, hi, step, gravity, drag, maxTicks })
  if (!scan) return null
  const { yaw, cands } = scan
  let best = cands[0]
  /* 平射优先：在"误差不比最优差超过 lowTol 格"的候选里，挑仰角绝对值最小的那条 */
  if (preferLow) {
    const limit = best.err + Math.max(0, Number(lowTol) || 0)
    for (const c of cands) {
      if (c.err <= limit && Math.abs(c.deg) < Math.abs(best.deg)) best = c
    }
  }
  return { yaw, pitch: best.pitch, err: best.err, ticks: best.ticks, deg: best.deg }
}

/**
 * 带提前量的解：先按当前位置解一条，拿到飞行 tick 数，再把目标按速度往前推，重解一遍（迭代 `rounds` 次）。
 *
 * @param vel 目标速度（格 / tick），`null`/零向量就退化成不带提前量
 */
export function solveArrowLead ({
  from, to, vel = null, speed = ARROW_SPEED_FULL, rounds = 3, ...rest
} = {}) {
  const vx = Number(vel?.x) || 0
  const vy = Number(vel?.y) || 0
  const vz = Number(vel?.z) || 0
  let aim = { x: to.x, y: to.y, z: to.z }
  let sol = solveArrow({ from, to: aim, speed, ...rest })
  if (!sol) return null
  const moving = Math.abs(vx) + Math.abs(vy) + Math.abs(vz) > 1e-6
  if (moving) {
    for (let i = 0; i < Math.max(1, rounds); i++) {
      aim = { x: to.x + vx * sol.ticks, y: to.y + vy * sol.ticks, z: to.z + vz * sol.ticks }
      const next = solveArrow({ from, to: aim, speed, ...rest })
      if (!next) break
      sol = next
    }
  }
  return { ...sol, aim, lead: moving }
}
