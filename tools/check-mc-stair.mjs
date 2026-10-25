#!/usr/bin/env node
/**
 * tools/check-mc-stair.mjs —— 挖阶梯（`mc_dig {mode:"stair"}`）的静态 + 纯函数回归。
 *
 * 钉住四件事：
 *   ① 几何：每步挖 **3 格**（目标站位 / 我的脚 / 我的头），少一格就会卡住
 *   ② 平台：每 4 格留一次（`STAIR_PLATFORM_EVERY`）
 *   ③ 方向推导：给 x/z 用主轴；给 dir 直接用；都没给按朝向
 *   ④ 接线：`dig()` 转调、`mc_dig` 暴露 mode/dir/maxSteps、vendor 补丁禁掉「挖脚下」
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stairDirOf, STAIR_MAX_STEPS, STAIR_STEP_MS } from '../src/mining.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
let pass = 0; let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) } else { fail++; console.log(`  FAIL ${label}${extra ? ' ｜ ' + extra : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

const mvSrc = read('src/mining.mjs')
const idxSrc = read('index.js')
const patchSrc = read('tools/patch-mc-deps.mjs')

section('1. 常量')
ok(STAIR_MAX_STEPS === 64, '默认最多 64 步')
ok(STAIR_STEP_MS === 3000, '每走一格最多 3 秒')
ok(/export const STAIR_MAX_STEPS/.test(mvSrc), '常量有导出（测试能拿到）')

section('2. 几何：上下都挖 3 格（fy / fy+1 / fy+2）')
ok(/const cells = \[fy, fy \+ 1, fy \+ 2\]\.map\(/.test(mvSrc),
  '上下同一套：fy / fy+1 / fy+2 三格（2026-10-25 用户「stair往上挖也是挖3格」）')
ok(!/const cells = up/.test(mvSrc), '不再按方向分两套格数')
ok(/const fy = up \? cur\.y \+ 1 : cur\.y - 1/.test(mvSrc), '每步升/降 1 格（没有平台步）')
ok(/const up = start\.y < ty/.test(mvSrc) && /if \(up \? cur\.y >= ty : cur\.y <= ty\)/.test(mvSrc), '目标更高就是上升阶梯（循环按方向判完成）')
ok(/if \(isAir\(floor\.name\)\) \{ reason = 'no-floor'; break \}/.test(mvSrc), '脚下是空就停（不往深洞挖）')
ok(/names\.some\(\(n\) => isLiquid\(n\)\)/.test(mvSrc), '三格里任何一格是液体就停')

section('3. 平台逻辑')
ok(!/STAIR_PLATFORM_EVERY/.test(mvSrc), '平台逻辑已彻底移除（2026-10-25 用户要求）')

section('4. 方向推导（纯函数）')
const bot = (x, y, z, yaw = 0) => ({ entity: { position: { x, y, z }, yaw } })
{
  const d = stairDirOf(bot(0, 64, 0), { pos: { x: 10, y: 50, z: 2 } })
  ok(d && d.x === 1 && d.z === 0, '目标在东边 ⇒ 朝 x+ 挖')
}
{
  const d = stairDirOf(bot(0, 64, 0), { pos: { x: 2, y: 50, z: -10 } })
  ok(d && d.z === -1 && d.x === 0, '目标在南边（z 小）⇒ 朝 z- 挖')
}
{
  const d = stairDirOf(bot(0, 64, 0), { pos: { x: 3, y: 50, z: 3 } })
  ok(d && Math.abs(d.x) === 1 && d.z === 0, '斜着给 ⇒ 取主轴（dx 与 dz 相等时取 x）')
}
{
  const d = stairDirOf(bot(0, 64, 0), { dir: 'z+' })
  ok(d && d.z === 1 && d.x === 0, 'dir:"z+" 直接用')
}
{
  const d = stairDirOf(bot(0, 64, 0), { dir: 'x-' })
  ok(d && d.x === -1, 'dir:"x-" 直接用')
}
{
  const d = stairDirOf(bot(0, 64, 0), {})
  ok(d && (Math.abs(d.x) === 1 || Math.abs(d.z) === 1), '都不给 ⇒ 按朝向（yaw=0 朝 -z）')
  ok(d && d.z === -1, 'yaw=0 时朝 z-')
}
{
  const d = stairDirOf(bot(0, 64, 0), { pos: { x: 0, y: 50, z: 0 } })
  ok(d === null, '目标就在脚下 ⇒ 算不出方向（返回 null）')
}
{
  const d = stairDirOf({ entity: null }, { dir: 'x+' })
  ok(d === null, '拿不到位置 ⇒ null（不崩）')
}

section('5. dig() 转调')
ok(/if \(mode === 'stair'\) return await digStair\(self, \{ pos, dir, targetY, maxSteps, budgetMs \}, ctx\)/.test(mvSrc),
  'dig() 在 requireBot 之前就转调 digStair（targetY 一起传）')
ok(/mode = 'block', dir = null, targetY = null, maxSteps = STAIR_MAX_STEPS, budgetMs = 10_000,/.test(mvSrc),
  'dig() 参数表有 mode/dir/targetY/maxSteps/budgetMs')
ok(/export async function digStair \(self, \{/.test(mvSrc), 'digStair 有导出')

section('6. 早退与报错')
ok(/已经在 y=\$\{start\.y\}/.test(mvSrc), '已经比目标低就直接说不用挖')
ok(/挖阶梯要知道挖到哪一层/.test(mvSrc), '不给 y 时报清楚的错')
ok(/算不出往哪挖/.test(mvSrc), '算不出方向时报清楚的错')
/* 🔴 2026-10-25 实机 bug：说明写「x/z 可选」，但 index.js 只在 x/y/z 齐全时才组 pos，
 *   于是 `mc_dig {mode:"stair", y:50, dir:"z+"}` 一路报「给 y」——用户明明给了。 */
