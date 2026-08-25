import 'dotenv/config'

// 启动校验：缺 LLM 配置直接 fail-fast（对齐 lark 配置校验），避免运行期才 401
if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) {
  throw new Error('缺少 LLM 配置：请在 .env 设置 OPENAI_API_KEY / OPENAI_BASE_URL')
}

if (!process.env.OPENAI_MODEL) {
  console.log('未配置 MODEL 将使用 deepseek-v4-flash')
}

export const API_KEY = process.env.OPENAI_API_KEY
export const BASE_URL = process.env.OPENAI_BASE_URL
export const MODEL = process.env.OPENAI_MODEL ?? 'deepseek-v4-flash'

export const modelConfig = {
  model: MODEL,
  apiKey: API_KEY,
  streaming: true,
  timeout: 60_000,
  maxRetries: 2,
  configuration: { baseURL: BASE_URL }
}
