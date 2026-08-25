import WorkerService from './WorkerService'
import type { TraceStatus } from '@/services/traces/TracesService'

declare module 'cordis' {
  interface Context {
    worker: WorkerService
  }
  interface Events {
    /** worker 状态流转 pending→processing→done/failed，观察/审计用，避免别人轮询 DB */
    'trace/status'(threadId: string, status: TraceStatus): void
  }
}
