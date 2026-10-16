# x-boost — 大号给 Owen 做权重 + 社群互关

**运行前必读 [规范与约束.md](./规范与约束.md)，所有约束已在代码强制执行。**

## 文件

| 文件 | 用途 |
|---|---|
| `boost.js` | 主脚本（任务1 + 任务2，含全部风控约束） |
| `insights.js` | Owen 互动研究（纯只读）：扫通知页出"最近谁互动最多"报告（规范 §6.3） |
| `config.json` | 账号/上限/时序/模板（改约束先改规范文档再改这里） |
| `state/` | 每账号去重状态 + 每日计数 + 熔断标记 + 月度日志 |
| `规范与约束.md` | 唯一运行依据 |

## 用法

```bash
# 演练（不点击、不写状态）
node boost.js --account butcher --task all --dry

# 正式（在 09:00-22:00 执行窗内）
node boost.js --account butcher          # butcher 跑两个任务
node boost.js --account fullwin --task 1 # fullwin 只跑任务一
node boost.js --account both             # 两号自动错开 35±5 分钟
```

```bash
# Owen 互动研究（纯只读，规范 §6.3）：扫通知页出"最近谁互动最多"报告
node insights.js                 # 默认 10 屏 / Top 20 / 近 7 天口径
node insights.js --screens 15 --dry   # 更深抓取，演练不写 state
```

## 上线流程（规范第 8 条）

1. DRY 演练通过
2. 第 1-3 天：仅任务一、每日 1 帖（`--max-posts 1`）
3. 第 4 天起：全量
4. 第 7 天复盘调参留档

## 调试脚本（一次性排查用）

`debug-login.js` / `debug-detail.js` / `debug-reply.js` / `debug-reply2.js` — 会打开真实窗口，仅在排查时用。
