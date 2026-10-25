/**
 * mc_drops —— 看周围掉落物（dsh-mc-agent 扩展）
 *
 * 为什么需要它（用户 2026-10-25）：「加一个工具看周围掉落物，和具体位置」。
 *
 * 以前 AI 想知道地上有什么，只能：
 *   · `mc_observe` —— 掉落物被**聚合**成一句「掉落物 12」（2026-10-23 为了不让候选清单被 item 占满
 *     而做的瘦身），看不到具体是什么、在哪儿；
 *   · `mc_inventory` —— 只报自己背包，地上的看不见；
 *   · `mc_scan` —— 扫的是**方块**，掉落物是实体，扫不到。
 * 结果：挖完一堆矿，AI 不知道地上还剩什么、值不值得走回去捡（2026-10-24 就出过「挖一个就跑一趟」）。
 *
 * 判据复用 `src/entity-names.mjs` 的 `isDropEntity()` —— 那是全仓**唯一**一份"什么算掉落物"的定义
 * （`minecraft-data` 里掉落物实体 type 是 'other'，靠 displayName 兜底会把牛当掉落物，所以别自己写）。
 *
 * 物品名/数量怎么读：
 *   · 1.9+ 掉落物实体带 `getDroppedItem()`（mineflayer 自带的便捷方法，读 metadata[8] 的 ItemStack）；
 *   · 老协议/元数据还没到时读不到 ⇒ 报「读不出是什么」，**不猜**（猜错比不报更糟）。
 *
 * 边界：只读，不动世界 ⇒ 不进门禁。
 */
import { isDropEntity } from '../src/entity-names.mjs'

export const name = 'mc_drops'

export const DROPS_R_DEFAULT = 16
export const DROPS_R_MAX = 48
export const DROPS_LIMIT_DEFAULT = 20
export const DROPS_LIMIT_MAX = 50

/** 从掉落物实体里读出物品栈（`{name, count}`）；读不到回 null —— 绝不猜 */
export function stackOfDrop (e) {
  try {
    if (typeof e?.getDroppedItem === 'function') {
      const s = e.getDroppedItem()
      if (s && s.name) return { name: String(s.name), count: Number(s.count) || 1 }
    }
  } catch {}
  try {
    const s = e?.metadata?.[8]
    if (s && typeof s === 'object' && s.name) return { name: String(s.name), count: Number(s.count) || 1 }
  } catch {}
  return null
}

/** 方位（相对我）：先南北后东西，8 向里取整成 4 向 + 斜 */
export function bearingOf (dx, dz) {
  const ax = Math.abs(dx)
  const az = Math.abs(dz)
  if (ax < 0.7 && az < 0.7) return '脚下'
  const ns = az >= 0.7 ? (dz > 0 ? '南' : '北') : ''
  const ew = ax >= 0.7 ? (dx > 0 ? '东' : '西') : ''
  return (ns + ew) || '附近'
}

/** 单个掉落物 → 记录（位置取整到方块坐标，距离保留 1 位小数） */
export function dropInfo (b, e) {
  const p = e?.position
  if (!p) return null
  const me = b?.entity?.position ?? null
  const st = stackOfDrop(e)
  const d = me ? p.distanceTo(me) : null
  const dx = me ? p.x - me.x : 0
  const dz = me ? p.z - me.z : 0
  return {
    id: e.id,
    name: st ? st.name : null,
    count: st ? st.count : 1,
    x: Math.floor(p.x),
    y: Math.floor(p.y),
    z: Math.floor(p.z),
    dist: d === null ? null : Math.round(d * 10) / 10,
    dy: me ? Math.round((p.y - me.y) * 10) / 10 : null,
    bearing: me ? bearingOf(dx, dz) : null,
  }
}

/**
 * 列出周围掉落物。
 * @returns {{radius:number,total:number,items:number,drops:object[],more:number,agg:object[]}}
 */
export function listDrops (b, { radius = DROPS_R_DEFAULT, name: wantName = null, limit = DROPS_LIMIT_DEFAULT } = {}) {
  const R = Math.min(Math.max(Number(radius) || DROPS_R_DEFAULT, 1), DROPS_R_MAX)
  const lim = Math.min(Math.max(Number(limit) || DROPS_LIMIT_DEFAULT, 1), DROPS_LIMIT_MAX)
  const want = wantName ? String(wantName).toLowerCase().replace(/\s+/g, '_') : null
  const all = []
  for (const e of Object.values(b?.entities ?? {})) {
    if (!isDropEntity(e)) continue
    const info = dropInfo(b, e)
    if (!info) continue
    if (info.dist !== null && info.dist > R) continue
    if (want && !String(info.name ?? '').includes(want)) continue
    all.push(info)
  }
  all.sort((a, c) => (a.dist ?? 1e9) - (c.dist ?? 1e9))
  const aggMap = new Map()
  for (const x of all) {
    const k = x.name ?? '(读不出)'
    aggMap.set(k, (aggMap.get(k) ?? 0) + x.count)
  }
  const agg = [...aggMap.entries()]
    .map(([n, c]) => ({ name: n, count: c }))
    .sort((a, c) => c.count - a.count)
  return {
    radius: R,
    total: all.length,
    items: all.reduce((s, x) => s + x.count, 0),
    drops: all.slice(0, lim),
    more: Math.max(0, all.length - lim),
    agg,
  }
}

