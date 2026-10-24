/* ============================================================================
 * 挖掘 —— 两件事：按坐标破坏一块方块（`mc_act {mode:"break"}`）、挖方块（`mc_dig`）
 *
 * 路线图第 ④ 条第三十八刀从 `src\core.mjs` 搬出来。这一层只做"把一块方块挖掉"，
 * 所有判断都靠已经搬出去的邻居：
 *   · `blockReachOf`（world-observer）：**眼睛→方块中心** ≤ 4.5（生存）/ 5.0（创造）才动手
 *   · `ctx.waitGrounded`（dig-guard）：空中挖慢 5 倍，先等落地
 *   · `ctx.equipFor`（inventory）：动手前换到对的工具；换不上直接拒绝，不硬挖
 *   · `digMsFor`（dig-speed）：这块按手上的东西要几秒；**时间不够就别开始挖**
 *     （到点松手 = 破坏进度清零，白玩一次调用）
 *   · `ctx.watchServerBreak` / `ctx.awaitServerBreak`（server-break）：服务端的判决才是判决 ——
 *     "改成空气"＝挖掉、"改成非空气"＝复原（服务端没认）、其余＝没有证据
 *   · `dropHint`（world-observer）：真挖掉了就点一句"东西还在地上"
 *
 * 参数：`self` = McBot（只读 `callLeft()` / `log()` / `requireBot()`），
 *       `ctx` = 五个私有回调（见 core 的 `#mineCtx()`）。
 * 判据：模块不 import `core.mjs`、不 import 游戏库（只认 `b.blockAt` / `b.dig` / `b.game`）。
 * ========================================================================== */

import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg

import { sleep, DESYNC_HINT } from './async-util.mjs'
import { isAir, isLiquid, isSolidBlock, isPassable } from './block-names.mjs'
import { heldText, canHarvestNow, canBreakNow, toolKinds, countOf, durWarnText } from './inventory.mjs'
import { digMsFor } from './dig-speed.mjs'
import { blockReachOf, slowDigWhy, stateNameOf, dropHint, dropListOf } from './world-observer.mjs'
import { waitForPickup } from './pickup.mjs'
import { classifyRestore, restoreLocalBlock } from './server-break.mjs'
import { callBudget, callSecText } from './budget.mjs'
import { dangerNow, dangerText, dangerNotice, healthOf, noticeKey } from './danger.mjs'

/* 「挖到刚好够合成就不挖了」—— 收工时补一句（用户 2026-10-13 报的毛病）。
 *
 * 判据**不是**"手头有几个"，而是**附近还有没有同一种矿**（用户后来改的：
 * 不要定数量，让它把同一条矿脉挖干净）。所以只在"刚挖掉的那一格附近还有同一串矿"
 * 时提醒，并且报出**还剩几块**，让模型自己决定挖到哪：
 *   - 附近一块都不剩（或只剩一块孤零零的）⇒ 不啰嗦，它已经挖干净了；
 *   - 手头已经很多也不管 —— 矿脉就在旁边，顺手挖完永远是对的。
 * `mc_dig` 一轮挖不完时本来就会说"还有 N 个没挖"，所以预算用光那条路不再补这句。
 */
const VEIN_RE = /(_ore$|^ancient_debris$)/
const VEIN_RADIUS = 12
const VEIN_LEFT_MIN = 2
/** 矿 → 挖出来会变成什么（用来报"手头有多少"，只报背包里真有的）。 */
const VEIN_HAVE = {
  diamond_ore: ['diamond'],
  deepslate_diamond_ore: ['diamond'],
  iron_ore: ['raw_iron', 'iron_ingot'],
  deepslate_iron_ore: ['raw_iron', 'iron_ingot'],
  gold_ore: ['raw_gold', 'gold_ingot'],
  deepslate_gold_ore: ['raw_gold', 'gold_ingot'],
  nether_gold_ore: ['raw_gold', 'gold_ingot'],
  coal_ore: ['coal', 'charcoal'],
  deepslate_coal_ore: ['coal', 'charcoal'],
  copper_ore: ['raw_copper', 'copper_ingot'],
  deepslate_copper_ore: ['raw_copper', 'copper_ingot'],
  lapis_ore: ['lapis_lazuli'],
  deepslate_lapis_ore: ['lapis_lazuli'],
  emerald_ore: ['emerald'],
  deepslate_emerald_ore: ['emerald'],
  redstone_ore: ['redstone'],
  deepslate_redstone_ore: ['redstone'],
  ancient_debris: ['ancient_debris'],
}

/** 掉落物的人话坐标（给多块挖矿的"没捡到"那句话用）；一个都没有回空串 */
function dropsWhereText (b, radius = 8) {
  const list = dropListOf(b, { radius, limit: 3 })
  if (!list.length) return ''
  return list.map((d) => {
    const nm = d.name ? d.name + ' ' : ''
    return `${nm}@ (${d.x},${d.y},${d.z}) ${d.dist} 格`
  }).join('、')
}

/**
 * 收工提醒：这次挖的是矿石、而且**附近 12 格内还剩两块以上同一种矿**时，返回一句话；否则 null。
 * 扫的是机器人**当前站位**附近（它刚站在这条矿脉边上）。
 */
export function veinHint (b, minedName) {
  const nm = String(minedName ?? '')
  if (!VEIN_RE.test(nm)) return null
  let left = 0
  try {
    const hits = b?.findBlocks?.({ matching: (blk) => blk?.name === nm, maxDistance: VEIN_RADIUS, count: 64 })
    left = Array.isArray(hits) ? hits.length : 0
  } catch { return null }
  if (left < VEIN_LEFT_MIN) return null
  const got = (VEIN_HAVE[nm] ?? []).map((k) => [k, countOf(b, k) ?? 0]).filter(([, v]) => v > 0)
  const label = got.length ? `（手头 ${got.map(([k, v]) => `${k}×${v}`).join(' + ')}）` : ''
  return `　💡 附近 ${VEIN_RADIUS} 格内还有 **${left} 块 ${nm}**${label} —— 把这条矿脉挖干净再走：`
    + `接着 \`mc_dig {name:"${nm}", count:8, maxDistance:${VEIN_RADIUS}}\`，直到结果里出现"附近找不到 ${nm}"。`
    + '回头补料比多挖几块贵得多。'
}

