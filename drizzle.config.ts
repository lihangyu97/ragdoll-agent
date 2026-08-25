import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/services/data/database/schema.ts',
  out: './drizzle',
  dbCredentials: { url: 'data/agent.db' }
})
