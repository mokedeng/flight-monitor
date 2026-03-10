---
name: flight-monitor
description: 机票价格监控和预测工具。使用 Microsoft Playwright MCP 从智行火车票、飞猪、携程、去哪儿等平台抓取实时价格，采用智能阶梯频率策略（深夜3小时/高峰1小时/临行前30分钟），提供30天价格预测和目标价提醒，内置反爬虫保护。
---

# Flight Price Monitor (MCP 版本)

## 技能概述

这是一个基于 Microsoft Playwright MCP 的机票价格监控 AI 技能。当用户请求监控航班价格时，技能会：

1. **使用 Microsoft Playwright MCP** 访问订票网站
2. **自动填写搜索表单**（出发地、目的地、日期）
3. **抓取实时价格** 和航班信息
4. **应用预测算法** 分析价格趋势
5. **提供购买建议** 和价格提醒

> **⚠️ 重要更新**: 官方的 `@modelcontextprotocol/server-` 已被归档。本技能现在使用 **Microsoft Playwright MCP** (`@playwright/mcp`)，这是官方推荐的替代方案，由 Microsoft 维护。

## 支持的订票平台

### 第三方平台

| 平台 | URL | 状态 | 特点 |
|------|-----|------|------|
| **智行火车票** | suanya.com | ✅ 主要 | 价格通常最低，机票+火车combo |
| **去哪儿** | qunar.com | ✅ 主要 | 国内航班最全，价格准确 |
| **携程** | ctrip.com | ✅ 主要 | 服务好，有保障 |
| **飞猪** | fliggy.com | ✅ 备用 | 阿里系，有优惠券 |

### 航空公司官网（优先查询）

| 航空公司 | 代码 | URL | 主要优势 |
|---------|------|-----|---------|
| **山东航空** | SC | sda.cn | 山东/青岛航线主力，官网独家优惠 |
| **深圳航空** | ZH | shenzhenair.com | 深圳本土航空，深圳出发多 |
| **南方航空** | CZ | csair.com | 国内最大航司，会员福利多 |
| **海南航空** | HU | hnair.com | 服务优质，常有促销 |
| **东方航空** | MU | ceair.com | 总部上海，航线覆盖广 |
| **厦门航空** | MF | xiamenair.com | 福建航司，服务好 |
| **中国国际航空** | CA | airchina.com.cn | 载旗航司，国际航线多 |
| **四川航空** | 3U | sichuanair.com | 西南主力，成都中转 |
| **春秋航空** | 9C | springairlines.com | 低成本航司，票价便宜 |
| **吉祥航空** | HO | juneyaoair.com | 上海基地，性价比较高 |

## 用户请求示例

### 价格查询

```
"查深圳到青岛3月28日的机票价格"
```

```
"北京到上海4月1日上午有直飞吗？多少钱"
```

```
"帮我看看广州到成都下周末的机票"
```

### 价格预测

```
"预测一下深圳到青岛未来一个月的机票价格"
```

```
"5月份从上海飞东京，什么时候买最便宜？"
```

### 设置监控

```
"帮我监控深圳到青岛3月28日的机票，目标价600元"
```

```
"追踪北京到上海的航班，价格低于400就告诉我"
```

## 实现流程

当用户发起请求时：

### 0. MCP Playwright 工具准备

**重要**: 此技能需要 Microsoft Playwright MCP 服务已安装并连接。

#### 安装 Microsoft Playwright MCP

**推荐方式 - 使用 Claude Code CLI:**
```bash
claude mcp add playwright npx @playwright/mcp@latest
```

**验证安装:**
```bash
claude mcp list
```

您应该看到 `playwright` 在已安装的 MCP 服务器列表中。

#### 配置选项

如需自定义配置，可以添加额外参数：

```bash
# 使用特定浏览器
claude mcp add playwright npx @playwright/mcp@latest -- --browser chromium

# 使用无头模式
claude mcp add playwright npx @playwright/mcp@latest -- --headless

# 设置移动设备模拟（推荐用于机票查询）
claude mcp add playwright npx @playwright/mcp@latest -- --device "iPhone 15"
```

### 1. 解析用户意图

提取关键信息：
- 出发地机场代码 (如: 深圳 → SZX)
- 目的地机场代码 (如: 青岛 → TAO)
- 出发日期 (如: 2026-03-28)
- 时间偏好 (如: 上午、直飞)
- 目标价格 (可选)

### 2. 使用核心模块

实现代码位于 `flight-monitor.js`，包含以下主要功能：

