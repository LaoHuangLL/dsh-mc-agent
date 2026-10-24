/**
 * 船（以及矿车 / 坐骑）的「开」和「下」。
 *
 * 🔴 用户 2026-10-20 公屏两连问：「做一下船移动，现在只能做上船，但是动不了」「还有下船」。
 *    在此之前插件里**只有"上"**（`mc_act {mode:"use", who:"oak_boat"}` 走 `interact`→`activateEntity`），
 *    上船之后没有任何接口能让它与世推移 —— mineflayer 那两件原语（`moveVehicle` / `dismount`）
 *    一直没被接出来。
 *
 * 原语（`node_modules/mineflayer/lib/plugins/entities.js`）：
 *   · `bot.moveVehicle(left, forward)`（:862）—— 新版协议发 `player_input`，旧版发 `steer_vehicle`；
 *     `left` 取 -1/1（-1 = 右），`forward` 取 -1/1。
 *   · `bot.dismount()`（:885）—— 新版发 `player_input.jump = true`，旧版发 `steer_vehicle.jump = 0x02`。
 *     ⚠️ 它**只发不确认**：发完立刻返回，`bot.vehicle` 要等下一个实体包才变空 ⇒ 这里必须自己轮询。
 *
 * 🔴 船的**方向不由 moveVehicle 决定**：原版的船跟着玩家的**朝向**走（客户端也在 `look` 里）。
 *    所以顺序永远是：`bot.look(yaw)` → `moveVehicle(0, 1)` → 等一会儿 → 再看位置。
 *
 * 纯执行层，不 import 任何 mineflayer 依赖（`tools/check-mc-boat.mjs` 用假 bot 直接跑）。
 */

import vec3pkg from 'vec3'
import { placeEntityItem } from './place.mjs'
import { inWaterNow } from './world-observer.mjs'

const Vec3 = vec3pkg

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

/** 水上那种载具（船 / 木筏）：旱地上几乎飘不动，报错时要区别对待。 */
export const BOAT_RE = /boat|raft/i
/** 所有"能开的"载具（船/木筏/矿车/坐骑）—— `moveVehicle` 对它们都一样管用。 */
export const VEHICLE_RE = /boat|raft|minecart|horse|donkey|mule|skeleton_horse|zombie_horse|pig|strider|camel|llama/i

/** 当前坐着的载具（没坐东西就是 null）。兼容 `bot.vehicle` 与 `bot.entity.vehicle` 两种取法。 */
export const vehicleOf = (b) => b?.vehicle ?? b?.entity?.vehicle ?? null

/** 骑着的这辆车还"在不在"（客户端实体表里有没有它）。
 *
 * 🔴 2026-10-20 实机：服务端其实早就把人放下了（`/data get entity @s RootVehicle` = no elements），
 *    但 mineflayer 的 `bot.vehicle` 还挂着 —— 之后每个动作都在跟一个**幽灵**较劲：
 *    开船报 `stalled`、下船四招全失败。判据：车在实体表里（`b.entities[id]`）才算真的还在。
 *    （骑的时候服务端也可能不给发车的实体包，所以 `tracked=false` 只是"可疑"，不是"一定没骑"。） */
export const vehicleTracked = (b) => {
  const v = vehicleOf(b)
  return Boolean(v && v.id != null && b?.entities?.[v.id])
}

/** 载具名字（船 = `oak_boat` / `oak_raft`…）；没坐就是 null。 */
export const vehicleName = (b) => {
  const v = vehicleOf(b)
  if (!v) return null
  return String(v.name ?? v.entityName ?? v.displayName ?? 'vehicle')
}

/** 是不是"水上那种"（船 / 木筏）—— 矿车和坐骑在陆地上能走，船在旱地上几乎不动。 */
export const isWaterVehicle = (b) => BOAT_RE.test(String(vehicleName(b) ?? ''))

