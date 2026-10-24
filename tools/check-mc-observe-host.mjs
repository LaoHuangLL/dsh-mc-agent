/**
 * mc_observe 扩展的宿主侧自检：用假 ctx / 假 bot 加载真实扩展文件，跑通
 *   ① 工具注册形状  ② 渲染输出（文字 + 图片附件 + 落盘）  ③ 动作前看图门禁（默认关，AI 自主）
 * 不连 MC、不需要 DSH。
 * 跑法：node dsh-mc-agent/tools/check-mc-observe-host.mjs [--gate-on]
 *   默认（不带参数）= **AI 自主模式**：门禁不生效，靠工具说明引导；view.json 能当场打开。
 *   --gate-on = 强制模式（DSH_MC_AGENT_VIEW_GATE=on），验证硬门禁的尺度与失效。
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const GATE_ON = process.argv.includes('--gate-on')
if (GATE_ON) process.env.DSH_MC_AGENT_VIEW_GATE = 'on'
else delete process.env.DSH_MC_AGENT_VIEW_GATE // 默认：AI 自主，外面真设了也清掉，免得测出不确定结果
// 门禁尺度：固定成 4 个动作 / 60 秒，免得被外部环境变量搞成不确定
const MAX = 4
const AGE = 60_000
process.env.DSH_MC_AGENT_VIEW_MAX_ACTIONS = String(MAX)
process.env.DSH_MC_AGENT_VIEW_MAX_AGE_MS = String(AGE)

const EXT = new URL('../extensions/mc_observe.mjs', import.meta.url).href

/** 记忆根（模拟 Master 设了 `config.memoryDir`）；null = 老宿主，退回 `<工作区>/.dsh-mc-agent` */
let MEM_ROOT = null

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) } else { fail++; console.log('  FAIL ' + label + (extra ? '  <<< ' + extra : '')) }
}

/* ── 假世界：平地 + 北边石墙(z=-4) + 右前方水 + 更右一块未加载 ── */
const world = {
  getBlock (pos) {
    // 照抄 prismarine-world：必须调 pos.floored()（worldsync.js:102）
    const { x, y, z } = pos.floored()
    if (x >= 6 && z <= -2) return null // 未加载
    if (x >= 2 && x <= 3 && z >= -2 && z <= -1 && y === 0) return { name: 'water', boundingBox: 'empty' }
    if (y < 0) return { name: 'stone', boundingBox: 'block' }
    if (y === 0) return { name: 'grass_block', boundingBox: 'block' }
    if (z === -4 && y >= 1 && y <= 3) return { name: 'stone', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  },
}
const SELF = { id: 1, type: 'player', name: 'player', position: { x: 0.5, y: 1, z: 0.5 }, width: 0.6, height: 1.8 }
const STEVE = { id: 2, type: 'player', name: 'player', username: 'Steve', position: { x: -2.5, y: 1, z: -2 }, width: 0.6, height: 1.8 }
const ZOMBIE = { id: 3, type: 'mob', name: 'zombie', kind: 'Hostile mobs', position: { x: 2.5, y: 1, z: -2 }, width: 0.6, height: 1.95 }
const mineflayerBot = {
  entity: {
    id: 1,
    position: { x: 0.5, y: 1, z: 0.5 },
    yaw: 0,
    pitch: 0,
    eyeHeight: 1.62,
    isInWater: false,
  },
  entities: { 1: SELF, 2: STEVE, 3: ZOMBIE },
  world,
}
/** 会话上的 McBot 实例（`sess.bot`）—— 感知块要调它的 `entities()`。
 *  🔴 裸 `mineflayerBot.entities` 是**实体映射对象**（渲染要用），不是函数；2026-10-08 实机
 *  就踩了这个：`bot.entities(...)` 在真服永远报 `is not a function`，所以这里必须提供这一层。 */
const mkEntities = (radius = 24, { kind = 'all', limit = 40 } = {}) => {
  const rows = [
    { e: STEVE, kind: 'player', hostile: false, neutral: false, player: true, health: 20, distance: 3 },
    { e: ZOMBIE, kind: 'hostile', hostile: true, neutral: false, player: false, health: 20, distance: 4 },
  ].map((r) => ({
    name: r.e.username ?? r.e.name, kind: r.kind, hostile: r.hostile, neutral: r.neutral, ranged: false,
    distance: r.distance, position: { x: r.e.position.x, y: r.e.position.y, z: r.e.position.z }, dy: 0,
    health: r.health, ...(r.player ? { player: true } : {}),
  }))
  return {
    me: { x: 0.5, y: 1, z: 0.5 }, radius, kind,
    counts: { hostile: 1, neutral: 0, player: 1, other: 0 }, total: rows.length,
    list: rows.slice(0, limit),
  }
}
/** 让假 bot 正对 Steve 的包围盒中心（眼在 0.5,2.62,0.5） */
const aimAtSteve = () => { mineflayerBot.entity.yaw = 0.8761; mineflayerBot.entity.pitch = -0.1824 }
const mkBot = (online, { noEntities = false } = {}) => ({
  online,
  bot: mineflayerBot,
  requireBot () { if (!online) throw new Error('机器人不在线（假会话）'); return mineflayerBot },
  ...(noEntities ? {} : { entities: mkEntities }),
  waitForChunks: async () => {},
  status: () => ({
    online, position: { x: 0, y: 1, z: 0 }, yaw: 0, pitch: 0, gamemode: 'survival',
    dimension: 'overworld', time: 6000, health: 20, food: 20, held: 'stone_pickaxe', inWater: false,
  }),
})

/* ── 假宿主 ctx / api ── */
const registered = new Map()
const guards = []
const handlers = new Map()
const logs = []
const sessions = new Map()
const wsRoot = mkdtempSync(join(tmpdir(), 'mcview-ws-'))
const savedImages = []

const ctx = {
  tools: {
    register: (def) => { registered.set(def.name, def) },
    guard: (fn) => { guards.push(fn) },
    get: () => undefined,
  },
  on: (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event) },
  get: (service) => (service === 'attachments'
    ? { saveImage: async ({ data, mediaType, name }) => { const att = { id: 'att-' + savedImages.length, mediaType, name, bytes: data.length }; savedImages.push(att); return att } }
    : undefined),
  logger: { info: (m) => logs.push('info ' + m), warn: (m) => logs.push('warn ' + m) },
}

