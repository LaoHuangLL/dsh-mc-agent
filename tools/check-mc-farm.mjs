#!/usr/bin/env node
/**
 * 睡觉 / 耕地播种自检 —— `src/farm.mjs`
 *
 * 🔴 起因（用户 2026-10-23「1档和2档做一下」）：一档第 4 条 = 睡觉 + 耕地播种。抄 mindcraft 的
 *    `goToBed` / `tillAndSow`（`skills.js:1543` / `:1575`），但那边 `activateBlock` 一发了事、
 *    成功与否看不出来。我们没有"发了就当成了"的余地，所以每一步都要回读。
 *
 * 钉死这几件事：
 *   ① 白天/不下雷雨 ⇒ 直接 `daytime`，不白走一趟（`timeOfDay` 读不到时**不拦**，私人服可能没时间）；
 *   ② 附近没床 ⇒ `no-bed` 并指路（`mc_craft white_bed` + `mc_act place`）；给坐标不是床 ⇒ `not-a-bed`；
 *   ③ 床太远先走过去（`self.walkTo`，intent=interact），走不到 ⇒ `too-far` 而不是硬点；
 *   ④ 走过去那十来秒里床被拆 ⇒ `bed-gone`；
 *   ⑤ `bot.sleep` 的报错翻译成人话（白天/有人躺着/有怪/太远/半张床）—— 不把英文原文丢给模型；
 *   ⑥ 点了床但 `isSleeping` 还是 false ⇒ `not-sleeping`（服务端没让躺下）；
 *   ⑦ 躺上了要区分"醒了"和"还躺着"（多人服要所有人才跳夜）；
 *   ⑧ 作物熟不熟按 `age >= num_values - 1` 判，查不到就 `null`（不知道就别当熟）；
 *   ⑨ 播种/锄地**每格都回读**：锄完不是 farmland ⇒ `till-unconfirmed`；撒了种子没长出作物 ⇒ `sow-unconfirmed`；
 *   ⑩ 没锄头 ⇒ `no-hoe` 并指 `mc_craft wooden_hoe`；种子用完 ⇒ 跳过并不当失败；
 *   ⑪ 时间不够 ⇒ 剩下的进 `remaining`（再叫一次接着干）；
 *   ⑫ 插件面接线：`index.js` 的 `mc_act` 有 sleep/wake/farm 三个 mode + 参数，并直接调 `src/farm.mjs`（`core.mjs` 卡在 ≤1000 行，不再往门面上加薄包装）。
 *
 * 用法：node tools/check-mc-farm.mjs
 */
import { readFileSync } from 'node:fs'
import {
  sleepInBed, wakeUp, farmArea, nightStateOf, bedNear, matureOf, maxAgeOf, ageOf,
  hoeOf, seedOf, farmSpotsNear, sleepErrorText, SEED_TO_CROP, CROP_TO_SEED, TILLABLE,
  NIGHT_FROM, NIGHT_TO, BED_REACH,
} from '../src/farm.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

/** 带 `distanceTo` 的位置（模块里全靠这套调用）。 */
const P = (x, y, z) => ({
  x, y, z,
  distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) },
})

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const block = (name, x, y, z, age = null) => ({
  name, type: 1, position: P(x, y, z),
  getProperties: () => (age == null ? {} : { age }),
})

const REGISTRY = {
  blocksByName: {
    wheat: { states: [{ name: 'age', num_values: 8 }] },
    carrots: { states: [{ name: 'age', num_values: 8 }] },
    potatoes: { states: [{ name: 'age', num_values: 8 }] },
    beetroots: { states: [{ name: 'age', num_values: 4 }] },
    farmland: { states: [{ name: 'moisture', num_values: 8 }] },
  },
}

/**
 * 假 bot。
 *  · `world` 是 `"x,y,z" → 方块名` 的字典；`blockAt` 只认这里有的格子（没有 = 未加载，回 null）
 *  · `sleep(blk)` 按原版行为：`sleepError` 给了就抛，否则把 `isSleeping` 置 true
 *  · `activateBlock(blk)` 按手上拿的东西改世界：锄头 ⇒ farmland；种子 ⇒ 上面长出作物
 */
