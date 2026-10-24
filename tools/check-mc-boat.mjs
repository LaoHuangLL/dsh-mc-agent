#!/usr/bin/env node
/**
 * 船（开 / 下）自检 —— `src/boat.mjs`
 *
 * 🔴 起因（用户 2026-10-20 公屏）：「做一下船移动，现在只能做上船，但是动不了」「还有下船」。
 *    上船一直有（`mc_act {mode:"use", who:"oak_boat"}` → `activateEntity`），
 *    mineflayer 的 `moveVehicle` / `dismount` 这两件原语却从来没被接出来。
 *
 * 🔴 2026-10-20 实机又纠了一次：开船**不能**用 `player_input`（`moveVehicle(0,1)` 连发 10 秒，
 *    服务端 `/data get entity @s Pos` 一格没动）；原版是「客户端算位移、服务端照着走」——
 *    每 tick 发 `vehicle_move{x,y,z,yaw,pitch,onGround}`。下船同理：`player_input{shift}` 要连发几拍
 *    （原版按键是按下-松开的边沿），只发一次服务端没反应。
 *
 * 钉死这几件事：
 *   ① 没坐在载具上时 `driveBoat` 不瞎开会，如实报 `not-in-boat` 并指路上船；
 *   ② 已经在到达半径内 ⇒ 一个 `vehicle_move` 都不发，直接 `moveVehicle(0,0)` 收油；
 *   ③ 方向靠 `bot.look(yaw)`（yaw 约定 = `atan2(-dx,-dz)`）**并且** `vehicle_move.yaw` 是原版度数；
 *   ④ 走不动（旱地/卡住）报 `stalled` 并说明"船要在水上才飘"；
 *   ⑤ 从载具上下来：先收油 → 连发几拍 `player_input{shift}` → **轮询 `bot.vehicle`**；
 *   ⑥ 没骑东西时 `dismountVehicle` 报 `not-riding`，不抛错；
 *   ⑦ 船/矿车/坐筏都能认（`VEHICLE_RE`），`vehicleName` 拿得到名字。
 *
 * 用法：node tools/check-mc-boat.mjs
 */
