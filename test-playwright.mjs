#!/usr/bin/env node

/**
 * Playwright MCP 测试脚本
 * 用于验证 Playwright MCP 是否正常工作
 */

import { spawn } from 'child_process';

// 测试函数：检查 Playwright MCP 是否可用
async function testPlaywrightMCP() {
  console.log('🔍 检查 Playwright MCP 状态...\n');

  // 检查 MCP 服务器列表
  const mcpList = spawn('claude', ['mcp', 'list']);
  let output = '';

  for await (const chunk of mcpList.stdout) {
    output += chunk.toString();
  }

  await new Promise((resolve) => mcpList.on('close', resolve));

  console.log('MCP 服务器状态:');
  console.log(output);

  if (output.includes('playwright')) {
    console.log('\n✅ Playwright MCP 已安装并连接！');
    console.log('\n接下来你可以在 Claude 中使用以下命令:');
    console.log('  "查深圳到青岛今天的机票价格"');
    console.log('  "帮我监控北京到上海下周的机票，目标价500元"');
    console.log('  "广州到成都3月28日有直飞吗？多少钱"');
    return true;
  } else {
    console.log('\n⚠️  未检测到 Playwright MCP');
    console.log('\n请运行以下命令安装:');
    console.log('  claude mcp add playwright npx @playwright/mcp@latest');
    return false;
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  testPlaywrightMCP().catch(console.error);
}

export { testPlaywrightMCP };
