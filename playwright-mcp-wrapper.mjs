#!/usr/bin/env node

/**
 * Playwright MCP Wrapper for Flight Monitor
 *
 * 简化的 Playwright MCP 工具包装器
 * 专用于机票价格监控功能
 *
 * Microsoft Playwright MCP 文档:
 * https://github.com/microsoft/playwright-mcp
 *
 * 功能特性:
 * - 智能等待：等待特定元素出现或网络空闲，替代固定延迟
 * - 快速失败：超时后立即返回，不重试（避免触发WAF）
 * - 多模式等待：支持元素选择器、文本匹配、网络空闲检测
 * - 自动降级：如果智能等待失败，仍可继续尝试价格提取
 */

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Playwright MCP 工具包装类
 */
export class PlaywrightMCPWrapper {
  constructor(mcpTools) {
    this.mcp = mcpTools;
    this.initialized = false;
    // 标签页管理：跟踪每个平台对应的标签页索引
    this.platformTabs = new Map();
    // 登录状态缓存：记录哪些平台需要登录
    this.loginRequiredPlatforms = new Set();
  }

  /**
   * 验证 MCP 工具是否可用
   */
  async validate() {
    const requiredTools = [
      'browser_navigate',
      'browser_snapshot',
      'browser_evaluate',
      'browser_take_screenshot'
    ];

    // 检查是否有 browser_tabs 工具（用于标签页管理）
    const hasTabsTool = !!this.mcp['browser_tabs'];
    if (hasTabsTool) {
      requiredTools.push('browser_tabs');
    }

    for (const tool of requiredTools) {
      if (tool === 'browser_tabs' && !hasTabsTool) continue;
      if (!this.mcp[tool]) {
        throw new Error(`必需的 MCP 工具不可用: ${tool}`);
      }
    }

    this.initialized = true;
    this.hasTabsTool = hasTabsTool;
    return true;
  }

  /**
   * 获取所有标签页
   */
  async getTabs() {
    if (!this.hasTabsTool) return [];
    const result = await this.mcp.browser_tabs({ action: 'list' });
    return result || [];
  }

  /**
   * 创建新标签页
   */
  async newTab() {
    if (!this.hasTabsTool) return null;
    const result = await this.mcp.browser_tabs({ action: 'new' });
    return result;
  }

  /**
   * 切换到指定标签页
   */
  async switchTab(index) {
    if (!this.hasTabsTool) return false;
    try {
      await this.mcp.browser_tabs({ action: 'select', index });
      return true;
    } catch (e) {
      console.log(`  ⚠️  切换标签页失败: ${e.message}`);
      return false;
    }
  }

  /**
   * 关闭指定标签页
   */
  async closeTab(index) {
    if (!this.hasTabsTool) return false;
    try {
      await this.mcp.browser_tabs({ action: 'close', index });
      return true;
    } catch (e) {
      console.log(`  ⚠️  关闭标签页失败: ${e.message}`);
      return false;
    }
  }

  /**
   * 检测是否需要登录
   * @returns {Object} { required: boolean, reason?: string }
   */
  async detectLoginRequired() {
    try {
      const checkScript = `() => {
        // 检查登录弹窗
        const loginSelectors = [
          '.login-modal', '.login-popup', '.auth-modal',
          '[class*="login"]', '[class*="auth"]',
          '.sign-in', '.signin'
        ];

        for (const sel of loginSelectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el.offsetParent !== null) {
              const text = el.textContent.toLowerCase();
              // 检查是否包含登录相关文本
              if (text.includes('登录') || text.includes('log in') ||
                  text.includes('sign in') || text.includes('请登录')) {
                return { required: true, reason: '检测到登录弹窗' };
              }
            }
          }
        }

        // 检查页面是否有重定向到登录页
        if (window.location.href.includes('login') || window.location.href.includes('auth')) {
          return { required: true, reason: '页面重定向到登录页' };
        }

        // 检查是否有价格数据（没有价格数据可能需要登录）
        const priceElements = document.querySelectorAll('.price, .prc, [class*="price"]');
        if (priceElements.length === 0) {
          // 进一步检查是否真的没有内容
          const bodyText = document.body.textContent.toLowerCase();
          if (bodyText.includes('登录') || bodyText.includes('请先登录')) {
            return { required: true, reason: '页面提示需要登录' };
          }
        }

        return { required: false };
      }`;

      const result = await this.evaluate(checkScript);
      return result || { required: false };
    } catch (e) {
      // 检测失败，假设不需要登录
      return { required: false };
    }
  }

