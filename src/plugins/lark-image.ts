import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from 'cordis'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

/** fetch_image 工具的注册名（definition 按此名引用） */
export const FETCH_IMAGE_TOOL = 'fetch_image'

/** content-type → 文件扩展名（未知类型落 .bin） */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

/**
 * 装配 fetch_image 工具：下载飞书消息里的图片，落到 agent 文件沙箱（capability.root）下，
 * 返回沙箱内相对路径（agent 的 read_file 同一坐标系）。下载 I/O 在 LarkAdapter，这里只做装配。
 * 模型当前不一定支持视觉，先落盘存证；后续接视觉模型/MCP 直接读这个文件。
 */
export default {
  name: 'lark-image',
  inject: ['capability', 'larkAdapter'],
  apply(ctx: Context) {
    ctx.capability.registerTool(
      tool(
        async ({ message_id, image_key }: { message_id: string; image_key: string }) => {
          try {
            const { data, contentType } = await ctx.larkAdapter.downloadImage(message_id, image_key)
            const ext = EXT_BY_CONTENT_TYPE[contentType ?? ''] ?? '.bin'
            const rel = join('images', `${message_id}-${image_key}${ext}`)
            const abs = join(ctx.capability.root, rel)
            await mkdir(dirname(abs), { recursive: true })
            await writeFile(abs, data)
            return `图片已保存: ${rel}（${contentType ?? '未知类型'}，${data.length} 字节）`
          } catch (err) {
            return `[fetch_image] 下载失败（message_id=${message_id} image_key=${image_key}）: ${String(err)}`
          }
        },
        {
          name: FETCH_IMAGE_TOOL,
          description:
            '下载飞书消息里的图片并保存到工作区，返回保存路径（沙箱内相对路径）。「图片」占位符里的 message_id 和 image_key 原样复制过来即可，仅支持飞书图片。',
          schema: z.object({
            message_id: z.string().describe('消息 id（图片占位符里的 message_id）'),
            image_key: z.string().describe('图片 key（图片占位符里的 image_key）')
          })
        }
      )
    )
  }
}
