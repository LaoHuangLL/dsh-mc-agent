#!/usr/bin/env node
/**
 * 射箭自检 —— `src/shoot.mjs` / `mc_shoot {}`
 *
 * 用户 2026-10-19：「hawkeye 主要是水晶和末影龙」—— 也就是末地战那两个用法：
 *   · 末影水晶：**坐标**目标（柱顶那颗），静止；
 *   · 末影龙：**实体**目标，会飞，必须带提前量。
 *
 * 这一套钉死七件事：
 *   ① 目标必须二选一 —— `who` 或 `x/y/z`，都给/都不给都要**明确报错**，不许猜；
 *   ② 没弓 / 没箭 / 换不上弓 ⇒ **一箭都不射**（不拉空弓、不浪费这一轮）；
 *   ③ 顺序必须是 **look → activate → (等拉满) → release** —— 反了就是照着上一次朝向射；
 *   ④ 弹道由 hawkeye 算；**算不出来（`undefined`）就如实说"太远/角度刁"**，绝不拿默认角度瞎射；
 *   ⑤ 放箭之后**数箭**确认真的出去了；箭数没变（服务端不认）⇒ `ok:false`；
 *   ⑥ 创造模式**不耗箭**，不能拿"箭数没变"当失败；
 *   ⑦ 真 hawkeye 能通过 `loadMcDep('hawkeye')` 找到、且 `getMasterGrade()` 返回的
 *      `yaw/pitch` 是**弧度**（直接喂 `bot.look`）。
 *
 * 用法：node tools/check-shoot.mjs
 */
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const { shoot, arrowsIn, infiniteArrows, itemHasInfinity, aimHeightFor, aimProxyFor } = await import(new URL('../src/shoot.mjs', import.meta.url))
const { loadMcDep } = await import(new URL('../src/plugins.mjs', import.meta.url))
const { withBudget } = await import(new URL('../src/runtime.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const throws = async (p, re, label) => {
  try { await p(); ok(false, label, '没报错') } catch (e) { ok(re.test(String(e?.message ?? e)), label, String(e?.message ?? e)) }
}

/** 假 bot：只实现 shoot 真正碰到的那几个接口（其余一律没有 ⇒ 用了就会炸，正好当"越界"探针） */
const makeBot = ({ items = [], gameMode = 'survival', consumeArrow = true, equipWorks = true, consumeDelayMs = 0, held = null, blockAt = null, world = null } = {}) => {
  const log = []
  const inv = items.map(([name, count]) => ({ name, count }))
  const bot = {
    entity: { position: new Vec3(0, 64, 0), height: 1.8 },
    entities: {},
    game: { gameMode },
    heldItem: held ? { name: held, count: 1 } : null,
    inventory: { items: () => inv },
    async equip (item, dest) {
      log.push(['equip', item.name, dest])
      /* 真的 mineflayer：换手后 `heldItem` 就是背包里那个**同一个对象**（附魔/耐久都跟着），
       * 所以这里也回背包里找，别新建一个 —— 否则"无限附魔"这类读附魔的判据测不出来。 */
      if (equipWorks) bot.heldItem = inv.find((i) => i.name === item.name) ?? { name: item.name, count: item.count ?? 1 }
    },
    async look (yaw, pitch, force) { log.push(['look', Number(yaw), Number(pitch), force]) },
    /* 🔴 真 mineflayer 的 `activateItem` / `deactivateItem` 是**同步 void** 方法（返回 undefined）。
     *    这里以前写成 `async`（返回 promise），于是"真机的 t() 收到 undefined 会炸"这种 bug
     *    自检 73/0 全绿也测不出来 —— 2026-10-19 实机射箭当场踩到
     *    （`TypeError: Cannot read properties of undefined (reading 'then')`，弓拉起来了、箭没放）。
     *    所以假 bot 必须跟真 API 一样是同步的。 */
    activateItem () { log.push(['activate']) },
    deactivateItem () {
      log.push(['release'])
      if (!consumeArrow) return
      const eat = () => {
        const a = inv.find((i) => /arrow/i.test(i.name))
        if (a && a.count > 0) a.count -= 1
      }
      if (consumeDelayMs > 0) setTimeout(eat, consumeDelayMs)   // 服务端回包慢：箭数过一会儿才掉
      else eat()
    },
    blockAt: blockAt ?? ((pos) => ({ name: pos && pos.y > 100 ? 'stone' : 'air' })),
    world: world ?? { raycast: () => null },
    __log: log,
    __inv: inv,
  }
  return bot
}

/**
 * 最小 `self`：`withBudget` 只用到这几样（`cfg.timeouts` / `msLeft` / `stats` / `abortSignal` / `log`）。
 * 用**真的**闸门而不是 `async (p) => await p` —— 假 ctx 太宽容，真机上"传进去的是 undefined"这种
 * 事故就测不到（`withBudget` → `raceAbort` → `promise.then`）。
 */
const fakeSelf = (ms = 8_000) => ({
  cfg: { timeouts: {} },
  msLeft: () => ms,
  stats: { timeouts: 0 },
  lastTimeout: null,
  /* 🔴 必须是**真的** signal（未 abort）：真机上每轮 turn 都有 exec.signal，
   *    `raceAbort` 只有拿到 signal 才会走 `promise.then(...)` 那条路 ——
   *    signal 给 null 时它直接原样返回，`undefined.then` 那个炸点反而测不到。 */
  abortSignal: new AbortController().signal,
  log: () => {},
})

const ctxOf = (grade, extra = {}) => {
  const self = extra.self ?? fakeSelf()
  return {
    t: (p, k, l) => withBudget(self, p, k, l),      // 真闸门
    callLeft: () => self.msLeft(),
    minDrawMs: 0,                     // 测试不等那 1 秒
    pollMs: 0,                        // 也不等"箭数掉下来"的轮询间隔
    grade,
    ...extra,
  }
}

const GRADE = { yaw: Math.PI / 2, pitch: -0.3, grade: -17.2, nearestDistance: 0.3, blockInTrayect: null }

/* ────────────────────────── ① 目标二选一 ────────────────────────── */
section('① 目标：who 或 x/y/z，只能给一个')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  await throws(() => shoot(b, {}, ctxOf(() => GRADE)), /射谁|射哪/, 'who/坐标都不给 ⇒ 报错')
  await throws(() => shoot(b, { who: 'ender_dragon', x: 1, y: 2, z: 3 }, ctxOf(() => GRADE)), /只能给一个/, 'who + 坐标同时给 ⇒ 报错')
  await throws(() => shoot(b, { x: 1, y: 2 }, ctxOf(() => GRADE)), /射谁|射哪/, '坐标缺一个 ⇒ 报错')
  await throws(() => shoot(b, { x: 1, y: 2, z: 3, weapon: 'sword' }, ctxOf(() => GRADE)), /weapon/, 'weapon 不认识 ⇒ 报错')
}

