# 专用模型子服务计划（specialized-model-services-in-memory）

> 2026-11-25 落地版。状态：**阶段一代码全部完成、E2E 大部通过，仅剩克隆合成 E2E（内存阻塞）+ 阶段二外部识图**。
> 本文件是执行账本：改一处记一处，找得回来。

## 0. 用户裁定（不可回退的设计决策）

1. **图片识别 / 语音生成 / 语音识别是工具功能，不依赖 LLM**（视觉 LLM 兜底只是阶段一过渡）。
2. 这些服务**与 memory 同仓库**，作为 memory 的**子进程随启随管**（supervisor spawn，端口 127.0.0.1:18102/18103/18104）。
3. 发送多媒体拆成 **3 个工具**：`chat_image_send` / `chat_voice_send` / `chat_file_send`；`chat_media_send` 已退役删除（调用报明确指引错误）。网关侧按 kind 校验，平台格式转换由 bridge 适配。
4. **音频发送由 LLM 编排**：LLM 查 voice_bank（人设关键词匹配角色）→ 选角色+情绪 → 对应情绪参考音频 → GPT-SoVITS 克隆合成 → 发送。
5. **收藏详情表只收图片和语音**：
   - 语音**不保留源文件**（转写 ready 后源文件迁 `voice_lib/inbox/`，3 天内可被 LLM 归档为音色参考；详情表只留一条含转写文本的记录）；
   - 视频/其他文件**不保留源文件也不进详情表**（ensureAssets 直接跳过）。
6. 外部识图 API（SauceNAO / trace.moe / Cloudflare Workers AI）注册放**阶段二最后**，先用 LLM 视觉兜底。
7. 识图降级链（阶段二）：Cloudflare → HF → LLM 兜底；动漫域 SauceNAO/trace.moe 双轨 ≥80% 命中判定。

## 1. 代码落点（全部已实现）

| 文件 | 职责 |
|---|---|
| `subprocesses/asr-svc/server.mjs` | SenseVoice int8（sherpa-onnx-node）转写子服务，端口 18102，`/health`（带 pid）、`/transcribe`（Bearer 鉴权）；10s 音频→1.1s |
| `subprocesses/tts-svc/server.mjs` | GPT-SoVITS v2pro 按需 spawn 适配器，端口 18103；spawn `runtime/python.exe api_v2.py -c GPT_SoVITS/configs/memhub-tts.yaml`；空闲 10min 自动退出；内存水位保护（`memFreeRatio`，触发返回 `E_BUSY`） |
| `subprocesses/vision-svc/` | 阶段一薄适配骨架（LLM 兜底），阶段二填外部聚合 |
| `src/service/model-supervisor.js` | 子进程监管：spawn + 指数退避重启（cap 5）+ **pid 校验健康探活**（防孤儿假 ready）+ httpPostJson 带 Authorization；`createMediaModelAdapter`（与 llmProvider 同形状注入 analyzer） |
| `src/service/voice-synth.js` | `chat_voice_synthesize` 异步 worker：submit → pending 语音资产（ma_ id 占位）→ 队列 → hub.synthesize → wav 落 `voice_lib/` → 详情表 ready；`state/data/voice_bank.json` 读导（角色→关键词→情绪→参考音频+prompt 文本） |
| `src/service/media-analyzer.js` | voice→ASR 转写+瘦身、image→LLM 兜底（desc 带 `via-llm-fallback` tag）、video/file→不登记；FAILED 原因入日志 |
| `src/service/media-service.js` | ensureAssets 跳过 video/file；资产迁移 `voice_lib/inbox/` |
| `src/server.mjs` | modelHub + mediaLlm + voiceSynth 装配；shutdown 顺序：hub 子进程先停 |
| `subprocesses/tts-svc/tts.config.json` | gsvDir=`models/gpt-sovits/GPT-SoVITS-v2pro-20250604`、yaml=`GPT_SoVITS/configs/memhub-tts.yaml`（v2ProPlus 预设：t2s=s1v3.ckpt、vits=s2Gv2ProPlus.pth、cpu）、`memFreeRatio: 0.08`（临时，验证后回调 0.15） |
| `llm.config.json` | `audio.libDir = C:/qq-bridge/bridge/audio`（voice_lib 即 bridge 音频目录） |
| `scripts/` | media-send 专项测试（三工具）+ 全量回归 |

## 2. 已验证 ✅