/**
 * 「挖脚下方块」的安全检查 —— 2026-10-18 审计（P1-5）。
 *
 * 现象：`mc_dig` / `mc_act {mode:"break"}` 挖**自己站着的那一格**（或它脚下）时没有任何检查，
 * 下面若是岩浆 / 悬空 / 水就直接掉下去 —— 实机摔死过（y=68 → 47）。
 *
 * 判据刻意保守，只拦「**这一格就是我的支撑**」这一种：
 *   · 方块在**脚下**（同一列、`pos.y === 脚下方块的 y`），或
 *   · 方块**和我脚同层**（同一列、`pos.y === 脚 y`，挖掉后脚下可能是空的）
 * 并且往下 3 格量一遍：第一格不是实心（悬空）或第一格/第二格是液体 ⇒ 有风险。
 *
 * 返回 `{ bad, why, below }`，`bad=false` 表示照挖。**不检查远处的方块** —— 那是寻路和搭路的事。
 */
function underfootRiskOf (b, pos) {
  const p = b.entity?.position
  if (!p) return null
  const feet = p.floored()
  const sameColumn = pos.x === feet.x && pos.z === feet.z
  /* 只有"脚底下**垫着**的那一格"才算拆支撑 —— 站的那一格本身（`feet.y`）永远是空气，
   * 挖同层的方块不会让人掉下去（水平相邻的方块另算，那是寻路的事）。 */
  const mineSupport = pos.y === feet.y - 1
  if (!sameColumn || !mineSupport) return null
  const below = []
  for (let dy = 1; dy <= 3; dy++) {
    const c = b.blockAt(new Vec3(pos.x, pos.y - dy, pos.z))
    below.push(c ? c.name : null)
  }
  const first = below[0]
  const second = below[1]
  const liquid = (n) => n != null && isLiquid(n)
  /* 🔴 `null` = 那一格没加载（"不知道"），**不当成"空"** —— 否则在测试/新区块里
   *    每次挖脚下方块都会被拦，而在真世界里脚下总是加载好的。
   *    只有**读到了**"不是实心"或"是液体"才判危险。 */
  const bad = (first != null && !isSolidBlock(first)) || liquid(first) || liquid(second)
  return {
    bad,
    why: bad
      ? `正下方只有 ${below.map((n) => n ?? '未加载').join(' / ')} —— 挖掉这一格就掉下去了`
      : null,
    below,
  }
}

