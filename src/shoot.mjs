/**
 * 射箭（`mc_shoot`）—— 弹道交给**现成的** `minecrafthawkeye` 算，我们不自己推公式。
 *
 * 用户 2026-10-19：「hawkeye 主要是水晶和末影龙」—— 也就是末地战两个用法：
 *   · 末影水晶（站在黑曜石柱顶上的那个，射爆它才不让龙回血）：**坐标目标**，静止、体积大，
 *     给 `x/y/z` 就行（方块坐标，瞄它中心上方一点）。
 *   · 末影龙（会飞、会俯冲）：**实体目标**，必须带提前量 —— 这是 hawkeye 比"抬头算角度"强的地方。
 *
 * 为什么用 hawkeye 而不是自己写抛物线（用户 2026-10-06 定的"现成方案优先"）：
 *   它按武器（bow / crossbow / trident / splash_potion…）的 `BaseVo`（初速）与 `GRAVITY`（每 tick 重力）
 *   迭代出**落点误差最小**的那一档 pitch，还顺带给出整条箭矢轨迹点（`arrowTrajectoryPoints`）和
 *   轨迹上撞到的第一个方块（`blockInTrayect`，`world.raycast` 的结果）。
 *
 * 这里踩过的坑（细节见 `踩坑档案.md` 第 188 / 189 / 190 条）：
 *   ① `getMasterGrade()` 返回的 `yaw` / `pitch` **已经是弧度**（`calculateYaw` 是 atan2、`pitch` 走过
 *      `degreesToRadians`）—— 直接喂 `bot.look()`，**不要再转一次**；多转一次就永远射到天上/地里。
 *   ② 它的模块级 `bot` 是**单例**（`loadBot(bot)` 存在模块作用域）：同一进程连第二个号之后，
 *      `getMasterGrade` 会拿**上一个 bot 的坐标**算 —— 所以每次射之前都要重新 `inject(bot)` 一遍
 *      （`loadBot` 幂等，只换引用，不重复挂监听）。
 *   ③ `getMasterGrade` 在"落点误差 > 4 格"时**返回 `undefined`**（不是抛错）—— 太远/角度太刁就算不出来，
 *      这时必须如实说"算不出来、靠近点"，绝不能拿一个默认角度瞎射。
 *   ④ 弓要**拉满**才有那个初速（≥ 20 tick ≈ 1000ms）。不到 1 秒放箭，箭是"软"的 —— 落点会比算的短一大截。
 *   ⑤ 放箭瞬间的方向由服务端按**放箭那一包的 rotation** 决定：必须"先 look、再 deactivateItem"，
 *      顺序反了就是照着上一次的朝向射出去。
 *   ⑥ 创造模式、以及**带无限附魔（Infinity）的弓**都不消耗箭 —— "箭数前后对比"这条证据在这两种情况下
 *      不成立（不能据此判失败），所以判据分 `noConsume` 与 `creative` 两件事。
 *   ⑦ 射完把**原来手里那件换回去**（用户 2026-10-19 对搭路的同一诉求：别让"为了射一箭"把
 *      手里的剑换成弓留在手上）。用的是 `bridge.mjs` 里那对 `heldSnapshotOf` / `restoreHeldOf`。
 */
import Vec3 from 'vec3'
import { sleep } from './async-util.mjs'
import { heldSnapshotOf, restoreHeldOf } from './bridge.mjs'
import { entityNameOf, pickEntity } from './entity-names.mjs'
import { loadMcDep } from './plugins.mjs'
import { arrowSpeedFor, solveArrowLead, solveArrowAll, ARROW_GRAVITY, ARROW_DRAG } from './ballistics.mjs'

/** 能当箭用的物品（`tipped_arrow` 也算；`arrow` 是常态） */
const ARROW_RE = /^(arrow|spectral_arrow|tipped_arrow)$/i
/** hawkeye 的 `Weapons` 里我们开放的那几个（弓是常态；弩要装填，trident 有专属弹道） */
const WEAPONS = new Set(['bow', 'crossbow', 'trident'])
/** 弓拉满要 20 tick = 1000ms，留 50ms 余量 */
const MIN_DRAW_MS = 1_050
/** `look` 之后、`deactivateItem` 之前的间隔（同一条 TCP 内本来就有序，这只是保险） */
const LOOK_SETTLE_MS = 40
/** 默认等多久再放（拉满再放） */
const DEFAULT_DRAW_MS = 1_200
/** 拉满之后**端着等**的最长时间（用户 2026-10-19：「能不能弓蓄力，然后等高命中率，再射」） */
const HOLD_MAX_MS = 1_500
/** 端着等的时候多久重解一次弹道（`gradeOf` 自己还要采一次速度，实际步长更大） */
const HOLD_POLL_MS = 60
/** 哪些目标才"拉满端着等" —— **只给末影龙**开（用户 2026-10-19：「只在打末影龙生效」）。
 *  龙一直在绕圈飞、解出来的弹道到撒手那一刻多半已经作废；普通怪/玩家站着不动，
 *  端着等只会白拖时间，所以不开。 */
const HOLD_FOR_RE = /^ender_dragon$/i

/**
 * 末影龙**落地（perched）时免疫投射物** —— 实机 2026-10-20 验证（Bluezi 提醒 + 实测）：
 *   龙停在祭坛 (0,61,0)、我在 3 格内、aimError 0.16、`arrowEntity:true`（箭确实射出去了），
 *   但 `/data get entity @e[type=ender_dragon,limit=1] Health` 前后都是 121.25 ⇒ **0 伤害**。
 *   飞着打同一支箭是 2.5 血（200 血的龙 ⇒ 一箭只掉 1.25% 血条）。
 * ⇒ 龙趴着的时候别射：白费箭，还会把"命中率"统计带歪。等它起飞（y 回到 70 上下）再打，
 *   或者换近战上去砍（落地那几秒本来就是砍它的窗口）。
 * 判据用**位置**（比 metadata 槽位稳）：末影龙只在中央祭坛落地，x/z 贴近原点、y 掉到 65 以下。
 */
