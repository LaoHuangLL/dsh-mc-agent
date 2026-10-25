#!/usr/bin/env node
/**
 * mc_drops 自检 —— `extensions/mc_drops.mjs`（周围掉落物 + 具体位置）
 *
 * 用户 2026-10-25：「加一个工具看周围掉落物，和具体位置」。
 *
 * 这一套钉死六件事：
 *   ① 判据只认 `isDropEntity()` —— 僵尸/船/盔甲架**不能**被当成掉落物；
 *   ② 物品名与数量读 `getDroppedItem()`，退路是 `metadata[8]`；两样都读不到 ⇒ `null`，**不猜**；
 *   ③ 半径/名字过滤、按距离排序、`limit` 截断 + `more` 计数；
 *   ④ 按物品汇总（`agg`）；
 *   ⑤ 文案：没有掉落物要说「地上干净」，读不出的要写「读不出是什么」；
 *   ⑥ 工具定义接线（name / 三个参数 / 只读不门禁）。
 *
 * 用法：node tools/check-mc-drops.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'

const {
  name, DROPS_R_DEFAULT, DROPS_R_MAX, DROPS_LIMIT_DEFAULT, DROPS_LIMIT_MAX,
  stackOfDrop, bearingOf, dropInfo, listDrops, dropsText,
} = await import(new URL('../extensions/mc_drops.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/* 假世界：位置对象只需要 distanceTo / x / y / z */
const P = (x, y, z) => ({
  x, y, z,
  distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) },
})

function mkBot (list, at = P(0.5, 64, 0.5)) {
  const entities = {}
  for (const e of list) entities[e.id] = e
  return { entity: { position: at }, entities }
}

const item = (id, stack, x, y, z) => ({
  id, name: 'item', displayName: 'Item', position: P(x, y, z),
  getDroppedItem: () => stack,
})
const itemRaw = (id, meta8, x, y, z) => ({
  id, name: 'item', displayName: 'Item', position: P(x, y, z), metadata: { 8: meta8 },
})
const noStack = (id, x, y, z) => ({ id, name: 'item', displayName: 'Item', position: P(x, y, z) })

/* ── ① 物品栈读取 ── */
section('① 物品栈：getDroppedItem → metadata[8] → null（不猜）')
{
  ok(stackOfDrop(item(1, { name: 'coal', count: 4 }, 0, 64, 0))?.name === 'coal', 'getDroppedItem() 能读到')
  ok(stackOfDrop(item(1, { name: 'coal', count: 4 }, 0, 64, 0))?.count === 4, '数量也对')
  ok(stackOfDrop(itemRaw(2, { name: 'iron_ore', count: 2 }, 0, 64, 0))?.name === 'iron_ore', 'metadata[8] 退路能读到')
  ok(stackOfDrop(noStack(3, 0, 64, 0)) === null, '两样都没有 ⇒ null（不猜）')
  ok(stackOfDrop(item(4, { count: 3 }, 0, 64, 0)) === null, '有 count 没 name ⇒ 也算读不到')
  ok(stackOfDrop(null) === null && stackOfDrop({}) === null, '空实体不抛错')
}

/* ── ② 方位 ── */
section('② 方位：南北东西 + 脚下')
{
  ok(bearingOf(0, 5) === '南', 'z+ ⇒ 南')
  ok(bearingOf(0, -5) === '北', 'z- ⇒ 北')
  ok(bearingOf(5, 0) === '东', 'x+ ⇒ 东')
  ok(bearingOf(-5, 0) === '西', 'x- ⇒ 西')
  ok(bearingOf(4, 4) === '南东', '斜着 ⇒ 南东')
  ok(bearingOf(0.2, 0.2) === '脚下', '几乎同一格 ⇒ 脚下')
}

/* ── ③ 判据：只认掉落物 ── */
section('③ 判据：僵尸 / 船 / 盔甲架不算掉落物')
{
  const bot = mkBot([
    item(1, { name: 'coal', count: 1 }, 2, 64, 0),
    { id: 2, name: 'zombie', displayName: 'Zombie', position: P(3, 64, 0) },
    { id: 3, name: 'boat', displayName: 'Boat', position: P(4, 64, 0) },
    { id: 4, name: 'armor_stand', displayName: 'Armor Stand', position: P(5, 64, 0) },
  ])
  const r = listDrops(bot)
  ok(r.total === 1 && r.drops[0].name === 'coal', '只留下真正的掉落物', JSON.stringify(r.drops))
}