- supervisor 随 memory 7181 spawn asr-svc，日志 `[model-hub] asr ready (port 18102, pid …)`（pid 校验版）
- 语音 E2E：pending → ready，转写逐字准确，源文件迁 `voice_lib/inbox/ma_e2e000000001.wav`
- 图片 E2E：`deepseek娘.png` → LLM 兜底描述精准 + `via-llm-fallback` 入库
- 三发送工具在网关日志就绪：`media-send ready: chat_image_send / chat_voice_send / chat_file_send`
- memory `npm test` 全绿 + 网关测试全绿（media-analyzer / media-select / gateway-v1 / gateway-watch 等）
- python asr 8001 已退役（Node 版全链替代）

## 3. 测试揪出的真实缺陷（修完，防复发）

1. `resolveLlmConfig`（server.mjs）曾丢弃 audio/video 子块 → 语音全部 no-audio-data。已透传。
2. supervisor `httpPostJson` 曾不带 Authorization → 全 401。已加 Bearer。
3. 健康探活不校验 pid → 孤儿子服务占端口假 ready（SIGKILL 重启必现）。已 pid 匹配；重启 memory 需手动清孤儿 asr-svc。
4. 测试进程多次 `hub.start()` 造成端口冲突风暴 → withApi 现显式 `MEMORY_MCP_MODEL_HUB_ASR=0`。
5. `renderPlaceholders` 误删无源文件的语音详情记录 → 已兼容瘦身语义。

## 4. 克隆合成 E2E ✅（2026-11-25 收尾）

- GPT-SoVITS v2ProPlus（`models/gpt-sovits/`，13.2GB）zero-shot 克隆打通：9.5s 参考音频（3~10s 限制，test-hello 截断为 `ref-test-9s.wav`）→ **62s CPU 合成** → ASR 回环可懂（「克隆」被 SenseVoice 听成同音「贺隆」，属罕见词识别误差，非合成缺陷）。
- 适配过程修了 3 处：api_v2.py 走 `-c memhub-tts.yaml`（不收 -s/-g）；端点 POST `/tts`；字段名 `ref_audio_path/text_lang/prompt_lang`（Pydantic TTS_Request）。
- `MEMORY_MCP_MODEL_HUB_TTS` **默认 1**（GPT-SoVITS 就位后），=0 显式关闭；测试回归全绿（server 级测试 hub 启动正常）。
- `memFreeRatio` 恢复 0.15（内存 <15% 时 E_BUSY，客户端稍后重试）。
- python tts 8002 已退役；C:\ai-services 全部退出（asr 8001 先前已退）。
- 剩最后一步用户侧 E2E：DSH 模型在 QQ 对话里调 `chat_voice_synthesize` → ready 后 `chat_voice_send` 发送。

## 5. 阶段二：外部识图（注册后接入）

> 2026-11-26 **已激活**（visionMode=vision-svc，.env 载体）：SauceNAO + Cloudflare key 已落 vision.config.json，trace.moe keyless 运行（IP 100 次/24h），HF 留空跳过。
> live-e2e PASS：公开动漫图直调 /recognize——首调 6.6s 命中（trace.moe：《東京レイヴンズ》第 24 话，相似度 80.4%；saucenao 并行轨计数+1 未夺分），二调 6ms 缓存零外调，usage-20261126.json 计数 saucenao:1/traceMoe:1 正确。
> 待补（可选）：trace.moe 免费 key（trace.moe/account 走 Google/GitHub OAuth，1,000 次/月）；HF token（可选第四源）。
> 2026-11-26 补：**照片域模型迁移**——`@cf/llava-1.5-7b-hf` 已被 Cloudflare 下架（7000 No route），provider 请求体改标准 messages 架构，模型换 `@cf/mistralai/mistral-small-3.1-24b-instruct`（账户可用 vision 模型实测：mistral 200 中文描述 / llama-3.2-11b-vision 403 无权限 / moondream schema 不匹配）。照片域 e2e PASS：合成图（动漫轨 no-hit 降级）7.7s 返回准确中文描述，via-cloudflare 标注 + cloudflare:1 计数正确。网络联通性验证：api.cloudflare.com 全链路直连正常（DNS/TCP/TLS/token），无需代理。

### 已落地（2026-11-25）

