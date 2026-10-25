#!/usr/bin/env node
/**
 * check-dig-sight.mjs —— 「不能隔着方块挖」的回归检查
 *
 * 判据（2026-10-25 三次收敛后的定稿，用户原话「改成方块前后左右有一格方块是空的就可以挖」）：
 *   ① 贴身 1 格（脚下 / 头顶 / 水平相邻 / 斜角）一律放行
 *   ② 前后左右四格只要有一格是空的（空气 / 可通行）⇒ 能挖
 *   ③ 四面全被实心包住 ⇒ 才是"隔着方块挖"，拦下并说清是哪面
 *   ④ 读不到方块 / 够不着 ⇒ 不拦（判不了就别拒绝干活）
 *
 * 用法：node tools/check-dig-sight.mjs（必须从包目录跑，理由见 check-core-dig.mjs 顶部）
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑。')
  process.exit(2)
}
const Vec3 = req('vec3')
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))
const { canSeeBlockOf } = await import(new URL('../src/mining.mjs', import.meta.url))

const TMP = []

/**
 * 假 bot：目标方块在 (0,64,3)，玩家站在 (0,64,0)。
 *   `open` = 'north' → 北面 (0,64,2) 是空气，其余三面实心（有一面空 ⇒ 能挖）
 *   `open` = 'none'  → 前后左右四面全是 stone（四面被包 ⇒ 拦）
 *   `open` = null    → 邻居读不到（blockAt 返回 null）⇒ 判不了，不拦
 */
const mkBot = ({ open = 'north' } = {}) => {
  const calls = { dig: 0 }
  const state = { dug: false }
  const mk = (name, bb, x, y, z) => ({ name, type: 0, boundingBox: bb, position: new Vec3(x, y, z) })
  const target = mk('iron_ore', 'block', 0, 64, 3)
  const isTarget = (p) => Boolean(p) && p.x === 0 && p.y === 64 && p.z === 3
  const bot = {
    entity: { position: new Vec3(0, 64, 0), onGround: true },
    game: { gameMode: 'survival' },
    registry: { itemsByName: {}, blocksByName: {}, items: {}, blocksByStateId: { 200: { name: 'iron_ore' } } },
    inventory: { items: () => [] },
    heldItem: null,
    blockAt: (p) => {
      if (!p) return null
      if (isTarget(p)) return state.dug ? mk('air', 'empty', 0, 64, 3) : target
      if (open === null) return null
      if (open === 'north' && p.x === 0 && p.y === 64 && p.z === 2) return mk('air', 'empty', 0, 64, 2)
      return mk('stone', 'block', p.x, p.y, p.z)
    },
    findBlocks: () => [],
    findBlock: () => null,
    setControlState: () => {},
    on: () => bot,
    removeListener: () => {},
    dig: async () => { calls.dig++; state.dug = true },
    pathfinder: { goto: async () => {}, stop: () => {}, setMovements: () => {} },
  }
  return { bot, calls, state, target }
}

const mkMc = (fake) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-digsight-'))
  TMP.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = fake.bot
  mc.mcPlugins = {}
  mc.pfReady = true
  mc._pf = {
    goals: { GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } } },
    Movements: class { constructor () {} },
  }
  mc.cfg.collectBudgetMs = 300
  return mc
}

/* ─────────── ① 四面全实心 ⇒ 一格都不挖 ─────────── */
section('① 前后左右四面全被实心包住 ⇒ 不挖，并说清挡着的是哪面')
{
  const fake = mkBot({ open: 'none' })
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(fake.calls.dig === 0, '没调用 bot.dig（一格都没挖）', `dig=${fake.calls.dig}`)
  ok(out.some((l) => /隔着方块挖不了/.test(l)), '明说"隔着方块挖不了"', String(out[0]).slice(0, 90))
  ok(out.some((l) => /\*\*stone\*\*/.test(l)), '报出挡着的方块名', String(out[0]).slice(0, 90))
  ok(out.some((l) => /x:0, y:64, z:2/.test(l)), '给出其中一面的坐标（可以去挖它）')
}

/* ─────────── ② 有一面是空的 ⇒ 照常挖 ─────────── */
section('② 前后左右有一格是空的 ⇒ 照常挖')
{
  const fake = mkBot({ open: 'north' })
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(fake.calls.dig === 1, '调用了 bot.dig', `dig=${fake.calls.dig}`)
  ok(/挖掉 iron_ore/.test(out[0] ?? ''), '报了"挖掉 iron_ore"', String(out[0]).slice(0, 80))
  ok(!out.some((l) => /隔着方块/.test(l)), '没有误报"隔着方块"')
}

