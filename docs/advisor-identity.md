# 顾问身份与结果投影

本页说明 1.3.1 起 Bot Team 为「一个 Bot 一个角色」提供的两个 Host 契约：只读身份服务 `botTeamIdentity`、作业结果投影。二者都不保存角色数据、不读人格文本，也不改变普通原生会话的既有行为。

## botTeamIdentity

插件启动时通过 Cordis 发布只读服务：

```js
const identity = ctx.get('botTeamIdentity') // 宿主其他插件读取；Bot Team 未加载时为 undefined
```

服务对象：

| 成员 | 签名 | 行为 |
|---|---|---|
| `version` | `2` | 契约版本 |
| `resolve(sessionId)` | `冻结快照 \| undefined` | 当前会话、持久历史绑定，或经创建关系验证的原生子代理 |
| `describe(sessionId)` | `{ knownBot, current, historical, ready, snapshot? }` | 诊断；`ready` 仅服务未就绪时出现 |

快照字段固定为 `{ version, sessionId, membershipId, botId, groupId, conversationId, current, historical }`；子代理快照另含 `inherited: true` 与 `rootSessionId`。快照冻结，不含名称、人格、模型等可编辑字段。

三种状态：

- `current: true`：当前活动会话的有效成员（`enabled !== false` 且绑定一致）。
- `historical: true`：持久 `sessionBinding` 仍证明原会话属于该 Bot，但成员已轮换、会话已切走或成员被停用/移除。身份保留供迟到回报继续按其角色授权，但不得据此发起新工作。
- 均不再解析：普通会话，或 binding 与群/Bot 不一致的伪造会话。

子代理身份来自受验证的创建关系（宿主 Agent 目录的 `parentAgent` + `origin: subagent`），中间祖先已释放时仍通过创建时记录的谱系保留；仅带 `parentSession` 字段的历史 fork 不会被当作 Bot 子代理。

语义：

- 只信任 Bot Team 持久绑定，不接受调用方提交的身份；不按名称、人格、目录或请求元数据推断角色。
- 成员移除后持久 binding 仍返回 `historical: true` 与 `botId`，策略层不会把它降级为普通会话。
- 同一群内不同 Bot 共享工作目录，但 `botId` 各自独立，可按成员授权。
- 策略消费者若在身份服务缺失/未就绪时遇到 Bot 形状的会话，必须失败关闭，不得回退到共享 cwd 策略。

部署侧策略插件可按 `botId` 静态映射角色策略，普通原生会话继续按 `session.header.cwd` 最长前缀匹配。

## 结果投影 `resultMode`

`cordis.patch.yml` 中 Bot Team 配置项：

```yaml
resultMode: final   # full（默认）| final
```

- `final`：群聊中的 Bot 回复只保留最终答案。最终答案取本 turn 最后一条 text 非空、且 `content` 不含 `tool-call` 块的 `assistant/message`，与宿主原生「最终回复」判定一致；流式增量不写入正文，pending/typing 状态保留。
- 无已证实最终答案（停止、报错、达到输出上限）时正文留空，只保留既有 `status`/`error` 与审批等必要状态；绝不把内部 commentary 当结果发布。
- 有真实阶段标记时以标记为准：assistant 消息 `source.replayState` 中 text 块 `textSignature` JSON 的 `phase` 为 `final_answer` 才接受；存在 phase 但不是 `final_answer` 时即使纯文本也不发布；完全无 phase 时才回退原生「text 非空且无 tool-call」判定。
- 审批卡、系统消息、讨论、任务、评审等既有消息类型不受影响；评审结论仍从最终答案解析。
- `full`：维持 1.3.0 行为，全部 assistant 文本串接。

## 迟到回报

会话轮换、换项目或归档后，已提交作业继续在原原生会话跑到自然结束，结果写入原会话的消息（`message.conversationId` 不变），并置 `meta.lateDelivery: true`。作业不会写入新会话、不会重复建消息，也不会重复执行；任务钩子与空闲调度只在作业所属会话仍为当前会话时触发。

任务中心可据此元数据把迟到结果绑定回原 `bot/group/conversation/session/execution`，无需按新会话重投。

## 文件交付

Bot 在原生会话中调用 `present` 后，DSH 会追加 `deliverables/presented`。Bot Team 在同一 turn 内把声明的文件写入原生附件存储（内容寻址、只读），并挂到该条群消息的 `attachments` 上；客户端按原生附件样式展示，并通过 `GET /api/bot-team.attachment?groupId=&attachmentId=&name=&bytes=` 下载。

- 仅接受 Bot 当前工作目录内的文件；`deliveryRoots` 可追加绝对路径白名单。
- 每个 turn 最多 4 个文件，单文件上限 32 MB；重复事件与重复路径只挂一次。
- 下载路由只放行该群消息已引用的附件，路径不对外暴露。
- 不新增第二套文件卡片或文件服务。

## 配置项补充

| 配置 | 默认 | 作用 |
|---|---|---|
| `resultMode` | `full` | `final` 启用最终答案投影 |
| `deliveryRoots` | `[]` | `present` 文件可交付的额外绝对根目录；Bot 工作目录始终允许 |
| `defaultLanding` | `auto` | `bot-team` 时客户端默认落 Bot Team 最近聊天并收起宿主侧栏；其他值保持宿主原生落点 |
