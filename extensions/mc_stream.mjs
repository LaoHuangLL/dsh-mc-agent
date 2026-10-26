// -*- coding: utf-8 -*-
/**
 * mc_stream —— 直播用的「AI 视角」小窗 + 状态条 + 字幕（dsh-mc-agent 扩展）
 * ============================================================================
 * 需求（用户 2026-10-26）：
 *   「形态：抖音横屏。我睡觉的时候开播，就让 AI 自己玩……
 *     把 AI 看到的画面和思考过程放出来，也是节目效果。」
 *   「AI 视角小窗要不要？ 要」
 *
 * 主画面是真人客户端旁观（用户自己挂观察者跟随），所以这个扩展**不碰主画面**，
 * 只负责三件直播叠加层要用的东西：
 *   ① `mc_stream {mode:"start"}` 起一个**只听 127.0.0.1** 的小 HTTP 服务；
 *   ② OBS 加一个「浏览器源」指向它 —— 拿到一个**透明背景**的页面：
 *      AI 第一人称小窗（renderView 实时帧）+ 血量/饱食/坐标/在干什么 + 一行大字幕；
 *   ③ `mc_stream {mode:"say"}` 写字幕（AI 的"心里话"/回复），`{mode:"state"}` 改状态条。
 *
 * 为什么是"浏览器源"而不是把画面塞进游戏：
 *   - OBS 的浏览器源**支持透明**，直接盖在真客户端画面上，位置大小随时拖；
 *   - 不用改 MC 客户端、不用装 mod、不用第二块屏；
 *   - `mc_observe` 已经证明 `renderView` 出的 PNG 是对的，这里只是把它按帧率推出去。
 *
 * 性能事实（实测，单核 CPU，含 PNG 编码）：
 *   192×108 ≈ 13ms/帧、320×180 ≈ 34ms/帧、480×270 ≈ 76ms/帧（renderView 是**同步阻塞**的）。
 *   所以默认 **320×180 / 6fps**（约吃掉一个核的 20%）；要更清楚可以调 `width`，
 *   但 480×270 下 10fps 就会吃掉约 3/4 个核，并把物理循环拖慢 —— 直播会看起来"卡卡的"。
 *   🔴 4090 帮不上忙：这是 JS 手写光栅器，纯 CPU。
 *
 * 安全边界（都写在代码里，不靠自觉）：
 *   - 只 bind `127.0.0.1`，不监听 0.0.0.0 —— 页面里没有密钥，但**没有理由让局域网能开它**；
 *   - 只认 GET + 四个固定路径，**不做目录服务**，不接受任意文件路径；
 *   - 字幕/状态一律走 `textContent` 写进 DOM（**不拼 HTML**），观众昵称或 AI 输出里带
 *     `<img onerror=...>` 也只会被当成字面量显示；
 *   - 同一时刻最多一个渲染在跑（浏览器源被复制成 3 份也不会把 CPU 打满）。
 */

export const name = 'mc_stream'

const EYE_HEIGHT = 1.62
const DEFAULTS = {
  port: 16_060,
  width: 320,
  height: 180,
  fps: 6,
  distance: 24,
  playerLabel: '',
}
/** 一帧最多 400ms（480×270 实测 76ms；超过说明世界在狂变/机器在抖） */
const FRAME_BUDGET_MS = 400
/** 思考流缓冲区上限（字）：只留尾巴，模型想多久都不会把内存吃满 */
const THINK_BUF = 8_000
/** 上屏的思考尾巴长度：够看"它在想什么"，又不至于变成朗读全文 */
const THINK_TAIL = 420

/* ── 小工具件 ──────────────────────────────────────────────────────────────── */

const num = (v, dflt, lo, hi) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  const r = Math.round(n)
  return Math.min(hi, Math.max(lo, r))
}

/** 帧率闸门：距上一帧够了才渲染。**导出去给自检用**（纯函数，不碰时间） */
export function frameGate (now, last, minMs) {
  if (!Number.isFinite(last)) return true
  return now - last >= minMs
}

