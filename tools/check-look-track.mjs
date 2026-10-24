#!/usr/bin/env node
/**
 * 跟踪 / 采样 / 等新实体自检 —— `src/look-track.mjs`
 *
 * 🔴 起因（用户 2026-10-24）：末影之眼指路要的是"方向"，`mc_act {mode:"look"}` 原来只会
 *    "转一次头"就返回，答不了"它往哪飞 / 还在动吗 / 我刚扔的东西生成在哪"。
 *
 * 钉死这几件事：
 *   ① `bearingText`：0=北、90=东、180=南、270=西（Minecraft 习惯：-Z 北、+X 东）；
 *   ② `solveTrack` 用**首尾水平差**算方向；水平位移 < 0.5 格 ⇒ `dir:null`（不硬编方向）；
 *   ③ 速度 = 水平位移 / 首尾时间差；
 *   ④ `watchNewEntity`：快照之后才出现的才算新的（**id 复用不算**）；
 *   ⑤ 同时出现多个新实体时，**名字对得上的优先**，其次离得最近的；
 *   ⑥ 命中就立刻返回（不等满 waitMs）；超时返回 `ent:null` + 期间看到过的新实体；
 *   ⑦ 太远的新实体（> maxDist）不算；
 *   ⑧ `lookTrack` 不给 track ⇒ 只转一次头，返回 yaw/pitch/dist；
 *   ⑨ 给 track ⇒ 有采样点、有 dir/bearing；`samples:"raw"` 才附原始点；
 *   ⑩ 跟踪途中被别的动作接管（moveGen 变了）⇒ `preempted:true` 并立刻收手；
 *   ⑪ 目标实体消失 ⇒ 记 `lostAt`，不假装还在跟；
 *   ⑫ 插件面接线：`index.js` 的 look 分支会走 `lookTrack`，参数表补了 newEntity/track/samples/useItem。
 *
 * 用法：node tools/check-look-track.mjs
 */
import { readFileSync } from 'node:fs'
import {
  lookTrack, watchNewEntity, solveTrack, bearingText,
  TRACK_POLL_MS, NEW_ENTITY_POLL_MS, NEW_ENTITY_NAME_WINDOW_MS, NEW_ENTITY_MAX_DIST,
} from '../src/look-track.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const P = (x, y, z) => ({
  x, y, z,
  distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) },
})

/** 假 bot：`entities` 是一个可变字典，测试里直接往里塞就是"服务端发了 spawn 包"。 */
function mkBot ({ x = 0, y = 64, z = 0 } = {}) {
  const b = {
    entity: { position: P(x, y, z), yaw: 0, pitch: 0 },
    entities: {},
  }
  b.entity.id = 0
  b.entities[0] = b.entity
  return b
}

function addEnt (b, id, name, x, y, z) {
  const e = { id, name, position: P(x, y, z) }
  b.entities[id] = e
  return e
}

/* ─────────────────────────────────────────────────────────────── */
section('① bearingText：方位角 → 中文八向')
ok(bearingText(0) === '北（0°）', '0° = 北', bearingText(0))
ok(bearingText(90) === '东（90°）', '90° = 东', bearingText(90))
ok(bearingText(180) === '南（180°）', '180° = 南', bearingText(180))
ok(bearingText(270) === '西（270°）', '270° = 西', bearingText(270))
ok(bearingText(45) === '东北（45°）', '45° = 东北', bearingText(45))
ok(bearingText(315) === '西北（315°）', '315° = 西北', bearingText(315))
ok(bearingText(-90) === '西（270°）', '负数也归一到 0–360', bearingText(-90))
ok(bearingText(null) === '算不出', 'null 说"算不出"，不编一个方向')

