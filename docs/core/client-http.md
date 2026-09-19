# client-http — 客户端共享的 HTTP 请求基座

## 职责

`packages/core/src/client-http.ts` 是所有 daemon 客户端（CLI 的 `KclawClient`、WebUI 的 `api.ts`）共用的 HTTP 请求基座，经 `@kclaw/core/client-http` 子路径出口对外发布。它把每处客户端都要重复写的同一套请求管道收敛成一份：Bearer 注入、JSON body 序列化、非 2xx 的错误提取、401 hook、204/空响应解析。

实现只依赖浏览器/Node 都有的全局 `fetch`，**不 import 任何 `node:*` 模块**——WebUI 把它打进浏览器产物时不会把 Node 绑定的代码带进去（与 `@kclaw/core/protocol` 同一先例）。

## 设计决策

- **一个错误路径，两种消息来源**：非 2xx 时优先取服务端 `body.error` 字符串（服务端统一错误形状就是 `{error: string}`，见 [http-api](../server/http-api.md)），取不到（非 JSON 错误体等）退回 `HTTP <status>`。抛出的 `HttpRequestError` 始终附带 `status`，调用方可以按状态码分支而不必解析消息文本。
- **401 用 hook 而不是抛错语义**：每次 401 响应都在抛错之前触发一次 `onUnauthorized`（比如 WebUI 的"清 token 回输入页"），然后照常抛错——调用方不用在 catch 里猜状态码做重入。
- **token 每次请求重取**：`getToken` 在每次请求时重新求值，所以 401 后重新输入、token 轮换立即对下一次请求生效，不需要重建客户端；返回 `null` 就不发 `Authorization` 头。
- **contentType 是"原样透传"开关**：设置它时 body 不 JSON 序列化、按原始字节流发送——附件上传（CLI 的 `uploadAttachment`、WebUI 的 `upload`）用它传文件本体。

## 契约

```ts
// packages/core/src/client-http.ts
export class HttpRequestError extends Error {
  readonly status: number   // HTTP 状态码
}

export interface HttpRequestInit {
  method?: string                 // 默认 GET
  body?: unknown                  // JSON 序列化为 application/json；设置了 contentType 则原样透传
  contentType?: string            // 设了就按这个 Content-Type 原样发 body（附件上传用）
  getToken: () => string | null   // 每次请求重评估；null 不发 Authorization 头
  onUnauthorized?: () => void     // 每次 401 触发一次，发生在抛错之前
}

export async function httpRequest(url: string, init: HttpRequestInit): Promise<unknown>
// 一次到 daemon 的请求：JSON 进、JSON 出。非 2xx 抛 HttpRequestError（消息取
// body.error，退回 "HTTP <status>"）；204 或空响应体解析为 undefined。
```

## 使用方

- **CLI**（`packages/cli/src/client.ts`）：`request()` 与 `uploadAttachment()` 都经 `httpRequest` 实现——前者发 JSON、后者带 `contentType` 发原始字节流。CLI 不传 `onUnauthorized`（没有 401 重入流程），`getToken` 恒返回 `<home>/token` 读到的 token。
- **WebUI**（`packages/web/src/api.ts`）：`createApi` 的 `get/post/patch/del/upload` 全部经 `httpRequest`。URL 解析（空 base = 同源，daemon 自己托管 SPA）与 401 重入 hook（App 清除 token、回 token 输入页）是 web 本地逻辑，留在 `api.ts` 里；`ApiError` 现在就是 `HttpRequestError` 的别名导出（同一个构造函数，`instanceof` 判断不变）。

## 边界与出错

- **错误消息优先服务端文案**：响应体是合法 JSON 且 `error` 字段是字符串时用它；否则（如网关层返回的非 JSON 页面）退回 `HTTP <status>`。
- **浏览器安全是硬约束**：本模块不允许出现 `node:*` import，否则 WebUI 打包会失败——这是本模块的一条硬性要求。

## 关联

- [http-api](../server/http-api.md)：服务端路由与统一错误形状 `{error: string}`（本模块提取的来源）
- [protocol](./protocol.md)：与 protocol 相同的「权威类型 + 子路径出口」模式
- [cli](../cli/cli.md)：`KclawClient.request` / `uploadAttachment` 的处理侧
- [webui](../web/webui.md)：`api.ts` 的处理侧与 401 重入
