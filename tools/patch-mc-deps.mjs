#!/usr/bin/env node
/**
 * tools/patch-mc-deps.mjs —— 把我们对 **vendor 依赖**（`mineflayer-pathfinder` 等）打的补丁重新打上。
 *
 * 为什么要这个脚本：vendor 树在 `%USERPROFILE%\.dsh\profiles\<profile>\vendor\mc-deps\`
 * 里（见 PATHFINDER.md），重装 / 升级依赖时会被整包覆盖，我们改过的文件就回到原版 ——
 * 症状是「以前修好的毛病又回来了」，而且很难联想到是依赖被覆盖。
 *
 * 用法：
 *   node tools/patch-mc-deps.mjs           # 打补丁（幂等，已打过就跳过）
 *   node tools/patch-mc-deps.mjs --check   # 只检查，不改文件；缺补丁时 exit 1
 *   node tools/patch-mc-deps.mjs --dir <vendor 树>   # 指定 vendor 目录
 *
 * 目前自动化的是 `mineflayer-pathfinder/index.js` 里的四处（2026-10-24 垫柱悬空）。
 * 其它补丁（`lib/physics.js` 的 canStraightLine、`lib/movements.js` 的斜切拐角、
 * index.js 的水下 jump）只做**存在性检查** —— 它们的改法写在踩坑档案里，脚本不重放。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const dirArgIdx = args.indexOf('--dir')
const DIR_ARG = dirArgIdx >= 0 ? args[dirArgIdx + 1] : null

/** 找 vendor 树（含 node_modules/mineflayer-pathfinder 的目录） */
function pickVendor () {
  const cands = []
  if (DIR_ARG) cands.push(DIR_ARG)
  if (process.env.DSH_MC_AGENT_MC_DEPS) cands.push(process.env.DSH_MC_AGENT_MC_DEPS)
  cands.push(join(HERE, '..', '..', 'vendor', 'mc-deps'))
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profRoot = join(home, 'profiles')
  if (existsSync(profRoot)) {
    for (const ent of readdirSync(profRoot, { withFileTypes: true })) {
      if (ent.isDirectory()) cands.push(join(profRoot, ent.name, 'vendor', 'mc-deps'))
    }
  }
  for (const c of cands) {
    const nm = join(c, 'node_modules')
    if (existsSync(nm) && existsSync(join(nm, 'mineflayer-pathfinder'))) return c
  }
  return null
}

const VENDOR = pickVendor()
if (!VENDOR) {
  console.error('✗ 找不到 vendor 树（含 node_modules/mineflayer-pathfinder）。用 --dir 指定。')
  process.exit(1)
}
const PF_DIR = join(VENDOR, 'node_modules', 'mineflayer-pathfinder')
const IDX = join(PF_DIR, 'index.js')

let src = readFileSync(IDX, 'utf8')
const EOL = src.includes('\r\n') ? '\r\n' : '\n'
let changed = 0
let missing = 0

/** 幂等替换：已含新文本就跳过；否则要求旧锚点存在 */
function rep (oldText, newText, label) {
  const n = newText.split('\n').join(EOL)
  if (src.includes(n)) { console.log(`  = ${label}（已打过）`); return }
  const o = oldText.split('\n').join(EOL)
  if (!src.includes(o)) { console.error(`  ✗ ${label}：锚点找不到（vendor 版本变了？）`); missing++; return }
  src = src.replace(o, n)
  changed++
  console.log(`  + ${label}`)
}

console.log(`vendor: ${VENDOR}`)
console.log('mineflayer-pathfinder/index.js:')

rep(
  '  let placingBlock = null\n  let lastNodeTime = performance.now()',
  '  let placingBlock = null\n  let placingStartedAt = 0\n  let digStartedAt = 0\n  let lastNodeTime = performance.now()',
  '计时变量：placingStartedAt / digStartedAt'
)

