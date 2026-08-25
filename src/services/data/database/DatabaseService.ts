import { Service, type Context } from 'cordis'
import { z } from 'zod'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getDb } from '@/utils/sqlite'

declare module 'cordis' {
  interface Context {
    database: DatabaseService
  }
}

/**
 * database Service：单例连接 + 暴露 drizzle 实例 + 应用 schema 迁移（drizzle-kit 生成，见 drizzle/）。
 * 表结构唯一来源是 database/schema.ts，改表 = 改 schema → `pnpm exec drizzle-kit generate`（表结构变更后清库）。
 * 底层连接用 getDb() 单例（双连接问题：agent checkpointer 另持有连接，见文档 §8）。
 */
export default class DatabaseService extends Service {
  static Config = z.object({
    dbPath: z.string().default('data/agent.db')
  })

  /** drizzle 查询实例（repository 经此执行类型安全查询） */
  readonly db: BetterSQLite3Database

  constructor(ctx: Context, config: z.infer<typeof DatabaseService.Config>) {
    super(ctx, 'database')
    getDb(config.dbPath)
    this.db = drizzle(getDb())
    migrate(this.db, { migrationsFolder: './drizzle' })
  }

  /** 执行 DDL / 清表（测试用） */
  exec(sql: string) {
    getDb().exec(sql)
  }
}