const api = {
  ctx,
  config: {},
  registry: {
    peek: (id) => sessions.get(String(id)),
    listSessions: () => [...sessions.values()],
  },
  asTool: (spec) => spec, // 真插件会再包一层（getSession + setAbortSignal + lossless）
  getSession: (exec) => {
    const id = exec?.agent?.id
    if (!id) throw new Error('拿不到当前会话（exec.agent 不可用）')
    return sessions.get(String(id))
  },
  memory: {},
  // 记忆根：null = 老宿主（退回 <工作区>/.dsh-mc-agent）；设了就模拟 `config.memoryDir` 生效
  memoryFor: () => (MEM_ROOT ? { root: MEM_ROOT } : {}),
  workspaceOf: (agent) => agent?.session?.header?.cwd ?? null,
  logLine: (line) => logs.push('logLine ' + line),
  Watchdog: class {},
  ensureWatchdog: () => {},
}

const mod = await import(EXT + '?v=' + Date.now())
ok(typeof mod.apply === 'function', '扩展导出 apply(api)')
ok(mod.name === 'mc_observe', '扩展 name = mc_observe', mod.name)
await mod.apply(api)

console.log('— ① 工具注册 —')
{
  const spec = registered.get('mc_observe')
  ok(Boolean(spec), '注册了 mc_observe')
  ok(spec && typeof spec.execute === 'function', '有 execute')
  ok(spec && typeof spec.description === 'string'
    && (GATE_ON ? spec.description.includes('硬规则') : spec.description.includes('什么时候看，你自己定')),
    GATE_ON ? '描述里写明了"动手前先看"的硬规则' : '描述里写明"什么时候看，你自己定"（自主模式）')
  if (GATE_ON) {
    ok(spec && spec.description.includes('最多连着做 4 个动作'), '描述里写明了看一眼能做几个动作')
  } else {
    /* 🔴 2026-10-15：这句断言原来找的是"没有硬性门禁"四个字，而描述早就改成
     *    "**什么时候看，你自己定**"了（`extensions\mc_observe.mjs` 的 gateEnabled 三元）
     *    ⇒ 从改词那天起就一直红着。这里按**意图**断言：不宣称硬规则 + 明确交给模型自己定。 */
    ok(spec && !spec.description.includes('硬规则') && spec.description.includes('什么时候看，你自己定'),
      '自主模式的描述里不再有"硬规则"，改成"什么时候看，你自己定"')
  }
  ok(spec && spec.parameters && typeof spec.parameters === 'object', '有 parameters（平铺映射，和 mc_map 同款）')
  ok(spec && !Array.isArray(spec.parameters) && spec.parameters.width && spec.parameters.width.type === 'number', 'parameters.width 是 number')
  ok(spec && typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0, 'timeoutMs 是正数', spec && String(spec.timeoutMs))
  ok(spec && spec.output && spec.output.schema && spec.output.schema.additionalProperties === true, 'output.schema 带 additionalProperties')
  const blocks = spec.output.render({}, { text: 'hi', image: { attachment: { id: 'a1' } } })
  ok(Array.isArray(blocks) && blocks.length === 2 && blocks[0].type === 'text' && blocks[1].type === 'image', 'render 同时推文字与图片块', JSON.stringify(blocks))
  const blocks2 = spec.output.render({}, { text: 'hi' })
  ok(blocks2.length === 1 && blocks2[0].type === 'text', '没有图片时只推文字')
  ok(logs.some((l) => l.includes('mc_observe 已加载') || l.includes('mc_observe 门禁注册失败')), 'apply 打了加载日志', JSON.stringify(logs))
}