export async function breakBlock (self, { x, y, z, allowDangerous = false } = {}, ctx = {}) {
  const b = self.requireBot()
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const blk = b.blockAt(pos)
  if (!blk) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载`)
  if (isAir(blk.name)) {
    return {
      broken: null, at: { x: pos.x, y: pos.y, z: pos.z },
      note: '那里本来就是空气（**我这边**读到的）—— 要么已经挖掉了，要么客户端的区块缓存旧了：'
        + '先 `mc_scan` 看看附近实际有什么。'
        + DESYNC_HINT,
    }
  }
  const name = blk.name
  /* ①′ 挖自己脚下 = 拆自己的支撑（2026-10-18 审计 P1-5）：下面若是岩浆/悬空/水，
   *    挖下去人就跟着掉。**默认拦住**，要拆就说 `allowDangerous:true`。 */
  const risk = allowDangerous ? null : underfootRiskOf(b, pos)
  if (risk?.bad) {
    return {
      broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
      dangerous: true,
      note: `挖这一格会把自己脚下的支撑拆掉：${risk.why}`
        + ' —— **我没开始挖**。真要走的话先横着挪一格（`mc_move`），或确实想拆就带上 `allowDangerous:true`。',
    }
  }
  /* 🔴 2026-10-08 第五份审计报告 ② + 实机定论：`breakBlock` 以前**完全没有"够不着"检查**（dig 有）。
   *    上游 `digging.js` 的 `canDigBlock` 要求**眼睛到方块中心** ≤ 5.1，服务端生存 reach 是 4.5；
   *    对够不着的方块动手 = 服务端静默忽略 + 报告 ① 的客户端预测 ⇒ **静默假成功**。
   *    ⚠️ 判据必须是 `#reachOf`（眼→中心）：用"脚→坐标"算的话，正下方 4 格的方块会被判"够得着"。 */
  const dist = blockReachOf(b, blk)
  const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
  if (dist > reachMax) {
    return {
      broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
      held: heldText(b), reach: Math.round(dist * 100) / 100,
      note: `够不着（我在 ${Math.round(dist * 100) / 100} 格外，${b.game?.gameMode === 'creative' ? '创造 5' : '生存 4.5'} 格以内才挖得动）`
        + ' —— **我没开始挖**（服务端会静默忽略，然后报个假的"挖掉了"）。先 `mc_move` 走到它旁边再挖。',
    }
  }
  // ①′ 空中挖慢 5 倍（`bot.digTime` 的 `notOnGround`）⇒ 先等落地再动手，别把预算喂给一次注定超时的挖掘
  if (!await ctx.waitGrounded(b, Math.min(1_500, Math.max(0, self.callLeft() - 800)))) {
    return {
      broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
      held: heldText(b),
      note: '我还在空中（没落地）—— 空中挖方块慢 5 倍（徒手原木 3 秒变 15 秒），'
        + '**我没开始挖**。先站稳（`mc_move {mode:"jump"}` 换个落脚点，或等一下）再叫一次。',
    }
  }
  // ① 先换到对的工具（背包里有的话）—— "手上攥着泥土刨石头"是"一直超时"的头号原因
  const t = await ctx.equipFor(b, blk, `换工具挖 ${name}`)
  // ② 换不上就**别硬挖**：徒手挖石头要 7.5 秒，比一轮预算还长，只会白花时间 + 报个假原因
  /* 🔴 2026-10-24 用户实机（挖雪三坑之一）：「雪块只能锹挖，手上是铁镐/钻石镐都没用」——
   *    这句话只对了一半：**没有锹就没有掉落**，但雪块徒手 0.3 秒就挖开。
   *    以前这里 `!canHarvestNow` 一律抛错，于是"挖开它爬上去"这种正当需求被挡死；
   *    用户当时的处境是竖井顶上就是雪块、退无可退 ⇒ 报错 → 想做锹 → 要木头 → 木头在地表 →
   *    地表被雪盖着 ⇒ 死循环。现在分开判：挖得动就挖（并说明没掉落），挖不动才拦。 */
  const noDrop = !canHarvestNow(b, blk)
  if (noDrop && !canBreakNow(b, blk)) {
    throw new Error(`手上是 ${t.held}，挖 ${name} ${toolKinds(b, blk)} —— 背包里也没有能挖它的东西。`
      + '先 mc_craft 一把（木镐 = 3 木板 + 2 木棍），或先 mc_act{mode:"equip",name:"…"} 换一个。硬挖会一直超时。')
  }
  const digMs = digMsFor(b, blk, b?.heldItem?.type ?? null)
  /* 🔴 时间不够就**别开始挖**（2026-10-08 实机反馈：玩家转来 AI 的话"快挖完的时候会重置"）。
   *    到点松手 = 破坏进度清零、白费一次调用；模型连着叫三次就是"挖到八成又从头来"。
   *    宁可如实说"我没开始挖"，让它专门再叫一次。 */
  const leftMs = self.callLeft()
  if (digMs != null && leftMs < digMs + 900) {
    return {
      broken: false,
      at: { x: pos.x, y: pos.y, z: pos.z },
      now: name,
      held: heldText(b),
      digMs,
      budgetMs: Math.round(leftMs),
      ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
      note: `这一轮只剩 ${Math.round(leftMs)}ms，这块按手上的东西要 ${(digMs / 1000).toFixed(1)} 秒${slowDigWhy(b)} —— **我没开始挖**`
        + '（挖到一半到点松手，破坏进度会清零，白费一次调用）。再叫一次 `mc_act {mode:"break"}` 专门挖它就行。',
    }
  }
  /* 动手之前就挂上"服务端认没认"的监听（报告 ①）。 */
  const watch = ctx.watchServerBreak(b, pos)
  let timedOut = false
  try {
    await ctx.t(b.dig(blk, true), 'digBlock', `破坏 ${name}`)
  } catch (e) { if (e?.mcTimeout) timedOut = true; else { watch.stop(); throw e } }
  /* 🔴 超时**不代表没挖掉**：`withTimeout` 只是让我们不等了，mineflayer 那边的挖矿循环还在发包，
   *    方块往往过一会儿就真没了（2026-10-08 实机：连着两次 `mc_act{break}` 都回"那里本来就是空气"）。
   *    所以超时时多等一会儿再复查，别急着报"没挖掉"。
   *    ⚠️ 等的是**服务端的包**（`#awaitServerBreak`），不是干睡 —— 客户端那个 air 是预测，不算数。 */
  await ctx.awaitServerBreak(b, watch, { maxMs: timedOut ? 900 : 1_200 })
  // 同样要验证：挖失败（服务端拒绝/失步）不能报"broken: name"
  const now = b.blockAt(pos)?.name ?? null
  const localGone = now !== name
  /* 没挂上监听（假 bot）时**别下结论**：报 `null` 而不是 false（"没收到回包"是结论，不能凭空说）。 */
  /* 🔴 服务端把这个位置改成了**非空气** —— 得先看是不是**同一个方块**（`classifyRestore`）：
   *   同一个 ⇒ 真拒绝（复原）；变成**液体** ⇒ 破坏其实成功了（冰挖掉就是水，海草/海带同理）；别的 ⇒ 客户端区块旧了。 */
  const rest = classifyRestore(watch)
  const confirmed = watch.watching ? (watch.hit() || rest?.kind === 'liquid') : null
  watch.stop()
  const held = heldText(b)
  if (rest?.kind === 'same') {
    await sleep(150)                      // 等客户端把服务端这个包应用上，好报出"复原成什么"
    /* 服务端包里的状态 id 是**权威**的（本地 `blockAt` 可能还没应用上这个包，会读成 air）⇒ 优先用它。 */
    const back = rest.name ?? stateNameOf(b, watch.restored()) ?? b.blockAt(pos)?.name ?? '别的方块'
    self.log(`⚠️ 服务端把 ${name} 复原了（${pos.x},${pos.y},${pos.z}）—— 这次破坏没被认`)
    return {
      broken: false, restored: true, at: { x: pos.x, y: pos.y, z: pos.z }, now: back,
      held, reach: Math.round(blockReachOf(b, blk) * 100) / 100,
      ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
      ...(digMs != null ? { digMs } : {}),
      note: `服务端把这块**改回了 ${back}**（复原）—— 这次破坏服务端没认（多半是我离得远，或客户端区块旧了）。`
        + '先 `mc_move` 走到它旁边（3 格以内）再叫一次。'
        + slowDigWhy(b)
        + DESYNC_HINT,
    }
  }
  if (rest?.kind === 'other') {
    await sleep(150)
    const back = rest.name ?? '别的方块'
    self.log(`⚠️ 服务端说 ${pos.x},${pos.y},${pos.z} 是 ${back}，和我以为的 ${name} 不一样 —— 客户端区块旧了？`)
    return {
      broken: false, restored: true, desync: true, at: { x: pos.x, y: pos.y, z: pos.z }, now: back,
      held, reach: Math.round(blockReachOf(b, blk) * 100) / 100,
      ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
      ...(digMs != null ? { digMs } : {}),
      note: `服务端说这一格是 **${back}**，和我这边看到的 **${name}** 不一样（客户端区块旧了）—— 这次破坏没被认。`
        + '先 `mc_scan` 复核一眼，别照着旧方块继续动手。'
        + DESYNC_HINT,
    }
  }
  /* 真挖掉了 ⇒ 掉落物就在脚边。用户 2026-10-08 原话："挖完方块…老是忘记走过去拾取"。
   * 只**点一句**（`mc_act{break}` 这条路从来不自己捡），让模型知道这活还没完。 */
  /* 🔴 2026-10-23：本地已经被 `digging.js` 清成空气、服务端却**一声不响**（既没破坏包也没复原包）⇒
   *    把本地那一格改回去。否则这一格会变成“本地空气 / 服务端实心”的幽灵空位，
   *    寻路和地图都以为那儿通了（实机表现：得换目标或绕一下才走得动）。 */
  const rolledBack = (localGone && confirmed === false) ? restoreLocalBlock(b, pos, Number(blk?.stateId)) : false
  const pickup = localGone ? dropHint(b) : null
  /* 🔴 和 mc_attack 一个口径：只说"地上还有东西"不够，**在哪**才是能不能捡的依据
   *   （2026-10-22 下界连丢两根烈焰棒就是栽在这上面）。捡不捡仍由 AI 决定。 */
  const drops = localGone ? dropListOf(b, { radius: 8, limit: 4 }) : []
  /* 这一下把工具磨掉多少 —— 只在快坏时给（理由见 `dig` 收工段那段注释：
   * 全好时不说，坏的时候必须说，否则"镐子中途爆了"和"挖得好好的"长得一模一样）。 */
  const toolWear = durWarnText(b)
  return {
    broken: rolledBack ? false : (localGone ? name : false),
    ...(rolledBack ? { localRestored: true } : {}),
    confirmed,
    at: { x: pos.x, y: pos.y, z: pos.z },
    now,
    held,
    ...(toolWear ? { toolWear } : {}),
    ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
    ...(digMs != null ? { digMs } : {}),
    ...(noDrop ? {
      note: `挖开了 —— 但**没掉落**（${name} 要 ${toolKinds(b, blk) || '对工具'}才有东西掉）。`
        + '要是只想清路/爬出去，这样就行了；想要掉落得先弄一把对的工具。',
    } : {}),
    ...(pickup ? { pickup } : {}),
    ...(drops.length ? { drops } : {}),
    /* 服务端把这一格发成了**液体**（冰挖掉就是水，海草/海带也是）⇒ 破坏**成功**了，只是液体立刻涌了进来。
     * 单独说一句，免得模型把它当成"服务端复原 / 没挖掉"再挖一次。 */
    ...(rest?.kind === 'liquid' ? {
      note: `这一格现在是 **${rest.name}**（液体立刻涌了进来）—— 这次破坏是**成功**的，不是"服务端复原"。`
        + '挖到的东西按方块的正常掉落算；别当成没挖掉重挖一次。',
    } : {}),
    ...(localGone && confirmed === false ? {
      note: '本地世界已经清掉了，但**没收到服务端的破坏回包** —— 服务端很可能拒了这次破坏'
        + '（领地保护 / 权限 / 反作弊 / 太远），客户端这边却把方块写成空气了。'
        + '用 `mc_scan` 或 `mc_observe` 再确认一下，**别在空气上盖房、别走进你以为挖穿的墙**。'
        + (rolledBack ? '（我已经把本地那一格改回原样，免得寻路把它当成空洞）' : '')
        + DESYNC_HINT,
    } : {}),
    ...(localGone ? {} : {
      /* 🔴 审计 F2：这句必须让"预算用完"能被**文本**认出来（`timeout`/`budget` 规则），
       *    而且**不能**出现"没挖掉"三个字 —— 那三个字会先命中"明确失败"那条正则，
       *    于是真·时间到被记成"这一步失败了"，3 轮之后任务被误判成 blocked。 */
      note: timedOut
        ? `这一轮的时间用完了（挖了 ${callSecText()}，方块还在，手上是 ${held}${digMs != null ? `；这块按手上的东西要 ${(digMs / 1000).toFixed(1)} 秒` : ''}）`
          + '—— **这不是失败**，再叫一次 `mc_dig` 接着挖就行；换个对的工具、或换个更近的点位会更顺。'
        : `方块还在（${now}）—— 服务端可能拒了这次破坏，别当成挖掉了`,
    }),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 挖方块（`mc_dig` 的正文）—— 路线图第 ④ 条第四十刀从 `src\core.mjs` 搬出来。
 *
 * 一条路，没有兜底：**自己走过去 → 换对的工具 → `bot.dig()` → 等服务端的破坏回包 → 捡掉落物**。
 * 为什么把 collectBlock 那条路整个删掉、为什么够不着就如实说，见函数体里那两段长注释
 * （2026-10-08 实机：交给 collectBlock 会出现"挖完又复原 + 之后几分钟走不了路"）。
 *
 * 参数：`self` = McBot（读 `tasks` / `position` / `cfg`，调 `requireBot` / `callLeft` / `walkTo` /
 *       `interruptMove` / `log`），`ctx` = 十个私有回调（见 core 的 `#mineCtx()`）。
 * 判据：模块不 import `core.mjs`、不 import 游戏库（只认 `b.blockAt` / `b.dig` / `b.findBlocks` / `b.game`）。
 * ──────────────────────────────────────────────────────────────────────────── */

export async function dig (self, {
  name = null, pos = null, maxDistance = 6, count = 1, allowDangerous = false,
  /* 2026-10-23 用户实机（「挖矿老是乱挖 / 够得到还搭方块」）：
   *   noDig：走过去这一路允不允许挖穿挡路的方块。默认 true（只绕路、不挖墙）——
   *     以前是 false，为了够到墙后的矿，pathfinder 会顺手把一路石头泥土全挖了，
   *     在用户眼里就是"乱挖"。确实要挖穿（矿在墙后）就显式 noDig:false 再叫一次。
   *   towerFallback：走不通时允不允许"垫一格方块往上"。默认 false —— 以前这个兜底
   *     无视 noTower 一律会跑，于是"明明够得到"也会原地搭柱子。 */
  noDig = true, towerFallback = false,
} = {}, ctx = {}) {
  const b = self.requireBot()
  const out = []
  const held0 = heldText(b)
  /* 🔴 2026-10-19 实机：**只给 pos 又给 count>1** 时，第二格开始 `want` 取的是
   *    `blockAt(pos).name` —— 而那格刚被挖空，读回来是 `air`，于是 `findBlocks` 抓一堆**空气**
   *    当目标（返回里就成了"（12,-60,28）已经不在了"那样的话）。
   *    指定坐标的语义本来就是"挖这一格"，count 在这里没有意义 ⇒ 直接按 1 处理。 */
  const n = Math.min(Math.max(pos ? 1 : count, 1), 16)
  /* 水/岩浆是**流体**，挖不掉（`mc_dig water` 只会白花一次调用，日志里留一条
   * "破坏 water 这一轮的时间用完了"）。淹死时的正确动作是**上浮换气**，不是挖水。 */
  const fluid = name ?? (pos ? b.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name : null)
  if (fluid && isLiquid(fluid)) {
    throw new Error(`${fluid} 是流体，挖不掉 —— 想从水里出来：mc_move {"mode":"swim"} 按住 jump 上浮换气，`
      + '露出水面后再 mc_move 往岸上走（不知道岸在哪就先 mc_scan 找最近的干燥方块）。')
  }
  // 先把要挖的方块列出来（collectBlock 要一份目标清单，它自己会走过去 + 捡掉落物）
  /* 📋 任务记账（用户 2026-10-08 路线图第 ②③ 条）：**一次要挖 4 个以上 = 一件"活儿"**。
   * 开工时落一条任务到 `<记忆根>/tasks.json`，以后每次 mc_dig 都接到同一个任务上：
   *   - 模型不用自己记"我挖到第几个了"（进度在磁盘上，掉线重连也在）；
   *   - 收工时把失败**分类**（够不着 / 服务端不认 / 没工具 / 时间用完了），
   *     同一个原因连着 3 次就把任务标成"卡住"，别让它原地死磕（用户要的"循环检测"）。
   * 只要 1 个（或只给 pos）就不建任务：那种调用不需要记账，建了只是噪声。 */
  const task = (name && n >= 4) ? self.tasks.auto({ kind: 'dig', item: name, total: n, params: { maxDistance } }) : null
  if (task) self.tasks.checkpoint(task.taskId, { position: self.position, have: ctx.taskHave(name) })
  const targets = []
  for (let i = 0; i < n; i++) {
    if (pos && i === 0) {
      const one = b.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!one) throw new Error(`(${pos.x},${pos.y},${pos.z}) 未加载`)
      targets.push(one)
      continue
    }
    /* 走到这里一定是"按 name 找"：只给 pos 的在上面的 `i === 0` 分支就 continue 了，
     * 而给了 pos 时 `n` 已经压成 1，不会有第二格。以前这里会回退去读 pos 那格的方块名，
     * 读到的是**刚挖空的 `air`** —— 于是抓一堆空气当目标（见上面 `n` 那段注释）。 */
    if (!name) throw new Error('需要 name 或 pos')
    const want = name
    const found = typeof b.findBlocks === 'function'
      // ⚠️ mineflayer 4.39 的 findBlocks 返回的是**坐标**（{x,y,z}），不是方块对象
      //    （blocks.js:212 里 findBlock 才是 blockAt(blocks[0])）——所以要自己转回方块
      ? b.findBlocks({ matching: (blk) => blk?.name === want, maxDistance, count: n - targets.length })
        .map((p) => b.blockAt(new Vec3(p.x, p.y, p.z)))
        .filter((blk) => blk && blk.name === want)
      : [b.findBlock({ matching: (blk) => blk?.name === want, maxDistance })].filter(Boolean)
    if (!found.length) { out.push(`附近找不到 ${want}`); break }
    for (const f of found) if (!targets.includes(f)) targets.push(f)
    if (targets.length >= n) break
  }
  if (!targets.length) {
    // 一个目标都没找到：这是**真的**做不成（`no-target`），记一笔 —— 连着三次就说明该换地方了
    if (task) self.tasks.fail(task.taskId, { action: 'dig', reason: out[out.length - 1] ?? `附近找不到 ${name}` })
    return out
  }

  /* 🔴 按距离从近到远排（显式给的那个 pos 仍排第一）：
   * 2026-10-08 用户转来的实机反馈 —— "mc_dig 挑到够不着的目标就超时"。
   * findBlocks 的返回顺序不保证是最近的，第一个够不着就能把整轮 11 秒吃光。
   */
  const distOf = (blk) => { try { return b.entity.position.distanceTo(blk.position) } catch { return Infinity } }
  /* 2026-10-23 用户实机（「挖矿老是乱挖 / 明明够得到还搭方块」）：
   *   原来只按**脚到方块**的距离排 —— 墙后面那格永远"更近"，于是挑中的目标 A* 根本没路
   *   （能站的格子在墙的另一侧），绕死 → 脱困阶梯 → 垫柱搭方块。
   *   现在分三层挑：① 已经够得着（眼睛→方块中心 ≤ 4.5）一步都不用走；
   *                ② 同一层（|dy| ≤ 2）走过去不用爬高爬低；③ 剩下一律按距离。
   *   同一层里仍是"近的先挖"，矿脉一片一片挖的手感不变。 */
  const mineReachLimit = b.game?.gameMode === 'creative' ? 5.0 : 4.5
  const tierOf = (blk) => {
    let reach = Infinity
    try { reach = blockReachOf(b, blk) } catch {}
    if (Number.isFinite(reach) && reach <= mineReachLimit) return 0
    const dy = Math.abs(Number(blk?.position?.y) - Number(b.entity?.position?.y ?? 0))
    return Number.isFinite(dy) && dy <= 2 ? 1 : 2
  }
  if (targets.length > 1) {
    const pinned = pos ? targets[0] : null
    const rest = targets.filter((t) => t !== pinned)
      .sort((a, c) => (tierOf(a) - tierOf(c)) || (distOf(a) - distOf(c)))
    targets.length = 0
    targets.push(...(pinned ? [pinned, ...rest] : rest))
  }

  /* 🔴 手上（背包里）没有能挖它的工具就别动手：
   * ① 硬挖石头/矿石不掉东西，白耗十几秒，还容易被误当成"挖到了"；
   * ② mineflayer-collectblock 挖之前会拿 `{requireHarvest:true, getFromChest:true}` 去问
   *    mineflayer-tool 要工具，而那个插件在 chestLocations 为空时**无限递归** →
   *    JS 堆十几秒涨到几 GB 直接 OOM，而且全在微任务里跑，连 withTimeout 都不会触发。
   *    （vendor 树里已经给 mineflayer-tool 打了补丁，这里再挡一道，别白跑。）
   */
  if (b.game?.gameMode !== 'creative') {
    const inv = b.inventory.items()
    const canHarvest = (blk) => !blk?.harvestTools || inv.some((it) => blk.harvestTools[it.type])
    if (!targets.some(canHarvest)) {
      const blk = targets[0]
      const why = `背包里没有能挖 ${blk.name} 的工具（${toolKinds(b, blk)}）—— 先 mc_craft 一把（木镐 = 3 木板 + 2 木棍），再叫我挖`
      if (task) self.tasks.fail(task.taskId, { action: 'dig', reason: why })
      return [why]
    }
  }

  // ① 有 mineflayer-collectblock 就交给它：走过去 → 挖 → 捡掉落物（换工具它内部用 mineflayer-tool）
  // 🔴 **一次只喂一个目标**：collectBlock 内部是个 for 循环，任何一个目标寻路失败都会把整批带崩
  //    （2026-10-06 实机：挖 4 根原木只拿到 1 根，其余全因 "Took to long to decide path to goal!" 丢掉）。
  //    逐个喂 + 逐个 catch：坏目标跳过，好目标照挖。
  /* 🔴 用 `self.callLeft()` 而不是 `callDeadline()`：本轮已经用掉的时间要算进去
   *    （`mc_sequence` 里"走一段再挖"时，挖只剩 1 秒，不能又给整整 11 秒）。
   * 🔴 再**留 900ms 收尾**（2026-10-08 实机反馈：`mc_dig` 报 `Error: tool call timed out after 6000ms`，
   *    方块其实早挖掉了）。收尾包括：`#cancelCollect` 等 `collectBlock_finished`、
   *    兜底原地挖、拼返回文本、DSH 层序列化 —— 这些以前都排在预算之外，
   *    两个目标就是 2×1.5 秒，整轮直接冲出工具超时，模型只拿到一个没有信息的硬错误。 */
  const callLeftMs = self.callLeft()
  const deadline = Date.now() + Math.max(0, callLeftMs - 900)
  /* 🔴 2026-10-17（实机：「mc_sequence 会假失败：秒回报 stoppedAt:0 / 本轮时间不够，但方块其实已经挖掉了」）：
   *    `callLeft()` 太小 ⇒ `leftOf()` 一上来就 < 900 ⇒ **一个都不挖**。
   *    这是"没做"，不是"没做成" —— 两件事必须分开说（踩坑档案第 107 条），
   *    否则模型会把已经挖掉的再挖一遍、或者以为"这矿挖不动"。 */
  const noBudget = callLeftMs <= 900
  const leftOf = () => deadline - Date.now()
  /* 🔴 2026-10-08 实机（用户「挖矿还是会」）：**`dig()` 不再把方块交给 mineflayer-collectblock**。
   *    collectBlock 走过去用的是 `goals.GoalLookAtBlock`（vendor CollectBlock.js:30）—— 只要**看得见**
   *    就算"到了"，站 6 格开外也算到，然后 `bot.dig()` 从够不着的地方挖：
   *    服务端按"眼睛→方块中心 ≤4.5"拒收，而 mineflayer 的 `finishDigging()`（digging.js:158）
   *    已经把**客户端**那格写成 air ⇒ 画面上就是"挖完又复原"；
   *    更糟的是服务端不回 air 方块更新 ⇒ `diggingTask` 永远不 resolve ⇒ 采集任务永远挂着
   *    （`collectBlock_finished` 不 emit）⇒ 之后几分钟走不了路（实机日志 02:38–02:43 连打 20 次
   *    "上次的采集任务还在后台跑"，机器人整整 5 分钟没挪窝）。
   *    现在统一成一条路：**自己走到方块旁边**（`walkTo` 的 pathfinder 带 canDig，能挖穿挡路的），
   *    再按"眼睛→方块中心"复核，够得着才 `bot.dig()`，而且**认服务端的破坏回包**；
   *    掉落物由 `#grabDrops` 捡（原来靠 collectBlock 顺手捡）。 */
  let okCount = 0   // 这一轮挖到几个（下面那条兜底路径也要用，所以放在块外）
  let budgetCut = false   // 是不是"时间用完了"提前收工的（那条路自己会说"还有 N 个没挖"）
  /* 🔴 2026-10-17（用户报"工具排队执行、延迟很大"）：一次调用是**原子**的。
   *    实机那次：12 个 break 挖竖井 → 骷髅跟下来一路射 → AI 要等 10 秒过完才知道
   *    （日志里 `mc_auto：zombie 贴上来 → 已叫醒 AI` 比这条调用结束早 5 秒）。
   *    挖矿是最容易招怪的场景（挖穿到洞穴、没插火把），所以每个目标之前查一次。 */
  const stopOnDanger = self.cfg?.stopOnDanger === true
  const noticed = new Set()
  const hp0 = healthOf(b)
  {
    /* 🔴 2026-10-08 审计④：`interruptMove()` 以前是**死代码**（定义了没人调），而文档说 mc_dig 靠它抢占。
     *    走路/采集会按着 forward、占着 pathfinder ⇒ 先把还在跑的移动真停掉，再领号。 */
    await self.interruptMove()
    ctx.beginMove()
    let seen = 0
    const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
    for (const target of targets) {
      seen++
      /* 挨打了 / 有怪贴脸 ⇒ **立刻**把控制权还回去（这个目标没挖）。放在预算检查**之前**：
       * 还剩 8 秒也不该继续挖 —— 怪已经站到脸上了。 */
      const danger = dangerNow(b, { hp0 })
      if (danger) {
        /* 🔴 2026-10-19 用户：「不要打断只提醒」—— 默认**不再**因为险情收工：
         *    挖竖井那种活一停就得重来一遍（还要重新看脚下是不是 air），
         *    而险情本身由反射层（`mc_auto`）的叫醒去处理。这里只留一句话。
         *    想恢复旧行为（立刻停手）把 config.stopOnDanger 设成 true。 */
        if (stopOnDanger) {
          out.push(`⚠️ ${dangerText(danger)} —— 先别挖了（挖到 ${okCount}/${targets.length}），`
            + '`mc_attack` 打掉它，或者 `mc_move` 躲开；安全了再叫一次 mc_dig')
          break
        }
        const k = noticeKey(danger)
        if (!noticed.has(k)) {
          noticed.add(k)
          out.push(`${dangerNotice(danger)}（挖到 ${okCount}/${targets.length}）`)
        }
      }
      // 🔴 单次调用 ≤11 秒：到点就带着已经挖到的结果返回，剩下的下次再叫
      const left = leftOf()
      if (left < 900) {
        out.push(noBudget && okCount === 0
          ? `—— 这次调用**自己没分到时间**（外层只剩 ${callLeftMs}ms），**一个都没挖**。`
            + '**这不等于那些方块还在**：先 `mc_scan` / `mc_map` 复核一下到底挖掉没有，'
            + '确认真没挖再单独叫一次 mc_dig（**别塞在 mc_task 里** —— 外层时间早被前面的步骤吃掉了）。'
          : `—— 这一轮的 ${callSecText()}用完了（挖到 ${okCount}/${targets.length}），`
            + `还有 ${targets.length - seen + 1} 个没挖：再叫一次 mc_dig 接着挖`)
        budgetCut = true
        break
      }
      // 🔴 别让**一个**够不着的目标吃掉整轮：单个目标最多给"剩余时间的一大半"，
      //    剩下的时间留给后面的目标 + 兜底原地挖（2026-10-08 实机反馈）。
      const budget = Math.max(300, Math.min(
        callBudget(self.cfg.collectBudgetMs), left, Math.max(2500, Math.floor(left * 0.6))))
      const p = target.position.clone()
      const nm = target.name
      /* 够不着 → **先自己走过去**（以前这一步交给 collectBlock，而它只要"看得见"就算到）。
       * 🔴 判据必须是 `#reachOf`（**眼睛 → 方块中心**，服务端也是这么判的），不是脚到方块坐标：
       *    用脚算的话，正下方 4 格的石头会被判"够得着"，原地挖一发服务端根本不认。
       * 🔴 走到方块**自己那一格**（x+0.5 / y / z+0.5）再复核：走过去这一路 pathfinder 可能顺手
       *    把它挖穿（`canDig`），所以到地方必须重新读一次方块。 */
      let fresh = b.blockAt(p)
      /* 🔴 2026-10-15 审计：以前这里是一句 `continue` —— 方块读不到（区块卸载）或已经不在时
       *    一个字都不输出，模型只看到结果里少了一项，不知道是"没这块"还是"插件跳过了"。 */
      if (!fresh) {
        out.push(`${nm} @ ${p} 读不到（区块没加载）—— 先 \`mc_move\` 靠近让区块加载，再叫我挖`)
        continue
      }
      if (fresh.name !== nm) {
        out.push(`${nm} @ ${p} 已经不在了（现在 ${fresh.name}）—— 别人挖走了，或刚才已经挖掉`)
        continue
      }
      if (blockReachOf(b, fresh) > reachMax) {
        /* 2026-10-23：落点以前是**矿块自己那一格**（嵌在石头里），由 standPointFor 挪到
         *   "离矿最近的可站格" —— 那个格子可能在墙的**另一侧**，A* 永远没路，于是绕死/垫柱。
         *   改成先自己算：矿块周围能站、且眼睛够得着（≤ reachMax）的格子里挑**离我最近**的，
         *   落点天然在墙的这一侧；一个候选都没有才退回老写法。 */
        const cell = mineApproachCell(b, p, reachMax)
        /* 口径和以前一致：x/z 取**格中心**（+0.5），y 是脚那一格。 */
        const stand = cell
          ? { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }
          : { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }
        const w = await self.walkTo(stand, { arrive: 2.2, budget, noDig, towerFallback })
        fresh = b.blockAt(p)
        /* 🔴 2026-10-15 审计：`b.blockAt(p)` 在**区块卸载**时返回 null，而以前 `!fresh` 和
         *    `fresh.name !== nm` 走同一条路 ⇒ 把"读不到"当成"走过去顺手挖掉了"，`okCount++`
         *    虚增、还把 `?` 当证据写进同一条消息。这两件事必须分开。 */
        if (!fresh) {
          out.push(`${nm} @ ${p} 走过去以后读不到了（区块没加载）—— **这一格没算挖掉**，`
            + '先 `mc_move` 靠近让区块加载再叫我复核')
          continue
        }
        if (fresh.name !== nm) {
          /* 2026-10-23 审计：名字变了不等于「我挖掉了」——可能被别的实体替换/炸掉。
           * 只有变成空气/液体才算这一格真被我挖掉了。 */
          if (!isAir(fresh.name) && !isLiquid(fresh.name)) {
            out.push(`走到 ${nm} @ ${p} 时那里已经是 ${fresh.name}（不是空气）—— **这一格没算挖掉**，`
              + '不是我挖的（被替换 / 炸掉 / 区块更新过了），要它的话指个新目标')
            continue
          }
          okCount++
          if (task) self.tasks.progress(task.taskId, { add: 1 })
          out.push(`走过去的时候顺手挖掉了 ${nm} @ ${p} → 现在 ${fresh.name}`)
          const got = await ctx.grabDrops(b)
          if (got > 0) out.push(`　（顺手捡回 ${got} 个掉落物）`)
          else {
            const hint = dropHint(b)
            const where = dropsWhereText(b)
            if (hint) out.push(`　（${hint}${where ? '：' + where : ''}）`)
          }
          continue
        }
        if (blockReachOf(b, fresh) > reachMax) {
          const away = blockReachOf(b, fresh)
          out.push(`够不着 ${nm} @ ${p}（眼睛到方块中心 ${away.toFixed(1)} 格，`
            + `${w?.arrived ? '走过去也只到这么远' : '走过去也没走到'}）—— `
            + '先 `mc_move` 到它旁边（或换个近一点的目标）再叫我挖：站远了挖服务端不认，方块会"复原"。'
            + (noDig ? '（这条路被方块挡着走不过去的话，带 `digThrough:true` 叫我，我挖穿过去）' : ''))
          continue
        }
      }
      /* 挖自己脚下（2026-10-18 审计 P1-5）：跟 `breakBlock` 同一条判据。 */
      const risk = allowDangerous ? null : underfootRiskOf(b, p)
      if (risk?.bad) {
        out.push(`⚠️ ${nm} @ ${p} 是你脚下的支撑：${risk.why} —— **这一格没挖**。`
          + '先横着挪一格（`mc_move`）再挖，或确实要拆就带 `allowDangerous:true`')
        continue
      }
      {
        const watch = ctx.watchServerBreak(b, p)
        try {
          // 空中挖慢 5 倍 ⇒ 先等落地（否则预算全喂给一次注定超时的挖掘）
          if (!await ctx.waitGrounded(b, Math.min(1_500, Math.max(0, leftOf() - 800)))) {
            out.push(`—— 我还在空中（没落地）就挖不了 ${nm}：空中挖方块慢 5 倍，先落稳（或 \`mc_move {mode:"jump"}\` 换个落脚点）再叫一次 mc_dig`)
            continue
          }
          await ctx.equipFor(b, fresh, `换工具挖 ${nm}`)
          const oneMs = digMsFor(b, fresh, b?.heldItem?.type ?? null)
          if (oneMs != null && leftOf() < oneMs + 500) {
            out.push(`—— 剩下的时间不够挖 ${nm}（这块要 ${(oneMs / 1000).toFixed(1)} 秒${slowDigWhy(b)}），没开始挖：再叫一次 mc_dig 接着挖`)
            break
          }
          await ctx.t(b.dig(fresh, true), 'dig', `挖 ${nm}`)
          /* 等**服务端**的判决（客户端那个 air 是预测，不算数；服务端的包可能晚到约 1 秒） */
          await ctx.awaitServerBreak(b, watch)
          const now = b.blockAt(p)?.name ?? '?'
          /* 🔴 服务端把这一格改成非空气 —— 先看是不是**同一个方块**（见 `classifyRestore`）：
           *   同一个 ⇒ 真拒绝（复原）；变成**液体** ⇒ 破坏其实成功了（冰挖掉就是水）；别的 ⇒ 客户端区块旧了。 */
          const rest = classifyRestore(watch)
          const confirmed = watch.watching ? (watch.hit() || rest?.kind === 'liquid') : null
          if (rest?.kind === 'same') {
            await sleep(150)
            const back = rest.name ?? stateNameOf(b, watch.restored()) ?? b.blockAt(p)?.name ?? '别的方块'
            self.log(`⚠️ 服务端把 ${nm} 复原了（${p}）—— 这次破坏没被认`)
            out.push(`没挖掉 ${nm} @ ${p}：服务端把这块**改回了 ${back}**（复原）`
              + ' —— 多半是我离得远，或客户端区块旧了。先 `mc_move` 走到它旁边（3 格以内）再叫一次 mc_dig。'
              + DESYNC_HINT)
          } else if (rest?.kind === 'other') {
            await sleep(150)
            const back = rest.name ?? '别的方块'
            self.log(`⚠️ 服务端说 ${p} 是 ${back}，和我以为的 ${nm} 不一样 —— 客户端区块旧了？`)
            out.push(`没挖掉 ${nm} @ ${p}：服务端说这一格是 **${back}**，和我这边看到的 **${nm}** 不一样`
              + '（客户端区块旧了）—— 先 `mc_scan` 复核一眼。'
              + DESYNC_HINT)
          } else if (now !== nm) {
            okCount++
            if (task) self.tasks.progress(task.taskId, { add: 1 })
            /* 🔴 审计①：`bot.dig()` 的 resolve 来自**客户端预测**（digging.js:143-159 自己
             *    `_updateBlockState(pos, 0)` 又自己接住）⇒ 服务端拒了也照样"成功"。
             *    只有服务端发的破坏包才算真挖掉。 */
            if (!watch.watching) out.push(`挖掉 ${nm} @ ${p}（原地，不用走过去）→ 现在 ${now}`)
            else if (confirmed) {
              out.push(`挖掉 ${nm} @ ${p}（原地，不用走过去）→ 现在 ${now}（服务端已确认`
                + `${rest?.kind === 'liquid' ? '：液体立刻涌了进来，这次破坏是成功的' : ''}）`)
            } else {
              /* 🔴 2026-10-23 同上（`breakBlock` 那条路）：本地 air 是 `digging.js` 自己写上去的，
               *    服务端静默拒绝时这一格会变成“本地空气 / 服务端实心”的幽灵空位 —— 寻路会往那儿走。 */
              const back = restoreLocalBlock(b, p, Number(fresh?.stateId))
              out.push(`本地读到 ${nm} @ ${p} 已经变成 ${now}，但**没收到服务端的破坏回包**`
                + ' —— 服务端很可能拒了这次破坏（够不着 / 领地保护 / 权限 / 反作弊）：别当成挖掉了，'
                + '先 `mc_scan` 复核。'
                + (back ? '（我已经把本地那一格改回原样，免得寻路把它当成空洞）' : '')
                + DESYNC_HINT)
            }
            /* 🔴 原地挖绕过了 collectBlock（它平时挖完还会把掉落物捡回来）⇒ 得自己去捡，
             *    否则"挖到 3 根原木、背包里只有 1 根"（2026-10-08 实机）。
             * 🔴 2026-10-24 用户（「可不可以不马上捡，过一段时间没吸到再去拿」）：**先等自动吸附** ——
             *    掉在脚边的会自己飞进背包，等不到再走过去拿。以前每挖一格都立刻跑过去，
             *    表现成"挖一个、动一下"，可那一步多半是白走。 */
            const flew = await waitForPickup(self, b, { at: p }).catch(() => 0)
            if (flew > 0) out.push(`　（等了一下，${flew} 个掉落物自己飞进背包）`)
            const got = await ctx.grabDrops(b)
            if (got > 0) out.push(`　（顺手捡回 ${got} 个掉落物）`)
            else if (flew <= 0) {
              /* 一个都没捡到（够不着 / 卡住 / 背包满）⇒ 点一句"东西还在地上"。
               * why：用户 2026-10-08 原话"挖完方块或者打完动物以后老是忘记走过去拾取" ——
               * 捡东西是**决策**，插件替不了，但结果里必须让它知道这活还没完。 */
              const hint = dropHint(b)
              const where = dropsWhereText(b)
              if (hint) out.push(`　（${hint}${where ? '：' + where : ''}）`)
            }
          } else out.push(`没挖成 ${nm} @ ${p}（原地挖完了，但那里**还是 ${now}**）`
            + ' —— 服务端没认这次破坏（失步 / 领地保护 / 工具不对）：先 `mc_scan` 复核。'
            + DESYNC_HINT)
        } catch (e) {
          /* 🔴 被新指令抢占（`interruptMove` / abort）：**这不是失败**，进度留着 —— 用户
           * 2026-10-08 路线图原话"玩家发出新命令可取消或抢占旧任务"。 */
          if (e?.mcAborted) {
            if (task) self.tasks.pause(task.taskId, '被新的指令打断')
            throw e
          }
          out.push(`挖 ${nm} @ ${p} 失败：${String(e?.message ?? e).slice(0, 120)}`)
        } finally {
          watch.stop()
        }
        continue
      }
    }
    /* 以前这里还有一条"够不着就交给 collectBlock"的路 + 一个"② 退回：原地挖"的兜底循环 ——
     * 2026-10-08 全部删掉：那条路正是"挖完又复原 + 之后几分钟走不了路"的来源（见本函数开头的注释）。
     * 够不着就如实说，让模型自己 `mc_move` 过去再挖。 */
    /* 「这条矿脉还没挖干净」—— 收工前补一句（`veinHint` 的判据见本文件开头）。
     * 时间用完那条路自己会说"还有 N 个没挖"，不重复。 */
    if (okCount > 0 && !budgetCut) {
      const h = veinHint(b, targets[0]?.name ?? name)
      if (h) out.push(h)
    }
    /* 工具快坏了就点一句。**只在有警告时**加 —— 这个动作每轮都在跑，
     * 全好时也念"都还好"就是稳定噪声。而缺了它的后果很实：`mc_dig {count:16}`
     * 一次能打掉几十点耐久，镐子在执行**中间**爆掉时，AI 拿到的结果
     * 和"挖得好好的"一模一样，只能靠自己 `mc_inventory` 去查（通常不会查）。 */
    const wear = durWarnText(b)
    if (wear) out.push(`⚠️ 工具：${wear}`)
    ctx.taskSettle(task, out, okCount, targets.length)
    ctx.verdictLine(out, okCount, targets.length)
    return ctx.withHeld(out, b, held0)
  }
}

/**
 * 挑一个"走到那里就够得着 p 这块矿"的落脚点（2026-10-23，用户「够得到还搭方块」）。
 * 候选 = 矿块周围一圈（含上下）的可站格，过滤条件是眼睛→矿块中心 ≤ reachMax，
 * 最后挑**离自己最近**的那个：离我近 ⇒ 天然在墙的这一侧 ⇒ A* 有路。
 * 返回 {x,y,z}（格坐标，y 是脚那一格）或 null（让调用方退回老写法）。
 */
function mineApproachCell (b, p, reachMax) {
  const me = b?.entity?.position
  if (!me || !p) return null
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const standable = (x, y, z) => {
    const u = at(x, y - 1, z); const a = at(x, y, z); const c = at(x, y + 1, z)
    if (!u || !a || !c) return false
    if (isAir(u.name) || isLiquid(u.name)) return false
    return isPassable(a.name) && isPassable(c.name)
  }
  const px = Math.floor(p.x); const py = Math.floor(p.y); const pz = Math.floor(p.z)
  const center = new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)
  let best = null; let bestD = Infinity
  for (const dy of [0, -1, 1]) {
    for (const dx of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        if (!dx && !dz && !dy) continue
        const x = px + dx; const y = py + dy; const z = pz + dz
        if (!standable(x, y, z)) continue
        if (new Vec3(x + 0.5, y + 1.62, z + 0.5).distanceTo(center) > reachMax) continue
        const d = me.distanceTo(new Vec3(x + 0.5, y, z + 0.5))
        if (d < bestD) { bestD = d; best = { x, y, z } }
      }
    }
  }
  return best
}