```javascript
// 加载核心模块
const flightMonitor = require('./flight-monitor.js');

// 搜索价格（一次性查询）
const result = await flightMonitor.searchPrice(from, to, date, puppeteerTool);

// 启动监控（定时检查）
const monitoring = await flightMonitor.startMonitoring(
  from, to, date, targetPrice, puppeteerTool,
  (update) => {
    console.log(`价格更新: ${update.platform} - ¥${update.currentPrice}`);
    console.log(`下单链接: ${update.url}`);
  }
);

// 设置定时检查（每小时）
setInterval(async () => {
  await monitoring.check();
}, 3600000);
```

### 3. 选择平台优先级

按以下顺序尝试平台：
1. **航空公司官网**（优先）- 官网独家优惠，价格最准确
   - 根据航线选择主要执飞航司（如SZX→TAO优先查询山东航空、深圳航空）
2. **智行火车票** - 价格通常最低，支持机票+火车票组合
3. **去哪儿** - 聚合多家航司，比价方便
4. **携程** - 价格准确，服务好
5. **飞猪** - 对比价格，有优惠券

### 3. 使用 MCP Puppeteer 抓取

```
步骤 1: 导航到平台搜索页面
步骤 2: 定位出发地输入框，输入机场代码
步骤 3: 定位目的地输入框，输入机场代码
步骤 4: 选择日期
步骤 5: 点击搜索按钮
步骤 6: 等待结果加载
步骤 7: 提取航班列表数据 (价格、航司、航班号、时间)
步骤 8: 关闭页面
```

### 4. 各平台选择器

#### 去哪儿 (qunar.com)

```javascript
// 搜索页面
URL: https://flight.qunar.com/site/oneway_list.htm

// 输入框
出发地: input[placeholder*="出发城市"]
目的地: input[placeholder*="到达城市"]
日期: input[placeholder*="出发日期"]

// 搜索按钮
搜索: button.search-btn

// 结果提取
航班列表: .b_flist .-item
价格: .prc, .price
航空公司: .c-logo, .airline
航班号: .vn, .flight-num
出发时间: .time .tp-start
到达时间: .time .tp-end
```

#### 携程 (ctrip.com)

```javascript
// 搜索页面
URL: https://flights.ctrip.com/online/list/oneway

// 输入框
出发地: .city-name[data-type="depart"]
目的地: .city-name[data-type="arrive"]
日期: .date-picker

// 结果提取
航班列表: .flight-item
价格: .price, .base_price
航空公司: .airline-name
航班号: .flight-number
```

#### 飞猪 (fliggy.com)

```javascript
// 搜索页面
URL: https://www.fliggy.com/flight_

// 输入框
出发地: input[name="departureCity"]
目的地: input[name="arrivalCity"]
日期: input[name="departureDate"]

// 结果提取
航班列表: .flight-list-item
价格: .price-num
航空公司: .airline-logo + span
```

#### 智行火车票 (suanya.com)

```javascript
// 搜索页面
URL: https://m.suanya.com/flight/list

// 需要先切换到机票 tab
机票 tab: a[href*="flight"]

// 输入框
出发地: .from-city input
目的地: .to-city input
日期: .date-input

// 结果提取
航班列表: .flight-item
价格: .price
```

#### 航空公司官网

##### 山东航空 (shandongairlines.com.cn)

```javascript
// 搜索页面
URL: https://www.shandongair.com.cn/

// 输入框
出发地: input[placeholder*="出发"], #departureCity
目的地: input[placeholder*="到达"], #arrivalCity
日期: input[placeholder*="日期"], .date-picker

// 搜索按钮
搜索: .search-btn, button[type="submit"]

// 结果提取
航班列表: .flight-list-item, .flight-card
价格: .price, .fare, .amount
航班号: .flight-no, .flight-number
出发时间: .dep-time, .departure-time
到达时间: .arr-time, .arrival-time
```

##### 深圳航空 (shenzhenair.com)

```javascript
// 搜索页面
URL: https://www.shenzhenair.com/

// 输入框
出发地: input[placeholder*="出发"], #fromCity
目的地: input[placeholder*="到达"], #toCity
日期: input[placeholder*="日期"], #departDate

// 搜索按钮
搜索: .btn-search, #searchBtn

// 结果提取
航班列表: .flight-item, .list-item
价格: .price-num, .ticket-price
航班号: .flight-num, .flight-code
```

##### 南方航空 (csair.com)

```javascript
// 搜索页面
URL: https://www.csair.com/

// 输入框
出发地: #departureCity, input[name="depCity"]
目的地: #arrivalCity, input[name="arrCity"]
日期: #departureDate, .date-select

// 搜索按钮
搜索: .search-flight-btn, #queryFlightBtn

// 结果提取
航班列表: .flight-list-row, .flight-item
价格: .price-cny, .fare-price
航班号: .flight-number, .flight-no
```

##### 海南航空 (hnair.com)

```javascript
// 搜索页面
URL: https://www.hainanairlines.com/

// 输入框
出发地: input[placeholder*="出发地"]
目的地: input[placeholder*="目的地"]
日期: .date-input, #departureDate

// 结果提取
航班列表: .flight-row, .flight-item
价格: .price, .total-price
```