console.log('— ② 门禁注册（总是注册，生效与否每次现算）—')
ok(guards.length === 1, '注册了 1 个守卫（默认开还是关都注册，view.json 才能当场切换）', String(guards.length))
ok(handlers.has('tools/post-execute'), '注册了 tools/post-execute 处理器')

console.log('— ③ 门禁行为 —')
{
  const guard = guards[0]
  const ex = (name, id = 'A', withWs = true) => ({ name, agent: withWs ? { id, session: { header: { cwd: wsRoot } } } : { id } })
  const spec = registered.get('mc_observe')
  const post = handlers.get('tools/post-execute')

  ok(guard(ex('mc_status')) === undefined, '只读工具（mc_status）永不拦')
  ok(guard(ex('mc_move', 'NOBODY')) === undefined, '没会话时不拦（交给工具自己报错）')
  sessions.set('A', { bot: mkBot(false) })
  ok(guard(ex('mc_move')) === undefined, '会话离线时不拦')
  sessions.set('A', { bot: mkBot(true) })

  if (!GATE_ON) {
    /* —— 默认：AI 自主模式。动作类工具一律不拦，什么时候看图由模型自己判断 —— */
    ok(guard(ex('mc_move')) === undefined, '自主模式：在线 + 没看过图也不拦 mc_move')
    ok(guard(ex('mc_dig')) === undefined && guard(ex('mc_build')) === undefined && guard(ex('mc_command')) === undefined,
      '自主模式：mc_dig / mc_build / mc_command 也不拦')
    ok(guard(ex('mc_scan')) === undefined, '自主模式：只读工具照旧不拦')
    ok(logs.some((l) => l.includes('AI 自主决定何时看图')),
      '加载日志写明是"AI 自主"模式', JSON.stringify(logs.filter((l) => l.includes('mc_observe 已加载'))))

    // view.json 能**当场**把强制模式打开/关掉（不用重启 DSH）—— 这是"总是注册"的理由
    const viewJson = join(wsRoot, '.dsh-mc-agent', 'view.json')
    mkdirSync(dirname(viewJson), { recursive: true })
    try {
      writeFileSync(viewJson, JSON.stringify({ gate: true, maxActions: 2, maxAgeMs: 60_000 }))
      const denied = guard(ex('mc_move'))
      ok(typeof denied === 'string' && denied.includes('mc_observe'),
        'view.json {"gate":true} ⇒ 当场变强制模式：拒绝并让先看图', String(denied))
      ok(typeof guard(ex('mc_dig')) === 'string', '强制模式下 mc_dig 也拦')
      await spec.execute({}, { agent: { id: 'A', session: { header: { cwd: wsRoot } } } })
      ok(guard(ex('mc_move')) === undefined, '强制模式下看过图就放行')
      await post(ex('mc_move'), { content: [] }, async () => ({}))
      await post(ex('mc_move'), { content: [] }, async () => ({}))
      ok(typeof guard(ex('mc_move')) === 'string', '用满 view.json 里的 maxActions:2 ⇒ 又要看一次（额度也跟着文件走）')
      writeFileSync(viewJson, JSON.stringify({ gate: false }))
      ok(guard(ex('mc_move')) === undefined, 'view.json {"gate":false} ⇒ 又放开（回到自主模式）')
    } finally { rmSync(viewJson, { force: true }) }
    ok(guard(ex('mc_move')) === undefined, '删掉 view.json ⇒ 仍按默认（自主）')
  } else {
    /* —— 强制模式：验证尺度、失效、隔离 —— */
    const denied = guard(ex('mc_move'))
    ok(typeof denied === 'string' && denied.includes('mc_observe'), '在线 + 没看过图 ⇒ 拒绝并让先看 mc_observe', String(denied))
    ok(typeof guard(ex('mc_dig')) === 'string' && typeof guard(ex('mc_act')) === 'string', 'mc_dig / mc_act 也拦')
    ok(guard(ex('mc_scan')) === undefined, 'mc_scan（只读）不拦')

    // 看图 → 放行
    const out = await spec.execute({}, { agent: { id: 'A', session: { header: { cwd: wsRoot } } } })
    ok(guard(ex('mc_move')) === undefined, '看过图后 mc_move 放行')
    ok(guard(ex('mc_observe')) === undefined, 'mc_observe 自己永远不被拦')

    // 看一眼能连着做 MAX 个动作：第 1..MAX 个全放行，第 MAX+1 个才被拒
    const allowed = []
    for (let i = 0; i < MAX; i++) {
      allowed.push(guard(ex('mc_move')) === undefined)
      await post(ex('mc_move'), { content: [] }, async () => ({ kind: 'accept' }))
    }
    ok(allowed.every(Boolean), `看一眼后连着 ${MAX} 个动作全部放行（不再"做一个动作就得重看"）`, JSON.stringify(allowed))
    const deniedN = guard(ex('mc_move'))
    ok(typeof deniedN === 'string' && deniedN.includes(`最多连着做 ${MAX} 个动作`),
      `第 ${MAX + 1} 个动作才被拒，且拒绝文案说明额度`, String(deniedN))

    // 失败的动作（isError）不占额度
    await spec.execute({}, { agent: { id: 'A', session: { header: { cwd: wsRoot } } } })
    for (let i = 0; i < 3; i++) await post(ex('mc_command'), { isError: true, content: [] }, async () => ({}))
    ok(guard(ex('mc_move')) === undefined, '被拒/失败的动作不占额度（isError）')
    const passthrough = await post(ex('mc_observe'), { content: [] }, async () => 'NEXT')
    ok(passthrough === 'NEXT', 'post-execute 把 next() 的返回值透传出去', String(passthrough))

    // 另一个 agent：没会话 ⇒ 不拦；建了会话且没看过 ⇒ 拦
    ok(guard(ex('mc_move', 'B')) === undefined, 'B 还没有会话 ⇒ 不拦')
    sessions.set('B', { bot: mkBot(true) })
    ok(typeof guard(ex('mc_move', 'B')) === 'string', 'B 会话在线也没看过 ⇒ 拦')
    const outB = await spec.execute({}, { agent: { id: 'B', session: { header: { cwd: wsRoot } } } })
    ok(guard(ex('mc_move', 'B')) === undefined, 'B 看过之后放行')
    ok(guard(ex('mc_move', 'A')) === undefined, 'A 的图还在有效期内（会话隔离，各自计时）')
    ok(outB.image.file && outB.image.file.startsWith('.dsh-mc-agent'), 'B 也落盘了')

    // 超时失效：把时钟拨到 AGE 之后
    const realNow = Date.now
    let fake = realNow()
    Date.now = () => fake
    try {
      await spec.execute({}, { agent: { id: 'B', session: { header: { cwd: wsRoot } } } })
      ok(guard(ex('mc_move', 'B')) === undefined, '刚看完 ⇒ 放行（假时钟）')
      fake += AGE + 1000
      const aged = guard(ex('mc_move', 'B'))
      ok(typeof aged === 'string' && aged.includes('过了'), `超过 ${AGE / 1000} 秒后失效，拒绝文案写明原因`, String(aged))
    } finally { Date.now = realNow }

    // 可选调参文件 <工作区>/.dsh-mc-agent/view.json（立即生效，不用重启 DSH）
    const viewJson = join(wsRoot, '.dsh-mc-agent', 'view.json')
    mkdirSync(dirname(viewJson), { recursive: true })
    try {
      await spec.execute({}, { agent: { id: 'A', session: { header: { cwd: wsRoot } } } })
      for (let i = 0; i < MAX; i++) await post(ex('mc_move'), { content: [] }, async () => ({}))
      ok(typeof guard(ex('mc_move')) === 'string', '额度用满 ⇒ 拒（此时还没有调参文件）')
      writeFileSync(viewJson, JSON.stringify({ maxActions: MAX + 3 }))
      ok(guard(ex('mc_move')) === undefined, 'view.json 放大 maxActions ⇒ 立即放行（不用重启）')
      ok(guard(ex('mc_move', 'A', false)) === undefined, 'guard 的 exec 拿不到工作区时，用"上次看到的工作区"也能找到调参文件')
      writeFileSync(viewJson, '{ 这不是 JSON')
      ok(typeof guard(ex('mc_move')) === 'string', 'view.json 写坏了就当没有（仍然拒，不抛）')
      writeFileSync(viewJson, JSON.stringify({ gate: false }))
      ok(guard(ex('mc_move')) === undefined, 'view.json 里 gate:false ⇒ 直接放行（等于关掉门禁）')
      writeFileSync(viewJson, JSON.stringify({ maxActions: 1, maxAgeMs: 0 }))
      await spec.execute({}, { agent: { id: 'A', session: { header: { cwd: wsRoot } } } })
      ok(guard(ex('mc_move')) === undefined, 'view.json maxActions:1 ⇒ 第一下放行')
      await post(ex('mc_move'), { content: [] }, async () => ({}))
      ok(typeof guard(ex('mc_move')) === 'string', 'view.json maxActions:1 ⇒ 第二下就拒（文件能收紧）')
      const real2 = Date.now
      let f2 = real2()
      Date.now = () => f2
      try {
        await spec.execute({}, { agent: { id: 'A', session: { header: { cwd: wsRoot } } } })
        f2 += 3_600_000
        ok(guard(ex('mc_move')) === undefined, 'view.json maxAgeMs:0 ⇒ 一小时前看的图也算数（不按时间失效）')
      } finally { Date.now = real2 }
    } finally { rmSync(viewJson, { force: true }) }
  }
}