rep(
  `      if (!placing) {
        placing = true
        placingBlock = nextPoint.toPlace.shift()
        fullStop()
      }`,
  `      if (!placing) {
        placing = true
        placingStartedAt = performance.now()
        placingBlock = nextPoint.toPlace.shift()
        fullStop()
      }`,
  '垫柱计时：记录开始时间'
)

rep(
  `      let canPlace = true
      if (placingBlock.jump) {
        bot.setControlState('jump', true)
        canPlace = placingBlock.y + 1 < bot.entity.position.y
      }`,
  `      let canPlace = true
      if (placingBlock.jump) {
        /* 🔴 2026-10-24 DSH 补丁：原来"先按 jump，再判断够不够高"，
         * 而这条路径末尾的 \`return\` 在 3500ms 卡住检测**之前** ——
         * 头顶被顶板 / 树叶挡住、永远升不到放置高度时，jump 会一直按着，
         * 卡住检测永远轮不到它。实机现象：「正在垫方块往上爬，悬空超过 3 秒才掉下来」。
         * 现在：达不到高度只按有限的时间（bot.pathfinder.placeJumpTimeout，默认 1500ms），
         * 到点就松开 jump 并 resetPath，让外层照常重算 / 换招。 */
        canPlace = placingBlock.y + 1 < bot.entity.position.y
        if (!canPlace) {
          const jumpLimit = bot.pathfinder.placeJumpTimeout ?? 1500
          if (performance.now() - placingStartedAt > jumpLimit) {
            bot.setControlState('jump', false)
            resetPath('place_jump_timeout')
            return
          }
          bot.setControlState('jump', true)
          return
        }
        bot.setControlState('jump', false)
      }`,
  '垫柱跳跃：限时 + 达不到高度就松手'
)

rep(
  `          })
          .catch(_ignoreError => {})
      }
      return`,
  `          })
          .catch(_ignoreError => {
            /* 🔴 2026-10-24 DSH 补丁：装备失败原来什么都不做 ⇒ lockEquipItem 永不释放、
             * placing 永远为 true，这条路径**永久卡死**（每 tick 都在 tryAcquire 处 return，
             * 连 3500ms 卡住检测都到不了）。 */
            lockEquipItem.release()
            resetPath('equip_error')
          })
      }
      return`,
  '装备失败：释放锁 + 结束路径'
)

/* ── 2026-10-24 寻路通审：挖掘分支的永久粘住 ───────────────────────────── */
rep(
  `      if (!digging && bot.entity.onGround) {
        digging = true
        const b = nextPoint.toBreak.shift()`,
  `      if (!digging && bot.entity.onGround) {
        digging = true
        digStartedAt = performance.now()
        const b = nextPoint.toBreak.shift()`,
  '挖掘计时：记录开始时间'
)

rep(
  `    if (digging) {
      bot.on('diggingAborted', detectDiggingStopped)
      bot.on('diggingCompleted', detectDiggingStopped)
      bot.stopDigging()
    }`,
  `    if (digging) {
      /* 🔴 2026-10-24 DSH 补丁：原来只注册事件、等 diggingAborted/diggingCompleted 来复位
       * digging。但 stopDigging() 在方块已经不存在（被别人挖了 / 服务端没回包）时
       * **一个事件都不会发** ⇒ digging 永远是 true ⇒ 之后每次移动都在挖掘分支 return，
       * 永久卡死，只能重连。实机现象：「完全卡住，tp 也不行，最后重进才好」。 */
      digging = false
      try { bot.stopDigging() } catch (e) {}
    }`,
  '挖掘状态：resetPath 时直接复位'
)