export const PERCH_MIN_Y = 68
export const PERCH_MAX_HORIZ = 16
export const isDragonPerched = (e) => {
  const p = e?.position
  if (!p) return false
  const x = Number(p.x)
  const z = Number(p.z)
  const y = Number(p.y)
  if (![x, z, y].every(Number.isFinite)) return false
  return Math.hypot(x, z) < PERCH_MAX_HORIZ && y < PERCH_MIN_Y
}

/**
 * 打末影龙的**默认射程上限**（格）。
 * 实机 2026-10-20：24.4 格 aimError 0.19 打空、26.5 格 0.03 打中、43 / 46.5 格 0.19 全空。
 * 2026-10-19 那批：命中的都 ≤ 25 格，26.5 / 30.1 / 34.2 格全空 —— 箭飞 0.6~1 秒，龙已经拐弯。
 * ⇒ 只给末影龙自动套这个闸（别的目标不套）；调用方显式给了 `maxDist` 就以调用方为准。
 */
export const DRAGON_MAX_DIST = 25
/** 仰角超过这个度数就算"高抛解"——实机验证高抛解不可靠，见 `gradeOf` 里的注释
 *  （用户 2026-10-19「优先平射」）。45° 以下当平射直接采用。 */
export const LOW_ARC_MAX_DEG = 45

/**
 * 瞄哪儿 —— hawkeye 的默认是**包围盒顶面**：`target.position + (0, target.height, 0)`
 * （`minecrafthawkeye/dist/hawkEyeEquations.js:35`：`targetPosition = target.position.offset(0, targetHeight, 0)`）。
 *
 * 🔴 用户 2026-10-19 真机点评：「弓现在使用是不是不够好…你往上搭高一点就不准了，瞄准的是翅膀那里，
 *    但碰撞箱在下面」。末影龙 `height=8` ⇒ hawkeye 瞄的是 `y+8`，那是**翅膀上方**；
 *    箭真正能命中的是下面那截身体（实机确认过：Bluezi 在公屏喊「准了一点」都是我把枪口压低之后）。
 *
 * 所以这里给一个**瞄点高度**（相对 `entity.position.y` 的格数，覆盖 hawkeye 的默认顶面），
 * 再包成一个 hawkeye 认的"实体"（`isEntity` 的判据是 `'type' in e`，所以纯对象就行）。
 */
export const BIG_MOB_MIN_HEIGHT = 4          // ≥ 这个高度算"大个子"（末影龙 8 / 凋灵 3.5+ / 恶魂 4 / 铁傀儡 2.7 不在此列）
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * `aim` 参数 → 瞄点高度（相对实体 position 的格数）；`null` = 用 hawkeye 默认（顶面）。
 *
 * 🔴 2026-10-20（用户：「把 auto body 和其他精简掉」）：**字符串名全删了，只剩数字**。
 *    理由（实测对账）：打末影龙时 `shoot_auto` 和 `shoot_body` 算出来**完全一样**（`8 × 0.35 = 2.8`）；
 *    `shoot_low` 的 0.9 写成 `aim:0.9` 就行；`shoot_top` 只是"老行为"，而老行为正是瞄到翅膀上方那个不准的。
 *    三个名字没带来任何信息，还让 `shoot_auto` / `shoot-auto` / `auto` 三种写法互相兼容 —— 干脆删掉。
 *
 * - **不给 `aim`**（默认）：大个子（`height ≥ 4`）按 `height * 0.35` 夹到 `[1.2, 3]` —— 打身体，不打翅膀；
 *   其余实体一律瞄**碰撞箱中心**（`height * 0.5`）。
 *   🔴 2026-10-20（用户：「鸡打不中」）：以前小怪走 hawkeye 默认的**顶面**，而顶面就是碰撞箱的最上沿 ——
 *   鸡只有 0.7 高、半高 0.35，落点只要低 0.2 格就从**底下**钻过去了。瞄中心后上下各留半格余量。
 * - **给数字**：直接按这个格数瞄（负数是往下瞄）。打水晶时 `aim:2` 就是"瞄中心上方 2 格"，越过柱顶边缘。
 *   字符串形式的数字（`"2"`）也收 —— MCP 那边参数常常是字符串。
 * - 给了看不懂的东西（老写法 `"shoot_auto"` 之类）⇒ **退回默认行为**，不会悄悄变差。
 */
export function aimHeightFor ({ entity = false, height = 0 } = {}, aim = null) {
  const h = Number(height) || 0
  /* 大个子（龙）打身体；其余实体瞄碰撞箱中心（顶面是最上沿，小个子太容易擦过去）。 */
  const bodyAim = () => {
    if (!entity || !(h > 0)) return null
    return h >= BIG_MOB_MIN_HEIGHT ? clamp(h * 0.35, 1.2, 3) : h * 0.5
  }
  if (aim === null || aim === undefined) return bodyAim()
  const s = String(aim).trim()
  if (s === '') return bodyAim()
  const n = Number(s)
  return Number.isFinite(n) ? n : bodyAim()
}

/** 把"瞄点高度"包成 hawkeye 认的目标（`'type' in e` 即为实体；`height` 只影响它算瞄点的那个偏移）。 */
export function aimProxyFor (obj, height) {
  if (height == null) return obj
  const pos = obj?.position ?? obj
  return { type: String(obj?.type ?? obj?.name ?? 'mob'), position: pos, height: Number(height) || 0 }
}

/** 背包里还有几支箭（给"到底射出去没有"当证据） */
export const arrowsIn = (b) => {
  let n = 0
  for (const it of b?.inventory?.items?.() ?? []) if (ARROW_RE.test(String(it?.name ?? ''))) n += Number(it.count ?? 0)
  return n
}

