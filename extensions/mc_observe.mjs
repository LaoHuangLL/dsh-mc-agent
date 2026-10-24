/**
 * mc_observe —— 第一人称视角截图（dsh-mc-agent 扩展）
 *
 * 需求（用户 2026-10-05）：给它装上第一人称获取，让 agent 每次使用前查看第一人称的图片。
 * 改（用户 2026-10-06「看第一视角改成让 ai 自主调用」）：**硬门禁默认关掉** —— 不再拦任何动作，
 * 什么时候看一眼由 AI 自己判断（靠工具说明里的"什么时候值得看"引导）。
 *
 * 装法：本文件放在 `<profile>/node_modules/dsh-mc-agent/extensions/` 下即自动加载
 * （插件 index.js:4089 的扩展点在**异步 IIFE** 里 import 本目录所有 .mjs 并调 apply）。
 *
 * 两部分：
 *   ① 工具 `mc_observe`（主体）：从机器人眼睛（眼高 1.62）朝视线方向渲染一张 PNG ——
 *      内联成图片附件（模型直接能看）+ 落盘工作区 + 一段文字摘要（准星命中/脚下/前方/视野构成）。
 *   ② 可选硬门禁 `ctx.tools.guard(...)`（**默认关**）：动作类工具（mc_move/mc_act/mc_dig/mc_build/
 *      mc_give/mc_command/mc_sequence）执行前，若本会话**手上没有够新的第一人称图**就拒绝执行，
 *      并让模型先调 mc_observe。想变回强制模式见下面的环境变量 / view.json。
 *
 * 门禁的尺度（若启用）：看一眼之后**最多连着做 N 个动作、且不超过 T 秒**，超了才要求再看一次
 * （最初是"看一次只能做一个动作"，模型一轮里习惯连做 2~4 个动作 ⇒ 后面几个全被拒、刷一屏红字、还浪费回合）。
 *
 * 环境变量（可选）：
 *   DSH_MC_AGENT_VIEW_GATE=on             开硬门禁（**默认 off：AI 自主决定何时看图**）
 *   DSH_MC_AGENT_VIEW_MAX_ACTIONS=4       看一眼后最多连着做几个动作（默认 4，最小 1）
 *   DSH_MC_AGENT_VIEW_MAX_AGE_MS=60000    看一眼后的有效期毫秒（默认 60000；0 = 不按时间失效）
 *   DSH_MC_AGENT_VIEW_GATED=name1,name2   自定义要门禁的工具名（逗号分隔）
 *
 * 也可以不用环境变量：在**工作区**写 `.dsh-mc-agent/view.json`，例如
 *   {"gate":true,"maxActions":6,"maxAgeMs":120000}   打开/放宽硬门禁；{"gate":false} 关（**默认**）
 * 改完**立即生效**（下次判定时读），不用重启 DSH。环境变量管"默认值"，这个文件管"覆盖值"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { encodePng } from '../src/png.mjs'
import { equipmentOf, equipmentText, toolDurability, durabilityText } from '../src/inventory.mjs'
import { EXPRESS_DIR, OUT_DIR } from '../src/express.mjs'
import { withTimeout, CALL_MS, CALL_BUDGET_MS } from '../src/core.mjs'
import { VIEW_DEFAULTS, compassOf, isAirName, makePos, renderView } from './mc_view-render.mjs'
import { ensureAtlas } from '../src/textures.mjs'
import { createSkinStore } from './mc_skin.mjs'
import { clamp } from './mc_util.mjs'
import { spatialMapOf, spatialText } from '../src/spatial-map.mjs'

/* ── 官方贴图库（src/textures.mjs）────────────────────────────────────────────
 * 第一次渲染时从本机客户端 jar 里建一次（之后走磁盘缓存，秒开）；拿不到就 null，
 * 渲染器自动退回调色板。**不能让它拖垮 11 秒预算**：只等 ATLAS_WAIT_MS，超时就
 * 这一张先用调色板，后台继续建，下一张就有贴图了。 */
let atlasPromise = null
let atlasReady = null
const ATLAS_WAIT_MS = 2500
async function atlasForRender () {
  if (process.env.DSH_MC_TEXTURES === 'off') return null
  if (atlasReady !== null) return atlasReady
  if (atlasPromise === null) {
    atlasPromise = ensureAtlas({ log: (m) => { try { console.error('[textures]', m) } catch { /* 忽略 */ } } })
      .then((a) => { atlasReady = a; return a })
      .catch(() => null)
  }
  try { return await withTimeout(atlasPromise, ATLAS_WAIT_MS, '读方块贴图') } catch { return null }
}

export const name = 'mc_observe'

/** 动作类工具：会移动机器人或改变世界的。只读类（mc_status/mc_scan/mc_inventory…）不门禁。 */
const DEFAULT_GATED = [
  'mc_move', 'mc_act', 'mc_dig', 'mc_build', 'mc_give', 'mc_command', 'mc_sequence', 'mc_furnace', 'mc_chest',
]

/** ChatMessage / 字符串 → 纯文本（拿不到就给 null） */
function plainText (v) {
  if (v == null) return null
  if (typeof v === 'string') return v || null
  try {
    const s = String(v)
    return s && s !== '[object Object]' ? s : null
  } catch { return null }
}

/** 读一个方块（未加载 → null）；用于脚下/头上/正前方这种"精确点查"。
 *  注意：真实世界是 prismarine-world，`getBlock` 会调 `pos.floored()`，
 *  传纯 `{x,y,z}` 会抛异常 —— 那样这里会被 catch 成 null，把一切都误报成"未加载"。 */
const queryPos = makePos()
function blockAt (world, x, y, z) {
  try {
    queryPos.x = Math.floor(x)
    queryPos.y = Math.floor(y)
    queryPos.z = Math.floor(z)
    const b = world.getBlock(queryPos)
    return b ? b.name : null
  } catch { return null }
}

/** 把 "区块未加载" 和 "空气" 区分开写给人看 */
const showBlock = (n) => (n === null ? '未加载' : n)