section('② solveTrack：首尾水平差 → 方向')
const mk = (pts) => solveTrack(pts)
/* 向北：dz 变小（-Z 是北） */
const north = mk([{ t: 0, x: 0, y: 64, z: 0 }, { t: 1000, x: 0, y: 64, z: -10 }])
ok(north.bearing === 0, '向 -Z 飞 ⇒ 0°（北）', String(north.bearing))
ok(north.dir.dz < -0.9 && Math.abs(north.dir.dx) < 0.01, 'dir 是单位向量（dz≈-1）')
const east = mk([{ t: 0, x: 0, y: 64, z: 0 }, { t: 1000, x: 10, y: 64, z: 0 }])
ok(east.bearing === 90, '向 +X 飞 ⇒ 90°（东）', String(east.bearing))
const south = mk([{ t: 0, x: 0, y: 64, z: 0 }, { t: 1000, x: 0, y: 64, z: 10 }])
ok(south.bearing === 180, '向 +Z 飞 ⇒ 180°（南）', String(south.bearing))
const west = mk([{ t: 0, x: 0, y: 64, z: 0 }, { t: 1000, x: -10, y: 64, z: 0 }])
ok(west.bearing === 270, '向 -X 飞 ⇒ 270°（西）', String(west.bearing))
/* 用户 2026-10-24 的实测数据：基地 (-5,98,-3)，落点方向 dx≈-5.5 dz≈+10.5（南偏西） */
const real = mk([{ t: 0, x: -5, y: 98, z: -3 }, { t: 1000, x: -10.5, y: 101, z: 7.5 }])
ok(real.bearing > 180 && real.bearing < 225, '实机数据（dx-5.5 dz+10.5）⇒ 南偏西（180–225°）', String(real.bearing))

section('③ solveTrack：没动 / 点数不够 / 速度')
const still = mk([{ t: 0, x: 0, y: 64, z: 0 }, { t: 1000, x: 0.1, y: 64, z: 0 }])
ok(still.dir === null && still.bearing === null, '水平 <0.5 格 ⇒ 不给方向（不瞎编）')
ok(still.moved === 0.1, 'moved 如实报 0.1 格', String(still.moved))
ok(mk([{ t: 0, x: 0, y: 64, z: 0 }]).dir === null, '只有 1 个点 ⇒ 不给方向')
ok(mk([]).speed === null, '空数组不炸')
const fast = mk([{ t: 0, x: 0, y: 64, z: 0 }, { t: 500, x: 0, y: 64, z: -10 }])
ok(fast.speed === 20, '速度 = 10 格 / 0.5 秒 = 20 格/秒', String(fast.speed))

section('④ watchNewEntity：快照之后才出现的才算新的')
{
  const b = mkBot()
  addEnt(b, 5, 'zombie', 3, 64, 0)          // 老实体
  const p = watchNewEntity(b, { newEntity: 400, x: 0, y: 64, z: 0 }, {
    useItem: async () => { addEnt(b, 9, 'eye_of_ender', 0.5, 64.5, 0.5) },
  })
  const r = await p
  ok(r.ent && r.ent.id === 9, '扔完出现的新实体被抓到', JSON.stringify(r.ent?.name))
  ok(r.waitedMs < 400, '命中就立刻返回，不等满 waitMs', `${r.waitedMs}ms`)
  ok(!r.seen.some((x) => x.id === '5'), '老实体（zombie）没被当成新的')
}

section('⑤ id 复用：同一 id 换了东西 ⇒ 认不出来（已知限制，如实记录）')
{
  const b = mkBot()
  addEnt(b, 5, 'zombie', 3, 64, 0)          // 快照里已经有 id=5
  const r = await watchNewEntity(b, { newEntity: 250, x: 0, y: 64, z: 0, who: 'eye' }, {
    /* 服务端回收 id：同一个 id 从 zombie 变成眼睛 —— 我们只能靠 id 表判断，认不出来。
     * 这是**已知限制**（代价是漏检，不是误检），缓解手段是把快照到扔的间隔压到最短
     * （`useItem:true` 一步到位），别"先 useitem 再调 look"。 */
    useItem: async () => { b.entities[5] = { id: 5, name: 'eye_of_ender', position: P(0.5, 64.5, 0.5) } },
  })
  ok(r.ent === null, 'id 被复用时认不出来 —— 已知限制，不假装能认')
}

