import "dotenv/config"

export const API_KEY = process.env.OPENAI_API_KEY
export const BASE_URL = process.env.OPENAI_BASE_URL
export const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini"