function fakeBot ({
  me = { x: 0, y: 64, z: 0 },
  world = {},
  beds = [],
  items = [],
  timeOfDay = 15_000,
  raining = false,
  thunder = 0,
  sleepError = null,
  wakeOnSleep = true,
  tillWorks = true,
  sowWorks = true,
  isSleeping = false,
} = {}) {
  const w = new Map(Object.entries(world))
  const inv = items.map((it) => ({ ...it }))
  const bot = {
    calls: [],
    held: null,
    beds,
    isSleeping,
    isRaining: raining,
    thunderState: thunder,
    time: { timeOfDay },
    entity: { position: P(me.x, me.y, me.z) },
    inventory: { items: () => inv },
    registry: REGISTRY,
    blockAt (p) {
      const n = w.get(key(p))
      return n ? block(n, p.x, p.y, p.z, bot.ages?.get(key(p)) ?? null) : null
    },
    findBlocks ({ matching, maxDistance } = {}) {
      return (bot.beds ?? [])
        .map((b) => ({ ...b, name: b.name ?? 'red_bed' }))
        .filter((b) => b.position.distanceTo(bot.entity.position) <= (maxDistance ?? 32))
        .filter((b) => (typeof matching === 'function' ? matching(b) : true))
        .map((b) => b.position)
    },
    async sleep (blk) {
      bot.calls.push(['sleep', blk.position.x, blk.position.y, blk.position.z])
      if (sleepError) throw new Error(sleepError)
      bot.isSleeping = true
      if (wakeOnSleep) setTimeout(() => { bot.isSleeping = false }, 600) // 躺上 0.6 秒后自己醒（默认懒）
    },
    async wake () {
      bot.calls.push(['wake'])
      if (!bot.isSleeping) throw new Error('already awake')
      bot.isSleeping = false
    },
    async activateBlock (blk) {
      const p = key(blk.position)
      bot.calls.push(['activate', p, bot.held])
      if (/_hoe$/.test(bot.held ?? '')) {
        if (tillWorks) w.set(p, 'farmland')
        return
      }
      const crop = SEED_TO_CROP[bot.held]
      if (crop && sowWorks) w.set(`${blk.position.x},${blk.position.y + 1},${blk.position.z}`, crop)
    },
  }
  return bot
}

function fakeSelf (bot, { msLeft = () => 9_000, arrive = true, walkError = null, breakWorks = true } = {}) {
  return {
    requireBot: () => bot,
    msLeft,
    async walkTo (target, opts = {}) {
      bot.calls.push(['walkTo', target.x, target.y, target.z, opts.intent])
      if (walkError) throw new Error(walkError)
      if (arrive) bot.entity.position = P(target.x, target.y, target.z)
      return { arrived: arrive, remaining: arrive ? 0 : 9, intent: opts.intent }
    },
    async equip ({ name } = {}) {
      bot.held = name
      bot.calls.push(['equip', name])
      return { equipped: true, to: 'hand', held: name }
    },
    async breakBlock (pos) {
      bot.calls.push(['break', pos.x, pos.y, pos.z])
      if (!breakWorks) return { broken: false }
      bot.worldSet?.()
      return { broken: true }
    },
  }
}

const item = (name, count = 1) => ({ name, count, type: 1, displayName: name })

/* ────────────────── ① 夜里能不能睡 ────────────────── */
section('① nightStateOf：白天/夜里/雷雨/读不到时间')
{
  const night = nightStateOf({ time: { timeOfDay: 15_000 } })
  ok(night.night === true && night.thunder === false, '傍晚 15000 ⇒ 能睡', JSON.stringify(night))
  const day = nightStateOf({ time: { timeOfDay: 4_000 } })
  ok(day.night === false, '上午 4000 ⇒ 不能睡', JSON.stringify(day))
  const thunder = nightStateOf({ time: { timeOfDay: 4_000 }, isRaining: true, thunderState: 1 })
  ok(thunder.night === false && thunder.thunder === true, '白天打雷 ⇒ thunder=true（能睡）')
  const noTime = nightStateOf({})
  ok(noTime.night === true && noTime.timeOfDay === null, '读不到时间 ⇒ 不拦（night=true, timeOfDay=null）', JSON.stringify(noTime))
  ok(nightStateOf({ time: { timeOfDay: NIGHT_FROM } }).night === true, '刚好 12541 算夜里')
  ok(nightStateOf({ time: { timeOfDay: NIGHT_TO } }).night === true, '刚好 23458 也算夜里')
  ok(nightStateOf({ time: { timeOfDay: NIGHT_TO + 1 } }).night === false, '23459 就不算了')
}

