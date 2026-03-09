#!/usr/bin/env node

/**
 * Flight Monitor Handler - Enhanced Version
 *
 * 在 Claude 中直接调用的机票价格监控处理器
 * 使用 Microsoft Playwright MCP 抓取实时价格
 *
 * 增强功能:
 * - 模糊日期解析（下周末、清明节、下个月中旬等）
 * - 节假日 API 集成（Timor.tech）
 * - 直飞/转机过滤
 * - 节假日价格系数预警
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { createPlaywrightWrapper, scrapeMultiplePlatforms } from './playwright-mcp-wrapper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const fs = require('fs');

/**
 * 时区配置 - 强制使用北京时间 (UTC+8)
 *
 * 解决服务器/容器时区为 UTC 时的日期解析偏差问题
 */
const TIMEZONE_OFFSET = 8; // 北京时间 UTC+8 (小时)

/**
 * 获取当前北京时间
 * @returns {Date} 北京时间的 Date 对象
 */
function getBeijingDate() {
  const now = new Date();
  // 转换为北京时间（UTC+8）
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + (TIMEZONE_OFFSET * 3600000));
}

/**
 * 获取当前北京时间的时间戳
 * @returns {number} 毫秒时间戳
 */
function getBeijingTimestamp() {
  return getBeijingDate().getTime();
}

/**
 * 监控管理器 - 防止内存泄漏
 *
 * 跟踪所有活跃的监控计时器，支持清理和去重
 */
class MonitorManager {
  constructor() {
    // 存储所有活跃的监控: { monitorId: { intervalId, createdAt, ... } }
    this.activeMonitors = new Map();
  }

  /**
   * 注册或更新监控
   * @param {string} monitorId - 监控 ID
   * @param {Object} config - 监控配置
   * @returns {boolean} 如果是新建监控返回 true，更新返回 false
   */
  register(monitorId, config) {
    const existing = this.activeMonitors.get(monitorId);

    // 如果已存在，先清除旧计时器
    if (existing && existing.intervalId) {
      clearInterval(existing.intervalId);
      clearTimeout(existing.intervalId); // 兼容 setTimeout
      console.log(`  🔄 清除旧监控: ${monitorId}`);
    }

    // 存储新监控
    this.activeMonitors.set(monitorId, {
      ...config,
      registeredAt: Date.now()
    });

    return !existing; // 返回是否为新监控
  }

  /**
   * 注销监控并清理计时器
   * @param {string} monitorId - 监控 ID
   * @returns {boolean} 是否成功清理
   */
  unregister(monitorId) {
    const monitor = this.activeMonitors.get(monitorId);
    if (!monitor) return false;

    // 清除计时器
    if (monitor.intervalId) {
      clearInterval(monitor.intervalId);
      clearTimeout(monitor.intervalId);
    }

    this.activeMonitors.delete(monitorId);
    return true;
  }

  /**
   * 更新监控的计时器 ID
   * @param {string} monitorId - 监控 ID
   * @param {number} intervalId - 计时器 ID
   */
  setIntervalId(monitorId, intervalId) {
    const monitor = this.activeMonitors.get(monitorId);
    if (monitor) {
      monitor.intervalId = intervalId;
    }
  }

  /**
   * 检查监控是否存在
   * @param {string} monitorId - 监控 ID
   * @returns {boolean}
   */
  has(monitorId) {
    return this.activeMonitors.has(monitorId);
  }

  /**
   * 获取监控信息
   * @param {string} monitorId - 监控 ID
   * @returns {Object|null}
   */
  get(monitorId) {
    return this.activeMonitors.get(monitorId) || null;
  }

  /**
   * 获取所有活跃监控
   * @returns {Array} 监控 ID 列表
   */
  getActiveMonitors() {
    return Array.from(this.activeMonitors.keys());
  }

  /**
   * 清理所有监控（用于测试或重置）
   */
  clearAll() {
    for (const [monitorId, monitor] of this.activeMonitors) {
      if (monitor.intervalId) {
        clearInterval(monitor.intervalId);
        clearTimeout(monitor.intervalId);
      }
    }
    this.activeMonitors.clear();
  }

  /**
   * 清理过期的监控（超过指定时间未更新）
   * @param {number} maxAge - 最大年龄（毫秒），默认 24 小时
   * @returns {number} 清理的数量
   */
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

// 全局监控管理器实例
const globalMonitorManager = new MonitorManager();

/**
 * 请求频率限制器 - 防止触发反爬虫封禁
 *
 * 跟踪每个平台的请求频率，确保不超过设定的阈值
 */
class RequestLimiter {
  constructor(maxRequestsPerHour = 15) {
    this.maxRequests = maxRequestsPerHour;
    this.requests = []; // { platform, timestamp }
  }

  /**
   * 检查是否可以发起请求
   * @param {string} platform - 平台名称
   * @returns {Object} { allowed: boolean, waitTime?: number, reason?: string }
   */
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
      return {
        allowed: false,
        waitTime,
        reason: `${platform} 请求频率限制，需等待 ${waitTime} 分钟`
      };
    }

    this.requests.push({ platform, timestamp: now });
    return { allowed: true };
  }

  /**
   * 获取当前平台的请求计数
   * @param {string} platform - 平台名称
   * @returns {number} 最近1小时的请求数
   */
  getRequestCount(platform) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    return this.requests.filter(r => r.platform === platform && r.timestamp > oneHourAgo).length;
  }

  /**
   * 重置指定平台的请求记录
   * @param {string} platform - 平台名称
   */
  reset(platform) {
    this.requests = this.requests.filter(r => r.platform !== platform);
  }
}

// 全局请求限流器实例
const globalLimiter = new RequestLimiter(15);

// 机场代码快速映射
/**
 * 机场代码映射（P2 增强：支持具体机场名称）
 *
 * 优先级：
 * 1. 具体机场名称（大兴、首都、虹桥、浦东等）→ 精准定位
 * 2. 城市名称（北京、上海等）→ 使用默认机场
 * 3. 机场代码（PEK、PVG等）→ 直接使用
 *
 * 多机场城市的默认选择：
 * - 北京: PEK（首都机场，国际航班多）
 * - 上海: PVG（浦东机场，国际航班多）
 * - 成都: CTU（双流机场，市区更近）
 * - 重庆: CKG（江北机场）
 * - 昆明: KMG（长水机场）
 */
