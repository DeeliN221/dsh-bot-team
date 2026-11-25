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
| `version` | `1` | 契约版本 |
| `resolve(sessionId)` | `冻结快照 \| undefined` | 当前 Bot 会话，或其原生子代理（向上最多 8 层） |
| `describe(sessionId)` | `{ knownBot, current, ready, snapshot? }` | 诊断：已轮换的 Bot 会话仍返回 `knownBot: true` |

快照字段固定为 `{ version, sessionId, membershipId, botId, groupId, conversationId }`；子代理快照另含 `inherited: true` 与 `rootSessionId`。快照冻结，不含名称、人格、模型等可编辑字段。

语义：

- 只信任 Bot Team 持久成员绑定（`isCurrentMemberSession`），不接受调用方提交的身份。
- 会话轮换或成员停用后 `resolve` 返回 `undefined`；`describe` 仍标记 `knownBot`，供策略层失败关闭，而不是回退到共享群目录策略。
- 同一群内不同 Bot 共享工作目录，但 `botId` 各自独立，可按成员授权。
- 原生子代理继承最近 Bot 祖先的身份；父链超过 8 层、断链或成环时拒绝解析。

部署侧策略插件可按 `botId` 静态映射角色策略，普通原生会话继续按 `session.header.cwd` 最长前缀匹配。

## 结果投影 `resultMode`

`cordis.patch.yml` 中 Bot Team 配置项：

```yaml
resultMode: final   # full（默认）| final
```

- `final`：群聊中的 Bot 回复只保留最终答案。最终答案取本 turn 最后一条 text 非空、且 `content` 不含 `tool-call` 块的 `assistant/message`，与宿主原生「最终回复」判定一致；流式增量不写入正文，pending/typing 状态保留。
- 无最终答案（停止、报错、达到输出上限）时回退最后一条非空 assistant 文本，并保留既有 `status`/`error`。
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
