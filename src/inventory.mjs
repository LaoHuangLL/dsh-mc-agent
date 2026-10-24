/**
 * 背包那一层（路线图第 ④ 条第七刀）。
 *
 * 用户 2026-10-08 的路线图：`src\core.mjs` 渐进拆分，顺序是"先纯函数，再实体/背包/感知，
 * 移动与挖掘最后"。前六刀搬走的都是**纯函数**；这一刀是第一次搬"读 bot 实时状态"的东西。
 *
 * 这些函数以前是 `McBot` 的私有方法（`#heldText` / `#invSnap` / `#invUsed` /
 * `#canHarvestNow` / `#toolKinds` / `#freeSlot`）和一个公开方法（`countOf`）。
 * 搬出来之后签名多了一个 `b`（mineflayer bot）—— 函数体**逐字未改**，只把
 * `this.#invSnap(b)` 换成 `invSnap(b)`。
 *
 * 三条约定（跟前面几刀一样）：
 *   ① 本模块**不 import `core.mjs`**（不许反向依赖），也**不 import 任何游戏库**：
 *      它只读传进来的 `b`。
 *   ② 只读、不改状态：不看世界、不发包、不 await。所以搬走不会动到异步流程。
 *      （⚠️ 第十九刀搬进来的四个**动作**是例外：它们发包、会 await、会改背包 —— 见下面那一段分节注释；
 *       它们仍然不 import 游戏库，实例相关的东西由 `ctx` 传进来。）
 *      （第三十二刀又加进来一个 `equipFor`（动手前换对的工具）：它要读 `self.mcPlugins`、
 *       要调实例的预算闸门 `this.#t`（由 core 的薄包装塞进 `ctx.t`），所以它收 `self`。）
 *   ③ `core.mjs` 里那些同名方法**保留**（`countOf` 是公开面，一行都不能少），
 *      它们变成薄包装或直接调这里 —— 外部调用点一行都不用改。
 *
 * ⚠️ 改这些判据时请连着 `src\core.mjs` 的调用点一起想：`heldText` 的文案会出现在
 * `mc_dig` / `mc_act` / `mc_build` 的结果里，是 AI 判断"我手里现在是什么"的唯一来源。
 */
import { sleep } from './async-util.mjs'
/* 第三十二刀：`equipFor` 要比较「手上这把 / 背包里最快那把」的挖掘耗时（`digMsFor` / `bestToolFor`）。
 * 依赖方向是 inventory → dig-speed → world-observer，不成环。 */
import { digMsFor, bestToolFor } from './dig-speed.mjs'

/** 手上那叠的短名（`dirtx18`）；空手就是 `空手` */
export function heldText (b) {
  return b?.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : '空手'
}

/**
 * 装备栏那五格 —— `bot.inventory.slots` 的 **5/6/7/8/45**（头/身/腿/脚/副手）。
 *
 * 为什么要有这一段（2026-10-13 用户报"它现在看不到自己身上的装备"）：
 * `bot.inventory.items()` 只回**背包范围**（`minecraft:inventory` 窗口的 `inventoryStart..inventoryEnd`
 * = 槽 9–44，也就是主背包 + 快捷栏）。5–8 的盔甲和 45 的副手**不在里面** —— 所以以前
 * `mc_inventory` / `mc_observe` 的"背包"里根本看不到身上穿着什么，AI 会以为自己光着，
 * 于是把已经穿在身上的头盔又做一遍。
 *
 * 名字用 `bot.getEquipmentDestSlot()` 那套（`head` / `torso` / `legs` / `feet` / `off-hand`），
 * 这样 `mc_act {mode:"equip", name, to}` 能直接拿它当 `to` 用。
 */
export const EQUIP_SLOTS = [
  [5, 'head', '头'],
  [6, 'torso', '身'],
  [7, 'legs', '腿'],
  [8, 'feet', '脚'],
  [45, 'off-hand', '副手'],
]

/** 身上穿着什么：`{ head: 'iron_helmetx1 · 耐久 120/165（73%）' | null, torso, legs, feet, 'off-hand' }` */
export function equipmentOf (b) {
  const slots = b?.inventory?.slots
  const out = {}
  for (const [i, dest] of EQUIP_SLOTS) {
    const it = Array.isArray(slots) ? slots[i] : null
    out[dest] = it ? `${it.name}x${it.count}${durSuffix(it)}` : null
  }
  return out
}