const AIRPORT_MAP = {
  // ===== P2 新增：具体机场名称映射 =====
  // 北京
  '大兴': 'PKX', '首都': 'PEK', '北京大兴': 'PKX', '北京首都': 'PEK',
  // 上海
  '虹桥': 'SHA', '浦东': 'PVG', '上海虹桥': 'SHA', '上海浦东': 'PVG',
  // 成都
  '天府': 'TFU', '双流': 'CTU', '成都天府': 'TFU', '成都双流': 'CTU',
  // 其他城市
  '白云': 'CAN', '广州白云': 'CAN',  // 广州
  '宝安': 'SZX', '深圳宝安': 'SZX',  // 深圳
  '胶东': 'TAO', '青岛胶东': 'TAO',  // 青岛
  '萧山': 'HGH', '杭州萧山': 'HGH',  // 杭州
  '咸阳': 'XIY', '西安咸阳': 'XIY',  // 西安

  // ===== 城市名称映射（使用默认机场）=====
  '深圳': 'SZX', '北京': 'PEK', '上海': 'PVG', '广州': 'CAN',
  '成都': 'CTU', '杭州': 'HGH', '西安': 'XIY', '南京': 'NKG',
  '青岛': 'TAO', '厦门': 'XMN', '三亚': 'SYX', '重庆': 'CKG',
  '武汉': 'WUH', '长沙': 'CSX', '郑州': 'CGO', '大连': 'DLC',
  '沈阳': 'SHE', '哈尔滨': 'HRB', '乌鲁木齐': 'URC', '昆明': 'KMG',
  '天津': 'TSN', '贵阳': 'KWE', '南宁': 'NNG', '福州': 'FOC',
  '济南': 'TNA', '太原': 'TYN', '南昌': 'KHN', '合肥': 'HFE',
  '桂林': 'KWL', '丽江': 'LJG', '海口': 'HAK', '温州': 'WNZ',
  '宁波': 'NGB', '烟台': 'YNT', '威海': 'WEH', '潍坊': 'WEF',

  // ===== 支线机场 =====
  '宜昌': 'YIH', '万州': 'WXN', '洛阳': 'LYA', '张家界': 'DYG',
  '黄山': 'TXN', '井冈山': 'JGS', '敦煌': 'DNH', '喀什': 'KHG',
  '北海': 'BHY', '桂林两江': 'KWL', '三亚凤凰': 'SYX',

  // ===== 直接支持机场代码（透传）=====
  // 北京
  'PKX': 'PKX', 'PEK': 'PEK',
  // 上海
  'SHA': 'SHA', 'PVG': 'PVG',
  // 成都
  'TFU': 'TFU', 'CTU': 'CTU',
  // 其他
  'SZX': 'SZX', 'CAN': 'CAN', 'HGH': 'HGH', 'XIY': 'XIY',
  'NKG': 'NKG', 'TAO': 'TAO', 'XMN': 'XMN', 'SYX': 'SYX',
  'CKG': 'CKG', 'WUH': 'WUH', 'CSX': 'CSX', 'CGO': 'CGO',
  'DLC': 'DLC', 'SHE': 'SHE', 'HRB': 'HRB', 'URC': 'URC',
  'KMG': 'KMG', 'TSN': 'TSN', 'KWE': 'KWE', 'NNG': 'NNG',
  'FOC': 'FOC', 'TNA': 'TNA', 'TYN': 'TYN', 'KHN': 'KHN'
};

// 移动端 URL 配置（避免反爬虫）
// eslint-disable-next-line no-unused-vars
const MOBILE_URLS = {
  qunar: 'https://m.flight.qunar.com/otn/roundtrip/flight',
  ctrip: 'https://m.ctrip.com/webapp/flight/index',
  fliggy: 'https://m.fliggy.com/flight',
  zhixing: 'https://m.zhixing.com/flight'
};

// 节假日缓存目录
const HOLIDAY_CACHE_DIR = join(process.env.HOME || require('os').homedir(), '.flight-monitor', 'holidays');

/**
 * 获取节假日信息并计算价格系数
 * 使用 Timor.tech API，支持中国复杂的调休逻辑
 *
 * @param {string} dateStr - 格式 YYYY-MM-DD
 * @returns {Promise<Object>} - { factor: number, type: string, name: string, isHoliday: boolean }
 */
/**
 * 获取节假日价格系数（支持缓冲期）
 *
 * P1 增强：增加节假日前后缓冲期逻辑
 * - 节前2天 (Day -2): 开始预热，系数 1.3
 * - 节前1天 (Day -1): 出行最高峰，系数 1.5
 * - 节假日当天 (Day 0): 维持高位，系数 1.8
 * - 节后1天 (Day +1): 返程余温，系数 1.2
 *
 * @param {string} dateStr - 格式 YYYY-MM-DD
 * @returns {Promise<Object>} - { factor: number, type: string, name: string, isHoliday: boolean, bufferInfo?: string }
 */
async function getHolidayFactor(dateStr) {
  try {
    // 确保缓存目录存在
    if (!fs.existsSync(HOLIDAY_CACHE_DIR)) {
      fs.mkdirSync(HOLIDAY_CACHE_DIR, { recursive: true });
    }

    // 检查本地缓存
    const year = dateStr.split('-')[0];
    const cacheFile = join(HOLIDAY_CACHE_DIR, `holidays_${year}.json`);

    let holidayData = null;

    // 尝试从缓存读取
    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached[dateStr]) {
          return cached[dateStr];
        }
        holidayData = cached; // 保存整个缓存以便后续查询
      } catch (e) {
        console.log('  ⚠️  缓存文件损坏，将重新获取');
      }
    }

    // 如果缓存中没有，调用 API 获取单日信息
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

    const response = await fetch(`https://timor.tech/api/holiday/info/${dateStr}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API 返回状态: ${response.status}`);
    }

    const data = await response.json();

    // 解析节假日类型
    let factor = 1.0;
    let type = 'workday';
    let name = '';
    let isHoliday = false;
    let bufferInfo = '';

    if (data.code === 0 && data.type) {
      const typeCode = data.type.type;
      name = data.type.name || '';

      // type: 0=工作日, 1=周末, 2=节日, 3=调休
      switch (typeCode) {
        case 0: // 工作日
          factor = 1.0;
          type = 'workday';
          break;
        case 1: // 周末
          factor = 1.1;
          type = 'weekend';
          isHoliday = true;
          break;
        case 2: // 法定节日
          factor = 1.8; // 节日当天价格暴涨
          type = 'festival';
          isHoliday = true;
          break;
        case 3: // 调休（周末补班）
          factor = 1.2; // 调休工作日略贵
          type = 'adjusted';
          break;
      }
    }

    // ===== P1 增强：检查节假日缓冲期 =====
    // 如果当前日期不是节假日，检查前后2天是否有节假日
    if (!isHoliday && factor === 1.0) {
      const bufferFactor = await getHolidayBufferFactor(dateStr);
      if (bufferFactor.factor > 1.0) {
        factor = bufferFactor.factor;
        type = bufferFactor.type;
        name = bufferFactor.name;
        isHoliday = true;
        bufferInfo = bufferFactor.bufferInfo;
      }
    }

    const result = { factor, type, name, isHoliday, bufferInfo };

    // 更新缓存（异步执行，不阻塞）
    if (holidayData) {
      holidayData[dateStr] = result;
      fs.writeFile(cacheFile, JSON.stringify(holidayData, null, 2), () => {});
    } else {
      // 如果是第一次查询这一年，可以获取全年数据（异步）
      fetch(`https://timor.tech/api/holiday/year/${year}`)
        .then(res => res.json())
        .then(yearData => {
          if (yearData.holiday) {
            const cache = {};
            yearData.holiday.forEach(h => {
              // 假期包含多天
              if (Array.isArray(h.days)) {
                h.holiday && h.days.forEach(day => {
                  const dayKey = formatDate(new Date(day));
                  cache[dayKey] = { factor: 1.8, type: 'festival', name: h.name, isHoliday: true };
                });
              }
            });
            if (Object.keys(cache).length > 0) {
              fs.writeFile(cacheFile, JSON.stringify(cache, null, 2), () => {});
            }
          }
        })
        .catch(() => {});
    }

    return result;

  } catch (error) {
    console.log(`  ⚠️  节假日 API 调用失败: ${error.message}，使用基础计算逻辑`);

    // 降级到基础计算
    const date = new Date(dateStr);
    const day = date.getDay();
    const month = date.getMonth() + 1;

    // 简单周末判断
    if (day === 0 || day === 6) {
      return { factor: 1.1, type: 'weekend', name: '周末', isHoliday: true };
    }

    // 简单的节假日月份判断（不够精确，但作为兜底）
    const holidayMonths = [1, 2, 5, 10]; // 春节、国庆、五一、元旦
    if (holidayMonths.includes(month)) {
      return { factor: 1.3, type: 'holiday_season', name: '节日期间', isHoliday: true };
    }

    return { factor: 1.0, type: 'workday', name: '工作日', isHoliday: false };
  }
}