/* ─────────── ③ 判不了 ⇒ 不拦 ─────────── */
section('③ 邻居读不到（区块没加载）⇒ 不拦（不能凭空拒绝干活）')
{
  const fake = mkBot({ open: null })
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(fake.calls.dig === 1, '读不到邻居时照常挖', `dig=${fake.calls.dig}`)
  ok(!out.some((l) => /隔着方块/.test(l)), '没有误报')
}

/* ─────────── ④ mc_act {mode:"break"} 同一条判据 ─────────── */
section('④ breakBlock 也走同一条判据')
{
  const fake = mkBot({ open: 'none' })
  const mc = mkMc(fake)
  const r = await mc.breakBlock({ x: 0, y: 64, z: 3 })
  ok(r?.broken === false, 'broken=false', JSON.stringify({ broken: r?.broken }))
  ok(r?.blockedBy === 'stone', 'blockedBy=stone', String(r?.blockedBy))
  ok(/隔着方块挖不了/.test(r?.note ?? ''), 'note 里说清隔着方块', String(r?.note).slice(0, 80))
  ok(fake.calls.dig === 0, '没调用 bot.dig', `dig=${fake.calls.dig}`)

  const fake2 = mkBot({ open: 'north' })
  const mc2 = mkMc(fake2)
  const r2 = await mc2.breakBlock({ x: 0, y: 64, z: 3 })
  ok(r2?.broken === 'iron_ore', '有一面空时照常挖掉（broken=方块名）', JSON.stringify({ broken: r2?.broken }))
}

/* ─────────── ⑤ 单元：canSeeBlockOf 的三种返回 ─────────── */
section('⑤ canSeeBlockOf：能挖 / 四面被包 / 判不了')
{
  const t = mkBot({ open: 'north' })
  const r1 = await canSeeBlockOf(t.bot, { x: 0, y: 64, z: 3 })
  ok(r1?.ok === true, '有一面空 ⇒ {ok:true}', JSON.stringify(r1))

  const w = mkBot({ open: 'none' })
  const r2 = await canSeeBlockOf(w.bot, { x: 0, y: 64, z: 3 })
  ok(r2?.ok === false && r2?.blocker === 'stone', '四面被包 ⇒ {ok:false, blocker:stone}', JSON.stringify(r2))
  ok(r2?.at?.x === 0 && r2?.at?.y === 64 && r2?.at?.z === 2, 'at 是其中一面的坐标', JSON.stringify(r2?.at))

  const n = mkBot({ open: null })
  const r3 = await canSeeBlockOf(n.bot, { x: 0, y: 64, z: 3 })
  ok(r3 === null, '读不到邻居 ⇒ null（不拦）', JSON.stringify(r3))
}

/* ─────────── ⑥ 贴身 1 格一律放行 ─────────── */
section('⑥ 贴身（脚下/头顶/水平相邻 1 格）一律放行')
{
  /* 用户原话：「现在判定又太严了，在附近1格就行。刚刚站在铁矿上都挖不了」——
   * 玩家站在 (0,64,0)，脚下那块是 (0,63,0)。 */
  const w = mkBot({ open: 'none' })
  const under = await canSeeBlockOf(w.bot, { x: 0, y: 63, z: 0 })
  ok(under?.ok === true, '脚下那块放行（站着挖脚下方块不判遮挡）', JSON.stringify(under))
  const head = await canSeeBlockOf(w.bot, { x: 0, y: 65, z: 0 })
  ok(head?.ok === true, '头顶那块放行', JSON.stringify(head))
  const side = await canSeeBlockOf(w.bot, { x: 1, y: 64, z: 0 })
  ok(side?.ok === true, '水平相邻 1 格放行', JSON.stringify(side))
  const diag = await canSeeBlockOf(w.bot, { x: 1, y: 63, z: 1 })
  ok(diag?.ok === true, '斜下方 1 格也放行', JSON.stringify(diag))
  /* 离开 1 格以外才看四面：这一格四面全实心，照样拦。 */
  const far = await canSeeBlockOf(w.bot, { x: 0, y: 64, z: 3 })
  ok(far?.ok === false && far?.blocker === 'stone', '3 格外仍按四面判（不放松）', JSON.stringify(far))
}

for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\ncheck-dig-sight：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