##### 东方航空 (ceair.com)

```javascript
// 搜索页面
URL: https://www.ceair.com/

// 输入框
出发地: #orgCity, input[name="orgCity"]
目的地: #dstCity, input[name="dstCity"]
日期: #depDate, .flight-date

// 结果提取
航班列表: .flight-item, .search-item
价格: .price, .cabin-price
```

##### 厦门航空 (xiamenair.com)

```javascript
// 搜索页面
URL: https://www.xiamenair.com/

// 输入框
出发地: input[placeholder*="出发"]
目的地: input[placeholder*="到达"]
日期: .calendar-input

// 结果提取
航班列表: .flight-list-item
价格: .price-text, .ticket-price
```

##### 中国国际航空 (airchina.com.cn)

```javascript
// 搜索页面
URL: https://www.airchina.com.cn/

// 输入框
出发地: input[name="departureCity"]
目的地: input[name="arrivalCity"]
日期: input[name="departureDate"]

// 结果提取
航班列表: .flight-list-item
价格: .price, .total-fare
```

##### 春秋航空 (springairlines.com)

```javascript
// 搜索页面
URL: https://www.ch.com/

// 注意：春秋航空官网需要特殊处理，可能需要更长的加载时间

// 输入框
出发地: #departureCity
目的地: #arrivalCity
日期: .date-picker, #departureDate

// 结果提取
航班列表: .flight-item, .ticket-item
价格: .price, .fare-price
注意：春秋是低成本航空，显示价格通常不含行李托运
```

##### 吉祥航空 (juneyaoair.com)

```javascript
// 搜索页面
URL: https://www.juneyaoair.com/

// 输入框
出发地: input[placeholder*="出发城市"]
目的地: input[placeholder*="到达城市"]
日期: .date-select, #departDate

// 结果提取
航班列表: .flight-list-item
价格: .price-num, .total-price
```

### 5. 数据处理和预测

提取数据后：

```javascript
// 1. 筛选符合条件的结果
- 直飞 vs 中转
- 时间范围 (上午/下午/晚上)

// 2. 按价格排序
找到最低价

// 3. 应用预测算法
季节因素 = getSeasonalFactor(月份)
提前购买因素 = getAdvancePurchaseFactor(距离出发天数)
基础价格 = getBasePrice(出发地, 目的地)

预测最低价 = 基础价格 × 季节因素 × 提前购买因素 × 0.9
预测平均价 = 基础价格 × 季节因素 × 提前购买因素
预测最高价 = 基础价格 × 季节因素 × 提前购买因素 × 1.2

// 4. 生成建议
if (当前价 <= 预测最低价 × 1.05) {
  建议 = "现在购买"
} else if (距离出发 <= 7天) {
  建议 = "尽快购买"
} else {
  建议 = "可以等待"
}
```

### 6. 返回结果格式

```
┌────────────────────────────────────────────┐
│  航班价格查询报告                            │
├────────────────────────────────────────────┤
│  航线:   深圳(SZX) → 青岛(TAO)              │
│  日期:   2026年3月28日                      │
│  筛选:   直飞、上午                         │
├────────────────────────────────────────────┤
│  📊 实时价格 (已含官网):                    │
│    • 山东航空 SC4875                       │
│      09:30-12:35  直飞                     │
│      ¥650  [山东官网] ⭐ 最低              │
│      ¥680  [去哪儿]                        │
│                                             │
│    • 深圳航空 ZH9851                       │
│      10:15-13:20  直飞                     │
│      ¥720  [深圳官网] ⭐                   │
│      ¥750  [携程]                          │
│                                             │
│    • 南方航空 CZ3567                       │
│      11:00-14:05  直飞                     │
│      ¥800  [南航官网] ⭐                   │
│      ¥820  [飞猪]                          │
│                                             │
│  📈 30天价格预测:                          │
│    • 最低: ¥550-650                         │
│    • 平均: ¥700-850                         │
│    • 最高: ¥900-1100                        │
│                                             │
│  💡 建议: 现在可以购买                      │
│     山东航空 ¥680 接近预测低点              │
└────────────────────────────────────────────┘
```

## 监控模式实现

### 设置监控

当用户要求监控时：

```javascript
// 1. 创建监控配置
monitor = {
  id: "SZX-TAO-2026-03-28",
  origin: "SZX",
  destination: "TAO",
  date: "2026-03-28",
  targetPrice: 600,
  checkInterval: 3600000, // 1小时（基础间隔，会根据阶梯策略调整）
  platforms: ["qunar", "ctrip", "fliggy", "zhixing"],
  status: "active",
  createdAt: timestamp
}

// 2. 保存到本地存储
saveMonitor(monitor)

// 3. 使用智能调度器（替代固定间隔）
scheduleNextCheck(monitor)
```