  /**
   * 导航到指定 URL
   */
  async goto(url) {
    if (!this.initialized) await this.validate();
    await this.mcp.browser_navigate({ url });
    console.log(`  ✓ 已导航到: ${url}`);
  }

  /**
   * 获取页面快照
   */
  async snapshot() {
    if (!this.initialized) await this.validate();
    const result = await this.mcp.browser_snapshot({});
    return result;
  }

  /**
   * 执行 JavaScript 代码
   */
  async evaluate(script) {
    if (!this.initialized) await this.validate();
    const result = await this.mcp.browser_evaluate({
      function: script
    });
    return result;
  }

  /**
   * 截图
   */
  async screenshot(filename = null) {
    if (!this.initialized) await this.validate();
    const options = { type: 'png', fullPage: true };
    if (filename) options.filename = filename;
    const result = await this.mcp.browser_take_screenshot(options);
    console.log(`  ✓ 截图已保存: ${filename || 'page-screenshot.png'}`);
    return result;
  }

  /**
   * 等待指定时间（秒）
   */
  async wait(seconds) {
    if (!this.initialized) await this.validate();
    await this.mcp.browser_wait_for({ time: seconds });
  }

  /**
   * 智能等待 - 等待特定元素出现或文本出现
   * @param {Object} options - 等待选项
   * @param {string[]} options.selectors - CSS选择器列表，任一出现即返回
   * @param {string} options.text - 等待特定文本出现
   * @param {number} options.timeout - 最大超时时间（秒），默认15
   * @param {number} options.interval - 检查间隔（秒），默认0.5
   * @returns {Object} { found: boolean, selector?: string, elapsed: number }
   */
  async smartWait(options = {}) {
    const {
      selectors = [],
      text = null,
      timeout = 15,
      interval = 0.5
    } = options;

    if (!this.initialized) await this.validate();

    const startTime = Date.now();
    const maxAttempts = Math.ceil(timeout / interval);
    let attempts = 0;

    console.log(`  🔄 智能等待中... (超时: ${timeout}秒)`);

    while (attempts < maxAttempts) {
      attempts++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      try {
        // 检查选择器是否存在
        if (selectors.length > 0) {
          const checkScript = `() => {
            const selectors = ${JSON.stringify(selectors)};
            for (const sel of selectors) {
              try {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) { // 可见元素
                  return { found: true, selector: sel };
                }
              } catch (e) {
                // 忽略无效选择器
              }
            }
            return { found: false };
          }`;

          const result = await this.evaluate(checkScript);
          if (result.found) {
            console.log(`  ✓ 元素已出现: ${result.selector} (耗时: ${elapsed}秒)`);
            return { found: true, selector: result.selector, elapsed: parseFloat(elapsed), attempts };
          }
        }

        // 检查文本是否存在
        if (text) {
          const result = await this.evaluate(`() => {
            const bodyText = document.body.textContent || document.body.innerText;
            return bodyText.includes(${JSON.stringify(text)});
          }`);
          if (result) {
            console.log(`  ✓ 文本已出现: "${text}" (耗时: ${elapsed}秒)`);
            return { found: true, text, elapsed: parseFloat(elapsed), attempts };
          }
        }

        // 如果都没有指定，检查是否有航班数据加载
        if (selectors.length === 0 && !text) {
          // 默认检查常见的航班列表元素
          const defaultCheck = `() => {
            const flightSelectors = [
              '.flight-list', '.flight-item', '.b_flist',
              '[class*="flight"]', '[class*="Flight"]',
              '.list-item', '.flight-card'
            ];
            for (const sel of flightSelectors) {
              const els = document.querySelectorAll(sel);
              if (els.length > 0) {
                return { found: true, selector: sel, count: els.length };
              }
            }
            // 检查是否有价格元素（表示数据已加载）
            const priceSelectors = ['.price', '.prc', '[class*="price"]'];
            for (const sel of priceSelectors) {
              const els = document.querySelectorAll(sel);
              if (els.length >= 3) { // 至少3个价格元素
                return { found: true, selector: sel, count: els.length };
              }
            }
            return { found: false };
          }`;
          const result = await this.evaluate(defaultCheck);
          if (result.found) {
            console.log(`  ✓ 检测到航班数据: ${result.selector} (${result.count || ''}个元素, 耗时: ${elapsed}秒)`);
            return { found: true, selector: result.selector, elapsed: parseFloat(elapsed), attempts };
          }
        }

      } catch (error) {
        // 评估失败，继续等待
        console.log(`  ⚠️  检查失败: ${error.message}`);
      }

      // 等待间隔时间
      await this.mcp.browser_wait_for({ time: interval });
    }

    // 超时
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  ⏱️  等待超时 (${totalElapsed}秒)`);
    return { found: false, elapsed: parseFloat(totalElapsed), attempts };
  }

  /**
   * 等待网络空闲（简化版，通过检查页面DOM是否稳定）
   * @param {number} idleTime - 需要保持稳定的时间（秒），默认2
   * @param {number} timeout - 最大超时时间（秒），默认15
   */
  async waitForNetworkIdle(idleTime = 2, timeout = 15) {
    const startTime = Date.now();
    let lastDomState = '';
    let stableSince = null;
    const checkInterval = 0.5;
    const maxAttempts = Math.ceil(timeout / checkInterval);
    let attempts = 0;

    console.log(`  🔄 等待网络空闲... (稳定时间: ${idleTime}秒)`);

    while (attempts < maxAttempts) {
      attempts++;

      try {
        // 获取当前DOM状态（简化版本，只检查body的长度）
        const currentDomState = await this.evaluate(`() => {
          return {
            bodyLength: document.body.textContent.length,
            elementCount: document.querySelectorAll('*').length,
            loadingElements: document.querySelectorAll('[class*="loading"], [class*="spinner"], .loading').length
          };
        }`);

        const stateStr = JSON.stringify(currentDomState);

        if (stateStr === lastDomState && currentDomState.loadingElements === 0) {
          if (!stableSince) {
            stableSince = Date.now();
          } else if ((Date.now() - stableSince) / 1000 >= idleTime) {
            const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`  ✓ 网络已空闲 (耗时: ${totalElapsed}秒)`);
            return { found: true, elapsed: parseFloat(totalElapsed), attempts };
          }
        } else {
          stableSince = null;
        }

        lastDomState = stateStr;

      } catch (error) {
        stableSince = null;
      }

      await this.mcp.browser_wait_for({ time: checkInterval });
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  ⏱️  等待网络空闲超时 (${totalElapsed}秒)`);
    return { found: false, elapsed: parseFloat(totalElapsed), attempts };
  }

  /**
   * 点击元素
   */
  async click(element, ref) {
    if (!this.initialized) await this.validate();
    await this.mcp.browser_click({ element, ref });
  }

  /**
   * 输入文本
   */
  async type(element, ref, text, submit = false) {
    if (!this.initialized) await this.validate();
    await this.mcp.browser_type({ element, ref, text, submit });
  }

  /**
   * 批量填写表单
   */
  async fillForm(fields) {
    if (!this.initialized) await this.validate();
    await this.mcp.browser_fill_form({ fields });
  }

  /**
   * 关闭浏览器
   */
  async close() {
    if (this.initialized && this.mcp.browser_close) {
      await this.mcp.browser_close({});
      this.initialized = false;
    }
  }

  /**
   * 专用于机票价格抓取的方法（增强版：支持标签页复用和登录检测）
   * @param {string} platform - 平台名称
   * @param {string} url - 目标URL
   * @param {string[]} priceSelectors - 自定义价格选择器
   * @param {Object} waitOptions - 智能等待选项
   * @param {string[]} waitOptions.selectors - 等待出现的元素选择器
   * @param {number} waitOptions.timeout - 最大等待时间（秒）
   * @param {boolean} waitOptions.useNetworkIdle - 是否使用网络空闲检测
   * @param {boolean} reuseTab - 是否复用已有标签页（默认true）
   */
  async scrapeFlightPrice(platform, url, priceSelectors = [], waitOptions = {}, reuseTab = true) {
    try {
      console.log(`\n🔍 正在抓取 ${platform} 的价格...`);

      // 1. 标签页管理：尝试复用已有标签页
      let tabReused = false;
      if (reuseTab && this.hasTabsTool && this.platformTabs.has(platform)) {
        const tabIndex = this.platformTabs.get(platform);
        console.log(`  🔄 尝试复用已有标签页 (索引: ${tabIndex})...`);
        tabReused = await this.switchTab(tabIndex);
        if (tabReused) {
          console.log(`  ✓ 已切换到 ${platform} 的标签页`);
        } else {
          // 标签页可能已关闭，从缓存中移除
          this.platformTabs.delete(platform);
        }
      }

      // 2. 导航到页面（如果没有复用标签页，或者复用失败）
      if (!tabReused) {
        if (reuseTab && this.hasTabsTool) {
          // 创建新标签页而不是在当前标签页中导航
          await this.newTab();
          // 等待新标签页加载
          await this.wait(1);
        }
        await this.goto(url);

        // 记录当前标签页索引
        if (this.hasTabsTool) {
          const tabs = await this.getTabs();
          if (tabs.length > 0) {
            // 假设新创建的标签页是最后一个
            this.platformTabs.set(platform, tabs.length - 1);
            console.log(`  ✓ 已为 ${platform} 创建标签页 (索引: ${tabs.length - 1})`);
          }
        }
      }

      // 3. 智能等待页面加载
      const waitResult = waitOptions.useNetworkIdle
        ? await this.waitForNetworkIdle(2, waitOptions.timeout || 15)
        : await this.smartWait({
            selectors: waitOptions.selectors || [],
            timeout: waitOptions.timeout || 15
          });

      if (!waitResult.found) {
        console.log(`  ⚠️  页面可能未完全加载，继续尝试...`);
      }

      // 4. 检测是否需要登录
      const loginCheck = await this.detectLoginRequired();
      if (loginCheck.required) {
        console.log(`  🔐 ${platform} 需要登录: ${loginCheck.reason || '未检测到价格数据'}`);
        this.loginRequiredPlatforms.add(platform);

        // 保持标签页打开，让用户可以手动登录
        return {
          platform,
          url,
          error: '需要登录',
          loginRequired: true,
          reason: loginCheck.reason,
          success: false,
          timestamp: new Date().toISOString(),
          tabOpen: true // 标签页保持打开
        };
      }

      // 5. 获取快照（用于调试）
      await this.snapshot();
      console.log(`  ✓ 页面快照已获取`);

      // 6. 提取航班详情（包含时间、航班号、航空公司、价格）
      const flightDataScript = this._generateFlightDataScript();
      const flights = await this.evaluate(flightDataScript);
      console.log(`  ✓ 找到 ${flights?.length || 0} 个航班`);

      // 7. 同时提取价格（用于兼容旧逻辑）
      const priceScript = this._generatePriceScript(priceSelectors);
      const prices = await this.evaluate(priceScript);

      // 8. 截图（用于验证）
      const filename = `flight-${platform}-${Date.now()}.png`;
      await this.screenshot(filename);

      return {
        platform,
        url,
        prices: prices || [],
        flights: flights || [],  // 新增：航班详情数组
        screenshot: filename,
        success: true,
        timestamp: new Date().toISOString(),
        waitInfo: waitResult,
        tabOpen: true // 标签页保持打开，方便用户下单
      };

    } catch (error) {
      console.error(`  ✗ ${platform} 抓取失败:`, error.message);
      return {
        platform,
        url,
        error: error.message,
        success: false,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 生成航班详情提取脚本（增强版：包含起飞时间、航班号、航空公司、价格）
   *
   * 提取字段:
   * - departureTime: 起飞时间 (HH:MM格式)
   * - flightNumber: 航班号 (如 CA1234)
   * - airline: 航空公司 (如 中国国际航空)
   * - price: 价格 (数字)
   */
  _generateFlightDataScript() {
    return `() => {
      const flights = [];

      // 通用航班选择器（针对不同平台的DOM结构）
      const flightContainers = [
        // 去哪儿
        '.b_flist .itm',
        // 携程
        '.flight-item',
        // 飞猪
        '.flight-list-item',
        // 智行/苏雅
        '.flight-card',
        // 南方航空官网
        '.flight-list-item',
        '.csair-flight',
        // 东方航空官网
        '.ceair-flight-item',
        '.mu-flight-item',
        // 海南航空官网
        '.hnair-flight',
        '.hainan-flight-item',
        // 厦门航空官网
        '.xiamenair-flight',
        '.mf-flight-item',
        // 山东航空官网
        '.flight-item-info',
        '.flightList-item',
        // 深圳航空官网
        '.flight-list-row',
        '.flight-row',
        // 通用
        '[class*="flight-item"]',
        '[class*="flight-card"]',
        '[class*="flight-list"] > div',
        '[class*="flight-row"]',
        '.list-item',
        // 航空公司通用
        '.flight-info',
        '.flight-detail',
        '.flight-card-item',
        '[data-flight]'
      ];

      for (const containerSelector of flightContainers) {
        try {
          const containers = document.querySelectorAll(containerSelector);
          if (containers.length === 0) continue;

          containers.forEach(container => {
            const flight = {};

            // 1. 提取起飞时间（更全面的选择器）
            const timeSelectors = [
              '.depart-time', '.start-time', '.time-dep',
              '[class*="depart"][class*="time"]',
              '[class*="start"][class*="time"]',
              '.time-1', '.t1',
              // 航空公司官网
              '.dep-time', '.depTime', '.departure-time',
              '.flight-depart-time',
              '[data-depart-time]'
            ];
            for (const sel of timeSelectors) {
              const el = container.querySelector(sel);
              if (el) {
                const timeMatch = el.textContent.match(/(\\d{1,2}):(\\d{2})/);
                if (timeMatch) {
                  flight.departureTime = timeMatch[0];
                  break;
                }
              }
            }

            // 2. 提取航班号
            const flightNoSelectors = [
              '.flight-no', '.flight-number', '.no',
              '[class*="flight-no"]', '[class*="flight-number"]',
              '.f-no', '.fn',
              // 航空公司官网
              '.flight-num', '.flightNum',
              '.flight-code', '.flightCode'
            ];
            for (const sel of flightNoSelectors) {
              const el = container.querySelector(sel);
              if (el) {
                const flightNoMatch = el.textContent.match(/([A-Z]{2}\\d{3,4})/);
                if (flightNoMatch) {
                  flight.flightNumber = flightNoMatch[1];
                  break;
                }
              }
            }

            // 3. 提取航空公司
            const airlineSelectors = [
              '.airline', '.company', '.carrier',
              '[class*="airline"]', '[class*="company"]',
              '.air-name', '.c-name',
              // 航空公司官网
              '.airline-name', '.airlineName'
            ];
            for (const sel of airlineSelectors) {
              const el = container.querySelector(sel);
              if (el) {
                const airlineText = el.textContent.trim();
                if (airlineText && airlineText.length < 20) {
                  flight.airline = airlineText;
                  break;
                }
              }
            }

            // 4. 提取价格（更全面的选择器）
            const priceSelectors = [
              '.price', '.prc', '.fare',
              '[class*="price"]', '[data-price]',
              // 航空公司官网
              '.ticket-price', '.ticketPrice',
              '.flight-price', '.flightPrice',
              '.amount', '.total-amount'
            ];
            for (const sel of priceSelectors) {
              const el = container.querySelector(sel);
              if (el) {
                const priceMatch = el.textContent.match(/¥?\\s*(\\d+(?:\\.\\d+)?)/);
                if (priceMatch) {
                  const price = parseFloat(priceMatch[1]);
                  if (price >= 100 && price <= 20000) {
                    flight.price = Math.round(price);
                    break;
                  }
                }
              }
            }

            // 只有至少包含时间和价格的航班才添加
            if (flight.departureTime && flight.price) {
              flights.push(flight);
            }
          });

          // 如果找到了航班数据，不再尝试其他选择器
          if (flights.length > 0) break;
        } catch (e) {
          // 忽略选择器错误
        }
      }

      return flights;
    }`;
  }

  /**
   * 生成价格提取脚本（保留用于兼容性）
   *
   * P0 修复：增强价格解析能力
   * - 支持 k/K/千 单位（如 1.2k → 1200）
   * - 过滤无效价格（<100 可能是机建燃油费，>20000 可能是异常数据）
   * - 去重并排序
   */
  _generatePriceScript(customSelectors = []) {
    const defaultSelectors = [
      '.price', '.prc', '.fare', '.amount',
      '[class*="price"]', '[data-price]',
      '.flight-price', '.ticket-price',
      'span.price', 'div.price'
    ];

    const selectors = [...new Set([...defaultSelectors, ...customSelectors])];

    return `() => {
      const selectors = ${JSON.stringify(selectors)};
      const results = [];

      for (const selector of selectors) {
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => {
            const text = el.textContent || el.innerText || '';

            // 匹配：¥1234、1.2k、1.2K、1.2千、1234、1,234
            // 不匹配：单独的"起"字、"¥"符号后无数字
            const patterns = [
              /¥?\\s*([1-9]\\d{0,3}(?:,\\d{3})*(?:\\.\\d+)?)[kK千]?/,  // 1234、1,234、1.2k
              /¥?\\s*([1-9]\\d{0,3}(?:,\\d{3})*(?:\\.\\d+)?)[kK千]?/,  // 同上（避免重复）
            ];

            // 综合匹配：数字 + 可选的k/K/千单位
            const match = text.match(/¥?\\s*(\\d+(?:\\.\\d+)?)[\\s,]*([kK千])?/);

            if (match) {
              let val = parseFloat(match[1]);
              const unit = match[2];

              // 处理单位：k/K/千 → ×1000
              if (unit === 'k' || unit === 'K' || unit === '千') {
                val *= 1000;
              }

              // 过滤无效价格：
              // - <100：可能是机建燃油费、或其他费用
              // - >20000：可能是异常数据或国际票价
              if (val >= 100 && val <= 20000 && isFinite(val)) {
                results.push({
                  price: Math.round(val),
                  text: text.trim().substring(0, 50), // 保存前50字符用于调试
                  selector: selector
                });
              }
            }
          });
        } catch (e) {
          // 忽略选择器错误
        }
      }

      // 去重并排序
      const uniquePrices = [...new Set(results.map(r => r.price))];
      return uniquePrices.sort((a, b) => a - b);
    }`;
  }
}

/**
 * 创建包装器实例
 */
export function createPlaywrightWrapper(mcpTools) {
  return new PlaywrightMCPWrapper(mcpTools);
}

/**
 * 快捷方法：抓取单个平台的价格
 */
export async function scrapePlatform(mcpTools, platform, url, selectors = []) {
  const wrapper = new PlaywrightMCPWrapper(mcpTools);
  return await wrapper.scrapeFlightPrice(platform, url, selectors);
}

/**
 * 快捷方法：抓取多个平台的价格（增强版：支持登录检测和智能排序）
 *
 * 优化策略：
 * 1. 先抓取不需要登录的平台（去哪儿、携程、智行等通常不需要登录即可查看价格）
 * 2. 后抓取可能需要登录的平台（如飞猪）
 * 3. 标签页复用：每个平台使用独立的标签页，保持打开状态方便用户下单
 * 4. 登录提示：对于需要登录的平台，保持标签页打开并提示用户手动登录
 *
 * @param {Object} mcpTools - MCP 工具对象
 * @param {Object} platforms - 平台URL映射 { platform: url }
 * @param {Object} options - 选项
 * @param {string[]} options.priority - 平台优先级（按顺序抓取）
 * @param {boolean} options.reuseTabs - 是否复用标签页（默认true）
 * @returns {Promise<Array>} 抓取结果数组
 */
export async function scrapeMultiplePlatforms(mcpTools, platforms, options = {}) {
  const {
    // 默认优先级：去哪儿 > 携程 > 智行 > 飞猪（飞猪通常需要登录）
    priority = ['qunar', 'ctrip', 'zhixing', 'fliggy'],
    reuseTabs = true
  } = options;

  // 创建包装器实例
  const wrapper = new PlaywrightMCPWrapper(mcpTools);
  await wrapper.validate();

  // 按优先级排序平台
  const sortedPlatforms = priority.filter(p => platforms[p]);

  console.log(`\n📋 抓取顺序: ${sortedPlatforms.join(' → ')}`);

  const results = [];
  const loginRequiredPlatforms = [];
  const successfulPlatforms = [];

  // 第一轮：抓取所有平台
  for (const platform of sortedPlatforms) {
    const url = platforms[platform];
    const result = await wrapper.scrapeFlightPrice(platform, url, [], {}, reuseTabs);
    results.push(result);

    if (result.loginRequired) {
      loginRequiredPlatforms.push({ platform, reason: result.reason });
    } else if (result.success) {
      successfulPlatforms.push(platform);
    }
  }

  // 生成登录提示
  if (loginRequiredPlatforms.length > 0) {
    console.log(`\n🔐 需要登录的平台:`);
    for (const { platform, reason } of loginRequiredPlatforms) {
      console.log(`   • ${platform}: ${reason || '需要登录才能查看价格'}`);
    }
    console.log(`\n💡 提示: 相关标签页已保持打开，您可以手动登录后查看价格`);
  }

  // 返回结果（保持标签页打开）
  return {
    results,
    successfulPlatforms,
    loginRequiredPlatforms,
    wrapper // 返回wrapper以便后续操作（如关闭标签页）
  };
}

export default PlaywrightMCPWrapper;
