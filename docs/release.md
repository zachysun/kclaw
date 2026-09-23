# release — 版本管理与发布

kclaw 尚未发布 npm 包（恢复发布时 `packages/kclaw` 直接 `npm publish` 即可）。当前发布形态是 GitHub Release：打 tag 触发 `.github/workflows/release.yml`，自动完成校验、测试、打包和 Release 创建。

## 版本号

- **唯一权威数据**：`packages/kclaw/package.json` 的 `version`（当前 0.x 规则，不做兼容承诺）。core/server/web/cli 四个内部包的版本号不参与定版，恒停在 0.1.0。
- **运行时读取**：daemon 的 `GET /status` 与 CLI 的 `--version` 都在运行时读所在包的 package.json。聚合安装形态（`packages/kclaw/app/`）下两者读到的是同一个文件（构建时写入的 stub，携带聚合包版本），因此 `kclaw daemon status` 报出的 daemon 版本与 CLI 版本天然可比——不一致即说明两者不是同一次构建的产物。

## 定版流程（三步手工，其余自动）

1. 改 `packages/kclaw/package.json` 的 `version`；
2. 在 `CHANGELOG.md` 顶部加对应条目（Keep a Changelog 格式，`## [x.y.z] - 日期`）；
3. `git tag vX.Y.Z && git push origin vX.Y.Z`（代码 commit 照常先行）。

推送 tag 后 release workflow 自动执行：

- **一致性断言**：tag 名（去掉 `v`）等于 package.json 版本、CHANGELOG 存在该版本条目，任一不符直接失败；
- **全量 build + typecheck + test**（与 CI 同序：build 先于 typecheck）；
- **打包**：`packages/kclaw`（含组装好的 `app/`，不含 `node_modules`）打成 tar.gz，附到 Release；
- **Release notes**：从 CHANGELOG 切出该版本条目正文作为说明（英文，与 CHANGELOG 同源）。

安装 Release 的 tarball：解包后 `npm i -g ./kclaw`。

## CI

`.github/workflows/ci.yml` 在 push main 与 PR 时触发，ubuntu + macos × node 22/24 四个组合跑 install → build → typecheck → test。node 22 是发布下限，24 是实际部署形态（better-sqlite3 按 node 版本编译，双档都能锁住）。纯 `docs/**` 与 `*.md` 的改动跳过 CI。

## 相关文档

- [tutorial](./tutorial.md)：安装与升级（本地部署）
- [architecture](./architecture.md)：包结构与依赖方向