/* ────────────────── ② 找床 ────────────────── */
section('② bedNear：只认床，选最近的一张')
{
  const bot = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '10,64,0': 'red_bed', '3,64,0': 'blue_bed', '5,64,0': 'oak_planks' },
    beds: [{ position: P(10, 64, 0) }, { position: P(3, 64, 0) }],
  })
  const hit = bedNear(bot, 32)
  ok(hit && hit.pos.x === 3, '两张床里挑最近的（x=3）', JSON.stringify(hit?.pos))
  ok(hit && hit.d === 3, '距离报的是 3', String(hit?.d))
  ok(bedNear(bot, 2) === null, '半径 2 够不着 ⇒ null')
  const none = fakeBot({ world: { '1,64,0': 'red_bed' }, beds: [{ position: P(1, 64, 0) }] })
  ok(bedNear({ ...none, blockAt: () => null }, 32) === null, '位置有但方块没加载 ⇒ null（不瞎睡）')
}

/* ────────────────── ③ 睡觉 ────────────────── */
section('③ sleepInBed：白天 / 没床 / 太远 / 有人躺 / 躺上了')
{
  const day = fakeBot({ timeOfDay: 3_000 })
  const r1 = await sleepInBed(fakeSelf(day), {})
  ok(r1.ok === false && r1.reason === 'daytime', '白天 ⇒ reason=daytime', r1.text)
  ok(/白天/.test(r1.text) && /床/.test(r1.text), '白天要把"点了也没用"说清楚', r1.text)
  ok(day.calls.length === 0, '白天一次动作都不做（不白走）', JSON.stringify(day.calls))

  const nobed = fakeBot({ me: { x: 0, y: 64, z: 0 }, world: {} })
  const r2 = await sleepInBed(fakeSelf(nobed), { radius: 16 })
  ok(r2.ok === false && r2.reason === 'no-bed', '没床 ⇒ no-bed', r2.text)
  ok(/white_bed/.test(r2.text) && /mc_craft/.test(r2.text), '没床要指路：mc_craft white_bed', r2.text)

  const far = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '20,64,0': 'red_bed' },
    beds: [{ position: P(20, 64, 0) }],
  })
  const r3 = await sleepInBed(fakeSelf(far, { arrive: false }), {})
  ok(r3.ok === false && r3.reason === 'too-far', '走不到 ⇒ too-far', r3.text)
  ok(far.calls.some((c) => c[0] === 'walkTo'), '太远要先 walkTo', JSON.stringify(far.calls))
  ok(far.calls.some((c) => c[0] === 'walkTo' && c[4] === 'interact'), 'walkTo 用 intent=interact（要够得着才点）')

  const good = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '1,64,0': 'red_bed' },
    beds: [{ position: P(1, 64, 0) }],
  })
  const r4 = await sleepInBed(fakeSelf(good), { waitMs: 3_000 })
  ok(r4.ok === true && r4.slept === true, '正常睡上 ⇒ ok/slept', r4.text)
  ok(r4.woken === true, '床在近处（不用走）+ sleep 后 isSleeping 掉了 ⇒ woken=true', JSON.stringify(r4))
  ok(good.calls.some((c) => c[0] === 'sleep'), '真的调了 bot.sleep')

  // 躺上了但这个服要所有人才跳夜 ⇒ 等不到醒，要如实说"还没醒，别叫我干活"
  const stillInBed = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '1,64,0': 'red_bed' },
    beds: [{ position: P(1, 64, 0) }],
    wakeOnSleep: false,
  })
  const r4b = await sleepInBed(fakeSelf(stillInBed), { waitMs: 400 })
  ok(r4b.ok === true && r4b.slept === true && r4b.woken === false, '躺上但没醒 ⇒ woken=false 且 slept=true', r4b.text)
  ok(/还没醒/.test(r4b.text) && /别叫我干活/.test(r4b.text), '没醒要说明白"别叫我干活"', r4b.text)
  ok(stillInBed.isSleeping === true, '这种情形 isSleeping 还是 true（真躺着）')

  const occupied = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '1,64,0': 'red_bed' },
    beds: [{ position: P(1, 64, 0) }],
    sleepError: 'the bed is occupied',
  })
  const r5 = await sleepInBed(fakeSelf(occupied), {})
  ok(r5.ok === false && r5.reason === 'sleep-failed', '床被占 ⇒ sleep-failed', r5.text)
  ok(/有人躺着/.test(r5.text) && /换一张/.test(r5.text), '占床要翻译成人话 + 下一步', r5.text)
  ok(/occupied/.test(r5.error ?? ''), '原始英文报错留在 error 里（排查用）', r5.error)

  const noSleepState = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '1,64,0': 'red_bed' },
    beds: [{ position: P(1, 64, 0) }],
  })
  noSleepState.sleep = async function () { this.calls.push(['sleep-noop']); /* 不置 isSleeping */ }
  const r6 = await sleepInBed(fakeSelf(noSleepState), {})
  ok(r6.ok === false && r6.reason === 'not-sleeping', '点了床但 isSleeping 还是 false ⇒ not-sleeping', r6.text)

  const already = { ...fakeBot({}), isSleeping: true }
  const r7 = await sleepInBed({ requireBot: () => already, msLeft: () => 5_000 }, {})
  ok(r7.already === true, '已经躺着 ⇒ already=true（不重复睡）', r7.text)
}