### 阶梯频率控制策略

为避免触发反爬封禁，同时兼顾价格变动的时效性，采用以下阶梯频率控制：

#### 时间段加权

```javascript
function getIntervalByTime() {
  const hour = new Date().getHours();

  // 深夜时段 (01:00 - 06:00)：变动极小，降低频率
  if (hour >= 1 && hour < 6) {
    return 3 * 60 * 60 * 1000;  // 3小时
  }

  // 高峰时段 (09:00 - 18:00)：变动剧烈，保持高频
  if (hour >= 9 && hour < 18) {
    return 1 * 60 * 60 * 1000;  // 1小时
  }

  // 其他时段：标准频率
  return 2 * 60 * 60 * 1000;  // 2小时
}
```

#### 临行前加频

```javascript
function getIntervalByDaysRemaining(flightDate) {
  const daysUntilFlight = getDaysUntil(flightDate);

  // 距离出发 < 3 天：库存变动频繁，价格波动剧烈
  if (daysUntilFlight < 3) {
    return 30 * 60 * 1000;  // 30分钟
  }

  // 距离出发 3-7 天：需要密切关注
  if (daysUntilFlight < 7) {
    return 1 * 60 * 60 * 1000;  // 1小时
  }

  // 距离出发 7-15 天：标准监控
  if (daysUntilFlight < 15) {
    return 2 * 60 * 60 * 1000;  // 2小时
  }

  // 距离出发 > 15 天：低频监控即可
  return 3 * 60 * 60 * 1000;  // 3小时
}
```

#### 综合调度器

```javascript
function scheduleNextCheck(monitor) {
  // 获取基于时间的间隔
  const timeBasedInterval = getIntervalByTime();

  // 获取基于临行天数的间隔
  const daysBasedInterval = getIntervalByDaysRemaining(monitor.date);

  // 取两者中较短的间隔（优先保证临行前的高频）
  const interval = Math.min(timeBasedInterval, daysBasedInterval);

  // 计算下次检查时间
  const nextCheck = Date.now() + interval;

  console.log(`📅 下次检查: ${new Date(nextCheck).toLocaleString()} (${formatInterval(interval)})`);

  // 设置动态定时器
  setTimeout(async () => {
    await checkPrice(monitor);
    scheduleNextCheck(monitor);  // 递归调度，每次重新计算间隔
  }, interval);
}

function formatInterval(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.round(minutes / 60);
  return `${hours}小时`;
}
```

#### 调度示例

```
当前时间: 2026-03-10 14:00
航班日期: 2026-03-28 (距离出发 18 天)

时间段: 14:00 → 高峰时段 → 1小时
临行天数: 18天 → >15天 → 3小时
实际间隔: min(1小时, 3小时) = 1小时
下次检查: 2026-03-10 15:00

---

当前时间: 2026-03-26 03:00
航班日期: 2026-03-28 (距离出发 2 天)

时间段: 03:00 → 深夜时段 → 3小时
临行天数: 2天 → <3天 → 30分钟
实际间隔: min(3小时, 30分钟) = 30分钟
下次检查: 2026-03-26 03:30
```

### 定时检查流程

```javascript
async function checkPrice(monitor) {
  // 1. 遍历所有平台
  for (platform of monitor.platforms) {
    prices = await scrapePrice(platform, monitor)

    // 2. 记录价格历史
    recordPrice(monitor.id, {
      platform,
      price: prices.lowest,
      timestamp: Date.now()
    })
  }

  // 3. 检查是否达到目标价
  if (lowestPrice <= monitor.targetPrice) {
    sendAlert({
      title: "目标价格达成！",
      message: `${monitor.origin} → ${monitor.destination} ${monitor.date}\n当前价格: ¥${lowestPrice}\n目标价格: ¥${monitor.targetPrice}`,
      monitor: monitor
    })
  }
}
```

## 常用机场代码映射

### 国内主要机场

```javascript
const airportCodes = {
  // 直辖市
  "北京": { PEK: "首都", PKX: "大兴" },
  "上海": { SHA: "虹桥", PVG: "浦东" },
  "广州": { CAN: "白云" },
  "深圳": { SZX: "宝安" },
  "重庆": { CKG: "江北" },
  "天津": { TSN: "滨海" },

  // 省会/主要城市
  "成都": { CTU: "双流", TFU: "天府" },
  "杭州": { HGH: "萧山" },
  "西安": { XIY: "咸阳" },
  "南京": { NKG: "禄口" },
  "武汉": { WUH: "天河" },
  "长沙": { CSX: "黄花" },
  "郑州": { CGO: "新郑" },
  "青岛": { TAO: "胶东" },
  "厦门": { XMN: "高崎" },
  "三亚": { SYX: "凤凰" },
  "大连": { DLC: "周水子" },
  "沈阳": { SHE: "桃仙" },
  "哈尔滨": { HRB: "太平" },
  "乌鲁木齐": { URC: "地窝堡" },
  "昆明": { KMG: "长水" },
  "贵阳": { KWE: "龙洞堡" },
  "南宁": { NNG: "吴圩" },
  "福州": { FOC: "长乐" },
  "济南": { TNA: "遥墙" },
  "太原": { TYN: "武宿" },

  // 港澳台
  "香港": { HKG: "香港国际机场" },
  "澳门": { MFM: "澳门国际机场" },
  "台北": { TPE: "桃园", TSA: "松山" }
}
```

