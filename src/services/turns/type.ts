import TurnsService from './TurnsService'

declare module 'cordis' {
  interface Context {
    turns: TurnsService
  }
}
