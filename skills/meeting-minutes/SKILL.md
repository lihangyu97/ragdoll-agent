---
name: meeting-minutes
description: 整理会议纪要：从聊天记录/发言中提取讨论要点、决策与待办，按标准结构输出。Use when the user asks to summarize a meeting or organize meeting notes.
license: MIT
metadata:
  author: ragdoll-demo
  version: "1.0"
---

# 会议纪要整理

按以下工作流整理会议纪要：

1. 通读会议/讨论内容，识别主题段落。
2. 提取三块核心信息：
   - **讨论要点**：每段讨论的结论与分歧
   - **决策**：明确拍板的事项（谁、何时、定了什么）
   - **待办**：任务 + 负责人 + 截止时间
3. 用 `references/REFERENCE.md` 中的结构规范组织输出；拿不准格式时先看 `assets/template.md` 模板。
4. 输出语言跟随会议语言，默认中文。

需要时用 load_skill(name, resource) 加载：
- references/REFERENCE.md —— 纪要字段规范与示例
- assets/template.md —— 可直接套用的空模板