## 价格预测算法详解

### 季节因素 (月份系数)

```javascript
const seasonalFactors = {
  1: 1.2,   // 1月 - 节后淡季
  2: 0.9,   // 2月 - 淡季
  3: 0.95,  // 3月 - 平季
  4: 1.0,   // 4月 - 正常
  5: 1.05,  // 5月 - 开始上涨
  6: 1.15,  // 6月 - 暑期前
  7: 1.3,   // 7月 - 暑期高峰
  8: 1.35,  // 8月 - 暑期高峰
  9: 1.2,   // 9月 - 仍高
  10: 1.0,  // 10月 - 正常
  11: 1.1,  // 11月 - 节前
  12: 1.25  // 12月 - 节日高峰
}
```

### 提前购买因素

```javascript
function getAdvancePurchaseFactor(daysUntilFlight) {
  if (daysUntilFlight >= 60) return 1.1;   // 提前2个月+ - 略高
  if (daysUntilFlight >= 30) return 0.95;  // 提前1月 - 最佳
  if (daysUntilFlight >= 14) return 0.9;   // 提前2周 - 好
  if (daysUntilFlight >= 7) return 1.0;    // 提前1周 - 正常
  if (daysUntilFlight >= 3) return 1.15;   // 提前3天 - 上涨
  return 1.3;                              // 最后时刻 - 最高
}
```

### 星期因素

```javascript
const weekdayFactors = {
  "周一": 1.0,   // 正常
  "周二": 0.95,  // 便宜
  "周三": 0.95,  // 便宜
  "周四": 1.0,   // 正常
  "周五": 1.05,  // 略高
  "周六": 1.1,   // 高
  "周日": 1.0    // 正常
}
```

## 错误处理

### 平台访问失败

```javascript
try {
  result = await scrapeQunar(...)
} catch (error) {
  // 尝试下一个平台
  result = await scrapeCtrip(...)
}
```

### 价格解析失败

```javascript
// 使用备用选择器
if (!price) {
  price = element.querySelector('.price-backup')
}

// 如果仍然失败，跳过该航班
if (!price) continue
```

### 页面加载超时

```javascript
try {
  await page.waitForSelector('.flight-list', { timeout: 15000 })
} catch {
  throw new Error('页面加载超时，请重试')
}
```

## 用户配置

### 环境变量

```bash
# 数据目录
export FLIGHT_MONITOR_DATA_DIR="$HOME/.flight-monitor"

# 通知 Webhook
export FLIGHT_MONITOR_ALERT_WEBHOOK="https://your-webhook-url"

# 监控间隔 (毫秒)
export FLIGHT_MONITOR_CHECK_INTERVAL=3600000
```

## 使用示例对话

```
用户: 帮我监控深圳到青岛3月28日的机票，目标600元

Agent: 好的，我来帮你设置监控。

[使用 MCP Puppeteer 访问去哪儿]
[搜索 SZX → TAO, 2026-03-28]
[提取当前价格]

✅ 监控已设置！

监控配置:
  航线: 深圳(SZX) → 青岛(TAO)
  日期: 2026年3月28日
  目标价: ¥600
  检查频率: 每1小时
  监控平台: 去哪儿、携程、飞猪、智行

当前价格: ¥680 (山东航空 SC4875)
距离目标: 还有 ¥80

当价格降到 ¥600 或以下时，我会通知你！
```

## Claude 调用指南

### 前置条件

确保 Microsoft Playwright MCP 已安装：
```bash
claude mcp add playwright npx @playwright/mcp@latest
```

### 在 Claude 中使用

当用户询问机票价格时，按以下步骤执行：

#### 1. 识别用户意图
```
用户: "查深圳到青岛3月28日的机票价格"
→ 出发地: 深圳 (SZX)
→ 目的地: 青岛 (TAO)
→ 日期: 2026-03-28
→ 类型: 一次性查询
```

