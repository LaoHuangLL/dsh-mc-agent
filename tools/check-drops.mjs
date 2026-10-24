#!/usr/bin/env node
/**
 * check-drops.mjs —— "掉落物在哪"（dropsNear / dropListOf）
 *
 * 背景：2026-10-22 我在下界两次打死烈焰人、两次都没拿到烈焰棒 —— 因为
 *   `mc_attack` 的返回里只有 `dropHint` 的一句话（"地上还有 N 个掉落物没捡"），
 *   **没有坐标、没有名字**，等回头再问东西已经消失了。
 *   现在 `mc_attack` / `mc_dig` 都会带 `drops`（坐标 + 名字 + 距离）。
 *
 * 这里钉死的是**事实口径**（捡不捡仍由 AI 决定，所以不测任何"自动走过去"）：
 *   ① 只认掉落物实体（物品/经验球），怪不算；
 *   ② 按距离**从近到远**排，超出半径的不报；
 *   ③ `limit` 真的截断（别拿一屏坐标淹掉模型）；
 *   ④ 取不到名字时**省略字段**，不能让整条结果抛错；
 *   ⑤ 畸形 bot（没 entity / entities 为空）返回空数组，不抛。
 *
 * 用法：node tools/check-drops.mjs（**必须从包目录跑**）
 */
import { readFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import { dropListOf, dropsNear } from '../src/world-observer.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')) } }

const drop = (id, x, y, z, kind = 'item') => ({
  id, name: kind, kind, type: 'object', position: new Vec3(x, y, z), isValid: true,
})
const mob = (id, x, y, z) => ({ id, name: 'zombie', kind: 'Hostile mobs', type: 'mob', position: new Vec3(x, y, z), isValid: true })

const mkBot = (entities, at = [0, 64, 0], nameOf = null) => ({
  entity: { position: new Vec3(at[0], at[1], at[2]) },
  entities: Object.fromEntries(entities.map((e) => [e.id, e])),
  ...(nameOf === null ? {} : { getDroppedItem: nameOf }),
})

console.log('\n── 只认掉落物 ──')
{
  const b = mkBot([drop(1, 1, 64, 0), mob(2, 0, 64, 1)])
  const near = dropsNear(b, 8)
  ok(near.length === 1, '怪不算掉落物', 'len=' + near.length)
  ok(near[0].e.id === 1, '留下的是那个 item 实体')
}

console.log('\n── 排序与半径 ──')
{
  const b = mkBot([drop(1, 5, 64, 0), drop(2, 1, 64, 0), drop(3, 30, 64, 0)])
  const near = dropsNear(b, 8)
  ok(near.length === 2, '半径外的（30 格）不报', 'len=' + near.length)
  ok(near[0].e.id === 2 && near[1].e.id === 1, '从近到远排')
}

console.log('\n── dropListOf ──')
{
  const b = mkBot([drop(1, 1, 64, 0), drop(2, 2, 64, 0), drop(3, 3, 64, 0)], [0, 64, 0],
    (e) => ({ name: 'blaze_rod_' + e.id }))
  const list = dropListOf(b, { radius: 8, limit: 2 })
  ok(list.length === 2, 'limit 真的截断', 'len=' + list.length)
  ok(list[0].name === 'blaze_rod_1', '名字按 getDroppedItem 取', String(list[0].name))
  ok(Number.isFinite(list[0].dist) && list[0].dist > 0, 'dist 是数字', String(list[0].dist))
  ok(list.every((d) => Number.isInteger(d.x) && Number.isInteger(d.y) && Number.isInteger(d.z)), '坐标是整数格')
}
{
  const b = mkBot([drop(1, 1, 64, 0)], [0, 64, 0], () => { throw new Error('boom') })
  let threw = null
  let list = null
  try { list = dropListOf(b, { radius: 8 }) } catch (e) { threw = e }
  ok(!threw, '取名字抛错不能把整条结果炸掉', threw && threw.message)
  ok(list && list.length === 1 && !('name' in list[0]), '取不到名字就省略该字段', list && JSON.stringify(list[0]))
}
{
  const b = mkBot([drop(1, 1, 64, 0)], [0, 64, 0], null)
  const list = dropListOf(b, { radius: 8 })
  ok(list.length === 1 && !('name' in list[0]), '没有 getDroppedItem 这个方法时也不抛')
}

console.log('\n── 畸形输入 ──')
{
  let bad = 0
  for (const w of [null, {}, { entity: null }, { entities: {} }, { entity: { position: new Vec3(0, 0, 0) } }]) {
    try { if (dropListOf(w, { radius: 8 }).length !== 0) bad++ } catch { bad++ }
  }
  ok(bad === 0, '畸形 bot ⇒ 空数组，不抛', 'bad=' + bad)
}

console.log('\n── 等吸附的范围（2026-10-25 用户要求收窄到 2 格）──')
{
  const src = readFileSync(new URL('../src/pickup.mjs', import.meta.url), 'utf8')
  ok(/radius = 2, at = null/.test(src), 'waitForPickup 默认只看挖掘点 2 格内')
  const digSrc = readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8')
  ok(/grabDrops\(b, \{ radius: 2\.5 \}\)/.test(digSrc), '挖完只捡脚边 2.5 格内的，远的只报不给捡')
}

console.log(`\ncheck-drops：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