/** 创造模式不耗箭（`bot.game.gameMode` 是字符串；老版本/离线服可能没有 → 当生存看） */
export const infiniteArrows = (b) => String(b?.game?.gameMode ?? b?.player?.gameMode ?? '') === 'creative'

/**
 * 弓带无限附魔（Infinity）—— 生存模式下**也不耗箭**，所以"箭数掉了"不能再当证据。
 *
 * 🔴 2026-10-19 实机栽过：明明已经把龙射到半血（用户在场确认「中了」），工具却回
 *    `arrowsUsed:0 / outcome:"failed" / why:"箭数没变——服务端没认这次放箭"`，
 *    连射当场停掉。原因是**附魔的字段形状一代一个样**：
 *      · 1.12：`enchants: [{ name:'infinity', lvl:1 }]`
 *      · 1.16+：`enchantsByName: { infinity: 1 }`
 *      · 1.20.5+（本服 1.21.9）：走**物品组件** `componentMap.get('enchantments').data`，
 *        里面的字段可能叫 `id` / `type` / `enchantment`，等级可能叫 `lvl` / `level`
 *    ⇒ 老代码只认 `{name,lvl}`，一个都没命中，于是"无限弓"被当成"没射出去"。
 *
 * 这里**不认字段名**：把附魔的容器整个序列化，看里面有没有 `infinity`。
 * 认不出就当"没有"——宁可多等 600ms 判失败，也不能把真射出去的箭判成没射。
 */
export const itemHasInfinity = (it) => {
  if (!it || typeof it !== 'object') return false
  const hasInf = (v) => { try { return /infinity/i.test(JSON.stringify(v)) } catch { return false } }
  try { if (it.enchants != null && hasInf(it.enchants)) return true } catch {}
  try {
    const byName = it.enchantsByName
    if (byName && typeof byName === 'object') {
      if (Object.prototype.hasOwnProperty.call(byName, 'infinity')) return true
      if (hasInf(byName)) return true
    }
  } catch {}
  try {
    const cm = it.componentMap
    if (cm && typeof cm.get === 'function') {
      const comp = (typeof cm.has === 'function' && cm.has('enchantments')) ? cm.get('enchantments') : null
      if (comp && hasInf(comp?.data ?? comp)) return true
    }
  } catch {}
  try { if (it.nbt && hasInf(it.nbt)) return true } catch {}
  return false
}

/** 手里那把弓是不是无限的（见 `itemHasInfinity` 的形状说明） */
export const infinityBow = (b) => itemHasInfinity(b?.heldItem)

/**
 * 附近箭矢实体的 id 集合 —— **旁证**：无限弓 / 创造模式下箭数不变，
 * 但"天上多了一支新的箭"这件事骗不了人（2026-10-19 补上，见文件头坑 ⑥）。
 *
 * 半径给 24：箭速 30~60 格/秒，判失败前最多等 600ms，那时它已经在 20 格外了。
 */
const arrowEntityIdsNear = (b, radius = 24) => {
  const out = new Set()
  let me = null
  try { me = b?.entity?.position ?? null } catch {}
  try {
    for (const e of Object.values(b?.entities ?? {})) {
      if (!e?.position) continue
      if (!/arrow/i.test(String(e.name ?? e.displayName ?? ''))) continue
      if (me && typeof e.position.distanceTo === 'function' && e.position.distanceTo(me) > radius) continue
      out.add(e.id)
    }
  } catch {}
  return out
}


/**
 * 放完箭等"服务端把这箭记上"（箭数掉 1）—— 最多 600ms，掉下来就立刻回。
 *
 * 🔴 为什么不固定 `sleep(120)` 再看一眼：服务端有延迟/掉帧时，120ms 常常还没回包，
 *    于是"箭数没变"被误判成"这一箭没射出去"，整个连射当场停掉（2026-10-19 实测过）。
 *    创造模式 / 无限附魔没有箭数变化，固定等一小会儿就行。
 */
async function arrowsAfterRelease (b, before, noConsume, stepMs = 100) {
  const step = Math.max(0, Number(stepMs) || 0)
  if (noConsume) { await sleep(step ? 150 : 0); return arrowsIn(b) }
  for (let i = 0; i < 6; i++) {
    if (step) await sleep(step)
    const now = arrowsIn(b)
    if (now < before) return now
  }
  return arrowsIn(b)
}

/**
 * 目标速度（每 tick 多少格）—— hawkeye 的提前量就是 `newTarget += speed` 累加 `totalTicks` 次。
 *
 * 🔴 为什么不用 `entity.velocity` 了事：末影龙那种高速飞行体的 `entity_velocity` 包很稀（几 tick 一个），
 *    两次包之间读到的常常是 0，算出来的提前量就废了。这里**实测**：隔 100ms（2 tick）读两次位置，
 *    差值除以 tick 数。静止目标（水晶）直接给零向量。
 */
const speedOf = async (e, { lead = true } = {}) => {
  if (!lead || !e?.position) return new Vec3(0, 0, 0)
  const p0 = e.position.clone ? e.position.clone() : new Vec3(e.position.x, e.position.y, e.position.z)
  const ticks = 2                       // 100ms ≈ 2 tick（20 tick/s）
  await sleep(100)
  const p1 = e?.position
  if (!p1) return new Vec3(0, 0, 0)
  return new Vec3((p1.x - p0.x) / ticks, (p1.y - p0.y) / ticks, (p1.z - p0.z) / ticks)
}

