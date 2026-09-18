# Feishu 频道（飞书 IM 接入）

`packages/server/src/feishu/` 把 kclaw 接入飞书：在飞书里给机器人发消息就能用 kclaw，不需要开电脑，也不需要公网 IP 或端口转发——出站入站都走飞书官方的长连接（WebSocket，由飞书主动把事件推给 daemon）。频道是**新的入口和出口，不是新的机制**：入站消息走普通的 `RunManager.submit` 门（触发器 user），出站渲染消费既有的事件总线，权限确认走普通的确认网关，引擎零改动。

- 模块：`channel.ts`（频道逻辑：命令、白名单、卡片状态机、剥离）、`transport.ts`（传输接口，唯一的接缝）、`real-transport.ts`（官方 SDK 薄壳）、`config.ts`（feishu.json 与绑定状态）。
- 测试：全部频道逻辑在假传输上测试（`test/feishu/`），真传输不带逻辑、只做翻译。
- 前置：`@larksuiteoapi/node-sdk`（server 依赖）；真机使用需要一个飞书自建应用（见文末"启用步骤"）。

## 配置与状态

**`~/.kclaw/feishu.json`**（手工编辑，重启生效；文件权限不足 0600 时加载器会尽力收紧）：

```json
{
  "enabled": true,
  "app_id": "cli_xxx",
  "app_secret": "xxx",
  "allowlist": ["ou_xxx"],
  "primaryOpenId": "ou_xxx"
}
```

`enabled` 缺省 false；开启后 `app_id` 与 `app_secret` 必填，否则 daemon 启动时报一行错误并跳过频道（其余功能不受影响）。`allowlist` 是 open_id 白名单，白名单外的发件人被**静默忽略**（记一行日志，不回任何信息）——应用被拉进陌生群或被陌生人私聊都不会泄露内容。`primaryOpenId` 接收主动推送（定时任务终态、后台子代理完成）。密钥独立于 config.yaml，是为了不让 app_secret 混进主配置的备份与同步路径。

**`~/.kclaw/feishu-state.json`**（频道写入，0600，原子写）：open_id → 常驻会话的绑定表。白名单内每个 open_id 绑定一个常驻会话，首条消息自动创建（标题 `飞书 · <open_id>`）并持久化；daemon 重启后读回（会话已被删除的绑定自动丢弃）。

## 入站

私聊文本消息按顺序过四道门：

1. **白名单**：非白名单 open_id 静默忽略。
2. **命令**（在进 submit 之前拦截，不产生 run）：
   - `/help` —— 回命令卡片；
   - `/stop` —— 停止当前回复**并清空该会话未执行队列**，回执写明中断与丢弃条数。注意这不是普通的中断处置：interrupt 只把新消息插到队头并中止当前 run，队列里排着的消息之后照常执行，做不成"停止"；`/stop` 用的是 RunManager 的 `stopAndClear` 组合口（见 [run-manager](./run-manager.md)）；
   - `/new` —— 若有进行中 run 先 `/stop` 的语义停掉，再开新会话并回执；旧会话保留，可在 WebUI 查看。
3. **表情回执**：处理前给消息加一个 Typing 表情（处理状态一目了然）。
4. **submit**：普通文本以触发器 user、固定 wait 处置进 `RunManager.submit`——忙时排队、空闲直发，连续多条消息严格按发送顺序消化。

## 出站

**镜像（四态卡片）**：绑定会话的每一轮 run，无论从哪个入口触发（飞书消息、WebUI、定时任务），都同步渲染成卡片序列——`run.started` → "思考中"卡；首个 `text.created` → 流式卡（官方流式更新能力，增量累积，不手动反复刷卡）；`run.completed`/`run.failed` → 终稿卡（markdown 渲染，失败附原因）。用户在电脑上用 WebUI 时，手机飞书同步看到进展；双端同用的重复提醒是接受的成本。thinking 只体现为状态，思考内容不外发。

**主动推送（摘要卡，发给 primaryOpenId）**：

- `job.completed`/`job.failed` 广播（总线上的无会话事件）→ 定时任务终态卡；
- 后台子代理落定 → 子代理宿主在完成回投后发出可选回调（`onBackgroundSettled`），daemon 把它接到频道。

**审批卡**：绑定会话上的 `confirmation.requested` 渲染为"批准（仅本次）/拒绝"两键卡片；按钮按下经普通确认网关落裁决——批准即 `once`、拒绝即 `reject`，审计的裁决来源 `by` 记 `feishu`（与 cli/web 同级，见 [permissions](../core/permissions.md)）。裁决若已被别处（WebUI/CLI/超时）处理，broker 里这条确认已不存在，卡片就地改为"已失效"。卡片只在确认存续期间有效，超时按既有超时语义（拒绝）处理。

**出站剥离器**：所有发往飞书的正文先过 `stripOutboundText`——`<system-reminder>` 注入标记（成对的剥对、悬空的开标签剥到结尾）绝不外发；批注块与思考块内容按构造就进不了出站路径（只有 assistant 的文本块参与渲染）。

## 传输接缝

`FeishuTransport` 是频道唯一的接缝：连接、收消息、收卡片动作、发表情、发卡片、更新卡片、流式（start/append/finish 三步）全部收在接口后。真传输把它翻译到官方 SDK 的 LarkChannel 门面（长连接、自动重连、DM 白名单策略做第二道防线、流式节流与超长滚动都在 SDK 内建）；频道逻辑对这些一无所知，所以能整体在假传输上测试。流式的适配点：SDK 的流式是"一次调用 + 生产者闭包"，接缝是"start 拿 id、逐段 append、finish 收尾"——真传输在两者之间垫了一条内存队列，卡片 id 返回前的增量先缓冲后冲刷。

## 边界（v1 有意不做）

群聊、入站图片/文件/语音、WebUI 管理页与配置热改、多主用户推送、引擎侧改动。飞书长连接断连期间不补发事件（飞书侧硬约束）；运行中的提问（`ask_user_questions`）没有飞书卡片入口，会在限时后按超时路径落定。

## 启用步骤（真机验收）

注册飞书组织（免费）→ 开放平台建**自建应用** → 拿 `app_id`/`app_secret` → 开通长连接模式、收发消息、消息卡片、消息表情回复等权限 → 调试台查自己的 open_id 填进 allowlist 与 primaryOpenId → 写 `~/.kclaw/feishu.json`（enabled=true）→ 重启 daemon。
