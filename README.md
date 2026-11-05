# Token 用量看板

侧边栏底部的「用量」按钮 → 一个全屏看板：总量卡片、每日趋势、53 周热力图、逐条请求日志，
以及可编辑的模型价格与节假日日历。

数据全部来自本机的 DSH 会话日志，不联网上报任何东西。

## 形态

- **入口**：侧边栏底部（设置 / 账号那一行）的仪表盘图标 +「Token 用量」。与当前页面无关。
- **顶部四张卡**：
  1. **总请求数** —— 只算成功调用；副行是 `失败 N 次 · 取消 M 次`（悬浮有说明）。
  2. **Token 消耗** —— 输入 + 缓存读 + 输出（等于 provider 上报的 `totalTokens`）。
  3. **缓存命中率** —— `缓存读取 ÷（缓存读取 + 未命中输入）`。
  4. **总成本** —— 按写入时价格冻结，标注「仅供参考」；有未定价模型时会提示数量。
- **趋势**：近 7 / 30 / 90 天，堆叠柱（未命中输入 / 缓存读取 / 输出）+ 请求数折线（右轴）。
- **热力图**：近 53 周，按当天总 token 分 5 档，悬浮显示日期 / token / 请求数。
- **日志表**：时间｜模型｜输入｜输出｜缓存命中｜命中率｜速度｜首字｜成本，50 条一页，可按模型过滤。
  点击表头的 `成本 *` 有口径说明。
- **右上角**：`¥ CNY / $ USD` 切换（只切显示币种，不重算历史）、设置齿轮、关闭。

## 数据从哪来