/* ────────────────── ④ 报错翻译 ────────────────── */
section('④ sleepErrorText：把上游英文翻成人话')
{
  ok(/不是夜里/.test(sleepErrorText('it\'s not night and it\'s not a thunderstorm')), '白天 ⇒ 不是夜里')
  ok(/有人躺着/.test(sleepErrorText('the bed is occupied')), 'occupied ⇒ 有人躺着')
  ok(/有怪/.test(sleepErrorText('there are monsters nearby')), 'monsters ⇒ 有怪')
  ok(/太远/.test(sleepErrorText('the bed is too far')), 'too far ⇒ 太远')
  ok(/半张床/.test(sleepErrorText("there's only half bed")), 'half bed ⇒ 半张床')
  ok(/没让躺下/.test(sleepErrorText('bot is not sleeping')), 'not sleeping ⇒ 没让躺下')
  ok(/奇怪|躺不下去/.test(sleepErrorText('')), '空报错也要有话说', sleepErrorText(''))
}

/* ────────────────── ⑤ 起床 ────────────────── */
section('⑤ wakeUp')
{
  const awake = fakeBot({})
  const r1 = await wakeUp({ requireBot: () => awake })
  ok(r1.ok === true && r1.wasSleeping === false, '没在睡 ⇒ wasSleeping=false', r1.text)
  ok(!awake.calls.some((c) => c[0] === 'wake'), '没在睡就不发包')

  const sleeping = fakeBot({ isSleeping: true })
  const r2 = await wakeUp({ requireBot: () => sleeping })
  ok(r2.ok === true && r2.wasSleeping === true && r2.stillSleeping === false, '躺着 ⇒ 发 wake 并确认起来了', r2.text)
  ok(sleeping.calls.some((c) => c[0] === 'wake'), '真的调了 bot.wake')
}