/**
 * P1 新增：获取节假日缓冲期系数（并发优化版）
 *
 * 检查指定日期前后2天是否有节假日，返回相应的缓冲期系数
 *
 * 性能优化：使用 Promise.all 并发请求，将 4 个串行请求（~12秒）优化为并发（~3秒）
 *
 * @param {string} dateStr - 格式 YYYY-MM-DD
 * @returns {Promise<Object>} - { factor: number, type: string, name: string, bufferInfo: string }
 */
async function getHolidayBufferFactor(dateStr) {
  const targetDate = new Date(dateStr);
  const checkOffsets = [-2, -1, 1, 2]; // 检查前后2天

  // 并发检查所有日期
  const checkPromises = checkOffsets.map(async (offset) => {
    const checkDate = new Date(targetDate);
    checkDate.setDate(checkDate.getDate() + offset);
    const checkDateStr = formatDate(checkDate);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`https://timor.tech/api/holiday/info/${checkDateStr}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();

        // 检查是否是节假日或调休
        if (data.code === 0 && data.type) {
          const typeCode = data.type.type;

          // type: 0=工作日, 1=周末, 2=节日, 3=调休
          if (typeCode === 2 || typeCode === 1) {
            // 找到节假日，计算缓冲期系数
            let factor = 1.0;
            let type = 'buffer';
            let name = data.type.name || '节假日';
            let bufferInfo = '';

            if (offset === -2) {
              factor = 1.3;
              bufferInfo = `节前2天 (${name}预热期)`;
            } else if (offset === -1) {
              factor = 1.5;
              bufferInfo = `节前1天 (${name}出行高峰)`;
            } else if (offset === 1) {
              factor = 1.2;
              bufferInfo = `节后1天 (${name}返程余温)`;
            }

            return { factor, type, name, bufferInfo, found: true };
          }
        }
      }
    } catch (e) {
      // 单个检查失败，返回未找到状态
      return { found: false };
    }

    return { found: false };
  });

  // 等待所有请求完成
  const results = await Promise.all(checkPromises);

  // 返回第一个找到的节假日结果
  for (const result of results) {
    if (result.found) {
      return { factor: result.factor, type: result.type, name: result.name, bufferInfo: result.bufferInfo };
    }
  }

  // 没有找到附近的节假日
  return { factor: 1.0, type: 'normal', name: '', bufferInfo: '' };
}

/**
 * 解析模糊日期表达式
 *
 * 支持的格式:
 * - 相对日期: 今天、明天、后天、大后天
 * - 本周: 这周一/二/.../日、本周末
 * - 下周: 下周一/二/.../日、下周末
 * - 本月: 本月中旬、本月底
 * - 下月: 下月初、下月中、下月底
 * - 节日: 清明节、劳动节、国庆节等
 * - 具体日期: 3月28日、2026-03-28、3.28
 *
 * @param {string} dateStr - 日期表达式
 * @returns {Date|null} - 解析后的日期对象
 */
function parseFuzzyDate(dateStr) {
  // 使用北京时间而非系统时间，避免时区偏差
  const now = getBeijingDate();
  const normalized = dateStr.toLowerCase().replace(/\s+/g, '');

  // ===== 相对日期 =====
  if (normalized === '今天') {
    return now;
  }

  if (normalized === '明天') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  if (normalized === '后天') {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return d;
  }

  if (normalized === '大后天') {
    const d = new Date(now);
    d.setDate(d.getDate() + 3);
    return d;
  }

  // ===== 本周 =====
  const thisWeekMatch = normalized.match(/这?周([一二三四五六七日天])/);
  if (thisWeekMatch || normalized === '这周末' || normalized === '本周末') {
    const days = ['一', '二', '三', '四', '五', '六', '七', '日', '天'];
    const targetDay = thisWeekMatch ? thisWeekMatch[1] : '六';

    let targetIndex;
    if (targetDay === '日' || targetDay === '天') {
      targetIndex = 6; // 周日
    } else if (targetDay === '六') {
      targetIndex = 5; // 周六
    } else {
      targetIndex = days.indexOf(targetDay); // 周一到周五
    }

    const currentDay = now.getDay(); // 0=周日, 1=周一, ..., 6=周六
    const currentDayMapped = currentDay === 0 ? 6 : currentDay - 1; // 转换为 0=周一, ..., 6=周日

    let daysUntil = targetIndex - currentDayMapped;
    if (daysUntil < 0) {
      // 目标日已过，返回 null 表示本周没有这个日了
      // 或者可以理解为下周？
      // 这里选择返回 null，让用户明确说"下周"
      return null;
    }

    const d = new Date(now);
    d.setDate(d.getDate() + daysUntil);
    return d;
  }

  // ===== 下周 =====
  const nextWeekMatch = normalized.match(/下周([一二三四五六七日天])/);
  if (nextWeekMatch || normalized === '下周末') {
    const days = ['一', '二', '三', '四', '五', '六', '七', '日', '天'];
    const targetDay = nextWeekMatch ? nextWeekMatch[1] : '六';

    let targetIndex;
    if (targetDay === '日' || targetDay === '天') {
      targetIndex = 6;
    } else if (targetDay === '六') {
      targetIndex = 5;
    } else {
      targetIndex = days.indexOf(targetDay);
    }

    const currentDay = now.getDay();
    const currentDayMapped = currentDay === 0 ? 6 : currentDay - 1;

    let daysUntil = targetIndex - currentDayMapped + 7;
    const d = new Date(now);
    d.setDate(d.getDate() + daysUntil);
    return d;
  }

  // ===== 下下周 =====
  const weekAfterNextMatch = normalized.match(/下下周([一二三四五六七日天])/);
  if (weekAfterNextMatch || normalized === '下下周末') {
    const days = ['一', '二', '三', '四', '五', '六', '七', '日', '天'];
    const targetDay = weekAfterNextMatch ? weekAfterNextMatch[1] : '六';

    let targetIndex;
    if (targetDay === '日' || targetDay === '天') {
      targetIndex = 6;
    } else if (targetDay === '六') {
      targetIndex = 5;
    } else {
      targetIndex = days.indexOf(targetDay);
    }

    const currentDay = now.getDay();
    const currentDayMapped = currentDay === 0 ? 6 : currentDay - 1;

    let daysUntil = targetIndex - currentDayMapped + 14;
    const d = new Date(now);
    d.setDate(d.getDate() + daysUntil);
    return d;
  }

  // ===== 本月/下月 =====
  if (normalized === '本月初' || normalized === '这个月初') {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }

  if (normalized === '本月中' || normalized === '这个月中旬') {
    return new Date(now.getFullYear(), now.getMonth(), 15);
  }

  if (normalized === '本月底' || normalized === '这个月底') {
    return new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }

  if (normalized === '下月初') {
    return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }

  if (normalized === '下月中' || normalized === '下月中旬') {
    return new Date(now.getFullYear(), now.getMonth() + 1, 15);
  }

  if (normalized === '下月底') {
    return new Date(now.getFullYear(), now.getMonth() + 2, 0);
  }

  // ===== 节假日（支持前/后X天）=====
  // 优先匹配组合表达式："清明节前的上个周六"、"国庆后第3天"等
  const holidayCombinations = [
    // 节日前的相对日期
    {
      pattern: /(.+?)前的上一个?(周一|周二|周三|周四|周五|周六|周日|周末)/,
      handler: (match) => {
        const holidayName = match[1];
        const targetWeekday = match[2];
        return { type: 'before_last_weekday', holiday: holidayName, weekday: targetWeekday };
      }
    },
    {
      pattern: /(.+?)前(的)?(\d+)天/,
      handler: (match) => {
        const holidayName = match[1];
        const daysBefore = parseInt(match[3]);
        return { type: 'before_days', holiday: holidayName, days: daysBefore };
      }
    },
    // 节日后的相对日期
    {
      pattern: /(.+?)后的下一个?(周一|周二|周三|周四|周五|周六|周日|周末)/,
      handler: (match) => {
        const holidayName = match[1];
        const targetWeekday = match[2];
        return { type: 'after_next_weekday', holiday: holidayName, weekday: targetWeekday };
      }
    },
    {
      pattern: /(.+?)后(的)?(\d+)天/,
      handler: (match) => {
        const holidayName = match[1];
        const daysAfter = parseInt(match[3]);
        return { type: 'after_days', holiday: holidayName, days: daysAfter };
      }
    }
  ];

  // 先尝试匹配组合表达式
  for (const combo of holidayCombinations) {
    const match = normalized.match(combo.pattern);
    if (match) {
      const params = combo.handler(match);

      // 查找对应的节日
      const holidays = {
        '元旦': '01-01',
        '春节': (y) => getSpringFestival(y),
        '清明节': '04-04',
        '劳动节': '05-01',
        '端午节': (y) => getDragonBoatFestival(y),
        '中秋节': (y) => getMidAutumnFestival(y),
        '国庆节': '10-01',
        '圣诞节': '12-25'
      };

      // 匹配节日名称（支持简写）
      let holidayDate = null;
      for (const [name, dateOrFunc] of Object.entries(holidays)) {
        if (params.holiday.includes(name) || name.includes(params.holiday)) {
          let year = now.getFullYear();
          if (typeof dateOrFunc === 'function') {
            holidayDate = dateOrFunc(year);
          } else {
            holidayDate = new Date(`${year}-${dateOrFunc}`);
          }

          // 如果今年已过，查询明年
          if (holidayDate < now) {
            year++;
            if (typeof dateOrFunc === 'function') {
              holidayDate = dateOrFunc(year);
            } else {
              holidayDate = new Date(`${year}-${dateOrFunc}`);
            }
          }
          break;
        }
      }

      if (!holidayDate) {
        continue; // 无法识别节日，尝试下一个模式
      }

      // 根据类型计算最终日期
      const result = new Date(holidayDate);

      if (params.type === 'before_last_weekday') {
        // 找到节日前的上一个指定星期几
        const weekdayMap = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 0, '周末': 6 };
        const targetDay = weekdayMap[params.weekday];
        const holidayDay = holidayDate.getDay();

        // 计算距离：从节日的星期几往回数，找到上一个目标星期几
        let daysBack = (holidayDay - targetDay + 7) % 7;
        if (daysBack === 0) daysBack = 7; // 如果当天就是目标星期几，取上一个（7天前）
        result.setDate(result.getDate() - daysBack);

      } else if (params.type === 'after_next_weekday') {
        // 找到节日后的下一个指定星期几
        const weekdayMap = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 0, '周末': 6 };
        const targetDay = weekdayMap[params.weekday];
        const holidayDay = holidayDate.getDay();

        let daysForward = (targetDay - holidayDay + 7) % 7;
        if (daysForward === 0) daysForward = 7; // 如果当天就是目标星期几，取下一个（7天后）
        result.setDate(result.getDate() + daysForward);

      } else if (params.type === 'before_days') {
        // 节日前X天
        result.setDate(result.getDate() - params.days);

      } else if (params.type === 'after_days') {
        // 节日后X天
        result.setDate(result.getDate() + params.days);
      }

      return result;
    }
  }

  // 如果没有匹配组合表达式，使用原有的简单节日匹配
  const holidays = {
    '元旦': '01-01',
    '春节': (y) => getSpringFestival(y), // 动态计算
    '清明节': '04-04', // 或 04-05，需要每年确认
    '劳动节': '05-01',
    '端午节': (y) => getDragonBoatFestival(y),
    '中秋节': (y) => getMidAutumnFestival(y),
    '国庆节': '10-01',
    '圣诞节': '12-25'
  };

  for (const [name, dateOrFunc] of Object.entries(holidays)) {
    if (normalized.includes(name)) {
      let holidayDate;
      if (typeof dateOrFunc === 'function') {
        holidayDate = dateOrFunc(now.getFullYear());
      } else {
        holidayDate = new Date(`${now.getFullYear()}-${dateOrFunc}`);
      }

      // 如果今年已过，查询明年
      if (holidayDate < now) {
        if (typeof dateOrFunc === 'function') {
          holidayDate = dateOrFunc(now.getFullYear() + 1);
        } else {
          holidayDate = new Date(`${now.getFullYear() + 1}-${dateOrFunc}`);
        }
      }

      return holidayDate;
    }
  }

  // ===== 具体日期格式 =====
  // YYYY-MM-DD 或 YYYY/MM/DD
  const fullDateMatch = normalized.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (fullDateMatch) {
    return new Date(fullDateMatch[1], fullDateMatch[2] - 1, fullDateMatch[3]);
  }

  // M月D日 或 M.D
  const shortDateMatch = normalized.match(/(\d{1,2})[月.](\d{1,2})日?/);
  if (shortDateMatch) {
    const month = parseInt(shortDateMatch[1]);
    const day = parseInt(shortDateMatch[2]);
    let year = now.getFullYear();

    // 如果日期已过，假设是明年
    const targetDate = new Date(year, month - 1, day);
    if (targetDate < now) {
      year++;
    }

    return new Date(year, month - 1, day);
  }

  return null;
}

/**
 * 获取春节日期（简化版，精确到年份）
 * 春节通常是农历正月初一，公历日期在 1月21日到2月20日之间浮动
 */
function getSpringFestival(year) {
  // 简化版：返回大致日期，实际应用建议使用农历转换库
  const springFestivalDates = {
    2024: '2024-02-10',
    2025: '2025-01-29',
    2026: '2026-02-17',
    2027: '2027-02-06',
    2028: '2028-01-26'
  };
  return new Date(springFestivalDates[year] || `${year}-02-10`);
}

/**
 * 获取端午节日期（农历五月初五）
 */
function getDragonBoatFestival(year) {
  const dates = {
    2024: '2024-06-10',
    2025: '2025-05-31',
    2026: '2026-06-19',
    2027: '2027-06-08',
    2028: '2028-05-27'
  };
  return new Date(dates[year] || `${year}-06-10`);
}

/**
 * 获取中秋节日期（农历八月十五）
 */
function getMidAutumnFestival(year) {
  const dates = {
    2024: '2024-09-17',
    2025: '2025-10-06',
    2026: '2026-09-25',
    2027: '2027-09-15',
    2028: '2028-10-03'
  };
  return new Date(dates[year] || `${year}-09-17`);
}

/**
 * 格式化日期为 YYYY-MM-DD
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 解析用户输入的查询 - 增强版
 *
 * 支持的查询格式:
 * - "深圳到青岛下周五的机票"
 * - "查清明节去北京的直飞航班"
 * - "下周飞成都，什么时候买最便宜"
 * - "5月份去上海，哪个平台最便宜"
 *
 * @param {string} query - 用户输入的查询
 * @returns {Object} - 解析结果 { from, to, date, targetPrice, type, options }
 */
async function parseQuery(query) {
  const result = {
    from: null,
    to: null,
    date: null,
    targetPrice: null,
    type: 'query',
    options: {
      directOnly: false,  // 只要直飞
      preferredTime: null,  // 偏好时间 (morning/afternoon/evening)
      holidayFactor: null   // 节假日价格系数
    }
  };

  // ===== 1. 提取航班选项 =====

  // 直飞过滤
  result.options.directOnly = query.includes('直飞') && !query.includes('中转');

  // 时间偏好
  if (query.includes('上午') || query.includes('早上')) {
    result.options.preferredTime = 'morning';
  } else if (query.includes('下午')) {
    result.options.preferredTime = 'afternoon';
  } else if (query.includes('晚上') || query.includes('夜间')) {
    result.options.preferredTime = 'evening';
  }

  // ===== 2. 提取出发地和目的地 =====

  const cities = Object.keys(AIRPORT_MAP);
  const foundCities = [];

  // 查找所有出现的城市
  for (const city of cities) {
    if (query.includes(city)) {
      foundCities.push({ city, code: AIRPORT_MAP[city], index: query.indexOf(city) });
    }
  }

  // 按在查询中出现的位置排序
  foundCities.sort((a, b) => a.index - b.index);

  if (foundCities.length >= 2) {
    result.from = foundCities[0].code;
    result.to = foundCities[1].code;
  } else if (foundCities.length === 1) {
    // 只找到一个城市，检查连接词
    const parts = query.split(/[到至去]/);
    if (parts.length === 2) {
      result.from = foundCities[0].code;
      // 尝试从第二部分提取城市
      for (const city of cities) {
        if (parts[1].includes(city)) {
          result.to = AIRPORT_MAP[city];
          break;
        }
      }
    }
  }

  // ===== 3. 提取日期 =====

  // 首先尝试匹配标准日期格式
  const standardDateMatch = query.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})|(\d{1,2})月(\d{1,2})日/);
  if (standardDateMatch) {
    if (standardDateMatch[1]) {
      // YYYY-MM-DD 格式
      result.date = `${standardDateMatch[1]}-${standardDateMatch[2].padStart(2, '0')}-${standardDateMatch[3].padStart(2, '0')}`;
    } else {
      // M月D日 格式
      const year = new Date().getFullYear();
      const month = parseInt(standardDateMatch[4]);
      const day = parseInt(standardDateMatch[5]);
      let targetDate = new Date(year, month - 1, day);

      // 如果日期已过，假设是明年
      if (targetDate < new Date()) {
        targetDate = new Date(year + 1, month - 1, day);
      }

      result.date = formatDate(targetDate);
    }
  } else {
    // 尝试模糊日期匹配
    const fuzzyDatePatterns = [
      /今天|明天|后天|大后天/,
      /这周|本周|下周末|下周|下下周/,
      /本月底|本月中|本月初|下月底|下月中|下月初/,
      /元旦|春节|清明节?|劳动节|端午节?|中秋节?|国庆节|圣诞节/,
      /月底|月中|月初/  // 默认为本月
    ];

    let matchedPattern = null;
    for (const pattern of fuzzyDatePatterns) {
      if (pattern.test(query)) {
        matchedPattern = pattern;
        break;
      }
    }

    if (matchedPattern) {
      const parsedDate = parseFuzzyDate(query.match(matchedPattern)?.[0] || '');
      if (parsedDate) {
        result.date = formatDate(parsedDate);

        // 如果是节假日，异步获取节假日信息
        if (matchedPattern.toString().includes('元旦|春节|清明节?|劳动节|端午节?|中秋节?|国庆节|圣诞节')) {
          // 这将在后续异步处理
        }
      }
    }
  }

  // 如果没有找到日期，默认为今天
  if (!result.date) {
    result.date = formatDate(new Date());
  }

  // ===== 4. 提取目标价格 =====

  const priceMatch = query.match(/(\d+)元|目标价?\s*:?\s*(\d+)|(\d+)以内|低于(\d+)/);
  if (priceMatch) {
    result.targetPrice = parseInt(priceMatch[1] || priceMatch[2] || priceMatch[3] || priceMatch[4]);
    result.type = 'monitor';
  }

  // ===== 5. 检查是否是监控请求 =====

  if (query.includes('监控') || query.includes('追踪') || query.includes('提醒') || query.includes('什么时候')) {
    result.type = 'monitor';
  }

  // ===== 6. 异步获取节假日信息（不影响主流程） =====

  // 不阻塞主流程，在后台获取
  getHolidayFactor(result.date).then(holidayInfo => {
    result.options.holidayFactor = holidayInfo;
    if (holidayInfo.isHoliday) {
      console.log(`  🎭 ${result.date} 是 ${holidayInfo.name}，价格系数: ${holidayInfo.factor}`);
    }
  }).catch(() => {
    // 静默失败，不影响主流程
  });

  return result;
}

/**
 * 生成搜索 URL
 */
function generateSearchURL(platform, from, to, date) {
  const baseUrls = {
    qunar: `https://m.flight.qunar.com/otn/roundtrip/flight?departCode=${from}&arriveCode=${to}&departDate=${date}`,
    ctrip: `https://m.ctrip.com/webapp/flight/flightone?dcity=${from}&acity=${to}&date=${date}`,
    fliggy: `https://m.fliggy.com/flight/index.htm?departureCity=${from}&arrivalCity=${to}&departDate=${date}`,
    zhixing: `https://m.zhixing.com/flight/list?departCity=${from}&arriveCity=${to}&departDate=${date}`
  };
  return baseUrls[platform] || baseUrls.qunar;
}

/**
 * 生成比价报告 - 增强版
 */
async function generateReport(from, to, date, platforms, prices, options = {}) {
  const today = new Date().toLocaleDateString('zh-CN');
  const daysUntil = Math.ceil((new Date(date) - new Date()) / (1000 * 60 * 60 * 24));

  // 获取节假日信息
  const holidayInfo = await getHolidayFactor(date);

  // 平台名称映射
  const platformNames = {
    'qunar': '去哪儿',
    'ctrip': '携程',
    'fliggy': '飞猪',
    'zhixing': '智行'
  };

  let report = `
┌─────────────────────────────────────────────────┐
│            航班价格查询报告                        │
├─────────────────────────────────────────────────┤
│  航线:   ${from} → ${to}                           │
│  日期:   ${date}${holidayInfo.isHoliday ? ` (${holidayInfo.name})` : ''}            │
│  查询时间: ${today}                            │
│  距离出发: ${daysUntil} 天                           │`;

  // 显示节假日预警
  if (holidayInfo.isHoliday && holidayInfo.factor > 1.0) {
    report += `│  ⚠️  节假日系数: ${holidayInfo.factor}x (价格可能上涨)         │`;
  }

  report += `├─────────────────────────────────────────────────┤`;

  // 显示过滤选项
  if (options.directOnly) {
    report += `│  筛选:   直飞航班                                  │`;
  }
  if (options.preferredTime) {
    const timeMap = { morning: '上午', afternoon: '下午', evening: '晚上' };
    report += `│  筛选:   ${timeMap[options.preferredTime]}起飞                │`;
  }

  report += `│  📊 全网价格对比:                                 │`;

  if (prices.length > 0) {
    prices.forEach((item, index) => {
      const platformName = platformNames[item.platform] || item.platform;
      const rank = index === 0 ? '⭐ 最低价' : `   ${index + 1}.`;
      report += `│    ${rank} ${platformName.padEnd(8)} ¥${item.price.toString().padStart(4)}  ${item.url ? '🔗' : '   '}  │\n`;
    });
  } else {
    report += `│    暂无实时价格数据 - 请尝试手动访问以下平台:       │\n`;
  }

  report += '│                                                 │\n';
  report += '│  🔗 快速访问链接:                                │\n';

  platforms.forEach(p => {
    const url = generateSearchURL(p, from, to, date);
    const platformName = platformNames[p] || p;
    report += `│    • ${platformName.padEnd(8)} ${url.substring(0, 40)}...  │\n`;
  });

  report += '│                                                 │\n';
  report += '│  💡 建议:                                       │\n';

  if (prices.length > 0) {
    const lowest = prices[0];
    const priceDiff = prices[prices.length - 1].price - lowest.price;
    report += `│    当前${platformNames[lowest.platform] || lowest.platform}价格最低，比最高价省 ¥${priceDiff}       │\n`;

    // 基于节假日和天数的建议
    if (holidayInfo.isHoliday && holidayInfo.factor >= 1.5) {
      report += `│    ⚠️  正值${holidayInfo.name}期间，建议尽快预订               │\n`;
    } else if (daysUntil > 30) {
      report += `│    距离出发还有${daysUntil}天，建议继续关注价格变化            │\n`;
    } else if (daysUntil > 14) {
      report += `│    距离出发${daysUntil}天，进入最佳预订窗口期               │\n`;
    } else if (daysUntil > 7) {
      report += `│    距离出发${daysUntil}天，价格可能开始上涨，建议近期预订        │\n`;
    } else {
      report += `│    距离出发仅${daysUntil}天，建议尽快购买                      │\n`;
    }
  } else {
    report += `│    由于反爬虫限制，建议直接点击上方链接查看           │\n`;
    report += `│    移动端页面通常有更好的价格和优惠                   │\n`;
  }

  report += '└─────────────────────────────────────────────────┘\n';

  return report;
}

/**
 * 主处理函数 - 增强版
 *
 * 使用 Microsoft Playwright MCP 抓取实时价格
 */
export async function handleFlightQuery(query, mcpTools = null) {
  console.log('\n🔍 正在解析查询...\n');

  const parsed = await parseQuery(query);

  if (!parsed.from || !parsed.to) {
    return '❌ 无法识别出发地或目的地，请提供完整的城市名称。\n\n示例: "查深圳到青岛今天的机票价格"';
  }

  console.log(`✈️  航线: ${parsed.from} → ${parsed.to}`);
  console.log(`📅 日期: ${parsed.date}`);
  console.log(`🎯 类型: ${parsed.type === 'monitor' ? '价格监控' : '一次性查询'}`);
  if (parsed.targetPrice) {
    console.log(`💰 目标价: ¥${parsed.targetPrice}`);
  }
  if (parsed.options.directOnly) {
    console.log(`🎯 筛选: 只要直飞`);
  }
  if (parsed.options.preferredTime) {
    const timeMap = { morning: '上午', afternoon: '下午', evening: '晚上' };
    console.log(`🕐 时间偏好: ${timeMap[parsed.options.preferredTime]}`);
  }

  // 平台列表和 URL 映射
  const platforms = ['qunar', 'ctrip', 'fliggy', 'zhixing'];

  // 如果有 Playwright MCP 工具，尝试抓取价格
  let prices = [];

  if (mcpTools) {
    console.log('\n🌐 使用 Microsoft Playwright MCP 抓取实时价格...\n');

    // 平台轮换策略：每次随机打乱前3个平台
    const shuffledPlatforms = [...platforms];
    const top3 = shuffledPlatforms.splice(0, 3);
    top3.sort(() => Math.random() - 0.5);
    platforms.unshift(...top3);

    try {
      // 构建 URL 映射（过滤掉被限流的平台）
      const platformURLs = {};
      for (const platform of [...new Set(platforms)]) { // 去重
        // 检查请求频率限制
        const limitCheck = globalLimiter.canMakeRequest(platform);
        if (!limitCheck.allowed) {
          console.log(`  ⏳ ${platform} ${limitCheck.reason}`);
          continue;
        }

        const requestCount = globalLimiter.getRequestCount(platform);
        console.log(`  ✅ ${platform} 可以抓取 (最近1小时: ${requestCount}/${globalLimiter.maxRequests}次)`);
        platformURLs[platform] = generateSearchURL(platform, parsed.from, parsed.to, parsed.date);
      }

      if (Object.keys(platformURLs).length === 0) {
        console.log('\n⚠️  所有平台都处于频率限制中，请稍后再试\n');
      } else {
        // 使用包装器抓取所有平台（快速失败策略）
        const results = await scrapeMultiplePlatforms(mcpTools, platformURLs);

        // 处理结果
        for (const result of results) {
          if (result.success && result.prices && result.prices.length > 0) {
            const lowestPrice = Math.min(...result.prices);
            prices.push({
              platform: result.platform,
              price: lowestPrice,
              url: result.url,
              allPrices: result.prices
            });
          }
        }

        // 按价格排序
        prices.sort((a, b) => a.price - b.price);
      }

    } catch (error) {
      console.log(`\n⚠️  抓取过程出错: ${error.message}`);
      console.log('💡 将提供直接访问链接作为替代方案\n');
    }
  } else {
    console.log('\n⚠️  未检测到 Playwright MCP 工具');
    console.log('💡 建议: 安装 Microsoft Playwright MCP 以获取实时价格\n');
    console.log('   安装命令: claude mcp add playwright npx @playwright/mcp@latest');
  }

  // 生成报告
  const report = await generateReport(parsed.from, parsed.to, parsed.date, platforms, prices, parsed.options);

  return report;
}

/**
 * 动态间隔计算 - 阶梯频率控制策略
 *
 * 为避免触发反爬封禁，同时兼顾价格变动的时效性，采用以下策略：
 *
 * 时间段加权:
 * - 深夜 (01:00 - 06:00): 3小时 - 变动极小，降低频率
 * - 高峰 (09:00 - 18:00): 1小时 - 变动剧烈，保持高频
 * - 其他时段: 2小时 - 标准频率
 *
 * 临行前加频:
 * - < 3天: 30分钟 - 库存变动频繁，价格波动剧烈
 * - 3-7天: 1小时 - 需要密切关注
 * - 7-15天: 2小时 - 标准监控
 * - > 15天: 3小时 - 低频监控即可
 *
 * @param {string} flightDate - 航班日期 (YYYY-MM-DD)
 * @returns {number} 间隔时间（毫秒）
 */
function getDynamicInterval(flightDate) {
  const hour = new Date().getHours();

  // ===== 时间段加权策略 =====
  let timeBasedInterval;
  if (hour >= 1 && hour < 6) {
    // 深夜时段 (01:00 - 06:00)：变动极小，降低频率
    timeBasedInterval = 3 * 60 * 60 * 1000; // 3小时
  } else if (hour >= 9 && hour < 18) {
    // 高峰时段 (09:00 - 18:00)：变动剧烈，保持高频
    timeBasedInterval = 1 * 60 * 60 * 1000; // 1小时
  } else {
    // 其他时段：标准频率
    timeBasedInterval = 2 * 60 * 60 * 1000; // 2小时
  }

  // ===== 临行前加频策略 =====
  const daysUntilFlight = getDaysUntil(flightDate);

  let daysBasedInterval;
  if (daysUntilFlight < 3) {
    // 距离出发 < 3 天：库存变动频繁，价格波动剧烈
    daysBasedInterval = 30 * 60 * 1000; // 30分钟
  } else if (daysUntilFlight < 7) {
    // 距离出发 3-7 天：需要密切关注
    daysBasedInterval = 1 * 60 * 60 * 1000; // 1小时
  } else if (daysUntilFlight < 15) {
    // 距离出发 7-15 天：标准监控
    daysBasedInterval = 2 * 60 * 60 * 1000; // 2小时
  } else {
    // 距离出发 > 15 天：低频监控即可
    daysBasedInterval = 3 * 60 * 60 * 1000; // 3小时
  }

  // ===== 取两者中较短的间隔（优先保证临行前的高频）=====
  return Math.min(timeBasedInterval, daysBasedInterval);
}

/**
 * 计算距离航班出发的天数（使用北京时间）
 * @param {string} flightDate - 航班日期 (YYYY-MM-DD)
 * @returns {number} 天数（可为负数表示已过期）
 */
function getDaysUntil(flightDate) {
  const flight = new Date(flightDate);
  const today = getBeijingDate();
  today.setHours(0, 0, 0, 0);
  flight.setHours(0, 0, 0, 0);
  return Math.ceil((flight - today) / (1000 * 60 * 60 * 24));
}

/**
 * 格式化时间间隔为可读字符串
 * @param {number} ms - 毫秒数
 * @returns {string} 格式化后的字符串
 */
function formatInterval(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.round(minutes / 60);
  return `${hours}小时`;
}

/**
 * 获取当前时段描述
 * @returns {string} 时段描述
 */
function getCurrentTimeSlot() {
  const hour = new Date().getHours();
  if (hour >= 1 && hour < 6) return '深夜 (变动极小)';
  if (hour >= 6 && hour < 9) return '早晨 (标准)';
  if (hour >= 9 && hour < 12) return '上午高峰';
  if (hour >= 12 && hour < 14) return '午间 (标准)';
  if (hour >= 14 && hour < 18) return '下午高峰';
  if (hour >= 18 && hour < 22) return '晚间 (标准)';
  return '深夜 (变动极小)';
}

/**
 * 监控模式处理器 - 增强版（支持动态频率和内存泄漏防护）
 *
 * @param {string} from - 出发地机场代码
 * @param {string} to - 目的地机场代码
 * @param {string} date - 航班日期 (YYYY-MM-DD)
 * @param {number} targetPrice - 目标价格
 * @param {number} baseInterval - 基础间隔（毫秒），会被动态策略覆盖
 * @param {Function} onPriceUpdate - 价格更新回调函数
 * @returns {Object} 监控对象
 */
export async function startMonitoring(from, to, date, targetPrice, baseInterval = 3600000, onPriceUpdate = null) {
  const monitorId = `${from}-${to}-${date}`;

  // 检查是否已存在监控，如果存在则先清理
  const isNew = globalMonitorManager.register(monitorId, {
    from,
    to,
    date,
    targetPrice,
    onPriceUpdate
  });

  if (!isNew) {
    console.log(`  🔄 检测到已存在的监控，已重置计时器`);
  }

  // 获取节假日信息
  const holidayInfo = await getHolidayFactor(date);

  // 计算动态间隔
  const dynamicInterval = getDynamicInterval(date);
  const daysUntil = getDaysUntil(date);

  console.log(`\n✅ 监控已启动！`);
  console.log(`   ID: ${monitorId}`);
  console.log(`   航线: ${from} → ${to}`);
  console.log(`   日期: ${date}${holidayInfo.isHoliday ? ` (${holidayInfo.name})` : ''}`);
  console.log(`   目标价: ¥${targetPrice}`);
  console.log(`   距离出发: ${daysUntil} 天`);
  console.log(`   当前时段: ${getCurrentTimeSlot()}`);
  console.log(`   📊 动态频率: ${formatInterval(dynamicInterval)}/次`);

  if (holidayInfo.isHoliday && holidayInfo.factor > 1.0) {
    console.log(`   ⚠️  节假日系数: ${holidayInfo.factor}x，价格可能偏高`);
  }

  console.log(`\n   💡 策略说明:`);
  console.log(`      • 深夜时段降至3小时/次，高峰保持1小时/次`);
  console.log(`      • 临行前<3天自动提升至30分钟/次`);
  console.log(`      • 重复启动会自动清理旧计时器，防止内存泄漏`);
  console.log();

  /**
   * 调度下次检查
   */
  const scheduleNextCheck = async () => {
    // 检查监控是否已被注销
    if (!globalMonitorManager.has(monitorId)) {
      console.log(`  ⏹️  监控 ${monitorId} 已停止`);
      return;
    }

    // 计算动态间隔
    const interval = getDynamicInterval(date);
    const nextCheckTime = new Date(Date.now() + interval);

    console.log(`📅 [${monitorId}] 下次检查: ${nextCheckTime.toLocaleString('zh-CN')} (${formatInterval(interval)})`);

    // 设置定时器
    const intervalId = setTimeout(async () => {
      try {
        // 更新动态间隔
        const newInterval = getDynamicInterval(date);

        console.log(`\n🔍 [${monitorId}] 开始检查价格...`);
        console.log(`   当前策略: ${formatInterval(newInterval)}/次`);

        // TODO: 实际执行价格检查逻辑
        // 这里需要调用 handleFlightQuery 或类似函数获取实时价格
        // const result = await handleFlightQuery(`${from}到${to}${date}的机票`, mcpTools);

        // 如果有回调函数，调用它
        if (onPriceUpdate) {
          // await onPriceUpdate({ /* 价格数据 */ });
        }

        // 递归调度下次检查
        await scheduleNextCheck();

      } catch (error) {
        console.error(`❌ [${monitorId}] 检查出错: ${error.message}`);

        // 即使出错也继续调度（除非监控已停止）
        if (globalMonitorManager.has(monitorId)) {
          await scheduleNextCheck();
        }
      }
    }, interval);

    // 保存计时器 ID 以便后续清理
    globalMonitorManager.setIntervalId(monitorId, intervalId);
  };

  // 启动第一次调度
  scheduleNextCheck();

  // 返回增强的监控对象
  const monitor = {
    id: monitorId,
    from,
    to,
    date,
    targetPrice,
    baseInterval,
    currentInterval: dynamicInterval,
    status: 'running',
    start: new Date().toISOString(),
    holidayInfo,
    daysUntil,

    /**
     * 停止监控
     */
    stop() {
      const stopped = globalMonitorManager.unregister(this.id);
      if (stopped) {
        this.status = 'stopped';
        console.log(`⏹️  监控 ${this.id} 已停止`);
      }
      return stopped;
    },

    /**
     * 获取下次检查时间
     * @returns {Date} 下次检查时间
     */
    getNextCheckTime() {
      return new Date(Date.now() + this.currentInterval);
    },

    /**
     * 更新动态间隔（每次检查时调用）
     * @returns {number} 新的间隔时间
     */
    updateInterval() {
      this.currentInterval = getDynamicInterval(this.date);
      this.daysUntil = getDaysUntil(this.date);
      return this.currentInterval;
    },

    /**
     * 获取当前策略说明
     * @returns {string} 策略说明
     */
    getStrategyInfo() {
      const interval = formatInterval(this.currentInterval);
      const timeSlot = getCurrentTimeSlot();
      const days = this.daysUntil;

      let strategy = `当前: ${interval}/次 (${timeSlot})`;
      if (days < 3) {
        strategy += ` | 临行前: 高频监控 (剩余${days}天)`;
      } else if (days > 15) {
        strategy += ` | 远期: 低频监控 (剩余${days}天)`;
      }
      return strategy;
    }
  };

  return monitor;
}

/**
 * 导出函数和类供外部使用
 */
export {
  getHolidayFactor,
  parseFuzzyDate,
  formatDate,
  RequestLimiter,
  globalLimiter,
  MonitorManager,
  globalMonitorManager,
  getBeijingDate,
  getBeijingTimestamp
};

// 如果直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  const query = process.argv.slice(2).join(' ') || '深圳到青岛下周五的机票';
  handleFlightQuery(query).then(console.log).catch(console.error);
}
