#!/usr/bin/env node
/**
 * check-map-slice.mjs —— `mc_map` 的竖直剖面（`axis:"x"` / `"z"` / `"all"`）
 *
 * 背景（2026-10-25 用户）：「map floor 加 x z all 的功能，默认还是 y」。
 * floor 原来是水平切片（固定 y 看 x-z 平面），看不到"洞顶多高 / 上面压着什么 / 有没有落石"。
 * 现在补另外两个方向：固定 x（或 z），纵轴是 y。
 *
 * 这里钉死的是**事实口径**：
 *   ① 行 = y（从 cy+up 到 cy-down，含两端），列 = 另一条水平轴（-R..R-1）；
 *   ② 分类只认四种：实心 / 空气 / 水 / 岩浆（+ 未加载），不做"能不能站"的判断；
 *   ③ 只有固定的那条线正好穿过我时才标 `@`；
 *   ④ `all` 三张一起给，默认仍是 `y`（不改变老行为）。
 *
 * 用法：node tools/check-map-slice.mjs（**必须从包目录跑**）
 */
import { readFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import { sliceMapOf, sliceMapText, sliceKeyOf, SLICE_GLYPH } from '../src/map-render.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')) } }
const section = (t) => console.log('\n── ' + t + ' ──')

const src = readFileSync(new URL('../src/map-render.mjs', import.meta.url), 'utf8')
const idxSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

/** 假世界：y<=61 石头、y=62 水、y>=63 空气；另外 (2,64,0) 放岩浆 */
const mkBot = (x = 0.5, y = 64, z = 0.5) => ({
  entity: { position: new Vec3(x, y, z) },
  blockAt: (v) => {
    const bx = Math.floor(v.x), by = Math.floor(v.y), bz = Math.floor(v.z)
    if (bx === 2 && by === 64 && bz === 0) return { name: 'lava' }
    if (by <= 61) return { name: 'stone' }
    if (by === 62) return { name: 'water' }
    return { name: 'air' }
  },
})

section('1. 单格分类')
{
  const b = mkBot()
  ok(sliceKeyOf(b, 0, 60, 0) === 'solid', 'y=60 石头 ⇒ solid')
  ok(sliceKeyOf(b, 0, 62, 0) === 'liquid', 'y=62 水 ⇒ liquid')
  ok(sliceKeyOf(b, 2, 64, 0) === 'lava', '岩浆 ⇒ lava')
  ok(sliceKeyOf(b, 0, 70, 0) === 'air', 'y=70 空气 ⇒ air')
  ok(sliceKeyOf({ blockAt: () => null }, 0, 64, 0) === 'unknown', '读不到（区块没加载）⇒ unknown')
  ok(sliceKeyOf({ blockAt: () => { throw new Error('x') } }, 0, 64, 0) === 'unknown', 'blockAt 抛错 ⇒ unknown（不崩）')
}

section('2. 形状：行=y、列=水平轴')
{
  const b = mkBot()
  const m = sliceMapOf(b, { axis: 'x', radius: 4, up: 3, down: 2 })
  ok(m.axis === 'x' && m.fixed === 0, 'axis:"x" ⇒ 固定我自己那一格 x=0')
  ok(m.topY === 67 && m.bottomY === 62, 'topY=cy+up=67、bottomY=cy-down=62')
  ok(m.names.length === 6, '行数 = up+down+1 = 6（含两端）', 'rows=' + m.names.length)
  ok(m.names[0].length === 8, '列数 = 2R = 8', 'cols=' + m.names[0].length)
  ok(m.names[0][0] === 'air' && m.names[5][0] === 'liquid', '第一行（y=67）空气、最后一行（y=62）水')
  ok(m.self && m.self.row === 3 && m.self.col === 4, '@ 落在 cy 那一行、中心列', JSON.stringify(m.self))
}

section('3. axis:"z" 与 layer')
{
  const b = mkBot()
  const m = sliceMapOf(b, { axis: 'z', radius: 3, up: 1, down: 1 })
  ok(m.axis === 'z' && m.fixed === 0, 'axis:"z" ⇒ 固定 z=0')
  ok(m.names.length === 3 && m.names[0].length === 8, '行 = up+down+1、列 = 2R（radius 有 4 的下限）')
  const off = sliceMapOf(b, { axis: 'x', layer: 5, radius: 3, up: 1, down: 1 })
  ok(off.fixed === 5, '给了 layer ⇒ 固定在那条线上')
  ok(off.self === null, '固定的那条线没穿过我 ⇒ 不画 @（self=null）')
}

section('4. 字符图')
{
  const b = mkBot()
  const m = sliceMapOf(b, { axis: 'x', radius: 4, up: 2, down: 3 })
  const text = sliceMapText(m)
  const lines = text.split('\n')
  ok(lines.length === 6, '行数 = 6（up 2 + down 3 + 1）', 'lines=' + lines.length)
  ok(lines[0].length === 8, '每行 8 个字符（2R，radius 下限 4）', 'len=' + lines[0].length)
  ok(/#/.test(text) && /~/.test(text) && /\./.test(text), '实心 # / 水 ~ / 空气 . 都画出来了')
  ok(/@/.test(text), '自己那格画成 @')
  ok(SLICE_GLYPH.lava === '≈' && SLICE_GLYPH.unknown === '?', '图例字符对得上（岩浆 ≈ / 未加载 ?）')
  ok(sliceMapText(m, { step: 2 }).split('\n').length === 3, 'step:2 ⇒ 抽稀（5 行变 3 行）')
}

section('5. mc_map 接线')
{
  ok(/axis: \{ type: 'string', description: 'floor 的切片方向/.test(idxSrc), 'mc_map 暴露 axis 参数')
  ok(/String\(args\.axis \?\? 'y'\)/.test(idxSrc), 'axis 默认 y（老行为不变）')
  ok(/axisArg === 'all' \? \['y', 'x', 'z'\] : \[axisArg\]/.test(idxSrc), 'axis:"all" 三张一起给')
  ok(/sliceMapOf\(bot, \{ axis: ax, layer: args\.layer/.test(idxSrc), '接线走 sliceMapOf')
  ok(/sliceMapText\(sm, \{ step, compress/.test(idxSrc), '接线走 sliceMapText')
  ok(/sliceMapOf, sliceMapText \} from '\.\/src\/map-render\.mjs'/.test(idxSrc), 'import 里有 sliceMapOf / sliceMapText')
}

console.log(`\ncheck-map-slice：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