/* ───────────────────────── 耐久（2026-10-15 用户点名要的） ─────────────────────────
 *
 * 以前只能看到"我有一把 iron_pickaxe"，看不到"它只剩 3 下了"。于是 AI 会一直用一把快断的镐
 * 挖到它断掉，然后以为"这个方块挖不动"（真实案例：`mc_dig` 报"挖不动"，其实是镐断了）。
 *
 * mineflayer 的 `Item` 上：`durabilityUsed`（已用掉多少）+ `maxDurability`（上限）。
 * 工具/武器/盔甲/盾有这两个字段；方块、食物、材料没有。
 * ⚠️ `maxDurability` 为 0/undefined 时**不能**拿它当分母（`0/0` 是 `NaN`，而 `NaN <= 0.2`
 *    恒为 false ⇒ "快坏了"永远不报警 —— 一个静默失效的判据）。所以先判 `max > 0`。
 */

/** 一件东西还剩多少耐久：`{ used, max, left, pct }`；**不会磨损的东西回 `null`** */
export function durabilityOf (it) {
  if (!it) return null
  const used = Number(it.durabilityUsed)
  const max = Number(it.maxDurability)
  if (!Number.isFinite(max) || max <= 0) return null
  const u = Number.isFinite(used) ? Math.max(0, Math.min(used, max)) : 0
  const left = max - u
  return { used: u, max, left, pct: left / max }
}

/** 耐久的人话：`120/250（48%）`；不会磨损的回 `null` */
export function durText (it) {
  const d = durabilityOf(it)
  return d ? `${d.left}/${d.max}（${Math.round(d.pct * 100)}%）` : null
}

/** 拼在名字后面的短尾巴（` · 耐久 120/250`）；不会磨损的回空串 */
const durSuffix = (it) => { const s = durText(it); return s ? ` · 耐久 ${s}` : '' }

/** 低于或等于这个比例算"快坏了"（20% —— 铁镐 250 耐久 ⇒ 剩 50 下就该提醒了） */
export const DUR_LOW = 0.2
/** 低于或等于这个比例算"马上就没"（5%） */
export const DUR_CRITICAL = 0.05

/** 这件东西的告警档：`'critical'` / `'low'` / `null`（还好，或压根不会磨损） */
export function durWarnOf (it, { low = DUR_LOW, critical = DUR_CRITICAL } = {}) {
  const d = durabilityOf(it)
  if (!d) return null
  if (d.pct <= critical) return 'critical'
  if (d.pct <= low) return 'low'
  return null
}

/**
 * 背包 + 装备栏里**所有会磨损的东西**还剩多少耐久，**最危险的在最前**。
 *
 * 两处都要收：`b.inventory.items()` 只回背包那 9–44 格，**身上穿的 5/6/7/8/45 不在里面**
 * （和 `EQUIP_SLOTS` 的注释是同一个坑）—— 不收就会"穿着快碎的头盔看不见"。
 */
export function toolDurability (b, { low = DUR_LOW, critical = DUR_CRITICAL } = {}) {
  const out = []
  const push = (it, where, slot) => {
    const d = durabilityOf(it)
    if (!d) return
    out.push({
      name: it.name, count: it.count ?? 1, slot: slot ?? null, where,
      left: d.left, max: d.max, pct: Math.round(d.pct * 100) / 100,
      warn: durWarnOf(it, { low, critical }),
    })
  }
  try { for (const i of b?.inventory?.items?.() ?? []) push(i, 'bag', i.slot) } catch { /* 假 bot 没有就算了 */ }
  const slots = b?.inventory?.slots
  for (const [idx, dest] of EQUIP_SLOTS) {
    if (Array.isArray(slots) && slots[idx]) push(slots[idx], 'equipped', dest)
  }
  out.sort((a, c) => a.pct - c.pct || a.left - c.left)
  return out
}

/** 快坏的那几件拼成一行（`durabilityText` 与 `durWarnText` 共用同一份排版） */
const badDurText = (bad) => {
  const head = bad.some((i) => i.warn === 'critical') ? '🔴 马上要坏' : '⚠️ 快坏了'
  return `${head}：` + bad.map((i) =>
    `${i.name} ${i.left}/${i.max}（${Math.round(i.pct * 100)}%${i.where === 'equipped' ? '，穿在身上' : ''}）`).join('、')
}

/**
 * 上面那行的**文字版**（给 `mc_inventory` / `mc_observe` 用）：
 * - 全都好好的 ⇒ 一句"都还好，最紧的是 X"（**不报具体数字堆**，免得占地方）；
 * - 有快坏的 ⇒ 只列快坏的，`🔴 马上要坏` / `⚠️ 快坏了`，并标明是不是穿在身上；
 * - 一件会磨损的都没有 ⇒ `null`（调用方别 push 空行）。
 */