/* ────────────────────────── ② 没弓 / 没箭 ────────────────────────── */
section('② 没弓 / 没箭 / 换不上弓 ⇒ 一箭都不射')
{
  {
    const b = makeBot({ items: [['arrow', 10]] })
    await throws(() => shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE)), /背包里没有 bow/, '没弓 ⇒ 报错')
    ok(!b.__log.some((e) => e[0] === 'activate'), '没弓时没拉弓')
  }
  {
    const b = makeBot({ items: [['bow', 1], ['crossbow', 1]] })
    await throws(() => shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE)), /没有箭/, '有弓没箭 ⇒ 报错（生存）')
  }
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 5]], equipWorks: false })
    await throws(() => shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE)), /换 bow 没成功/, '换不上弓 ⇒ 报错')
  }
}

/* ────────────────────────── ③ 顺序 + 一箭射出去 ────────────────────────── */
section('③ 顺序 look → activate → release，且数箭确认')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
  const idx = (k) => b.__log.findIndex((e) => e[0] === k)
  ok(r.ok === true, 'ok:true', JSON.stringify(r))
  ok(r.fired === 1, '射了 1 箭', String(r.fired))
  ok(idx('look') >= 0 && idx('look') < idx('activate'), '先瞄准再拉弓', JSON.stringify(b.__log))
  ok(idx('release') > idx('activate'), '拉弓之后才放箭')
  ok(b.__log.find((e) => e[0] === 'look')[3] === true, 'look 带 force=true（不会被平滑插值拖偏）')
  ok(r.arrows.before === 10 && r.arrows.after === 9, '箭数 10 → 9', JSON.stringify(r.arrows))
  ok(r.shots[0].arrowsUsed === 1, '这一箭记了 arrowsUsed:1')
  ok(r.shots[0].yawDeg === 90, 'yaw 弧度 → 度数换算对（π/2 = 90）', String(r.shots[0].yawDeg))
  ok(r.shots[0].pitchDeg === -17.2, 'pitch 弧度 → 度数换算对（-0.3 ≈ -17.2）', String(r.shots[0].pitchDeg))
  ok(r.shots[0].aimError === 0.3, 'aimError 透传 nearestDistance')
  ok(Array.isArray(r.target?.at) && r.target.at[1] === 70, '结果报目标坐标', JSON.stringify(r.target))
  ok(r.held === 'bowx1', '结果报手上是弓', String(r.held))
  ok(b.__log.some((e) => e[0] === 'equip' && e[1] === 'bow'), '没拿弓时先换弓')
}

/* ────────────────────────── ④ 算不出弹道 ⇒ 不瞎射 ────────────────────────── */
section('④ hawkeye 返回 undefined ⇒ 停手 + 说清为什么')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  const r = await shoot(b, { x: 0, y: 70, z: 200 }, ctxOf(() => undefined))
  ok(r.ok === false, 'ok:false')
  ok(r.fired === 0, '一箭没射')
  ok(/算不出弹道/.test(String(r.why)), 'why 说"算不出弹道"', String(r.why))
  ok(!b.__log.some((e) => e[0] === 'look'), '没瞄也没拉（不瞎射）')
}

/* ────────────────────────── ⑤ 服务端不认 ⇒ ok:false ────────────────────────── */
section('⑤ 箭数没变（服务端没认）⇒ ok:false')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]], consumeArrow: false })
  const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
  ok(r.ok === false, 'ok:false')
  ok(/箭数没变/.test(String(r.why)), 'why 说"箭数没变"', String(r.why))
  ok(r.fired === 1, '只放了这一次就停（不接着空放）', String(r.fired))
}

/* ────────────────────────── ⑥ 创造模式不耗箭 ────────────────────────── */
section('⑥ 创造模式：不耗箭也不算失败')
{
  const b = makeBot({ items: [['bow', 1]], gameMode: 'creative' })
  ok(infiniteArrows(b) === true, 'infiniteArrows 认 creative')
  ok(arrowsIn(b) === 0, '创造模式背包里没箭')
  const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
  ok(r.ok === true, 'ok:true（没箭也能射）', JSON.stringify(r))
  ok(r.creative === true, '结果标了 creative:true')
  ok(r.fired === 1, '射出去了')
}

/* ────────────────────────── ⑦ 实体目标 + 提前量 ────────────────────────── */
section('⑦ 实体目标（末影龙）：按实测速度算提前量')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  let x = 0
  const dragon = { name: 'ender_dragon', type: 'mob', isValid: true }
  Object.defineProperty(dragon, 'position', { get: () => new Vec3((x += 1), 70, 30) })
  b.entities = { 7: dragon }
  let sawSpeed = null
  let sawTarget = null
  /* 2026-10-20：末影龙默认套 DRAGON_MAX_DIST=25 的射程闸（实机命中距离分布），
     这里故意把它放在 30 格，所以**显式给 maxDist** 越过自动闸 —— 顺带验证"调用方能覆盖"。 */
  const r = await shoot(b, { who: 'ender_dragon', maxDist: 40 }, ctxOf((target, speed) => { sawSpeed = speed; sawTarget = target; return GRADE }))
  ok(sawTarget === dragon, 'grade 拿到的是那个实体（不是坐标壳）')
  ok(sawSpeed && Math.abs(sawSpeed.x) > 0, '速度非零（实测位置差，不是读 velocity）', JSON.stringify(sawSpeed))
  ok(r.ok === true && r.target?.name === 'ender_dragon', '结果报目标名', JSON.stringify(r.target))
  ok(r.target.distance > 29.5 && r.target.distance < 32, '结果报距离（≈30 格）', String(r.target.distance))
  ok(b.__log.filter((e) => e[0] === 'look').length >= 2, '实体目标会"放箭前再瞄一次"（目标在动）')
}
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  await throws(() => shoot(b, { who: 'ender_dragon' }, ctxOf(() => GRADE)), /找不到 "ender_dragon"/, '半径内没这个实体 ⇒ 报错')
}

