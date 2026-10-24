/**
 * 只读观察：我在哪、我周围有什么、我离它多远。
 *
 * 路线图第 ④ 条第十刀从 `src/core.mjs` 搬出来的（原来是类里的私有方法 `#x`）。
 * 头注释里那几条约定与前几刀一样：
 *   · 不反向 import `core.mjs`（这一层只往下依赖 `entity-names.mjs`）；
 *   · 不 import mineflayer / vec3 这类游戏库 —— 收 `bot` 当参数，只用它现成的字段；
 *   · **只读**：不看世界、不发包、不改状态、不 await（所以搬出来不会动到异步流程）。
 *
 * 搬家时唯一动过的地方：`#reachOf` 改名 `blockReachOf`（`extensions/mc_craft.mjs` 里有一个
 * 同名的 `reachOf`，那个是"这个材料我够不够得着做"，跟"我离这块方块多远"不是一回事）。
 */
import { isDropEntity } from './entity-names.mjs'
import { isWaterLike } from './block-names.mjs'

/**
 * 读一个实体的血量（读不到就 null）。
 *
 * 🔴 2026-10-17 实机：**以前这个函数在真服上永远回 null**，于是 `attack()` 的
 *    "打死必须有掉血证据"永远不成立 —— 拳头把僵尸打死了，报的却是
 *    `combat:"unknown"` + "没读到过它掉血"（连带 `pickup` 掉落提示也从不出现）。
 *
 *    根因不在我们这儿，在 `@nxg-org/mineflayer-util-plugin` 的 `getHealth()`：
 *    它算 `metadata[9] + Number(metadata[13]) ?? 0`，而怪身上第 13 格是 `undefined`
 *    ⇒ `Number(undefined)` 是 `NaN`，`NaN ?? 0` **还是 NaN**（`??` 只兜 null/undefined）
 *    ⇒ 整个返回值是 NaN。所以这里**自己读 metadata**，别指望那个助手。
 *
 *    槽位跟它一样按版本分：1.16 及以前是 7，1.17+ 是 9；
 *    吸收血量在 `槽位 + 4`（**要单独判有限性**，不能再犯上面那个 `??` 的错）。
 *
 * @param {object} b mineflayer bot
 * @param {object} e prismarine-entity 实体
 * @returns {number|null} 血量（保留一位小数）；读不到 / 已死（<=0）回 null
 */
export function entityHealth (b, e) {
  if (!e) return null
  const fin = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null
  }
  /* ① 自己读 metadata（唯一在真服上验证过能用的路） */
  const minor = Number(String(b?.version ?? '').split('.')[1])
  const slot = Number.isFinite(minor) && minor <= 16 ? 7 : 9
  const abs = Number(e?.metadata?.[slot + 4])
  const direct = fin(Number(e?.metadata?.[slot]) + (Number.isFinite(abs) ? abs : 0))
  if (direct != null) return direct
  /* ② 现成的助手（对 bot 自己的实体它另有来源，可能比 metadata 靠谱） */
  try { const viaUtil = fin(b?.util?.entity?.getHealth?.(e)); if (viaUtil != null) return viaUtil } catch { /* 助手不可用 */ }
  /* ③ 兜底：老版本 mineflayer 会在实体上直接放 `health` */
  return fin(e?.health)
}

/** 我现在在水里吗（脚在水的 AABB 里，或眼睛那格是水）。
 *  🔴 `bot.entity.isInWater` 在**浮在水面**时读出来是 false（prismarine-physics 入水 AABB 从底部缩了 0.401）
 *  ⇒ 两个判据都要看（2026-10-08 实机，水里游不动那次）。 */
export function inWaterNow (b) {
  try { if (b?.entity?.isInWater) return true } catch { /* 往下退 */ }
  try {
    const eye = b?._getBlockAtEyeLevel?.()?.name
    if (isWaterLike(eye)) return true
  } catch { /* 往下退 */ }
  /* 2026-10-22 实机（用户：卡在水面）：浮在水面头露出时眼高那格是空气，只看眼睛会判成没在水里，
     于是 swimUp 说"我本来就没在水里"、walkToOnce 走 pathfinder（A* 不认水，moved 0）、
     dig-guard 见 onGround=false 拒掉所有挖掘，实测卡死约 10 分钟。
     补一层：脚所在那格是水也算在水里（entity.position 就是脚底）。 */
  try {
    const feet = b?.entity?.position?.floored?.()
    const n = feet && typeof b?.blockAt === 'function' ? b.blockAt(feet)?.name : null
    /* 🔴 2026-10-24 实机（用户：「在水里会被水草挡住」）：这里以前只认 water/flowing_water/bubble_column，
     *    站在 seagrass / tall_seagrass / kelp 那格就被判成"在陆地上" ⇒ swim 分支不触发、原地卡死。
     *    改用 isWaterLike（把水里植物也算进来）。 */
    return isWaterLike(n)
  } catch { return false }
}