/** 渲染成给模型看的一段话 */
export function dropsText (b, r) {
  if (!r || r.total === 0) {
    return `📦 周围 ${r?.radius ?? DROPS_R_DEFAULT} 格内没有掉落物（地上干净）`
  }
  const lines = [`📦 周围 ${r.radius} 格内掉落物 **${r.total} 个**（共 ${r.items} 件）`]
  for (const x of r.drops) {
    const nm = x.name ? `${x.name}×${x.count}` : '读不出是什么'
    const pos = `(${x.x}, ${x.y}, ${x.z})`
    const bits = [`距 ${x.dist} 格`]
    if (x.bearing && x.bearing !== '脚下') bits.push(x.bearing)
    if (x.dy !== null && x.dy !== 0) bits.push(x.dy > 0 ? `高 ${x.dy} 格` : `低 ${-x.dy} 格`)
    lines.push(`  · ${nm} · ${pos} · ${bits.join(' · ')}`)
  }
  if (r.more > 0) lines.push(`  （还有 ${r.more} 个没列出来 —— 想全看就 `+"`limit`"+` 放宽）`)
  const top = r.agg.slice(0, 6).map((a) => `${a.name}×${a.count}`).join('、')
  if (top) lines.push(`　按物品合起来：${top}${r.agg.length > 6 ? ' …' : ''}`)
  lines.push('　→ 走到 1.5 格内会自动吸进去；要捡就说走哪一格（`mc_move` 到那个坐标）')
  return lines.join('\n')
}

export async function apply (api) {
  const { ctx, asTool, getSession, logLine } = api

  ctx.tools.register(asTool({
    name: 'mc_drops',
    description: '📦 **看周围掉落物**（地上的物品实体，不是背包）。挖完矿、打完怪、箱子被炸之后，看地上还剩什么、在哪儿、值不值得走过去捡。\n'
      + '· 每个都报：物品名×数量 · 方块坐标 (x,y,z) · 距我几格 · 方位（东南/西北…）· 比我高还是低。\n'
      + '· 读不出是什么的（刚生成/旧协议）**如实说「读不出」**，不猜。\n'
      + '· 按**最近的排前面**；末尾给一份按物品汇总（`cobblestone×12、coal×4`）。\n'
      + '· `name` 只看某一种（`coal`）；`radius` 默认 16、最大 48；`limit` 默认 20、最大 50。\n'
      + '· 只读不动世界：走到 1.5 格内会自动吸，要捡用 `mc_move` 走到那个坐标。',
    parameters: {
      radius: { type: 'number', description: '看多大范围（默认 16，最大 48）' },
      name: { type: 'string', description: '只看某一种物品，如 coal / iron_ingot（可选，支持部分匹配）' },
      limit: { type: 'number', description: '最多列几个（默认 20，最大 50）' },
    },
    /* 🔴 内置 defineTool 要求 output.schema 必须在（不给就抛「schema 必须是对象」⇒ 注册失败、工具压根不存在）。
     *    2026-10-25 踩过：mc_drops 初版漏了这块，工具在宿主里静默消失（selfcheck 的 deny 断言先红了才发现）。 */
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }],
    },
    /* 🔴 2026-10-25 实机：写成 `getSession()` ⇒ 每调必报「拿不到当前会话（exec.agent 不可用）」。
     *    `getSession` 要的是**这次调用的 exec**（agent 在 exec.agent 上），别的扩展都是 `execute(args, exec)`。 */
    async execute (args = {}, exec) {
      const sess = getSession(exec)
      /* 🔴 2026-10-25 实机第二处：`sess.bot` 是 **McBot**（包装层），`entities`/`entity` 在它包着的
       *    真 mineflayer bot 上。直接读 `sess.bot.entities` 会永远是空 ⇒ 恒报「还没进服」。 */
      let bot
      try { bot = sess.bot.requireBot() } catch { return { text: '📦 还没进服，看不到掉落物（先 `mc_connect`）' } }
      if (!bot?.entity) return { text: '📦 还没进服，看不到掉落物（先 `mc_connect`）' }
      const r = listDrops(bot, { radius: args.radius, name: args.name, limit: args.limit })
      logLine(`mc_drops：${r.radius} 格内 ${r.total} 个`)
      return { text: dropsText(bot, r) }
    },
  }))

  logLine('mc_drops 已加载：工具 mc_drops（周围掉落物 + 坐标 + 距离 + 方位）')
}