/* ────────────────── ⑥ 熟没熟 ────────────────── */
section('⑥ matureOf / ageOf / maxAgeOf')
{
  const b = { registry: REGISTRY }
  ok(maxAgeOf(b, 'wheat') === 7, 'wheat 的 age 上限 7（num_values 8）', String(maxAgeOf(b, 'wheat')))
  ok(maxAgeOf(b, 'beetroots') === 3, 'beetroots 上限 3', String(maxAgeOf(b, 'beetroots')))
  ok(maxAgeOf(b, 'farmland') === null, '没有 age 的方块 ⇒ null')
  ok(ageOf(block('wheat', 0, 64, 0, 7)) === 7, 'ageOf 读 getProperties().age')
  ok(matureOf(b, block('wheat', 0, 64, 0, 7)) === true, 'wheat age=7 ⇒ 熟了')
  ok(matureOf(b, block('wheat', 0, 64, 0, 5)) === false, 'wheat age=5 ⇒ 没熟')
  ok(matureOf(b, block('carrots', 0, 64, 0, null)) === null, '读不到 age ⇒ null（不当熟）')
  ok(matureOf(b, block('stone', 0, 64, 0, 7)) === null, '不是作物 ⇒ null')
}

/* ────────────────── ⑦ 锄头 / 种子 ────────────────── */
section('⑦ hoeOf / seedOf')
{
  const b = fakeBot({ items: [item('wooden_hoe'), item('diamond_hoe'), item('stone_sword'), item('wheat_seeds', 5)] })
  ok(hoeOf(b)?.name === 'diamond_hoe', '多把锄头挑最好的', hoeOf(b)?.name)
  ok(hoeOf(fakeBot({ items: [item('stone_sword')] })) === null, '没有锄头 ⇒ null')
  ok(seedOf(b)?.seed === 'wheat_seeds', '默认拿背包里第一种种子', JSON.stringify(seedOf(b)))
  ok(seedOf(b, 'wheat_seeds')?.seed === 'wheat_seeds', '指名种子能拿到')
  ok(seedOf(b, 'carrot') === null, '背包没有的种子 ⇒ null')
  const alt = fakeBot({ items: [item('carrot', 3)] })
  ok(seedOf(alt)?.seed === 'carrot', 'carrot 也算种子')
  ok(Object.keys(SEED_TO_CROP).length >= 6 && CROP_TO_SEED.wheat === 'wheat_seeds', '种子↔作物表双向对得上')
}

/* ────────────────── ⑧ 找能种的地 ────────────────── */
section('⑧ farmSpotsNear：只要土/草/已耕地，上面得是空的或作物')
{
  const bot = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: {
      '0,63,0': 'grass_block', '0,64,0': 'air',
      '1,63,0': 'dirt', '1,64,0': 'air',
      '2,63,0': 'stone', '2,64,0': 'air',
      '3,63,0': 'farmland', '3,64,0': 'wheat',
      '-1,63,0': 'dirt', '-1,64,0': 'stone',
    },
  })
  const spots = farmSpotsNear(bot, { radius: 3, count: 8 })
  const names = spots.map((s) => s.soil).sort()
  ok(!names.includes('stone'), '石头不算地', names.join(','))
  ok(spots.some((s) => s.soil === 'farmland' && s.above === 'wheat'), '已耕地 + 上面有作物 ⇒ 也算（好判断熟没熟）')
  ok(!spots.some((s) => key(s.pos) === '-1,63,0'), '上面压着石头 ⇒ 不算')
  ok(farmSpotsNear(bot, { radius: 3, count: 1 }).length === 1, 'count 生效')
  ok(TILLABLE.has('grass_block') && !TILLABLE.has('coarse_dirt'), 'coarse_dirt 锄不动（不在表里）')
}