rep(
  `      return
    }
    // Handle block placement
    // TODO: sneak when placing or make sure the block is not interactive`,
  `      /* 🔴 2026-10-24 DSH 补丁：挖掘分支的 return 在 3500ms 卡住检测**之前** ——
       * 服务端不回包时 digging 永远是 true，每 tick 都在这里 return，卡住检测永远轮不到。 */
      if (digging && performance.now() - digStartedAt > (bot.pathfinder.digTimeout ?? 8000)) {
        try { bot.stopDigging() } catch (e) {}
        digging = false
        resetPath('dig_timeout')
      }
      return
    }
    // Handle block placement
    // TODO: sneak when placing or make sure the block is not interactive`,
  '挖掘分支：加超时（digTimeout，默认 8000ms）'
)

rep(
  `          bot.equip(tool, 'hand')
            .catch(_ignoreError => {})
            .then(() => digBlock())`,
  `          bot.equip(tool, 'hand')
            .then(() => digBlock())
            .catch(_ignoreError => {
              /* 🔴 2026-10-24 DSH 补丁：装备失败原来照样硬挖（拿着手上的错工具白等几秒，
               * 然后被判卡）。现在失败就结束这条路径。 */
              resetPath('dig_equip_error')
            })`,
  '挖前装备失败：结束路径而不是硬挖'
)

/* ── 2026-10-24 寻路通审：开门失败无限重试 ───────────────────────────── */
rep(
  `        }, err => {
          console.error(err)
          lockUseBlock.release()
        })`,
  `        }, err => {
          console.error(err)
          lockUseBlock.release()
          /* 🔴 2026-10-24 DSH 补丁：原来只 release 锁，placingBlock 不前进也不 resetPath
           * ⇒ 下一 tick 重试同一扇门；门打不开（铁门 / 被挡 / 够不着）就**无限重试**。 */
          resetPath('use_block_error')
        })`,
  '开门失败：结束路径而不是无限重试'
)

/* ── 2026-10-24 寻路通审：起点偏移用错 movements 对象 ─────────────────── */
rep(
  'const offset = (b && dy > 0.001 && bot.entity.onGround && !stateMovements.emptyBlocks.has(b.type)) ? 1 : 0',
  'const offset = (b && dy > 0.001 && bot.entity.onGround && !movements.emptyBlocks.has(b.type)) ? 1 : 0',
  '起点偏移：用传入的 movements 而不是全局 stateMovements'
)

if (!CHECK_ONLY && changed > 0) writeFileSync(IDX, src)

/* ── goto.js：noPath 被当成"到了" ─────────────────────────────────────── */
const GOTO = join(PF_DIR, 'lib', 'goto.js')

function repIn (file, oldText, newText, label) {
  const txt = readFileSync(file, 'utf8')
  const eol = txt.includes('\r\n') ? '\r\n' : '\n'
  const n = newText.split('\n').join(eol)
  if (txt.includes(n)) { console.log(`  = ${label}（已打过）`); return }
  const o = oldText.split('\n').join(eol)
  if (!txt.includes(o)) { console.error(`  ✗ ${label}：锚点找不到（vendor 版本变了？）`); missing++; return }
  if (!CHECK_ONLY) writeFileSync(file, txt.replace(o, n))
  changed++
  console.log(`  + ${label}`)
}

console.log('\nmineflayer-pathfinder/lib/goto.js:')
repIn(
  GOTO,
  `    function noPathListener (results) {
      if (results.path.length === 0) {
        cleanup()
      } else if (results.status === 'noPath') {
        cleanup(error('NoPath', 'No path to the goal!'))
      } else if (results.status === 'timeout') {
        cleanup(error('Timeout', 'Took to long to decide path to goal!'))
      }
    }`,
  `    function noPathListener (results) {
      /* 🔴 2026-10-24 DSH 补丁：原来**先**判 \`path.length === 0\` 就 cleanup()（= 当成功），
       * 而 noPath 时 bestNode 往往就是起点、path 正好为空 ⇒「无路可走」被当成「到了」。
       * 外层于是收到 resolve，只能靠"到了但还差 N 格"去反推，归因全错。 */
      if (results.status === 'noPath') {
        cleanup(error('NoPath', 'No path to the goal!'))
      } else if (results.status === 'timeout') {
        cleanup(error('Timeout', 'Took to long to decide path to goal!'))
      } else if (results.path.length === 0) {
        cleanup()
      }
    }`,
  'noPath 不再被当成到达'
)
if (CHECK_ONLY) console.log(`  （--check：未写文件）`)