export function durabilityText (b, opts = {}) {
  const list = toolDurability(b, opts)
  if (!list.length) return null
  const bad = list.filter((i) => i.warn)
  if (!bad.length) {
    const w = list[0]
    return `耐久：${list.length} 件会磨损的东西都还好（最紧的是 ${w.name} ${w.left}/${w.max}，${Math.round(w.pct * 100)}%）`
  }
  return badDurText(bad)
}

/**
 * **只报快坏的**那一版：全好 ⇒ `null`。
 *
 * 给"会磨损工具的动作"用（`mc_dig` / `mc_act{break}`）—— 这些动作每轮都在跑，
 * 全好时也念一句"都还好"就是稳定噪声。而缺了它后果很实：镐子在 `mc_dig`
 * **执行中间**爆掉时，AI 拿到的结果和"挖得好好的"一模一样，只能靠自己
 * `mc_inventory` 去查（通常不会查）。坏的时候输出与 `durabilityText` 逐字相同。
 */
export function durWarnText (b, opts = {}) {
  const bad = toolDurability(b, opts).filter((i) => i.warn)
  return bad.length ? badDurText(bad) : null
}

/** 装备栏一行字（`头 空 · 身 铁胸甲x1 · 耐久 200/240 · 腿 空 · 脚 空 · 副手 空`） */
export function equipmentText (b) {
  const eq = equipmentOf(b)
  return EQUIP_SLOTS.map(([, dest, label]) => `${label} ${eq[dest] ?? '空'}`).join(' · ')
}

/**
 * 物品名 → 该穿在哪一格。不认名字就回 `hand`（照旧"拿到手上"）。
 *
 * 判据照 `extensions\mc_auto.mjs` 的 `ARMOR_SLOTS`（自动穿甲那套）抄，多认了 `elytra`、
 * `carved_pumpkin` 和盾/图腾（盾和 `totem_of_undying` 是副手件 —— 1.21 里副手就是
 * `off-hand`，`simple_inventory.js:19` 加的键名带连字符）。
 */
export function equipDestOf (name) {
  const n = String(name ?? '')
  if (/(_helmet|_cap)$/.test(n) || n === 'turtle_helmet' || /_skull$/.test(n) || n === 'carved_pumpkin') return 'head'
  if (/(_chestplate|_tunic)$/.test(n) || n === 'elytra') return 'torso'
  if (/(_leggings|_pants)$/.test(n)) return 'legs'
  if (/_boots$/.test(n)) return 'feet'
  if (n === 'shield' || n === 'totem_of_undying') return 'off-hand'
  return 'hand'
}

/** 背包按**名字合计**快照（走路/挖矿前后比"路上用掉了什么"） */
export function invSnap (b) {
  const m = new Map()
  try { for (const i of b.inventory?.items?.() ?? []) m.set(i.name, (m.get(i.name) ?? 0) + i.count) } catch { /* 假 bot 没有就算了 */ }
  return m
}

/** 相比快照少掉的东西（按少掉的数量降序） */
export function invUsed (b, snap) {
  if (!snap?.size) return []
  const now = invSnap(b)
  const used = []
  for (const [name, n0] of snap) {
    const n1 = now.get(name) ?? 0
    if (n1 < n0) used.push({ name, lost: n0 - n1 })
  }
  return used.sort((a, z) => z.lost - a.lost)
}

/** 手上这叠现在能不能挖这块方块（`harvestTools` = {物品id:true}；没这项 = 徒手就行） */
/** 手上这套东西**挖掉**它要多久（毫秒）。和 `canHarvestNow` 是两件事：
 *
 *  `harvestTools` 管的是**掉不掉东西**，不是**挖不挖得动**。
 *  雪块（`snow_block`）hardness 只有 0.2 —— 徒手 0.3 秒就挖开，但只有锹才掉雪球。
 *  2026-10-24 用户实机：要挖穿头顶的雪块爬出竖井，报"需要锹，背包里也没有" ⇒ 以为挖不动，
 *  结果反复超时；再想去做锹，木头又在地表、地表正被雪盖着 ⇒ 死循环。
 *
 *  所以"挖开挡路的东西"看这个函数，"收获资源"才看 `canHarvestNow`。
 *  返回 `null` = 算不出来（旧数据 / 假 bot）。
 */
