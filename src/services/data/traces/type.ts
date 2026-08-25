import TracesService from './TracesService'

declare module 'cordis' {
  interface Context {
    traces: TracesService
  }
}
