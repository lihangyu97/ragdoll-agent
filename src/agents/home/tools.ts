import { z } from 'zod'
import { tool } from '@langchain/core/tools'

/** toy 设备状态（进程内存，重启即重置）：演示用，无真实硬件 */
const devices = {
  light: { on: false },
  fan: { on: false, level: 1 }
}

const lightSwitch = tool(
  async ({ room, on }) => {
    devices.light.on = on
    return `${room}的灯已${on ? '打开' : '关闭'}`
  },
  {
    name: 'lightSwitch',
    description: '打开或关闭某个房间的灯',
    schema: z.object({
      room: z.string().describe('房间名，如 客厅、卧室'),
      on: z.boolean().describe('true 开灯，false 关灯')
    })
  }
)

const fanSwitch = tool(
  async ({ on }) => {
    devices.fan.on = on
    return on ? `风扇已打开（当前 ${devices.fan.level} 档）` : '风扇已关闭'
  },
  {
    name: 'fanSwitch',
    description: '打开或关闭风扇。关闭后档位保留，下次打开沿用',
    schema: z.object({ on: z.boolean().describe('true 开风扇，false 关风扇') })
  }
)

const fanSpeed = tool(
  async ({ level }) => {
    devices.fan.level = level
    return devices.fan.on
      ? `风扇已调到 ${level} 档`
      : `风扇已设为 ${level} 档（当前未开机，开机后生效）`
  },
  {
    name: 'fanSpeed',
    description: '调节风扇风速档位（1-3 档）',
    schema: z.object({
      level: z.number().int().min(1).max(3).describe('档位，1 低速 2 中速 3 高速')
    })
  }
)

export default [lightSwitch, fanSwitch, fanSpeed]