/* ────────────────── ⑨ 耕地播种 ────────────────── */
section('⑨ farmArea：锄地→播种，每步回读')
{
  // 9.1 两格土 + 锄头 + 种子：锄完种上
  const b1 = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '0,63,0': 'grass_block', '0,64,0': 'air', '1,63,0': 'dirt', '1,64,0': 'air' },
    items: [item('stone_hoe'), item('wheat_seeds', 8)],
  })
  const s1 = await farmArea(fakeSelf(b1), { x: 0, y: 63, z: 0 })
  ok(s1.ok === true, '给坐标：一格种上了', JSON.stringify({ t: s1.tilled, p: s1.planted, f: s1.failed }))
  ok(s1.tilled === 1 && s1.planted === 1, '锄 1 格、种 1 格', `tilled=${s1.tilled} planted=${s1.planted}`)
  ok(s1.text.includes('🌾') && /锄 1 格/.test(s1.text), '结果里有"锄 1 格"', s1.text)
  ok(b1.calls.some((c) => c[0] === 'equip' && c[1] === 'stone_hoe'), '先用锄头')
  ok(b1.held === 'wheat_seeds' || b1.calls.some((c) => c[0] === 'equip' && c[1] === 'wheat_seeds'), '播的时候拿的是种子')

  // 9.2 没有锄头：直接 no-hoe，不瞎挥
  const b2 = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '0,63,0': 'dirt', '0,64,0': 'air' },
    items: [item('wheat_seeds', 3)],
  })
  const s2 = await farmArea(fakeSelf(b2), { x: 0, y: 63, z: 0 })
  ok(s2.ok === false && s2.reason === 'no-hoe', '没锄头 ⇒ no-hoe', s2.text)
  ok(/wooden_hoe/.test(s2.text), '要指路 mc_craft wooden_hoe', s2.text)
  ok(!b2.calls.some((c) => c[0] === 'activate'), '没锄头就一次都不挥')

  // 9.3 锄了但方块没变 ⇒ till-unconfirmed
  const b3 = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '0,63,0': 'dirt', '0,64,0': 'air' },
    items: [item('stone_hoe'), item('wheat_seeds', 8)],
    tillWorks: false,
  })
  const s3 = await farmArea(fakeSelf(b3), { x: 0, y: 63, z: 0 })
  ok(s3.ok === false && s3.failed.some((f) => f.why === 'till-unconfirmed'), '锄完还是 dirt ⇒ till-unconfirmed', JSON.stringify(s3.failed))
  ok(s3.planted === 0, '没锄成就别播种', String(s3.planted))

  // 9.4 撒了种子但没长出作物 ⇒ sow-unconfirmed
  const b4 = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '0,63,0': 'farmland', '0,64,0': 'air' },
    items: [item('wheat_seeds', 8)],
    sowWorks: false,
  })
  const s4 = await farmArea(fakeSelf(b4), { x: 0, y: 63, z: 0 })
  ok(s4.failed.some((f) => f.why === 'sow-unconfirmed'), '撒了没长出 ⇒ sow-unconfirmed', JSON.stringify(s4.failed))
  ok(s4.planted === 0 && s4.ok === false, '没种上就不算成功')

  // 9.5 上面长着没熟的作物 ⇒ 跳过，不动它
  const b5 = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '0,63,0': 'farmland', '0,64,0': 'wheat' },
    items: [item('stone_hoe'), item('wheat_seeds', 8)],
  })
  b5.ages = new Map([['0,64,0', 3]])
  const s5 = await farmArea(fakeSelf(b5), { x: 0, y: 63, z: 0 })
  ok(s5.skipped.some((s) => s.why === 'growing'), '没熟的作物 ⇒ 跳过', JSON.stringify(s5.skipped))
  ok(!b5.calls.some((c) => c[0] === 'break'), '没熟就不收（别白拆）')

  // 9.6 上面压着别的方块：默认跳过，clear:true 才挖
  const b6 = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '0,63,0': 'dirt', '0,64,0': 'oak_leaves' },
    items: [item('stone_hoe'), item('wheat_seeds', 8)],
  })
  const s6 = await farmArea(fakeSelf(b6), { x: 0, y: 63, z: 0 })
  ok(s6.skipped.some((s) => s.why === 'blocked'), '上面有杂物 ⇒ blocked 跳过', JSON.stringify(s6.skipped))
  ok(!b6.calls.some((c) => c[0] === 'break'), 'clear:false 不挖')

  // 9.7 种子用完了 ⇒ 跳过（不是失败），地已经锄好
  const b7 = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '0,63,0': 'farmland', '0,64,0': 'air' },
    items: [item('stone_hoe')],
  })
  const s7 = await farmArea(fakeSelf(b7), { x: 0, y: 63, z: 0 })
  ok(s7.skipped.some((s) => s.why === 'seed-out' || s.why === 'no-seed'), '没种子 ⇒ 跳过', JSON.stringify(s7.skipped))
  ok(s7.failed.length === 0, '没种子不算失败')

  // 9.8 时间不够 ⇒ 剩下的进 remaining
  const b8 = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: {
      '0,63,0': 'dirt', '0,64,0': 'air',
      '1,63,0': 'dirt', '1,64,0': 'air',
      '2,63,0': 'dirt', '2,64,0': 'air',
    },
    items: [item('stone_hoe'), item('wheat_seeds', 8)],
  })
  let left = 9_000
  const s8 = await farmArea(fakeSelf(b8, { msLeft: () => (left -= 4_000) }), { radius: 3, count: 3 })
  ok(Array.isArray(s8.remaining) && s8.remaining.length > 0, '预算用完 ⇒ remaining 报出来', JSON.stringify(s8.remaining))
  ok(/再叫一次/.test(s8.text), '要告诉模型"再叫一次接着干"', s8.text)

  // 9.9 收成熟的再种（复种同一作物）
  const b9 = fakeBot({
    me: { x: 0, y: 64, z: 0 },
    world: { '0,63,0': 'farmland', '0,64,0': 'wheat' },
    items: [item('stone_hoe'), item('wheat_seeds', 8)],
  })
  b9.ages = new Map([['0,64,0', 7]])
  const self9 = fakeSelf(b9)
  const origBreak = self9.breakBlock
  self9.breakBlock = async (pos) => {
    const r = await origBreak(pos)
    // 收掉作物：把上面那格清成空气（模拟服务端破坏）
    b9.breakBlockClear = pos
    b9.ages.delete(`${pos.x},${pos.y},${pos.z}`)
    b9.blockAt = ((inner) => (p) => (key(p) === key(pos) ? block('air', p.x, p.y, p.z) : inner(p)))(b9.blockAt.bind(b9))
    return r
  }
  const s9 = await farmArea(self9, { x: 0, y: 63, z: 0 })
  ok(s9.harvested === 1, '熟了的先收（harvested=1）', String(s9.harvested))
  ok(b9.calls.some((c) => c[0] === 'break'), '真的挖了作物')
}

