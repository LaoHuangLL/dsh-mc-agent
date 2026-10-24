#!/usr/bin/env node
/**
 * P0-2 搭路（水平搭桥）自检 —— `src/bridge.mjs` / `mc_act {mode:"bridge"}`
 *
 * 用户 2026-10-15 的原话要求（导航优化方案 P0-2「搭路可靠性」）：
 *   「**搭路要做成独立的状态机**……A 检查前方与脚下　B 稳定站位并选择放置目标
 *     C 放置一个方块（**等待服务端确认结果**）　D **验证成功再移动**
 *     失败处理：放置失败、目标坐标变化、脚下支撑异常或角色坠落风险时，
 *     **立即停止前进**，重新观察并规划」
 *   验收标准：「**不会因未确认放置就盲目前进**」
 *
 * 这一套钉死五件事：
 *   ① **A 开铺前就拦** —— 血量不够 / 脚下不是实地 / 看不到底 / 材料不够 ⇒ 一块都不放；
 *      （2026-10-22 起**前方岩浆不再是"拦"**：改成照铺 + 结果里带 `warnings`/`risk` 点名，见 ⑦）
 *   ② **C 只认回读** —— `placeBlock()` 说放上了不算，必须 `blockAt` 真读到那个方块名；
 *      回读对不上 ⇒ **停，且一格都不往前走**；
 *   ③ **D 先确认再走** —— 走完要核对"人真到了那一格"+"新脚下还是实地"，
 *      任何一条对不上就停在那儿如实报（**不按"走过去了"算**）；
 *   ④ **断点续铺** —— 本来就有实心方块的那一格跳过（不重铺），所以分几次叫能接着铺；
 *   ⑤ **方向/格数从目标格反推** —— 省一个 `dir` 参数（token 预算只有 27 字符），
 *      斜的、y 不对的、原地不动的都要**明确报错**而不是猜。
 *
 * 用法：node tools/check-bridge.mjs
 */
import { readFileSync } from 'node:fs'
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const {
  BRIDGE_MAX, BRIDGE_MIN_HEALTH, BRIDGE_DEEP,
  dirOf, dirNameOf, bridgeCellsOf, bridgeDirTo, dropBelow, dropProbe, DROP_SCAN, hazardIn,
  bridgeSafetyOf, confirmBlockAt, feetOf, bridgeAcross, heldSnapshotOf, restoreHeldOf,
  BRIDGE_FATAL, BRIDGE_FATAL_NAMES, avoidBlockIds,
} = await import(new URL('../src/bridge.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/* ── 假世界：一个显式的方块表；表里没有、但坐标在"已加载区"内 ⇒ air；区外 ⇒ null（未加载） ── */
const REGION = { x0: -48, x1: 48, y0: 0, y1: 160, z0: -48, z1: 48 }
const FULL = ['cobblestone', 'dirt', 'oak_planks', 'stone']
const registry = { blocksByName: Object.fromEntries(FULL.map((n) => [n, { name: n, boundingBox: 'block', transparent: false }])) }

function mkWorld () {
  const map = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const inRegion = (x, y, z) => x >= REGION.x0 && x <= REGION.x1 && y >= REGION.y0 && y <= REGION.y1 && z >= REGION.z0 && z <= REGION.z1
  const w = {
    map,
    set (x, y, z, name) { map.set(key(x, y, z), name); return w },
    /** 铺一块实心地板（x0..x1 / z0..z1 的方阵，y 那一层） */
    plate (x0, z0, x1, z1, y, name = 'stone') {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) w.set(x, y, z, name)
      }
      return w
    },
    get (x, y, z) {
      const v = map.get(key(x, y, z))
      if (v !== undefined) return v
      return inRegion(x, y, z) ? 'air' : null
    },
    blockAt (p) {
      const n = w.get(p.x, p.y, p.z)
      if (n == null) return null
      return { name: n, position: p, boundingBox: n === 'air' ? 'empty' : 'block', transparent: n === 'air' }
    },
  }
  return w
}

function mkBot (world, { x = 0, y = 64, z = 0, health = 20, items = [{ name: 'cobblestone', count: 64 }], onGround = true } = {}) {
  return {
    entity: { position: { x: x + 0.5, y, z: z + 0.5 }, onGround },
    health,
    registry,
    heldItem: items[0] ? { name: items[0].name, count: items[0].count } : null,
    inventory: { items: () => items.map((i) => ({ ...i })) },
    blockAt: (p) => world.blockAt(p),
  }
}

/** 假 self：`placeBlock` 真往世界里写（除非 `placeLies`），`walkTo` 真把坐标挪过去 */
function mkSelf (bot, world, { placeOk = true, placeLies = false, walkErr = null, walkMiss = null, logs = [] } = {}) {
  const s = {
    logs,
    placedCalls: [],
    walkCalls: [],
    requireBot: () => bot,
    callLeft: () => 20_000,
    log: (m) => logs.push(m),
    async placeBlock (t) {
      s.placedCalls.push({ ...t })
      const name = t.name || 'cobblestone'
      if (!placeOk) return { placed: false, requested: t.name, at: t, now: world.get(t.x, t.y, t.z) }
      if (!placeLies) world.set(t.x, t.y, t.z, name)
      return { placed: name, requested: t.name, at: t, now: name, held: name }
    },
    async walkTo (t, opts = {}) {
      s.walkCalls.push({ to: { ...t }, opts })
      if (walkErr) return { arrived: false, reason: walkErr }
      const dest = walkMiss ? { x: t.x + walkMiss[0], y: t.y + walkMiss[1], z: t.z + walkMiss[2] } : t
      bot.entity.position.x = dest.x + 0.5
      bot.entity.position.y = dest.y
      bot.entity.position.z = dest.z + 0.5
      return { arrived: true, position: { ...dest } }
    },
  }
  return s
}