/** 我**真在下落**吗（空中挖慢 5 倍的那个判据）。
 *  🔴 不能只看 `entity.onGround === false`：走路下台阶、贴着斜坡边缘时它也会瞬间为 false
 *  （2026-10-08 实机把"木镐挖石头"估成 5650ms，真实只要 1125ms ⇒ 白拒一次本来挖得完的挖掘）。
 *  ⇒ 判据是"离地 **且** 竖直速度明显为负"。
 *  ⚠️ 这个判据必须和 `src\dig-speed.mjs` 里估时用的那个**是同一个** —— 2026-10-15 审计发现
 *  `slowDigWhy` 说"我在空中，挖方块慢 5 倍"时，那个 ms 其实根本没乘 5，文案在骗模型。 */
export function fallingNow (b) {
  const vY = Number(b?.entity?.velocity?.y ?? 0)
  return b?.entity?.onGround === false && vY < -0.02
}

/** 挖得慢的现成理由（水里 / 空中各慢 5 倍）—— 用来把"时间不够"说清楚 */
export function slowDigWhy (b) {
  const parts = []
  if (inWaterNow(b)) parts.push('我在水里')
  if (fallingNow(b)) parts.push('我在空中')
  return parts.length ? `（${parts.join('、')}，挖方块慢 5 倍）` : ''
}

/**
 * 附近**还没捡**的掉落物（离我多远，近的在前）。判据与 `#grabDrops` 共用 `isDropEntity`。
 */
export function dropsNear (b, radius = 12) {
  const me = b?.entity?.position
  if (!me) return []
  return Object.values(b?.entities ?? {})
    .filter((e) => isDropEntity(e))
    .map((e) => ({ e, d: me.distanceTo(e.position) }))
    .filter((x) => Number.isFinite(x.d) && x.d <= radius)
    .sort((a, c) => a.d - c.d)
}

/**
 * "东西还掉在地上"的一句话（没有就返回 null）。
 *
 * why（用户 2026-10-08 原话）："挖完方块或者打完动物以后老是忘记走过去拾取" ——
 * 这是**决策**，插件替不了；但插件至少能在结果里**点一句**，让模型别把这活当成干完了。
 * 只在"没捡到东西 / 打死怪之后"调用，捡到手就不提醒（服务端把掉落物实体移出视野有延迟，
 * 刚捡完那一下它还挂在 `bot.entities` 里，提醒会变成假警报）。
 */
/**
 * 掉落物清单（带坐标）：`[{ name?, x, y, z, dist }]`，最近的在前。
 *
 * 🔴 为什么不能只给一句"地上还有 N 个"（`dropHint` 就是那样）：
 *   2026-10-22 我在下界打死两只烈焰人，两次都**没拿到烈焰棒** ——
 *   结果里只有"地上还有掉落物"这句话，**没有它在哪**，等再问的时候东西已经没了。
 *   "要不要走过去、值不值得下那个崖"是 AI 的决策，但"东西在哪"必须是插件给的**事实**。
 *   名字取不到就省略（`getDroppedItem` 要看 mineflayer 版本，取不到不该让整条报错）。
 */
export function dropListOf (b, { radius = 12, limit = 5 } = {}) {
  const list = []
  for (const { e, d } of dropsNear(b, radius)) {
    if (list.length >= limit) break
    let name = null
    try { name = b?.getDroppedItem?.(e)?.name ?? null } catch { name = null }
    const p = e?.position
    if (!p) continue
    list.push({
      ...(name ? { name } : {}),
      x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z),
      dist: Math.round(d * 10) / 10,
    })
  }
  return list
}