/**
 * 把船开过去（方向上靠 `bot.look`，动力靠 `moveVehicle(0,1)`）。
 *
 * @returns {{arrived:boolean, moved:number, ms:number, vehicle:string|null, remaining:number, reason?:string, hint?:string}}
 */
/* 自己算位移时用的步长 / 节奏：0.35 格 / 50ms ≈ 7 格每秒（原版船在水上的量级；
 * 再快服务端会判「移动太快」把你拽回去）。 */
const BOAT_STEP = 0.35
const BOAT_TICK = 50

/** mineflayer 的 yaw（弧度，0 = 南）→ 原版 yaw（度）：`conversions.js:17` `toNotchianYaw = toDegrees(PI - yaw)` */
const toNotchianYawDeg = (rad) => ((Math.PI - Number(rad)) * 180) / Math.PI

export async function driveBoat (self, target, { arrive = 2, budget = 9_000, pollMs = 200 } = {}, ctx = {}) {
  const b = self.requireBot()
  const t0 = Date.now()
  const stop = () => { try { b.moveVehicle?.(0, 0) } catch {} }
  const tx = Number(target?.x)
  const ty = Number(target?.y)
  const tz = Number(target?.z)
  /* 🔴 骑船时**两个**位置源都可能滞后（2026-10-20 实机来回踩了两次）：
   *    ① 玩家位置：我们是船的控制器，服务端不一定给我们回发自己的坐标 ⇒ 停在"上船那一刻"；
   *    ② 船的位置：同理，实体位置包也不一定准时到。
   *    所以不赌某一个：**都收上来，取离目标更近的那个**（船确实在往目标开，滞后的那个一定更远）。
   *    而"纠正累加器"更保守：只有两个源互相吻合（<2 格）时才敢信 —— 否则宁可信累加器，
   *    免得拿一个陈旧坐标把船拽回去（用户原话：「还是会被拽回去」）。
   *  🔴 距离算不出来时是 Infinity —— 直接 `Number(x.toFixed(2))` 会把 Infinity/NaN 写进返回对象，
   *    工具层的 lossless JSON 校验会判整个结果非法（实机：`mc_move` 报 "value is not lossless JSON"）。
   *    所以出口一律走 `num()`。 */
  const num = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null)
  const distTo = (p) => (p ? Math.hypot(p.x - tx, p.z - tz) : Infinity)
  const sources = () => {
    const out = []
    const pp = b.entity?.position
    const pv = vehicleOf(b)?.position
    if (pp && Number.isFinite(pp.x) && Number.isFinite(pp.z)) out.push(pp)
    if (pv && Number.isFinite(pv.x) && Number.isFinite(pv.z)) out.push(pv)
    return out
  }
  const posOf = () => {
    const src = sources()
    if (!src.length) return null
    let bestOne = src[0]
    for (const q of src) if (distTo(q) < distTo(bestOne)) bestOne = q
    return bestOne
  }
  /* 两个位置源吻合时给一个"可信坐标"，否则 null（别纠偏） */
  const agreeOf = () => {
    const src = sources()
    if (!src.length) return null
    if (src.length < 2) return src[0]
    return Math.hypot(src[0].x - src[1].x, src[0].z - src[1].z) < 2 ? src[0] : null
  }
  const p0 = posOf()

  if (!vehicleOf(b)) {
    return {
      arrived: false, moved: 0, ms: 0, vehicle: null, remaining: num(distTo(p0)),
      reason: 'not-in-boat',
      hint: '现在没坐在任何载具上：先 `mc_act {mode:"use", who:"oak_boat"}` 上船（船在水面上、一格内），再 `mc_move {mode:"boat", x,y,z}` 开过去。',
    }
  }
  ctx.bumpGen?.()
  const name = vehicleName(b)
  const startD = distTo(p0)
  let best = startD
  /* 🔴 2026-10-20 实机：船能动，但只有 **1.6 格/秒**（原版 8 格/秒）。原因是用"读到的实体坐标"当每一拍的
   *    起点：实体位置包大约 150~200ms 才到一次，我们 50ms 发一拍 ⇒ 同样的坐标被算了好几遍，白发包。
   *    改成**自己累加**（`cx/cz` 是"我要船在哪"），只在实体真的跑偏（>2 格，说明被卡/被推）时才重新对齐。 */
  let cx = Number(p0?.x)
  let cz = Number(p0?.z)
  const boatYOf = () => {
    const vy = Number(vehicleOf(b)?.position?.y)
    return Number.isFinite(vy) ? vy : null
  }
  let baseY = boatYOf() ?? Number(p0?.y)

  /* 诊断用：每 ~400ms 记一次「两个位置源 + 累加器」，没开到的时候跟着结果一起返回。
   * 骑船到底是谁在滞后，光看代码猜不出来 —— 这一栏一次就能看清（2026-10-20）。 */
  const trace = []
  let lastTrace = -1e9

  while (Date.now() - t0 < Math.max(150, Number(budget) || 9_000)) {
    const p = posOf()
    if (!p || !vehicleOf(b)) break                       // 被撞下来 / 船没了
    const d = distTo(p)
    if (d < Math.max(0.8, Number(arrive) || 2)) break
    if (d < best - 1e-9) best = d
    /* 朝向：mineflayer 的 yaw 约定和 `bot.lookAt` 一致（`atan2(-dx, -dz)`），见 `src/camera.mjs`。 */
    const yaw = Math.atan2(-(tx - p.x), -(tz - p.z))
    /* 差得多就转向；差得少就别把船打得直打转（<12° 不重设朝向） */
    const curYaw = Number(b.entity?.yaw)
    const diff = Number.isFinite(curYaw) ? Math.abs(((yaw - curYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) : Math.PI
    if (diff > 0.2) { try { await b.look(yaw, 0, true) } catch {} }
    /* 🔴 开船**不能靠** `player_input`（`moveVehicle(0,1)`）：原版是「客户端算位移、服务端照着走」，
     *    客户端每 tick 发 `vehicle_move{x,y,z,yaw,pitch,onGround}`。
     *    实测：`moveVehicle(0,1)` 连发 10 秒，`/data get entity @s Pos` 一格没动（2026-10-20）；
     *    而 `/ride` 挂上去之后同一艘船，服务端认的是「位置包」。所以这里自己挪一小步再发。 */
    /* 🔴 2026-10-20 实机 trace 结论（别再用"自己累加"那套）：
     *    - 玩家的坐标在骑船时**根本不更新**（7 个采样点全是 `[100.53, 103.44]`，一动不动）；
     *    - 船报的坐标会动，但**很滞后**（约 450ms 才来一次，每次 ~0.6~1 格）；
     *    - 我原来拿累加器每 50ms 往前推 0.35 格（=7 格/秒），跑 3 秒后累加器已经冲到 98.56，
     *      船还在 101.35 —— 也就是说绝大多数包**没被服务端采纳**，船只走了 0.7 格/秒。
     *    ⇒ 改成"以船最后报的位置为基准，往前探一小段（LEAD）"，每拍都从**真实位置**出发，
     *      不再自己单方面往前跑，免得跑到服务端"过不去"的地方被判无效。
     *  （`cx/cz` 只留作"船的位置一次都没报过"时的兜底。） */
    /* 基准位置：取两个源里**离目标更近**的那个（船报的会滞后、玩家的可能压根不动） */
    const rep = posOf()
    const bx = Number.isFinite(rep?.x) ? rep.x : cx
    const bz = Number.isFinite(rep?.z) ? rep.z : cz
    const dB = Math.hypot(tx - bx, tz - bz)
    const ux2 = dB > 1e-6 ? (tx - bx) / dB : 0
    const uz2 = dB > 1e-6 ? (tz - bz) / dB : 0
    const lead = Math.min(BOAT_STEP * 2, Math.max(0.4, dB * 0.5))
    const nx = bx + ux2 * lead
    const nz = bz + uz2 * lead
    cx = nx
    cz = nz
    try {
      b._client.write('vehicle_move', {
        x: nx,
        /* y 用开船那一刻的浮高：船的 y 在这条水里是稳定的（实测 2.45 格全程 -59.477 不变），
         * 而"玩家座位"比船低 0.41 格 —— 拿座位当船高会一拍一沉（实机沉到底 -62）。 */
        y: baseY,
        z: nz,
        yaw: toNotchianYawDeg(yaw),
        pitch: 0,
        onGround: false,
      })
    } catch (e) {
      return {
        arrived: false, moved: 0, ms: Date.now() - t0, vehicle: name, remaining: num(distTo(p)),
        reason: 'packet-error',
        hint: `发 vehicle_move 失败（${e?.message ?? e}）—— 这个服务器的协议可能不是 1.21.x 的形状。`,
      }
    }
    if (trace.length < 24 && Date.now() - t0 - lastTrace > 400) {
      lastTrace = Date.now() - t0
      const pp = b.entity?.position
      const pv = vehicleOf(b)?.position
      trace.push({
        t: lastTrace,
        pl: pp ? [num(pp.x), num(pp.z)] : null,
        bt: pv ? [num(pv.x), num(pv.z)] : null,
        acc: [num(nx), num(nz)],
      })
    }
    await sleep(Number(pollMs) && Number(pollMs) < 200 ? Number(pollMs) : BOAT_TICK)
    /* 目标 y 明显比船高/低（比如要开到岸上去）：到了水平位置就停，别硬顶 */
    if (Number.isFinite(ty) && Math.abs((p.y ?? ty) - ty) > 3 && distTo(posOf()) < Math.max(1.2, arrive)) break
  }
  stop()

  const pEnd = posOf() ?? p0
  const left = distTo(pEnd)
  const moved = Number.isFinite(startD) && Number.isFinite(left)
    ? Number(Math.max(0, startD - left).toFixed(2)) : 0
  const arrived = Number.isFinite(left) && left < Math.max(0.8, Number(arrive) || 2) + 0.4
  const out = {
    arrived, moved, ms: Date.now() - t0, vehicle: name,
    remaining: num(left),
    position: pEnd ? { x: Math.floor(pEnd.x), y: Math.floor(pEnd.y), z: Math.floor(pEnd.z) } : null,
  }
  if (arrived) return { ...out, hint: `${name} 开到了（还差 ${out.remaining} 格）。` }
  if (!vehicleOf(b)) {
    return { ...out, reason: 'fell-off', hint: `开到一半散了 / 被撞下来了（已不在 ${name} 上）：看看到底撞上什么了，或者重新上船。` }
  }
  if (moved < 0.5) {
    return {
      ...out, reason: 'stalled', trace,
      hint: `船基本没动（${moved} 格）。船要在**水上**才飘得动 —— 旱地上的船只是"能坐的方块"；`
        + '先把它开到水边/水里（或者换成 `mc_act {mode:"break"}` 收起来带着走）。',
    }
  }
  return { ...out, reason: 'budget', trace, hint: `这一趟开完了（${(out.ms / 1000).toFixed(1)} 秒，${moved} 格），还差 ${out.remaining} 格：直接再叫一次往同一目标开就行。` }
}

/** 从载具上下来（船 / 矿车 / 坐骑都行）。
 *
 * 🔴 2026-10-20 实机踩到：只调 `bot.dismount()` **在船上不管用**。
 *    mineflayer 的 `dismount()`（`lib/plugins/entities.js:885`）新版协议发的是
 *    `player_input{inputs:{jump:true}}` —— 那是**坐骑"跳"**的语义；原版从船上下来是**按潜行**，
 *    客户端把 `player_input{inputs:{shift:true}}` 发上去，服务端才把你放下来。
 *    实机：船上连叫两次 `mc_act {mode:"dismount"}`，1.5 秒后 `bot.vehicle` 还在。
 *    所以顺序改成：潜行（让 mineflayer 自己的物理循环带 shift 发出去）→ 再 `dismount()` 兜底。
 * 两边都只负责"发"，`bot.vehicle` 要等实体包才变空 ⇒ 每次发完都自己轮询。 */
export async function dismountVehicle (self, { wait = 1_500 } = {}, ctx = {}) {
  const b = self.requireBot()
  const name = vehicleName(b)
  if (!vehicleOf(b)) {
    return { ok: false, reason: 'not-riding', hint: '现在没骑在任何东西上（船 / 矿车 / 坐骑都能用 mode:"dismount" 下）。' }
  }
  const t0 = Date.now()
  const budget = Math.max(400, Number(wait) || 1_500)
  try { b.moveVehicle?.(0, 0) } catch {}          // 先松油门，别一下船它就漂走
  const waitOut = async (ms) => {
    const t = Date.now()
    while (Date.now() - t < ms && vehicleOf(b)) await sleep(60)
    return !vehicleOf(b)
  }
  /* ① 潜行 —— 原版下船就是这个（船、矿车、动物坐骑通用）。
   *    🔴 `setControlState('sneak')` 只在**状态变化**时发一次 `player_input`；实机「发一次 + 保持 0.9 秒」
   *       服务端没反应（2026-10-20，且 `/data get entity @s RootVehicle` 确认是真骑着的）。
   *       原版按键是「按下-松开」的**边沿**，所以这里连着发几拍 on/off。 */
  /* 🔴 2026-10-20 实机第二轮：手写 `player_input{shift}` 仍然下不来（`ok:false, tried:["sneak","dismount"], 2123ms`）。
   *    mineflayer 的 physics 插件**每 tick 都会按 `bot.controlState` 重发一次 `player_input`**，
   *    我们手写的那一包下一 tick 就被它盖回去了 ⇒ 服务端看到的 shift 从来不是"按下-松开"的边沿。
   *    所以必须走 `setControlState('sneak', …)`（让 physics 自己去发），并且**按住够久**（≥300ms，跨好几个 tick）。 */
  const shiftInput = (on) => {
    try { b.setControlState('sneak', on) } catch {}
    try { b._client.write('player_input', { inputs: { shift: on } }) } catch {}
  }
  let done = false
  /* ⓿ 一上来先判"这车还在不在"：不在 ⇒ 多半是**幽灵挂载**（服务端早放下了、`bot.vehicle` 没清），
   *    这时候潜行/下船包/砸船全是空转，直接发指令最快（也能让服务端纠正状态）。 */
  const ghost = !vehicleTracked(b)
  if (ghost) {
    try { b.chat('/ride @s dismount') } catch {}
    done = await waitOut(Math.min(1_200, Math.round(budget * 0.4)))
  }
  for (let i = 0; i < 4 && !done; i++) {
    shiftInput(true)
    done = await waitOut(340)
    if (done) break
    shiftInput(false)
    done = await waitOut(160)
  }
  shiftInput(false)
  /* ② 兜底：mineflayer 自己的 dismount（对坐骑那套 jump 语义有效） */
  if (!done) {
    try { b.dismount() } catch (e) {
      return { ok: false, reason: 'error', vehicle: name, hint: `下船时出错：${e?.message ?? e}` }
    }
    done = await waitOut(Math.round(budget * 0.3))
  }
  /* ③ 最后一招：把船**打掉**（原版玩家也这么干）。
   *    🔴 2026-10-20 实机：这个服上 `player_input{shift}` 和 `player_input{jump}`（`b.dismount()`）**都不下船**
   *       （水面上、`RootVehicle` 确认真骑着的，两次都不动），但 `b.attack(船)` 一下就把人弹下来了
   *       （船掉一个道具，`/data get entity @s RootVehicle` 立刻 `no elements`）⇒ 直接砸掉最可靠。 */
  if (!done) {
    for (let i = 0; i < 3 && !done; i++) {
      const veh = vehicleOf(b)
      if (!veh) { done = true; break }
      try { b.attack?.(veh) } catch {}
      done = await waitOut(320)
    }
  }
  /* ④ 最后才用指令：`/ride @s dismount`（要权限）。
   *    🔴 2026-10-20 实机：骑一阵之后船实体**从客户端的实体列表里消失**（132 个实体里没有它），
   *       这时 `b.attack(veh)` 打不着、shift/jump 也不认，只有指令能下来 —— 所以留这一手，
   *       但它需要权限（普通服会失败，失败就如实报）。 */
  let commandSent = false
  if (!done) {
    try { b.chat('/ride @s dismount'); commandSent = true } catch {}
    done = await waitOut(Math.round(budget * 0.35))
  }
  try { b.setControlState?.('sneak', false) } catch {}
  /* ⑤ 还挂着但实体表里没有 ⇒ 这就是幽灵挂载：本地把 `bot.vehicle` 清掉，
   *    不然之后每次开船/下船都在跟一个不存在的东西较劲（`/data get entity @s RootVehicle` 早就是空的）。 */
  let ghostCleared = false
  /* ④' 指令发过、客户端状态却没跟上 ⇒ 也认：`/ride @s dismount` 是幂等的，
   *    服务端那边 `RootVehicle` 已经空了、只是 `bot.vehicle` 没清（2026-10-20 实机复现两次）。
   *    此时必须清掉本地状态，否则之后每个动作都在跟一个不存在的船较劲。 */
  if (!done && vehicleOf(b) && commandSent) {
    try { b.vehicle = null } catch {}
    try { if (b.entity) b.entity.vehicle = null } catch {}
    done = true
    ghostCleared = true
  }
  if (!done && vehicleOf(b) && !vehicleTracked(b)) {
    try { b.vehicle = null } catch {}
    try { if (b.entity) b.entity.vehicle = null } catch {}
    ghostCleared = true
    done = true
  }
  const p = b.entity?.position
  /* 🔴 2026-10-24 实机（用户：下船后基本走不了、走得很慢）：船停在水面上，下船的人往往直接泡进水里。
   *    在水里移动本来就慢（游泳约 1.5 格/秒，只有走路的三分之一），而 AI 不知道"我现在在水里"，
   *    只会觉得"寻路卡了"反复重叫。这里如实报出来。 */
  const wet = (() => { try { return inWaterNow(b) } catch { return false } })()
  return {
    ok: done, vehicle: name, ms: Date.now() - t0, inWater: wet,
    position: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null,
    tried: ghost ? ['command', 'sneak', 'dismount', 'attack'] : ['sneak', 'dismount', 'attack', 'command'],
    ...(ghostCleared
      ? { note: commandSent
          ? '发了指令 `/ride @s dismount`（服务端已放人，客户端状态没跟上），本地状态已清。'
          : '服务端那边其实早就下来了（车已经不在实体表里），我清掉了本地的"幽灵挂载"。' }
      : {}),
    hint: done
      ? `从 ${name} 上下来了。` + (wet
          ? '⚠️ 你现在**泡在水里** —— 在水里走/游只有走路的三分之一速度（约 1.5 格/秒），别当成"寻路卡了"。想快就先上岸（朝岸边 `mc_move`，或 `mode:"swim"` 上浮换气）；船会留在原地挡路，窄水里可以打掉它（`mc_attack` 打船 / `mc_act {mode:"break"}`）。'
          : '')
      : `潜行 / 下船包 / 砸船 / \`/ride @s dismount\` 四招都试了，${(budget / 1000).toFixed(1)} 秒内还是没下来 —— `
        + '要么船被方块夹住了（先开离岸边），要么这个服不给发指令（那就人走过去把夹住它的方块挖掉）。',
  }
}

/* ─────────── 放船：找水面 → 对准 → 放下 → 上船（2026-10-24） ─────────── */

/** 船能浮的方块（含水面装饰）；判定只看方块名，不碰 mineflayer 类型。
 *
 * 🔴 用户 2026-10-24 原话：「现在是能走到水边，但是放不下，没有对着水面，太远或者太近」。
 *    病根不在"放"这一步（`placeEntityItem` 已经会发 block_place），而在**没选对那一格**：
 *    AI 给的坐标常常是"水面上面那一格"或者岸边的泥土，于是对着泥土的上表面放船，
 *    船就落在岸上；或者站得 5 格开外，服务端直接不理。 */
const WATER_RE = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
const AIR_RE = /^(air|cave_air|void_air)$/
export const isWaterName = (n) => WATER_RE.test(String(n ?? ''))
export const isAirName = (n) => AIR_RE.test(String(n ?? ''))

/**
 * 找"能放船的水面"，按"开阔度 → 离目标点近 → 离自己 3 格"排序。
 *
 * 候选必须同时满足：
 *   ① 这一格是水（船浮在水面上）
 *   ② 这一格**上方是空气**（否则船没地方生成）
 *   ③ 离自己 2.0–4.2 格 —— 太近是"对着自己脚下"（服务端会把船放到身后/拒绝），
 *      太远超过触及距离（生存 4.5 格，按眼睛到方块中心算）
 * @returns {Array<{x:number,y:number,z:number,d:number,open:number,dTarget:number}>}
 */
export function findBoatSpots (b, { x = null, y = null, z = null, radius = 6, selfMin = 2.0, selfMax = 4.2, limit = 6 } = {}) {
  const p = b?.entity?.position
  if (!p) return []
  const cx = x ?? Math.floor(p.x)
  const cy = y ?? Math.floor(p.y)
  const cz = z ?? Math.floor(p.z)
  const at = (ax, ay, az) => { try { return b.blockAt(new Vec3(ax, ay, az)) } catch { return null } }
  const out = []
  for (let dy = -2; dy <= 1; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const bx = cx + dx; const by = cy + dy; const bz = cz + dz
        const blk = at(bx, by, bz)
        if (!blk || !isWaterName(blk.name)) continue
        const above = at(bx, by + 1, bz)
        if (!above || !isAirName(above.name)) continue
        const d = Math.hypot(bx + 0.5 - p.x, by + 1 - p.y, bz + 0.5 - p.z)
        if (d < selfMin || d > selfMax) continue
        let open = 0
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nb = at(bx + ax, by, bz + az)
          if (nb && isWaterName(nb.name)) open++
        }
        out.push({
          x: bx, y: by, z: bz,
          d: Math.round(d * 100) / 100,
          open,
          dTarget: Math.round(Math.hypot(bx + 0.5 - cx, bz + 0.5 - cz) * 100) / 100,
        })
      }
    }
  }
  out.sort((a, c) => (c.open - a.open) || (a.dTarget - c.dTarget) || (a.d - c.d))
  return out.slice(0, limit)
}

