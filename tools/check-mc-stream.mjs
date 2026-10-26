/**
 * mc_stream 扩展的离线自检：加载真实扩展文件、起真的本地 HTTP 服务、用 fetch 打真请求，
 * 覆盖 ① 文件硬约束 ② 纯函数（帧率闸门 / 单行化 / 状态对象） ③ 叠加层页面内容
 * ④ 渲染取景（假 bot） ⑤ 端到端：start → / → /state.json → /frame.png → 404 → say/state → stop。
 *
 * 为什么值得起真服务：这个扩展的绝大部分行为在"HTTP 层"（状态码、Content-Type、204 语义、
 * 只认 GET、只 bind 127.0.0.1），用 mock 测等于没测。它不联网、不碰 MC、不写工作区，
 * 所以可以放心在 CI 里跑。
 *
 * 跑法：node dsh-mc-agent/tools/check-mc-stream.mjs
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const EXT = join(ROOT, 'extensions', 'mc_stream.mjs')
const RENDER = join(ROOT, 'extensions', 'mc_stream-render.mjs')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) } else { fail++; console.log('  FAIL ' + label + (extra ? '  <<< ' + extra : '')) }
}

/* ── ① 文件硬约束 ──────────────────────────────────────────────────────────── */
console.log('\n[文件硬约束]')
for (const [label, file] of [['mc_stream.mjs', EXT], ['mc_stream-render.mjs', RENDER]]) {
  const bytes = readFileSync(file)
  const text = bytes.toString('utf8')
  ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${label} 没有 UTF-8 BOM`)
  ok(!/\r\n/.test(text), `${label} LF 行尾`)
}

const extText = readFileSync(EXT, 'utf8')
ok(/listen\(p, '127\.0\.0\.1'/.test(extText), '只监听 127.0.0.1（不监听 0.0.0.0）')
ok(!/listen\([^)]*0\.0\.0\.0/.test(extText), 'listen() 不绑 0.0.0.0（注释里提到这个词不算）')
ok(!/innerHTML/.test(extText), '不拼 innerHTML（字幕/昵称一律 textContent）')
ok(!/readdirSync|createReadStream/.test(extText), '不做目录遍历/流式读文件（没有目录服务的可能）')
// 唯一的读文件是 `<记忆根>/filter.json`（出口闸的词表），HTTP 侧一个字节都不读
ok(/resolve\(root, 'filter\.json'\)/.test(extText), '只读 filter.json（词表），不读别的文件')
ok(!/readFileSync\([^)]*(?:req|url|pathname|decoded|rel)/.test(extText), 'HTTP 请求里的路径不会被拿去读文件')
const renderText = readFileSync(RENDER, 'utf8')
ok(!/export (async )?function apply/.test(renderText), 'mc_stream-render.mjs 没有 apply（加载器会安静跳过，和 mc_util.mjs 一样）')
ok(/EYE_HEIGHT = 1\.62/.test(renderText), '眼高 1.62（和 mc_observe 同一套口径）')

/* ── ② 纯函数 ──────────────────────────────────────────────────────────────── */
console.log('\n[纯函数]')
const mod = await import(new URL('../extensions/mc_stream.mjs', import.meta.url))
ok(mod.name === 'mc_stream', '导出 name = mc_stream')
ok(typeof mod.apply === 'function', '导出 apply(api)')

ok(mod.oneLine('a\nb\r\nc') === 'a b c', 'oneLine 把换行压成空格（字幕必须是一行）')
const long = 'x'.repeat(400)
ok(mod.oneLine(long).length === 220, 'oneLine 截到 220 字')
ok(mod.oneLine(long).endsWith('…'), '截断带省略号')
ok(mod.oneLine(null) === '', 'oneLine(null) = 空串')

ok(mod.frameGate(1000, NaN, 160) === true, '帧率闸门：第一帧必放行')
ok(mod.frameGate(1100, 1000, 160) === false, '帧率闸门：窗口内不放行')
ok(mod.frameGate(1160, 1000, 160) === true, '帧率闸门：到点放行')

const offline = mod.stateOf(null)
ok(offline.online === false, 'stateOf(null).online = false')
ok(offline.hp === null && offline.x === null, 'stateOf(null) 数值为 null（页面显示 "-"）')

const fakeBot = {
  entity: { position: { x: 12.34, y: 64.5, z: -7.66 } },
  health: 17.4,
  food: 15.6,
  username: 'bot1',
  game: { dimension: 'minecraft:overworld', gameMode: 'survival' },
  heldItem: { name: 'iron_pickaxe' },
  players: { bot1: {}, steve: {} },
}
const st = mod.stateOf(fakeBot, { task: '第一颗钻石', doing: '挖到 y=12 了', subtitle: '我在挖' })
ok(st.online === true, 'stateOf(有实体).online = true')
ok(st.hp === 17 && st.food === 16, '血量/饱食取整')
ok(st.x === 12.3 && st.z === -7.7, '坐标保留一位小数')
ok(st.held === 'iron_pickaxe' && st.players === 2, '手持物与在线人数')
ok(st.task === '第一颗钻石' && st.doing === '挖到 y=12 了', 'task/doing 透传到状态条')
ok(st.subtitle === '我在挖', 'subtitle 透传')

const html = mod.overlayHtml()
ok(html.includes('<canvas') && html.includes('/frame.png'), '叠加层页面：canvas + 取帧路径')
ok(html.includes('/state.json'), '叠加层页面：状态轮询路径')
ok(html.includes('AI 视角'), '叠加层页面：有"AI 视角"角标')
ok(html.includes('OFFLINE'), '叠加层页面：有断线遮罩')
ok(!/https?:\/\//.test(html), '叠加层页面不引任何外网资源（OBS 离线也能跑）')
ok(!/innerHTML/.test(html) && html.includes('textContent'), '页面用 textContent 写文本')
ok(html.includes('background:transparent'), '页面背景透明（OBS 浏览器源要能盖在游戏画面上）')
ok(html.includes('AI 正在想') && html.includes('thinkText'), '页面有「AI 正在想」思考流面板')
ok(/font-size:1\.35vw/.test(html) && !/font-size:1[0-9]px/.test(html), '版面单位用 vw（2K 画布上字不会小一半）')
ok(html.includes('id="dot"') && html.includes('@keyframes blink'), '思考中有一个会闪的绿点')
ok(!/id="think"[^>]*>[^<]*<script/.test(html), '思考面板里没有内联脚本')

/* ── ④ 渲染取景（真模块，假 bot） ──────────────────────────────────────────── */
console.log('\n[渲染取景]')
const rmod = await import(new URL('../extensions/mc_stream-render.mjs', import.meta.url))
ok(rmod.EYE_HEIGHT === 1.62, '导出 EYE_HEIGHT')
const self = { entity: { position: { distanceTo: () => 0 } } }
const near = { position: { distanceTo: () => 5 } }
const far = { position: { distanceTo: () => 999 } }
const ents = rmod.nearEntities({ entity: { position: { distanceTo: () => 0 } }, entities: { a: near, b: far, c: self } }, 24)
ok(ents.length === 1 && ents[0] === near, 'nearEntities：只收半径内的、排除自己')
ok((await rmod.framePng({ bot: null })) === null, 'framePng(没有 bot) = null（调用方回 204）')
ok((await rmod.framePng({ bot: {} })) === null, 'framePng(bot 没有实体) = null')

/* ── ⑤ 出口闸（mc_text-filter） ─────────────────────────────────────────────── */
console.log('\n[出口闸：上屏前过一遍]')
const FILTER = join(ROOT, 'extensions', 'mc_text-filter.mjs')
const filterText0 = readFileSync(FILTER, 'utf8')
ok(!filterText0.includes('\r'), 'mc_text-filter.mjs 是 LF 行尾')
ok(!filterText0.startsWith('\ufeff'), 'mc_text-filter.mjs 没有 BOM')
ok(!/export\s+(async\s+)?function\s+apply/.test(filterText0), 'mc_text-filter.mjs 没有 apply（加载器会跳过它）')
const fmod = await import(new URL('../extensions/mc_text-filter.mjs', import.meta.url))
const F = fmod.filterText
ok(F('今晚挖钻石').text === '今晚挖钻石', '正常中文原样通过')
ok(F('看 https://a.example/x 别去').text.includes('＊') && !F('看 https://a.example/x 别去').text.includes('example'), '网址被遮掉')
ok(F('去 minecraft.wiki 查').text.includes('minecraft.wiki'), 'minecraft.wiki 不算引流（白名单后缀）')
ok(F('点击 bad-site.top/abc').text.includes('＊'), '裸域名被遮掉')
ok(!F('加微信 abc12345 领').text.includes('abc12345'), '"加微信 xxx" 连账号一起遮')
ok(!F('qq：987654321').text.includes('987654321'), 'QQ 号被遮')
ok(!F('打我电话 13800138000').text.includes('13800138000'), '长数字串被遮')
ok(F('坐标 -13.5 64 20.5').text === '坐标 -13.5 64 20.5', '带小数的坐标不会被当成电话')
ok(F('专业代练 上车').text.includes('＊'), '词表命中（默认有"代练"）')
ok(F('第一行\n第二行').text === '第一行 第二行', '换行压成空格（字幕是一行）')
ok(F('x'.repeat(400)).text.length === 200 && F('x'.repeat(400)).text.endsWith('…'), '超长截断到 200 字并加 …')
ok(fmod.filterText('代练', { words: [], mask: '#' }).text === '代练', 'words 传空数组就真的不过滤词表')
ok(fmod.filterText('代练', { mask: '#' }).text.includes('#'), 'mask 可以换字符')
ok(fmod.filterText('https://a.b', { urls: false }).text.includes('https://a.b'), 'urls:false 可以关掉网址过滤')
ok(Array.isArray(F('加微信 abc12345').hits) && F('加微信 abc12345').hits.length > 0, '命中会记在 hits 里（便于回告用户）')
ok(F('').text === '' && F(null).text === '', '空值不炸')
ok(fmod.mergeRules(fmod.DEFAULT_RULES, { words: ['测试词'] }).words.length === 1, 'mergeRules 用用户词表整体替换')
ok(fmod.mergeRules(fmod.DEFAULT_RULES, '不是对象').words.length === fmod.DEFAULT_RULES.words.length, 'mergeRules 遇到脏数据退回默认')

/* ── ⑤ 端到端 ──────────────────────────────────────────────────────────────── */
console.log('\n[端到端：真起服务、真发请求]')
/** 先占一个空闲端口再放掉：避免和别的测试撞端口 */
const freePort = await new Promise((resolvePort, rejectPort) => {
  const s = createServer()
  s.once('error', rejectPort)
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolvePort(p))
  })
})

const tools = new Map()
/** 假宿主：把 `llm/stream` 的监听器捉下来，好在自检里手动喂 chunk */
const streamHandlers = []
let lastSession = null
const api = {
  ctx: {
    tools: { register: (t) => tools.set(t.name, t) },
    effect: () => {},
    get: () => null,
    on: (ev, fn) => {
      if (ev === 'llm/stream') streamHandlers.push(fn)
      return () => {}
    },
  },
  asTool: (spec) => spec,
  workspaceOf: () => join(ROOT, '.tmp-check'),
  memoryFor: () => ({ root: join(ROOT, '.tmp-check') }),
  logLine: () => {},
  registry: { listSessions: () => (lastSession ? [lastSession] : []) },
  getSession: () => lastSession,
}
await mod.apply(api)
ok(tools.has('mc_stream'), '注册了 mc_stream 工具')
const tool = tools.get('mc_stream')
ok(typeof tool.execute === 'function', '工具有 execute')
ok(String(tool.description).includes('OBS'), '工具说明提到 OBS（模型要知道这个地址给谁用）')

const started = await tool.execute({ mode: 'start', port: freePort }, {})
ok(started.ok === true && started.port === freePort, 'start 返回端口')
const base = `http://127.0.0.1:${freePort}`
ok(String(started.text).includes(base), 'start 的文案里带可直接复制的地址')

const r1 = await fetch(base + '/')
const body1 = await r1.text()
ok(r1.status === 200, 'GET / = 200')
ok(String(r1.headers.get('content-type')).includes('text/html'), 'GET / 是 text/html')
ok(body1.includes('<canvas'), 'GET / 回来的就是叠加层页面')
ok(r1.headers.get('cache-control') === 'no-store', '页面不缓存（OBS 重载要拿到新版）')

const r2 = await fetch(base + '/state.json')
const st2 = await r2.json()
ok(r2.status === 200 && st2.online === false, '/state.json 在没进服时是 online:false（不崩）')

const r3 = await fetch(base + '/frame.png')
ok(r3.status === 204, '没进服时 /frame.png = 204（页面保留上一帧，不闪黑）')

const r4 = await fetch(base + '/health')
const h4 = await r4.json()
ok(h4.ok === true && typeof h4.requests === 'number', '/health 报 ok 与统计')

const r5 = await fetch(base + '/../package.json')
ok(r5.status === 404, '不接受路径穿越（没有目录服务）')
const r6 = await fetch(base + '/nope')
ok(r6.status === 404, '未知路径 404')
const r7 = await fetch(base + '/', { method: 'POST' })
ok(r7.status === 404, '非 GET 一律 404')

const said = await tool.execute({ mode: 'say', text: '大家好\n我在挖矿' }, {})
ok(said.ok === true && said.subtitle === '大家好 我在挖矿', 'say 把字幕压成一行')
const st3 = await (await fetch(base + '/state.json')).json()
ok(st3.subtitle === '大家好 我在挖矿', '字幕出现在 /state.json 里（页面据此上屏）')

await tool.execute({ mode: 'state', task: '第一颗钻石', doing: '挖到 y=12 了' }, {})
const st4 = await (await fetch(base + '/state.json')).json()
ok(st4.task === '第一颗钻石' && st4.doing === '挖到 y=12 了', 'state 改的目标/在做的事能在 /state.json 读到')

// 出口闸要真的接在 say/state 上（不是只存在于独立模块里）
const dirty = await tool.execute({ mode: 'say', text: '感谢老板 加微信 abc12345 领福利' }, {})
ok(dirty.subtitle.includes('＊') && !dirty.subtitle.includes('abc12345'), 'say 上屏前真的过闸了（联系方式被遮）')
ok(Array.isArray(dirty.filtered) && dirty.filtered.length > 0, 'say 会回报"遮了几处"')
const stDirty = await (await fetch(base + '/state.json')).json()
ok(stDirty.subtitle === dirty.subtitle, '/state.json 里拿到的是过闸后的文本（不是原文）')
const dirtyTask = await tool.execute({ mode: 'state', task: '去 https://evil.example 拉人', doing: '没事' }, {})
ok(dirtyTask.state.task.includes('＊') && !dirtyTask.state.task.includes('evil'), 'state 的目标也过闸')

const status = await tool.execute({ mode: 'status' }, {})
ok(status.running === true && status.url === base + '/', 'status 报 running 与地址')
ok(status.stats.requests >= 7 && status.stats.frames === 0, 'status 的计数是真的（帧数为 0：没进服）')

/* ── ⑥ 思考流：手动喂 chunk（假宿主捉下来的 llm/stream 监听器） ─────────────── */
console.log('\n[思考流：原样转发 + 只认 MC 请求 + 上屏前过闸]')
ok(streamHandlers.length === 1, '挂上了 llm/stream（恰好一个监听器）')
const feed = async (handler, options, chunks) => {
  const got = []
  const next = () => (async function * () { for (const c of chunks) yield c })()
  for await (const c of handler(options, next)) got.push(c)
  return got
}
const mcOptions = { messages: [{ role: 'system', content: '你在一台真实的 Minecraft 服务器里扮演一名玩家' }] }
const humanOptions = { messages: [{ role: 'system', content: 'You are a coding agent powered by DeepSeek Harness.' }] }

await feed(streamHandlers[0], humanOptions, [{ type: 'reasoning-delta', text: 'SECRET-别的会话' }])
const stLeak = await (await fetch(base + '/state.json')).json()
ok(!String(stLeak.think ?? '').includes('SECRET'), '别的会话的思考不会进直播间（按 Minecraft 标记过滤）')

const chunksIn = [
  { type: 'reasoning-delta', text: '我想去挖钻石，' },
  { type: 'reasoning-delta', text: '先别理 https://evil.example 那些人，' },
  { type: 'reasoning-delta', text: '坐标 -13 64 20' },
  { type: 'text-delta', text: '好' },
  { type: 'finish' },
]
const got = await feed(streamHandlers[0], mcOptions, chunksIn)
ok(got.length === chunksIn.length && got[0] === chunksIn[0] && got[4] === chunksIn[4], 'chunk 原样转发（一个不少、还是原对象）')
const stThink = await (await fetch(base + '/state.json')).json()
ok(String(stThink.think).includes('挖钻石'), '思考进了 /state.json（页面据此上屏）')
ok(String(stThink.think).includes('＊') && !String(stThink.think).includes('evil.example'), '思考上屏前也过闸')
ok(stThink.thinkAt > 0, 'thinkAt 有值（页面据此亮"正在想"）')
const rThink = await fetch(base + '/think')
ok(rThink.status === 200 && String(await rThink.text()).includes('挖钻石'), '/think 回纯文本')
ok(String(rThink.headers.get('content-type') || '').includes('text/plain'), '/think 的 content-type 是 text/plain')

const stopped = await tool.execute({ mode: 'stop' }, {})
ok(stopped.ok === true, 'stop 返回 ok')
let refused = false
try { await fetch(base + '/') } catch { refused = true }
ok(refused, 'stop 之后端口真的关掉了（下次 start 不会 EADDRINUSE）')
const again = await tool.execute({ mode: 'stop' }, {})
ok(again.already === true, '重复 stop 幂等')

// 关掉之后不许再碰 LLM 流：必须原样 next() 交棒（否则等于给整个宿主多套一层壳）
const after = [{ type: 'reasoning-delta', text: 'SHOULD-NOT-APPEAR' }]
const still = await feed(streamHandlers[0], mcOptions, after)
ok(still.length === 1 && still[0] === after[0], '叠加层关着时 llm/stream 原样交棒（不套壳）')

/* ── 汇总 ─────────────────────────────────────────────────────────────────── */
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 条通过，${fail} 条失败`)
process.exit(fail === 0 ? 0 : 1)
