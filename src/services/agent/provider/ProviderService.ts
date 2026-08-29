import { Service, type Context } from 'cordis'
import { z } from 'zod'
import { ChatOpenAI } from '@langchain/openai'

declare module 'cordis' {
  interface Context {
    provider: ProviderService
  }
}

/**
 * provider Service：模型层。持有模型配置与 ChatOpenAI 客户端，对 agent 执行层
 * （AgentService）只暴露 getModel()——换模型/换 provider 收敛在本 Service 内，
 * agent loop 与模型实现解耦。
 */
export default class ProviderService extends Service {
  static Config = z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().min(1),
    model: z.string().default('deepseek-v4-flash')
  })

  private readonly model: ChatOpenAI

  constructor(ctx: Context, config: z.infer<typeof ProviderService.Config>) {
    super(ctx, 'provider')
    this.model = new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey,
      streaming: true,
      timeout: 60_000,
      maxRetries: 2,
      configuration: { baseURL: config.baseUrl }
    })
  }

  /** 共享模型客户端（identify 路由与 agent run 复用同一实例） */
  getModel(): ChatOpenAI {
    return this.model
  }
}