export function breakMsNow (b, blk) {
  const held = b?.heldItem?.type ?? null
  try {
    const t = Number(blk?.digTime?.(held))
    if (Number.isFinite(t) && t > 0) return t
  } catch {}
  try {
    const t = Number(blk?.digTime?.(null))
    if (Number.isFinite(t) && t > 0) return t
  } catch {}
  // 退路：按硬度估（徒手约 hardness × 1500ms）
  const h = Number(blk?.hardness)
  if (Number.isFinite(h) && h >= 0) return h <= 0 ? 50 : h * 1500
  return null
}

/** 徒手/手上这套能在多久之内挖掉就算"挖得动"。3 秒 ≈ 泥土 0.75s、雪块 0.3s、沙子 0.75s；
 *  石头徒手 7.5s、深板岩 25s ⇒ 判为挖不动，别硬挖（一次调用才 10 秒，硬挖必超时）。 */
export const BREAK_OK_MS = 3_000

/** 手上这套挖得动它吗（不管掉不掉东西）。`limitMs` 可调，默认 `BREAK_OK_MS`。 */
export function canBreakNow (b, blk, limitMs = BREAK_OK_MS) {
  if (b?.game?.gameMode === 'creative') return true
  const ms = breakMsNow(b, blk)
  /* 算不出时间（旧数据 / 假 bot / 方块没有硬度）⇒ 退回老口径：**本来就能收获才放行**。
   * 反过来（一律放行）会把"石头 + 空手"也放过去，那就是白挖 7.5 秒再报个假原因。 */
  if (ms == null) return canHarvestNow(b, blk)
  return ms <= limitMs
}
export function canHarvestNow (b, blk) {
  if (b?.game?.gameMode === 'creative') return true
  const need = Object.keys(blk?.harvestTools ?? {})
  if (!need.length) return true
  return Boolean(b?.heldItem && blk.harvestTools[b.heldItem.type])
}

/** 工具档位：木/金=1、石=2、铁=3、钻石=4、下界合金=5；不是工具回 0。
 *
 * 用途只有一件事：**手上这把已经能挖，就别为了快几成换成更高级的**（2026-10-24 用户：
 * 「挖深板岩石镐 1.1 秒、铁镐 0.75 秒，慢三成；碰见钻石矿还得换回铁镐」）——
 * 铁镐该留给挖不动的矿，不该被拿去挖石头。 */