/* ────────────────── ⑩ 插件面接线 ────────────────── */
section('⑩ 插件面：mc_act 的三个 mode + 直接接线')
{
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  ok(/case 'sleep':\s+return withOutcome\(\{ mode, \.\.\.\(await sleepInBed\(bot,/.test(idx), 'index.js 有 case sleep → sleepInBed')
  ok(/case 'wake':\s+return withOutcome\(\{ mode, \.\.\.\(await wakeUp\(bot\)\)/.test(idx), 'index.js 有 case wake → wakeUp')
  ok(/case 'farm':\s+return withOutcome\(\{ mode, \.\.\.\(await farmArea\(bot,/.test(idx), 'index.js 有 case farm → farmArea')
  ok(/seed: \{ type: 'string'/.test(idx) && /harvest: \{ type: 'boolean'/.test(idx) && /clear: \{ type: 'boolean'/.test(idx), '参数表补了 seed / harvest / clear')
  ok(/waitMs: \{ type: 'number'/.test(idx), '参数表补了 waitMs（sleep 等醒）')
  ok(/sleep\/wake\/farm\//.test(idx) && /dismount/.test(idx), 'default 的可用清单里带上了 sleep/wake/farm')
  ok(/· sleep 睡最近的床/.test(idx) && /· farm 耕地\+播种/.test(idx), '描述里写了 sleep / farm 这两个 mode')
  ok(/import \{ sleepInBed, wakeUp, farmArea \} from '\.\/src\/farm\.mjs'/.test(idx), 'index.js 直接引了 src/farm.mjs')
  ok(core.split('\n').length <= 1000, 'core.mjs 没被这条功能撑破 ≤1000 行（现在 ' + core.split('\n').length + '）')
  ok(/BED_REACH = 3\.5/.test(readFileSync(new URL('../src/farm.mjs', import.meta.url), 'utf8')) && BED_REACH === 3.5, '够得着的门槛是 3.5 格')
}

console.log(`\n${fail === 0 ? '✅ 全过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
