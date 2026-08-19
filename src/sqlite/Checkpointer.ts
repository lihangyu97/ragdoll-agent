import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite"
import { DB_PATH } from "@config/agent"

export default class SqliteCheckpointer {
  private readonly checkpointer: SqliteSaver

  constructor() {
    mkdirSync(dirname(DB_PATH), { recursive: true })

    this.checkpointer = SqliteSaver.fromConnString(DB_PATH)
    this.checkpointer.db.pragma("busy_timeout = 5000")
  }

  getCheckpointer() {
    return this.checkpointer
  }

  buildConfig(threadId: string) {
    return { configurable: { thread_id: threadId } }
  }
}