export function toolTierOf (name) {
  const n = String(name ?? '')
  if (!/_?(pickaxe|axe|shovel|hoe|sword)$/.test(n)) return 0
  if (/^netherite_/.test(n)) return 5
  if (/^diamond_/.test(n)) return 4
  if (/^iron_/.test(n)) return 3
  if (/^stone_/.test(n)) return 2
  if (/^(wooden|golden)_/.test(n)) return 1
  return 0
}
/** 挖它需要什么工具（人话：镐／斧／锹；minecraft-data 里是 pickaxe/axe/shovel 这种英文） */
export function toolKinds (b, blk) {
  const CN = { pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', shears: '剪刀', sword: '剑' }
  const kinds = [...new Set(Object.keys(blk?.harvestTools ?? {})
    .map((id) => b.registry?.items?.[id]?.name).filter(Boolean)
    .map((n) => CN[n.split('_').pop()] ?? n.split('_').pop()))]
  return kinds.length ? `需要${kinds.join('／')}` : '需要合适的工具'
}

/**
 * 背包里某样东西有几个（同名合计，含手上那叠）—— 任务恢复时的"现场状态"。
 *
 * 读不到背包（假 bot、还没连上、inventory.items 不存在）就回 `null`：
 * **别回 0** —— 0 是"背包里确实没有"，`null` 是"读不到"，任务台账要靠这个区分。
 */
export function countOf (b, name) {
  if (!b?.inventory?.items) return null
  const want = String(name ?? '').trim()
  if (!want) return null
  let n = 0
  try { for (const i of b.inventory.items()) if (i?.name === want) n += Number(i.count) || 0 } catch { return null }
  return n
}

/**
 * 背包里每样东西各有多少（`{ 物品名: 数量 }`）。
 * 任务执行器判"目标达成没"读的就是这张表（`src\task-exec.mjs` 的 `goalDone`）——
 * 现场数出来的数，不是上一步工具返回的 `ok:true`。
 * 读不到返回 `null`：空对象 `{}` 的意思是"背包确实是空的"，跟"读不到"不是一回事。
 */
export function invCounts (b) {
  if (!b?.inventory?.items) return null
  const out = {}
  try {
    for (const i of b.inventory.items()) {
      const n = String(i?.name ?? '')
      if (!n) continue
      out[n] = (out[n] ?? 0) + (Number(i.count) || 0)
    }
  } catch { return null }
  return out
}

/**
 * 选一个槽位放取来的物品。优先级：
 *   ① 已经放着**同一种**东西的槽（重复取同款不占新格，也不会覆盖别的）
 *   ② 快捷栏（36–44）的空槽
 *   ③ 主背包（9–35）的空槽 —— 🔴 2026-10-19 实机补上的：以前只扫 36–44，
 *      快捷栏 9 格一满就落到 ④，明明主背包还空着 23 格，却去**覆盖手里那件东西**。
 *   ④ 手上那格（实在 36 格全满才覆盖，且 `giveItem` 会**如实报出被顶掉的是什么**）
 * 为什么要在意：连建一面墙会反复调 placeBlock → giveItem，
 * 若每次都挑"第一个空槽"，很快就把之前取的方块覆盖掉，导致后面莫名"背包里没有 X"。
 */
export function freeSlot (b, itemName = null) {
  const slots = b.inventory?.slots ?? []
  if (itemName) {
    for (let s = 36; s <= 44; s++) {
      if (slots[s]?.name === itemName) return s
    }
    for (let s = 9; s <= 35; s++) {
      if (slots[s]?.name === itemName) return s
    }
  }
  for (let s = 36; s <= 44; s++) {
    if (!slots[s]) return s
  }
  for (let s = 9; s <= 35; s++) {
    if (!slots[s]) return s
  }
  return b.quickBarSlot != null ? 36 + b.quickBarSlot : 36
}

/* ═══════════════ 第十九刀：把"背包动作"也搬过来（读 + 动，同一个模块） ═══════════════
 *
 * 前七刀这一层只读背包；这一刀把三个**动作**也收进来：`inventoryView`（一览）、
 * `giveItem`（创造取物）、`clearInventory`（清空）、`tossItem`（丢弃）。
 *
 * 与前七刀的区别：这三个要**发包**，所以都 `await`。它们仍然不 import 任何游戏库 ——
 * 需要"这一轮还剩多少时间"和"造一个 Item"这两件实例/库相关的事，由 `core.mjs` 的
 * 薄包装打包成 `ctx` 传进来（迁移规矩第 17 条）：
 *   · `ctx.t(promise, kind, label)` —— 本轮的 11 秒闸门 + 中断（`core.mjs` 的 `#t`）
 *   · `ctx.makeItem(type, n)`       —— `new (prismarine-item)(registry)(type, n)`
 */

/**
 * 背包一览（`mc_inventory` 的正文）。
 *
 * 🔴 按**名字合计**，而且只报一次"手上"。
 * 实机教训（2026-10-07）：旧实现回 `{held, items}`，而 mineflayer 的 `inventory.items()`
 * **本来就包含手上那一格** —— 同一叠东西在输出里出现两遍，模型当场数了两遍：
 * 「held oak_planksx2 + items oak_planksx2 = 4 块木板」，于是它以为 `mc_craft` 在撒谎
 * （其实它只有 2 块，做工作台要 4 块），跑去砍树了。工具输出必须**一眼看得出总数**。
 */
export function inventoryView (b) {
  const all = b.inventory.items()
  const totals = new Map()
  for (const i of all) totals.set(i.name, (totals.get(i.name) ?? 0) + i.count)
  const items = [...totals].map(([name, count]) => ({ name, count }))
  const held = b.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : null
  /* 🔴 2026-10-23 审计复查：报告 D[9] 说这两句口径重复、可以删一处 —— **不能删**。
   *    `check-core-inventory.mjs` 是照着"必须明说别再加一遍"写的（2026-10-08 实机：AI 把
   *    手上那叠和背包合计加了两遍，以为有 4 块木头、其实只有 2 块）。留着。 */
  const lines = [held ? `手上：${held}（这一叠已经算在下面的合计里，别再加一遍）` : '手上：空']
  lines.push(items.length ? `背包（同名已合计、**含手上那叠**）：${items.map((i) => `${i.name}x${i.count}`).join('、')}` : '背包：空')
  /* 🔴 2026-10-08 第五份审计旁注：`all.length` 是**叠数**（`items()` 一叠一条、不含 0-8 那九格），
   *    写"格"会让模型以为"背包只剩 3 格空位"。改成"叠"，并补一句空位。 */
  const free = (() => { try { return b.inventory.emptySlotCount() } catch { return null } })()
  lines.push(`共 ${all.length} 叠 / ${items.length} 样${free != null ? `（背包还有 ${free} 个空位）` : ''}`)
  /* 装备栏单独一行（2026-10-13 用户要求）：这几格不在 `items()` 里，以前完全看不见。
   * 用 `mc_act {mode:"equip", name, to}` 往里穿；`to` 就是这里的 head/torso/legs/feet/off-hand。 */
  const equipment = equipmentOf(b)
  lines.push(`装备栏：${equipmentText(b)}（这几格不占背包位，穿装备用 mc_act {mode:"equip"}）`)
  /* 耐久（2026-10-15 用户点名要的）：只看"快坏的"，全都好好的就一句话带过。
   * 以前没有这一行 —— AI 会拿一把剩 3 下的镐一直挖，挖到断掉还以为"方块挖不动"。 */
  const tools = toolDurability(b)
  const durLine = durabilityText(b)
  if (durLine) lines.push(durLine)
  return { text: lines.join('\n'), held, items, equipment, tools }
}

/**
 * 创造模式直接获取物品。
 *
 * 为什么不用 /give：多数服对非 OP 关掉 /give，而**创造模式改槽位是协议级能力**
 * （`set_creative_slot` 包），服务端一般照收。所以走 `bot.creative.setInventorySlot`。
 * 这也是用户点名的缺口："连创造模式直接获取物品的方法都没有"。
 */
export async function giveItem (b, { name, count = 1, slot = null, force = false } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  if (b.game?.gameMode !== 'creative') {
    throw new Error(`取物只在创造模式可用（当前 ${b.game?.gameMode ?? '未知'}）；生存模式请挖或合成`)
  }
  const itemName = String(name ?? '').trim()
  if (!itemName) throw new Error('要给物品名（如 oak_planks / diamond_sword）')
  const type = b.registry?.itemsByName?.[itemName]
  if (!type) throw new Error(`未知物品：${itemName}（用英文 id，如 oak_planks）`)
  const n = Math.min(Math.max(Number(count) || 1, 1), type.stackSize ?? 64)
  /* 🔴 2026-10-08 第五份审计报告 M3：`slot` 的文档以前写"0-44"，但 **0-8 不是背包槽**
   *    （`prismarine-windows` 的 `minecraft:inventory` 是 `{ start: 9, end: 44 }`：
   *     0 = 合成结果槽、1-4 = 2×2 合成格、5-8 = 盔甲槽）。
   *    写 0-8 会把物品塞进合成格/盔甲槽（模型以为是"背包第 1 格"）。
   *    现在钳到 9-44，并如实告诉它被挪过。 */
  const asked = slot != null ? Number(slot) : null
  const target = asked != null && Number.isFinite(asked)
    ? Math.min(Math.max(Math.floor(asked), 9), 44)
    : freeSlot(b, itemName)

  /* 🟢 2026-10-15 审计（报告 E 第 12 条）：原来 `ctx.makeItem ? ctx.makeItem(type, n) : null`
   *   会把 **null 传给 `setInventorySlot`** —— 那不是"什么都不做"，而是**清空那一格**。
   *   缺 makeItem 时宁可如实报错，也别悄悄把玩家背包里那格的东西抹掉。 */
  if (typeof ctx.makeItem !== 'function') {
    throw new Error('创造模式取物需要 ctx.makeItem，但这次调用没给 —— 这是插件内部 bug，请报告（不要当成"取物失败"重试）')
  }
  /* 覆盖前先记住目标格原来是什么：`freeSlot` 满格兜底会落到手上那格（见 `clobber`） */
  const occBefore = b.inventory?.slots?.[target] ?? null
  /* 🔴 2026-10-19 实机（用户点名要修的 bug ⑧）：**显式给 slot** 时以前照样覆盖，
   *    只在那句 `clobber` 里事后提一句 —— 而模型常常一口气取十几种建材、看都不看回执，
   *    于是背包里原有的弓 / 钻剑 / 末影之眼就凭空没了（那天顶掉了 2 把弓、1 把钻剑、2 颗眼）。
   *    现在：显式指定一个**装着别的东西**的格子 ⇒ 直接拒绝，要顶必须 `force:true`。 */
  const explicit = asked != null && Number.isFinite(asked)
  if (explicit && occBefore && occBefore.name !== itemName && force !== true) {
    throw new Error(`第 ${target} 格已经有 ${occBefore.name}x${occBefore.count} —— 显式指定槽位会把它顶掉。`
      + '想找空位就别传 slot；确定要顶掉它就传 force:true')
  }
  const item = ctx.makeItem(type, n)
  await t(b.creative.setInventorySlot(target, item, 800), 'give', `取物 ${itemName}`)
  await sleep(120)
  const nowItem = b.inventory.slots?.[target] ?? null
  const now = nowItem ? `${nowItem.name}x${nowItem.count}` : null
  const moved = asked != null && Number.isFinite(asked) && target !== Math.floor(asked)
    ? `你要的第 ${Math.floor(asked)} 格不是背包格（背包是 9-44：0=合成结果、1-4=合成格、5-8=盔甲）—— 我放进第 ${target} 格了；`
    : ''
  /* 🔴 2026-10-19 实机：`freeSlot` 的最后一条兜底是"36 格全满就用手上那格"，
   *    而创造取物只能覆盖 ⇒ 以前**静默**顶掉那一格，还回一句"已放进快捷栏第 5 格"。
   *    实测：连着取 chest / furnace，第二次把第一次的东西原样顶没了（用户的东西凭空消失）。
   *    现在先记下原来是什么（`occBefore`），真顶掉了就照实说。 */
  const clobber = occBefore && occBefore.name !== itemName
    ? `⚠️ ${explicit ? `你指定的第 ${target} 格` : '背包 36 格都满了 —— 第 ' + target + ' 格'}原来的 **${occBefore.name}x${occBefore.count}** 被顶掉了`
      + '（创造取物只能覆盖那一格）。要留它就先用 mc_act {mode:"toss"} 丢点东西、或用 mc_chest 塞进箱子腾一格，再取物。'
    : ''
  return {
    gave: `${itemName}x${n}`, slot: target, now,
    ...(moved ? { slotAsked: Math.floor(asked) } : {}),
    ...(clobber ? { clobbered: `${occBefore.name}x${occBefore.count}` } : {}),
    /* 🔴 2026-10-08 审计：旧版**无条件**说"已放进背包/快捷栏"，即使那格还是空的。文案要跟 `now` 走。 */
    ...(now
      ? { note: clobber || (moved + (target >= 36 ? `已放进快捷栏第 ${target - 35} 格` : '已放进背包')) }
      : { note: `**没放进去**（第 ${target} 格现在还是空的）—— 服务端没认这次 setInventorySlot（失步 / 权限 / 那格被别的窗口占着）。别当成拿到了` }),
  }
}

/** 清空背包（创造模式） */
export async function clearInventory (b, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  if (b.game?.gameMode !== 'creative') throw new Error('清空背包只在创造模式可用')
  await t(b.creative.clearInventory(), 'give', '清空背包')
  /* 🔴 2026-10-08 第五份审计报告 ⑥：以前直接 `return { cleared: true }` —— 而 `giveItem`
   *    已经改成"读回槽位再说结果"。清完抽查一遍，别谎报"清空成功"。 */
  await sleep(200)
  const left = (() => { try { return b.inventory.items() } catch { return [] } })()
  if (!left.length) return { cleared: true }
  const names = [...new Set(left.map((i) => i.name))].slice(0, 6)
  return {
    cleared: false,
    left: left.length,
    names,
    note: `**没清干净** —— 背包里还剩 ${left.length} 叠（${names.join('、')}${left.length > names.length ? '…' : ''}）。`
      + '服务端可能没认这次清空（失步 / 权限 / 那几格被别的窗口占着）。别当成背包空了。',
  }
}

/** 丢弃手上的物品（`name` 给了就先换上那个） */
export async function tossItem (b, { name = null, count = 1 } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  let item = b.heldItem
  if (name) {
    const want = String(name)
    item = b.inventory.items().find((i) => i.name === want)
    if (!item) throw new Error(`背包里没有 ${want}（用 mc_inventory 看有什么）`)
    if (b.heldItem?.name !== want) await t(b.equip(item, 'hand'), 'equip', `手持 ${want}`)
  }
  if (!item) throw new Error('手上没东西可丢')
  const n = Math.min(Math.max(Number(count) || 1, 1), item.count)
  const snap = invSnap(b)
  await t(Promise.resolve(b.toss(item.type, null, n)), 'toss', `丢弃 ${item.name}`)
  /* 🔴 2026-10-08 审计：`bot.toss` 底层是 `transfer()`（clickWindow + 等窗口回包），resolve 只说明
   *    "服务端回包了" —— 到底掉出去几个要按**背包数量差**说，别把"想丢几个"当结果。 */
  const lost = (snap.get(item.name) ?? 0) - (invSnap(b).get(item.name) ?? 0)
  return {
    tossed: `${item.name}x${n}`,
    /* 🟡 2026-10-15 审计（报告 C 第 1 条）：`tossed` 永远是 `"名字xN"` 字符串（少丢时只加 `note`），
     *   所以调用方拿 `tossed !== false` 判成功是**恒真**的。这里补一个如实的结果位。 */
    ok: lost === n,
    ...(lost === n ? {} : { note: `背包里只少了 ${Math.max(0, lost)} 个（想丢 ${n} 个）—— 东西可能还在地上或没丢出去，用 mc_inventory 看一眼` }),
  }
}

/* ─────────── 第三十二刀：动手前换工具（原来 core 的私有 `#equipFor`） ─────────── */

/**
 * 动手前把对的工具拿到手上。
 *
 * 🔴 为什么必须做（2026-10-07 实机）：机器人从矿底**垫方块爬回地面后手上还攥着泥土**，
 *    接着对石头连发 6 次 `mc_act{mode:"break"}` —— 徒手挖石头要 7.5 秒，比一轮预算还长，
 *    于是每次都超时，工具还回一句"服务端可能拒了这次破坏"，模型完全看不出问题在哪，
 *    直到玩家在游戏里问「怎么用手挖方块」才反应过来。**手上工具不对 = 挖得极慢**，
 *    这件事必须由插件自己处理 + 明说，不能指望模型记得自己手里攥着什么。
 *
 * 🔴 不只"能不能挖"，还有"挖得多慢"（2026-10-08 实机反馈：玩家转来"快挖完的时候会重置"）：
 *    手上攥着**石剑**去挖原木（剑砍木头 ≈ 3 秒，石斧 ≈ 0.9 秒），一轮预算被啃掉大半，
 *    挖到八成到点松手 → **破坏进度清零**，模型看到的就是"快挖完就重置"。
 *    所以这里还会比较"换成背包里最快的工具能快多少"，快 1.4 倍以上就换。
 */
export async function equipFor (self, b, blk, label = '换工具', ctx = {}) {
  /* 🟢 2026-10-15 审计（报告 E 第 12 条）：同文件其它动作（`:229`/`:268`/`:288`）都有
   *   `const t = ctx.t ?? ((p) => p)` 兜底，只有这里直接用 `ctx.t(...)` —— 缺 ctx.t 时
   *   TypeError 会被下面那个"换不上就照旧"的 catch 吞掉，表现为"静默不换工具"。 */
  const t = ctx.t ?? ((p) => p)
  const heldBefore = heldText(b)
  const canNow = canHarvestNow(b, blk)
  const nowMs = digMsFor(b, blk, b?.heldItem?.type ?? null)
  const best = bestToolFor(b, blk)
  /* 2026-10-24 用户：「能挖就不升档」—— 手上这把已经挖得动（能掉落）、且本身就是工具时，
   * 不许为了快几成换成更高级的（铁镐挖深板岩快 47%，但那是拿耐久换速度）。
   * 空手（tier 0）例外：该换还得换，否则会徒手挖土。 */
  const heldTier = toolTierOf(b?.heldItem?.name)
  const bestTier = toolTierOf(best?.item?.name)
  const wouldUpgrade = Boolean(canNow && heldTier > 0 && bestTier > heldTier)
  const faster = Boolean(best && nowMs != null && best.ms < nowMs * 0.72
    && best.item?.name !== b?.heldItem?.name && !wouldUpgrade)
  if (canNow && !faster) return { heldBefore, held: heldBefore, changed: false }
  try {
    if (faster) {
      await t(b.equip(best.item, 'hand'), 'equip', label)
    } else if (self.mcPlugins?.tool && typeof b.tool?.equipForBlock === 'function') {
      await t(b.tool.equipForBlock(blk, { requireHarvest: false }), 'equip', label)
    } else {
      const pick = best?.item ?? (b.inventory?.items?.() ?? []).find((it) => blk?.harvestTools?.[it.type])
      if (pick && b.heldItem?.name !== pick.name) await t(b.equip(pick, 'hand'), 'equip', label)
    }
  } catch { /* 换不上就照旧：调用方按"手上还是不对"如实拒绝 */ }
  const held = heldText(b)
  return { heldBefore, held, changed: held !== heldBefore }
}
