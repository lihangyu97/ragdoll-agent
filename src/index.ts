import Application from '@/application'

const app = new Application()

await app.start().catch(error => {
  app.handleStartupError(error)
})