ok(/const ty = Number\.isFinite\(Number\(targetY\)\) \? Math\.floor\(Number\(targetY\)\)/.test(mvSrc),
  '目标高度优先取 targetY（只给 y 也能用，不需要 x/z）')
ok(/pos && Number\.isFinite\(pos\.y\) \? Math\.floor\(pos\.y\) : null/.test(mvSrc),
  'targetY 没给时退回 pos.y（老写法照样能用）')
ok(/targetY = null, maxSteps = STAIR_MAX_STEPS/.test(mvSrc), 'digStair 参数表有 targetY')

section('7. mc_dig 工具面')
ok(/mode: \{ type: 'string', description: 'block（默认，挖方块）\/ stair（挖阶梯/.test(idxSrc), 'mc_dig 暴露 mode')
ok(/dir: \{ type: 'string', description: 'stair 专用/.test(idxSrc), 'mc_dig 暴露 dir')
ok(/maxSteps: \{ type: 'number', description: 'stair 专用/.test(idxSrc), 'mc_dig 暴露 maxSteps')
ok(/mode: args\.mode === 'stair' \? 'stair' : 'block',/.test(idxSrc), 'execute 把 mode 传下去')
ok(/targetY: Number\.isFinite\(Number\(args\.y\)\) \? Number\(args\.y\) : null,/.test(idxSrc),
  'execute 把 y 作为 targetY 单独传下去（不受 pos 三坐标齐全的限制）')
ok(/别指望 mc_move 挖竖井/.test(idxSrc), '描述里点明 move 不再挖竖井')
ok(/目标 y 比现在低就是往下挖、高就是往上挖/.test(idxSrc), '描述里点明 stair 双向（上/下）')

section('8. vendor 补丁：move 不许挖脚下')
ok(/move 不挖脚下：getMoveDown/.test(patchSrc), 'patch 脚本有 getMoveDown 补丁')
ok(/move 不挖脚下：getMoveDropDown/.test(patchSrc), 'patch 脚本有 getMoveDropDown 补丁')
ok(/if \(toBreak\.length > 0\) return/.test(patchSrc), '两处都是「要挖就不许掉下去」')

section('9. 结果文案')
ok(/再叫一次 `mc_dig \{mode:"stair", y:/.test(mvSrc), '预算用完时告诉它怎么接着挖')
ok(/前面是水\/岩浆/.test(mvSrc), '遇到水/岩浆有明确说明')
ok(/挖开了但没走过去/.test(mvSrc), '卡住时不建议原地重叫')

console.log(`\n${'─'.repeat(60)}`)
console.log(`check-mc-stair：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