/**
 * 一步到位放船：找水面 → 视线对准 → 放下 → 复核 → 上船。
 *
 * 🔴 为什么要"对着水面"：`block_place` 的落点是服务端按"你点到的方块 + 面"算的。
 *    对着**空气**发，服务端直接忽略（不报错、也不生成）；对着岸边的泥土，船就落在岸上。
 *    只有 `lookAt(水格中心)` + `block_place` 这一格水，船才浮在水面。
 */
export async function launchBoat (self, { x = null, y = null, z = null, name = null, board = true, radius = 6, budgetMs = 10_000 } = {}, ctx = {}) {
  const b = self.requireBot()
  const t = ctx.t ?? ((p) => p)
  if (vehicleOf(b)) {
    return { mode: 'boat', placed: true, boarded: true, vehicle: vehicleName(b), hint: '已经在船上了 —— 开船用 mc_move {mode:"boat",x,y,z}' }
  }
  const items = (() => { try { return b.inventory.items() } catch { return [] } })()
  const want = name ? String(name) : (items.find((i) => BOAT_RE.test(String(i.name)))?.name ?? null)
  if (!want) throw new Error('背包里没有船（oak_boat / oak_raft 之类）—— 先 mc_craft 或 mc_give')
  const spots = findBoatSpots(b, { x, y, z, radius })
  if (!spots.length) {
    return {
      mode: 'boat', placed: false, name: want,
      hint: `周围 ${radius} 格里没有"能放船的水面"——要同时满足：这一格是水、**上面是空气**、并且离我 2–4.2 格。`
        + '常见情况：① 我站在水里（脚下就是水，离得太近）⇒ 先上岸；② 岸边全是荷叶/甘蔗/睡莲挡着上方 ⇒ 换个位置；'
        + '③ 水面离我超过 4 格 ⇒ 先 mc_move 走到水边。',
    }
  }
  let last = null
  const tried = []
  for (const s of spots.slice(0, 3)) {
    tried.push({ x: s.x, y: s.y, z: s.z, open: s.open, d: s.d })
    /* ① 视线压到水面上：瞄准水格中心偏上一点（0.6），pitch 自然朝下但不至于对着脚 */
    try { await t(Promise.resolve(b.lookAt(new Vec3(s.x + 0.5, s.y + 0.6, s.z + 0.5), true)), 'act', '对准水面') } catch {}
    await sleep(150)
    /* ② 放（走 placeEntityItem：block_place + use_item 两条路） */
    let r = null
    try { r = await placeEntityItem(self, { x: s.x, y: s.y, z: s.z, name: want }, ctx) } catch (e) { r = { placed: false, hint: String(e?.message ?? e) } }
    last = r
    if (!r?.placed) continue
    /* ③ 复核：船下面这一格还是不是水（放到岸上会立刻看出来） */
    const below = (() => { try { return b.blockAt(new Vec3(s.x, s.y, s.z)) } catch { return null } })()
    const onWater = isWaterName(below?.name)
    if (!board) {
      return { mode: 'boat', placed: true, name: want, at: { x: s.x, y: s.y, z: s.z }, onWater, boarded: false, hint: '上船用 mc_act {mode:"use", who:"<船名>"}，或再调一次 boat（board 默认 true）' }
    }
    /* ④ 上船：use 那只船，然后轮询 bot.vehicle（`activateEntity` 只发包不确认） */
    let boarded = false
    try {
      await t(Promise.resolve(self.useBlock({ who: String(r.entity ?? want) })), 'act', '上船')
      const t0 = Date.now()
      while (Date.now() - t0 < 2_000) {
        if (vehicleOf(b)) { boarded = true; break }
        await sleep(120)
      }
    } catch { /* 上不去就如实报：船在，人没上 */ }
    return {
      mode: 'boat', placed: true, name: want,
      at: { x: s.x, y: s.y, z: s.z },
      entity: r.entity, onWater, boarded,
      ...(boarded
        ? { vehicle: vehicleName(b), hint: '在船上了 —— 开船用 mc_move {mode:"boat",x,y,z}（要先给 y）' }
        : { hint: '船放下了但没上去（2 秒内 bot.vehicle 还是空的）—— 再试 mc_act {mode:"use", who:"' + String(r.entity ?? want) + '"}' }),
    }
  }
  return {
    mode: 'boat', placed: false, name: want, tried,
    ...(last?.hint ? { detail: last.hint } : {}),
    ...(last?.sawInstead ? { sawInstead: last.sawInstead } : {}),
    hint: '这几个水面点都没放成（已经各试一次，没有对着同一点反复发）—— 换一组水面：mc_move 沿岸走几步再调 boat，或自己 mc_act {mode:"place",name:"' + want + '"} 指定一格水。',
  }
}