/** 换到手里的武器；返回 `{ held, equipped }`（回读确认，和 `attack` 一个规矩） */
const holdWeapon = async (b, weapon) => {
  const now = b?.heldItem?.name ?? null
  if (now === weapon) return { held: `${now}x${b.heldItem?.count ?? 1}`, equipped: false }
  const item = (b?.inventory?.items?.() ?? []).find((it) => String(it?.name ?? '') === weapon)
  if (!item) {
    const have = (b?.inventory?.items?.() ?? []).map((it) => it.name).filter((n) => /bow|crossbow|trident/i.test(String(n)))
    throw new Error(`背包里没有 ${weapon}${have.length ? `（有：${[...new Set(have)].join('、')}）` : ''}—— 先 mc_craft 一把或者去拿`)
  }
  await b.equip(item, 'hand')
  const after = b?.heldItem?.name ?? null
  if (after !== weapon) throw new Error(`换 ${weapon} 没成功：换完手里是 ${after ?? '空'}`)
  return { held: `${after}x${b.heldItem?.count ?? 1}`, equipped: true }
}

/**
 * @param {object} b mineflayer bot
 * @param {object} args `{ who, x, y, z, count, waitTime, lead, weapon, radius, budget }`
 * @param {object} ctx `{ t, callLeft, grade, log }`
 *   · `ctx.t(promise, key, label)` —— 预算闸门（发包动作都要过）
 *   · `ctx.callLeft()` —— 这一轮还剩多少毫秒
 *   · `ctx.grade(target, speed, weapon)` —— 自检脚本注入假弹道用（不给就走真 hawkeye）
 */
/**
 * 射箭的正文（换弓 → 算弹道 → 瞄准 → 拉满 → 放箭 → 数箭）。
 *
 * 不直接对外：射完"把手换回去"要在**所有**出口（成功 / 半路停 / 抛错）都发生，
 * 所以外面套了一层 `shoot()` —— 和 `bridge.mjs` 的 `bridgeAcross` 同一个套路。
 */