/* ────────────────────────── ⑧ 连射上限 + 静止目标不取提前量 ────────────────────────── */
section('⑧ count 上限 5；坐标目标速度为零')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 30]] })
  const speeds = []
  const r = await shoot(b, { x: 0, y: 70, z: 20, count: 99, waitTime: 5 }, ctxOf((t, s) => { speeds.push(s); return GRADE }))
  ok(r.shots.length === 5, 'count:99 最多射 5 箭', String(r.shots.length))
  ok(speeds.every((s) => s.x === 0 && s.y === 0 && s.z === 0), '坐标目标的速度是零向量')
  ok(r.arrows.before === 30 && r.arrows.after === 25, '连射 5 箭扣 5 支', JSON.stringify(r.arrows))
}

/* ────────────────────────── ⑨ 真 hawkeye：找得到、弧度对 ────────────────────────── */
section('⑨ 真 hawkeye 接线（vendor 里那个包）')
{
  const bind = await loadMcDep('hawkeye')
  ok(typeof bind === 'function', 'loadMcDep("hawkeye") 找到注入函数', String(typeof bind))
  if (typeof bind === 'function') {
    const stub = { entity: { position: new Vec3(0, 64, 0) }, world: { raycast: () => null } }
    bind(stub)
    ok(typeof stub.hawkEye?.getMasterGrade === 'function', '注入后 bot.hawkEye.getMasterGrade 在')
    /* 20 格外的地面目标（比自己低 4 格）：pitch 应该是**负**的（往下压），且是弧度不是度数 */
    const g = stub.hawkEye.getMasterGrade({ position: new Vec3(0, 60, 20), isValid: true }, new Vec3(0, 0, 0), 'bow')
    ok(Boolean(g), '20 格目标算得出弹道')
    if (g) {
      ok(Number.isFinite(g.yaw) && Number.isFinite(g.pitch), 'yaw/pitch 都是有限数')
      ok(g.pitch < 0, '目标更低 ⇒ pitch < 0', String(g.pitch))
      ok(Math.abs(g.pitch) < Math.PI / 2, 'pitch 是弧度（|pitch| < π/2，不是度数）', String(g.pitch))
      ok(Number.isFinite(g.nearestDistance) && g.nearestDistance <= 4, '落点误差 ≤ 4 格', String(g.nearestDistance))
    }
    /* 200 格外：hawkeye 自己会返回 undefined（落点误差 > 4 格）—— 这正是 shoot 必须处理的分支 */
    const far = stub.hawkEye.getMasterGrade({ position: new Vec3(0, 64, 200), isValid: true }, new Vec3(0, 0, 0), 'bow')
    ok(far === undefined, '200 格外 ⇒ undefined（不硬算）', JSON.stringify(far))
  }
}

/* ────────────────────────── ⑩ 射完把手换回去 + 箭数回包慢 ────────────────────────── */
section('⑩ 射完换回原来的东西（用户 2026-10-19）')
{
  /* 手里拿着剑来射箭：射完必须回到剑上，别让"为了射一箭"把弓留在手里 */
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10], ['diamond_sword', 1]], held: 'diamond_sword' })
    const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
    ok(r.ok && r.fired === 1, '照常射出去', JSON.stringify({ ok: r.ok, fired: r.fired }))
    ok(b.heldItem?.name === 'diamond_sword', '射完手里是原来的剑', b.heldItem?.name)
    ok(r.heldRestored === 'diamond_sword', '结果报 heldRestored = diamond_sword', String(r.heldRestored))
    ok(r.held === 'diamond_swordx1', 'held 报的是"换回来之后"的手上', String(r.held))
    ok(b.__log.some((e) => e[0] === 'equip' && e[1] === 'diamond_sword' && e[2] === 'hand'), '确实发生过"换回手上"')
  }
  /* 半路停（算不出弹道）也要换回去 —— 不能让"没射成"留下弓在手里 */
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10], ['iron_sword', 1]], held: 'iron_sword' })
    const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => undefined))
    ok(r.ok === false && r.fired === 0, '算不出弹道 ⇒ 一箭没射', JSON.stringify({ ok: r.ok, fired: r.fired }))
    ok(b.heldItem?.name === 'iron_sword', '没射成也换回剑', b.heldItem?.name)
  }
  /* 抛错也要换回去（没箭 ⇒ 直接抛） */
  {
    const b = makeBot({ items: [['bow', 1], ['golden_sword', 1]], held: 'golden_sword' })
    await throws(() => shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE)), /没有箭/, '没箭 ⇒ 抛错')
    ok(b.heldItem?.name === 'golden_sword', '抛错之后手里还是原来的剑', b.heldItem?.name)
  }
  /* 原来空手：不假装还原（射完手里就是弓） */
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
    const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
    ok(!r.heldRestored, '空手开局 ⇒ 不报 heldRestored')
    ok(r.held === 'bowx1', 'held 如实报"手里是弓"', String(r.held))
  }
  /* 原来那件在背包里没了（比如刚丢完）：如实说一句，不算失败 */
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10]], held: 'netherite_sword' })
    const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
    ok(r.ok && r.fired === 1, '箭照样射出去了', JSON.stringify({ ok: r.ok, fired: r.fired }))
    ok(/netherite_sword/.test(String(r.heldRestoreWhy)), 'heldRestoreWhy 说清"背包里没有它了"', String(r.heldRestoreWhy))
  }
}

section('⑫ 中文叫法：末影龙 / 末影水晶')
{
  const mk = (name) => {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
    const e = { name, displayName: name, position: new Vec3(0, 70, 15), isValid: true, velocity: new Vec3(0, 0, 0) }
    b.entities = { 1: e }
    return b
  }
  const r1 = await shoot(mk('ender_dragon'), { who: '末影龙' }, ctxOf(() => GRADE))
  ok(r1.ok && r1.fired === 1, 'who:"末影龙" 找得到 ender_dragon', JSON.stringify({ ok: r1.ok, fired: r1.fired }))
  ok(/ender_dragon/.test(String(r1.target?.name)), 'target 报的是 ender_dragon', String(r1.target?.name))
  const r2 = await shoot(mk('ender_crystal'), { who: '末影水晶' }, ctxOf(() => GRADE))
  ok(r2.ok && r2.fired === 1, 'who:"末影水晶" 找得到 ender_crystal', JSON.stringify({ ok: r2.ok, fired: r2.fired }))
}