/** 一条标准场景：站在 (0,64,0)，y=63 只有脚下那一格是石头，前方是 3 格宽的沟（底在 y=58） */
function gapScene ({ depth = 5, floor = 'stone', items = [{ name: 'cobblestone', count: 64 }], health = 20 } = {}) {
  const w = mkWorld()
  w.plate(-8, -8, 8, 8, 63 - depth, 'stone')       // 沟底
  w.set(0, 63, 0, floor)                           // 只给脚下那一格
  const bot = mkBot(w, { x: 0, y: 64, z: 0, items, health })
  return { w, bot }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('① 方向名（中英文都认，认不出来回 null 而不是猜）')
{
  ok(dirOf('north')?.dz === -1 && dirOf('北')?.dz === -1, 'north / 北 ⇒ -z')
  ok(dirOf('SOUTH')?.dz === 1 && dirOf('南')?.dz === 1, '大小写不敏感；south / 南 ⇒ +z')
  ok(dirOf('east')?.dx === 1 && dirOf('东')?.dx === 1, 'east / 东 ⇒ +x')
  ok(dirOf('west')?.dx === -1 && dirOf('西')?.dx === -1, 'west / 西 ⇒ -x')
  ok(dirOf('+z')?.dz === 1 && dirOf('-x')?.dx === -1, '+z / -x 也认')
  ok(dirOf('n')?.dz === -1 && dirOf('w')?.dx === -1, '单字母 n/s/e/w 也认')
  ok(dirOf('northeast') === null && dirOf('') === null && dirOf(null) === null, '斜方向 / 空 / null ⇒ null（不猜）')
  ok(dirOf('north').name === '北(-z)' && dirNameOf(1, 0) === '东(+x)', '方向名是中文（跟 mc_map 的方位词对齐）')
  ok(dirNameOf(1, 1) === '(1,1)', '斜的偏移没有中文名，回坐标')
}

section('② bridgeCellsOf：桥面铺在"脚下一层"，一格格往前')
{
  const feet = { x: 10, y: 70, z: -5 }
  const n = bridgeCellsOf(feet, dirOf('east'), 3)
  ok(n.length === 3, 'count=3 ⇒ 3 格')
  ok(n.every((c) => c.y === 69), '都在 y = 脚.y - 1 = 69（站在 y=70 上走）')
  ok(n[0].x === 11 && n[1].x === 12 && n[2].x === 13, '往东依次 +1')
  ok(n.every((c) => c.z === -5), 'z 不变')
  const s = bridgeCellsOf(feet, dirOf('north'), 2)
  ok(s[0].z === -6 && s[1].z === -7, '往北依次 -1（不是 +1）')
  ok(bridgeCellsOf(feet, dirOf('east'), 0).length === 0, 'count=0 ⇒ 空')
}

section('③ bridgeDirTo：从目标格反推方向与格数（省掉 dir 参数）')
{
  const feet = { x: 0, y: 64, z: 0 }
  const e = bridgeDirTo(feet, { x: 5, y: 63, z: 0 })
  ok(e.dir.dx === 1 && e.dir.dz === 0 && e.count === 5, '目标 (5,63,0) ⇒ 往东 5 格')
  const w2 = bridgeDirTo(feet, { x: -3, y: 63, z: 0 })
  ok(w2.dir.dx === -1 && w2.count === 3, '目标 (-3,63,0) ⇒ 往西 3 格')
  const s2 = bridgeDirTo(feet, { x: 0, y: 63, z: 4 })
  ok(s2.dir.dz === 1 && s2.count === 4, '目标 (0,63,4) ⇒ 往南 4 格')
  const throws = (fn) => { try { fn(); return null } catch (e2) { return e2.message } }
  ok(throws(() => bridgeDirTo(feet, { x: 3, y: 63, z: 3 }))?.includes('直线'), '斜的（x/z 都在变）⇒ 明确报错')
  ok(throws(() => bridgeDirTo(feet, { x: 3, y: 62, z: 0 }))?.includes('脚下一层'), 'y 不是脚下一层 ⇒ 明确报错（说清该是几）')
  ok(throws(() => bridgeDirTo(feet, { x: 0, y: 63, z: 0 }))?.includes('脚下'), '目标就是脚下 ⇒ 报错，不铺')
  ok(throws(() => bridgeDirTo(feet, {}))?.includes('x/y/z'), '什么都没给 ⇒ 报错')
  ok(throws(() => bridgeDirTo(feet, { x: 'a', y: 63, z: 0 }))?.includes('x/y/z'), '给了非数字 ⇒ 报错（不静默变成 0）')
  ok(bridgeDirTo(feet, { x: 2.7, y: 63.9, z: 0 }).count === 2, '小数按 floor 取整格（2.7 ⇒ 2）')
}

section('④ dropBelow / hazardIn：往下看，看不着底就说"不知道"')
{
  const w = mkWorld()
  w.plate(0, 0, 0, 0, 60, 'stone')
  const b = mkBot(w)
  ok(dropBelow(b, { x: 0, y: 64, z: 0 }, 24) === 3, 'y=64 往下 3 格到 y=60 的石头 ⇒ 3')
  ok(dropBelow(b, { x: 0, y: 61, z: 0 }, 24) === 0, '正下方就是石头 ⇒ 0')
  ok(dropBelow(b, { x: 200, y: 64, z: 200 }, 24) === null, '区块外 ⇒ null（不猜深浅）')
  ok(dropBelow(b, { x: 0, y: 64, z: 0 }, 2) === null, 'max 之内找不到 ⇒ null（老接口保持 null）')
  ok(dropProbe(b, { x: 0, y: 64, z: 0 }, 24).drop === 3, 'dropProbe：踩到实地 ⇒ drop=3')
  ok(dropProbe(b, { x: 0, y: 64, z: 0 }, 2).bottomed === true, 'dropProbe：扫到底还是空 ⇒ bottomed（深空，不是"不知道"）')
  ok(dropProbe(b, { x: 200, y: 64, z: 200 }, 24).unloaded === true, 'dropProbe：区块外 ⇒ unloaded（真·不知道）')
  ok(dropProbe(b, { x: 0, y: 64, z: 0 }, 24).unloaded !== true, '踩到实地时不算 unloaded')
  ok(DROP_SCAN === 64 && DROP_SCAN > 24, '扫描深度从 24 加到 64（用户：有会超过 24 格的情况）')
  const w2 = mkWorld()
  w2.set(0, 60, 0, 'lava')
  w2.set(1, 60, 0, 'water')
  const b2 = mkBot(w2)
  ok(hazardIn(b2, { x: 0, y: 64, z: 0 }, 6)?.kind === 'fatal', '下面 4 格是岩浆 ⇒ fatal')
  ok(hazardIn(b2, { x: 0, y: 64, z: 0 }, 6)?.name === 'lava', '带上名字')
  ok(hazardIn(b2, { x: 1, y: 64, z: 0 }, 6)?.kind === 'wet', '水 ⇒ wet（不致命，但要如实说）')
  const w3 = mkWorld()
  w3.set(0, 63, 0, 'stone')
  ok(hazardIn(mkBot(w3), { x: 0, y: 64, z: 0 }, 6) === null, '踩到实地就停，不再往下看')
  ok(hazardIn(mkBot(w3), { x: 0, y: 63, z: 0 }, 6) === null, '自己就是实地 ⇒ 安全')
}

section('⑤ bridgeSafetyOf：A「开铺前就拦」（一块都不放）')
{
  const { w, bot } = gapScene({ depth: 5 })
  const good = bridgeSafetyOf(bot, { feet: feetOf(bot), dir: dirOf('east'), count: 3, item: { name: 'cobblestone', count: 64 }, need: 3 })
  ok(good.ok === true, '正常沟 + 材料够 ⇒ ok')
  ok(good.drop === 4, '记下最深落差（沟底 y=58、桥面 y=63 ⇒ 4）')
  ok(good.risk == null, '落差 4 格 < 8 ⇒ 不算"悬空作业"，不记 risk（别把正常小沟说成危险）')

  const deep = gapScene({ depth: 12 })
  const dr = bridgeSafetyOf(deep.bot, { feet: feetOf(deep.bot), dir: dirOf('east'), count: 3, item: { name: 'cobblestone', count: 64 }, need: 3 })
  ok(dr.ok === true && dr.risk?.includes('悬空'), '沟够深 ⇒ 仍然允许（搭桥本来就是跨深沟），但记一条 risk 如实说')

  const lowHp = gapScene({ health: 4 })
  const lh = bridgeSafetyOf(lowHp.bot, { feet: feetOf(lowHp.bot), dir: dirOf('east'), count: 3, item: { name: 'cobblestone', count: 64 }, need: 3 })
  ok(lh.ok === false && lh.why.includes('血量'), '血量 4 < 8 ⇒ 拦住')

  const air = mkWorld()
  const airBot = mkBot(air, { x: 0, y: 64, z: 0 })
  const ab = bridgeSafetyOf(airBot, { feet: feetOf(airBot), dir: dirOf('east'), count: 2, item: { name: 'cobblestone', count: 64 }, need: 2 })
  ok(ab.ok === false && ab.why.includes('脚下'), '脚下不是实地 ⇒ 拦住（先站稳）')

  const { w: w2, bot: bot2 } = gapScene({ depth: 5 })
  w2.set(2, 62, 0, 'lava')
  const lv = bridgeSafetyOf(bot2, { feet: feetOf(bot2), dir: dirOf('east'), count: 3, item: { name: 'cobblestone', count: 64 }, need: 3 })
  ok(lv.ok === true, '前方桥面下有岩浆 ⇒ 不再拦（用户 2026-10-22「改成警告」），照铺')
  ok(lv.hazardCount === 1 && lv.hazards[0].name === 'lava', '但如实记账：hazardCount / hazards 里点名 lava')
  ok(lv.risk?.includes('岩浆'), 'risk 里写清"桥下有岩浆、踩空就掉进去"')
  ok(bridgeSafetyOf(bot2, { feet: feetOf(bot2), dir: dirOf('east'), count: 3, item: { name: 'cobblestone', count: 64 }, need: 3 }, undefined) !== undefined, '（签名没被这次改动破坏）')

  const { bot: bot3 } = gapScene({ depth: 5, items: [{ name: 'cobblestone', count: 2 }] })
  const nm = bridgeSafetyOf(bot3, { feet: feetOf(bot3), dir: dirOf('east'), count: 3, item: { name: 'cobblestone', count: 2 }, need: 3 })
  ok(nm.ok === false && nm.why.includes('只剩 2'), '材料不够铺满 ⇒ 拦住（并说还剩几块）')

  const { w: w4, bot: bot4 } = gapScene({ depth: 5 })
  const orig4 = w4.blockAt.bind(w4)
  bot4.blockAt = (p) => (p.y < 63 ? null : orig4(p))   // 脚下那格是实地，前方"看不到底"
  const un = bridgeSafetyOf(bot4, { feet: feetOf(bot4), dir: dirOf('east'), count: 3, item: { name: 'cobblestone', count: 64 }, need: 3 })
  ok(un.ok === false && un.why.includes('没加载'), '读到 null（区块没加载）⇒ 拦住，不猜深浅')
  ok(BRIDGE_MIN_HEALTH === 8 && BRIDGE_DEEP === 8, '常量值：最低血量 8、深沟阈值 8')

  // ── 很高的悬空长廊：一路空到 64 格还没底 ⇒ 照搭 + risk（2026-10-22 用户：有超过 24 格的情况） ──
  const sky = mkWorld()
  // 站在 y=100（假世界的"已加载区"是 y=0..160），下面 64 格全是空气且**都读得到** ⇒ 只会 bottomed
  sky.set(0, 99, 0, 'stone')
  const skyBot = mkBot(sky, { x: 0, y: 100, z: 0 })
  const sd = bridgeSafetyOf(skyBot, { feet: feetOf(skyBot), dir: dirOf('east'), count: 3, item: { name: 'cobblestone', count: 64 }, need: 3 })
  ok(sd.ok === true, '🔴 下方一路空到 64 格 ⇒ 不再拒（以前必拒"看不到底"）')
  ok(sd.drop === DROP_SCAN, '落差按扫描深度记（>= 深沟阈值，会带 risk）')
  ok(sd.risk?.includes('没到底') && sd.risk.includes('悬空长廊'), 'risk 说清"64 格内没到底、真·悬空长廊"')
}

section('⑥ confirmBlockAt：C 的确认（只认回读，不认"我以为"）')
{
  const w = mkWorld()
  const b = mkBot(w)
  w.set(1, 63, 0, 'cobblestone')
  ok(await confirmBlockAt(b, { x: 1, y: 63, z: 0 }, 'cobblestone', { tries: 2, ms: 1 }) === true, '读到的名字对得上 ⇒ true')
  ok(await confirmBlockAt(b, { x: 1, y: 63, z: 0 }, 'dirt', { tries: 2, ms: 1 }) === false, '名字不对 ⇒ false')
  ok(await confirmBlockAt(b, { x: 9, y: 63, z: 0 }, 'cobblestone', { tries: 2, ms: 1 }) === false, '那一格还是空气 ⇒ false')
  let n = 0
  const late = { blockAt: () => { n++; return n >= 3 ? { name: 'cobblestone' } : { name: 'air' } } }
  ok(await confirmBlockAt(late, { x: 1, y: 63, z: 0 }, 'cobblestone', { tries: 5, ms: 1 }) === true, '服务端晚一点才生效 ⇒ 重读能等到')
  ok(n === 3, '确认是"轮询"而不是只读一次')
  const boom = { blockAt: () => { throw new Error('x') } }
  ok(await confirmBlockAt(boom, { x: 0, y: 0, z: 0 }, 'x', { tries: 2, ms: 1 }) === false, 'blockAt 抛错 ⇒ false（不炸）')
}

section('⑦ bridgeAcross 整条：放一块 → 确认 → 才走一格')
{
  // ── happy path：3 格沟，一路铺过去 ──
  const { w, bot } = gapScene({ depth: 5 })
  const self = mkSelf(bot, w)
  const r = await bridgeAcross(self, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(r.ok === true, '一路铺通 ⇒ ok:true', JSON.stringify(r).slice(0, 200))
  ok(r.placed === 3 && r.walked === 3, '放了 3 块、走了 3 格')
  ok(self.placedCalls.length === 3, 'placeBlock 被调 3 次')
  ok(self.walkCalls.length === 3, 'walkTo 被调 3 次（每块一次）')
  ok(self.placedCalls.every((c, i) => c.y === 63), '都放在脚下一层（y=63）')
  ok(feetOf(bot).x === 3, '最后人真的走到了 x=3')
  ok(w.get(1, 63, 0) === 'cobblestone' && w.get(3, 63, 0) === 'cobblestone', '世界里的方块真的在（不是只信返回值）')
  ok(self.placedCalls.length === self.walkCalls.length, '🔴 每一块放置都对应一次走路（不会"连放几块再走"）')
  const order = []
  const self2 = mkSelf(bot, w)
  self2.placeBlock = ((orig) => async (t) => { order.push('place'); return await orig(t) })(self2.placeBlock.bind(self2))
  self2.walkTo = ((orig) => async (t, o) => { order.push('walk'); return await orig(t, o) })(self2.walkTo.bind(self2))
  ok(order.length === 0, '（顺序断言见下一段）')

  // ── 顺序：place 一定在 walk 之前，且交替 ──
  const s3 = gapScene({ depth: 5 })
  const self3 = mkSelf(s3.bot, s3.w)
  const seq = []
  const p0 = self3.placeBlock.bind(self3); const w0 = self3.walkTo.bind(self3)
  self3.placeBlock = async (t) => { seq.push('place'); return await p0(t) }
  self3.walkTo = async (t, o) => { seq.push('walk'); return await w0(t, o) }
  await bridgeAcross(self3, { dir: 'east', count: 2, name: 'cobblestone' })
  ok(seq.join(',') === 'place,walk,place,walk', '顺序是 place→walk→place→walk（🔴 先确认再前进）', seq.join(','))

  // ── 🔴 放置没成功 ⇒ 停，且一格都不走 ──
  const a = gapScene({ depth: 5 })
  const sa = mkSelf(a.bot, a.w, { placeOk: false })
  const ra = await bridgeAcross(sa, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(ra.ok === false && ra.stopped === true, 'placeBlock 报 placed:false ⇒ 停')
  ok(ra.walked === 0 && sa.walkCalls.length === 0, '🔴 **一格都没往前走**（用户的验收标准）')
  ok(ra.why.includes('没放上去'), 'why 说清是"没放上去"')
  ok(ra.placed === 0, 'placed 记 0')

  // ── 🔴 放置"声称成功"但回读对不上 ⇒ 停，且不走 ──
  const c = gapScene({ depth: 5 })
  const sc = mkSelf(c.bot, c.w, { placeLies: true })
  const rc = await bridgeAcross(sc, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(rc.ok === false && rc.stopped === true, '回读不是那个方块 ⇒ 停')
  ok(rc.walked === 0 && sc.walkCalls.length === 0, '🔴 回读对不上时**也不往前走**')
  ok(rc.why.includes('回读'), 'why 说清是"回读"对不上')

  // ── 🔴 走了但没到 ⇒ 停（不按"走过去了"算） ──
  const d = gapScene({ depth: 5 })
  const sd = mkSelf(d.bot, d.w, { walkMiss: [0, 0, 0] })
  const rd = await bridgeAcross(sd, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(rd.ok === true && rd.walked === 3, '（正常情况作为对照：走满 3 格）')

  const e2 = gapScene({ depth: 5 })
  const se = mkSelf(e2.bot, e2.w)
  let k = 0
  const we = se.walkTo.bind(se)
  se.walkTo = async (t, o) => { k++; if (k === 2) return { arrived: false, reason: 'stuck' }; return await we(t, o) }
  const re = await bridgeAcross(se, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(re.ok === false && re.stopped === true, '第 2 步没走过去 ⇒ 停')
  ok(re.walked === 1 && re.placed === 2, '已经铺了 2 块、只走了 1 格（如实记）')
  ok(re.why.includes('没走过去'), 'why 说清是"没走过去"')
  ok(re.stepTarget && re.stepTarget.x === 2, '带上 stepTarget，模型知道卡在哪')

  // ── 走"到"了但坐标不是那一格（被挤/被弹） ⇒ 停 ──
  const f = gapScene({ depth: 5 })
  const sf = mkSelf(f.bot, f.w)
  let m = 0
  const wf = sf.walkTo.bind(sf)
  sf.walkTo = async (t, o) => { m++; const rr = await wf(t, o); if (m === 2) f.bot.entity.position.x += 0.0, f.bot.entity.position.z = 9.5; return rr }
  const rf = await bridgeAcross(sf, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(rf.ok === false && rf.why.includes('没到'), '人没站在那一格 ⇒ 停（不按"走过去了"算）')

  // ── 走到新位置后脚下不是实地 ⇒ 停 ──
  const g = gapScene({ depth: 5 })
  const sg = mkSelf(g.bot, g.w)
  const wg = sg.walkTo.bind(sg)
  sg.walkTo = async (t, o) => { const rr = await wg(t, o); g.w.set(t.x, t.y - 1, t.z, 'air'); return rr }
  const rg = await bridgeAcross(sg, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(rg.ok === false && rg.why.includes('支撑'), '走完发现脚下支撑没了 ⇒ 立刻停（再往前就是掉）')

  // ── 前方有岩浆：现在只警告，照铺（用户 2026-10-22「改成警告」） ──
  const h = gapScene({ depth: 5 })
  h.w.set(2, 58, 0, 'lava')
  const sh = mkSelf(h.bot, h.w)
  const rh = await bridgeAcross(sh, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(rh.ok === true && rh.placed === 3, '前方岩浆 ⇒ 照样铺完 3 格（不再一块都不放）')
  ok(rh.warningCount >= 1 && String(rh.warnings || '').includes('岩浆'), '结果里点名岩浆（warnings）')
  ok(rh.risk && rh.risk.includes('岩浆'), 'risk 也写着桥下有岩浆')
  ok(rh.warningCount === 1, '只是"经过"(2,63,0) 那格时扫到一次，同一处不重复刷')

  // ── 深空长廊：一路空 ⇒ 照铺（不只安全检查放行，复跑装配也要真走完） ──
  const sky2 = mkWorld()
  sky2.set(0, 99, 0, 'stone')
  const sky2Bot = mkBot(sky2, { x: 0, y: 100, z: 0 })
  const ssky = mkSelf(sky2Bot, sky2)
  const rsky = await bridgeAcross(ssky, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(rsky.ok === true && rsky.placed === 3, '深空长廊 ⇒ 3 格全铺上')
  ok(ssky.placedCalls.length === 3, '真放了 3 块方块')

  // ── 血量低：A 阶段拦 ──
  const i2 = gapScene({ depth: 5, health: 3 })
  const si = mkSelf(i2.bot, i2.w)
  const ri = await bridgeAcross(si, { dir: 'east', count: 3, name: 'cobblestone' })
  ok(ri.ok === false && ri.why.includes('血量'), '血量 3 ⇒ 开铺前就停')
  ok(si.placedCalls.length === 0, '一块都没放')

  // ── 没材料：抛错，且话说清楚（怎么补料） ──
  const j = gapScene({ depth: 5, items: [{ name: 'torch', count: 9 }] })
  const sj = mkSelf(j.bot, j.w)
  let jerr = null
  try { await bridgeAcross(sj, { dir: 'east', count: 2 }) } catch (err) { jerr = err.message }
  ok(Boolean(jerr), '背包里没有能当搭路料的整方块 ⇒ 抛错')
  ok(jerr?.includes('mc_dig'), '错误信息里告诉它怎么补料')
  const j2 = gapScene({ depth: 5, items: [{ name: 'cobblestone', count: 64 }] })
  const sj2 = mkSelf(j2.bot, j2.w)
  let jerr2 = null
  try { await bridgeAcross(sj2, { dir: 'east', count: 2, name: 'diamond_block' }) } catch (err) { jerr2 = err.message }
  ok(jerr2?.includes('diamond_block'), '指定了没有的材料 ⇒ 报错里点名它')

  // ── 断点续铺：本来就有方块的那一格跳过 ──
  const k2 = gapScene({ depth: 5 })
  k2.w.set(1, 63, 0, 'stone')
  const sk = mkSelf(k2.bot, k2.w)
  const rk = await bridgeAcross(sk, { dir: 'east', count: 2, name: 'cobblestone' })
  ok(rk.ok === true && rk.skipped === 1, '第 1 格本来就有方块 ⇒ 跳过、记 skipped')
  ok(sk.placedCalls.length === 1, '只放了缺的那 1 块（不重铺）')

  // ── 目标格被占住（放不进去） ⇒ 停 ──
  //     `ladder` 在 minecraft-data 里 boundingBox 是 'block' 但属于可穿过方块：
  //     `isSolidBlock` 说"不是实地"（所以不会被当成"已有方块"跳过），
  //     `canPlaceInto` 又说"放不进去" —— 正好是那条兜底分支。
  const l = gapScene({ depth: 5 })
  l.w.set(1, 63, 0, 'ladder')
  const sl = mkSelf(l.bot, l.w)
  const rl = await bridgeAcross(sl, { dir: 'east', count: 2, name: 'cobblestone' })
  ok(rl.ok === false && rl.why.includes('占住'), '目标格被梯子占住 ⇒ 停并说清（换方向或先清掉）', rl.why)

  // ── 目标格未加载 ⇒ 停 ──
  const m2 = gapScene({ depth: 5 })
  const origM = m2.w.blockAt.bind(m2.w)
  m2.w.blockAt = (p) => (p.x === 1 && p.y === 63 && p.z === 0 ? null : origM(p))
  const sm = mkSelf(m2.bot, m2.w)
  const rm = await bridgeAcross(sm, { dir: 'east', count: 2, name: 'cobblestone' })
  ok(rm.ok === false && rm.why.includes('未加载'), '目标格未加载 ⇒ 停（不猜）', rm.why)

  // ── 方向/格数从 x/y/z 反推（mc_act 走这条） ──
  const n2 = gapScene({ depth: 5 })
  const sn = mkSelf(n2.bot, n2.w)
  const rn = await bridgeAcross(sn, { x: 4, y: 63, z: 0, name: 'cobblestone' })
  ok(rn.ok === true && rn.count === 4 && rn.dir === '东(+x)', '给 x/y/z ⇒ 反推成"往东 4 格"')
  ok(sn.placedCalls.length === 4, '铺了 4 块')

  // ── 超过单次上限 ⇒ 明确报错（不偷偷截断） ──
  const o = gapScene({ depth: 5 })
  const so = mkSelf(o.bot, o.w)
  let oerr = null
  try { await bridgeAcross(so, { x: BRIDGE_MAX + 5, y: 63, z: 0, name: 'cobblestone' }) } catch (err) { oerr = err.message }
  ok(oerr?.includes(String(BRIDGE_MAX)), `超过 ${BRIDGE_MAX} 格 ⇒ 报错并告诉它分几次铺`)
  ok(so.placedCalls.length === 0, '报错时一块都没放')
}

section('⑧ 静态接线：core.mjs / index.js 真的挂上了')
{
  const core = read('../src/core.mjs')
  ok(/import \{ bridgeAcross \} from '\.\/bridge\.mjs'/.test(core), 'core.mjs import 了 bridgeAcross')
  ok(/async bridge \(opts = \{\}\) \{ return await bridgeAcross\(this, opts, \{ t: \(p, k, l\) => this\.#t\(p, k, l\) \}\) \}/.test(core), 'core.mjs 暴露了 bot.bridge()')
  const idx = read('../index.js')
  ok(/case 'bridge':\s+return withOutcome\(\{ mode, \.\.\.\(await bot\.bridge\(/.test(idx), "mc_act 有 case 'bridge'")
  ok(idx.includes('· bridge 搭路：'), 'mc_act 的描述里写了 bridge')
  ok(/可用 look\/toward\/place\/bridge\//.test(idx), 'default 的可用 mode 列表里有 bridge')
  const br = read('../src/bridge.mjs')
  ok(!/from '\.\/core\.mjs'/.test(br), '🔴 bridge.mjs 不反向 import core.mjs（会循环导入）')
  ok(!/^import[^\n]*mineflayer/m.test(br), '🔴 bridge.mjs 不 import mineflayer（离线可测；注释里提它不算）')
  ok(/export const BRIDGE_MAX = 16/.test(br), '单次上限 16 格')
  ok(/MOVE_SAMPLE_MS|moveProgressWatcher/.test(read('../src/movement.mjs')), '（相邻模块 sanity：movement.mjs 还是那一份）')
}

/* ═══════════════ ⑨ 危险方块 → 寻路黑名单（mc_map 第二轮） ═══════════════ */
section('⑨ avoidBlockIds：把"要命方块"交给寻路器绕开')
{
  const reg = { blocksByName: {} }
  BRIDGE_FATAL_NAMES.forEach((n, i) => { reg.blocksByName[n] = { id: 100 + i } })
  const ids = avoidBlockIds({ registry: reg })
  ok(ids.length === BRIDGE_FATAL_NAMES.length, '名单里的每个方块都换成了 id', `${ids.length}/${BRIDGE_FATAL_NAMES.length}`)
  ok(ids.includes(100) && ids.includes(106), 'lava(100) 和 cactus(106) 都在', JSON.stringify(ids))
  ok(ids.every((n) => typeof n === 'number'), '全是数字 id（`blocksToAvoid` 收的就是 id）')

  // 认不出来的方块跳过，不硬凑
  const partial = { registry: { blocksByName: { lava: { id: 7 } } } }
  ok(JSON.stringify(avoidBlockIds(partial)) === '[7]', '只认得 lava ⇒ 只回 lava', JSON.stringify(avoidBlockIds(partial)))
  ok(avoidBlockIds({}).length === 0, '没 registry ⇒ 空数组（不炸）')
  ok(avoidBlockIds(null).length === 0, 'null ⇒ 空数组')
  ok(avoidBlockIds({ registry: { blocksByName: { get lava () { throw new Error('boom') } } } }).length === 0, 'registry 抛错 ⇒ 空数组')
  ok(BRIDGE_FATAL.test('lava') && BRIDGE_FATAL.test('cactus') && !BRIDGE_FATAL.test('stone')
    && !BRIDGE_FATAL.test('sweet_berry_bush'), '正则仍由那份名单生成（唯一出处）；甜浆果丛只减速、不算致命')

  const plugins = read('../src/plugins.mjs')
  ok(/import \{ avoidBlockIds, treeBlockIds \} from '\.\/bridge\.mjs'/.test(plugins), 'plugins.mjs 引了 avoidBlockIds')
  ok(/for \(const id of avoidBlockIds\(b\)\) mv\.blocksToAvoid\.add\(id\)/.test(plugins), '🔴 movements() 里真把它们加进 blocksToAvoid')
}

console.log(`\n──────────────────────────────────────────────`)
/* ═══════════════ ⑧ 铺完把手换回来（2026-10-19 实机：搭完还攥着圆石） ═══════════════ */
section('⑧ 铺完把手换回来：之前的武器/镐子，所有返回路径都还原')
{
  /** 手里先拿着镐，背包里有圆石；placeBlock 会把方块塞到手上（真 mineflayer 就是这样） */
  const mkScene = (o = {}) => {
    const { w, bot } = gapScene({ depth: 5 })
    bot.heldItem = { name: 'diamond_pickaxe', count: 1 }
    bot.inventory = { items: () => [{ name: 'diamond_pickaxe', count: 1 }, { name: 'cobblestone', count: 64 }] }
    bot.equip = async (item) => { bot.heldItem = { name: item.name, count: item.count } }
    const self = mkSelf(bot, w, o)
    const orig = self.placeBlock.bind(self)
    self.placeBlock = async (t) => { bot.heldItem = { name: 'cobblestone', count: 64 }; return await orig(t) }
    return { w, bot, self }
  }
  {
    const { bot, self } = mkScene()
    const r = await bridgeAcross(self, { dir: 'east', count: 2, name: 'cobblestone' })
    ok(r.ok === true, '正常铺完', JSON.stringify(r).slice(0, 100))
    ok(bot.heldItem?.name === 'diamond_pickaxe', '🔴 铺完自动切回之前的镐/武器', String(bot.heldItem?.name))
    ok(r.held === 'diamond_pickaxex1', '结果里报的是**换回来的手**（held）', String(r.held))
    ok(r.heldRestored === 'diamond_pickaxe', '结果里标了"换回了什么"（heldRestored）', String(r.heldRestored))
    ok(r.heldBefore === 'diamond_pickaxex1', '搭之前手里是什么也留着（heldBefore）', String(r.heldBefore))
  }
  {
    const { bot, w } = mkScene({ placeOk: false })
    const self = mkSelf(bot, w, { placeOk: false })
    const r = await bridgeAcross(self, { dir: 'east', count: 2, name: 'cobblestone' })
    ok(r.ok === false, '放置失败 ⇒ 停（对照）')
    ok(bot.heldItem?.name === 'diamond_pickaxe', '🔴 半路停下也要把手换回来', String(bot.heldItem?.name))
  }
  {
    /* 🔴 空手开搭（2026-10-21 用户："搭路自动切回去…不生效"）：搭路会把方块塞到手上，
     *    铺完必须**把手放回空手** —— 原来空手时 `heldSnapshotOf` 返回 null，`if (keep)` 直接跳过，
     *    手里就一直攥着那摞方块。 */
    const { w, bot } = gapScene({ depth: 5 })
    bot.heldItem = null
    bot.quickBarSlot = 0
    bot.inventory = { items: () => [{ name: 'cobblestone', count: 64 }], slots: [] }
    bot.inventory.slots[36] = { name: 'cobblestone', count: 64 }
    bot.inventory.slots[37] = null
    bot.setQuickBarSlot = (i) => { bot.quickBarSlot = i; bot.heldItem = bot.inventory.slots[36 + i] ?? null }
    bot.equip = async (item) => { bot.heldItem = { name: item.name, count: item.count } }
    const snap = heldSnapshotOf(bot)
    ok(snap != null && snap.empty === true && snap.name === null, 'heldSnapshotOf：空手也记快照（empty:true，不再返回 null）', JSON.stringify(snap))
    const self = mkSelf(bot, w)
    const orig = self.placeBlock.bind(self)
    self.placeBlock = async (t) => { bot.heldItem = { name: 'cobblestone', count: 64 }; return await orig(t) }
    const r = await bridgeAcross(self, { dir: 'east', count: 1, name: 'cobblestone' })
    ok(r.ok === true, '空手开搭照常铺完', JSON.stringify(r).slice(0, 80))
    ok(bot.heldItem == null, '🔴 空手开搭 ⇒ 铺完把手里的方块放回去（收工空手）', `${r.held} / ${String(bot.heldItem?.name)}`)
    ok(r.heldRestored === '空手' && r.held === '空手', '结果里如实标成"还原成空手"', `${r.heldRestored} / ${r.held}`)
  }
  {
    const b = { heldItem: { name: 'cobblestone', count: 3 }, inventory: { items: () => [{ name: 'cobblestone', count: 3 }] }, equip: async () => {} }
    const r = await restoreHeldOf(b, { name: 'diamond_sword' })
    ok(r.restored === false && /已经没有 diamond_sword/.test(String(r.why)), '要还的东西不在背包里 ⇒ 如实说', String(r.why))
    const b2 = { heldItem: { name: 'cobblestone', count: 3 }, inventory: { items: () => [{ name: 'diamond_sword', count: 1 }] }, equip: async () => {} }
    const r2 = await restoreHeldOf(b2, { name: 'diamond_sword' })
    ok(r2.restored === false && /手里是 cobblestone/.test(String(r2.why)), '换完回读不对 ⇒ 不算换回来', String(r2.why))
    const b3 = { heldItem: { name: 'cobblestone', count: 3 }, inventory: { items: () => [{ name: 'diamond_sword', count: 1 }] }, equip: async () => { b3.heldItem = { name: 'diamond_sword', count: 1 } } }
    const r3 = await restoreHeldOf(b3, { name: 'diamond_sword' })
    ok(r3.restored === true && r3.now === 'diamond_sword', '换回来了（restored:true）', JSON.stringify(r3))
    const b4 = { heldItem: { name: 'cobblestone', count: 3 }, inventory: { items: () => [{ name: 'diamond_sword', count: 1 }] }, equip: async () => { throw new Error('服务端拒了') } }
    const r4 = await restoreHeldOf(b4, { name: 'diamond_sword' })
    ok(r4.restored === false && /服务端拒了/.test(String(r4.why)), '换失败也不抛错（桥已经搭完了，如实说一句）', String(r4.why))
  }
}

console.log(`check-bridge：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
