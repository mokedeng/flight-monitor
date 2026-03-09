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

    for (const tool of requiredTools) {
      if (!this.mcp[tool]) {
        throw new Error(`必需的 MCP 工具不可用: ${tool}`);
      }
    }

    this.initialized = true;
    return true;
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
   * 专用于机票价格抓取的方法
   * @param {string} platform - 平台名称
   * @param {string} url - 目标URL
   * @param {string[]} priceSelectors - 自定义价格选择器
   * @param {Object} waitOptions - 智能等待选项
   * @param {string[]} waitOptions.selectors - 等待出现的元素选择器
   * @param {number} waitOptions.timeout - 最大等待时间（秒）
   * @param {boolean} waitOptions.useNetworkIdle - 是否使用网络空闲检测
   */
  async scrapeFlightPrice(platform, url, priceSelectors = [], waitOptions = {}) {
    try {
      console.log(`\n🔍 正在抓取 ${platform} 的价格...`);

      // 1. 导航到页面
      await this.goto(url);

      // 2. 智能等待页面加载
      const waitResult = waitOptions.useNetworkIdle
        ? await this.waitForNetworkIdle(2, waitOptions.timeout || 15)
        : await this.smartWait({
            selectors: waitOptions.selectors || [],
            timeout: waitOptions.timeout || 15
          });

      if (!waitResult.found) {
        console.log(`  ⚠️  页面可能未完全加载，继续尝试...`);
      }

      // 3. 获取快照（用于调试）
      await this.snapshot();
      console.log(`  ✓ 页面快照已获取`);

      // 4. 提取价格
      const priceScript = this._generatePriceScript(priceSelectors);
      const prices = await this.evaluate(priceScript);
      console.log(`  ✓ 找到 ${prices?.length || 0} 个价格`);

      // 5. 截图（用于验证）
      const filename = `flight-${platform}-${Date.now()}.png`;
      await this.screenshot(filename);

      return {
        platform,
        url,
        prices: prices || [],
        screenshot: filename,
        success: true,
        timestamp: new Date().toISOString(),
        waitInfo: waitResult
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
   * 生成价格提取脚本
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
 * 快捷方法：抓取多个平台的价格
 */
export async function scrapeMultiplePlatforms(mcpTools, platforms) {
  const results = [];

  for (const [platform, url] of Object.entries(platforms)) {
    const result = await scrapePlatform(mcpTools, platform, url);
    results.push(result);
  }

  return results;
}

export default PlaywrightMCPWrapper;