/* ── movements.js：自己骑的船被当成障碍（A* 每格 +entityCost） ─────────── */
console.log('\nmineflayer-pathfinder/lib/movements.js:')
repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `  updateCollisionIndex () {
    for (const ent of Object.values(this.bot.entities)) {
      if (ent === this.bot.entity) { continue }
`,
  `  updateCollisionIndex () {
    for (const ent of Object.values(this.bot.entities)) {
      if (ent === this.bot.entity) { continue }
      /* 🔴 2026-10-24 DSH 补丁：**自己骑的那条船 / 矿车**也在 bot.entities 里。
       * 原来只跳过 bot.entity ⇒ 骑着船寻路时，脚下的船被算成障碍（每格 +entityCost，我们设的 8），
       * 下船后船还停在原地继续挡路 —— 实机现象：「在船上 / 刚下船后基本走不了，走得很慢」。 */
      if (this.bot.vehicle && ent === this.bot.vehicle) { continue }
`,
  '自己骑的载具不算障碍'
)

repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `    if (!blockC.physical) {
      if (node.remainingBlocks === 0) return // not enough blocks to place`,
  `    /* 🔴 2026-10-24 DSH 补丁（实机：浅水里卡住，垫方块 place_error ×8）：
     * 水不是 physical，但它**能站**。原来没判 liquid，A* 把“目标格是水”当成“目标格是空气”，
     * 于是规划出“往水里垫方块”的路 —— 而水下放置没有可依附的面，
     * 服务端必拒（\`the block is still air\`）。表现：“完全卡住、动不了”。 */
    if (!blockC.physical && !blockC.liquid) {
      if (node.remainingBlocks === 0) return // not enough blocks to place`,
  '水里不垫方块：jumpUp 目标格是水'
)

repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `      if (!blockD.physical) {
        if (node.remainingBlocks === 1) return // not enough blocks to place`,
  `      /* 🔴 2026-10-24 DSH 补丁：脚下那格是水也不垫。 */
      if (!blockD.physical && !blockD.liquid) {
        if (node.remainingBlocks === 1) return // not enough blocks to place`,
  '水里不垫方块：脚下那格是水'
)

/* ── 其它补丁只做存在性检查（改法在踩坑档案里，不在这里重放） ───────────── */
console.log('\n其它已知补丁（只检查）：')
const checks = [
  [join(PF_DIR, 'lib', 'physics.js'), /simulateStraight|collides\s*\(pos\)/, 'lib/physics.js：canStraightLine 假阳性'],
  [join(PF_DIR, 'lib', 'movements.js'), /cost1\s*>\s*0\s*\|\|\s*cost2\s*>\s*0/, 'lib/movements.js：禁斜切拐角'],
  [IDX, /waterCeil/, 'index.js：水下 jump 看头顶净空']
]
for (const [file, re, label] of checks) {
  if (!existsSync(file)) { console.error(`  ✗ ${label}：文件不存在`); missing++; continue }
  const txt = readFileSync(file, 'utf8')
  if (re.test(txt)) console.log(`  ✓ ${label}`)
  else { console.error(`  ✗ ${label}：**没打**（重装后需按踩坑档案手工补）`); missing++ }
}

if (missing > 0) {
  console.error(`\n✗ ${missing} 处缺失`)
  process.exit(1)
}
console.log(`\n${CHECK_ONLY ? '✓ 全部补丁在位' : `✓ 完成（本次新打 ${changed} 处）`}`)
