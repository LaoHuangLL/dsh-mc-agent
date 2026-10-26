# dsh-mc-agent —— 让 DSH 里的 AI 真的去玩 Minecraft

在 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）里给 AI 一副**能动手的身体**：
43 个 `mc_*` 工具，覆盖进服、寻路、挖矿、合成、熔炼、存取箱子、村民交易、睡觉种地、按图盖房、看第一人称画面、读直播弹幕、给直播叠加层上字幕、记账。
它不是在"描述"游戏，是真的在玩。

本仓库是 [whale-craft](https://github.com/yzi1b/whale-craft)（作者 yzi1b）的魔改版，改名 `dsh-mc-agent`。

## 能干什么

- **进服就能玩** —— 离线 / 微软正版 / 第三方皮肤站三种账户；连上就有位置、血量、背包、时间、天气
- **会走路** —— 寻路、挖矿开路、搭桥过沟、水里游、垫脚爬竖井；走不通会自己换策略，不原地打转
- **会干活** —— 挖矿（看工具和耐久）、合成、熔炼、存取箱子、放方块、按范围盖房子
- **看得见** —— 第一人称画面（`mc_observe`）、地形图 / 地板层图 / 竖列图（`mc_map`；竖列图连**头顶**一起报：封着什么、跳不跳得起来）；**方块状态也读得出来**（`mc_scan{name:"wheat"}` 直接给作物 `age/ripe`，不用收一次再猜）
- **打得了架** —— 战斗策略层：评威胁、**开打前先换趁手的家伙**（被围/被远程射也照换，只有"该撤了"不换）、走位、**放风筝**（`kite:true`：只对近战怪，打一下退到验过的安全落脚点）；低血/被围**只给建议不擅自撤**（要撤自己叫 `mc_move`）；打完顺带报"附近还有几只"；**默认按威胁挑目标**（`priority:"nearest"/"weakest"` 可改）、目标没了当场换、副手有盾会举、血掉太快/远程追不上**早收手**
- **自己会动** —— 自主层（默认 `ai-led`）：只**监测 + 叫醒**（受伤 / 溺水 / 窒息 / 苦力怕贴脸 / 任务卡住 / 有人叫你），**不替你吃、捡、穿、跟随、下水**；每次叫醒是一轮可追查的决策，文案只要求"做一个动作、看结果、再决定"。要旧行为就用 `mode:"legacy"`；**苦力怕贴到 4 格先退再叫**，**保命叫醒单独一份配额**（挂机空转烧不掉它）
- **长活儿不卡死** —— 单次调用 ≤11 秒分片返回并带进度；挨打就带着进度退出，不会闷头挖到死
- **不瞎编** —— 报成功要有证据：挖了要回读、打死要有掉血记录、合成要确认进了背包

## 装到自己的 DSH

前提：Node.js >= 22、DSH、一个能进的 Minecraft 服务器。

```bash
pnpm add github:blueziii/dsh-mc-agent
pnpm add mineflayer-pathfinder mineflayer-collectblock mineflayer-tool mineflayer-pvp mineflayer-auto-eat minecrafthawkeye
```

然后把 `"dsh-mc-agent"` 加进 DSH profile 的 `dsh.profile.bundles`，重启 DSH。

- 没装 `mineflayer-pathfinder` 时 `mc_move` 会直接拒绝（`via:"pathfinder-unavailable"`），只剩游泳和原地跳
- 改代码调试时用软链，不要装包：`"dsh-mc-agent": "link:C:/你的路径/dsh-mc-agent"`

## 第一次用

1. DSH 的 **MC 设置 → 账户**：加一个账户（离线填名字 / 正版走设备码 / 皮肤站填服务器和账号密码）
2. 跟它说"连 192.168.1.x:25565"，它自己 `mc_connect`
3. 之后正常聊天就行 —— 它自己看图、自己动手

## 配置

环境变量都有默认值，一般不用动：

| 变量 | 作用 |
| --- | --- |
| `MC_HOST` / `MC_PORT` | 默认服务器 |
| `DSH_MC_AGENT_SCHEDULER` | `observe-only`（默认，只记账）/ `enforce`（撞车时排队，够高就叫停低的） |
| `DSH_MC_AGENT_PERF` | `off` 关掉性能监测（默认开） |
| `DSH_MC_AGENT_WORKERS` | Worker 线程池：**不给 = 关**；数字 = 池子上限（≤4）；`on` = 自动取 |
| `DSH_MC_AGENT_AUTO` | 自主层开关 |
| `MC_LOG_LEVEL` / `MC_LOG_MAX_BYTES` / `MC_LOG_KEEP` | 日志级别 / 单个大小 / 保留份数 |

## 自检（不连服务器也能跑）

```bash
node tools\check-all.mjs          # 43 项，几分钟
node tools\check-all.mjs --fast   # 跳过 selfcheck
```

## 文档

| 文件 | 给谁看 |
| --- | --- |
| [插件说明.md](插件说明.md) | 装好之后怎么玩、每个工具干什么 |
| [开发说明.md](开发说明.md) | 自检期望值、模块表、目录结构、拆分规矩 |
| [踩坑档案.md](踩坑档案.md) | 151 个真 bug 的现象 → 根因 → 修法 |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本改了什么 |
