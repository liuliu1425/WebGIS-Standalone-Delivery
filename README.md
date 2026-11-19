# GeoFlow

GeoFlow 是一个 WebGIS 数据展示与分析应用，包含地图图层管理、时序分析、工作流和自然语言地图助手。交付源码包括前端、后端、共享协议、算法模块及相应回归用例。

本交付候选已完成独立新数据卷启动、初始管理员创建和本地合成数据 HTTP 验收；Agent 精选回归 73 条通过。具体范围与未验证项见 [交付验收记录](Docs/交付验收记录.md)。

## 从哪里开始

| 需要完成的事 | 文档 |
|---|---|
| 准备依赖、生成配置、首次登录、启动与停止 | [部署与运行](Docs/部署与运行.md) |
| 了解模块、修改代码、执行回归 | [二次开发](Docs/二次开发.md) |
| 查看已完成与未完成的验证 | [交付验收记录](Docs/交付验收记录.md) |
| 查看交付文档目录 | [文档导航](Docs/README.md) |
| 查看运行编排与合成样例 | [deploy](deploy/README.md)、[samples](samples/README.md) |

## 交付内容

| 目录 | 内容 |
|---|---|
| Code/frontend | Vue 与 TypeScript 前端，地图、图层、助手及曲线界面 |
| Code/backend | API、数据访问、任务编排与业务服务 |
| Code/agentKits | 助手提示词与工具定义 |
| Code/algorithms | 算法实现与执行协议 |
| Code/shared | 前后端及算法共享的数据约定 |
| deploy | 配置初始化、容器编排、首位管理员初始化与网关入口 |
| samples | 用于功能演示与验收的本地合成样例 |
| Test | 前后端与算法回归用例 |
| Docs | 部署、运行、验收与二次开发说明 |

各层 README 提供实际子目录与文件导航，并保留已有模块说明。

## 部署约定

- Node.js 22 构建前端；Python 3.12 执行配置初始化；Docker Compose 管理运行组件。
- 配置文件在源码目录之外生成，由接收方保存。源码中不提供接收方的登录或数据服务凭据。
- 默认仅在本机回环地址开放 25175 入口，其他组件通过编排内部网络连接。
- 默认限制运行组件访问外部网络。确需在线 Provider 时，显式使用 deploy/compose.egress.yaml，并配置接收方自选服务。
- 交付部署入口统一采用 deploy 下的初始化脚本和编排。

## 快速准备

以下使用 PowerShell，当前目录为源码根目录，Python 命令须对应 3.12。配置示例路径位于源码目录之外。

~~~powershell
cd Code/frontend
npm ci
$env:VITE_BEHIND_GATEWAY = '1'
node node_modules/vite/bin/vite.js build
cd ../..

python deploy/init_config.py --output ../geoflow-private/runtime.env
docker compose -p geoflow-delivery --env-file ../geoflow-private/runtime.env -f deploy/compose.yaml build backend
docker compose -p geoflow-delivery --env-file ../geoflow-private/runtime.env -f deploy/compose.yaml up -d
~~~

npm ci 是正常首次网络安装流程。本次验收的前端构建实际使用了与锁文件一致的本机依赖副本；这不代表已经提供或验证了完整离线安装介质。

打开本机回环地址的 25175 端口，使用外置配置中的初始管理员账号登录。账号读取及一次性初始化行为见 [首次账号](Docs/部署与运行.md#4-首次管理员与登录)。

合成样例通过 sample-loader 服务、samples profile 加载，精确命令见部署文档。样例以本地月度数据验证功能，不代表真实观测。

## 数据与助手

真实数据源、在线模型及 Provider 由接收方独立配置和授权。未配置、无有效像元、日期缺测与请求失败分别处理；合成样例不能作为真实产品结果。

助手中的添加、显示、选中和日期操作具有不同含义。详细约定见 [二次开发](Docs/二次开发.md)。额度按实际账号与部署策略生效，不以界面文案推断无限量或数据服务可用性。

<!-- geoflow-directory-navigation:start -->
## 本层目录导航

交付运行说明：[部署与运行](Docs/%E9%83%A8%E7%BD%B2%E4%B8%8E%E8%BF%90%E8%A1%8C.md)。本层原有开发说明保留，运行入口与最终验收以交付部署文档为准。

### 子目录

| 目录 | 说明 |
|---|---|
| [Code](Code/README.md) | 应用源码与共享组件。 |
| [Docs](Docs/README.md) | 交付部署、运行与开发文档。 |
| [Env](Env/README.md) | 开发环境辅助脚本。 |
| [Test](Test/README.md) | 回归用例与检查辅助。 |
| [Tools](Tools/README.md) | 开发与数据准备辅助工具。 |
| [deploy](deploy/README.md) | 独立交付环境的初始化与容器编排。 |
| [launch](launch/README.md) | 模块化启动辅助源码；交付运行按 deploy 文档执行。 |
| [samples](samples/README.md) | 合成样例、生成与功能检查脚本。 |

### 文件

| 文件 | 类型 |
|---|---|
| [.dockerignore](.dockerignore) | 源码或配置 |
| [.editorconfig](.editorconfig) | 源码或配置 |
| [.gitattributes](.gitattributes) | 源码或配置 |
| [.gitignore](.gitignore) | 源码或配置 |
| [.pre-commit-config.yaml](.pre-commit-config.yaml) | YAML 配置 |
| [launch.py](launch.py) | Python 模块或脚本 |
| [ruff.toml](ruff.toml) | 源码或配置 |
| [start.bat](start.bat) | 命令入口 |
| [start.sh](start.sh) | Shell 脚本 |
| [stop.bat](stop.bat) | 命令入口 |
| [stop.sh](stop.sh) | Shell 脚本 |

<!-- geoflow-directory-navigation:end -->
