/**
 * 传送门（末地/下界/末地门）不再被当危险地形（2026-10-19 实机）
 *
 * 用户原话：「还有把末影传送门视为危险方块」。
 * 实机里的样子：要塞传送门那 9 格与地板同层，`mc_move` 走到门外 1 格就报"到了"，
 * 人根本不进去；最后靠"门上方垫方块 → 挖掉 → 自己掉下去"硬闯（又慢又容易摔）。
 *
 * 修法三件：
 *   ① `GoalNear` 半径：目标（或邻格）是传送门时收到 **0**（`goalPointFor`）；
 *   ② 到了之后补一步"迈进去"（`stepIntoPortal`），按维度/位置变化判进没进；
 *   ③ 寻路报没路但人就在门边 4 格内 ⇒ 也直接迈进去（不再硬闯）；
 *   ④ 寻路黑名单里显式剔除 `*_portal`（传送门是目的地，不是危险）。
 */
import { readFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import { PORTAL_RE, portalAt, inPortalNow, stepIntoPortal, goalPointFor } from '../src/movement.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

/* 假 bot：blocks 是 `x,y,z -> name` 的 Map */
function makeBot ({ feet = new Vec3(0, -40, 0), blocks = new Map(), dimension = 'overworld' } = {}) {
  const controls = new Map()
  const bot = {
    entity: { position: feet.clone(), eyeHeight: 1.62, yaw: 0, pitch: 0 },
    game: { dimension },
    setControlState (k, v) { controls.set(k, v) },
    async lookAt () { bot.looked = true },
    blockAt (p) {
      const n = blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
      return n ? { name: n, getProperties: () => ({}) } : { name: 'air', getProperties: () => ({}) }
    },
  }
  bot.controls = controls
  return bot
}
const setBlock = (m, x, y, z, name) => m.set(`${x},${y},${z}`, name)

section('① PORTAL_RE：只认"站进去会被送走"的那三种')
{
  ok(PORTAL_RE.test('end_portal'), 'end_portal 是传送门')
  ok(PORTAL_RE.test('end_gateway'), 'end_gateway 是传送门')
  ok(PORTAL_RE.test('nether_portal'), 'nether_portal 是传送门')
  ok(!PORTAL_RE.test('end_portal_frame'), 'end_portal_frame（框）**不是**传送门', PORTAL_RE.source)
  ok(!PORTAL_RE.test('obsidian'), '黑曜石不是传送门')
}

section('② portalAt：目标格邻域里找最近的门，优先级 = 同层 > 上下层')
{
  const m = new Map()
  setBlock(m, 0, -40, 0, 'end_portal')       // 正上方那格（同层）
  const b = makeBot({ blocks: m })
  const r = portalAt(b, 1, -40, 1)
  ok(r && r.name === 'end_portal', '邻格的门找得到', JSON.stringify(r))
  ok(r && r.x === 0 && r.y === -40 && r.z === 0, '给的是门那一格的坐标', JSON.stringify(r))

  const m2 = new Map()
  setBlock(m2, 0, -39, 0, 'end_portal')      // 头那格
  const r2 = portalAt(makeBot({ blocks: m2 }), 0, -40, 0)
  ok(r2 && r2.y === -39, '比我高一格的门也认（人站在门下面）', JSON.stringify(r2))

  const m3 = new Map()
  setBlock(m3, 0, -41, 0, 'nether_portal')
  setBlock(m3, 1, -40, 0, 'nether_portal')   // 同层更近
  const r3 = portalAt(makeBot({ blocks: m3 }), 0, -40, 0)
  ok(r3 && r3.y === -40 && r3.x === 1, '同层的优先于脚下一层的', JSON.stringify(r3))

  ok(portalAt(makeBot({ blocks: new Map() }), 0, -40, 0) === null, '附近没门 ⇒ null')
  ok(portalAt(makeBot(), NaN, 0, 0) === null, '垃圾坐标 ⇒ null（不炸）')
  ok(portalAt(makeBot(), 0, -40, 0, 0) !== null === false, '半径 0 只认那一格本身', String(portalAt(makeBot(), 0, -40, 0, 0)))
}

section('③ goalPointFor：目标半径（这就是"到了却没进去"的根因）')
{
  const g1 = goalPointFor({ target: { x: -1689, y: -40, z: 1151 }, ty: -40, arriveUsed: 1.6 })
  ok(g1.radius === 1, '普通目标：半径 1（老行为不变）', JSON.stringify(g1))
  ok(g1.portal === false, '普通目标不标 portal')

  const g2 = goalPointFor({ target: { x: -1689, y: -40, z: 1151 }, ty: -40, arriveUsed: 1.6, portal: { name: 'end_portal', x: -1689, y: -40, z: 1150 } })
  ok(g2.radius === 0, '传送门目标：半径必须收到 0', JSON.stringify(g2))
  ok(g2.x === -1689 && g2.y === -40 && g2.z === 1150, '目标点改成门那一格', JSON.stringify(g2))
  ok(g2.portal === true, '标 portal:true')

  const g3 = goalPointFor({ target: { x: 1.7, y: 64, z: -2.2 }, ty: 64, arriveUsed: 2.6 })
  ok(g3.radius === 2, 'arrive 2.6 ⇒ 半径 2', String(g3.radius))
  ok(g3.x === 1 && g3.z === -3, '坐标取整（floor）', JSON.stringify(g3))
}

section('④ inPortalNow：人是不是已经站在门里')
{
  const m = new Map()
  setBlock(m, 0, -40, 0, 'end_portal')
  ok(inPortalNow(makeBot({ blocks: m })) === 'end_portal', '脚内是门 ⇒ 认得出')

  const m2 = new Map()
  setBlock(m2, 0, -39, 0, 'end_portal')
  ok(inPortalNow(makeBot({ blocks: m2 })) === 'end_portal', '头内是门 ⇒ 也认得出（眼高 1.62 那一格）')

  ok(inPortalNow(makeBot()) === null, '站在普通地板上 ⇒ null')
  ok(inPortalNow({}) === null, '没有 entity ⇒ null（不炸）')
}

section('⑤ stepIntoPortal：迈进去（按下前进 + 判传送）')
{
  const m = new Map()
  setBlock(m, 0, -40, 0, 'end_portal')
  const b = makeBot({ blocks: m, feet: new Vec3(2.5, -40, 0.5) })
  let released = null
  const origSet = b.setControlState.bind(b)
  b.setControlState = (k, v) => { origSet(k, v); if (v === false) released = k }
  // 假装"按住前进的那一刻被服务端送走了"
  b.lookAt = async () => { setTimeout(() => {
    b.game.dimension = 'the_end'
    b.entity.position = new Vec3(100, 49, 0)
  }, 60) }
  const r = await stepIntoPortal(b, { x: 0, y: -40, z: 0 }, { ms: 200 })
  ok(r.entered === true, '维度变了 ⇒ entered:true', JSON.stringify(r))
  ok(b.controls.get('forward') === false && b.controls.get('sprint') === false, '控制位都松开了', JSON.stringify([...b.controls]))
  ok(released !== null, '走过 finally 里的松手（不会一直前进）')
}

section('⑥ stepIntoPortal：没被传送就如实说 entered:false')
{
  const b = makeBot({ feet: new Vec3(3.5, -40, 0.5) })
  const r = await stepIntoPortal(b, { x: 0, y: -40, z: 0 }, { ms: 120 })
  ok(r.entered === false, '原地没动 ⇒ entered:false', JSON.stringify(r))
  ok(b.controls.get('forward') === false, '照样松手')
}

section('⑦ stepIntoPortal：已经站在门里就不再多此一举')
{
  const m = new Map()
  setBlock(m, 0, -40, 0, 'end_portal')
  const b = makeBot({ blocks: m, feet: new Vec3(0.5, -40, 0.5) })
  const r = await stepIntoPortal(b, { x: 0, y: -40, z: 0 }, { ms: 120 })
  ok(r.entered === true && r.already === true, 'already:true', JSON.stringify(r))
  ok(!b.controls.has('forward'), '不用按前进')
}

/* ── ⑧ 2026-10-25 实机：「还是走不进末地传送门」 ── */
section('⑧ stepIntoPortal：往下瞄 + 没进就再跳一下 + 被打断也试 300ms')
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/const aimY = Math\.min\(Number\(cell\.y\) \+ 0\.5, eyeY - 0\.2\)/.test(src), '站在框架顶上时往下瞄（水平瞄只会贴着边沿蹭）')
  ok(/const attempts = \[\{ ms: Math\.min\(ms, 700\), jump: false \}, \{ ms: 450, jump: true \}\]/.test(src), '第一段没进就再跳一下走一次')
  ok(/if \(signal\?\.aborted === true\) await sleep\(Math\.min\(a\.ms, 300\)\)/.test(src), '🔴 预算见底（signal 已 abort）也至少走 300ms，别一动不动就报没进')
  const m = new Map()
  setBlock(m, 0, -40, 0, 'end_portal')
  const b = makeBot({ blocks: m, feet: new Vec3(2.5, -39, 0.5) })   // 比门高一格（框架顶）
  let jumps = 0
  const origSet = b.setControlState.bind(b)
  b.setControlState = (k, v) => { origSet(k, v); if (k === 'jump' && v === true) jumps++ }
  let lookedAt = null
  b.lookAt = async (v) => { lookedAt = v; setTimeout(() => { b.game.dimension = 'the_end' }, 300) }
  const r = await stepIntoPortal(b, { x: 0, y: -40, z: 0 }, { ms: 200 })
  ok(r.entered === true, '第二段才被传送 ⇒ 仍然报 entered:true', JSON.stringify(r))
  ok(lookedAt && lookedAt.y < -37, '瞄点是往下（低于眼睛 -37.38）', String(lookedAt?.y))
  ok(jumps === 1, '第二段按了一次 jump', String(jumps))
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