section('⑥ 多个新实体：名字对得上的优先')
{
  const b = mkBot()
  const r = await watchNewEntity(b, { newEntity: 500, x: 0, y: 64, z: 0, who: 'eye' }, {
    useItem: async () => {
      addEnt(b, 11, 'zombie', 0.3, 64, 0.3)          // 更近，但名字不对
      addEnt(b, 12, 'eye_of_ender', 2, 65, 2)
    },
  })
  ok(r.ent && r.ent.id === 12, '选了名字匹配的 eye_of_ender，而不是更近的 zombie', JSON.stringify(r.ent?.name))
  ok(r.seen.some((x) => x.id === '11'), '另一个新实体进 others，不丢信息')
}

section('⑦ 太远的新实体不算 / 超时如实报')
{
  const b = mkBot()
  const r = await watchNewEntity(b, { newEntity: 200, x: 0, y: 64, z: 0 }, {
    useItem: async () => { addEnt(b, 21, 'zombie', 40, 64, 0) },   // 40 格 > 12
  })
  ok(r.ent === null, `超过 ${NEW_ENTITY_MAX_DIST} 格的新实体不算`)
  ok(r.seen.length === 0, '也不进 seen（它根本不是候选）')
}
{
  const b = mkBot()
  const t0 = Date.now()
  const r = await watchNewEntity(b, { newEntity: 200, x: 0, y: 64, z: 0 }, {})
  ok(r.ent === null && r.waitedMs === 200, '什么都没出现 ⇒ ent:null + 等满 waitMs')
  ok(Date.now() - t0 >= 180, '确实等到了（不是立刻返回）')
}

section('⑧ lookTrack 不给 track：只转一次头')
{
  const b = mkBot()
  addEnt(b, 7, 'zombie', 5, 64, 0)
  const r = await lookTrack(b, { who: 'zombie' })
  ok(r.text.includes('已看向'), '返回人话', r.text)
  ok(typeof r.yaw === 'number' && typeof r.pitch === 'number', '有 yaw/pitch')
  ok(r.track === undefined, '没有 track 字段（没跟踪）')
  ok(r.dist > 4 && r.dist < 6, 'dist 算出来了', String(r.dist))
}

section('⑨ lookTrack + track：采样、方向、raw')
{
  const b = mkBot()
  const e = addEnt(b, 8, 'eye_of_ender', 0, 64, -1)
  /* 让它"飞"：每 100ms 往 -Z 挪 2 格 */
  const timer = setInterval(() => { e.position.z -= 2 }, 60)
  const r = await lookTrack(b, { newEntity: 400, track: 600, samples: 'raw', x: 0, y: 64, z: 0 }, {
    useItem: async () => { /* 实体已在表里，这里模拟"扔之前就有了" ⇒ 应等不到 */ },
  })
  clearInterval(timer)
  ok(r.newEntity && r.newEntity.found === false, '扔之前就在表里的不算"新出现"（快照先行）', JSON.stringify(r.newEntity))
}
{
  const b = mkBot()
  const r = await lookTrack(b, { who: 'eye', track: 400, samples: 'raw' }, {
    /* 先放一个实体，再让它动 */
  }).catch((err) => ({ err: String(err.message) }))
  ok(r.err && r.err.includes('要么给 who'), '什么目标都没有 ⇒ 说清要什么，不静默', r.err)
}
{
  const b = mkBot()
  const timer = setInterval(() => { const e = b.entities[10]; if (e) e.position.z -= 1.5 }, 50)
  const r = await lookTrack(b, { newEntity: 500, track: 600, samples: 'raw', x: 0, y: 64, z: 0 }, {
    useItem: async () => { addEnt(b, 10, 'eye_of_ender', 0, 64.5, -0.5) },
  })
  clearInterval(timer)
  ok(r.newEntity && r.newEntity.found === true, '等到了新实体', JSON.stringify(r.newEntity))
  ok(r.track && r.track.points >= 2, '采到了多个点', String(r.track?.points))
  ok(Array.isArray(r.samples) && r.samples.length === r.track.points, 'samples:"raw" 附原始点')
  ok(typeof r.bearing === 'number', '解出了方位角', String(r.bearing))
  ok(r.bearing < 10 || r.bearing > 350, '往 -Z 飞 ⇒ 北（0°/360°）附近', String(r.bearing))
  ok(r.speed > 0, '速度是正数（确实在动）', String(r.speed))
}
{
  const b = mkBot()
  const r = await lookTrack(b, { newEntity: 500, track: 300, x: 0, y: 64, z: 0 }, {
    useItem: async () => { addEnt(b, 30, 'eye_of_ender', 0, 64.5, 0) },
  })
  ok(r.samples === undefined, '不给 samples:"raw" ⇒ 不附原始点（省 token）')
  ok(r.track && r.track.points >= 2, '但仍然报 track 摘要')
}

