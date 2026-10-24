/**
 * 一次把所有自检跑完（省得一条条敲）。
 *
 *   cd <profile>/node_modules/dsh-mc-agent
 *   node tools/check-all.mjs            # 全部（含 selfcheck，慢）
 *   node tools/check-all.mjs --fast     # 跳过 selfcheck（只跑各工具套件）
 *   node tools/check-all.mjs --only mc  # 只跑文件名含 "mc" 的套件
 *
 * 每个套件都用**子进程 + stdio inherit** 跑（不做管道抓取：受限沙箱里 Node 的管道
 * 会被 EPERM 挡掉，inherit 不受影响），所以套件自己的输出会原样打在下面，
 * 这里只汇总"退出码 + 耗时"。任何一个非 0 就以非 0 退出。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const args = process.argv.slice(2)
const fast = args.includes('--fast')
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? String(args[onlyIdx + 1] ?? '') : ''

/** 跑的顺序：先核心，再工具，最后会话/日志这类横切的；上游的 check-core 与 selfcheck 放最后。 */
const ORDER = [
  'check-core-dig.mjs', 'check-drops.mjs', 'check-block-rollback.mjs', 'check-core-digtime.mjs', 'check-core-place.mjs', 'check-core-entities.mjs', 'check-core-attack.mjs', 'check-combat-timing.mjs', 'check-core-useitem.mjs', 'check-useitem-eat.mjs', 'check-shoot.mjs', 'check-fish.mjs', 'check-prep.mjs',
  'check-core-swim.mjs', 'check-core-map.mjs', 'check-core-inventory.mjs', 'check-core-equip.mjs', 'check-armor-compare.mjs', 'check-core-evidence.mjs',
  'check-call-budget.mjs', 'check-tool-args.mjs', 'check-token-budget.mjs', 'check-async-util.mjs', 'check-worker-pool.mjs', 'check-mc-pathfinder.mjs',
  'check-danger.mjs',
  'check-action-scheduler.mjs', 'check-perf-monitor.mjs', 'check-move-progress.mjs', 'check-bridge.mjs', 'check-terrain.mjs','check-chunk-model.mjs', 
  'check-water-navigation.mjs', 'check-water-recovery.mjs', 'check-task-epoch.mjs', 'check-msa.mjs', 'check-connection-stale.mjs',
  'check-mc-craft.mjs', 'check-mc-furnace.mjs', 'check-mc-chest.mjs', 'check-mc-trade.mjs', 'check-mc-farm.mjs', 'check-generic-names.mjs', 'check-mc-blueprint.mjs',
  'check-spatial-map.mjs', 'check-look-track.mjs', 'check-mc-observe-host.mjs', 'check-mc-view-render.mjs', 'check-mc-skin.mjs',
  'check-mc-auto.mjs', 'check-mc-deps.mjs', 'check-dep-guard.mjs',
  'check-session-memory.mjs', 'check-update-copy.mjs', 'check-rules-file.mjs', 'check-logging.mjs', 'check-watch-chat.mjs', 'check-chat-log.mjs', 'check-audit-session.mjs',
  'check-module-load.mjs',
  'check-core.mjs',
  'check-standalone-import.mjs',
]

const all = readdirSync(HERE).filter((f) => /^check-.*\.mjs$/.test(f) && f !== 'check-all.mjs')
const ordered = [...ORDER.filter((f) => all.includes(f)), ...all.filter((f) => !ORDER.includes(f)).sort()]
const suites = ordered.filter((f) => (only ? f.includes(only) : true))
if (!fast) suites.push('selfcheck.mjs')

const results = []
for (const f of suites) {
  const label = f.replace(/\.mjs$/, '')
  console.log(`\n\x1b[36m━━ ${label} ${'─'.repeat(Math.max(2, 46 - label.length))}\x1b[0m`)
  const t0 = Date.now()
  // 5 分钟上限：2026-10-08 真发生过一次 —— selfcheck 的 ❌ 记录器把"打印失败清单"也记了一遍，
  // 边遍历边长 ⇒ 死循环，输出涨到 2.7 GB、堆 OOM（exit 134），而且是**边跑边涨**：
  // 没人掐它就会把磁盘写满。超时一律按失败报（spawnSync 会 kill 掉子进程）。
  const r = spawnSync(process.execPath, [f === 'selfcheck.mjs' ? 'selfcheck.mjs' : join('tools', f)], {
    cwd: ROOT, stdio: 'inherit', timeout: 5 * 60_000, killSignal: 'SIGKILL',
  })
  const ms = Date.now() - t0
  const code = r.status ?? (r.error ? 1 : 0)
  results.push({ f: label, code, ms, err: r.error ? String(r.error.message) : '' })
}

const bad = results.filter((r) => r.code !== 0)
console.log(`\n${'═'.repeat(60)}`)
for (const r of results) {
  const mark = r.code === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`  ${mark} ${r.f.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s${r.code === 0 ? '' : `   exit=${r.code} ${r.err}`}`)
}
console.log(`${'═'.repeat(60)}`)
console.log(bad.length === 0
  ? `\x1b[32m全部通过\x1b[0m：${results.length}/${results.length}`
  : `\x1b[31m有失败\x1b[0m：${results.length - bad.length}/${results.length} 通过，失败 ${bad.map((b) => b.f).join(', ')}`)
process.exit(bad.length === 0 ? 0 : 1)