section('⑬ 无限附魔（Infinity）的弓：箭数不掉也算射出去了')
{
  /* 无限附魔：服务端真的不扣箭（假 bot 也跟着不扣，否则测的不是这条判据） */
  const b = makeBot({ items: [['bow', 1], ['arrow', 5]], consumeArrow: false })
  b.__inv.find((i) => i.name === 'bow').enchants = [{ name: 'infinity', lvl: 1 }]
  const r = await shoot(b, { x: 0, y: 70, z: 20, count: 2 }, ctxOf(() => GRADE, { pollMs: 0 }))
  ok(r.fired === 2, '连射两箭（没被"箭数没变"打断）', String(r.fired))
  ok(r.ok === true, '箭数一支没掉也判成功', String(r.ok))
  ok(!r.why, '不报"箭数没变"', String(r.why))
  ok(r.arrows.before === 5 && r.arrows.after === 5, '如实报箭数没变', JSON.stringify(r.arrows))
}

section('⑫ 箭数回包慢 200ms：不能当成"没射出去"')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]], consumeDelayMs: 200 })
  const r = await shoot(b, { x: 0, y: 70, z: 20, count: 2 }, ctxOf(() => GRADE, { pollMs: 100 }))
  ok(r.fired === 2, '两箭都算射出去了（不是被 120ms 误判打断）', String(r.fired))
  ok(r.shots.every((s) => s.arrowsUsed === 1), '每箭都数到"扣了 1 支"', JSON.stringify(r.shots.map((s) => s.arrowsUsed)))
  ok(r.ok === true, '整体 ok', String(r.ok))
}

section('⑭ 同步 void 动作（真 mineflayer 的形状）不能炸')
{
  /* 2026-10-19 实机现场：`mc_shoot {}` 直接回
   *   `Error: Cannot read properties of undefined (reading 'then')`
   * 根因是 `t(b.activateItem())` —— 真 mineflayer 这两个方法是同步 void，
   * 传 undefined 进 withBudget → raceAbort 里 `promise.then` 当场炸。
   * 这一条钉住"闸门必须容忍非 thenable"。 */
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  ok(b.activateItem() === undefined, '假 bot 的 activateItem 返回 undefined（同真 API）')
  ok(b.deactivateItem() === undefined, '假 bot 的 deactivateItem 返回 undefined（同真 API）')
  const r = await shoot(b, { x: 0, y: 70, z: 20 }, ctxOf(() => GRADE))
  ok(r.ok === true && r.fired === 1, 't() 收到 undefined 不抛，箭照样射出去', JSON.stringify({ ok: r.ok, fired: r.fired, why: r.why }))
  ok(b.__log.filter((e) => e[0] === 'release').length === 2, '放箭那一步真的执行了（含上面那次直调）')
}

section('⑮ 1.21 的组件附魔 + "天上多一支箭"旁证（无限弓假失败的根治）')
{
  /* 2026-10-19 实机：明明射中了（用户在场确认「中了」），工具却回
   *   `arrowsUsed:0 / outcome:"failed" / why:"箭数没变——服务端没认这次放箭"`
   *   ——根因是附魔字段形状一代一个样（1.21 走物品组件），老的 `{name,lvl}` 判据一个都没命中。 */

  /* ① 字段形状：三种都要认出来（不认字段名，看容器里有没有 infinity） */
  ok(itemHasInfinity({ enchants: [{ name: 'infinity', lvl: 1 }] }), '1.12 形状 `enchants:[{name,lvl}]` 认得出')
  ok(itemHasInfinity({ enchantsByName: { infinity: 1 } }), '1.16 形状 `enchantsByName:{infinity:1}` 认得出')
  const compMap = new Map([['enchantments', { data: [{ id: 'minecraft:infinity', level: 1 }] }]])
  ok(itemHasInfinity({ componentMap: compMap }), '1.21 组件形状 `componentMap.get("enchantments").data` 认得出')
  ok(itemHasInfinity({ nbt: { value: { Enchantments: [{ id: 'minecraft:infinity', lvl: 1 }] } } }), 'NBT 兜底也认得出')
  ok(!itemHasInfinity({ enchants: [{ name: 'efficiency', lvl: 3 }] }), '效率 III 不算无限')
  ok(!itemHasInfinity(null) && !itemHasInfinity({}), '空物品 / 无附魔 ⇒ false（不误判）')
  ok(itemHasInfinity({ enchants: { get x () { throw new Error('boom') } } }) === false, '读附魔时抛异常 ⇒ 当没有，不炸')

  /* ② 组件形状的无限弓：箭数不掉，连射不许被打断 */
  const b1 = makeBot({ items: [['bow', 1], ['arrow', 5]], consumeArrow: false })
  b1.__inv.find((i) => i.name === 'bow').componentMap = new Map([['enchantments', { data: [{ id: 'minecraft:infinity', level: 1 }] }]])
  const r1 = await shoot(b1, { x: 0, y: 70, z: 20, count: 2 }, ctxOf(() => GRADE, { pollMs: 0 }))
  ok(r1.fired === 2 && r1.ok === true, '组件形状的无限弓 ⇒ 两箭都算射出去、ok:true', JSON.stringify({ fired: r1.fired, ok: r1.ok, why: r1.why }))
  ok(r1.noConsume === true, '结果里标明 noConsume（不是"失败"）', String(r1.noConsume))

  /* ③ 附魔**完全认不出**、箭数也不掉 —— 但天上多了一支新箭 ⇒ 靠旁证判成功 */
  const b2 = makeBot({ items: [['bow', 1], ['arrow', 5]], consumeArrow: false })
  const origRelease = b2.deactivateItem.bind(b2)
  let arrowSeq = 900
  b2.deactivateItem = () => {
    origRelease()
    /* 放箭 → 服务端生成一支箭实体（真机就是这样；这里直接塞进 entities） */
    b2.entities[arrowSeq++] = { id: arrowSeq, name: 'arrow', position: new Vec3(1, 64, 1) }
  }
  const r2 = await shoot(b2, { x: 0, y: 70, z: 20, count: 2 }, ctxOf(() => GRADE, { pollMs: 0 }))
  ok(r2.fired === 2, '认不出的无限弓：靠"新箭实体"不打断连射', String(r2.fired))
  ok(r2.shots.every((s) => s.arrowEntity === true), '每一箭都标了 arrowEntity（旁证生效）', JSON.stringify(r2.shots.map((s) => s.arrowEntity)))
  ok(r2.ok === true, '整体 ok:true（不再假失败）', String(r2.ok))

  /* ④ 既认不出附魔、天上也没多箭 ⇒ 才是真的"没射出去"，该停 */
  const b3 = makeBot({ items: [['bow', 1], ['arrow', 5]], consumeArrow: false })
  const r3 = await shoot(b3, { x: 0, y: 70, z: 20, count: 2 }, ctxOf(() => GRADE, { pollMs: 0 }))
  ok(r3.fired === 1, '毫无证据 ⇒ 射一箭就停（不空耗）', String(r3.fired))
  ok(r3.ok === false && /没多出箭/.test(String(r3.why)), '报"箭数没变、天上也没多出箭"', String(r3.why ?? '').slice(0, 40))
}