async function shootInner (b, args = {}, ctx = {}) {
  const {
    who = null, x, y, z, count = 1, waitTime = DEFAULT_DRAW_MS, lead = true,
    weapon = 'bow', radius = 48, budget = 8_000, aim = null, maxDist = null,
  } = args ?? {}
  const t = ctx.t ?? (async (p) => await p)
  const callLeft = ctx.callLeft ?? (() => budget)

  const hasCoords = [x, y, z].every((v) => Number.isFinite(Number(v)))
  if (!who && !hasCoords) {
    throw new Error('要射谁/射哪：给 who（实体名，如 ender_dragon）或 x/y/z（方块坐标，射水晶用）')
  }
  if (who && hasCoords) throw new Error('who 和 x/y/z 只能给一个（要射那个实体就别给坐标）')
  if (!WEAPONS.has(String(weapon))) throw new Error(`weapon 只能是 ${[...WEAPONS].join(' / ')}（现在是 "${weapon}"）`)

  const n = Math.max(1, Math.min(5, Math.trunc(Number(count) || 1)))

  /* ① 换弓（先看手里是不是已经是了）。原来的那件由外面的 `shoot()` 记着，射完换回去 */
  const { held, equipped } = await holdWeapon(b, String(weapon))

  /* ② 箭：没有就别拉弓（服务端会白拉，白白吃掉这一轮的时间） */
  let arrowsBefore = arrowsIn(b)
  const creative = infiniteArrows(b)
  /* 无限附魔的弓：生存也不耗箭 ⇒ 箭数变化不能当证据（`noConsume` 管判据，`creative` 只管结果里那一行） */
  const noConsume = creative || infinityBow(b)
  if (arrowsBefore === 0 && !creative) {
    throw new Error(`没有箭（背包里箭 = 0）—— 先 mc_give 一组 arrow，或者去捡/合成，再射`)
  }

  /* ③ 目标：坐标（水晶）或实体（龙）。实体每射一箭都重新找（龙会飞走） */
  const findTarget = () => {
    if (hasCoords) {
      const pos = new Vec3(Number(x), Number(y), Number(z))
      const me = b.entity?.position
      const dist = me && typeof pos.distanceTo === 'function' ? me.distanceTo(pos) : null
      return { obj: { position: pos, isValid: true }, label: `(${x}, ${y}, ${z})`, pos, dist, entity: false }
    }
    const snap = Object.values(b.entities ?? {})
      .filter((e) => e && e !== b.entity && e.position)
      .map((e) => ({ e, d: e.position.distanceTo(b.entity.position) }))
      .filter((s) => s.d <= Math.max(8, Number(radius) || 48))
    const { hit, near } = pickEntity(snap, who)
    if (!hit) {
      throw new Error(`附近 ${radius} 格内找不到 "${who}"（实际有：${near || '什么都没有'}）`)
    }
    return { obj: hit.e, label: entityNameOf(hit.e), pos: hit.e.position, dist: hit.d, entity: true }
  }

  /* ④ 弹道：真 hawkeye（每次重新 bind，见文件头坑 ②）或注入的假弹道 */
  /* 兜底弹道要知道"这一箭有多快" ⇒ 先按 waitTime 估一个拉弓时长（循环里真正的 `drawMs`
   * 还会被剩余预算夹一次，那点差别对弹道影响很小，不值得为它重解）。 */
  const estDrawMs = Math.max(MIN_DRAW_MS, Math.min(Number(waitTime) || DEFAULT_DRAW_MS, 20_000))
  /**
   * 沿一条弹道采样，看有没有**实心方块**挡着（用户 2026-10-25「现在弓箭只会平射，不会抛射」）。
   *
   * 只认 `boundingBox === 'block'`：空气 / 水 / 草 / 藤蔓 / 火把这些箭都能穿过去。
   * 读不到区块（`blockAt` 回 null）= **不知道**，不当作"挡"。
   */
  const blockedAlong = (pitch, yaw, to, speed) => {
    const me = b.entity?.position
    if (!me || typeof b.blockAt !== 'function') return null
    const from = new Vec3(me.x, me.y + Number(b.entity?.eyeHeight ?? 1.62), me.z)
    const c = Math.cos(pitch)
    const v = new Vec3(-Math.sin(yaw) * c * speed, Math.sin(pitch) * speed, -Math.cos(yaw) * c * speed)
    const p = from.clone()
    const reach = from.distanceTo(to) + 3
    let unknown = false
    /* 只跳过"自己站的那一格"（约 0.3 格），原来写 1.3 —— 紧贴着脸的墙（1 格）整段被跳过 ⇒ 漏检。 */
    const probe = (sx, sy, sz) => {
      const d = Math.hypot(sx - from.x, sy - from.y, sz - from.z)
      if (d < 0.6) return null
      if (d > reach) return 'done'
      let blk = null
      try { blk = b.blockAt(new Vec3(Math.floor(sx), Math.floor(sy), Math.floor(sz))) } catch { blk = null }
      /* 读不到（区块没加载）≠ 没有：记一笔继续往后看，一路都读不到才算"不知道"。 */
      if (!blk) { unknown = true; return null }
      if (blk.boundingBox === 'block') return { name: blk.name, at: { x: sx, y: sy, z: sz } }
      return null
    }
    for (let tk = 1; tk <= 240; tk++) {
      const px = p.x
      const py = p.y
      const pz = p.z
      p.x += v.x; p.y += v.y; p.z += v.z
      v.x *= ARROW_DRAG; v.y = v.y * ARROW_DRAG - ARROW_GRAVITY; v.z *= ARROW_DRAG
      /* 🔴 2026-10-26 实机（打末影水晶永远平射）：箭一 tick 走 3 格，原来**只在 tick 端点采样**
       *   ⇒ 1 格厚的柱子 / 墙 / 台阶被整段跨过去，永远查不出"挡"，于是永远不换抛射。
       *   现在沿这一段插值（步长 ≤ 0.4 格）。 */
      const seg = Math.hypot(p.x - px, p.y - py, p.z - pz)
      const n = Math.max(1, Math.ceil(seg / 0.4))
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const hit = probe(px + (p.x - px) * t, py + (p.y - py) * t, pz + (p.z - pz) * t)
        if (hit === 'done') return unknown ? { name: null, unknown: true } : null
        if (hit) return hit
      }
    }
    return unknown ? { name: null, unknown: true } : null
  }

  /** 最后一道闸：这条弹道会不会撞方块？会就换一条能越过去的（通常是高抛） */
  const polish = (g, aimed, speed) => {
    if (!g) return g
    const p = aimed?.position ?? aimed
    if (!p || !b.entity?.position || typeof b.blockAt !== 'function') return g
    const to = new Vec3(p.x, p.y + Number(aimed?.height ?? 0), p.z)
    const hit = blockedAlong(g.pitch, g.yaw, to, arrowSpeedFor(estDrawMs))
    if (!hit || hit.unknown) return g
    const alt = fallbackGrade(aimed, speed, { clearOf: true })
    if (alt) return { ...alt, wasBlocked: hit.name ?? '?' }
    return { ...g, blockedBy: hit.name ?? '?' }
  }

  const gradeOf = async (target) => {
    const speed = target.entity ? await speedOf(target.obj, { lead }) : new Vec3(0, 0, 0)
    /* 瞄点：hawkeye 默认瞄包围盒**顶面**（`position + (0, height, 0)`）——末影龙 height=8 ⇒ 翅膀上方。
     * `aimHeightFor` 把大个子压到身体高度；坐标目标（水晶）可以用数字往上抬。 */
    const aimH = aimHeightFor({ entity: target.entity, height: target.obj?.height ?? 0 }, aim)
    const aimed = aimProxyFor(target.obj, aimH)
    if (typeof ctx.grade === 'function') return ctx.grade(aimed, speed, String(weapon))
    const bind = await loadMcDep('hawkeye', { log: (m) => ctx.log?.(m), logWarn: (m) => ctx.log?.(m) })
    if (!bind) {
      throw new Error('没装 minecrafthawkeye（`vendor/mc-deps` 里缺这个包）—— 弹道算不出来，不瞎射')
    }
    bind(b)                              // 幂等：只把模块级单例换成本 bot（多号共进程时必须）
    if (typeof b.hawkEye?.getMasterGrade !== 'function') {
      throw new Error('hawkeye 挂上了但没给 getMasterGrade —— 版本不对，别射了')
    }
    const grade = b.hawkEye.getMasterGrade(aimed, speed, String(weapon))
    /* 🔴 2026-10-20（用户：「怎么感觉射不准」「鸡打不中」）：hawkeye 在**近距离**只有约 0.5 格的格点精度
     *    —— 实机：4 格外的 NoAI 鸡，它报落点误差 0.50，直接被 0.4 的闸拦死，一箭没放。
     *    所以自己也解一条（`ballistics.mjs`，0.5° 步长、无偏），**落点误差更小就用自己那条**。
     *    实测同一批目标：hawkeye 0.50 → 自己 0.01（鸡 4 格）、0.09 → 0.01（僵尸 9 格）。 */
    const fbBest = fallbackGrade(aimed, speed)
    const gErr0 = Number(grade?.nearestDistance)
    const fbErr0 = Number(fbBest?.nearestDistance)
    if (grade && Number.isFinite(gErr0) && Math.abs(Number(grade.pitch) || 0) * 180 / Math.PI <= LOW_ARC_MAX_DEG) {
      /* 两边都是平射解：挑落点更准的（差 0.02 以内算打平，保留 hawkeye 的原解） */
      return polish((Number.isFinite(fbErr0) && fbErr0 + 0.02 < gErr0) ? fbBest : grade, aimed, speed)
    }
    if (grade) {
      /* 🔴 用户 2026-10-19「优先平射」：hawkeye 在同一段距离上常常给出**高抛解**
       *    （实机 22 格的静止末影水晶给了 pitch 83.5°，箭打短 4 格；19.7 格给 3.9° 一发就中）。
       *    所以只要它给的仰角超过 LOW_ARC_MAX_DEG，就用自己那套解一条平射的比一比，
       *    误差不比它差太多（≤ +0.5 格）就用平射。 */
      const gdeg = Math.abs(Number(grade.pitch) || 0) * 180 / Math.PI
      if (gdeg <= LOW_ARC_MAX_DEG) return polish(grade, aimed, speed)
      const low = fallbackGrade(aimed, speed, { preferLow: true })
      const gErr = Number.isFinite(Number(grade.nearestDistance)) ? Number(grade.nearestDistance) : 4
      if (low && Number(low.nearestDistance) <= gErr + 0.5) {
        /* 🔴 2026-10-26 实机「打末影水晶还是只能用平射」：误差小 ≠ 打得中 ——
         *   水晶都在黑曜石柱顶上，平射轨迹撞柱子/打不到；"优先平射"必须先问一句
         *   "这条平射真的通吗"，通不过就让位给高抛解。 */
        /* 🔴 2026-10-26 实机 `Error: to is not defined`：`to` 是 polish/fallbackGrade 的局部变量，
         *    这里（gradeOf 作用域）根本没有它 —— 自己算一个瞄准点。 */
        const aimP = aimed?.position ?? aimed
        const toV = aimP ? new Vec3(aimP.x, aimP.y + Number(aimed?.height ?? 0), aimP.z) : null
        const blk = toV ? blockedAlong(low.pitch, low.yaw, toV, arrowSpeedFor(estDrawMs)) : null
        if (!blk || blk.unknown) return polish({ ...low, preferLow: true }, aimed, speed)
      }
      return polish(grade, aimed, speed)
    }
    /* 🔴 2026-10-19（用户：「要它在空中射中」「在低上往上射」）：hawkeye 解不出来时不能就此放弃。
     *    实机：站在地面（y≈63）往 y≈85 的龙射，仰角 40°~70°，hawkeye 一律返回 undefined
     *    （提示「算不出弹道：目标 31.1 格、角度也刁」）—— "低处往高处打"整条路被堵死。
     *    兜底：用 `ballistics.mjs` 自己按箭的运动模型暴力扫仰角（带提前量）。 */
    return polish(fallbackGrade(aimed, speed), aimed, speed)
  }

  /** hawkeye 没有解时的兜底弹道（`ballistics.mjs`）—— 返回形状和 hawkeye 的 grade 对齐 */
  const fallbackGrade = (aimed, speed, { preferLow = false, clearOf = false } = {}) => {
    const me = b.entity?.position
    const p = aimed?.position ?? aimed
    if (!me || !p) return null
    const from = new Vec3(me.x, me.y + Number(b.entity?.eyeHeight ?? 1.62), me.z)
    const to = new Vec3(p.x, p.y + Number(aimed?.height ?? 0), p.z)
    const spd0 = arrowSpeedFor(estDrawMs)
    /* 🔴 用户 2026-10-25「现在弓箭只会平射，不会抛射」：
     *    `preferLow` 一律挑低仰角，平射路径上有方块（墙/台阶/树叶/地形）时箭全撞上去。
     *    这里换成"按误差可接受扫全部候选，挑轨迹上**没有实心方块**的那条"——通常就是高抛。
     *    一条都不清白 ⇒ 返回 null，让调用方如实说"打不着，被挡着"。 */
    if (clearOf) {
      const base = solveArrowLead({ from, to, vel: speed, speed: spd0 })
      const scan = solveArrowAll({ from, to: base?.aim ?? to, speed: spd0 })
      if (!scan) return null
      const tol = Math.max(0.4, Number(ctx?.maxAimError ?? 0.4) + 0.6)
      for (const c of scan.cands) {
        if (!(c.err <= tol)) continue
        if (blockedAlong(c.pitch, scan.yaw, to, spd0)) continue
        return {
          yaw: scan.yaw,
          pitch: c.pitch,
          nearestDistance: c.err,
          grade: c.deg,
          ballistics: true,
          lob: Math.abs(c.deg) > 10,
          flyTicks: c.ticks,
          lead: Boolean(base?.lead),
        }
      }
      return null
    }
    const sol = solveArrowLead({ from, to, vel: speed, speed: spd0, preferLow })
    if (!sol) return null
    return {
      yaw: sol.yaw,
      pitch: sol.pitch,
      nearestDistance: sol.err,
      grade: sol.deg,
      ballistics: true,
      flyTicks: sol.ticks,
      lead: sol.lead,
    }
  }

  const shots = []
  let fired = 0
  let why = null
  let lastTarget = null
  let sawNewArrow = false       // 有过"箭数没变但天上多了一支新箭"的证据 ⇒ 算真射出去了

  for (let i = 1; i <= n; i++) {
    const target = findTarget()
    lastTarget = target
    /* 🔴 用户 2026-10-19「maxDist可以改，那个不是你测出来的吗」——
     *    实机数据：打末影龙**命中的都 ≤ 25 格**（15.5 / 16.3 / 22.3 / 23.3 格），
     *    26.5 / 30.1 / 34.2 格那几发全空（箭飞 0.6~1 秒，龙已经拐弯）。
     *    所以给一个"太远就不射"的闸：它不是"判得中不中"，是**干脆不给这一箭**。
     *    默认关（null）—— 你自己按场合给数（打龙用 25）。 */
    const isDragon = HOLD_FOR_RE.test(String(target.obj?.name ?? ''))
    /* 龙落地 = 免疫投射物（见 `isDragonPerched` 的实测）⇒ 一箭都别射，等它起飞或换近战 */
    if (isDragon && target.entity && isDragonPerched(target.obj)) {
      why = '末影龙落地了（停在祭坛上）—— **落地时它免疫投射物**，射了也是 0 伤害。'
        + '等它起飞再射（升到 y≈70 以上），或者直接换剑上去砍'
      break
    }
    /* 没显式给 maxDist 时，末影龙自动套 DRAGON_MAX_DIST（实机命中距离分布，见常量注释） */
    const capRaw = Number(maxDist)
    const cap = (Number.isFinite(capRaw) && capRaw > 0)
      ? capRaw
      : (isDragon ? DRAGON_MAX_DIST : null)
    if (cap != null && target.dist != null && target.dist > cap) {
      why = `目标 ${target.dist.toFixed(1)} 格，超过 maxDist=${cap} 格 —— **这一箭没射**（走进去，或等它飞近）`
      break
    }
    const aimH = aimHeightFor({ entity: target.entity, height: target.obj?.height ?? 0 }, aim)
    const grade = await gradeOf(target)
    if (!grade) {
      why = `算不出弹道：目标 ${target.dist != null ? target.dist.toFixed(1) + ' 格' : '太远'}、角度也刁 —— `
        + 'hawkeye 要求落点误差 ≤ 4 格，靠近一点或换个高度再射'
      break
    }
    /* 🔴 2026-10-19（用户实机「尽量不空就行」）：解出来的弹道**离目标太远**就别放箭了。
     *    实机证据：打末影龙时有一箭 `aimError: 1.18`（弹道离它 1.18 格），那一箭果然空了；
     *    而命中的几箭 aimError 都在 0.01~0.39。hawkeye 只在误差 > 4 格时才返回 undefined，
     *    1~4 格这一段它会照样给出解、我们也照样射 —— 白费箭，还让人以为"弓不准"。
     *    阈值可用 `ctx.maxAimError` 覆盖（自检里用得到）。
     *    🔴 2026-10-19 实机统计（打末影龙，力量 V 弓、创造不耗箭）：**命中**的 18 箭 aimError
     *    落在 0.02~0.36；**打空**的 6 箭落在 0.43~0.60 ⇒ 0.6 这道闸太松，改成默认 **0.4**。
     *    **活的目标不在这道闸里拦**（下面"端着等"会等到准了再放）—— 见 `canHold`。 */
    const maxErr = Number(ctx?.maxAimError ?? 0.4)
    const aimErr = Number(grade.nearestDistance ?? 0)
    const canHold = Boolean(target.entity && lead && HOLD_FOR_RE.test(String(target.obj?.name ?? '')))
    if (!canHold && Number.isFinite(maxErr) && maxErr > 0 && aimErr > maxErr) {
      why = `这一箭会空：弹道离目标 ${aimErr.toFixed(2)} 格（我要求 ≤ ${maxErr} 格）—— `
        + '靠近点、等它慢下来，或者换个能站高/站低的位置再射'
      break
    }
    if (callLeft() < MIN_DRAW_MS + 600) { why = '这一轮时间不够拉满弓了（要 ≥ 1 秒）'; break }

    /* ⑤ 瞄准 → 拉弓 → 等拉满 → **再瞄一次**（目标动了/龙在俯冲）→ 放 */
    await t(b.look(grade.yaw, grade.pitch, true), 'look', '射箭瞄准')
    await t(b.activateItem(), 'use', '拉弓')
    const drawMs = Math.max(Number(ctx.minDrawMs ?? MIN_DRAW_MS), Math.min(Number(waitTime) || DEFAULT_DRAW_MS, callLeft() - 500))
    await sleep(drawMs)
    /* 🔴 2026-10-19（用户实机：「能不能弓蓄力，然后等高命中率，再射」）：
       以前是"拉满 → 重解一次弹道 → 立刻放"。可目标一直在动，解出来那一刻是准的，
       放出去时它已经拐弯了 —— 实机打末影龙时一轮十几箭全空。
       现在**拉满之后先端着别放**：弓拉满就一直满（端着不掉力量），每 `HOLD_POLL_MS`
       重解一次弹道，等到"这一箭离目标 ≤ maxAimError（默认 0.4 格）"再撒手；
       最多端 `HOLD_MAX_MS`；到点还不准就**不放**（用户 2026-10-19：「等不到不放」）。
       `gradeOf` 自己会采一次目标速度（~100ms），所以轮询实际步长比 HOLD_POLL_MS 大。 */
    let heldMs = null
    if (canHold) {
      const holdMax = Math.max(0, Number(ctx?.holdMaxMs ?? HOLD_MAX_MS))
      const goodErr = Number.isFinite(maxErr) && maxErr > 0 ? maxErr : 0.4
      const tHold = Date.now()
      let g = await gradeOf(target)
      if (g) await b.look(g.yaw, g.pitch, true)
      while (g && Number(g.nearestDistance ?? 9) > goodErr
             && Date.now() - tHold < holdMax && callLeft() > 400) {
        await sleep(HOLD_POLL_MS)
        const g2 = await gradeOf(target)
        if (!g2) continue
        g = g2
        await b.look(g.yaw, g.pitch, true)
      }
      heldMs = Date.now() - tHold
      const stillBad = !(g && Number(g.nearestDistance ?? 9) <= goodErr)
      /* 🔴 2026-10-19（用户：「等不到不放」）：端到上限还是不准 ⇒ **这一箭不放**。
       *    弓已经拉满了，想收回只能用原版那条路：**切快捷栏 = 取消拉弓、不发射**
       *    （`deactivateItem` 是"撒手"，在 Minecraft 里就等于放箭，所以不能拿它取消）。
       *    没 `setQuickBarSlot` 的假 bot 就干脆不撒手 —— 少一发也不影响判定。 */
      if (stillBad) {
        try {
          if (typeof b.setQuickBarSlot === 'function') b.setQuickBarSlot((Number(b.quickBarSlot ?? 0) + 1) % 9)
        } catch {}
        /* 🔴 2026-10-20 审计：`g` 为 null 时这里会印出"最近还差 **NaN** 格" ——
         *    对 AI 来说那是一句没法用的乱码。算不出来就直说算不出来。 */
        const gap = g?.nearestDistance
        why = `端着等了 ${(heldMs / 1000).toFixed(1)} 秒也没等到准的弹道（`
          + (gap == null ? '最后连弹道都算不出来（目标丢了/被挡住）' : `最近还差 ${Number(gap).toFixed(2)} 格 > ${goodErr}`)
          + '）'
          + ' —— **这一箭没放**，箭没白扔。换个位置（同高/贴到 15 格内）或等它慢下来再射'
        break
      }
    }
    await sleep(LOOK_SETTLE_MS)
    /* 放箭**之前**记下附近已有的箭（地上躺着的、别人射的）——放完新冒出来的那支才是我的 */
    /* 2026-10-23 审计：连射时 `arrowsBefore` 只在循环外取一次 ⇒ 第二发报「用了 2 支」、第三发报 3……
     * 每发之前重取**本发**基准 `shotBefore`（判"这一箭有没有真射出去"），
     * 而 `arrowsBefore` 保持循环前那次（结果里 `arrows.before → after` 的**总量**要算得对）。 */
    const shotBefore = noConsume ? arrowsBefore : arrowsIn(b)
    const arrowsSeenBefore = arrowEntityIdsNear(b)
    await t(b.deactivateItem(), 'use', '放箭')
    const after = await arrowsAfterRelease(b, shotBefore, noConsume, ctx.pollMs)
    const used = shotBefore - after
    /* 🔴 箭数没变时的**旁证**：天上多了一支新箭 ⇒ 这一箭确实射出去了。
     *    无限弓的附魔形状认不出来时（见 `itemHasInfinity` 的说明），全靠这一条兜底，
     *    否则会出现"明明射中了、工具却说没射出去"的假失败，连射当场停掉。 */
    const newArrow = (() => {
      if (used > 0) return false
      try { for (const id of arrowEntityIdsNear(b)) if (!arrowsSeenBefore.has(id)) return true } catch {}
      return false
    })()
    const blockedPos = grade.blockInTrayect?.position ?? null
    shots.push({
      n: i,
      yawDeg: Number((grade.yaw * 180 / Math.PI).toFixed(1)),
      pitchDeg: Number((grade.pitch * 180 / Math.PI).toFixed(1)),
      grade: Number(Number(grade.grade ?? 0).toFixed(1)),
      /* 🔴 2026-10-20 审计：原来 `?? 0` 会把"算不出误差"写成 **0 = 完美命中**。 */
      aimError: grade.nearestDistance == null ? null : Number(Number(grade.nearestDistance).toFixed(2)),
      distance: target.dist != null ? Number(target.dist.toFixed(1)) : null,
      blocked: blockedPos ? (b.blockAt?.(blockedPos)?.name ?? '?') : null,
      ...(blockedPos ? { blockedAt: [blockedPos.x, blockedPos.y, blockedPos.z] } : {}),
      arrowsUsed: Math.max(0, used),
      ...(aimH == null ? {} : { aimY: Number(Number(aimH).toFixed(2)) }),
      ...(heldMs == null ? {} : { heldMs }),
      ...(grade.ballistics ? { ballistics: true } : {}),
      ...(grade.lob ? { lob: true } : {}),
      ...(grade.wasBlocked ? { lobOver: grade.wasBlocked } : {}),
      ...(grade.blockedBy ? { blockedBy: grade.blockedBy } : {}),
      ...(newArrow ? { arrowEntity: true } : {}),
    })
    fired++
    if (newArrow) sawNewArrow = true
    if (!noConsume && used <= 0 && !newArrow) { why = '箭数没变、天上也没多出箭 —— 服务端没认这次放箭（可能没拉满/被拒），别接着射'; break }
  }

  const arrowsAfter = arrowsIn(b)
  /* 判"射出去了"的三条证据，任一成立即可：创造模式/无限弓（不耗箭）、箭数掉了、
   * 或者天上多了一支新箭（无限附魔形状认不出来时的兜底） */
  const ok = fired > 0 && (noConsume || sawNewArrow || arrowsBefore > arrowsAfter)
  return {
    ok,
    weapon: String(weapon),
    held,
    ...(equipped ? { equipped: true } : {}),
    ...(creative ? { creative: true } : {}),
    ...(noConsume ? { noConsume: true } : {}),
    ...(lastTarget
      ? {
          target: {
            name: lastTarget.label,
            at: [Math.floor(lastTarget.pos.x), Math.floor(lastTarget.pos.y), Math.floor(lastTarget.pos.z)],
            ...(lastTarget.dist != null ? { distance: Number(lastTarget.dist.toFixed(1)) } : {}),
          },
        }
      : {}),
    fired,
    shots,
    arrows: { before: arrowsBefore, after: arrowsAfter },
    ...(why ? { why } : {}),
  }
}

/**
 * 射箭（对外入口）—— 射完把手换回原来那件。
 *
 * 为什么必须包一层：`shootInner` 里有三个出口（射完 / 半路停 / 抛错），
 * 换回去这件事**每个出口都得做**；`finally` 是唯一能一次覆盖三处的地方。
 * 换不回来不算失败（箭已经射出去了），只如实记一句 `heldRestoreWhy`。
 */
export async function shoot (b, args = {}, ctx = {}) {
  const keep = heldSnapshotOf(b)
  let out = null
  try {
    out = await shootInner(b, args, ctx)
    return out
  } finally {
    const r = await restoreHeldOf(b, keep)
    if (out) {
      if (r.restored) out.heldRestored = keep.name
      else if (r.why) out.heldRestoreWhy = r.why
      out.held = b?.heldItem ? `${b.heldItem.name}x${b.heldItem.count ?? 1}` : '空手'
    }
  }
}
