import 'dotenv/config'

if (!process.env.DB_PATH) {
  console.log('未配置 sqlite 路径 将使用 data/agent.db')
}

export const DB_PATH = process.env.DB_PATH ?? 'data/agent.db'