section('⑯ 瞄点：hawkeye 默认瞄包围盒顶面，大个子要压到身体（用户 2026-10-19 / 2026-10-20 精简）')
{
  /* 用户原话：「弓现在使用是不是不够好…你往上搭高一点就不准了，瞄准的是翅膀那里，但碰撞箱在下面」。
     hawkeye 算的是 `position + (0, height, 0)`；末影龙 height=8 ⇒ 瞄的是翅膀上方。
     2026-10-20 用户：「把 auto body 和其他精简掉」⇒ 字符串名全删，只剩数字。 */
  const dragon = { type: 'mob', name: 'ender_dragon', position: new Vec3(0, 70, 40), height: 8 }
  ok(aimHeightFor({ entity: true, height: 8 }) === 2.8, '默认：龙（height 8）压到 +2.8 格（=8×0.35）', String(aimHeightFor({ entity: true, height: 8 })))
  ok(aimHeightFor({ entity: true, height: 1.95 }) === 0.975, '默认：普通怪（僵尸 1.95）瞄碰撞箱中心 0.975', String(aimHeightFor({ entity: true, height: 1.95 })))
  ok(aimHeightFor({ entity: true, height: 0.7 }) === 0.35, '默认：鸡（0.7 高）瞄中心 0.35（顶面是最上沿，会擦过去）', String(aimHeightFor({ entity: true, height: 0.7 })))
  ok(aimHeightFor({ entity: false, height: 0 }) === null, '默认：坐标目标不动（瞄那一格本身）')
  ok(aimHeightFor({ entity: true, height: 40 }) === 3, '默认：大得离谱也夹到 3 格（不瞄到天上去）')
  ok(aimHeightFor({ entity: true, height: 8 }, null) === 2.8, 'null 等同于不传')
  ok(aimHeightFor({ entity: true, height: 8 }, '') === 2.8, '空字符串等同于不传')
  ok(aimHeightFor({ entity: true, height: 8 }, '3') === 3, '数字字符串：直接给格数')
  ok(aimHeightFor({ entity: true, height: 8 }, 0.9) === 0.9, '数字 0.9（原来 shoot_low 的效果）')
  ok(aimHeightFor({ entity: true, height: 8 }, -1) === -1, '负数 ⇒ 往下瞄')
  ok(aimHeightFor({ entity: false, height: 0 }, '2') === 2, '坐标目标也能给数字（打水晶往柱顶上方抬）')
  /* 老写法不再有独立语义 —— 一律退回默认（宁可退回"更好的默认"，也别悄悄变成瞄顶面） */
  ok(aimHeightFor({ entity: true, height: 8 }, 'shoot_auto') === 2.8, '老写法 shoot_auto ⇒ 退回默认（龙 +2.8）')
  ok(aimHeightFor({ entity: true, height: 8 }, 'shoot_top') === 2.8, '老写法 shoot_top ⇒ 退回默认，不再瞄顶面')
  ok(aimHeightFor({ entity: true, height: 8 }, 'shoot_body') === 2.8, '老写法 shoot_body ⇒ 退回默认')
  ok(aimHeightFor({ entity: true, height: 8 }, 'shoot_low') === 2.8, '老写法 shoot_low ⇒ 退回默认')
  ok(aimHeightFor({ entity: false, height: 0 }, 'shoot_2') === null, 'shoot_2 不再当数字（退回默认）')

  const proxy = aimProxyFor(dragon, 2.8)
  ok(proxy !== dragon && proxy.height === 2.8 && proxy.position === dragon.position, '代理目标：换 height、留 position')
  ok('type' in proxy, "hawkeye 的 isEntity 判据是 'type' in e —— 代理对象要有 type")
  ok(aimProxyFor(dragon, null) === dragon, 'aimH 为 null ⇒ 原样传（老行为不变）')

  /* 真跑一遍：注入的 grade 收到的必须是"压过头的代理对象" */
  let got = null
  const b = makeBot({ items: [['bow', 1], ['arrow', 8]] })
  b.entities = { 7: dragon }
  const r = await shoot(b, { who: 'ender_dragon', count: 1, maxDist: 45 }, ctxOf((t) => { got = t; return GRADE }, { pollMs: 0 }))
  ok(got && Number(got.height) === 2.8, '射龙时 grade 拿到的是 height=2.8 的代理（不是 8）', JSON.stringify(got && got.height))
  ok(r.shots[0]?.aimY === 2.8, '结果里如实标着 aimY', JSON.stringify(r.shots[0]?.aimY))
}

