@echo off
rem memory-mcp 手动启动脚本。
rem LLM 提取配置在仓库根目录 llm.config.json（server.mjs 启动时读取；
rem MEMORY_MCP_LLM_* 显式环境变量仍可覆盖，但一般不需要设置）。
rem 端点走本机 wb2api 代理（OpenAI 兼容，承载 deepseek 模型）。
node "%~dp0src\server.mjs"