/* ── ④ 半径 / 名字 / 排序 / limit ── */
section('④ 半径过滤、名字过滤、按距离排序、limit + more')
{
  const bot = mkBot([
    item(1, { name: 'cobblestone', count: 3 }, 10, 64, 0),   // 距 9.5
    item(2, { name: 'coal', count: 2 }, 1, 64, 0),           // 距 0.5
    item(3, { name: 'cobblestone', count: 1 }, 30, 64, 0),   // 距 29.5（超默认 16）
    noStack(4, 0, 64, 3),                                    // 距 2.5，读不出
  ])
  const r = listDrops(bot)
  ok(r.radius === DROPS_R_DEFAULT && DROPS_R_DEFAULT === 16, '默认半径 16')
  ok(r.total === 3, '超过 16 格的那个被过滤掉', String(r.total))
  ok(r.drops[0].name === 'coal', '最近的排最前（coal 0.5 格）', JSON.stringify(r.drops.map((x) => x.name)))
  ok(r.drops[1].name === null, '读不出的排在第二（2.5 格），name 是 null', JSON.stringify(r.drops[1]))
  ok(r.drops[2].name === 'cobblestone', '远的排最后')

  const r2 = listDrops(bot, { radius: 40 })
  ok(r2.total === 4, '半径放到 40 ⇒ 四个都在', String(r2.total))
  ok(r2.radius === 40, '半径原样回显')

  const r3 = listDrops(bot, { radius: 999 })
  ok(r3.radius === DROPS_R_MAX && DROPS_R_MAX === 48, '半径上限 48')

  const r4 = listDrops(bot, { name: 'cobble', radius: 40 })
  ok(r4.total === 2, '名字部分匹配（cobble ⇒ cobblestone 两个）', String(r4.total))

  const r5 = listDrops(bot, { limit: 1 })
  ok(r5.drops.length === 1 && r5.more === 2, 'limit:1 ⇒ 只列 1 个、more 说还有 2', JSON.stringify({ n: r5.drops.length, more: r5.more }))
  const r6 = listDrops(bot, { limit: 999 })
  ok(r6.drops.length <= DROPS_LIMIT_MAX && DROPS_LIMIT_MAX === 50, 'limit 上限 50')
}

/* ── ⑤ 汇总 ── */
section('⑤ 按物品汇总（agg）')
{
  const bot = mkBot([
    item(1, { name: 'cobblestone', count: 3 }, 1, 64, 0),
    item(2, { name: 'cobblestone', count: 2 }, 2, 64, 0),
    item(3, { name: 'coal', count: 5 }, 3, 64, 0),
    noStack(4, 4, 64, 0),
  ])
  const r = listDrops(bot)
  ok(r.items === 11, '总件数 = 3+2+5+1', String(r.items))
  ok(r.agg[0].count === 5 && r.agg[1].count === 5, '按数量降序：两个都是 5 件，排在最前', JSON.stringify(r.agg))
  ok(r.agg.find((a) => a.name === 'cobblestone')?.count === 5, 'cobblestone 合起来 5')
  ok(r.agg.some((a) => a.name === '(读不出)'), '读不出的单独归一组')
}

/* ── ⑥ 文案 ── */
section('⑥ 文案：地上干净 / 具体位置 / 读不出')
{
  const empty = dropsText(mkBot([]), listDrops(mkBot([])))
  ok(/没有掉落物/.test(empty) && /地上干净/.test(empty), '没有掉落物 ⇒ 说地上干净', empty)

  const bot = mkBot([
    item(1, { name: 'coal', count: 2 }, 3, 62, 0),
    noStack(2, -2, 64, 0),
  ])
  const t = dropsText(bot, listDrops(bot))
  ok(/coal×2/.test(t), '写出「物品×数量」', t)
  ok(/\(3, 62, 0\)/.test(t), '写出方块坐标 (x, y, z)', t)
  ok(/距 3\.2 格/.test(t), '写出距离', t)
  ok(/低 2 格/.test(t), '写出高/低几格', t)
  ok(/读不出是什么/.test(t), '读不出的如实说', t)
  ok(/按物品合起来/.test(t), '末尾给汇总', t)
}