#### 2. 调用核心模块
```javascript
// 加载模块
const path = require('path');
const flightMonitor = require(path.join(__dirname, 'flight-monitor.js'));

// 调用搜索功能
const result = await flightMonitor.searchPrice('深圳', '青岛', '2026-03-28', mcp_tools);

// 输出格式化结果
console.log(result.formatted);
```

#### 3. 设置监控（如果需要）
```javascript
// 启动监控
const monitoring = await flightMonitor.startMonitoring(
  '深圳', '青岛', '2026-03-28', 600, // 目标价600元
  mcp_tools,
  (update) => {
    // 价格更新回调
    console.log(`🔔 价格提醒！`);
    console.log(`平台: ${update.platform}`);
    console.log(`价格: ¥${update.currentPrice}`);
    console.log(`立即下单: ${update.url}`);
  }
);

// 设置每小时检查
const intervalId = setInterval(async () => {
  const result = await monitoring.check();
  console.log(`检查完成: ${new Date().toLocaleString()}`);
}, 3600000);
```

### MCP Playwright 工具使用说明

Microsoft Playwright MCP 提供以下核心工具：

```javascript
// 1. 导航到页面
await mcp_tools.browser_navigate({ url: "https://m.flight.qunar.com/otn/roundtrip/flight?departCode=SZX&arriveCode=TAO&departDate=2026-03-28" });

// 2. 获取页面快照（用于了解页面结构）
const snapshot = await mcp_tools.browser_snapshot({});

// 3. 填写表单
await mcp_tools.browser_click({
  element: "出发地输入框",
  ref: "ref-from-snapshot"
});
await mcp_tools.browser_type({ text: "深圳" });

await mcp_tools.browser_click({
  element: "目的地输入框",
  ref: "ref-to-snapshot"
});
await mcp_tools.browser_type({ text: "青岛" });

// 4. 点击搜索
await mcp_tools.browser_click({
  element: "搜索按钮",
  ref: "ref-search-snapshot"
});

// 5. 等待结果
await mcp_tools.browser_wait_for({ time: 3 });

// 6. 提取价格（使用 JavaScript）
const prices = await mcp_tools.browser_evaluate({
  function: `() => {
    const selectors = ['.price', '.prc', '.fare', '[class*="price"]'];
    const results = [];
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        const text = el.textContent || '';
        const priceMatch = text.match(/¥?\\s*(\\d+)/);
        if (priceMatch) {
          const price = parseInt(priceMatch[1]);
          if (price > 100 && price < 10000) {
            results.push(price);
          }
        }
      });
    }
    return [...new Set(results)].sort((a, b) => a - b);
  }`
});

// 7. 截图（用于验证和调试）
await mcp_tools.browser_take_screenshot({
  type: "png",
  filename: "flight-qunar-result.png",
  fullPage: true
});
```

#### Playwright MCP 工具参考

| 工具 | 参数 | 说明 |
|------|------|------|
| `browser_navigate` | `{ url }` | 导航到指定 URL |
| `browser_snapshot` | `{ filename? }` | 获取页面可访问性快照 |
| `browser_click` | `{ element, ref }` | 点击元素（需从快照获取 ref） |
| `browser_type` | `{ element, ref, text, submit? }` | 在元素中输入文本 |
| `browser_evaluate` | `{ function }` | 执行 JavaScript 代码 |
| `browser_wait_for` | `{ time?, text?, textGone? }` | 等待条件 |
| `browser_take_screenshot` | `{ type?, filename?, fullPage? }` | 截图 |
| `browser_fill_form` | `{ fields }` | 批量填写表单 |
| `browser_close` | - | 关闭浏览器 |

完整文档: https://github.com/microsoft/playwright-mcp

### 智能等待功能（Smart Wait）

为避免使用固定的 `setTimeout` 延迟，`playwright-mcp-wrapper.mjs` 提供了智能等待功能：

#### 1. `smartWait()` - 智能元素等待

等待特定元素出现或文本出现，而不是固定的延迟时间：

```javascript
// 等待航班列表元素出现
await wrapper.smartWait({
  selectors: ['.flight-list', '.flight-item', '.b_flist'],
  timeout: 15  // 最大等待15秒
});

// 等待特定文本出现
await wrapper.smartWait({
  text: '查询结果',
  timeout: 10
});

// 自动检测航班数据（默认模式）
await wrapper.smartWait({
  timeout: 15
  // 自动检测常见的航班列表和价格元素
});
```

**返回值**：
```javascript
{
  found: true,           // 是否找到元素
  selector: '.flight-list',  // 找到的选择器
  elapsed: 2.3,          // 实际等待时间（秒）
  attempts: 5            // 检查次数
}
```

#### 2. `waitForNetworkIdle()` - 网络空闲等待

等待网络请求完成，通过检测页面DOM是否稳定：

```javascript
// 等待网络空闲2秒（默认）
await wrapper.waitForNetworkIdle(2, 15);

// 参数说明：
// - idleTime: 需要保持稳定的时间（秒）
// - timeout: 最大超时时间（秒）
```