export async function apply (api) {
  const { ctx, asTool, getSession, registry, logLine, workspaceOf, memoryFor } = api

  // 默认关：什么时候看一眼由 AI 自己判断（用户 2026-10-06「看第一视角改成让 ai 自主调用」）。
  // 只有显式写了 on/1/true/yes 才开硬门禁。
  const gateEnabled = /^(on|1|true|yes)$/i.test(String(process.env.DSH_MC_AGENT_VIEW_GATE ?? ''))
  // 看一眼之后：最多连着做 maxActions 个动作，且不超过 maxAgeMs 毫秒（0 = 不按时间失效）
  const numEnv = (key, dflt, min) => {
    const raw = process.env[key]
    if (raw == null || raw === '') return dflt
    const n = Number(raw)
    return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : dflt
  }
  const maxActions = numEnv('DSH_MC_AGENT_VIEW_MAX_ACTIONS', 4, 1)
  const maxAgeMs = numEnv('DSH_MC_AGENT_VIEW_MAX_AGE_MS', 60_000, 0)
  const spanText = maxAgeMs > 0 ? ` / ${Math.round(maxAgeMs / 1000)} 秒` : ''
  const gated = new Set(
    (process.env.DSH_MC_AGENT_VIEW_GATED
      ? String(process.env.DSH_MC_AGENT_VIEW_GATED).split(',')
      : DEFAULT_GATED
    ).map((s) => s.trim()).filter(Boolean),
  )

  /** agentId → { at, used }：这张图是什么时候看的、已经用掉了几个动作 */
  const viewed = new Map()

  /** agentId → 工作区路径：guard 的 exec 万一拿不到 session（workspaceOf 返回 null），
   *  就用"上次看到过的那个工作区"去找调参文件。 */
  const wsOf = new Map()
  const wsFor = (agent) => {
    const id = String(agent?.id ?? '')
    const ws = workspaceOf(agent)
    if (ws) { wsOf.set(id, ws); return ws }
    return wsOf.get(id) ?? null
  }

  /** 工作区路径 → 记忆根绝对路径（宿主认 `config.memoryDir`，扩展必须跟着走）。
   *  拿不到（老宿主 / 自检）返回 null，调用方退回 `<工作区>/.dsh-mc-agent`。 */
  const memRootOf = (ws) => { try { return ws ? (memoryFor?.(ws)?.root ?? null) : null } catch { return null } }
  /** agent → 记忆根（拿不到就退回 `<工作区>/.dsh-mc-agent`） */
  const memRootFor = (agent) => {
    const ws = wsFor(agent)
    if (!ws) return null
    return memRootOf(ws) ?? resolve(ws, '.dsh-mc-agent')
  }

  /** 可选调参文件 `<记忆根>/view.json`（默认 `<工作区>/.dsh-mc-agent/view.json`）：
   *  {"gate":true,"maxActions":6,"maxAgeMs":120000} —— 有就覆盖环境变量/默认值（放宽、收紧、gate:false 关掉都行），
   *  这样 用户 或 AI 自己写个文件就能改尺度，**不用重启 DSH、也不用环境变量**。 */
  const gateFileCfg = (agent) => {
    try {
      const root = memRootFor(agent)
      if (!root) return null
      const p = resolve(root, 'view.json')
      if (!existsSync(p)) return null
      const j = JSON.parse(readFileSync(p, 'utf8'))
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null
    } catch { return null }
  }

  /** 玩家皮肤仓库：拿真实皮肤贴图（缓存落 `<记忆根>/skins/`），拿不到就退回默认配色 */
  const mojangLookup = String(process.env.DSH_MC_AGENT_SKIN_MOJANG ?? '').toLowerCase() === 'on'
  const skinStore = createSkinStore({
    workspaceOf,
    memRootOf,
    logLine,
    // 🔴 这是**每个 HTTP 请求各自**的超时，不是整个皮肤阶段的总预算：`skinFor` → mojang 最多 2 次串行
    //    fetch，再皮肤 + 披风各 1 次（`http://` 还要先试一次 https）⇒ 单个玩家最坏 4~6 个 timeout。
    //    总预算由下面调用处那个 `withTimeout(…, callLeft() - 800)` 兜（2026-10-08 审计）。
    timeoutMs: clamp(Number(process.env.DSH_MC_AGENT_SKIN_TIMEOUT_MS) || 3_000, 500, 4_000),
    mojangLookup,
  })

  /* ─────────────────────── ① 工具 mc_observe ─────────────────────── */

  ctx.tools.register(asTool({
    name: 'mc_observe',
    description: '👁 **第一人称视角**：从我眼睛（眼高 1.62）朝正在看的方向渲染截图，直接内联给你看，并附**三段式感知**：'
      + '① **我看到**（图里数出来的：像素占比、谁在哪一侧、准星压着什么、手里拿什么）；'
      + '② **程序检测到**（坐标/朝向/独立射线打到的方块/半径内实体带坐标·距离·血量/脚下/头顶第 2 格与**能不能跳**/**局部空间地图**33×33（可站·墙·落差·未加载各多少，四向各能走几格与为什么停））；'
      + '③ **不确定**（客户端预测的方块世界、没加载的区块、读不到的血量 —— **别把推测当事实**）。'
      + '两套眼睛对不上时点名（以程序射线为准）。\n'
      + '图里：玩家（真皮肤）· 怪物（红=敌对/黄=被动）· 掉落物（黑描边）· 暗紫=区块没加载；右下角是手上的东西。\n'
      + (gateEnabled
        ? '🔴 **硬规则：动手之前必须先看一眼**。动作类工具（' + [...gated].join(' / ')
          + '）手上没有够新的图会被**直接拒绝**'
          + `（让你先调 mc_observe）。看一眼后最多连着做 ${maxActions} 个动作${spanText}，超了再看一次。\n`
          + '嫌紧可以改（立即生效）：写 `.dsh-mc-agent/view.json`，如 {"maxActions":8} 或 {"gate":false}。\n'
        : '👁 **什么时候看，你自己定**：只读查询（mc_status / mc_inventory / '
          + 'mc_scan…）不用看；**动手前先看一眼**最划算 —— 挖/放/拆/建、走路找路、'
          + '确认玩家或怪在哪、看不清、被卡住；一张图够做一段；'
          + '环境变了（走远/天黑/挨打）就再看一眼。\n')
      + (gateEnabled
        ? ''
        : '（想变回强制模式：写 `.dsh-mc-agent/view.json` 的 {"gate":true}。）\n')
      + `🔴 要让他看到：\`out:"\\.dsh-mc-agent/${EXPRESS_DIR}/<子目录>/view.png"\` 写进发布区，`
      + '再用 `mc_kit_express` 取；默认落 `.dsh-mc-agent/' + OUT_DIR + '/`（不对外）。',
    parameters: {
      width: { type: 'number', description: '宽（默认 192，32–480；越大越慢越费 token）' },
      height: { type: 'number', description: '高（默认按 16:9 算，即 108，18–480）' },
      fov: { type: 'number', description: '垂直 FOV（默认 70，20–140；越小越"望远"）' },
      distance: { type: 'number', description: '看得多远（默认 48，4–128；越大越慢）' },
      crosshair: { type: 'boolean', description: '是否画准星（默认 true）' },
      entities: { type: 'boolean', description: '是否画出玩家/怪物/掉落物（默认 true）' },
      image: { type: 'boolean', description: '是否画截图（默认 true；false = 只要结构化状态，不画图不落盘，省时间）' },
      percept: { type: 'boolean', description: '是否附三段式感知（看到/检测到/不确定，默认 true；false = 只要图和旧摘要，省 token）' },
      out: { type: 'string', description: `落盘路径（工作区相对；默认 .dsh-mc-agent/${OUT_DIR}/mc-observe-<时间>.png 不对外）` },
      verbose: { type: 'boolean', description: 'true = 连背包/装备/耐久/渲染统计一起给（默认只给一眼能用的：位置/朝向/血量/头顶/脚下/周围/实体/图路径）' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => {
        const blocks = [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }]
        // 图像以附件形式内联；纯文本模型由宿主自动降级成文本占位
        if (value?.image?.attachment) blocks.push({ type: 'image', attachment: value.image.attachment })
        return blocks
      },
    },
    timeoutMs: CALL_MS + 1_000,
    async execute (args, exec) {
      const sess = getSession(exec)
      const bot = sess.bot.requireBot() // 不在线会抛出带原因的错（幽灵在线也认得出）
      // 🔴 等区块也算进"这一轮 11 秒"（waitForChunks 自己也会看剩余时间）
      await withTimeout(sess.bot.waitForChunks(), CALL_MS, '等待区块加载')

      const e = bot.entity
      const width = clamp(Math.round(Number(args.width) || VIEW_DEFAULTS.width), 32, 480)
      const height = clamp(Math.round(Number(args.height) || Math.round((width * 9) / 16)), 18, 480)
      const fov = clamp(Number(args.fov) || VIEW_DEFAULTS.fov, 20, 140)
      const distance = clamp(Number(args.distance) || VIEW_DEFAULTS.distance, 4, 128)
      const crosshair = args.crosshair !== false
      /* 🔴 2026-10-08（用户路线图第 1 条）：「截图不应该每次都强制生成 —— 没有视觉需求的普通寻路、
       *    换工具、整理背包，直接用结构化状态即可」⇒ `image:false` = **只回结构化状态**：
       *    不渲染、不编码 PNG、不落盘、不内联；坐标/朝向/血量/饥饿/氧气/手持/背包/实体/射线/不确定照给。
       *    门禁只认"真看过图"（见文件末尾 `viewed.set`），所以 `image:false` 不能拿来糊弄门禁。 */
      const wantImage = args.image !== false
      if (!wantImage && args.percept === false) {
        throw new Error('`image:false` 和 `percept:false` 同时给就什么都不剩了 —— 至少留一个：'
          + '不画图就留着感知（percept 默认开），不想要文字就给 image（默认开）')
      }
      const eyeHeight = Number(e.eyeHeight) || VIEW_DEFAULTS.eyeHeight
      const yaw = Number(e.yaw) || 0
      const pitch = Number(e.pitch) || 0
      const origin = [e.position.x, e.position.y + eyeHeight, e.position.z]
      const s = sess.bot.status()

      // 视野附近的实体（position 是脚底；跳过自己）
      const drawEntities = args.entities !== false
      const near = []
      let nearSkipped = 0
      if (wantImage && drawEntities) { // 不画图就不用为渲染准备实体盒（省时间）
        const selfId = e.id
        const raw = bot.entities ?? {}
        /* 🔴 2026-10-08 审计：判据要和渲染侧一致 —— 渲染是按"眼睛到实体盒中心的三维距离"
         *    (`mc_view-render.mjs` `dc > distance + 4`)，这里原来只看水平距离 ⇒ 正上/正下方
         *    几十格的实体算进"附近 N 个"却被渲染丢掉（文案与实际不符）。 */
        const reach = distance + 4
        for (const key of Object.keys(raw)) {
          const ent = raw[key]
          if (!ent || !ent.position) continue
          if (selfId != null && ent.id === selfId) continue
          const ex = ent.position.x
          const ey = ent.position.y
          const ez = ent.position.z
          const cy = ey + (Number(ent.height) || 1.8) / 2
          if (Math.hypot(ex - origin[0], cy - origin[1], ez - origin[2]) > reach) continue
          near.push({
            id: ent.id, x: ex, y: ey, z: ez,
            width: ent.width, height: ent.height,
            name: ent.name, username: ent.username, displayName: plainText(ent.displayName),
            kind: ent.kind, type: ent.type,
            yaw: ent.yaw,
            dist: Math.hypot(ex - e.position.x, ey - origin[1], ez - e.position.z),
            // 真皮肤：服务端在 player_info 里给了 textures 才有
            skinData: ent.username ? (bot.players?.[ent.username]?.skinData ?? null) : null,
          })
        }
        near.sort((a, b) => a.dist - b.dist)
        // 渲染侧只画最近的 96 个（`mc_view-render.mjs` 的 `list.slice(0, 96)`）——
        // 这里也砍到 96，免得文字说"附近 120 个"而图上只有 96 个。
        if (near.length > 96) { nearSkipped = near.length - 96; near.length = 96 }
      }

      // 拉最近的几个玩家的真皮肤（有磁盘+内存缓存，正常情况下 0 延迟）
      const skins = {}
      if (wantImage && drawEntities && near.length) {
        const budget = clamp(Number(process.env.DSH_MC_AGENT_SKIN_MAX) || 4, 1, 12)
        const cands = near
          .filter((n) => n.username && (n.skinData?.url || mojangLookup))
          .slice(0, budget)
        if (cands.length) {
          const wsRoot = wsFor(exec?.agent)
          // 🔴 2026-10-08 审计：皮肤阶段**必须共享**这一轮 11 秒预算 —— 以前没有任何总预算，
          //    `waitForChunks` 用光时间之后这里照样再跑 10~20 秒，AI 拿到的是"超时错误"而不是画面。
          //    到点就退回默认配色（少几个真皮肤，总比拿不到图强）。
          const skinBudget = Math.max(300, Math.min(CALL_BUDGET_MS, (sess.bot.callLeft?.() ?? CALL_BUDGET_MS) - 800))
          const grab = Promise.all(cands.map(async (n) => {
            try { return [n.username, await skinStore.skinFor(n.username, n.skinData, wsRoot)] } catch { return [n.username, null] }
          }))
          let got = []
          try { got = await withTimeout(grab, skinBudget, '抓玩家皮肤') } catch { got = [] }
          for (const [uname, sk] of got) if (sk) skins[uname] = sk
        }
      }

      const t0 = Date.now()
      const atlas = wantImage ? await atlasForRender() : null
      const frame = wantImage
        ? renderView({
            world: bot.world, origin, yaw, pitch, width, height, fov, distance, crosshair,
            entities: near, time: s.time, dimension: s.dimension, held: s.held, skins, atlas,
          })
        : null
      const renderMs = Date.now() - t0
      const png = frame ? encodePng(width, height, frame.rgba) : null
      const total = frame ? (frame.stats.pixels || 1) : 1
      const pct = (n) => Math.round((n / total) * 100)
      const cross = frame ? frame.center : null
      const fx = Math.floor(origin[0])
      const fy = Math.floor(e.position.y)
      const fz = Math.floor(origin[2])
      // 水平朝向的整数步（拿"正前方一格"用）
      const sx = -Math.sin(yaw)
      const sz = -Math.cos(yaw)
      const stepX = Math.abs(sx) > Math.abs(sz) ? Math.sign(sx) : 0
      const stepZ = stepX === 0 ? Math.sign(sz) : 0

      /* 采样时刻（用户路线图第 1 条要 `capturedAt`：模型可能拿着几轮前的工具结果当"现在"，
       * 尤其别把旧截图当成当前画面 ⇒ 文本和结构化字段里都留一个时间戳）。 */
      const nowMs = Date.now()
      const stamp = new Date(nowMs).toTimeString().slice(0, 8)

      /* 背包（紧凑）：同名合计、只列最多的 10 样 —— 统一感知接口里要"背包"，
       * 这样普通寻路/换工具/整理背包不用再单独调一次 `mc_inventory`。 */
      let inv = null
      try {
        const all = bot.inventory.items()
        const totals = new Map()
        for (const i of all) totals.set(i.name, (totals.get(i.name) ?? 0) + i.count)
        const items = [...totals].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
        let free = null
        try { free = bot.inventory.emptySlotCount() } catch { free = null }
        inv = { items, stacks: all.length, kinds: items.length, free, held: s.held ?? null }
      } catch (err) { inv = { error: err?.message ?? String(err) } }

      /* 装备栏（头/身/腿/脚/副手）：`inventory.items()` **看不到这几格**（它们不在背包范围里），
       * 所以以前"我身上穿着什么"在感知里是空白 —— 2026-10-13 用户报"看不到自己身上的装备"。 */
      let equipment = null
      try { equipment = equipmentOf(bot) } catch { equipment = null }
      const eqText = (() => { try { return equipmentText(bot) } catch { return null } })()
      /* 耐久（2026-10-15 用户点名要的）：会磨损的东西还剩多少。
       * `tools` 是结构化列表（最危险的在最前），`durText` 是给正文用的一句话。 */
      let tools = []
      let durText = null
      try { tools = toolDurability(bot) } catch { tools = [] }
      try { durText = durabilityText(bot) } catch { durText = null }

      /* 用户 2026-10-23：「现在 ai 不知道移动后是什么状态，跳不起来」⇒ 头顶也量一份。
       * `headBlock` 只是"头那格"，跳上一格看的是它的**上一格**（`fy+2`）—— 两个分开报，
       * 再给一个能/不能跳的结论（`mc_move` 的 `above` 用同一套口径）。 */
      const headName = blockAt(bot.world, fx, fy + 1, fz)
      const jumpName = blockAt(bot.world, fx, fy + 2, fz)
      const headroomAbove = (() => {
        let n = 0
        for (let y = fy + 2; y <= fy + 7; y++) {
          const nm = blockAt(bot.world, fx, y, fz)
          if (nm === null) break // 未加载：不猜
          if (!isAirName(nm)) break // 第一块实心
          n++
        }
        return n
      })()
      const headBlocked = headName !== null && !isAirName(headName)
      const canJumpNow = headroomAbove >= 1 && !headBlocked
      /* 2026-10-23 局部空间地图（P0，用户「做p0」）：把"脚下三格"扩成"一两条通道"。
       * 只交摘要（≤6 行），**不交 169 列** —— 地图对象留在 bot 上，下次调用直接复用。 */
      const spatial = args.percept === false
        ? null
        : (() => {
            try {
              const sb = (() => {
                if (!bot) return null
                if (typeof bot.blockAt === 'function') return bot
                const w = bot.world
                if (w && typeof w.getBlock === 'function') {
                  return {
                    entity: bot.entity,
                    on: (ev, fn) => { try { bot.on?.(ev, fn) } catch { /* 假 bot 没有 on */ } },
                    blockAt: (pos) => { try { return w.getBlock(pos) } catch { return null } },
                  }
                }
                return null
              })()
              if (!sb) return { note: '这个会话拿不到方块读取接口，空间地图跳过' }
              const mp = spatialMapOf(sb)
              const slines = spatialText(mp)
              return {
                r: mp.r,
                reachable: mp.nav?.reachable ?? 0,
                counts: mp.counts,
                loaded: mp.loaded,
                cached: mp.stats,
                lines: slines,
                ...(mp.ok ? {} : { note: mp.note || '这一圈区块都还没加载' }),
              }
            } catch (err) {
              return { note: '空间地图算不出来：' + (err?.message ?? err) }
            }
          })()
      const out = {
        position: s.position ?? { x: fx, y: fy, z: fz },
        facing: compassOf(yaw),
        yawDeg: Math.round((yaw * 180) / Math.PI * 10) / 10,
        pitchDeg: Math.round((pitch * 180) / Math.PI * 10) / 10,
        dimension: s.dimension ?? null,
        timeOfDay: s.time ?? null,
        health: s.health ?? null,
        food: s.food ?? null,
        air: s.air ?? null,
        submerged: Boolean(s.submerged),
        gamemode: s.gamemode ?? null,
        held: s.held ?? null,
        ...(args.verbose === true ? { equipment, tools, durability: durText, inventory: inv } : {}),
        crosshair: !wantImage
          ? { block: null, note: '这次没截图（image:false）—— 准星对着什么看 structured 里的程序射线' }
          : cross === null
            ? { block: null, note: '准星方向到 ' + distance + ' 格都没有方块（天空）' }
            : cross.unknown
              ? { block: null, note: '准星方向撞到未加载区块' }
              : { block: cross.name, distance: Math.round(cross.dist * 10) / 10, face: ['东西面', '顶/底面', '南北面'][cross.axis] ?? null },
        surroundings: {
          underFeet: showBlock(blockAt(bot.world, fx, fy - 1, fz)),
          feetBlock: showBlock(blockAt(bot.world, fx, fy, fz)),
          headBlock: showBlock(blockAt(bot.world, fx, fy + 1, fz)),
          /* 跳上一格要占的那格 + 头顶净空：AI 老在"以为能跳"上卡（用户 2026-10-23）。 */
          jumpBlock: showBlock(jumpName),
          headroom: headroomAbove,
          canJump: canJumpNow,
          ...(canJumpNow
            ? {}
            : {
                aboveNote: headBlocked
                  ? "头那格（y=" + (fy + 1) + "）被 " + headName + " 堵着 —— 跳不起来，先挖开或挪开一格"
                  : "脚底上方第 2 格（y=" + (fy + 2) + "）是 " + (jumpName ?? "未加载") + " —— 跳不起来（上不了一格）",
              }),
          ahead: showBlock(blockAt(bot.world, fx + stepX, fy, fz + stepZ)),
          /* 🔴 只看 `e.isInWater` 会漏：泡在水柱里它读出来是 undefined（实机 (-31,59,261) 脚/头
           *    两格都是 water 却报"没在水里"）⇒ 再看脚/头那两格的方块名。
           *    🔴 审计 G1：`blockAt()` 回的是**方块名字符串**（见它自己的定义），
           *    旧写法 `blockAt(...)?.name ?? ''` 在字符串上取 `.name` 恒得 `undefined` ⇒ 恒 `''`
           *    ⇒ `/water|lava/.test('')` 恒 false —— 这段"修复"从来没生效过。 */
          inWater: Boolean(e.isInWater)
            || /water|lava/.test(String(blockAt(bot.world, fx, fy, fz) ?? ''))
            || /water|lava/.test(String(blockAt(bot.world, fx, fy + 1, fz) ?? '')),
        },
        ...(spatial ? { spatial } : {}),
        entities: frame?.stats.entities ?? [],
        crosshairEntity: frame?.stats.crosshairEntity ?? null,
        image: frame
          ? {
            /* 渲染统计（像素数/耗时/贴图来源）只在 verbose 时给 —— AI 判断用不到，
             * 真正要看的是"画面里有什么"，那是下面这几个字段。 */
            ...(args.verbose === true
              ? {
                  width, height, bytes: png.length,
                  renderMs,
                  texturedPct: pct(frame.stats.textured ?? 0),
                  atlas: atlas
                    ? { tiles: atlas.size, tag: atlas.tag, missing: (frame.stats.atlasMissing ?? []).slice(0, 5) }
                    : null,
                }
              : {}),
            hitPct: pct(frame.stats.hit),
            skyPct: pct(frame.stats.sky),
            unloadedPct: pct(frame.stats.unknown),
            topBlocks: frame.stats.top.map((t) => `${t.name} ${pct(t.pixels)}%`),
            /* 火把/花草/作物这类 boundingBox 为空的方块：视线直接穿过去，主射线打不到，
             * 渲染器在像素循环后按碰撞盒单独补画（stats.softTop）。 */
            softBlocks: (frame.stats.softTop ?? []).map((t) => `${t.name} ${pct(t.pixels)}%`),
            centerSoft: frame.stats.centerSoft ?? null,
            }
          : null,
      }

      // ① 内联给模型 / 前端看（`image:false` 时整段跳过）
      if (wantImage) {
        const att = ctx.get('attachments')
        if (att && typeof att.saveImage === 'function') {
          try {
            out.image.attachment = await att.saveImage({
              data: new Uint8Array(png), mediaType: 'image/png', name: 'mc-observe.png',
            })
          } catch (err) { out.image.attachmentError = err.message }
        } else {
          out.image.attachmentError = '宿主没有 attachments 服务'
        }
      }

      // ② 落盘（默认 `<记忆根>/.out/`，不对外；给 out 就写指定路径）
      if (wantImage) try {
        const wsRoot = wsFor(exec?.agent)
        if (!wsRoot) {
          out.image.fileError = '拿不到工作区路径（agent.session.header.cwd 为空）'
        } else {
          const rel = args.out ? String(args.out) : `.dsh-mc-agent/${OUT_DIR}/mc-observe-${Date.now()}.png`
          // `.dsh-mc-agent/...` 是"记忆根相对"的老写法：记忆根可能已经被 用户 挪出工作区
          // （`config.memoryDir`），所以剥掉前缀挂到记忆根上；其余相对路径仍按工作区解析，
          // 绝对路径原样用。这样默认出图会跟着记忆根走，express 发布区（`<记忆根>/.express/`）才对得上。
          const memPrefix = /^\.dsh-mc-agent[\\/]/i
          /* 审计 G12：这个变量是**布尔**（"是不是绝对路径"），不是路径本身 —— 原来叫 `abs`
           * 读起来像"绝对路径"，改叫 `isAbs`。 */
          const isAbs = /^([A-Za-z]:[\\/]|[\\/])/.test(rel)
          const file = isAbs
            ? rel
            : memPrefix.test(rel)
              ? resolve(memRootFor(exec?.agent) ?? wsRoot, rel.replace(memPrefix, ''))
              : resolve(wsRoot, rel)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, png)
          out.image.file = rel
          out.image.hint = `要让用户看到这张图：写到发布区（out:".dsh-mc-agent/${EXPRESS_DIR}/<子目录>/view.png"），`
            + '再用 mc_kit_express 取那一行。默认输出（.out/）不对外。'
        }
      } catch (err) { out.image.fileError = err.message }

      // ③ 摘要文本（模型先读这段，再决定要不要看图里细节）
      const visEnts = frame ? frame.stats.entities.filter((x) => x.pixels > 0) : []
      const dirOf = (x) => (x == null ? '画面外' : x < 34 ? '左侧' : x > 66 ? '右侧' : '中间')
      const lookOf = (x) => (x.skin
        ? `真实皮肤${x.skin.slim ? '（细臂）' : ''}${x.skin.cape ? '+披风' : ''}`
        : `图里是 ${x.color}`)
      const r1 = (n) => Math.round(n * 10) / 10
      const lines = []

      /* ── 三段式感知（用户 2026-10-08 要求）──────────────────────────────────
       * 「不要只让 AI 看截图，也不要只让 AI 读取方块坐标」⇒ 一次调用给三段：
       *   ① 我看到    —— 渲染出来的画面里**能数出来**的事实（像素占比、图里画了谁、准星压在哪）
       *   ② 程序检测到 —— 从游戏数据读到的（`bot.entities` 的坐标/血量、prismarine-world 的独立射线、status）
       *   ③ 不确定    —— 哪些字段不可信、为什么（客户端预测的方块世界 / 未加载区块 / 读不到的血量 / 同步延迟）
       * ①② 是两套眼睛（渲染 vs 游戏数据），③ 是"别把推测当事实"。
       * 传 `percept:false` 退回旧的一段式摘要（省 token）。 */
      let percept = null
      // 背包那行（紧凑：最多 10 样，多的用 … 省 token）
      const invText = inv?.error
        ? `读不到（${inv.error}）`
        : inv.items.length
        ? `${inv.items.slice(0, 10).map((i) => `${i.name}×${i.count}`).join('、')}${inv.items.length > 10 ? '…' : ''}（共 ${inv.kinds} 样 / ${inv.stacks} 叠${inv.free != null ? `，空位 ${inv.free}` : ''}）`
        : '空'

      if (args.percept !== false) {
        // ② 程序侧实体：带坐标/血量、隔墙也能报（原来 `mc_entities` 那条路，现在并进看图这一次调用）
        //    `entities:false` 时这条也一起关掉 —— 那个开关的语义是"这次别收集实体"，不是"只别画"
        //    🔴 2026-10-08 实机抓到的 bug：这里原来写 `bot.entities(...)`，而 `bot` 是
        //    `requireBot()` 给的**裸 mineflayer bot** —— 它的 `.entities` 是**实体映射对象**（渲染要用），
        //    不是函数 ⇒ 真服上永远报 `bot.entities is not a function`，感知块的实体段形同虚设
        //    （离线套件当时也报同样的错，被我当成"假 bot 没有这个能力"放过了）。
        //    正确入口是**会话上的 McBot 实例**（`sess.bot.entities(radius, opts)`，即 core.mjs 的 `entities()`）。
        let prog = null
        if (drawEntities) {
          if (typeof sess.bot?.entities !== 'function') {
            prog = { error: '这个宿主没给 entities()（只有裸 mineflayer bot）' }
          } else {
            try { prog = sess.bot.entities(distance, { kind: 'all', limit: 16 }) } catch (err) { prog = { error: err?.message ?? String(err) } }
          }
        }
        /* 🔴 2026-10-19 用户点的坑"读不到末影龙血量"：龙/凋灵的血**不在实体元数据里**
         *    （`entitiesNear()` 对它恒为 null），只在 Boss Bar 包里 ⇒ 这里单独读一份，
         *    否则"敌对 ender_dragon"那行永远没有血量，AI 只能靠问用户。 */
        const bosses = (() => {
          try { return sess.bot?.readBossBars?.() ?? [] } catch { return [] }
        })()
        const bossText = bosses.length ? bosses.map((x) => {
          const name = x.title || 'Boss'
          if (x.percent == null) return `${name}（读不到血量）`
          return x.hp == null ? `${name} ${x.pct}%` : `${name} ${x.pct}% ≈ ${x.hp}/${x.maxHp} 血`
        }).join('；') : ''

        // ② 独立射线：prismarine-world 自带的 `raycast`（和渲染内核那份 `castRay` 是两套实现，互相印证）
        //    🔴 2026-10-08 实机抓到的第二个 bug：`RaycastIterator` 内部用的是 `pos.plus()` /
        //    `dir.scaled()` / `pos.floored()` ⇒ **必须喂真 Vec3**；传 `{x,y,z}` 会报
        //    `this.pos.minus is not a function`（离线套件的假 world 没有 raycast，所以没暴露）。
        let ray = null
        try {
          const V = bot.entity.position.constructor
          const from = new V(origin[0], origin[1], origin[2])
          const dir = new V(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
          const hit = await withTimeout(bot.world.raycast(from, dir, distance, null), 800, '程序射线')
          ray = hit?.position
            ? { block: hit.name, x: hit.position.x, y: hit.position.y, z: hit.position.z, face: hit.face ?? null }
            : { block: null }
        } catch (err) { ray = { error: err?.message ?? String(err) } }

        // ② 实体逐条（沿用 `mc_entities` 的排布：怪/玩家一只一行，"其它"按名字合并省 token）
        const entLines = []
        let noHp = 0
        let drops = 0
        if (prog?.error) {
          entLines.push(`（读不到实体列表：${prog.error}）`)
        } else if (prog) {
          const label = { hostile: '敌对', neutral: '中立', player: '玩家', other: '生物', junk: '掉落物' }
          const one = (x) => {
            const bits = [`${label[x.kind] ?? x.kind} **${x.name}**`, `(${x.position.x}, ${x.position.y}, ${x.position.z})`, `${x.distance} 格`]
            if (x.dy) bits.push(`上下 ${x.dy > 0 ? '+' : ''}${x.dy}`)
            if (x.health != null) bits.push(`血 ${x.health}`)
            if (x.neutral) bits.push('中立（惹了才打）')
            if (x.ranged) bits.push('远程')
            /* 🔴 2026-10-19 用户：「检测到龙息应该提醒」。龙息云不是"生物"也不是"怪"，
             *    混在实体列表里一行 `生物 area_effect_cloud` 等于没说 —— 这里点名它有多疼。 */
            if (/^area_effect_cloud$/i.test(String(x.name ?? ''))) {
              bits.push('⚠️ 龙息云：站进去每 0.5 秒掉 4 点血，先跑开再管别的')
            }
            return bits.join(' · ')
          }
          const groups = new Map()
          for (const x of prog.list) {
            if (/^item$/i.test(String(x.name))) drops++
            if (x.health == null) noHp++
            /* 🔴 2026-10-23：掉落物单列 `junk` 档后必须**走聚合**，否则 174 个 item 会各占一行。
             *    捡东西时要知道在哪，所以保留"最近 3 个坐标"，只是压成一行。 */
            if (x.kind !== 'other' && x.kind !== 'junk') { entLines.push(one(x)); continue }
            const g = groups.get(x.name) ?? []
            g.push(x)
            groups.set(x.name, g)
          }
          for (const [nm, g] of groups) {
            if (g.length < 3) { for (const x of g) entLines.push(one(x)); continue }
            entLines.push(`${label[g[0].kind] ?? '其它'} **${nm}**×${g.length}（最近 3 个：${g.slice(0, 3).map((x) => `(${x.position.x}, ${x.position.y}, ${x.position.z}) ${x.distance} 格`).join('、')}）`)
          }
        }

        // ② 程序射线和渲染射线对不上时点名（两套实现不一致，以程序为准）
        const rayText = ray.error
          ? `没跑出来（${ray.error}）`
          : ray.block === null
            ? `到 ${distance} 格都没打到方块`
            : `**${ray.block}** @ (${ray.x}, ${ray.y}, ${ray.z}) · ${r1(Math.hypot(ray.x + 0.5 - origin[0], ray.y + 0.5 - origin[1], ray.z + 0.5 - origin[2]))} 格`
              + (!wantImage
                ? '（这次没截图，没有渲染那份可比）'
                : cross && !cross.unknown
                  ? (ray.block === cross.name ? '（和渲染一致）' : `（**渲染说 ${cross.name}**）`)
                  : '（渲染那边没打到）')

        // ③ 不确定清单：按重要性排，太多时留前 5 条 + 最后那条（重建画面）
        const uncertain = []
        /* 2026-10-23 审计：下面这两条**永远为真**，以前占着「最多 6 条」的名额，把会变的条目挤掉。
         * 现在单独放末尾、不参与名额；措辞也纠正 —— mineflayer 不做客户端预测，只会比服务端晚一拍。 */
        const CONST_DISCLAIMERS = [
          '本地方块世界是服务端下发的镜像，更新会晚一拍（看到的方块不代表"现在"）',
          wantImage ? '图是按方块数据重建的，不是真实画面（无光照/粒子/手臂）' : '结构化字段是这一轮现采的（看 capturedAt）',
        ]
        if (wantImage && out.image.unloadedPct > 0) uncertain.push(`${out.image.unloadedPct}% 的画面是没加载的区块（那儿看不见，程序也不知道是什么）`)
        if (wantImage && cross?.unknown) uncertain.push('准星撞在未加载区块上，那块是什么不知道')
        if (noHp > 0) uncertain.push(`${noHp} 个实体读不到血量`)
        if (wantImage && nearSkipped > 0) uncertain.push(`还有 ${nearSkipped} 个更远的实体没画（图只画最近的 96 个）`)
        if (drops > 0) uncertain.push(`地上有 ${drops} 个掉落物（掉落物同步有一两秒延迟，刚捡起可能还挂在列表里）`)
        if (!drawEntities) uncertain.push('这次没收集实体（`entities:false`）—— 实体信息整段都没有')
        if (!wantImage) uncertain.push('这次**没截图**（`image:false`）—— 没有"图里看到"这一路，全靠游戏数据；要看画面再调一次（不带 image:false）')
        if (ray?.error) uncertain.push(wantImage ? '程序射线没跑出来，准星对着什么只有渲染那份说了算' : '程序射线没跑出来，这次又没截图 —— 准星对着什么完全不知道')
        else if (ray && !ray.error && wantImage && cross && !cross.unknown && ray.block && ray.block !== cross.name) uncertain.push(`两套射线不一致：程序说 ${ray.block}，渲染说 ${cross.name}（以程序为准）`)
        const shown = uncertain.length > 6 ? [...uncertain.slice(0, 5), uncertain[uncertain.length - 1]] : uncertain
        for (const c of CONST_DISCLAIMERS) shown.push(c)

        if (wantImage) {
          lines.push(
            `👁 **我看到**（图里数出来的，${width}×${height}）：命中 ${out.image.hitPct}% · 天空 ${out.image.skyPct}% · 未加载 ${out.image.unloadedPct}%`
              + (out.image.topBlocks.length ? ` · 画面里：${out.image.topBlocks.slice(0, 5).join(' · ')}` : '')
              + (out.image.softBlocks?.length ? ` · 非实体方块：${out.image.softBlocks.slice(0, 4).join(' · ')}` : ''),
            `   · 准星${cross === null ? `指着天空（${distance} 格内没方块）` : cross.unknown ? '撞在未加载区块上' : `压在 **${cross.name}** 上（${r1(cross.dist)} 格）`}`
              + ` · 图右下角手里是 ${out.held ?? '空手'} · 脚下 ${out.surroundings.underFeet}`
              + (out.surroundings.inWater ? ' · 泡在水里' : '')
              + (out.image.centerSoft ? ` · 射线先穿过 **${out.image.centerSoft.name}**（${out.image.centerSoft.dist} 格，不是没东西）` : ''),
            /* 2026-10-23 审计：这一段和下面「程序检测到」的实体清单重复报同一批（132+202 字符）。
             * 图这行只留"**图里画出来的**是谁、在画面哪一侧、有没有被准星压着" —— 名字/坐标/血量看下面那行。 */
            visEnts.length
              ? `   · 图里 ${visEnts.length} 个实体：${visEnts.map((x) => `${x.name}@${dirOf(x.screen.xPct)}${x.underCrosshair ? '·准星正对' : ''}`).join(' · ')}`
              : (drawEntities
                  ? `   · 图里看不到实体（附近 ${near.length} 个被方块挡住或在画面外${nearSkipped ? `，另有 ${nearSkipped} 个更远的没画` : ''}）`
                  : '   · 这次没收集实体（`entities:false`）'),
          )
        } else {
          lines.push(`👁 **这次没截图**（\`image:false\`）—— 只有下面的游戏数据（要看画面：再调一次 mc_observe，别带 image:false）`)
        }
        lines.push(
          `🎯 **程序检测到**（游戏数据 · 采样 ${stamp}）：我在 (${out.position.x}, ${out.position.y}, ${out.position.z})（**脚底那格**：脚在 y=${out.position.y}，站在 y=${out.position.y - 1} 的方块上） · 朝 ${out.facing} yaw=${out.yawDeg}° pitch=${out.pitchDeg}°`
            + (out.dimension ? ` · ${out.dimension}` : '') + (out.timeOfDay != null ? ` · ${out.timeOfDay}` : '')
            + (out.crosshairEntity ? ` · 准星正对着 ${out.crosshairEntity.name}（${out.crosshairEntity.distance} 格）` : ''),
          `   · 程序射线：${rayText}`,
          prog?.error
            ? `   · 实体：${entLines.join(' ｜ ')}`
            : prog === null
              ? '   · 这次没收集实体（`entities:false`）'
              : `   · ${distance} 格内实体：敌对 ${prog?.counts?.hostile ?? 0} ｜ 中立 ${prog?.counts?.neutral ?? 0} ｜ 玩家 ${prog?.counts?.player ?? 0} ｜ 其它 ${prog?.counts?.other ?? 0}`
                + (prog?.counts?.junk ? ` ｜ 掉落物 ${prog.counts.junk}` : '')
                + (entLines.length ? ` —— ${entLines.join(' ｜ ')}` : '（一只都没有）')
                + (prog && prog.total > prog.list.length ? `（还有 ${prog.total - prog.list.length} 个没列出来）` : ''),
          ...(bossText ? [`   · 🗡 **Boss 血条**：${bossText}（龙/凋灵的血只在血条里，\`实体\` 那行读不到它）`] : []),
          `   · 生命 ${out.health ?? '?'} · 饥饿 ${out.food ?? '?'}`
            + (out.air != null ? ` · 氧气 ${out.air}${out.air <= 0 ? '（见底，正在窒息掉血）' : ''}` : '') + (out.submerged ? '（头在水下）' : '')
            + ` · 模式 ${out.gamemode ?? '?'} · 手持 ${out.held ?? '空手'}`,
          `   · 🎒 背包：${invText}`,
          `   · 🛡 装备栏：${eqText ?? '读不到'}`,
          ...(out.durability ? [`   · ${out.durability}`] : []),
          `   · 脚下 ${out.surroundings.underFeet} · 脚内 ${out.surroundings.feetBlock} · 头上一格 ${out.surroundings.headBlock} · 头顶第 2 格 ${out.surroundings.jumpBlock ?? `?`}`
            + ` · 正前方一格 ${out.surroundings.ahead}`
            + (out.surroundings.canJump === false ? ` · ⛔ **跳不起来**（${out.surroundings.aboveNote ?? '头顶堵着'}）`
              : out.surroundings.canJump === true ? ` · 能跳（头顶净空 ${out.surroundings.headroom} 格）` : '')
            + (out.surroundings.inWater ? ' · 泡在水里' : ''),
          '⚠️ **不确定**（别当成事实）：' + shown.map((t, i) => `${'①②③④⑤⑥⑦⑧⑨'[i] ?? '·'}${t}`).join('　'),
        )
        percept = {
          /* 用户路线图第 1 条点名的字段（扁平放一份：程序化消费、模型回看都一眼能拿）
           * `capturedAt` = 这份感知是什么时候采的（毫秒 + 本地时间），防止把旧截图/旧结果当"现在"。 */
          capturedAt: nowMs,
          capturedAtLocal: stamp,
          position: out.position, facing: out.facing, yawDeg: out.yawDeg, pitchDeg: out.pitchDeg,
          health: out.health, food: out.food, air: out.air, submerged: out.submerged,
          heldItem: out.held, gamemode: out.gamemode, inventory: inv, equipment,
          targetBlock: ray, visibleEntities: prog?.list ?? null,
          bossBars: bosses,
          image: wantImage ? { width, height, bytes: png.length, renderMs } : null,
          uncertain,
          uncertainties: uncertain, // 别名（路线图里写的是 uncertainties）
          seen: wantImage
            ? {
                size: `${width}×${height}`,
                hitPct: out.image.hitPct, skyPct: out.image.skyPct, unloadedPct: out.image.unloadedPct,
                topBlocks: out.image.topBlocks.slice(0, 5),
                softBlocks: (out.image.softBlocks ?? []).slice(0, 5),
                centerSoft: out.image.centerSoft ?? null,
                crosshair: cross === null ? null : cross.unknown ? 'unloaded' : { block: cross.name, distance: r1(cross.dist) },
                held: out.held,
                entities: visEnts.map((x) => ({
                  name: x.name, label: x.label, hostile: Boolean(x.hostile),
                  distance: x.distance, side: dirOf(x.screen.xPct), underCrosshair: Boolean(x.underCrosshair),
                })),
              }
            : null, // image:false → 没有"图里看到"这一路
          sensed: {
            position: out.position, facing: out.facing, yawDeg: out.yawDeg, pitchDeg: out.pitchDeg,
            dimension: out.dimension, timeOfDay: out.timeOfDay,
            ray,
            counts: prog?.counts ?? null, total: prog?.total ?? null, entities: prog?.list ?? null,
            health: out.health, food: out.food, air: out.air, submerged: out.submerged,
            gamemode: out.gamemode, held: out.held, inventory: inv, equipment,
            surroundings: out.surroundings,
            spatial: out.spatial ?? null,
          },
        }
        out.percept = percept
      } else {
        // 旧的一段式摘要（`percept:false` 时用）
        lines.push(
          `👁 第一人称 ${width}×${height} · 位置 (${out.position.x}, ${out.position.y}, ${out.position.z})`
            + ` · 朝向 ${out.facing} yaw=${out.yawDeg}° pitch=${out.pitchDeg}°`
            + (out.dimension ? ` · 维度 ${out.dimension}` : '')
            + (out.timeOfDay != null ? ` · 时间 ${out.timeOfDay}` : ''),
          `🎯 准星：${cross === null ? '天空（' + distance + ' 格内没方块）' : cross.unknown ? '未加载区块' : `${cross.name} · ${r1(cross.dist)} 格`}`
            + (out.crosshairEntity ? ` · **准星正对着 ${out.crosshairEntity.name}（${out.crosshairEntity.distance} 格）**` : '')
            + ` · 脚下 ${out.surroundings.underFeet} · 脚内 ${out.surroundings.feetBlock} · 头上一格 ${out.surroundings.headBlock}`
            + ` · 正前方一格 ${out.surroundings.ahead}`
            + (out.surroundings.canJump === false ? ` · ⛔ **跳不起来**（${out.surroundings.aboveNote ?? '头顶堵着'}）`
              : out.surroundings.canJump === true ? ` · 能跳（头顶净空 ${out.surroundings.headroom} 格）` : ''),
          `🧱 画面：命中 ${out.image.hitPct}% · 天空 ${out.image.skyPct}% · 未加载 ${out.image.unloadedPct}%`
            + (out.image.topBlocks.length ? ` · 视野里：${out.image.topBlocks.slice(0, 5).join(' · ')}` : '')
            + (out.image.softBlocks?.length ? ` · 非实体方块：${out.image.softBlocks.slice(0, 4).join(' · ')}` : ''),
        )
        lines.push(visEnts.length
          ? '👥 视野里 ' + visEnts.length + ' 个实体：' + visEnts.map((x) =>
            `${x.name}（${x.label}${x.hostile && !String(x.label).includes('敌对') ? '·敌对' : ''}·${lookOf(x)}）${x.distance} 格 ${dirOf(x.screen.xPct)}`
            + (x.underCrosshair ? '·准星正对' : '')).join(' · ')
          : (near.length
              ? `👥 视野里看不到实体（附近 ${near.length} 个被方块挡住或在画面外${nearSkipped ? `，另有 ${nearSkipped} 个更远的没画` : ''}）`
              : '👥 视野里没有实体（附近没人、没怪、没掉落物）'))
        if (out.health != null) {
          lines.push(`❤ 血量 ${out.health} · 饱食 ${out.food}`
            + (out.air != null ? ` · 氧气 ${out.air}${out.air <= 0 ? '（见底，正在窒息掉血）' : ''}` : '') + (out.submerged ? '（头在水下）' : '')
            + ` · 模式 ${out.gamemode ?? '?'} · 手持 ${out.held ?? '空手'}`
            + (out.surroundings.inWater ? ' · 泡在水里' : ''))
        }
        lines.push(`🎒 背包：${invText}`)
        lines.push(`🛡 装备栏：${eqText ?? '读不到'}（穿/脱用 mc_act {mode:"equip"}）`)
        if (out.durability) lines.push(`🛠 ${out.durability}`)
        if (out.image && out.image.unloadedPct > 25) {
          lines.push('⚠️ 未加载像素偏多：区块可能还没加载完，可以稍等再 mc_observe 一次。')
        }
        if (out.spatial?.lines?.length) lines.push(...out.spatial.lines)
      }
      /* 2026-10-23：默认落盘路径（.out/）对决策没意义，只在用户点名 out 时才报。 */
      if (out.image?.file && !String(out.image.file).includes('/.out/')) lines.push(`💾 已落盘 ${out.image.file}（${renderMs}ms）`)
      if (out.image?.attachmentError) lines.push(`⚠️ 内联图片失败：${out.image.attachmentError}`)
      out.text = lines.join('\n')

      // ④ 记下"本会话刚看过图"，放行接下来的动作（最多 maxActions 个 / maxAgeMs 毫秒）
      // 🔴 `image:false` 不算"看过"：门禁要的是真看过画面，不然拿"只看数据"就能把门禁糊弄过去
      // 🔴 审计 G5：内联失败（`attachmentError`）也**不算看过** —— 旧写法只看 `wantImage`，
      //    图没送出去也算数，门禁就被绕过了（模型手里其实没有画面）。
      const agentId = exec?.agent?.id
      if (agentId && wantImage && out.image?.attachment) viewed.set(String(agentId), { at: Date.now(), used: 0 })
      return out
    },
  }))

  /* ───────── ② 可选硬门禁：动手前必须先看图（**默认关**，AI 自主决定何时看） ───────── */

  try {
    /** 判定"这张图还能不能用"：够新 + 额度没用完 */
    const judge = (rec, ma, mg) => {
      if (rec && rec.used < ma && (mg <= 0 || Date.now() - rec.at <= mg)) return { ok: true }
      const stale = rec && mg > 0 ? Date.now() - rec.at : 0
      return {
        ok: false,
        why: !rec
          ? '本会话还没看过第一人称图'
          : (rec.used >= ma
              ? `上一张图已经连着做了 ${rec.used} 个动作`
              : `上一张图已经过了 ${Math.round(stale / 1000)} 秒`),
      }
    }
    const denyText = (tool, ma, mg, why) =>
      `🔴 动手前先看一眼：调用 mc_observe 看第一人称视角截图，然后立刻执行 ${tool}。`
      + `（规则：看一眼最多连着做 ${ma} 个动作${mg > 0 ? ` / ${Math.round(mg / 1000)} 秒` : ''}，之后要再看一次 —— ${why}。）`

    // 门禁**总是注册**，生效与否每次判定时现算 —— 这样 view.json 里的 {"gate":true}
    // 能当场把强制模式打开，不用重启 DSH（只按默认值决定注不注册的话就做不到）。
    ctx.tools.guard((exec) => {
      const tool = String(exec?.name ?? '')
      if (!gated.has(tool)) return undefined
      const agent = exec?.agent
      if (!agent) return undefined
      // peek 而不是 getOrCreate：没会话/没连上就不拦，交给工具自己报「不在线」
      const sess = registry.peek(String(agent.id))
      if (!sess?.bot?.online) return undefined

      let on = gateEnabled
      let ma = maxActions
      let mg = maxAgeMs
      // 可选的调参文件：每次判定都读（文件很小、判定的都是动作类工具，代价可忽略），
      // 这样 用户 / AI 写个文件就能开关和改尺度 —— 改完立即生效。
      const cfg = gateFileCfg(agent)
      if (cfg) {
        if (cfg.gate === true || cfg.gate === 'on') on = true
        else if (cfg.gate === false || cfg.gate === 'off') on = false
        const na = Number(cfg.maxActions)
        const ng = Number(cfg.maxAgeMs)
        if (Number.isFinite(na)) ma = Math.max(1, Math.floor(na))
        if (Number.isFinite(ng)) mg = Math.max(0, Math.floor(ng))
      }
      if (!on) return undefined // 默认：不拦，AI 自己决定何时看图

      const rec = viewed.get(String(agent.id))
      const v = judge(rec, ma, mg)
      if (v.ok) return undefined
      logLine(`mc_observe 门禁：拒绝 ${tool}（${v.why}）`)
      return denyText(tool, ma, mg, v.why)
    })
    // 动作执行完就把这张图"用掉"一格：用满 maxActions 个（或超时）就得重新看
    // （门禁关着时这些计数没人看，留着不碍事）
    ctx.on('tools/post-execute', async (exec, result, next) => {
      if (gated.has(String(exec?.name ?? ''))) {
        const rec = viewed.get(String(exec?.agent?.id ?? ''))
        // 没真正执行成功的（被指令白名单挡了、服务端拒绝等）不算用掉一格
        const failed = result?.isError === true || result?.message?.isError === true
          || result?.error != null || result?.ok === false
        if (rec && !failed) rec.used += 1
      }
      return next()
    })
    logLine(gateEnabled
      ? `mc_observe 已加载：工具 mc_observe + 动作前看图门禁（${[...gated].join('/')}；看一眼可做 ${maxActions} 个动作${spanText}）`
      : 'mc_observe 已加载：工具 mc_observe（默认模式 —— AI 自主决定何时看图，动作前看图门禁未启用；想强制就把 .dsh-mc-agent/view.json 写成 {"gate":true}）')
  } catch (err) {
    logLine(`mc_observe 门禁注册失败（工具仍可用）：${err?.message ?? err}`)
  }
}
