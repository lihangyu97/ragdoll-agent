import type { Skill } from '@/services/agent/capability/CapabilityService'

/** home skill 的注册名（definition 按此名引用） */
export const HOME_SKILL = 'home'

/**
 * home skill：智能家居 toy 演示技能，介绍设备工具的用法与操作约定。
 */
const homeSkill: Skill = {
  name: HOME_SKILL,
  description: '控制家居设备：灯的开关、风扇的开关与档位调节',
  trigger: '灯、开关灯、风扇、风速、档位',
  instructions: `控制家居设备时按以下约定执行：
1. 灯：用户说开/关某个房间的灯时，调用 lightSwitch（room 传房间名，on 传开或关）。
2. 风扇开关：调用 fanSwitch（on 传 true/false）。关闭风扇不会丢失档位设置。
3. 风扇档位：调用 fanSpeed（level 传 1/2/3，对应低/中/高速）。风扇未开机时也可先设档，开机后生效。
4. 用户没有明确房间名时先追问，不要猜。

执行完工具调用后，用一句话向用户确认结果。始终用中文回复。`,
  tools: ['lightSwitch', 'fanSwitch', 'fanSpeed']
}

export default homeSkill