/* ────────────────── ⑰ 弹道太糙就别放箭（用户「尽量不空就行」） ────────────────── */
section('⑰ 弹道误差太大 ⇒ 一箭都不放')
{
  const rough = { ...GRADE, nearestDistance: 1.18 }
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 8]] })
    const r = await shoot(b, { x: 0, y: 70, z: 20, count: 1 }, ctxOf(() => rough))
    ok(r.fired === 0, 'aimError 1.18 > 0.4 ⇒ 不放箭', String(r.fired))
    ok(!b.__log.some((e) => e[0] === 'activate'), '连弓都没拉')
    ok(/这一箭会空/.test(String(r.why ?? '')), 'why 说清楚"这一箭会空"', String(r.why ?? ''))
  }
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 8]] })
    const r = await shoot(b, { x: 0, y: 70, z: 20, count: 1 }, ctxOf(() => GRADE))
    ok(r.fired === 1, 'aimError 0.3 ≤ 0.4 ⇒ 正常放箭', String(r.fired))
  }
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 8]] })
    const r = await shoot(b, { x: 0, y: 70, z: 20, count: 1 }, ctxOf(() => rough, { maxAimError: 2 }))
    ok(r.fired === 1, 'ctx.maxAimError 覆盖成 2 ⇒ 1.18 也放箭', String(r.fired))
  }
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 8]] })
    const r = await shoot(b, { x: 0, y: 70, z: 20, count: 1 }, ctxOf(() => rough, { maxAimError: 0 }))
    ok(r.fired === 1, 'maxAimError 0 = 关掉这道闸（老行为）', String(r.fired))
  }
}

section('⑱ 拉满之后端着等，命中率高了再放')
{
  const mkDragon = () => {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
    const e = { name: 'ender_dragon', type: 'mob', position: new Vec3(0, 70, 22), height: 8, isValid: true, velocity: new Vec3(0, 0, 0) }
    b.entities = { 1: e }
    return b
  }
  /* 前两次弹道很糙（1.4 格），端着等之后变准（0.25 格）⇒ 等到准了才放 */
  {
    let n = 0
    const grade = () => { n++; return { ...GRADE, nearestDistance: n <= 2 ? 1.4 : 0.25 } }
    const b = mkDragon()
    const r = await shoot(b, { who: 'ender_dragon', count: 1 }, ctxOf(grade, { holdMaxMs: 600 }))
    ok(r.fired === 1, '端着等到准的那一刻放箭', String(r.fired))
    ok(n >= 3, '端着的时候反复重解弹道', String(n))
    ok(typeof r.shots?.[0]?.heldMs === 'number', '结果记了 heldMs', JSON.stringify(r.shots?.[0] ?? {}))
    ok(b.__log.filter((e) => e[0] === 'activate').length === 1, '只拉一次弓')
    ok(b.__log.filter((e) => e[0] === 'release').length === 1, '放箭一次（不多按）')
  }
  /* 一开始就准 ⇒ 不多等 */
  {
    let n = 0
    const grade = () => { n++; return { ...GRADE, nearestDistance: 0.2 } }
    const b = mkDragon()
    const r = await shoot(b, { who: 'ender_dragon', count: 1 }, ctxOf(grade, { holdMaxMs: 600 }))
    ok(r.fired === 1, '一开始就准 ⇒ 照常射', String(r.fired))
    ok(n === 2, '一开始就准 ⇒ 只解两次（拉弓前 + 拉满后）', String(n))
  }
  /* 一直不准 ⇒ 端到上限**不放**（用户：「等不到不放」） */
  {
    let n = 0
    const grade = () => { n++; return { ...GRADE, nearestDistance: 1.4 } }
    const b = mkDragon()
    const r = await shoot(b, { who: 'ender_dragon', count: 1 }, ctxOf(grade, { holdMaxMs: 80 }))
    ok(r.fired === 0, '端到上限还不准 ⇒ 这一箭不放', String(r.fired))
    ok(n >= 2, '端着期间重解过弹道', String(n))
    ok(!b.__log.some((e) => e[0] === 'release'), '不放的时候没有撒手（撒手=放箭）', JSON.stringify(b.__log.filter((e) => e[0] === 'release')))
    ok(/这一箭没放|没放/.test(String(r.why ?? '')), 'why 说清楚"这一箭没放"', String(r.why ?? ''))
  }
  /* 只给末影龙开：僵尸目标不端着等，弹道糙就不放 */
  {
    let n = 0
    const grade = () => { n++; return { ...GRADE, nearestDistance: 1.4 } }
    const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
    const e = { name: 'zombie', type: 'mob', position: new Vec3(0, 70, 15), height: 1.9, isValid: true, velocity: new Vec3(0, 0, 0) }
    b.entities = { 2: e }
    const r = await shoot(b, { who: 'zombie', count: 1 }, ctxOf(grade, { holdMaxMs: 600 }))
    ok(r.fired === 0, '僵尸：弹道糙就不放（不端着等）', String(r.fired))
    ok(r.shots?.[0]?.heldMs === undefined, '僵尸：没有 heldMs', JSON.stringify(r.shots?.[0] ?? {}))
  }
  /* 坐标目标没有"端着等"这一套 */
  {
    const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
    const r = await shoot(b, { x: 0, y: 70, z: 20, count: 1 }, ctxOf(() => GRADE, { holdMaxMs: 600 }))
    ok(r.fired === 1 && r.shots?.[0]?.heldMs === undefined, '坐标目标：没有 heldMs', JSON.stringify(r.shots?.[0] ?? {}))
  }
}