console.log('— ④ execute 输出（含真实渲染 + 附件 + 落盘）—')
{
  const spec = registered.get('mc_observe')
  sessions.set('C', { bot: mkBot(true) })
  const exec = { agent: { id: 'C', session: { header: { cwd: wsRoot } } } }
  const out = await spec.execute({ verbose: true }, exec)
  // ── 三段式感知（2026-10-08 用户要求："看到什么 / 程序检测到什么 / 哪些不确定"分开） ──
  // 这个假 bot 的 `entities` 是**对象映射**（渲染要用）、`world` 没有 `raycast`
  // ⇒ 程序侧两条探针都会抛，感知块必须靠 try/catch 兜住并如实说"没跑出来"。
  ok(out.text.includes('👁 **我看到**'), 'text 第一段是"我看到"（图里数出来的）', out.text.split('\n')[0])
  ok(out.text.includes('🎯 **程序检测到**'), 'text 第二段是"程序检测到"（游戏数据）')
  ok(out.text.includes('⚠️ **不确定**'), 'text 第三段是"不确定"清单（别把推测当事实）')
  ok(out.text.includes('图里 2 个实体') && out.text.includes('Steve'), 'text 的"我看到"段列了图里的实体',
    out.text.split('\n').find((l) => l.includes('图里')))
  ok(out.percept && out.percept.seen && out.percept.sensed && Array.isArray(out.percept.uncertain),
    'percept 结构齐（seen / sensed / uncertain）', JSON.stringify(Object.keys(out.percept ?? {})))
  ok(out.percept.seen.crosshair && out.percept.seen.crosshair.block === 'stone',
    'percept.seen.crosshair 记了准星方块', JSON.stringify(out.percept.seen.crosshair))
  ok(out.percept.seen.entities.length === 2, 'percept.seen.entities 是图里那份（2 个）')
  ok(Array.isArray(out.percept.sensed.entities) && out.percept.sensed.entities.length === 2,
    'sensed.entities 走会话上的 McBot.entities()（真数据，不是裸 bot 的映射对象）',
    JSON.stringify((out.percept.sensed.entities ?? []).map((x) => x.name)))
  ok(out.percept.sensed.counts?.hostile === 1 && out.percept.sensed.counts?.player === 1,
    'sensed.counts 有敌对/玩家计数', JSON.stringify(out.percept.sensed.counts))
  ok(out.text.includes('格内实体：敌对 1 ｜ 中立 0 ｜ 玩家 1 ｜ 其它 0'), 'text 给了"半径内实体：敌对 x ｜ 中立 y ｜ 玩家 z ｜ 其它 w"（2026-10-17 加中立档）')
  ok(out.percept.sensed.counts?.neutral === 0, 'sensed.counts 里也带 neutral（没中立怪就是 0，不是 undefined）',
    JSON.stringify(out.percept.sensed.counts))
  ok(out.percept.sensed.ray && out.percept.sensed.ray.error,
    '假 world 没有 raycast ⇒ 程序射线如实记成 { error }，不炸', JSON.stringify(out.percept.sensed.ray))
  ok(out.percept.uncertain.some((t) => /程序射线没跑出来/.test(t)), '不确定清单里点出"程序射线没跑出来"')
  /* 2026-10-23 审计：措辞从「客户端预测」改成「服务端下发的镜像，更新会晚一拍」——
   * mineflayer 根本不做预测，客户端只会**落后**，不会抢先。 */
  ok(out.percept.uncertain.some((t) => /服务端下发的镜像/.test(t)), '不确定清单里点名「本地方块世界是服务端下发的镜像」')
  ok(out.percept.uncertain.some((t) => /重建/.test(t)), '不确定清单里说明图是按方块数据重建的')

  // 静态：别调裸 `bot.entities(...)`（那是映射对象）、射线要喂真 Vec3
  const viewSrc = readFileSync(new URL('../extensions/mc_observe.mjs', import.meta.url), 'utf8')
  // 只看**代码**，注释里留着"为什么不能这么写"的说明（那是要留的）
  const viewCode = viewSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  ok(/sess\.bot\.entities\(distance/.test(viewSrc), '源码里走的是 `sess.bot.entities(distance, …)`')
  ok(!/[^.]bot\.entities\(/.test(viewCode), '源码里没有裸 `bot.entities(...)`（实机会报 is not a function）')
  ok(/const V = bot\.entity\.position\.constructor/.test(viewCode) && /new V\(origin\[0\]/.test(viewCode),
    '程序射线喂的是真 Vec3（RaycastIterator 要 pos.plus/scaled/floored）')

  // 宿主只有裸 bot（没有 entities()）⇒ 如实说"读不到实体列表"，不假装
  sessions.set('D', { bot: mkBot(true, { noEntities: true }) })
  const outNoProg = await spec.execute({}, { agent: { id: 'D', session: { header: { cwd: wsRoot } } } })
  ok(outNoProg.text.includes('   · 实体：') && /没给 entities\(\)/.test(outNoProg.text),
    '宿主没有 entities() 时如实说"读不到实体列表"',
    outNoProg.text.split('\n').find((l) => l.includes('实体')))

  // 程序射线跑通时：和渲染射线对账（一致就点名）
  world.raycast = async () => ({ name: 'stone', position: { x: 0.5, y: 2, z: -3 } })
  const outRay = await spec.execute({}, exec)
  ok(outRay.percept.sensed.ray && outRay.percept.sensed.ray.block === 'stone',
    '程序射线跑通时记下打到的方块', JSON.stringify(outRay.percept.sensed.ray))
  const rayLine = outRay.text.split('\n').find((l) => l.includes('程序射线')) ?? ''
  ok(/stone/.test(rayLine), 'text 的"程序检测到"段写了程序射线结果', rayLine)
  ok(outRay.text.includes('和渲染一致'), '两套射线一致时点名"和渲染一致"')
  delete world.raycast
  ok(out.image.width === 192 && out.image.height === 108, '默认 192×108', `${out.image.width}x${out.image.height}`)
  ok(out.image.attachment && out.image.attachment.mediaType === 'image/png', '图片附件已生成', JSON.stringify(out.image.attachment))
  ok(savedImages.length >= 1, 'attachments.saveImage 被调用')
  ok(out.crosshair && out.crosshair.block === 'stone', '准星命中北边石墙', JSON.stringify(out.crosshair))
  ok(out.crosshair.distance === 3.5, '命中距离 3.5 格（眼在 z=0.5，墙面 z=-3）', String(out.crosshair.distance))
  ok(out.surroundings.underFeet === 'grass_block' && out.surroundings.feetBlock === 'air', '脚下草地 / 脚内空气', JSON.stringify(out.surroundings))
  /* 用户 2026-10-23：「现在 ai 不知道移动后是什么状态，跳不起来」⇒ 头顶第 2 格 + 净空 + 结论都要给 */
  ok(out.surroundings.jumpBlock === 'air' && out.surroundings.canJump === true && out.surroundings.headroom >= 1,
    '头顶第 2 格 / 净空格数 / 能不能跳都给', JSON.stringify(out.surroundings))
  ok(out.surroundings.aboveNote === undefined, '能跳就不塞 aboveNote（省 token）')
  ok(/头顶第 2 格/.test(out.text) && /能跳（头顶净空/.test(out.text), 'text 里也写了头顶第 2 格与能不能跳',
    out.text.split('\n').find((l) => l.includes('头顶第 2 格')))
  ok(out.image.hitPct + out.image.skyPct + out.image.unloadedPct >= 98 && out.image.hitPct + out.image.skyPct + out.image.unloadedPct <= 102, '三类像素占比合计 ≈100%', `${out.image.hitPct}/${out.image.skyPct}/${out.image.unloadedPct}`)
  ok(out.image.unloadedPct > 0, '未加载区域被算出来', String(out.image.unloadedPct))
  ok(out.image.topBlocks.length > 0, '有 topBlocks', JSON.stringify(out.image.topBlocks))
  ok(typeof out.image.renderMs === 'number' && out.image.renderMs < 5000, 'renderMs 合理', String(out.image.renderMs))
  ok(out.image.file && out.image.file.startsWith('.dsh-mc-agent/.out/mc-observe-'), '默认落 .dsh-mc-agent/.out/', String(out.image.file))
  const file = join(wsRoot, out.image.file)
  ok(existsSync(file), '文件真的写出来了', file)
  const buf = readFileSync(file)
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  ok(buf.length > 100 && sig.every((b, i) => buf[i] === b), '落盘的是真 PNG（签名正确）', buf.slice(0, 8).toString('hex'))
  ok(buf.length === out.image.bytes, 'bytes 与实际文件一致', `${buf.length}/${out.image.bytes}`)

  // 实体：自己要被排除，Steve/zombie 要进列表并且真有像素
  ok(Array.isArray(out.entities) && out.entities.length === 2, '收集到 2 个实体（自己不算）', JSON.stringify(out.entities))
  const st = out.entities.find((x) => x.name === 'Steve')
  ok(st && st.shape === 'player' && st.pixels > 0, 'Steve 被画进图里', JSON.stringify(st))
  ok(st && st.screen.xPct < 50, 'Steve 在画面左半边', st && String(st.screen.xPct))
  ok(out.entities.some((x) => x.name === 'zombie' && x.hostile === true), 'zombie 被标成敌对')
  ok(!out.entities.some((x) => x.id === 1), '自己（id=1）不在实体列表里')
  ok(out.text.includes('Steve'), 'text 里写了 Steve 的名字')
  ok(out.crosshairEntity === null, '没瞄准实体时 crosshairEntity 是 null', JSON.stringify(out.crosshairEntity))

  // 瞄准 Steve ⇒ crosshairEntity 命中
  aimAtSteve()
  const outAim = await spec.execute({}, exec)
  ok(outAim.crosshairEntity && outAim.crosshairEntity.name === 'Steve', '瞄准 Steve 时 crosshairEntity = Steve', JSON.stringify(outAim.crosshairEntity))
  ok(outAim.text.includes('准星正对着'), 'text 里点出"准星正对着 Steve"')
  mineflayerBot.entity.yaw = 0
  mineflayerBot.entity.pitch = 0

  // entities:false ⇒ 不收集、不画（感知块里也要如实说"这次没收集"）
  const outNoEnt = await spec.execute({ entities: false }, exec)
  ok(outNoEnt.entities.length === 0, 'entities:false 不收集实体', JSON.stringify(outNoEnt.entities))
  ok(outNoEnt.text.includes('这次没收集实体'), 'entities:false 时"我看到/程序检测到"两段都如实说"没收集实体"')
  ok(outNoEnt.percept.sensed.entities === null && outNoEnt.percept.seen.entities.length === 0,
    'entities:false 时感知块里的实体为空')
  ok(outNoEnt.percept.uncertain.some((t) => /entities:false/.test(t)), '不确定清单里点出"这次没收集实体"')

  // percept:false ⇒ 退回旧的一段式摘要（省 token），且不产出 percept 对象
  const outPlain = await spec.execute({ percept: false }, exec)
  ok(outPlain.percept === undefined, 'percept:false 不产出感知块')
  ok(outPlain.text.includes('👁 第一人称') && outPlain.text.includes('🎯 准星') && outPlain.text.includes('🧱 画面'),
    'percept:false 退回旧摘要（标题/准星/画面三行）', outPlain.text.split('\n')[0])
  ok(outPlain.text.includes('👥') && outPlain.text.includes('Steve'), 'percept:false 时实体仍在 👥 那行')
  const outPlainNoEnt = await spec.execute({ percept: false, entities: false }, exec)
  ok(outPlainNoEnt.text.includes('视野里没有实体'), 'percept:false + entities:false 时 👥 说没有实体')

  // 自定义参数 + 自定义输出路径（发布区）
  const out2 = await spec.execute({ width: 200, height: 100, fov: 40, distance: 20, crosshair: false, out: '.dsh-mc-agent/.express/pic/v.png', verbose: true }, exec)
  ok(out2.image.width === 200 && out2.image.height === 100, '自定义尺寸生效', `${out2.image.width}x${out2.image.height}`)
  ok(out2.image.file === '.dsh-mc-agent/.express/pic/v.png', '自定义输出路径生效', String(out2.image.file))
  ok(existsSync(join(wsRoot, '.dsh-mc-agent/.express/pic/v.png')), '发布区文件写出来了')
  ok(out2.image.hint && out2.image.hint.includes('mc_kit_express'), '给发布区时提示用 mc_kit_express')

  // 越界参数要被夹住
  const out3 = await spec.execute({ width: 99999, height: -5, fov: 999, distance: 99999, verbose: true }, exec)
  ok(out3.image.width === 480 && out3.image.height === 18, '尺寸被夹到 [32,480] / [18,480]', `${out3.image.width}x${out3.image.height}`)
  ok(out3.image.width * out3.image.height < 20000, '夹完不会爆炸')

  // 拿不到工作区时不能崩（用一个全新的会话 id：既没有 session 也没"上次看到的工作区"）
  sessions.set('NOWHERE', { bot: mkBot(true) })
  const out4 = await spec.execute({}, { agent: { id: 'NOWHERE' } })
  ok(out4.text && out4.image.fileError, '拿不到 cwd 时给出 fileError 而不是崩', String(out4.image.fileError))

  // 记忆根覆盖（2026-10-06）：Master 设了 config.memoryDir 之后，默认出图必须跟着记忆根走，
  // 否则 `.out/` 和 express 发布区（`<记忆根>/.express/`）会落在两个地方。
  const memRoot = mkdtempSync(join(tmpdir(), 'mc-observe-mem-'))
  MEM_ROOT = memRoot
  const outMem = await spec.execute({}, exec)
  ok(outMem.image.file && outMem.image.file.startsWith('.dsh-mc-agent/.out/'), '记忆根模式：返回值仍是记忆根相对写法', String(outMem.image.file))
  ok(existsSync(join(memRoot, outMem.image.file.replace(/^\.dsh-mc-agent[\\/]/, ''))), '记忆根模式：图落进 <记忆根>/.out/', String(outMem.image.file))
  const outMem2 = await spec.execute({ out: '.dsh-mc-agent/.express/pic/v2.png' }, exec)
  ok(existsSync(join(memRoot, '.express/pic/v2.png')), '记忆根模式：发布区落进 <记忆根>/.express/')
  MEM_ROOT = null
  rmSync(memRoot, { recursive: true, force: true })
}

console.log('— ⑤ 离线时不崩 —')
{
  const spec = registered.get('mc_observe')
  sessions.set('D', { bot: mkBot(false) })
  let err = null
  try { await spec.execute({}, { agent: { id: 'D' } }) } catch (e) { err = e }
  ok(err && /不在线/.test(err.message), '离线时抛出可读错误', err && err.message)
}

console.log('— ⑥ 皮肤阶段共享 11 秒预算（静态）—')
{
  /* 🔴 2026-10-08 审计（子代理探针 p1/p5）：`timeoutMs` 是**每个 HTTP 请求各自**的超时 ——
   *    mojang 最多 2 次串行 fetch，再皮肤 + 披风各 1 次（`http://` 还要先试一次 https），
   *    单个玩家最坏 4~6 个 timeout。旧注释"上界压到 10 秒就不会顶穿 11 秒"是错的，
   *    而且皮肤阶段**没有任何总预算** ⇒ waitForChunks 用光时间后这里照样再跑 10~20 秒。
   *    现在给整个皮肤阶段套 `withTimeout(…, callLeft() - 800)`，到点退回默认配色。 */
  const src = readFileSync(new URL('../extensions/mc_observe.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(/const skinBudget = Math\.max\(300, Math\.min\(CALL_BUDGET_MS, \(sess\.bot\.callLeft\?\.\(\) \?\? CALL_BUDGET_MS\) - 800\)\)/.test(src),
    '皮肤阶段算了总预算（callLeft() - 800，夹在 300..CALL_BUDGET_MS）')
  ok(/withTimeout\(grab, skinBudget, '抓玩家皮肤'\)/.test(src), '整个皮肤阶段套了 withTimeout')
  ok(/catch \{ got = \[\] \}/.test(src), '抓皮肤超时 ⇒ 退回默认配色（不抛给宿主）')
  ok(/timeoutMs: clamp\(Number\(process\.env\.DSH_MC_AGENT_SKIN_TIMEOUT_MS\) \|\| 3_000, 500, 4_000\)/.test(src),
    '单个请求的超时降到 3 秒（上界 4 秒），不再等于 10 秒')
  ok(!/上界压到 CALL_BUDGET_MS（10 秒）/.test(src), '那句"压到 10 秒就不会顶穿 11 秒"的错误注释已经删掉')
}

/* ─────────── ㊹ 掉落物：垫底 + 聚成一行（用户 2026-10-23「怎么全是item」） ─────────── */
console.log('㊹ 掉落物单列 junk 档：不抢怪的名额，也不逐行刷屏')
{
  const spec = registered.get('mc_observe')
  const junkRows = Array.from({ length: 12 }, (_, i) => ({
    name: 'item', kind: 'junk', junk: true, hostile: false, neutral: false, ranged: false,
    distance: 1 + i * 0.3, position: { x: 0, y: 1, z: 1 }, dy: 0,
  }))
  const zombieRow = {
    name: 'zombie', kind: 'hostile', hostile: true, neutral: false, ranged: false,
    distance: 5, position: { x: 2, y: 1, z: -2 }, dy: 0, health: 20,
  }
  const botJunk = {
    ...mkBot(true),
    entities: (radius = 24, opts = {}) => ({
      me: { x: 0, y: 1, z: 0 }, radius, kind: opts.kind ?? 'all',
      counts: { hostile: 1, neutral: 0, player: 0, other: 0, junk: 12 },
      total: 13,
      list: [zombieRow, ...junkRows],
    }),
  }
  sessions.set('JUNK', { bot: botJunk })
  const out = await spec.execute({}, { agent: { id: 'JUNK', session: { header: { cwd: wsRoot } } } })
  const t = String(out.text ?? '')
  ok(/掉落物 \*\*item\*\*×12/.test(t), '掉落物要聚成一行（掉落物 **item**×12），不是 12 行各占一条', t.slice(t.indexOf('实体'), t.indexOf('实体') + 200))
  ok((t.match(/\*\*item\*\*/g) ?? []).length === 1, '渲染里 item 只出现一次（聚合后）', String((t.match(/\*\*item\*\*/g) ?? []).length))
  ok(/掉落物 12/.test(t), '计数行单独报掉落物个数', t.slice(t.indexOf('格内实体'), t.indexOf('格内实体') + 120))
  ok(t.indexOf('**zombie**') >= 0 && t.indexOf('**zombie**') < t.indexOf('掉落物 **item**'), '怪排在掉落物前面', '')
  sessions.delete('JUNK')
}
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：pass=${pass} fail=${fail}`)
if (!process.argv.includes('--keep')) {
  try { rmSync(wsRoot, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
}
process.exit(fail === 0 ? 0 : 1)