/** 把任意值压成一行纯文本（字幕是**一行**，换行会顶穿版面） */
export function oneLine (v, max = 220) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** 机器人状态 → 状态条用的小对象。**导出去给自检用**（不需要真 bot） */
export function stateOf (bot, extra = {}) {
  const out = {
    online: false,
    name: null,
    hp: null,
    food: null,
    x: null,
    y: null,
    z: null,
    dim: null,
    held: null,
    mode: null,
    players: null,
    task: oneLine(extra.task, 60) || null,
    doing: oneLine(extra.doing, 60) || null,
    subtitle: oneLine(extra.subtitle),
    subtitleAt: Number(extra.subtitleAt) || null,
    /** 思考流（宿主 llm/stream 的 reasoning-delta 尾巴；已过闸） */
    think: typeof extra.think === 'string' && extra.think ? extra.think : null,
    thinkAt: Number(extra.thinkAt) || null,
    ts: Date.now(),
  }
  if (!bot) return out
  try {
    const e = bot.entity
    if (e?.position) {
      out.online = true
      out.x = Math.round(e.position.x * 10) / 10
      out.y = Math.round(e.position.y * 10) / 10
      out.z = Math.round(e.position.z * 10) / 10
    }
  } catch { /* 掉线瞬间访问 entity 会抛 */ }
  try { if (Number.isFinite(bot.health)) out.hp = Math.round(bot.health) } catch { /* 忽略 */ }
  try { if (Number.isFinite(bot.food)) out.food = Math.round(bot.food) } catch { /* 忽略 */ }
  try { out.name = bot.username ?? null } catch { /* 忽略 */ }
  try { out.dim = bot.game?.dimension ?? null } catch { /* 忽略 */ }
  try { out.mode = bot.game?.gameMode ?? null } catch { /* 忽略 */ }
  try { out.held = bot.heldItem?.name ?? null } catch { /* 忽略 */ }
  try { out.players = Object.keys(bot.players ?? {}).length } catch { /* 忽略 */ }
  return out
}

/** 直播叠加层页面（透明底）。**导出去给自检用**：断言它不引外网、不拼内联脚本字符串 */
export function overlayHtml () {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-mc-agent stream</title>
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;
    font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
/* 版面单位一律用 vw/vh：OBS 的浏览器源可能建在 1920×1080，也可能建在 2560×1440
   的画布上（用户这台就是 2560×1440）。写死 px 会让 2K 画布上的字看起来小一半。 */
  #wrap{position:fixed;right:.7vw;bottom:.9vh;width:min(26vw,900px)}
  #view{position:relative;border-radius:.5vw;overflow:hidden;
    border:2px solid rgba(255,255,255,.28);box-shadow:0 .4vw 1.4vw rgba(0,0,0,.55);
    background:rgba(8,10,14,.82)}
  #frame{display:block;width:100%;height:auto;image-rendering:auto}
  #tag{position:absolute;left:.5vw;top:.5vh;font-size:.68vw;letter-spacing:.04em;
    color:#e8f2ff;text-shadow:0 1px 3px rgba(0,0,0,.9);opacity:.92}
  #vitals{display:none}
  #bar{display:flex;gap:.6vw;align-items:center;margin-top:.4vh;padding:.5vh .7vw;
    border-radius:.4vw;background:rgba(8,10,14,.72);color:#dfe9f5;font-size:.88vw;
    white-space:nowrap;overflow:hidden}
  #bar .k{opacity:.55;margin-right:3px}
  #bar .sep{opacity:.25}
  #bar #doing{overflow:hidden;text-overflow:ellipsis;max-width:13vw}
  #sub{position:fixed;left:50%;bottom:7vh;transform:translateX(-50%);
    max-width:76vw;padding:.8vh 1.2vw;border-radius:.5vw;
    background:rgba(6,8,12,.66);color:#fff;font-size:1.75vw;line-height:1.35;
    text-align:center;text-shadow:0 2px 6px rgba(0,0,0,.85);opacity:0;
    transition:opacity .25s ease}
  #sub.on{opacity:1}
  #mode{position:fixed;left:.7vw;bottom:.9vh;padding:.4vh .5vw;border-radius:.35vw;
    background:rgba(210,40,40,.82);color:#fff;font-size:.62vw;letter-spacing:.08em;display:none}
  /* 思考流：左边一栏，像"它的脑子"在滚动 */
  #think{position:fixed;left:.7vw;top:1.6vh;width:min(34vw,1100px);max-height:34vh;
    overflow:hidden;padding:.8vh .9vw 1vh;border-radius:.5vw;
    background:rgba(6,8,12,.52);backdrop-filter:blur(2px);display:none;
    color:#cfe0f2;font-size:1.35vw;line-height:1.5;text-shadow:0 2px 6px rgba(0,0,0,.9);
    -webkit-mask-image:linear-gradient(to bottom,rgba(0,0,0,.1),#000 14%,#000 82%,rgba(0,0,0,.15))}
  #think.on{display:block}
  #think .h{display:block;font-size:.66vw;letter-spacing:.14em;opacity:.72;margin-bottom:.4vh}
  #think .h b{color:#8fd0ff;font-weight:600}
  #think .t{display:block;white-space:pre-wrap;word-break:break-word;
    max-height:calc(34vh - 3vh);overflow:hidden}
  #dot{display:inline-block;width:.36vw;height:.36vw;border-radius:50%;background:#59c26a;
    margin-right:.35vw;vertical-align:.06vw;opacity:.25}
  #dot.live{opacity:1;animation:blink 1s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