section('⑨ maxDist：太远就不射（用户 2026-10-19：「maxDist可以改，那个不是你测出来的吗」）')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  b.entities = { 1: { name: 'zombie', position: new Vec3(0, 64, 30), height: 1.8 } }
  const r = await shoot(b, { who: 'zombie', maxDist: 25, count: 1 }, ctxOf(() => GRADE))
  ok(r.fired === 0, 'maxDist：目标 30 格 > 25 → 一箭不放', JSON.stringify(r.fired))
  ok(/没射/.test(String(r.why ?? '')), 'maxDist：原因写清楚了', JSON.stringify(r.why ?? ''))
  ok(Array.isArray(r.shots) && r.shots.length === 0, 'maxDist：连引弦都没拉', JSON.stringify(r.shots ?? []))

  const b2 = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  b2.entities = { 1: { name: 'zombie', position: new Vec3(0, 64, 10), height: 1.8 } }
  const r2 = await shoot(b2, { who: 'zombie', maxDist: 25, count: 1 }, ctxOf(() => GRADE))
  ok(r2.fired === 1, 'maxDist：10 格 ≤ 25 → 照射', JSON.stringify(r2.fired))

  const b3 = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  b3.entities = { 1: { name: 'zombie', position: new Vec3(0, 64, 30), height: 1.8 } }
  const r3 = await shoot(b3, { who: 'zombie', count: 1 }, ctxOf(() => GRADE))
  ok(r3.fired === 1, 'maxDist 不给（默认关）→ 不限距离', JSON.stringify(r3.fired))
}
section('⑩ 高抛解不吃：仰角 > 45° 改用平射解（用户 2026-10-19「优先平射」）')
{
  /* 实机证据（同一颗静止末影水晶）：22 格 ⇒ hawkeye 给 pitch 83.5°，箭落在 z=16、靶在 z=20（短 4 格），
   * 靶还在；走到 19.7 格 ⇒ pitch 3.9°，一发就炸。所以"高抛解"不可信，要优先平射。 */
  const shootMod = await import(new URL('../src/shoot.mjs', import.meta.url))
  ok(shootMod.LOW_ARC_MAX_DEG === 45, 'LOW_ARC_MAX_DEG = 45', String(shootMod.LOW_ARC_MAX_DEG))
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../src/shoot.mjs', import.meta.url), 'utf8')
  ok(/const gdeg = Math\.abs\(Number\(grade\.pitch\) \|\| 0\) \* 180 \/ Math\.PI/.test(src), 'gradeOf 把 hawkeye 的仰角换成度数')
  ok(/if \(gdeg <= LOW_ARC_MAX_DEG\) return polish\(grade, aimed, speed\)/.test(src), '平射解（≤45°）直接采用（再过一道遮挡闸）')
  ok(/fallbackGrade\(aimed, speed, \{ preferLow: true \}\)/.test(src), '高抛解时改用 preferLow 的兜底解')
  ok(/solveArrowLead\(\{ from, to, vel: speed, speed: spd0, preferLow \}\)/.test(src), 'preferLow 透传给 solveArrowLead')
  /* 2026-10-25 用户「现在弓箭只会平射，不会抛射」：遮挡检测 + 换高抛 */
  ok(/const blockedAlong = \(pitch, yaw, to, speed\) =>/.test(src), '有沿弹道采样查方块的 blockedAlong')
  ok(/blk\.boundingBox === 'block'/.test(src), '只把实心方块当挡（水/草/火把能穿）')
  /* 🔴 2026-10-26 实机「打末影水晶还是只能用平射」：读不到一格就 `return unknown` ⇒ 远处区块没加载时
     等于永远查不出挡。现在记一笔继续采样，一路都读不到才算不知道。 */
  ok(/if \(!blk\) \{ unknown = true; return null \}/.test(src), '读不到区块：记一笔、这一格不算挡，外层继续往后采样（别一格未知就放过整条轨迹）')
  ok(/return unknown \? \{ name: null, unknown: true \} : null/.test(src), '一路都读不到才算不知道（不知道 ≠ 挡）')
  ok(/if \(d < 0\.6\) return null/.test(src), '只跳过自己那一格（0.6），贴脸的墙不再漏检')
  ok(/const seg = Math\.hypot\(p\.x - px, p\.y - py, p\.z - pz\)/.test(src), '🔴 一 tick 走 3 格：沿段内插值采样（不然 1 格厚的柱子被整段跨过）')
  ok(/Math\.ceil\(seg \/ 0\.4\)/.test(src), '插值步长 ≤ 0.4 格')
  ok(/const blk = toV \? blockedAlong\(low\.pitch, low\.yaw, toV, arrowSpeedFor\(estDrawMs\)\) : null/.test(src),
    '🔴 「优先平射」降级前先查这条平射通不通（水晶在柱顶，平射撞柱子）')
  ok(/const toV = aimP \? new Vec3\(aimP\.x, aimP\.y \+ Number\(aimed\?\.height \?\? 0\), aimP\.z\) : null/.test(src),
    '🔴 预检自己算瞄准点（`to` 在该作用域不存在，实机报过 `to is not defined`）')
  ok(!/blockedAlong\(low\.pitch, low\.yaw, to,/.test(src), '别再用未定义的 `to`')
  ok(/const alt = fallbackGrade\(aimed, speed, \{ clearOf: true \}\)/.test(src), '被挡时换 clearOf 的抛射解')
  ok(/lob: Math\.abs\(c\.deg\) > 10/.test(src), '仰角 >10° 标成 lob（抛射）')
  ok(/if \(!hit \|\| hit\.unknown\) return g/.test(src), '没挡/不知道 ⇒ 用原解')
}

/* ───────── ⑲ 打龙的两道实机闸：落地免疫投射物 / 默认 25 格射程（2026-10-20） ───────── */
section('⑲ 末影龙：落地免疫投射物 + 默认射程 25 格')
{
  const shootMod = await import(new URL('../src/shoot.mjs', import.meta.url))
  ok(shootMod.DRAGON_MAX_DIST === 25, 'DRAGON_MAX_DIST = 25', String(shootMod.DRAGON_MAX_DIST))
  /* 判据：x/z 贴近祭坛原点、y 掉到 68 以下 ⇒ 落地 */
  ok(shootMod.isDragonPerched({ position: new Vec3(0, 61, 0) }) === true, '祭坛上 (0,61,0) ⇒ 判为落地')
  ok(shootMod.isDragonPerched({ position: new Vec3(3, 64, -2) }) === true, '祭坛附近 (3,64,-2) ⇒ 判为落地')
  ok(shootMod.isDragonPerched({ position: new Vec3(0, 80, 0) }) === false, '飞在 y=80 ⇒ 不是落地')
  ok(shootMod.isDragonPerched({ position: new Vec3(40, 64, 40) }) === false, '远在 40,40 就算低也不是祭坛落地')
  ok(shootMod.isDragonPerched({}) === false, '没有 position ⇒ 不判落地（不误伤）')

  /* 落地 ⇒ 一箭都不射（实测那支箭确实射出去了，但 /data get 前后血一样 = 0 伤害） */
  const bp = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  bp.entities = { 9: { name: 'ender_dragon', type: 'mob', position: new Vec3(0, 61, 0), height: 8, isValid: true } }
  const rp = await shoot(bp, { who: 'ender_dragon', count: 1 }, ctxOf(() => GRADE))
  ok(rp.fired === 0, '落地时：一箭不放', JSON.stringify(rp.fired))
  ok(/免疫投射物/.test(String(rp.why ?? '')), '落地时：why 说清"免疫投射物"', JSON.stringify(rp.why ?? ''))
  ok(Array.isArray(rp.shots) && rp.shots.length === 0, '落地时：连弓都没拉', JSON.stringify(rp.shots ?? []))

  /* 飞着但超过 25 格 ⇒ 自动闸挡住 */
  const bf = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  bf.entities = { 9: { name: 'ender_dragon', type: 'mob', position: new Vec3(0, 80, 40), height: 8, isValid: true } }
  const rf = await shoot(bf, { who: 'ender_dragon', count: 1 }, ctxOf(() => GRADE))
  ok(rf.fired === 0, '飞着 40 格 ⇒ 默认闸挡住（一箭不放）', JSON.stringify(rf.fired))
  ok(/maxDist=25/.test(String(rf.why ?? '')), '默认闸：why 里写明 maxDist=25', JSON.stringify(rf.why ?? ''))

  /* 飞着且在 25 格内 ⇒ 照射 */
  const bn = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  bn.entities = { 9: { name: 'ender_dragon', type: 'mob', position: new Vec3(0, 75, 18), height: 8, isValid: true } }
  const rn = await shoot(bn, { who: 'ender_dragon', count: 1 }, ctxOf(() => GRADE))
  ok(rn.fired === 1, '飞着 18 格 ⇒ 照射', JSON.stringify(rn.fired))

  /* 别的怪不受这道自动闸影响（默认仍然是"不限距离"） */
  const bz = makeBot({ items: [['bow', 1], ['arrow', 10]] })
  bz.entities = { 1: { name: 'zombie', position: new Vec3(0, 64, 40), height: 1.8 } }
  const rz = await shoot(bz, { who: 'zombie', count: 1 }, ctxOf(() => GRADE))
  ok(rz.fired === 1, '僵尸 40 格：自动闸只管龙，不管别的目标', JSON.stringify(rz.fired))
}

/* ────────────────────────── ⑱ 平射被墙挡住 ⇒ 自动改抛射（用户 2026-10-25） ────────────────────────── */
section('⑱ 平射撞墙 ⇒ 换高抛（真 hawkeye + 假方块世界）')
{
  /* 假世界：z=8~10、y=64~68 立一堵墙，正好挡在 20 格目标的平射线上 */
  const wall = (pos) => {
    if (!pos) return { name: 'air', boundingBox: 'empty' }
    if (pos.z >= 8 && pos.z <= 10 && pos.y >= 64 && pos.y <= 68) return { name: 'stone', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  }
  const mkZombie = (b) => {
    b.entities = { 1: { id: 1, name: 'zombie', displayName: 'Zombie', height: 1.95, isValid: true, metadata: {}, position: new Vec3(0, 64, 20) } }
    return b
  }
  {
    const b = mkZombie(makeBot({ items: [['bow', 1], ['arrow', 10]], blockAt: wall }))
    const r = await shoot(b, { who: 'zombie', waitTime: 5 }, ctxOf(undefined))
    const s0 = r.shots[0] ?? {}
    ok(s0.lob === true, '平射被挡 ⇒ 这一箭改抛射（lob:true）', JSON.stringify(s0))
    ok(s0.lobOver === 'stone', '结果里说清越过的是什么方块', String(s0.lobOver))
    ok(Math.abs(Number(s0.pitchDeg) || 0) > 10, '抛射的仰角 > 10°', String(s0.pitchDeg))
    ok(s0.blockedBy === undefined, '改抛射后不再报 blockedBy')
  }
  {
    /* 没有墙：还是平射（别把抛射当默认） */
    const b = mkZombie(makeBot({ items: [['bow', 1], ['arrow', 10]] }))
    const r = await shoot(b, { who: 'zombie', waitTime: 5 }, ctxOf(undefined))
    const s0 = r.shots[0] ?? {}
    ok(s0.lob === undefined && s0.lobOver === undefined, '没遮挡 ⇒ 不抛射（老行为不变）', JSON.stringify(s0))
    ok(Math.abs(Number(s0.pitchDeg) || 0) <= 10, '没遮挡 ⇒ 平射（|pitch| ≤ 10°）', String(s0.pitchDeg))
  }
}


/* ── ⑲ 目标在高处（水晶在柱顶）+ 平射被柱子挡 ⇒ 必须抛射（2026-10-26 实机） ── */
section('⑲ 打高处目标（柱顶）：平射撞柱子 ⇒ 抛射')
{
  const world = (pos) => {
    if (!pos) return { name: 'air', boundingBox: 'empty' }
    if (pos.x === 0 && pos.z >= 6 && pos.z <= 7 && pos.y >= 64 && pos.y <= 71) return { name: 'obsidian', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  }
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]], blockAt: world })
  b.entities = { 1: { id: 1, name: 'zombie', displayName: 'Zombie', height: 1.95, isValid: true, metadata: {}, position: new Vec3(0, 73, 20) } }
  const r = await shoot(b, { who: 'zombie', waitTime: 5 }, ctxOf(undefined))
  const s0 = r.shots[0] ?? {}
  ok(s0.lob === true, '柱顶目标 ⇒ 抛射（lob:true），不是平射', JSON.stringify(s0))
  ok(Math.abs(Number(s0.pitchDeg) || 0) > 10, '仰角 > 10°', String(s0.pitchDeg))
  ok(Number(s0.aimError) <= 1.5, '落点误差仍然可接受', String(s0.aimError))
}

/* ── ⑳ 实机原样：{aim:35, who:"end_crystal"} 曾报 `to is not defined` ── */
section('⑳ 带 aim 抬高打高处目标：不再抛 to is not defined')
{
  const b = makeBot({ items: [['bow', 1], ['arrow', 10]], blockAt: () => ({ name: 'air', boundingBox: 'empty' }) })
  b.entities = { 2: { id: 2, name: 'end_crystal', displayName: 'End Crystal', height: 2, isValid: true, metadata: {}, position: new Vec3(0, 90, 20) } }
  let out = null
  let err = null
  try { out = await shoot(b, { who: 'end_crystal', aim: 35, waitTime: 5 }, ctxOf(undefined)) } catch (e) { err = e }
  ok(!err, 'aim:35 + 高处目标不再抛错', String(err?.message))
  ok(Array.isArray(out?.shots), '照常返回射击记录', JSON.stringify(out)?.slice(0, 80))
  ok(/crystal/i.test(String(out?.target?.name ?? '')), '认得出末影水晶这个目标', String(out?.target?.name))
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
