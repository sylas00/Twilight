<div align="center">

![Twilight Logo](Twilight%20Logo.png)

# Twilight 暮光

面向 Emby / Jellyfin 的用户、邀请码、注册码、求片与 Telegram Bot 管理面板。

[![Go](https://img.shields.io/badge/Go-1.25+-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![Version](https://img.shields.io/badge/Version-0.0.4-blue)](docs/VERSION_HISTORY.md)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

[Telegram 频道](https://t.me/Twilightpanel) · [Telegram 群组](https://t.me/TwilightPanelChat) · [文档导航](docs/README.md)

</div>

## 项目简介

Twilight 是一套面向 Emby / Jellyfin 站点的自助管理面板，覆盖用户注册、续期、邀请码、注册码、求片、公告、Telegram Bot、运行日志、数据库迁移和系统维护等常见运维场景。

当前版本以 **Go 后端 + Next.js 前端** 为主线。旧 Python 后端不再作为生产运行路径，部署、配置、数据库迁移和运维请以 Go 后端文档为准。

## 核心能力

- 用户管理：注册、登录、续期、禁用、删除、白名单、设备与登录记录。
- 卡码体系：注册码、续期码、白名单码、诱饵码、指名码、批量生成与审计。
- 邀请系统：邀请码、续期邀请、邀请树和管理员邀请森林视图。
- 媒体服务：Emby / Jellyfin 账号绑定、创建、解绑、媒体库权限和播放统计。
- 求片系统：TMDB / Bangumi 搜索、库存检查、管理员审核和外部回调。
- Telegram Bot：账号绑定、个人查询、管理员只读查询、群组成员安全管理。
- 运维后台：实时日志、服务器状态、配置热重载、数据库备份/恢复/迁移、Git 更新。

## 技术栈

```text
backend   Go 1.25+ / net/http / PostgreSQL or JSON state / Redis optional
frontend  Next.js 16 / React / TypeScript
runtime   Linux + systemd recommended
```

## 快速开始

```bash
git clone https://github.com/Prejudice-Studio/Twilight.git
cd Twilight

# 后端
go test ./...
go build -o bin/twilight ./cmd/twilight
cp config.production.toml config.toml
./bin/twilight api --config config.toml

# 前端
cd webui
npm ci
NEXT_PUBLIC_API_URL=http://127.0.0.1:5000 npm run dev
```

生产部署建议先阅读 [安装部署文档](docs/INSTALL.md)。

## 环境要求

- Linux 服务器，建议使用 systemd 管理后端服务。
- Go `1.25+`。
- Node.js `22+`。
- 已部署并可由后端访问的 Emby 或 Jellyfin。
- 可选：PostgreSQL、Redis。

## 文档导航

| 文档 | 说明 |
| ---- | ---- |
| [安装部署](docs/INSTALL.md) | Linux、systemd、1Panel、Nginx、PostgreSQL 部署 |
| [Go 后端说明](docs/GO_BACKEND.md) | 后端启动、配置、Redis、验证 |
| [后端 API](docs/BACKEND_API.md) | REST API 规范与重点接口 |
| [Telegram Bot 命令](docs/TG_BOT_COMMANDS.md) | Bot 命令、私聊边界、管理员命令 |
| [注册码说明](docs/REGCODES.md) | 注册码/续期码/白名单码算法和使用规则 |
| [Bangumi 同步](docs/BANGUMI_SYNC.md) | Emby Webhook 与 Bangumi Token 配置 |
| [安全加固](docs/SECURITY.md) | 生产安全检查清单 |
| [开发者流程](docs/DEVELOPER_WORKFLOW.md) | 分支、验证、合并与发布流程 |
| [版本历史](docs/VERSION_HISTORY.md) | 更新记录与发布文案 |

## 安全提示

生产环境请务必检查 CORS、HTTPS Cookie、管理员权限、配置文件权限、数据库备份和外部服务密钥。运行日志会脱敏常见 Token、Cookie、密码、API Key 和 DSN，但仍应仅开放给管理员。

## 社区

- Telegram 频道：<https://t.me/Twilightpanel>
- Telegram 群组：<https://t.me/TwilightPanelChat>
- GitHub Issues：用于反馈可复现问题和功能建议

## 鸣谢

- [Emby](https://emby.media/)
- [Jellyfin](https://jellyfin.org/)
- [TMDB](https://www.themoviedb.org/)
- [Bangumi 番组计划](https://bgm.tv/)
- [Next.js](https://nextjs.org/)
- [Sakura_embyboss](https://github.com/berry8838/Sakura_embyboss)
- [Bangumi-syncer](https://github.com/SanaeMio/Bangumi-syncer)

## 贡献者

<div align="center">

[![Contributors](https://contrib.rocks/image?repo=Prejudice-Studio/Twilight)](https://github.com/Prejudice-Studio/Twilight/graphs/contributors)

</div>

## License

MIT © Prejudice Studio