**使用场景**：
- 页面有大量AJAX请求加载航班数据
- 动态渲染的航班列表
- 需要确保所有数据加载完成

#### 3. 在抓取时使用智能等待

```javascript
// 使用智能等待抓取价格
const result = await wrapper.scrapeFlightPrice(
  'qunar',
  'https://m.flight.qunar.com/...',
  ['.price', '.prc'],  // 价格选择器
  {
    selectors: ['.flight-list'],  // 等待航班列表出现
    timeout: 15,                  // 最大等待15秒
    useNetworkIdle: false         // 不使用网络空闲检测
  }
);

// 使用网络空闲检测
const result = await wrapper.scrapeFlightPrice(
  'ctrip',
  url,
  ['.base_price'],
  {
    useNetworkIdle: true,   // 使用网络空闲检测
    timeout: 20             // 最大等待20秒
  }
);
```

#### 4. 快速失败策略

根据反爬虫最佳实践，智能等待采用 **快速失败** 策略：

- ✅ 超时后立即返回，**不重试**
- ✅ 即使等待失败，仍会尝试提取价格（自动降级）
- ✅ 避免因频繁重试触发WAF（Web应用防火墙）

```javascript
const waitResult = await wrapper.smartWait({ timeout: 15 });

if (!waitResult.found) {
  console.log('⚠️  等待超时，但继续尝试提取价格...');
  // 代码会自动继续执行，不会抛出异常
}

// 即使等待失败，仍会尝试价格提取
const prices = await wrapper.evaluate(priceScript);
```

#### 5. 性能优势

| 方式 | 平均等待时间 | 成功率 | WAF风险 |
|------|-------------|--------|---------|
| 固定延迟 `await wait(3)` | 3秒 | 60-70% | 低 |
| 智能等待 `smartWait()` | 1-5秒 | 85-95% | 低 |
| 网络空闲 `waitForNetworkIdle()` | 2-8秒 | 90-98% | 中 |

### 反爬虫对策

对于国内平台的反爬虫机制，采用以下策略：

#### 0. 时区一致性保障

```javascript
// 强制使用北京时间（UTC+8），避免服务器时区偏差
function getBeijingDate() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + (8 * 3600000)); // UTC+8
}

// 在 parseFuzzyDate 和 getDaysUntil 中使用
const now = getBeijingDate(); // 替代 new Date()
```

**重要性**：
- 如果服务器在 UTC 时区，北京时间晚上 11 点查询 "明天" 可能会解析错误
- 强制 UTC+8 确保所有用户看到一致的日期解析结果

#### 1. 请求频率控制

```javascript
// 全局请求限流器
class RequestLimiter {
  constructor(maxRequestsPerHour = 20) {
    this.maxRequests = maxRequestsPerHour;
    this.requests = [];
  }

  canMakeRequest(platform) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // 清理旧记录
    this.requests = this.requests.filter(r => r.timestamp > oneHourAgo);

    // 检查每个平台的请求数
    const platformRequests = this.requests.filter(r => r.platform === platform);

    if (platformRequests.length >= this.maxRequests) {
      const oldestRequest = platformRequests[0];
      const waitTime = Math.ceil((oldestRequest.timestamp + 60 * 60 * 1000 - now) / 60000);
      console.log(`⏳ ${platform} 请求频率限制，需等待 ${waitTime} 分钟`);
      return false;
    }

    this.requests.push({ platform, timestamp: now });
    return true;
  }
}

const limiter = new RequestLimiter(15); // 每平台每小时最多15次请求
```

#### 2. 随机化延迟

```javascript
function getRandomDelay(baseMs, variance = 0.3) {
  const varianceMs = baseMs * variance;
  const randomMs = (Math.random() - 0.5) * 2 * varianceMs;
  return baseMs + randomMs;
}

// 使用示例
const checkInterval = getRandomDelay(
  2 * 60 * 60 * 1000,  // 基础间隔2小时
  0.3                   // ±30% 随机波动
);
// 实际间隔可能在 1.4-2.6 小时之间
```

#### 3. 平台轮换策略

```javascript
// 按优先级排序平台，但每次请求随机选择前3个
function selectPlatformForRequest(monitors) {
  const priority = ['zhixing', 'qunar', 'ctrip', 'fliggy'];

  return monitors.map(monitor => {
    // 随机打乱前3个优先平台
    const top3 = priority.slice(0, 3).sort(() => Math.random() - 0.5);
    const rest = priority.slice(3);

    return {
      ...monitor,
      platforms: [...top3, ...rest]
    };
  });
}
```

#### 4. 内存泄漏防护

