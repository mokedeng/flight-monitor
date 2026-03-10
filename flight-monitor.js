#!/usr/bin/env node

/**
 * Flight Price Monitor - Microsoft Playwright MCP Implementation
 *
 * 使用 Microsoft Playwright MCP 抓取多个平台的机票价格并比较
 * 支持：去哪儿、携程、飞猪、智行火车票
 *
 * Microsoft Playwright MCP: https://github.com/microsoft/playwright-mcp
 */

const fs = require('fs');
const path = require('path');

// 数据存储目录
const DATA_DIR = process.env.FLIGHT_MONITOR_DATA_DIR || path.join(require('os').homedir(), '.flight-monitor');
const MONITORS_FILE = path.join(DATA_DIR, 'monitors.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

// 确保目录存在
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// 机场代码映射
const AIRPORT_CODES = {
  "北京": { PEK: "首都", PKX: "大兴" },
  "上海": { SHA: "虹桥", PVG: "浦东" },
  "广州": { CAN: "白云" },
  "深圳": { SZX: "宝安" },
  "重庆": { CKG: "江北" },
  "天津": { TSN: "滨海" },
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
  "香港": { HKG: "香港国际机场" },
  "澳门": { MFM: "澳门国际机场" },
  "台北": { TPE: "桃园", TSA: "松山" }
};

// 城市名称到机场代码的转换
function getAirportCode(city) {
  const normalizedCity = city.replace(/市|机场|国际机场/g, '').trim();
  if (AIRPORT_CODES[normalizedCity]) {
    const codes = AIRPORT_CODES[normalizedCity];
    // 返回主要机场代码
    return Object.keys(codes)[0];
  }

  // 直接检查是否是机场代码
  for (const city in AIRPORT_CODES) {
    if (AIRPORT_CODES[city][normalizedCity]) {
      return normalizedCity;
    }
  }

  return null;
}

// 平台配置
const PLATFORMS = {
  qunar: {
    name: "去哪儿",
    url: "https://flight.qunar.com/site/oneway_list.htm",
    searchUrl: (from, to, date) =>
      `https://flight.qunar.com/site/oneway_list.htm?searchDepartureAirport=${from}&searchArrivalAirport=${to}&searchDepartureTime=${date}`,
    mobile: true // 使用移动端以避免反爬虫
  },
  ctrip: {
    name: "携程",
    url: "https://flights.ctrip.com/online/list/oneway",
    mobile: true
  },
  fliggy: {
    name: "飞猪",
    url: "https://www.fliggy.com/",
    mobile: false
  },
  zhixing: {
    name: "智行火车票",
    url: "https://m.suanya.com/flight", // 移动端
    mobile: true
  }
};

/**
 * 使用 Playwright MCP 抓取价格
 * 使用 Microsoft Playwright MCP 服务器的 API
 * 文档: https://github.com/microsoft/playwright-mcp
 *
 * Playwright MCP 工具列表:
 * - browser_navigate: 导航到 URL
 * - browser_snapshot: 获取页面可访问性快照
 * - browser_evaluate: 执行 JavaScript 代码
 * - browser_type: 在元素中输入文本
 * - browser_click: 点击元素
 * - browser_take_screenshot: 截图
 * - browser_wait_for: 等待条件
 */
async function scrapeWithPlaywright(platform, from, to, date, mcpTools) {
  const config = PLATFORMS[platform];
  const results = [];

  try {
    // 构建搜索 URL
    let url = config.searchUrl ? config.searchUrl(from, to, date) : config.url;

    // 使用移动端 URL 以避免反爬虫检测
    if (config.mobile && !url.includes('m.')) {
      url = url.replace('www.', 'm.');
    }

    console.log(`正在访问 ${config.name}: ${url}`);

    // 1. 导航到页面 (使用 browser_navigate)
    await mcpTools.browser_navigate({ url });
    console.log(`  ✓ 已导航到 ${config.name}`);

    // 2. 等待页面加载
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3. 获取页面快照来了解页面结构 (使用 browser_snapshot)
    let snapshot;
    try {
      snapshot = await mcpTools.browser_snapshot({});
    } catch (e) {
      console.log(`  ⚠️  无法获取快照: ${e.message}`);
    }

    // 4. 尝试填写搜索表单（如果页面需要）
    // 这里需要根据每个平台的具体结构调整选择器
    const formSelectors = {
      qunar: {
        from: 'input[placeholder*="出发"], input[name*="depart"]',
        to: 'input[placeholder*="到达"], input[name*="arrive"]',
        date: 'input[placeholder*="日期"], input[type="date"]',
        search: 'button[class*="search"], .search-btn'
      },
      ctrip: {
        from: 'input[placeholder*="出发"], input[aria-label*="出发"]',
        to: 'input[placeholder*="到达"], input[aria-label*="到达"]',
        date: 'input[placeholder*="日期"]',
        search: 'button[type="submit"], .search-btn'
      },
      fliggy: {
        from: 'input[name*="dep"]',
        to: 'input[name*="arr"]',
        date: 'input[type="date"]',
        search: '.search-button'
      },
      zhixing: {
        from: 'input[placeholder*="出发"]',
        to: 'input[placeholder*="到达"]',
        date: 'input[placeholder*="日期"]',
        search: 'button:has-text("搜索")'
      }
    };

    const selectors = formSelectors[platform] || formSelectors.qunar;

    // 5. 如果有快照，尝试填写表单
    if (snapshot) {
      try {
        // 填写出发地
        if (snapshot.includes('出发') || snapshot.includes('from')) {
          await mcpTools.browser_click({
            element: '出发地输入框',
            ref: findRefInSnapshot(snapshot, ['出发', 'from', 'departure'])
          });
          await mcpTools.browser_type({ text: from, submit: false });

          // 填写目的地
          await mcpTools.browser_click({
            element: '目的地输入框',
            ref: findRefInSnapshot(snapshot, ['到达', 'to', 'arrival'])
          });
          await mcpTools.browser_type({ text: to, submit: false });

          // 填写日期
          await mcpTools.browser_click({
            element: '日期选择框',
            ref: findRefInSnapshot(snapshot, ['日期', 'date'])
          });
          await mcpTools.browser_type({ text: date, submit: false });

          // 点击搜索按钮
          await mcpTools.browser_click({
            element: '搜索按钮',
            ref: findRefInSnapshot(snapshot, ['搜索', 'search', '查询'])
          });

          // 等待搜索结果
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (e) {
        console.log(`  ⚠️  表单填写失败: ${e.message}`);
        console.log(`  💡 将直接从 URL 获取价格信息`);
      }
    }

    // 6. 使用 JavaScript 提取价格 (使用 browser_evaluate)
    const priceData = await mcpTools.browser_evaluate({
      function: `() => {
        // 尝试多种价格选择器
        const selectors = [
          '.price', '.prc', '.fare', '.amount',
          '[class*="price"]', '[data-price]',
          '.flight-price', '.ticket-price',
          'span.price', 'div.price'
        ];

        const results = [];
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            elements.forEach(el => {
              const text = el.textContent || '';
              const priceMatch = text.match(/¥?\\s*(\\d+)/);
              if (priceMatch) {
                const price = parseInt(priceMatch[1]);
                if (price > 100 && price < 10000) { // 合理的价格范围
                  results.push({
                    price: price,
                    text: text.trim(),
                    selector: selector
                  });
                }
              }
            });
          }
        }

        // 去重并返回最低价
        const uniquePrices = [...new Set(results.map(r => r.price))];
        return uniquePrices.sort((a, b) => a - b);
      }`
    });

    // 7. 截图保存 (使用 browser_take_screenshot)
    try {
      const screenshotPath = `flight-${platform}-${from}-${to}-${Date.now()}.png`;
      await mcpTools.browser_take_screenshot({
        type: 'png',
        filename: screenshotPath,
        fullPage: true
      });
      console.log(`  ✓ 截图已保存: ${screenshotPath}`);
    } catch (e) {
      console.log(`  ⚠️  截图失败: ${e.message}`);
    }

    results.push({
      platform: config.name,
      url: url,
      prices: priceData || [],
      timestamp: new Date().toISOString(),
      success: true
    });

    console.log(`  ✓ ${config.name} 抓取成功，找到 ${priceData?.length || 0} 个价格`);

  } catch (error) {
    console.error(`${config.name} 抓取失败:`, error.message);
    results.push({
      platform: config.name,
      error: error.message,
      timestamp: new Date().toISOString(),
      success: false
    });
  }

  return results;
}

/**
 * 从快照中查找元素引用
 */
function findRefInSnapshot(snapshot, keywords) {
  // 简单的实现：在快照中查找包含关键词的元素引用
  // 实际使用时需要根据快照格式解析
  const lines = snapshot.split('\n');
  for (const line of lines) {
    for (const keyword of keywords) {
      if (line.toLowerCase().includes(keyword.toLowerCase())) {
        // 提取引用（快照格式可能不同）
        const match = line.match(/ref="?([^"\\s]+)"?/);
        if (match) return match[1];
      }
    }
  }
  return null;
}

/**
 * 多平台价格比较
 */
async function compareAllPlatforms(from, to, date, mcpTools) {
  console.log(`\n开始比价: ${from} → ${to}, ${date}`);
  console.log('='.repeat(50));

  const allResults = [];

  for (const platform of Object.keys(PLATFORMS)) {
    const results = await scrapeWithPlaywright(platform, from, to, date, mcpTools);
    allResults.push(...results);
  }

  return allResults;
}

/**
 * 解析价格并找到最低价
 */
function findBestPrice(results) {
  const validPrices = results
    .filter(r => r.success && r.prices && r.prices.length > 0)
    .map(r => {
      // r.prices 现在是一个价格数字数组
      const prices = Array.isArray(r.prices) ? r.prices : [];
      const validPriceValues = prices.filter(p => typeof p === 'number' && p > 0);

      if (validPriceValues.length > 0) {
        return {
          platform: r.platform,
          url: r.url,
          lowestPrice: Math.min(...validPriceValues),
          allPrices: validPriceValues
        };
      }
      return null;
    })
    .filter(p => p !== null && p.lowestPrice > 0);

  // 按价格排序
  validPrices.sort((a, b) => a.lowestPrice - b.lowestPrice);

  return validPrices;
}

/**
 * 保存监控配置
 */
function saveMonitor(monitor) {
  ensureDirs();

  let monitors = [];
  if (fs.existsSync(MONITORS_FILE)) {
    monitors = JSON.parse(fs.readFileSync(MONITORS_FILE, 'utf8'));
  }

  const index = monitors.findIndex(m => m.id === monitor.id);
  if (index >= 0) {
    monitors[index] = monitor;
  } else {
    monitors.push(monitor);
  }

  fs.writeFileSync(MONITORS_FILE, JSON.stringify(monitors, null, 2));
}

/**
 * 保存价格历史
 */
function savePriceHistory(monitorId, results) {
  ensureDirs();

  const historyFile = path.join(HISTORY_DIR, `${monitorId}.json`);
  let history = [];

  if (fs.existsSync(historyFile)) {
    history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  }

  history.push({
    timestamp: new Date().toISOString(),
    results: results
  });

  // 只保留最近 100 条记录
  if (history.length > 100) {
    history = history.slice(-100);
  }

  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

/**
 * 价格预测算法
 */
function predictPrice(from, to, targetDate) {
  const date = new Date(targetDate);
  const now = new Date();
  const daysUntilFlight = Math.ceil((date - now) / (1000 * 60 * 60 * 24));

  // 季节因素
  const seasonalFactors = {
    1: 1.2, 2: 0.9, 3: 0.95, 4: 1.0, 5: 1.05,
    6: 1.15, 7: 1.3, 8: 1.35, 9: 1.2, 10: 1.0,
    11: 1.1, 12: 1.25
  };

  // 提前购买因素
  let advanceFactor;
  if (daysUntilFlight >= 60) advanceFactor = 1.1;
  else if (daysUntilFlight >= 30) advanceFactor = 0.95;
  else if (daysUntilFlight >= 14) advanceFactor = 0.9;
  else if (daysUntilFlight >= 7) advanceFactor = 1.0;
  else if (daysUntilFlight >= 3) advanceFactor = 1.15;
  else advanceFactor = 1.3;

  // 基础价格（根据航线估算，这里简化处理）
  const basePrice = 500; // 可以根据实际航线调整

  const month = date.getMonth() + 1;
  const seasonFactor = seasonalFactors[month] || 1.0;

  return {
    lowest: Math.round(basePrice * seasonFactor * advanceFactor * 0.9),
    average: Math.round(basePrice * seasonFactor * advanceFactor),
    highest: Math.round(basePrice * seasonFactor * advanceFactor * 1.2),
    daysUntil: daysUntilFlight
  };
}

/**
 * 格式化输出结果
 */
function formatResults(from, to, date, results, prediction) {
  const bestPrices = findBestPrice(results);

  let output = '\n';
  output += '┌' + '─'.repeat(50) + '┐\n';
  output += '│  航班价格查询报告' + ' '.repeat(30) + '│\n';
  output += '├' + '─'.repeat(50) + '┤\n';
  output += `│  航线:   ${from} → ${to}` + ' '.repeat(30 - from.length - to.length) + '│\n';
  output += `│  日期:   ${date}` + ' '.repeat(38 - date.length) + '│\n';
  output += '├' + '─'.repeat(50) + '┤\n';
  output += '│  📊 全网价格对比:' + ' '.repeat(30) + '│\n';

  if (bestPrices.length > 0) {
    bestPrices.forEach((item, index) => {
      const rank = index === 0 ? '⭐ 最低' : `   ${index + 1}.`;
      output += `│    ${rank} ${item.platform}: ¥${item.lowestPrice}` + ' '.repeat(50 - 8 - item.platform.length - String(item.lowestPrice).length) + '│\n';
    });
  } else {
    output += '│    暂无价格数据，请检查搜索条件' + ' '.repeat(19) + '│\n';
  }

  if (prediction) {
    output += '│' + '─'.repeat(50) + '│\n';
    output += '│  📈 价格预测 (未来30天):' + ' '.repeat(23) + '│\n';
    output += `│    最低: ¥${prediction.lowest} - ¥${prediction.average}` + ' '.repeat(50 - 20 - String(prediction.lowest).length - String(prediction.average).length) + '│\n';
    output += `│    距离出发: ${prediction.daysUntil} 天` + ' '.repeat(50 - 15 - String(prediction.daysUntil).length) + '│\n';
  }

  output += '└' + '─'.repeat(50) + '┘\n';

  return output;
}

/**
 * 生成同一航班在各平台的价格对比表（Markdown格式）
 *
 * @param {string} flightNumber - 航班号 (如: CZ8735)
 * @param {string} flightTime - 航班时间 (如: 09:55-13:05)
 * @param {Array} platformPrices - 各平台价格数组
 *   格式: [{ platform: '携程', price: 800, url: '...' }, ...]
 * @returns {string} Markdown格式的对比表
 */
function formatFlightComparisonTable(flightNumber, flightTime, platformPrices) {
  let table = '\n## ✈️ 航班价格对比表\n\n';
  table += `### ${flightNumber} (${flightTime})\n\n`;

  // 创建表头
  table += '| 平台 | 价格 | 状态 | 备注 |\n';
  table += '|------|------|------|------|\n';

  // 填充数据
  platformPrices.forEach(item => {
    const price = item.price ? `¥${item.price}` : '-';
    const status = item.success ? '✅ 已查询' : (item.error ? '❌ 失败' : '⏳ 查询中');
    const note = item.note || '';

    // 找最低价
    if (item.price && item.price === Math.min(...platformPrices.filter(p => p.price).map(p => p.price))) {
      table += `| ${item.platform} | **${price}** ⭐ | ${status} | ${note} |\n`;
    } else {
      table += `| ${item.platform} | ${price} | ${status} | ${note} |\n`;
    }
  });

  // 添加结论
  const validPrices = platformPrices.filter(p => p.price && p.success);
  if (validPrices.length > 0) {
    const lowestPrice = Math.min(...validPrices.map(p => p.price));
    const highestPrice = Math.max(...validPrices.map(p => p.price));
    const avgPrice = Math.round(validPrices.reduce((sum, p) => sum + p.price, 0) / validPrices.length);

    table += '\n### 📊 价格分析\n\n';
    table += `- **最低价**: ¥${lowestPrice}\n`;
    table += `- **最高价**: ¥${highestPrice}\n`;
    table += `- **平均价**: ¥${avgPrice}\n`;
    table += `- **价格差**: ¥${highestPrice - lowestPrice}\n\n`;

    // 购买建议
    const lowestPlatforms = validPrices.filter(p => p.price === lowestPrice).map(p => p.platform);
    if (lowestPrice === highestPrice) {
      table += '### 💡 购买建议\n\n';
      table += '所有平台价格一致！建议：\n';
      table += '- 如果有航空公司会员，直接在**官网**购买积累里程\n';
      table += '- 如果有某平台优惠券/积分，选择相应平台\n';
      table += '- 选择您最常用的平台即可\n';
    } else {
      table += '### 💡 购买建议\n\n';
      table += `推荐在 **${lowestPlatforms.join(' / ')}** 购买，价格最优惠 (¥${lowestPrice})\n`;
    }
  }

  return table;
}

/**
 * 生成完整的价格对比报告（包含多航班对比）
 *
 * @param {string} from - 出发地
 * @param {string} to - 目的地
 * @param {string} date - 日期
 * @param {Array} flights - 航班数组
 *   格式: [{ flightNumber: 'CZ8735', time: '09:55-13:05', platforms: [...] }, ...]
 * @returns {string} 完整报告
 */
function formatFullComparisonReport(from, to, date, flights) {
  let report = '# 🌐 机票价格对比报告\n\n';
  report += `**航线**: ${from} → ${to}  \n`;
  report += `**日期**: ${date}  \n`;
  report += `**查询时间**: ${new Date().toLocaleString('zh-CN')}\n\n';

  report += '---\n\n';

  // 每个航班生成一个对比表
  flights.forEach((flight, index) => {
    report += formatFlightComparisonTable(
      flight.flightNumber,
      flight.time,
      flight.platforms
    );

    if (index < flights.length - 1) {
      report += '\n---\n\n';
    }
  });

  return report;
}

/**
 * 创建监控
 */
function createMonitor(from, to, date, targetPrice) {
  const id = `${from}-${to}-${date}`;
  return {
    id,
    origin: from,
    destination: to,
    date,
    targetPrice,
    checkInterval: 3600000, // 1小时
    platforms: Object.keys(PLATFORMS),
    status: 'active',
    createdAt: new Date().toISOString()
  };
}

/**
 * 导出函数供外部调用
 */
module.exports = {
  scrapeWithPlaywright,
  compareAllPlatforms,
  findBestPrice,
  formatResults,
  formatFlightComparisonTable,
  formatFullComparisonReport,
  predictPrice,
  saveMonitor,
  savePriceHistory,
  createMonitor,
  getAirportCode,
  AIRPORT_CODES,
  PLATFORMS,

  // 主函数：搜索价格 (使用 Playwright MCP)
  async searchPrice(from, to, date, mcpTools) {
    const fromCode = getAirportCode(from) || from;
    const toCode = getAirportCode(to) || to;

    const results = await this.compareAllPlatforms(fromCode, toCode, date, mcpTools);
    const prediction = this.predictPrice(fromCode, toCode, date);

    return {
      from: fromCode,
      to: toCode,
      date,
      results,
      prediction,
      formatted: this.formatResults(fromCode, toCode, date, results, prediction)
    };
  },

  // 主函数：启动监控 (使用 Playwright MCP)
  async startMonitoring(from, to, date, targetPrice, mcpTools, onPriceUpdate) {
    const monitor = this.createMonitor(from, to, date, targetPrice);
    this.saveMonitor(monitor);

    console.log(`\n✅ 监控已设置！`);
    console.log(`航线: ${from} → ${to}`);
    console.log(`日期: ${date}`);
    console.log(`目标价: ¥${targetPrice}`);
    console.log(`检查频率: 每1小时\n`);

    // 立即执行一次检查
    const result = await this.searchPrice(from, to, date, puppeteerTool);
    this.savePriceHistory(monitor.id, result.results);

    const bestPrices = this.findBestPrice(result.results);
    if (bestPrices.length > 0) {
      const currentLowest = bestPrices[0].lowestPrice;
      console.log(`当前最低价: ¥${currentLowest} (${bestPrices[0].platform})`);

      if (currentLowest <= targetPrice) {
        console.log(`\n🎉 目标价格已达成！建议立即下单！`);
        console.log(`下单链接: ${bestPrices[0].url}`);
      } else {
        console.log(`距离目标价还有 ¥${currentLowest - targetPrice}`);
      }
    }

    // 返回监控对象，以便外部设置定时器
    return {
      monitor,
      check: async () => {
        const result = await this.searchPrice(from, to, date, puppeteerTool);
        this.savePriceHistory(monitor.id, result.results);

        const bestPrices = this.findBestPrice(result.results);
        if (bestPrices.length > 0 && bestPrices[0].lowestPrice <= targetPrice) {
          if (onPriceUpdate) {
            onPriceUpdate({
              monitor,
              currentPrice: bestPrices[0].lowestPrice,
              platform: bestPrices[0].platform,
              url: bestPrices[0].url
            });
          }
        }

        return result;
      }
    };
  }
};

// 如果直接运行此脚本
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length >= 3) {
    const [from, to, date, target] = args;
    console.log(`\n机票价格监控工具`);
    console.log(`航线: ${from} → ${to}`);
    console.log(`日期: ${date}`);
    if (target) console.log(`目标价: ¥${target}`);
    console.log(`\n注意: 此脚本需要通过 Claude + MCP Puppeteer 调用`);
    console.log(`请在 Claude 中使用: "帮我监控 ${from} 到 ${to} ${date} 的机票${target ? '，目标价 ' + target : ''}"`);
  } else {
    console.log(`
使用方法:
  node flight-monitor.js <出发地> <目的地> <日期> [目标价格]

示例:
  node flight-monitor.js 深圳 青岛 2026-03-28 600

注意: 此脚本需要通过 Claude + MCP Puppeteer 完整功能
    `);
  }
}
