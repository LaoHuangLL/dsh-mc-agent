/**
 * mc_danmaku 扩展的离线自检：用假 ctx / 假附件服务 / **假截图器** 加载真实扩展文件，跑通
 *   ① 文件层面的硬约束（纯 ASCII、无 BOM、LF）  ② 工具注册形状
 *   ③ 没有区域时的引导（不能崩、要指路）        ④ config 读写与非法值
 *   ⑤ 像素差判定（变了发图 / 没变不发图 / force）⑥ 台账单行化与"防复读"回灌
 *   ⑦ 可选文本源 feedUrl（起一个本地 http 服务，不联网）
 *
 * 为什么要有"假截图器"：真截图要真桌面（CI 上锁屏就废），所以我们把扩展的
 * `DSH_MC_AGENT_CAPTURE_PS1` 指到一个只会写固定 JSON 的桩上 —— 测的是**扩展这一侧**的
 * 全部决策逻辑（像素差、阈值、台账、附件、文案），截图本身在实机上验。
 *
 * 跑法：node dsh-mc-agent/tools/check-mc-danmaku.mjs
 * 非 Windows 上会自动跳过桩相关用例（扩展在非 Windows 上本来就只保留 feedUrl 文本源）。
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PS1 = join(ROOT, 'tools', 'capture-region.ps1')
/** Windows 上不能用裸绝对路径做动态 import（ERR_UNSUPPORTED_ESM_URL_SCHEME），必须 file:// URL */
const EXT_URL = new URL('../extensions/mc_danmaku.mjs', import.meta.url)
const EXT = fileURLToPath(EXT_URL)
const isWin = process.platform === 'win32'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-danmaku-'))
const WS = join(TMP, 'ws')
const MEM_ROOT = join(WS, '.dsh-mc-agent')
mkdirSync(WS, { recursive: true })

/** 假截图器：只认 -Out / -Result，写一个假 PNG + 假结果 JSON。diff 用环境变量调。 */
const STUB = join(TMP, 'stub-capture.ps1')
writeFileSync(STUB, [
  'param([string]$Out,[string]$Result)',
  '$d = 0.5',
  'if ($env:DSH_FAKE_DIFF) { $d = [double]$env:DSH_FAKE_DIFF }',
  '$json = \'{"ok":true,"x":0,"y":0,"w":32,"h":32,"savedW":32,"savedH":32,"prevFound":true,"ms":7,"diff":\' + $d + \'}\'',
  '[System.IO.File]::WriteAllText($Result, $json, (New-Object System.Text.UTF8Encoding($false)))',
  '[System.IO.File]::WriteAllBytes($Out, [byte[]](137,80,78,71,13,10,26,10))',
  'exit 0',
  '',
].join('\r\n'), 'ascii')

process.env.DSH_MC_AGENT_CAPTURE_PS1 = STUB
process.env.DSH_FAKE_DIFF = '0.5'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) } else { fail++; console.log('  FAIL ' + label + (extra ? '  <<< ' + extra : '')) }
}

/* ── ① 文件层面的硬约束 ──────────────────────────────────────────────────── */
console.log('\n[capture-region.ps1 的硬约束]')
const psBytes = readFileSync(PS1)
const psText = psBytes.toString('utf8')
ok(!(psBytes[0] === 0xef && psBytes[1] === 0xbb && psBytes[2] === 0xbf), '没有 UTF-8 BOM（有 BOM 的 .ps1 会被 5.1 当 ANSI 读）')
ok(/^[\x00-\x7F]*$/.test(psText), '纯 ASCII（中文注释在 PS 5.1 里会乱码甚至解析失败）')
ok(!/\r\n/.test(psText), 'LF 行尾（仓库 .gitattributes 的要求，按行匹配的断言才不会红）')
ok(/SetProcessDPIAware/.test(psText), '声明了 DPI 感知（否则高缩放屏上坐标会偏）')
ok(!/Write-Output|Write-Host/.test(psText), '不往 stdout 写东西（结果只走 -Result 文件）')

