import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DB_PATH } from "@config/sqlite"

/**
 * SQLite 连接基类：统一负责打开连接 + PRAGMA 配置。
 * 子类通过两个模板方法完成初始化（基类构造时按序调用）：
 *   1. createTables() —— 建表
 *   2. init() —— 建表之后的其他初始化（如注册回调），默认空实现，不需要可不管
 * 注意：每个实例仍是独立的数据库连接（指向同一文件），继承只是抽掉了样板代码，连接数不变。
 * 注意：init() 在基类构造期间调用，此时子类字段初始值尚未就绪（ES 字段初始化在 super() 之后），
 *        init 里只适合注册回调/执行不读子类字段初始值的操作。
 */
export default abstract class SqliteBase {
  protected readonly db: DatabaseSync

  constructor() {
    mkdirSync(dirname(DB_PATH), { recursive: true })
    this.db = new DatabaseSync(DB_PATH)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.createTables()
    this.init()
  }

  /** 子类建表 */
  protected abstract createTables(): void

  /** 建表后的额外初始化，默认空实现 */
  protected init(): void {}

  /** 关闭连接 */
  close(): void {
    this.db.close()
  }
}
