# Binance AI Market Bridge — C版（指定币 + 全市场自动扫描）

这是一个“数据运输层”，不是自动交易机器人：

Binance 公共行情 → 本服务 → AI 可读取的 JSON / 文本报告

## 你最终会得到的链接

- 指定币完整机器数据：
  `/api/market?symbol=BTCUSDT`
- AI 易读文本报告：
  `/api/report?symbol=BTCUSDT`
- 自动扫描全市场：
  `/api/scan`
- AI 总览（最适合直接给 AI）：
  `/api/brief`

部署后把域名加在前面，例如：

`https://你的域名/api/brief`

## 包含的数据

- USDT 永续合约市场扫描（可改为现货）
- 当前价格、买一卖一、点差
- 1m / 3m / 5m / 15m / 1h / 4h K线
- OHLCV 原始数据
- EMA9 / EMA21 / EMA50
- RSI14
- ATR14
- VWAP（会话近似）
- 布林带
- 成交量相对倍数
- 各周期涨跌
- 最近高低点
- 支撑/阻力候选
- 趋势和市场状态的“机器标签”
- 全市场异常波动/成交量/趋势评分
- 1秒轮询的短期价格内存（用于服务器持续运行时的短时变化）

## 重要限制（必须知道）

1. 本服务可以实时请求 Binance，但任何 AI 是否“主动打开你的 URL”取决于该 AI 产品的联网/浏览功能和权限。
2. REST 请求不是交易所逐笔行情流；若需要真正逐笔/毫秒级行情，应让专用客户端使用 Binance WebSocket。这里为 AI 分析提供的是高频快照与持续服务端采样。
3. “买/卖判断”不能保证盈利。这个项目只负责完整、结构化地运输和整理市场信息。

## 本地运行

安装 Node.js 20+ 后：

```bash
npm install
npm start
```

浏览器打开：

`http://localhost:3000`

## Docker

```bash
docker build -t binance-ai-bridge .
docker run -p 3000:3000 binance-ai-bridge
```

## 部署

推荐部署到支持“持续运行 Node 服务”的平台或 VPS。原因：1秒价格历史保存在进程内存中；纯 serverless 会导致这部分历史不连续。

部署后设置（可选）环境变量：

```text
PORT=3000
MARKET=futures
BINANCE_BASE_URL=https://fapi.binance.com
SCAN_TOP=80
SCAN_CONCURRENCY=8
CACHE_MS=2500
PRICE_SAMPLE_MS=1000
```

如果 Binance 某个地区入口不可用，可以把 `BINANCE_BASE_URL` 改成你实际可访问的、对应市场的官方 Binance API 基础地址。

## AI 使用方法

把下面链接发给具备联网能力的 AI：

`https://你的域名/api/brief`

提示词可以写：

“读取这个市场数据链接中的最新内容。把它当作实时快照数据源，先检查时间戳，再分析趋势、波动、成交量、支撑阻力和风险。不要假设旧缓存仍然有效。如果需要分析指定币，再读取 /api/report?symbol=币种。”

## 安全

不需要 Binance API Key。
不要把交易所私钥或账户密钥放进这个项目。