const extText = readFileSync(EXT, 'utf8')
ok(!/\r\n/.test(extText), 'mc_danmaku.mjs LF 行尾')

/* ── ②③④⑤⑥⑦ 加载扩展并跑工具 ───────────────────────────────────────────── */
const tools = new Map()
let savedImages = 0
const api = {
  ctx: {
    tools: { register: (t) => tools.set(t.name, t) },
    get: (n) => (n === 'attachments'
      ? { saveImage: async ({ data, mediaType, name }) => { savedImages++; return { mediaType, name, bytes: data.length } } }
      : undefined),
  },
  config: {},
  asTool: (s) => s,
  getSession: () => ({ bot: { online: false } }),
  workspaceOf: () => WS,
  memoryFor: () => ({ root: MEM_ROOT }),
  logLine: () => {},
  registry: { peek: () => null, listSessions: () => [] },
  ensureWatchdog: () => {},
  memory: {},
  Watchdog: class {},
}

const mod = await import(EXT_URL.href)
await mod.apply(api)

const exec = { agent: { id: 'chk' } }
const call = (name, args) => {
  const t = tools.get(name)
  if (!t) throw new Error('没有这个工具: ' + name)
  return t.execute(args ?? {}, exec)
}

console.log('\n[工具注册形状]')
ok(tools.size === 2 && tools.has('mc_danmaku') && tools.has('mc_danmaku_log'), '注册了 2 个工具', [...tools.keys()].join(','))
const t1 = tools.get('mc_danmaku')
ok(t1.name.startsWith('mc_'), '工具名以 mc_ 开头（MC 模式才看得到）')
ok(/截图/.test(t1.description) && /观众写的数据/.test(t1.description), '说明里写了"直接截图"+ 观众文本不可信')
ok(typeof t1.output.render === 'function' && t1.parameters.mode, '有 output.render 与 parameters.mode')

console.log('\n[没有区域时]')
let r = await call('mc_danmaku', { mode: 'status' })
ok(/未设置/.test(r.text), 'status 明说区域未设置')
try {
  await call('mc_danmaku', { mode: 'read' })
  ok(false, 'read 缺区域应当抛错')
} catch (e) {
  ok(/screen/.test(e.message) && /config/.test(e.message), 'read 缺区域 → 指路 screen + config')
}

console.log('\n[config]')
r = await call('mc_danmaku', { mode: 'config', region: { x: 10, y: 20, w: 400, h: 600 } })
ok(/已设为/.test(r.text) && existsSync(join(MEM_ROOT, 'danmaku.json')), '写进 <记忆根>/danmaku.json')
r = await call('mc_danmaku', { mode: 'config', region: { x: '10', y: '20', width: '400', height: '600' } })
ok(r.region?.w === 400 && r.region?.h === 600, '字符串 + width/height 别名也认')
r = await call('mc_danmaku', { mode: 'config', region: { x: 0, y: 0, w: 4, h: 4 } })
ok(/不合法/.test(r.text), '太小的矩形被拒（w/h < 8）')