| 字段 | 来源 |
|---|---|
| 请求时间 | `step/start` 事件时间（请求发起时刻，北京时间） |
| 模型 / provider | `assistant/message.message.source` |
| 输入 / 输出 / 缓存 | 同一条消息的 `usage`（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`） |
| 首字（TTFT） | 首个 token 分片时间 − `step/start` 时间 |
| 解码时长 / 速度 | 流末 token 时间 − 首 token 时间；速度 = 输出 tokens ÷ 解码秒数 |
| 失败 / 取消 | `assistant/attempt` 的 `finish.reason.kind`（`error` / `aborted`；没有 finish 视为中断→取消） |

实时走 `ctx.on("session/event")`（DSH 持久化用的同一条 seam）。历史走
`ctx.sessionQuery.listSessions()` + `readSession()`，每天最多全量回填一次，`(session_id, seq)` 主键幂等。

**fork 去重**：fork / 子会话会把父会话的前缀整段复制进自己的日志。回填时用事件指纹
（`type|time|data`）与父会话比对，跳过重复部分——本机实测不做这件事会多算约 1400 条请求。

## 存储

`~/.dsh/token-usage/usage.db`（Node 24 内置 `node:sqlite`，WAL）。

| 表 | 内容 |
|---|---|
| `usage_requests` | 一行 = 一次成功调用；成本列在写入时算好 |
| `attempt_failures` | 失败 / 取消的尝试（不含 token） |
| `model_pricing` | 模型价格（**日常唯一权威**） |
| `model_aliases` | 模型别名（`deepseek-v4-flash → deepseek-flash` 这类程序判断不了的映射） |
| `calendar_days` | 法定节假日 / 补班日（内置 2025–2026，可覆盖） |
| `settings` | 显示币种、汇率及其来源、日期 |
| `meta` | 一次性标记（价格已播种、回填日期） |

## 成本：写入时冻结

```
请求结算 → 取请求开始时间 → 定峰谷 → 查 model_pricing → 算成本 → 连同 rate_used 一起写库
```

- 之后**改价、改汇率、改峰谷、改日历都不会回头重算历史**。
- 该模型当时没有价格 → `cost = NULL`，显示 `—`，不计入总成本（不会用 0 冒充）。
- 改价只影响改价之后的请求。

## 价格文件 `pricing.json`

**每次启动做一次「只补缺、不改旧」的合并**：文件里数据库还没有的模型会被插入；
已有的价格（包括你在面板里改过的）**永远不会被文件覆盖**。

- 想加新模型：写进文件，重启 DSH 即可。
- 想改价：在面板里改（改文件不会生效，除非先在面板里删掉那条）。
- 想彻底移除某个模型：面板删一次 + 文件里也删掉，否则下次启动会被补回来。

```jsonc
{
  "schemaVersion": 1,
  "usdCnyRate": 7.1,            // 首次安装且汇率接口不可用时的兜底
  "defaults": {                  // 模型条目的默认值
    "currency": "CNY",
    "unit": "per_1m",
    "peakValley": { "enabled": false }
  },
  "models": [
    {
      "provider": "*",           // "*" = 任意 provider；也可写精确值做覆盖
      "model": "deepseek-flash", // 会先归一化（小写 + 去 vendor 前缀）再匹配
      "currency": "CNY",
      "prices": { "input": 2, "cacheRead": 0.04, "cacheWrite": 0, "output": 8 },
      "peakValley": {
        "enabled": true,
        "windows": ["09:00-12:00", "14:00-18:00"],
        "windowsMean": "peak",   // 窗口内是峰时 → 其余时段自动谷时
        "discount": 0.5,          // 谷时 = 峰时 × 0.5
        "weekend": "valley",      // 周末整天谷时
        "holiday": "valley"       // 法定节假日整天谷时
      }
    }
  ]
}
```

- 单价单位固定「每百万 tokens」（`"unit": "per_1k"` 可改成每千）。
- 校验是**严格模式**：未知字段、负价、非法时间窗、缺 `input`/`cacheRead`/`output` 都会让整次导入失败，
  并在日志里指出路径（如 `models[2].prices.cacheRead`）。导入失败不会写半个表。
- 以 `_` 开头的键当注释，JSON 不支持注释就用这个。

**顺序很重要**：先填文件，再装插件。装完再改文件不会自动重导（那时以数据库为准）。

## 模型身份：归一化与别名

价格属于**模型**，不属于 provider。判断两个写法是不是同一个模型，按三层来：

| 层 | 规则 | 例子 |
|---|---|---|
| 大小写 | 统一转小写 | `DeepSeek-Flash` → `deepseek-flash` |
| vendor 前缀 | 去掉第一个 `/` 之前的部分 | `deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash` |
| 别名表 | 前两层处理不了的，你手动映射 | `deepseek-v4-flash → deepseek-flash` |

前两层自动生效，第三层在「设置 → 模型别名」里加，或直接写库。

**故意不自动做的**：`-fast`、`-mini`、`-vision`、`-1017` 这类后缀**不会**被剥掉——
它们是不同价位的模型，自动合并只会把钱算错。同价的话在 `pricing.json` 里各列一条即可。

「未定价模型」按归一化后的名字聚合，一条覆盖所有 provider；`N 个 provider` 是它的原始写法数量。
它只看**当前价格表能不能匹配**，所以给某个模型补上价格后，这条提示会立刻消失（历史行的 `—` 仍然保留，那是写入时就没有价格）。

## 峰谷与法定节假日

- `windows` + `windowsMean` 表达两种习惯：谷时很短（窗口=谷时，`windowsMean: "valley"`）
  或峰时很短（窗口=峰时，`windowsMean: "peak"`，DeepSeek 就是这种）。支持跨零点 `22:00-06:00`。
- `weekend` / `holiday` 决定**整天**归属：`peak` / `valley` / `windows`（按时钟走）。
- **调休补班日**（国务院公告里的 `isOffDay: false`）仍然算周末：DeepSeek 这条规则写的是「周一至周五」，补班周六不在其中，所以整天算谷时。若某个模型的规则是「工作日含补班」，把 `weekend` 设成 `"windows"` 让它按时钟走。
- 节假日数据内置 2025–2026（来源 [holiday-cn](https://github.com/NateScarlet/holiday-cn)，
  抓国务院公告）。设置里可「更新某年」：拉 GitHub raw / jsDelivr，空 `days` 视为**尚未发布**，
  不会当成「没有节假日」。也可以手动补录某天为节假日或补班日。
- 未配置的年份按时钟算，设置页会显示已载入年份，便于发现缺口。

## 汇率

- 每天自动拉一次（`open.er-api.com`，失败退 `api.frankfurter.dev`），当天已更新就跳过。
- 设置里可手填，手填值当天生效（`source=manual`），次日自动更新会覆盖。
- 从未取到过时用 7.1 兜底，并在设置里能看到来源。
- 汇率只影响**之后**写入的记录（`rate_used` 会随行存下来）。

## 已知限制

- **历史成本不随改价变化**：这是刻意的。改价后想重算历史，只能自己备份/删库重来（不建议）。
- **首次安装前已存在的会话**会在同一启动周期内回填；那时还没配价格的模型，成本永远是空。
- **失败 / 取消的调用不计入**请求数、token 与成本；它们只出现在失败计数里。
- **成本仅供参考**：价格是你手填的，汇率来自公开市场中间价（不是央行牌价），四舍五入也在所难免。
- 统计覆盖本机 `~/.dsh/sessions` 下的会话（含子代理会话），跨设备不汇总。

## 结构

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 只 insert 一行 Loader 条目 `id: token-usage` |
| `lib/index.js` | Host：SQLite、事件订阅、历史回填、汇率、HTTP 路由 `POST /__token-usage` |
| `lib/core.js` | 纯逻辑：事件 → 行、峰谷判定、成本、价格文件校验（离线工具复用） |
| `lib/client.js` | 界面：卡片、趋势、热力图、日志、设置抽屉 |
| `lib/client.chart.js` | vendor 的 Chart.js v4 UMD，包内动态 chunk |
| `pricing.json` | 首次安装的价格种子 |
| `calendar.seed.json` | 内置节假日 / 补班日 |
| `tools/check.mjs` | 离线静态自检 |
| `tools/selftest.mjs` | 假 ctx 跑 Host 全链路（临时 HOME，不碰真实数据） |
| `tools/replay.mjs` | 用真实会话日志验证口径 |
| `tools/render-smoke.mjs` | 客户端组件的冒烟渲染 |

## 自检

```bash
node tools/check.mjs          # 语法 / manifest / chunk / 价格 / token 白名单
node tools/selftest.mjs       # Host 全链路：落库、峰谷、成本冻结、HTTP 接口
node tools/replay.mjs         # 真实日志回放（约 12s），对账总量与成本
node tools/render-smoke.mjs   # 客户端渲染冒烟
```

真实页面上还要确认：侧边栏出现「用量」→ 点开面板四张卡有数 → 切币种数字变但历史不变 →
改一个模型价格后新请求按新价、旧行不变 → 设置里能更新节假日。

## 安装

用 `plugin_manager` 的 `install_bundle`，目标指向本目录（不要手写 profile 的 `cordis.patch.yml`）。
装之前确认 `pricing.json` 已经填好。