- `subprocesses/vision-svc/server.mjs`（端口 18104，Bearer MEMHUB_TOKEN，/health 带 pid）：POST /recognize 聚合链——24h SHA-256 磁盘缓存（state/vision-cache/<hash>.json，坏档静默重建）→ SauceNAO/trace.moe 双轨并行（相似度 ≥80% 判命中，取高分）→ Cloudflare Workers AI（llava，照片域）→ HuggingFace Inference（可选）→ ok:false 落回 LLM 兜底；每源日配额计数（usage-YYYYMMDD.json，跨日自动重置），超配额直接跳过；vision.config.json 懒加载（mtime 变化自动重读，注册 key 无需重启）
- `src/service/model-supervisor.js`：cfg.vision（enabled=visionMode==='vision-svc'，port 由 MEMORY_MCP_MODEL_HUB_VISION_PORT 配）+ start() spawn 分支 + visionReady getter + recognize()（Bearer 转发，失败 logger+ok:false）+ adapter.vision 重写——vision-svc 就绪优先转发，返回 `{text, source}`（source=saucenao/trace-moe/cloudflare/huggingface），未命中/不可用落回 llm.vision（source='llm-fallback'）；visionEnabled getter 放宽为 llm.vision 可用或 vision-svc 就绪
- `src/service/media-analyzer.js` image 分支：消费 {text,source} 对象（兼容裸字符串旧形态），tag 改按实际来源标注 via-saucenao/via-trace-moe/via-cloudflare/via-huggingface，LLM 兜底链尾仍 via-llm-fallback
- `scripts/test-vision-svc.mjs`：mock 四源 HTTP server + 聚合链场景用例（缓存命中/动漫双轨/照片 CF/HF/全败降级/配额跳过/坏缓存自愈）

### 激活日修复（2026-11-26）

- `src/load-env.js`：支持行内注释剥离（非引号值中「空白+#」截断，引号内 # 保留）——此前 `KEY=vision-svc  # 说明` 会把注释并值，模式开关静默失效
- `src/server.mjs`：model-hub 子服务 token 与 http-token 同源（`{...cfg.modelHub, token}`）——此前 supervisor 每次启动随机生成子服务 token，随重启轮换且无法外部探活
- `scripts/test-vision-svc.mjs`：配额用例日期改本地时区（与服务端 todayStamp 同口径）——UTC toISOString 在东八区 0-8 点差一天导致配额用例假失败

1. 注册三个免费 key：**Cloudflare Workers AI**（1 万 neurons/天，免信用卡）、**SauceNAO**（动漫溯源）、**trace.moe**（帧溯源）。
2. key 落 `vision.config.json`（gitignored 已有条目，模板见下）。
3. 切 `MEMORY_MCP_MODEL_HUB_VISION_MODE=vision-svc` 并重启 memory 7181（孤儿 asr-svc 清理见 §6）。
4. 识图三段流水线（LLM keep/skip 闸门 → 识图 → 落地）与「模型主动看图」`chat_image_describe`（原 `chat_media_describe`，2026-11-26 更名以名实相符：仅支持图片）经同一 analyzer 入口自动共享缓存与配额（零改动）。

```json
// vision.config.json 模板（填好后生效）
{
  "cloudflare": { "accountId": "", "apiToken": "", "model": "@cf/llava-1.5-7b-hf", "dailyQuota": 2000 },
  "sauceNao": { "apiKey": "", "dailyQuota": 100 },
  "traceMoe": { "apiKey": "", "dailyQuota": 120 },
  "huggingFace": { "token": "", "model": "Salesforce/blip-image-captioning-large", "dailyQuota": 50 }
}
```

## 6. 快速运维命令

```powershell
# 重启 memory（会留孤儿 asr-svc，需清）
$owner = (Get-NetTCPConnection -LocalPort 7181 -State Listen).OwningProcess
Stop-Process -Id $owner -Force
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*asr-svc*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process node -ArgumentList 'src\server.mjs' -WorkingDirectory C:\memory-mcp -WindowStyle Hidden `
  -RedirectStandardOutput C:\memory-mcp\run.log -RedirectStandardError C:\memory-mcp\run.err

# 克隆合成冒烟（内存空闲 ≥1.5GB 时）
node -e "fetch('http://127.0.0.1:18103/synthesize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'测试',refPath:'C:/qq-bridge/bridge/audio/test-hello.wav',promptText:'转写文本'})}).then(r=>r.json()).then(j=>console.log(j.ok,j.elapsedMs,j.error||''))"
```
