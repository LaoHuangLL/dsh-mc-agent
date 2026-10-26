# dsh-mc-agent 扩展点

**给其他 Agent 用**：想给麦块模式加能力，不必改 `index.js` —— 往这个目录丢一个 `.mjs` 文件即可。

## 契约

文件导出 `apply(api)`（可选导出 `name` 作为日志标签）：

```js
export const name = 'my-extension'

export async function apply(api) {
  const { ctx, config, asTool, getSession, registry, memory, logLine, Watchdog } = api
  // 注册你的工具
  ctx.tools.register(asTool({
    name: 'mc_my_tool',
    description: '……',
    parameters: { foo: { type: 'string' } },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true },
              render: (a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args, exec) {
      const sess = getSession(exec)      // 当前会话的 McSession（拿 bot）
      return { echo: args.foo, online: sess.bot.online }
    },
  }))
}
```

## api 里有什么

| 字段 | 说明 |
| --- | --- |
| `ctx` | 宿主 Cordis 上下文（`ctx.get('jobs')` / `sessionController` / `logger` …） |
| `config` | 插件的 Config（行为配置；连接参数不在这里） |
| `asTool(spec)` | **必须用它注册**——它负责返回值无损化和注入 `exec.signal` |
| `getSession(exec)` | 按 `exec.agent.id` 路由到当前会话的 `McSession`（含 `bot` / `events` / `watchdog`） |
| `registry` | `McRegistry`：`peek(id)` / `listSessions()` / `destroy(id)` |
| `ensureWatchdog(ctx, sess, agent)` | 拿/建看门狗 |
| `memory` | `MemoryStore`：记忆树增删改查（`list` / `read` / `write` / `append` / `put` / `delete` / `search`），根目录 `.dsh-mc-agent/` |
| `logLine(...)` | 写 `dsh-mc-agent/logs/dsh-mc-agent.log`（插件加载期也能用） |
| `Watchdog` | 看门狗类（要自己造一个时用） |

## 规矩

1. **必须用 `asTool` 注册**，否则返回值里的 mineflayer `Vec3` 类实例会让宿主报
   `value is not lossless JSON`，整条工具直接失败。
2. **任何可能永不 settle 的 await 都要套超时**。宿主没有硬中断能力
   （`tools/index.ts:219` 原话 "cannot hard-kill same-process code"），
   一个卡住的工具会让整轮 turn / 停止按钮 / 插话全部失效。用 `src/core.mjs` 导出的
   `withTimeout` / `raceAbort`。
3. **不要另开会话**（单脑约束）。要通知当前会话就用看门狗或 `sessionController.prompt`。
4. 加完跑 `node dsh-mc-agent/tools/check-core.mjs` + `node dsh-mc-agent/selfcheck.mjs`，
   再按铁律起隔离实例验整树。

## 共用件（`mc_util.mjs`）

`mc_util.mjs` **不是一个扩展**（没有 `apply`，加载器会安静跳过）。它放的是各扩展都要用的最小工具件：
`clamp`、`itemNameOf` / `itemIdOf` / `blockIdOf`（名字 ↔ id）、`countOf`（背包里几个）、`canPlaceInto`、
`vec3Of` / `blockAtXYZ`（**真 Vec3** 才能喂 `bot.blockAt`）、`findPlaceSpot`（找一格能放东西的地方）。

要写新扩展就用它，别再各抄一份：

```js
import { clamp, blockIdOf, countOf, findPlaceSpot } from './mc_util.mjs'
```

依赖方向：`mc_craft` / `mc_chest` / `mc_furnace` / `mc_observe` / `mc_auto` → **`mc_util`** → **`mc_view-render`**。
（`mc_craft.mjs` 仍然把其中几个再导出一次，只是为了不改老的 import 路径。）

直播相关的两个模块：`mc_stream.mjs`（HTTP 叠加层 + `mc_stream` 工具）→ **`mc_stream-render.mjs`**
（取景 + `renderView` + PNG 编码）。`mc_stream-render.mjs` 和 `mc_util.mjs` 一样**没有 `apply`**，
加载器会安静跳过它。

出口闸：`mc_stream` 上屏前走 **`mc_text-filter.mjs`**（网址/联系方式/长数字/广告词 → 遮成 ＊，
词表在 `<记忆根>/filter.json`）。它也没有 `apply`，只被 import。

## 模板

见 `example.mjs.example`（把后缀改成 `.mjs` 就会自动加载）。
