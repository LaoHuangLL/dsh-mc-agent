// -*- coding: utf-8 -*-
/**
 * mc_text-filter —— 上屏之前的"出口闸"（dsh-mc-agent 扩展的辅助模块，**没有 apply**）
 * ============================================================================
 * 为什么需要它（用户 2026-10-26 原话）：
 *   "让它骂人、念广告、破坏服务器。AI 做不到，又没有语音，文字整个过滤器就好了。"
 *   —— 这话说得很准：直播里**没有语音**，AI 的所有输出最终都会变成屏幕上的文字
 *   （字幕、状态条、游戏聊天）。所以只要在这一个出口上过一遍过滤器，就够了。
 *
 * 过滤什么（三层，都可关）：
 *   ① 联系方式/引流 —— 网址、QQ/微信、"加群/扫码/私聊我"、长数字串（电话、Q 号）
 *   ② 词表 —— `<记忆根>/filter.json` 的 `words`（默认给了一小撮广告词）
 *   ③ 形状 —— 换行压成空格、连续空白收成一个、超长截断（字幕是一行，会被顶穿版面）
 *
 * 不做什么：
 *   - 不做语义判断、不调模型、不联网 —— 它是几十微秒的字符串处理，每帧都能跑；
 *   - 不"净化"输入。弹幕是**观众写的数据**，读它的时候本来就该当数据（工具说明里写死了）；
 *     这里只负责"我们往外说的话"。
 *
 * 配置：`<记忆根>/filter.json`（可选，没有就用默认值；改完下次调用即生效）
 *   { "words": ["加微信", "代练"],     // 命中的**词**会被遮成 ＊＊（不是整句删掉）
 *     "mask": "＊",
 *     "urls": true, "contacts": true, "digits": true,
 *     "max": 200 }
 */

/** 默认规则。都是**字面量**匹配（中文没有 \b 的概念，正则边界会漏），英文大小写不敏感 */
export const DEFAULT_RULES = {
  words: ['加微信', '加我微信', '扫码', '二维码', '代练', '代打', '刷礼物', '返利', '私聊我', '博彩', '下注'],
  mask: '＊',
  urls: true,
  contacts: true,
  digits: true,
  max: 200,
}

const isAscii = (s) => /^[\x20-\x7e]+$/.test(s)

/** 合并用户规则（数组整体替换、布尔与数字覆盖；非法值忽略） */
export function mergeRules (base = DEFAULT_RULES, raw = null) {
  const out = { ...DEFAULT_RULES, words: [...DEFAULT_RULES.words] }
  if (!raw || typeof raw !== 'object') return out
  if (Array.isArray(raw.words)) out.words = raw.words.map((w) => String(w ?? '').trim()).filter(Boolean)
  if (typeof raw.mask === 'string' && raw.mask) out.mask = raw.mask.slice(0, 1)
  for (const k of ['urls', 'contacts', 'digits']) if (typeof raw[k] === 'boolean') out[k] = raw[k]
  if (Number.isFinite(raw.max) && raw.max > 20) out.max = Math.floor(raw.max)
  return out
}

const MASK_RUN = (mask, len) => mask.repeat(Math.max(1, Math.min(4, len)))

/**
 * 过一遍过滤器。**纯函数**（除了正则没有副作用），导出去给自检用。
 * @returns {{text: string, hits: Array<{kind: string, raw: string}>}}
 */
export function filterText (value, rules = DEFAULT_RULES) {
  const r = rules && typeof rules === 'object' ? { ...DEFAULT_RULES, ...rules } : DEFAULT_RULES
  const mask = typeof r.mask === 'string' && r.mask ? r.mask.slice(0, 1) : '＊'
  const hits = []
  // 先压成一行：字幕/状态条都是单行，换行会顶穿版面
  let s = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

  if (r.urls) {
    // 网址：带协议、以 www. 开头，或 "xxx.com/…" 这种裸域名
    s = s.replace(/\b(?:https?:\/\/|www\.)[^\s，。、）)】"'<>]+/gi, (m) => {
      hits.push({ kind: 'url', raw: m })
      return MASK_RUN(mask, 4)
    })
    s = s.replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|cn|cc|top|xyz|tv|io|me|vip)(?:\/[^\s，。、）)】"'<>]*)?/gi, (m) => {
      // "minecraft.wiki" 这种**不是引流**，放过（白名单后缀）
      if (/\.(?:wiki|gamepedia)$/i.test(m)) return m
      hits.push({ kind: 'url', raw: m })
      return MASK_RUN(mask, 4)
    })
  }

  if (r.contacts) {
    // "加微信 abc123" / "QQ 123456" / "vx:xxx"：连挂着的账号一起遮掉
    s = s.replace(/(?:加|➕|\+)?\s*(?:微信|威信|vx|wx|weixin|wechat|qq|扣扣|企鹅)\s*(?:号)?\s*[：:\s]?\s*[A-Za-z0-9_-]{3,}/gi, (m) => {
      hits.push({ kind: 'contact', raw: m })
      return MASK_RUN(mask, 4)
    })
  }

  if (r.digits) {
    // 长数字串：手机号、QQ 号、群号（3 位以上就遮；MC 坐标里带小数的不会被这条命中）
    s = s.replace(/(?<![\d.])\d{6,}(?![\d.])/g, (m) => {
      hits.push({ kind: 'digits', raw: m })
      return MASK_RUN(mask, 4)
    })
  }

  const words = Array.isArray(r.words) ? r.words : []
  for (const w of words) {
    const word = String(w ?? '').trim()
    if (word.length < 2) continue
    if (!s) break
    if (isAscii(word)) {
      const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      if (re.test(s)) {
        hits.push({ kind: 'word', raw: word })
        s = s.replace(re, MASK_RUN(mask, word.length))
      }
    } else if (s.includes(word)) {
      hits.push({ kind: 'word', raw: word })
      s = s.split(word).join(MASK_RUN(mask, word.length))
    }
  }

  s = s.replace(/\s{2,}/g, ' ').trim()
  const max = Number.isFinite(r.max) && r.max > 20 ? Math.floor(r.max) : 200
  if (s.length > max) s = s.slice(0, max - 1) + '…'
  return { text: s, hits }
}

/** 只要文本的便捷版 */
export function cleanText (value, rules) {
  return filterText(value, rules).text
}