import { readFileSync } from 'node:fs'
const { driveBoat, dismountVehicle, vehicleOf, vehicleName, isWaterVehicle } = await import(new URL('../src/boat.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) }
}

/**
 * 假 bot：按"服务端认位置包"的行为复现 —— 收到 `vehicle_move` 就把位置挪过去（`move:false` 时纹丝不动，
 * 模拟旱地/卡住）；收到 `player_input{shift:true}` 才把玩家放下来（`dismount()` 对船无效，正是实机那个坑）。
 */
function fakeBot ({ boat = 'oak_boat', pos = { x: 0, y: 63, z: 0 }, move = true, ignoreShift = false, breakOnAttack = false, staleVehicle = false, dismountOnChat = false } = {}) {
  const bot = {
    calls: [],
    vehicle: boat ? { id: 7, name: boat, position: { ...pos } } : null,
    entities: boat ? { 7: { id: 7, name: boat, position: { ...pos } } } : {},
    entity: { position: { ...pos }, yaw: 0 },
    look: async (yaw, pitch, force) => { bot.calls.push(['look', yaw, pitch, force]) },
    moveVehicle: (left, forward) => { bot.calls.push(['moveVehicle', left, forward]) },
    setControlState (name, on) { bot.calls.push(['setControlState', name, on]) },
    attack (entity) { bot.calls.push(['attack', entity]); if (breakOnAttack) bot.vehicle = null },
    chat (text) { bot.calls.push(['chat', text]); if (dismountOnChat) bot.vehicle = null },
    dismount () { bot.calls.push(['dismount']) },
    _client: {
      write (name, data) {
        bot.calls.push([name, data])
        if (name === 'vehicle_move' && move) {
          const p = { x: data.x, y: data.y, z: data.z }
          bot.entity.position = p
          if (bot.vehicle && !staleVehicle) bot.vehicle.position = p
        }
        if (name === 'player_input' && data?.inputs?.shift === true && bot.vehicle && move !== 'keep' && !ignoreShift) {
          bot.vehicle = null
          bot._dismounted = true
        }
      },
    },
    emit () {},
  }
  return bot
}

const sessOf = (b) => ({ requireBot: () => b, msLeft: () => 9_000 })
const packets = (b, name) => b.calls.filter((c) => c[0] === name)

console.log('\n① 没上船：不瞎开，指路上船')
{
  const b = fakeBot({ boat: null })
  const r = await driveBoat(sessOf(b), { x: 10, y: 63, z: 0 }, { budget: 300 })
  ok(r.arrived === false, '没上船 ⇒ arrived:false')
  ok(r.reason === 'not-in-boat', '没上船 ⇒ reason:"not-in-boat"', r.reason)
  ok(/mc_act \{mode:"use"/.test(String(r.hint)), 'hint 里给出上船的具体写法', String(r.hint))
  ok(packets(b, 'vehicle_move').length === 0, '没上船时一个位移包都没发')
}

console.log('\n② 已经在到达半径内：直接收油')
{
  const b = fakeBot({ pos: { x: 10, y: 63, z: 0 } })
  const r = await driveBoat(sessOf(b), { x: 10.5, y: 63, z: 0 }, { budget: 400, arrive: 2 })
  ok(r.arrived === true, '离目标 0.5 格 ⇒ 直接 arrived', String(r.remaining))
  ok(b.calls.some((c) => c[0] === 'moveVehicle' && c[2] === 0), '收油：调过 moveVehicle(0,0)')
  ok(packets(b, 'vehicle_move').length === 0, '一个位移包都没发')
}

console.log('\n③ 开过去：先 look 定方向，再发 vehicle_move（原版做法）')
{
  const b = fakeBot({ pos: { x: 0, y: 63, z: 0 } })
  const r = await driveBoat(sessOf(b), { x: 6, y: 63, z: 0 }, { budget: 2_500, arrive: 1.5, pollMs: 40 })
  ok(r.arrived === true, '开到了（arrived）', `remaining=${r.remaining} moved=${r.moved}`)
  ok(Number(r.moved) > 1, '真的往前挪了', String(r.moved))
  const firstLook = b.calls.findIndex((c) => c[0] === 'look')
  const firstMove = b.calls.findIndex((c) => c[0] === 'vehicle_move')
  ok(firstLook >= 0 && firstMove > firstLook, '先 look 后发位移包')
  const yaw = b.calls.find((c) => c[0] === 'look')?.[1]
  /* 往 +x 开 ⇒ dx>0, dz=0 ⇒ yaw = atan2(-dx, -dz) = atan2(-6, 0) = -π/2 */
  ok(Math.abs(yaw + Math.PI / 2) < 0.15, 'look 用 atan2(-dx,-dz) 约定（往 +x 开 ≈ -π/2）', String(yaw))
  const deg = packets(b, 'vehicle_move')[0]?.[1]?.yaw
  /* 原版 yaw 是**度**，且约定不同：`toNotchianYaw = toDegrees(PI - yaw)` ⇒ -π/2 → 270° */
  ok(Number.isFinite(deg) && Math.abs((((deg % 360) + 360) % 360) - 270) < 6, 'vehicle_move.yaw 是原版度数（-π/2 ⇒ ≈270°）', String(deg))
  const pkt = packets(b, 'vehicle_move')[0]?.[1] ?? {}
  ok(pkt.onGround === false && pkt.pitch === 0, 'vehicle_move 带 pitch/onGround 字段（少字段会烂包）', JSON.stringify(pkt))
  ok(r.vehicle === 'oak_boat', '报出载具名字', String(r.vehicle))
}

console.log('\n③b 骑船时按**船**的高度发（用玩家座位高度会把船一路拽沉）')
{
  const b = fakeBot({ pos: { x: 0, y: 63, z: 0 } })
  b.vehicle.position = { x: 0, y: 63, z: 0 }
  b.entity.position = { x: 0, y: 62.4, z: 0 }   // 座位比船低半格多（实机就是这样）
  await driveBoat(sessOf(b), { x: 4, y: 63, z: 0 }, { budget: 800, arrive: 1.5, pollMs: 40 })
  const ys = packets(b, 'vehicle_move').map((c) => c[1]?.y)
  ok(ys.length > 0 && ys.every((y) => Math.abs(y - 63) < 0.01), 'vehicle_move.y 用船的高度（不是玩家座位）', JSON.stringify(ys.slice(0, 3)))
}

console.log('\n③c 船的坐标是陈旧的（服务端不给骑手发船的实体位置）⇒ 判距离只认玩家坐标')
{
  const b = fakeBot({ pos: { x: 0, y: 62.4, z: 0 }, staleVehicle: true })
  b.vehicle.position = { x: 0, y: 63, z: 0 }   // 船停在"刚上船那一刻"，之后永远不动
  const r = await driveBoat(sessOf(b), { x: 6, y: 63, z: 0 }, { budget: 3_000, arrive: 1.5, pollMs: 40 })
  ok(r.arrived === true, '照样能判到（arrived）', JSON.stringify({ moved: r.moved, remaining: r.remaining, reason: r.reason }))
  ok(Number(r.moved) > 4, 'moved 读到的是真位移（不是 0）', String(r.moved))
  ok(r.reason !== 'stalled', '不会误判 stalled', String(r.reason))
  ok(b.calls.every((c) => c[0] !== 'vehicle_move' || Math.abs(c[1].y - 63) < 0.01), 'y 还是船的高度（不受陈旧坐标影响）')
}

console.log('\n④ 旱地上开不动：报 stalled + 说清"船要在水上"')
{
  const b = fakeBot({ pos: { x: 0, y: 63, z: 0 }, move: false })   // 包照发，位置不动
  const r = await driveBoat(sessOf(b), { x: 30, y: 63, z: 0 }, { budget: 500, arrive: 1.5, pollMs: 40 })
  ok(r.arrived === false, '没到 ⇒ arrived:false')
  ok(r.reason === 'stalled', 'reason:"stalled"', r.reason)
  ok(/水上/.test(String(r.hint)), 'hint 说明船要在水上才飘', String(r.hint))
  ok(packets(b, 'vehicle_move').length > 0, '包是照发的（不是没发就判卡住）')
}

console.log('\n⑤ 下船：先收油 → 连发 shift → 轮询 bot.vehicle')
{
  const b = fakeBot()
  const r = await dismountVehicle(sessOf(b))
  ok(r.ok === true, '下来了（ok:true）', JSON.stringify(r))
  ok(vehicleOf(b) === null, 'bot.vehicle 已经空')
  const iMove = b.calls.findIndex((c) => c[0] === 'moveVehicle' && c[2] === 0)
  const iShift = b.calls.findIndex((c) => c[0] === 'player_input' && c[1]?.inputs?.shift === true)
  ok(iShift >= 0, '发了潜行（原版下船靠 shift，不是 jump）')
  ok(iMove >= 0 && iMove < iShift, '先收油、再下船（不然船自己漂走）')
  ok(b.calls.some((c) => c[0] === 'player_input' && c[1]?.inputs?.shift === false), '潜行会被松开（不然一直蹲着）')
  ok(r.vehicle === 'oak_boat', '报出从哪条船上下来', String(r.vehicle))
}

console.log('\n⑤b 这服上 shift / dismount 都不管用 ⇒ 最后一招砸船（2026-10-20 实机）')
{
  const b = fakeBot({ ignoreShift: true, breakOnAttack: true })
  const r = await dismountVehicle(sessOf(b))
  ok(r.ok === true, '砸船之后下来了（ok:true）', JSON.stringify(r))
  ok(b.calls.some((c) => c[0] === 'attack'), '调过 attack 把船砸了')
  ok(Array.isArray(r.tried) && r.tried.includes('attack'), 'tried 里带 attack')
}

console.log('\n⑤c 骑久了船从客户端实体列表里消失（砸不着）⇒ 最后发 `/ride @s dismount`')
{
  /* 实机：骑一阵之后 `b.entities` 里根本没有船（132 个实体都没有它），
   * `b.attack(veh)` 打不着 ⇒ 只能发指令。 */
  const b = fakeBot({ ignoreShift: true, breakOnAttack: false, dismountOnChat: true })
  const r = await dismountVehicle(sessOf(b))
  ok(r.ok === true, '指令之后下来了（ok:true）', JSON.stringify(r))
  ok(b.calls.some((c) => c[0] === 'chat' && /^\/ride @s dismount$/.test(String(c[1]))), '发的是 `/ride @s dismount`')
  ok(Array.isArray(r.tried) && r.tried.includes('command'), 'tried 里带 command', JSON.stringify(r.tried))
}

console.log('\n⑤d 幽灵挂载（服务端早放下了、bot.vehicle 没清）⇒ 先发指令 + 本地清状态')
{
  /* 实机：`/data get entity @s RootVehicle` = no elements，但 `bot.vehicle` 还挂着 ⇒ 四个动作全空转。
   * 判据就是"车还在不在实体表里"。 */
  const b = fakeBot({ ignoreShift: true })
  b.entities = {}          // 车不在实体表里
  b.vehicle = { id: 7, name: 'oak_boat', position: { x: 0, y: 63, z: 0 } }
  const r = await dismountVehicle(sessOf(b), { wait: 400 })
  ok(r.ok === true, '最终算"下来了"（ok:true）', JSON.stringify(r))
  const firstReal = b.calls.find((c) => c[0] !== 'moveVehicle')
  ok(firstReal?.[0] === 'chat' && /\/ride @s dismount/.test(String(firstReal[1])), '第一招就是发指令（收油不算）', JSON.stringify(b.calls.slice(0, 3)))
  ok(b.vehicle === null, '本地把 bot.vehicle 清掉了')
  ok(typeof r.note === 'string' && /幽灵|指令/.test(r.note), 'note 说清了为什么清（幽灵挂载 / 发了指令）', String(r.note))
}

console.log('\n⑥ 没骑东西时下船：如实报，不抛错')
{
  const b = fakeBot({ boat: null })
  const r = await dismountVehicle(sessOf(b))
  ok(r.ok === false && r.reason === 'not-riding', 'reason:"not-riding"', r.reason)
  ok(/mode:"dismount"/.test(String(r.hint)), 'hint 里点明 mode:"dismount"')
}

console.log('\n⑦ 船 / 矿车 / 坐骑都认')
{
  ok(isWaterVehicle({ vehicle: { name: 'oak_boat' } }) === true, 'oak_boat 是水上载具')
  ok(isWaterVehicle({ vehicle: { name: 'oak_chest_boat' } }) === true, '带箱子的船也算')
  ok(isWaterVehicle({ vehicle: { name: 'oak_raft' } }) === true, '木筏也算（1.21.2 之后）')
  ok(isWaterVehicle({ vehicle: { name: 'minecart' } }) === false, '矿车不是水上载具（旱地也能走）')
  ok(vehicleName({ vehicle: { name: 'minecart' } }) === 'minecart', 'vehicleName 取得到名字')
  ok(vehicleOf({}) === null, '没骑东西 ⇒ vehicleOf 返回 null')
}

console.log('\n⑧ 下船后如实报「泡在水里」')
{
  const src = readFileSync(new URL('../src/boat.mjs', import.meta.url), 'utf8')
  ok(/inWater: wet/.test(src), '下船结果里有 inWater 字段')
  ok(/泡在水里/.test(src), '在水里时提示「泡在水里」')
  ok(/三分之一速度/.test(src), '并说明水里只有走路的三分之一速度')
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
