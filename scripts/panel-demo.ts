// 临时验证脚本（验证后删除）：只起 database + panel，不接渠道/worker，灌演示数据
process.env.DB_PATH = '/tmp/panel-demo.db'
process.env.PANEL_PORT = '3111'

import { Context } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import ThreadsService from '../src/services/data/threads/ThreadsService'
import PanelService from '../src/services/data/panel/PanelService'
import panel from '../src/plugins/panel'
import {
  agentThreads,
  agentTraces,
  agentTurns,
  logger,
  type TraceStatus
} from '../src/services/data/database/schema'

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: process.env.DB_PATH })
ctx.plugin(ThreadsService)
ctx.plugin(PanelService)
ctx.plugin(panel, { port: 3111 })
await new Promise(r => setTimeout(r, 500))

const db = ctx.database.db
db.delete(agentTraces).run()
db.delete(agentThreads).run()
db.delete(agentTurns).run()
db.delete(logger).run()

const mkThread = (id: string) =>
  db
    .insert(agentThreads)
    .values({
      threadId: id,
      chatType: 'p2p',
      chatId: 'oc_x1',
      senderId: 'ou_1',
      agentId: 'weather'
    })
    .run()
const mkTrace = (
  threadId: string,
  status: TraceStatus,
  input: string,
  offsetMin: number,
  channel = 'lark'
) => {
  ctx.threads.ensureThread(threadId, 'p2p', 'oc_x1', 'ou_1')
  db.insert(agentTraces)
    .values({
      threadId,
      messageId: `m-${Math.random()}`,
      chatId: 'oc_x1',
      inputText: input,
      channel,
      status
    })
    .run()
  // createdAt/updatedAt 是 sqlite 默认表达式，函数值用 raw update 写入
  db.run(
    `update agent_traces set created_at = datetime('now','localtime','-${offsetMin} minutes'), updated_at = datetime('now','localtime','-${Math.max(0, offsetMin - 1)} minutes') where thread_id = '${threadId}'`
  )
}

mkThread('lark:p2p:oc_x1')
mkThread('lark:p2p:oc_x2')
mkThread('tg:p2p:10086')
mkTrace('lark:p2p:oc_x1', 'done', '明天北京天气怎么样？', 30)
mkTrace('lark:p2p:oc_x2', 'processing', '帮我写一个快排，用 TypeScript', 2)
mkTrace('tg:p2p:10086', 'failed', '/weather 上海', 120, 'telegram')
for (let i = 0; i < 8; i++) mkTrace('lark:p2p:oc_x1', 'done', `历史消息 ${i}`, 200 + i * 40)
db.run(
  `update agent_traces set heartbeat_at = datetime('now','localtime','-10 seconds') where status = 'processing'`
)

db.insert(agentTurns)
  .values({
    threadId: 'lark:p2p:oc_x1',
    turnNo: 1,
    hookType: 'INPUT',
    content: '明天北京天气怎么样？'
  })
  .run()
db.insert(agentTurns)
  .values({
    threadId: 'lark:p2p:oc_x1',
    turnNo: 1,
    hookType: 'TOOL_CALL',
    node: 'llm',
    toolCallId: 'call_1',
    toolName: 'weather_query',
    args: JSON.stringify({ city: '北京' })
  })
  .run()
db.insert(agentTurns)
  .values({
    threadId: 'lark:p2p:oc_x1',
    turnNo: 1,
    hookType: 'TOOL_RESULT',
    node: 'weather_query',
    toolCallId: 'call_1',
    toolsResult: JSON.stringify({ city: '北京', temp: '28℃', weather: '多云', tip: '适合出行' })
  })
  .run()
db.insert(agentTurns)
  .values({
    threadId: 'lark:p2p:oc_x1',
    turnNo: 1,
    hookType: 'AGENT_RESULT',
    node: 'llm',
    content: '明天北京 28℃，多云，适合出行 🌤'
  })
  .run()

db.insert(logger)
  .values({ level: 'info', message: 'worker poll: no pending trace', threadId: null })
  .run()
db.insert(logger)
  .values({
    level: 'warn',
    message: 'lark 发送重试 1/3',
    data: JSON.stringify({ chatId: 'oc_x1' }),
    threadId: 'lark:p2p:oc_x1'
  })
  .run()
db.insert(logger)
  .values({
    level: 'error',
    message: 'weather_query 上游超时',
    data: JSON.stringify({ trace: 3 }),
    threadId: 'tg:p2p:10086'
  })
  .run()

console.log('panel demo ready on http://localhost:3111')