export function dropHint (b, { radius = 12 } = {}) {
  const drops = dropsNear(b, radius)
  if (!drops.length) return null
  const d = drops[0].d
  /* 背包满的时候"走过去"是白跑：服务端不会把东西塞给你（准则「干活习惯」里那条也是这么写的）。 */
  let full = false
  try { full = b?.inventory?.emptySlotCount?.() === 0 } catch { full = false }
  return `地上还有 ${drops.length} 个掉落物没捡（最近 ${d.toFixed(1)} 格）—— `
    + '先 `mc_move` 走过去站上去，一两秒就飞进背包（掉落物几分钟就消失）'
    + (full ? '；**背包满了**：先 `mc_chest` 存一趟，或丢掉没用的' : '')
}

/**
 * 我离这块方块**真正**有多远（服务端/上游的判据）。
 *
 * 🔴 2026-10-08 实机（熔炼验证，探针定论）：上游 `canDigBlock` 和服务端用的都是
 *    **眼睛 → 方块中心**（`digging.js`：`block.position.offset(.5,.5,.5).distanceTo(
 *    bot.entity.position.offset(0,1.65,0)) <= 5.1`，生存 reach 4.5），
 *    而插件以前算的是 **脚 → 方块坐标**。两者差得远：脚边 4 格**正下方**的石头，
 *    脚距 4.0（判"够得着"、原地挖）而眼距 5.6（服务端直接忽略）
 *    ⇒ 客户端预测把方块写成 air、插件报"挖掉"，**服务端没认、也没掉任何东西**。
 *    实机证据：`mc_dig stone` 连报 5 个"挖掉 … → 现在 air"，背包里圆石 = 0，
 *    `bot.entities` 里一个掉落物都没有（探针 `probe-drop.mjs`）。
 */
export function blockReachOf (b, blk) {
  try {
    const p = blk?.position
    const pos = b?.entity?.position
    if (!p || !pos) return Infinity
    const ex = Number(pos.x)
    const ey = Number(pos.y) + Number(b.entity.eyeHeight ?? 1.62)
    const ez = Number(pos.z)
    const cx = Number(p.x) + 0.5
    const cy = Number(p.y) + 0.5
    const cz = Number(p.z) + 0.5
    if (![ex, ey, ez, cx, cy, cz].every(Number.isFinite)) return Infinity
    return Math.hypot(ex - cx, ey - cy, ez - cz)
  } catch { return Infinity }
}

/** 方块状态 id → 名字（查不到就 null，别抛） */
export function stateNameOf (b, stateId) {
  try {
    const e = b?.registry?.blocksByStateId?.[Number(stateId)]
    return e?.name ?? null
  } catch { return null }
}

/** 世界上下界（读 bot.game.minY / bot.game.height；读不到就按 1.18+ 的默认 -64..320）。
 *  为什么要它：`blockAt()` 在 **y 越界** 时同样返回 null / air —— 那不是"区块没加载"，
 *  是"世界根本没有这一层"，两者混在一起会让扫描结果骗人。 */
export function worldBoundsOf (b) {
  const g = b?.game ?? {}
  const minY = Number.isFinite(Number(g.minY)) ? Number(g.minY) : -64
  const h = Number.isFinite(Number(g.height)) && Number(g.height) > 0 ? Number(g.height) : 384
  return { minY, maxY: minY + h - 1 }
}

/**
 * 这一格**客户端到底知不知道**（只读，不 await）。
 *
 * 2026-10-23 检查（用户："看一下客户端的代码"）后核实的模型事实：
 *   · prismarine-chunk 1.18+ 的 ChunkColumn 构造时就把**全部 section 预先分配好**
 *     （实测 1.21.4：numSections=24、缺失下标 0），所以"section 缺失导致方块更新被静默丢弃"
 *     这条路**不存在**；
 *   · y 在上下界之外时 getBlockStateId 直接回 0（= 空气），getBlock 也照常给 air ——
 *     **读不出"越界"这个状态**，只能按 bot.game 的上下界自己判；
 *   · 只有**整列没下发**时 bot.blockAt() 才是 null，那才是真的"还没加载"。
 *
 * @returns {{known: boolean, name: (string|null), why: 'ok'|'no-column'|'out-of-world'}}
 */
export function blockKnownAt (b, pos) {
  if (!pos) return { known: false, name: null, why: 'no-column' }
  const y = Number(pos.y)
  const { minY, maxY } = worldBoundsOf(b)
  if (!Number.isFinite(y) || y < minY || y > maxY) return { known: false, name: null, why: 'out-of-world' }
  let blk = null
  try { blk = b?.blockAt?.(pos) ?? null } catch { blk = null }
  if (!blk) return { known: false, name: null, why: 'no-column' }
  return { known: true, name: blk.name, why: 'ok' }
}
