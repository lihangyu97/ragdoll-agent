import ChannelLarkService from './ChannelLarkService'

declare module 'cordis' {
  interface Context {
    channelLark: ChannelLarkService
  }
}