</style></head>
<body>
<div id="sub"></div>
<div id="mode">OFFLINE</div>
<div id="think"><span class="h"><i id="dot"></i><b>AI 正在想</b></span><span class="t" id="thinkText"></span></div>
<div id="wrap">
  <div id="view">
    <canvas id="frame" width="320" height="180"></canvas>
    <div id="tag">AI 视角</div>
  </div>
  <div id="bar">
    <span><span class="k">HP</span><b id="hp">-</b></span>
    <span><span class="k">饱食</span><b id="food">-</b></span>
    <span class="sep">|</span>
    <span id="xyz">-</span>
    <span class="sep">|</span>
    <span><span class="k">在做</span><b id="doing">-</b></span>
  </div>
</div>
<script>
(function(){
  var cv=document.getElementById('frame'),cx=cv.getContext('2d');
  var sub=document.getElementById('sub'),mode=document.getElementById('mode');
  var hp=document.getElementById('hp'),food=document.getElementById('food');
  var xyz=document.getElementById('xyz'),doing=document.getElementById('doing');
  var tag=document.getElementById('tag');
  var think=document.getElementById('think'),thinkText=document.getElementById('thinkText');
  var dot=document.getElementById('dot');
  var DRAW_MS=Math.max(80,Math.round(1000/Math.max(1,Number('__FPS__')||6)));
  var subAt=0;

  function draw(){ cx.drawImage.apply(cx,arguments); }

  function grabFrame(){
    fetch('/frame.png?t='+Date.now(),{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('http '+r.status);
      return r.blob();
    }).then(function(b){
      return createImageBitmap(b);
    }).then(function(bmp){
      if(bmp.width!==cv.width||bmp.height!==cv.height){cv.width=bmp.width;cv.height=bmp.height;}
      cx.clearRect(0,0,cv.width,cv.height);
      cx.drawImage(bmp,0,0);
      if(bmp.close) bmp.close();
    }).catch(function(){
      cx.clearRect(0,0,cv.width,cv.height);
      cx.fillStyle='rgba(10,12,16,.9)';cx.fillRect(0,0,cv.width,cv.height);
      cx.fillStyle='#8899aa';cx.font='14px sans-serif';cx.textAlign='center';
      cx.fillText('等待画面…',cv.width/2,cv.height/2);
    }).then(function(){ setTimeout(grabFrame,DRAW_MS); });
  }

  function tick(){
    fetch('/state.json?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
      var on=!!s.online;
      mode.style.display=on?'none':'block';
      hp.textContent=(s.hp==null?'-':s.hp);
      food.textContent=(s.food==null?'-':s.food);
      xyz.textContent=on?(s.x+', '+s.y+', '+s.z):'未进服';
      doing.textContent=s.doing||s.task||'-';
      tag.textContent='AI 视角'+(s.held?(' · 手持 '+s.held):'')+(s.players?(' · '+s.players+' 人在线'):'');
      var txt=s.subtitle||'';
      if(txt&&txt!==sub.textContent){sub.textContent=txt;subAt=Date.now();sub.classList.add('on');}
      if(sub.classList.contains('on')&&subAt&&Date.now()-subAt>12000){sub.classList.remove('on');}
      // 思考流：有新内容就贴到最下面（观众看到的是"正在长的末尾"）
      var th=s.think||'';
      if(th){
        if(th!==thinkText.textContent){
          var atBottom=(think.scrollHeight-think.scrollTop-think.clientHeight)<24;
          thinkText.textContent=th;
          think.classList.add('on');
          if(atBottom){think.scrollTop=think.scrollHeight;}
        }
        var live=!!s.thinkAt&&(Date.now()-s.thinkAt<3500);
        if(live) dot.classList.add('live'); else dot.classList.remove('live');
      }else{
        think.classList.remove('on');dot.classList.remove('live');
      }
    }).catch(function(){ mode.style.display='block'; })
      .then(function(){ setTimeout(tick,500); });
  }
  grabFrame();tick();
})();
</script>
</body></html>`
}

/* ── 扩展主体 ─────────────────────────────────────────────────────────────── */

export async function apply (api) {
  const { ctx, asTool, workspaceOf, memoryFor, logLine } = api

  const { createServer } = await import('node:http')
  const { resolve } = await import('node:path')
  const { filterText, mergeRules, DEFAULT_RULES } = await import('./mc_text-filter.mjs')
  const { framePng } = await import('./mc_stream-render.mjs')

  /** 起来之后的运行态（module 内单例：一个会话一套；多会话时用 first-online 兜底） */
  const rt = {
    srv: null,
    port: null,
    lastSession: null,
    extra: { task: null, doing: null, subtitle: null, subtitleAt: null },
    lastFrameAt: 0,
    cached: null,
    rendering: false,
    /** 思考流：宿主 `llm/stream` 的 reasoning-delta 攒在这里（只留尾巴，不落盘） */
    think: { buf: '', at: 0, deltas: 0, calls: 0 },
    stats: { requests: 0, frames: 0, errors: 0, startedAt: null },
  }

  const wsFor = (agent) => { try { return workspaceOf(agent) ?? null } catch { return null } }
  const rootFor = (agent) => {
    const ws = wsFor(agent)
    if (!ws) return null
    try { return memoryFor?.(ws)?.root ?? ws } catch { return ws }
  }

  /** 出口闸的规则：`<记忆根>/filter.json`，按 mtime 缓存（改完下次调用即生效） */
  const { readFileSync, statSync } = await import('node:fs')
  let rulesCache = { file: null, mtime: -1, rules: mergeRules() }
  const rulesFor = (agent) => {
    const root = rootFor(agent)
    if (!root) return rulesCache.rules
    const file = resolve(root, 'filter.json')
    let mtime = -1
    try { mtime = statSync(file).mtimeMs } catch { /* 没有这个文件就用默认规则 */ }
    if (rulesCache.file === file && rulesCache.mtime === mtime) return rulesCache.rules
    let raw = null
    if (mtime >= 0) { try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { raw = null } }
    rulesCache = { file, mtime, rules: mergeRules(DEFAULT_RULES, raw) }
    return rulesCache.rules
  }
  /** 上屏前的唯一出口：一行 + 过闸 */
  const screenText = (v, agent, max) => {
    const one = oneLine(v, max ?? (v == null ? 220 : Math.max(220, String(v).length)))
    if (!one) return one
    return filterText(one, rulesFor(agent)).text
  }

  /** 当前该推哪个机器人：优先本次调用过的会话，其次第一个在线的 */
  const pickSession = () => {
    const s = rt.lastSession
    try { if (s?.bot?.entity) return s } catch { /* 掉线 */ }
    try {
      const list = api.registry?.listSessions?.() ?? []
      for (const it of list) {
        try { if (it?.bot?.entity) return it } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
    return rt.lastSession ?? null
  }

  /** 拉一帧 PNG（带闸门、带"同时只渲染一个"的保护）。`null` = 现在没画面 */
  const grabFrame = async () => {
    const now = Date.now()
    if (rt.rendering) return rt.cached
    if (!frameGate(now, rt.lastFrameAt, Math.round(1000 / DEFAULTS.fps))) return rt.cached
    rt.rendering = true
    try {
      const sess = pickSession()
      const f = await framePng({ bot: sess?.bot ?? null, width: rt.extra.width ?? DEFAULTS.width })
      if (!f) return rt.cached
      rt.cached = { png: f.png, width: f.width, height: f.height, at: now }
      rt.lastFrameAt = now
      rt.stats.frames++
      return rt.cached
    } catch {
      rt.stats.errors++
      return rt.cached
    } finally {
      rt.rendering = false
    }
  }

  /** 思考流的尾巴（上屏前过闸；只取最后 THINK_TAIL 个字，图省事也别把上下文搬上屏） */
  const thinkText = () => {
    const buf = rt.think.buf
    if (!buf) return null
    const tail = buf.length > THINK_TAIL ? buf.slice(-THINK_TAIL) : buf
    return filterText(tail, rulesCache.rules).text || null
  }

  const stateJson = () => {
    const sess = pickSession()
    return stateOf(sess?.bot ?? null, { ...rt.extra, think: thinkText(), thinkAt: rt.think.at })
  }

  const html = () => overlayHtml().replace('__FPS__', String(DEFAULTS.fps))

  const routes = async (req, url) => {
    if (req.method !== 'GET') return null
    const path = (url.pathname || '/').replace(/\/+$/, '') || '/'
    if (path === '/' || path === '/overlay' || path === '/index.html') return { type: 'html', body: html() }
    if (path === '/frame.png') {
      const f = await grabFrame()
      if (!f) return { type: 'png', body: null }
      return { type: 'png', body: f.png }
    }
    if (path === '/state.json') return { type: 'json', body: JSON.stringify(stateJson()) }
    if (path === '/think') return { type: 'text', body: thinkText() || '' }
    if (path === '/health') {
      return {
        type: 'json',
        body: JSON.stringify({
          ok: true,
          online: !!pickSession()?.bot?.entity,
          think: { deltas: rt.think.deltas, calls: rt.think.calls, textDeltas: rt.think.textDeltas ?? 0, at: rt.think.at, chars: rt.think.buf.length },
          ...rt.stats,
        }),
      }
    }
    return null
  }

  const start = async (port) => {
    if (rt.srv) return { ok: true, already: true, port: rt.port, url: `http://127.0.0.1:${rt.port}/` }
    const p = num(port, DEFAULTS.port, 1_024, 65_535)
    const srv = createServer((req, res) => {
      rt.stats.requests++
      void (async () => {
        let out = null
        try { out = await routes(req, new URL(req.url || '/', `http://127.0.0.1:${p}`)) } catch (err) {
          rt.stats.errors++
          out = { type: 'json', status: 500, body: JSON.stringify({ ok: false, error: err.message }) }
        }
        if (!out) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        if (out.type === 'png' && !out.body) {
          res.writeHead(204, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        const headers = {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        }
        if (out.type === 'html') headers['content-type'] = 'text/html; charset=utf-8'
        if (out.type === 'json') headers['content-type'] = 'application/json; charset=utf-8'
        if (out.type === 'text') headers['content-type'] = 'text/plain; charset=utf-8'
        if (out.type === 'png') headers['content-type'] = 'image/png'
        res.writeHead(out.status ?? 200, headers)
        res.end(out.body)
      })()
    })
    await new Promise((resolveStart, rejectStart) => {
      srv.once('error', rejectStart)
      srv.listen(p, '127.0.0.1', () => {
        srv.off('error', rejectStart)
        resolveStart()
      })
    })
    rt.srv = srv
    rt.port = p
    rt.stats.startedAt = Date.now()
    logLine?.(`mc_stream 已监听 http://127.0.0.1:${p}/（OBS 浏览器源指向它）`)
    return { ok: true, port: p, url: `http://127.0.0.1:${p}/` }
  }

  const stop = async () => {
    if (!rt.srv) return { ok: true, already: true }
    const srv = rt.srv
    rt.srv = null
    await new Promise((resolveStop) => srv.close(() => resolveStop()))
    return { ok: true }
  }

  /* ── 思考流：挂宿主的 `llm/stream` 瀑布 ──────────────────────────────────────
   * 宿主事件表里 `llm/stream` 是 waterfall：
   *     (options: GenerateOptions, next) => AsyncIterable<StreamChunk>
   * 我们 next() 拿到下游的 chunk 流，**原样转发**，顺手把 `reasoning-delta` 的文本
   * 攒进 `rt.think`。于是观众能看到"它正在想什么"，而这个功能**一个 token 都不额外花**
   * —— 想的内容本来就在流里，只是以前没人接。
   *
   * 三条红线：
   *   ① 叠加层没开就立刻 `return next()`（不套壳、不记账，等于不存在）；
   *   ② chunk **必须原样 yield**（短路/改写会让模型收不到自己的流）；
   *   ③ 只认带 `Minecraft` 标记的请求 —— 同一个 DSH 里别的会话（比如用户自己跟 AI 聊天）
   *      不会把思考过程播到直播间。
   */
  const THINK_MARKER = 'Minecraft'
  const isMcRequest = (options) => {
    const msgs = options?.messages
    if (!Array.isArray(msgs)) return false
    for (const m of msgs.slice(0, 3)) {
      const role = m?.role
      if (role !== 'system' && role !== 'developer') continue
      const content = m?.content
      if (typeof content === 'string') {
        if (content.includes(THINK_MARKER)) return true
        continue
      }
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (typeof part?.text === 'string' && part.text.includes(THINK_MARKER)) return true
      }
    }
    return false
  }
  const pushThought = (text) => {
    if (!text) return
    rt.think.deltas++
    rt.think.at = Date.now()
    const buf = rt.think.buf + text
    rt.think.buf = buf.length > THINK_BUF ? buf.slice(-THINK_BUF) : buf
  }
  try {
    const off = ctx.on('llm/stream', (options, next) => {
      if (!rt.srv) return next()
      if (!isMcRequest(options)) return next()
      rt.think.calls++
      // 新一轮请求开始：把上一轮的尾巴清掉，观众看到的永远是"当前这一轮在想什么"
      rt.think.buf = ''
      rt.think.at = 0
      const inner = next()
      return (async function * tee () {
        let src = inner
        if (src && typeof src.then === 'function') src = await src
        for await (const chunk of src) {
          try {
            if (chunk && typeof chunk.text === 'string') {
              if (chunk.type === 'reasoning-delta') pushThought(chunk.text)
              else if (chunk.type === 'text-delta') rt.think.textDeltas = (rt.think.textDeltas ?? 0) + 1
            }
          } catch { /* 采集失败绝不能影响模型 */ }
          yield chunk
        }
      })()
    })
    if (typeof off === 'function') ctx.effect(() => off)
    logLine?.('mc_stream 已挂上 llm/stream（思考流）')
  } catch { /* 老宿主没有这个事件：思考流自动缺席，其余功能照常 */ }

  /* ── 工具：mc_stream ────────────────────────────────────────────────────── */
  ctx.tools.register(asTool({
    name: 'mc_stream',
    description:
      '直播叠加层（**给 OBS 用的浏览器源**）：左上「AI 正在想」思考流 + AI 第一人称小窗 + 血量/坐标状态条 + 一行大字幕。\n'
      + '`mode:"start"` 起服务并给你一个 `http://127.0.0.1:<port>/` 地址 —— 让用户把它加进 OBS 的「浏览器源」'
      + '（宽高跟 OBS 画布一致，比如 2560×1440 或 1920×1080，透明背景），盖在真实客户端画面上。\n'
      + '**思考流是自动的**：它接的是宿主的 `llm/stream`，模型边想边显示，不额外花 token；'
      + '只显示带 `Minecraft` 标记的那个会话，别的会话不会露到直播间。\n'
      + '`mode:"say"` 写字幕（你说的"心里话"、回复弹幕、计划），观众看到的就是这一行字；'
      + '`mode:"state"` 改状态条上的「长期目标/在干什么」。\n'
      + '字幕、状态条、思考流上屏前都会自动**过闸**（网址/联系方式/长数字/广告词 → 遮成 ＊），'
      + '词表在 `<记忆根>/filter.json` 的 `words`；被遮了几处会在返回值里告诉你。\n'
      + '只在 127.0.0.1 上监听，不对局域网/公网开放；要关就 `mode:"stop"`。',
    parameters: {
      mode: {
        type: 'string',
        description: 'start = 起服务；stop = 关掉；status = 看运行状态；say = 写字幕；state = 改目标/在干什么',
      },
      port: { type: 'number', description: 'start 时的端口（默认 16060）' },
      width: { type: 'number', description: 'AI 视角小窗的渲染宽度（默认 320，上限 480；越大越清晰也越吃 CPU）' },
      text: { type: 'string', description: 'say 的字幕内容（一行；太长会被截到 220 字）' },
      task: { type: 'string', description: 'state 的长期目标（例如"今晚第一颗钻石"）' },
      doing: { type: 'string', description: 'state 的"现在在干什么"（例如"挖到 y=12 了"）' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }],
    },
    timeoutMs: 20_000,
    async execute (args, exec) {
      const mode = String(args?.mode ?? 'status').toLowerCase()
      try { rt.lastSession = api.getSession?.(exec) ?? rt.lastSession } catch { /* 忽略 */ }

      if (mode === 'start') {
        if (args?.width != null) rt.extra.width = num(args.width, DEFAULTS.width, 64, 480)
        const r = await start(args?.port)
        return {
          text: `直播叠加层已开：${r.url}\n`
            + '在 OBS 里加「浏览器源」指向它（宽高跟 OBS 画布一致，勾选"关闭源时关闭页面"以免空转）。\n'
            + '页面是透明底，只画：左上思考流 + 右下 AI 视角小窗 + 底部状态条 + 中间字幕。\n'
            + `AI 视角当前渲染宽度 ${rt.extra.width ?? DEFAULTS.width}px（想更清楚就 mode:"start" width:480，更吃 CPU）。`,
          ...r,
        }
      }
      if (mode === 'stop') {
        const r = await stop()
        return { text: r.already ? '本来就没开。' : '已关掉直播叠加层。', ...r }
      }
      if (mode === 'say') {
        const raw = oneLine(args?.text)
        if (!raw) return { ok: false, text: 'say 要给 `text`（字幕内容）。' }
        // 上屏前过闸：直播没有语音，文字是唯一出口（用户 2026-10-26 的要求）
        const { text: txt, hits } = filterText(raw, rulesFor(exec?.agent))
        rt.extra.subtitle = txt
        rt.extra.subtitleAt = Date.now()
        return {
          ok: true,
          text: hits.length
            ? `字幕：${txt}\n（过闸遮掉了 ${hits.length} 处：${hits.map((h) => h.kind).join('/')}）`
            : `字幕：${txt}`,
          subtitle: txt,
          filtered: hits,
        }
      }
      if (mode === 'state') {
        if (args?.task != null) rt.extra.task = screenText(args.task, exec?.agent, 60) || null
        if (args?.doing != null) rt.extra.doing = screenText(args.doing, exec?.agent, 60) || null
        return { ok: true, text: '状态条已更新。', state: stateJson() }
      }
      // status
      return {
        ok: true,
        text: rt.srv
          ? `在跑：http://127.0.0.1:${rt.port}/   帧 ${rt.stats.frames} · 请求 ${rt.stats.requests}`
            + ` · 错误 ${rt.stats.errors}`
          : '没开。要开就 `mode:"start"`。',
        running: !!rt.srv,
        url: rt.srv ? `http://127.0.0.1:${rt.port}/` : null,
        stats: { ...rt.stats },
        state: stateJson(),
      }
    },
  }))

  /** 宿主卸载时把端口让出来（否则下次 start 会 EADDRINUSE） */
  try {
    ctx.effect(() => () => { void stop() }, 'dsh-mc-agent: mc_stream')
  } catch { /* 老宿主没有 effect 就算了 */ }
}