if (isWin) {
  console.log('\n[像素差：首次 / 有变化]')
  process.env.DSH_FAKE_DIFF = '0.5'
  r = await call('mc_danmaku', { mode: 'read' })
  ok(r.changed === true && !!r.image?.attachment && savedImages === 1, '首次采集一定发图（附上附件）')
  ok(existsSync(r.image.file), '截图落盘')
  ok(/有变化/.test(r.text), '文案说"有变化"')

  console.log('\n[像素差：没变化 → 不发图]')
  process.env.DSH_FAKE_DIFF = '0.001'
  r = await call('mc_danmaku', { mode: 'read' })
  ok(r.changed === false && !r.image && savedImages === 1, '低于阈值 → 判"没人说话"，一张图都不发')
  ok(/没有变化/.test(r.text), '文案说"没有变化"')

  console.log('\n[force 绕过]')
  r = await call('mc_danmaku', { mode: 'read', force: true })
  ok(r.changed === true && !!r.image?.attachment, 'force:true 强制发图')

  console.log('\n[阈值可配]')
  const cfgFile = join(MEM_ROOT, 'danmaku.json')
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
  cfg.diffThreshold = 0.6
  writeFileSync(cfgFile, JSON.stringify(cfg))
  process.env.DSH_FAKE_DIFF = '0.5'
  r = await call('mc_danmaku', { mode: 'read' })
  ok(r.changed === false, '阈值 60% > 差异 50% → 判"没变化"（阈值是每次重读的，改完立即生效）')
  cfg.diffThreshold = 0.008
  writeFileSync(cfgFile, JSON.stringify(cfg))
} else {
  console.log('\n[非 Windows：只验报错文案]')
  process.env.DSH_FAKE_DIFF = '0.5'
  try {
    await call('mc_danmaku', { mode: 'read' })
    ok(false, 'read 在非 Windows 上应当抛错')
  } catch (e) {
    ok(/Windows/.test(e.message), '非 Windows → 明说"只在 Windows 上可用"')
  }
}

console.log('\n[台账 / 防复读]')
r = await call('mc_danmaku_log', { user: '小明', said: '主播在挖啥\n好奇', reply: '挖铁' })
ok(r.count === 1, '第一条写入', JSON.stringify(r.ledger))
ok(!/\n/.test(r.ledger[0]), '换行被单行化（台账按 `- ` 行数统计）')
ok(/「主播在挖啥 ⏎ 好奇」/.test(r.ledger[0]), '原话里的换行变成 ⏎')
r = await call('mc_danmaku_log', { said: '你好' })
ok(r.count === 2 && /@（未知名）/.test(r.ledger[1]), '只给 said 也能记（名字缺省）')
try {
  await call('mc_danmaku_log', {})
  ok(false, '空记录应当被拒')
} catch (e) { ok(/至少/.test(e.message), '空记录被拒（不留空行污染台账）') }

if (isWin) {
  process.env.DSH_FAKE_DIFF = '0.5'
  r = await call('mc_danmaku', { mode: 'read', force: true })
  ok(/小明/.test(r.text) && /别重复回|别重复/.test(r.text), '读弹幕时把最近回复一起带上（防复读）')
}

console.log('\n[可选文本源 feedUrl]')
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ items: [{ nickname: '阿强', content: '去挖钻石' }, { text: '纯字符串条' }] }))
})
await new Promise((ok2) => server.listen(0, '127.0.0.1', ok2))
const port = server.address().port
const cfgFile2 = join(MEM_ROOT, 'danmaku.json')
const cfg2 = JSON.parse(readFileSync(cfgFile2, 'utf8'))
cfg2.feedUrl = `http://127.0.0.1:${port}/`
writeFileSync(cfgFile2, JSON.stringify(cfg2))
r = await call('mc_danmaku', { mode: 'read' })
ok(r.source === 'feed' && r.count === 2, 'feedUrl → 吃文本，不截图', JSON.stringify(r.items))
ok(/阿强/.test(r.text) && /去挖钻石/.test(r.text), '各种字段名（nickname/content、纯字符串）都能揉平')
cfg2.feedUrl = `http://127.0.0.1:${port + 1}/`
writeFileSync(cfgFile2, JSON.stringify(cfg2))
try {
  await call('mc_danmaku', { mode: 'read' })
  ok(false, '文本源连不上应当抛错')
} catch (e) {
  ok(/feedUrl|文本源/.test(e.message), '文本源连不上 → 报错里带上配置项名')
}
await new Promise((ok2) => server.close(ok2))

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${'─'.repeat(50)}`)
console.log(fail === 0
  ? `\x1b[32m全部通过\x1b[0m：${pass}/${pass}`
  : `\x1b[31m有失败\x1b[0m：${pass}/${pass + fail} 通过，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
