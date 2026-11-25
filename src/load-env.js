// load-env：零依赖 .env 装载器（2026-11-25）。
// 目的：MEMORY_MCP_* 配置项此前散在环境变量里无显性载体——进程重启后「配过什么
// 无从查证」。本模块在 start() 入口把 <dir>/.env 合入 process.env，让所有
// MEMORY_MCP_* 开关（含 MEMORY_MCP_MODEL_HUB_VISION_MODE）可在根目录 .env 显式
// 配置；.env 已 gitignore（可含密钥），模板见 .env.example。
// 优先级纪律：真实进程 env > .env > 代码默认值——.env 只补缺，不覆盖已显式
// 设置的变量（保证 setx 残留告警逻辑与一次性覆盖能力不变）。
import fs from 'node:fs';
import path from 'node:path';

/** 解析 .env 文本 → {KEY: value}。支持：# 注释、空行、KEY=VALUE、
 *  可选 export 前缀、成对单/双引号包裹（去引号不去转义）。 */
export function parseEnvText(text) {
  const out = {};
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 无 '=' 或 key 为空 → 跳过（宽松解析，不因坏行拒绝整个文件）
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (!quoted) {
      // 行内注释（dotenv 惯例）：非引号值中「空白+#」起视为注释截断；引号内的 # 是字面量。
      // 2026-11-26 修复：`KEY=vision-svc  # 说明` 曾把注释并入值，导致 ==='vision-svc' 判 false。
      const hashIdx = value.search(/\s#/);
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    } else {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 把 <dir>/.env 合入 process.env（只补缺：env 中已存在的键不动）。
 * 返回实际注入的键数组（供启动日志展示）；文件不存在返回 []。
 */
export function loadEnvFile(dir, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`[memory-mcp] .env 读取失败（忽略）：${error?.message ?? error}`);
    return [];
  }
  const parsed = parseEnvText(text);
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