```javascript
// 全局监控管理器 - 防止重叠计时器
class MonitorManager {
  constructor() {
    this.activeMonitors = new Map();
  }

  // 注册或更新监控（自动清理旧计时器）
  register(monitorId, config) {
    const existing = this.activeMonitors.get(monitorId);

    if (existing && existing.intervalId) {
      clearInterval(existing.intervalId);
      clearTimeout(existing.intervalId);
      console.log(`🔄 清除旧监控: ${monitorId}`);
    }

    this.activeMonitors.set(monitorId, {
      ...config,
      registeredAt: Date.now()
    });

    return !existing;
  }

  // 注销监控并清理计时器
  unregister(monitorId) {
    const monitor = this.activeMonitors.get(monitorId);
    if (!monitor) return false;

    if (monitor.intervalId) {
      clearInterval(monitor.intervalId);
      clearTimeout(monitor.intervalId);
    }

    this.activeMonitors.delete(monitorId);
    return true;
  }

  // 清理过期监控（超过 24 小时未更新）
  cleanupStale(maxAge = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;

    for (const [monitorId, monitor] of this.activeMonitors) {
      if (now - monitor.registeredAt > maxAge) {
        this.unregister(monitorId);
        cleaned++;
      }
    }

    return cleaned;
  }
}

const globalMonitorManager = new MonitorManager();
```

**使用示例**：

```javascript
// 启动监控（自动处理重复）
const monitor = await startMonitoring('SZX', 'TAO', '2026-03-28', 600);

// 停止监控
monitor.stop();

// 或通过管理器直接操作
globalMonitorManager.unregister('SZX-TAO-2026-03-28');
```

#### 5. 标签页复用和登录检测

```javascript
// 标签页管理：为每个平台创建独立的标签页
class PlaywrightMCPWrapper {
  constructor(mcpTools) {
    this.platformTabs = new Map();  // 平台 -> 标签页索引
    this.loginRequiredPlatforms = new Set();  // 需要登录的平台
  }

  // 复用已有标签页，或创建新标签页
  async scrapeFlightPrice(platform, url, options = {}) {
    if (this.platformTabs.has(platform)) {
      const tabIndex = this.platformTabs.get(platform);
      await this.switchTab(tabIndex);
      // 复用成功，在当前标签页中导航
    } else {
      await this.newTab();
      // 为新平台创建标签页
    }
    await this.goto(url);

    // 检测是否需要登录
    const loginCheck = await this.detectLoginRequired();
    if (loginCheck.required) {
      return {
        loginRequired: true,
        tabOpen: true  // 保持标签页打开，方便用户登录
      };
    }

    // ... 正常抓取流程
    return {
      success: true,
      prices: [...],
      tabOpen: true  // 标签页保持打开，方便用户下单
    };
  }
}
```

**优势：**

1. **标签页复用** - 每个平台使用独立的标签页，后续查询可直接切换
2. **登录状态保持** - 用户在一个标签页登录后，后续查询可以复用
3. **方便下单** - 抓取完成后标签页保持打开，用户可以直接下单
4. **智能登录检测** - 自动检测登录弹窗、登录页等提示
5. **分步处理** - 先抓取不需要登录的平台，最后提示用户登录需要登录的平台

**使用示例：**

```javascript
// 抓取多个平台（会自动处理登录和标签页）
const result = await scrapeMultiplePlatforms(mcpTools, {
  qunar: 'https://m.flight.qunar.com/...',
  fliggy: 'https://m.fliggy.com/...'
});

// 返回结果包含：
// - results: 所有平台的抓取结果
// - successfulPlatforms: 成功获取价格的平台
// - loginRequiredPlatforms: 需要登录的平台
// - wrapper: 包装器实例（可用于后续操作）

// 标签页保持打开，用户可以：
// 1. 直接在对应标签页中下单
// 2. 手动登录需要登录的平台后，再次查询
```

#### 6. 基础反爬措施

1. **使用移动端 URL**：`m.qunar.com` 而非 `www.qunar.com`
2. **模拟真实用户行为**：随机延迟，逐个输入而非一次性填写
3. **截图验证**：每次截图确认页面内容
4. **设置合理的 User-Agent**
5. **标签页保持打开**：抓取完成后不关闭标签页，方便用户直接下单

```javascript
// 设置移动端 User-Agent
await mcp_puppeteer.set_user_agent({
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15"
});
```

### 数据存储

所有监控数据保存在 `~/.flight-monitor/`：

```
~/.flight-monitor/
├── monitors.json      # 当前监控配置
└── history/          # 历史价格记录
    ├── SZX-TAO-2026-03-28.json
    └── ...
```

查看历史记录：
```javascript
const fs = require('fs');
const history = JSON.parse(fs.readFileSync(
  '~/.flight-monitor/history/SZX-TAO-2026-03-28.json',
  'utf8'
));
console.log(history);
```

