import DatabaseService from './DatabaseService'

declare module 'cordis' {
  interface Context {
    database: DatabaseService
  }
}