/* ── ⑦ 接线 ── */
section('⑦ 工具定义接线')
{
  ok(name === 'mc_drops', '扩展名是 mc_drops')
  const src = read('../extensions/mc_drops.mjs')
  ok(/name: 'mc_drops'/.test(src), '注册的工具名是 mc_drops')
  ok(/radius: \{ type: 'number'/.test(src) && /name: \{ type: 'string'/.test(src) && /limit: \{ type: 'number'/.test(src), '三个参数都在')
  ok(!/DEFAULT_GATED/.test(src), '只读工具：不进 mc_observe 门禁')
  ok(/isDropEntity/.test(src), '判据复用 isDropEntity（不自己写一份）')
  /* 🔴 2026-10-25 实机：`getSession()` 少传 exec ⇒ 每调必报「拿不到当前会话（exec.agent 不可用）」。 */
  ok(/async execute \(args = \{\}, exec\)/.test(src) && /getSession\(exec\)/.test(src),
    '🔴 execute 收 exec 并传给 getSession（少传就每调必报「拿不到当前会话」）')
  ok(/sess\.bot\.requireBot\(\)/.test(src),
    '🔴 拿真 mineflayer bot 用 requireBot()（McBot 上没有 entities/entity，直读恒为空）')
  /* 🔴 2026-10-25 真 bug：mc_drops 初版漏了 `output.schema` ⇒ 内置 defineTool 抛
   *    「schema 必须是对象」⇒ 工具在宿主里**静默消失**（注册失败只写一行日志，模型根本看不到它）。
   *    这条把「每个扩展工具都必须带 output」钉住，新加扩展漏了会当场红。 */
  {
    const dir = new URL('../extensions/', import.meta.url)
    const bad = readdirSync(dir).filter((f) => f.endsWith('.mjs')).filter((f) => {
      const t = read(`../extensions/${f}`)
      return /asTool\(\{/.test(t) && !/output:\s*\{/.test(t)
    })
    ok(bad.length === 0, '每个扩展工具都带 output.schema（缺了注册会静默失败）', bad.join(','))
  }
}

/* ── ⑨ 接线（2026-10-25 实机两个 bug 都出在这一层） ── */
section('⑨ 接线：execute(args, exec) → getSession(exec) → requireBot()')
{
  const { apply } = await import('../extensions/mc_drops.mjs')
  const mkApi = (getSession) => {
    const box = { spec: null }
    const api = {
      ctx: { tools: { register: (d) => { box.spec = d; return () => {} } } },
      asTool: (s) => s,
      getSession,
      logLine: () => {},
    }
    return { api, box }
  }
  const drops = mkBot([item(1, { name: 'cobblestone', count: 12 }, 2, 64, 0)])
  let gotExec = null
  const { api, box } = mkApi((exec) => { gotExec = exec; return { bot: { requireBot: () => drops } } })
  await apply(api)
  ok(box.spec?.name === 'mc_drops', 'apply 注册了 mc_drops')
  const fakeExec = { agent: { id: 'sess-x' } }
  const out = await box.spec.execute({}, fakeExec)
  ok(gotExec === fakeExec, '🔴 getSession 收到的是这次调用的 exec（少传就报「拿不到当前会话（exec.agent 不可用）」）')
  ok(/cobblestone/.test(String(out?.text ?? '')), 'execute 真读到掉落物（说明拿的是真 bot 的 entities，不是 McBot 包装层）', String(out?.text ?? '').slice(0, 80))
  // 没进服：requireBot() 抛 ⇒ 软提示，不炸
  const { api: api2, box: box2 } = mkApi(() => ({ bot: { requireBot: () => { throw new Error('还没连接') } } }))
  await apply(api2)
  const out2 = await box2.spec.execute({}, {})
  ok(/还没进服/.test(String(out2?.text ?? '')), '没进服时给软提示（不抛错）', String(out2?.text ?? '').slice(0, 60))
}

console.log(`\ncheck-mc-drops：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
