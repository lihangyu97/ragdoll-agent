import ThreadsService from './ThreadsService'

declare module 'cordis' {
  interface Context {
    threads: ThreadsService
  }
}