section('⑩ 被接管：moveGen 一变就收手')
{
  const b = mkBot()
  /* 🔴 不能用定时器改 gen —— `watchNewEntity` 要等满名字窗口（300ms）才返回，
   *    gen0 那时才取；定时器早在窗口期里就把它改了，于是"一开始就是新代次"，永远测不出中断。
   *    改成**按调用次数**升代：第 1 次是取 gen0，第 2、3 次仍是 1，第 4 次变 2。 */
  let calls = 0
  const r = await lookTrack(b, { newEntity: 500, track: 2000, x: 0, y: 64, z: 0 }, {
    useItem: async () => { addEnt(b, 40, 'eye_of_ender', 0, 64.5, 0) },
    moveGenOf: () => { calls++; return calls > 3 ? 2 : 1 },
  })
  ok(r.track && r.track.preempted === true, '被接管 ⇒ preempted:true', JSON.stringify(r.track))
  ok(r.track.ms < 1500, '没有跑满 2000ms（提前收手）', `${r.track.ms}ms`)
  ok(r.text.includes('接管'), '人话里说明了原因', r.text)
}

section('⑪ 目标消失：记 lostAt，不假装还在跟')
{
  const b = mkBot()
  const timer = setInterval(() => { delete b.entities[50] }, 150)
  const r = await lookTrack(b, { newEntity: 500, track: 2000, x: 0, y: 64, z: 0 }, {
    useItem: async () => { addEnt(b, 50, 'eye_of_ender', 0, 64.5, 0) },
  })
  clearInterval(timer)
  ok(r.track && typeof r.track.lostAt === 'number', '记了 lostAt', JSON.stringify(r.track))
  ok(r.text.includes('不见了'), '人话里说"不见了"', r.text)
}

section('⑫ 插件面接线')
{
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok(/import \{ lookTrack \} from '\.\/src\/look-track\.mjs'/.test(idx), 'index.js 引了 src/look-track.mjs')
  ok(/case 'look': \{/.test(idx) && /lookTrack\(bot\.requireBot\(\), args/.test(idx), "look 分支会走 lookTrack")
  ok(/newEntity: \{ type: 'number'/.test(idx), '参数表补了 newEntity')
  ok(/track: \{ type: 'number'/.test(idx), '参数表补了 track')
  ok(/samples: \{ type: 'string'/.test(idx), '参数表补了 samples')
  ok(/useItem: \{ type: 'boolean'/.test(idx), '参数表补了 useItem')
  ok(/要看方向\/速度就加 track:1500 \+ samples/.test(idx), '描述里告诉模型怎么用')
  ok(TRACK_POLL_MS === 100 && NEW_ENTITY_POLL_MS === 25 && NEW_ENTITY_NAME_WINDOW_MS === 300 && NEW_ENTITY_MAX_DIST === 12,
    '四个默认值没被人偷偷改掉')
}

console.log(`\n${fail === 0 ? '✅ 全过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
