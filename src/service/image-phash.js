// 感知哈希 pHash（表情包同图识别，2026-11-26 表情库计划）：
//   解码：Windows 内置 System.Drawing（PowerShell 子进程，见 image-decode.ps1）——
//         node 无内置图片解码器，纯 JS 解 JPEG 不现实；零 npm 依赖约束下的务实解。
//         透明底固定平铺白色（表情库预处理关键，见 ps1 头注释）；GIF 取首帧。
//   哈希：32×32 灰度 → 2D DCT-II（行列分离两次 1D DCT）→ 左上 8×8 低频块
//         （跳过 DC 分量，63 位）→ 中位数阈值二值化 → 十六进制串。
//   匹配：hamming(a, b) 逐位异或计数。判定口径：距离 ≤6 确认同款；
//         7~12 候选区（不自动合并，继续走识图）；同模板不同文字通常 ≥10 天然分开。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DECODE_PS1 = fileURLToPath(new URL('./image-decode.ps1', import.meta.url));
const N = 32;
const SIZE = N * N;

// 1D DCT-II 余弦表：COS[u][x] = cos(pi*(2x+1)*u / (2N))
const COS = Array.from({ length: N }, (_, u) =>
  Array.from({ length: N }, (_, x) => Math.cos((Math.PI * (2 * x + 1) * u) / (2 * N))));

function dct2d(gray) {
  const tmp = new Float64Array(SIZE);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += gray[y * N + x] * COS[u][x];
      tmp[y * N + u] = s;
    }
  }
  const out = new Float64Array(SIZE);
  for (let x = 0; x < N; x++) {
    for (let v = 0; v < N; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += tmp[y * N + x] * COS[v][y];
      out[v * N + x] = s;
    }
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function hashFromGray(gray) {
  const freq = dct2d(gray);
  const low = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      if (v === 0 && u === 0) continue; // DC 分量无判别力
      low.push(freq[v * N + u]);
    }
  }
  const med = median(low);
  let bits = 0n;
  for (let i = 0; i < low.length; i++) if (low[i] > med) bits |= (1n << BigInt(i));
  return bits.toString(16).padStart(16, '0');
}

function parseGray(stdout) {
  const [header, csv] = stdout.trim().split(/\r?\n/);
  const [, w, h] = /^(\d+)x(\d+)$/.exec(header) ?? [];
  if (!w) throw new Error(`phash decode: bad header ${header}`);
  const parts = csv.split(',');
  if (parts.length !== SIZE) throw new Error(`phash decode: expected ${SIZE} values, got ${parts.length}`);
  return {
    width: Number(w),
    height: Number(h),
    gray: Float64Array.from(parts, (v) => Number(v)),
  };
}

/** 计算图片文件 pHash（16 位十六进制）。解码失败返回 null（调用方继续走正常识图流程）。 */
export function phashFromFile(filePath) {
  let stdout;
  try {
    stdout = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DECODE_PS1, String(filePath),
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  } catch {
    return null;
  }
  try {
    const { width, height, gray } = parseGray(stdout);
    return { hash: hashFromGray(gray), width, height };
  } catch {
    return null;
  }
}

/** 便捷：buffer 直算（调用方自备临时路径写盘——解码器按文件路径工作）。 */
export function phashFromBuffer(buffer, tempPath) {
  return phashFromFile(tempPath);
}

/** 汉明距离：两个 16 位十六进制 pHash 的逐位差异位数。任一为空返回 Infinity。 */
export function hamming(hexA, hexB) {
  if (!hexA || !hexB) return Infinity;
  try {
    let diff = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
    let count = 0;
    while (diff) { count += Number(diff & 1n); diff >>= 1n; }
    return count;
  } catch {
    return Infinity;
  }
}

/** 判定口径常量：≤6 确认同款（自动归并）；7~12 候选区（仅提示，不合并）。 */
export const PHASH_CONFIRM_DISTANCE = 6;
export const PHASH_CANDIDATE_DISTANCE = 12;

/** 供测试与调试：直接对灰度阵算哈希。 */
export function phashFromGrayValues(values) {
  if (values.length !== SIZE) throw new Error(`expected ${SIZE} gray values`);
  return hashFromGray(Float64Array.from(values, Number));
}

/** 读取 ps1 脚本自检（测试用：确认解码器文件随包存在）。 */
export function decoderScriptExists() {
  try { readFileSync(DECODE_PS1); return true; } catch { return false; }
}
