# Data-sync — 数据与运行隔离

| 栈 | 路径 | 职责 |
|----|------|------|
| **运行** | `Code/backend/docker-compose.yml`（`-p backend`） | Redis、MinIO、**`cgda-open-meteo` API**（长期运行） |
| **数据** | `Code/infra/data-sync/`（`-p data-sync`） | 一次性 `run --rm` 任务（当前仅 `open-meteo-sync`；可继续加） |

原则：核心数据只进 **Docker named volume**（本机 Docker Desktop → `I:\Docker\DockerDesktop`），不进项目目录 / D:。

**Windows**：Docker Desktop 与执行 `sync.ps1` / `launch.py sync` 的终端须以**管理员身份**运行，否则可能镜像无法访问或 volume/配置读失败。

## 当前任务

| Compose service | 写入 volume | 读取方 |
|-----------------|-------------|--------|
| `open-meteo-sync` | `backend_open-meteo-data` | `cgda-open-meteo` |

## 同步

Windows:

```powershell
cd Code\infra\data-sync
Copy-Item .env.example .env   # 首次
# 建议先: docker compose -p backend up -d   （创建 volume + 启 API）
.\sync.ps1                    # 默认 open-meteo-sync
.\sync.ps1 open-meteo-sync    # 显式任务名
.\list-jobs.ps1               # 列出可跑的 sync profile 服务
```

Linux / macOS:

```bash
cd Code/infra/data-sync
cp -n .env.example .env
./sync.sh
./sync.sh open-meteo-sync
./list-jobs.sh
```

Celery Beat / 设置页「立即同步」/ 一键：`python launch.py sync`（默认任务 `open-meteo-sync`，队列 `weather-batch`）。

## 如何添加更多数据任务

1. 在 `docker-compose.yml` 的 `services:` 下按模板新增 service（`profiles: ["sync"]`，`restart: "no"`）。
2. 数据用 **named volume**（可 `external: true` 与运行栈共用，或本文件新建）。
3. 需要时增加 `.env.example` 变量与 `.\sync.ps1 <service-name>` 用法。
4. 若需自动调度：仿 `app/tasks/open_meteo_sync_tasks.py` 再加 Celery 任务指向新 service。

不要把长期 API 放进本 compose。

## 清理

```powershell
.\prune-cache.ps1   # 仅应用侧 weatherengine 缓存

# 清空 Open-Meteo 库（需重新 sync）
docker compose -p backend stop open-meteo
docker volume rm backend_open-meteo-data
```

<!-- geoflow-directory-navigation:start -->
## 本层目录导航

[源码根目录](../../../README.md) · [上一级](../README.md)

交付运行说明：[部署与运行](../../../Docs/%E9%83%A8%E7%BD%B2%E4%B8%8E%E8%BF%90%E8%A1%8C.md)。本层原有开发说明保留，运行入口与最终验收以交付部署文档为准。

### 文件

| 文件 | 类型 |
|---|---|
| [.env.example](.env.example) | 配置字段示例 |
| [_compose.ps1](_compose.ps1) | PowerShell 脚本 |
| [_compose.sh](_compose.sh) | Shell 脚本 |
| [docker-compose.yml](docker-compose.yml) | YAML 配置 |
| [list-jobs.ps1](list-jobs.ps1) | PowerShell 脚本 |
| [list-jobs.sh](list-jobs.sh) | Shell 脚本 |
| [prune-cache.ps1](prune-cache.ps1) | PowerShell 脚本 |
| [prune-cache.sh](prune-cache.sh) | Shell 脚本 |
| [sync.ps1](sync.ps1) | PowerShell 脚本 |
| [sync.sh](sync.sh) | Shell 脚本 |

<!-- geoflow-directory-navigation:end -->
