import "dotenv/config"

// 环境变量集中管理：key / 中转站 / 模型名，缺省值也在这里
export const API_KEY = process.env.OPENAI_API_KEY
export const BASE_URL = process.env.OPENAI_BASE_URL
export const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini"
