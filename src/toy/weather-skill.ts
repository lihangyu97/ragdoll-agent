import type { Skill } from '@/services/capability/CapabilityService'

/**
 * weather skill：toy 演示技能（原 toy/systemPrompt 的工作流迁入 instructions）。
 */
const weatherSkill: Skill = {
  name: 'weather',
  description: '查询当前天气：获取用户所在城市、天气状况与温度',
  trigger: '天气、气温',
  instructions: `查询天气时按以下工作流执行：
1. 先调用 getLocation 确定用户所在城市。
2. 拿到城市后，在同一个回复里并行调用 getWeather 和 getTemperature（参数传第 1 步的城市）。
3. 把两个工具的结果合并成最终回答。

始终用中文回复。`,
  tools: ['getLocation', 'getWeather', 'getTemperature']
}

export default weatherSkill
