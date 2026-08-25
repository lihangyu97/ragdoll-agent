import 'dotenv/config'

// 拆 import 副作用：这里不再 throw（缺 env 由 AgentService 构造器校验 → 插件 FAILED 而非 import 崩进程）。
// 非空断言仅用于类型收窄，运行时缺失时构造器会先抛错。

if (!process.env.OPENAI_MODEL) {
  console.log('未配置 MODEL 将使用 deepseek-v4-flash')
}

export const API_KEY = process.env.OPENAI_API_KEY!
export const BASE_URL = process.env.OPENAI_BASE_URL!
export const MODEL = process.env.OPENAI_MODEL ?? 'deepseek-v4-flash'

export const modelConfig = {
  model: MODEL,
  apiKey: API_KEY,
  streaming: true,
  timeout: 60_000,
  maxRetries: 2,
  configuration: { baseURL: BASE_URL }
}
