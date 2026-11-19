# WebGIS独立部署与二次开发交付方案

GeoFlow WebGIS 合作单位交付版 · v1.0.0

这份源码可在合作单位自己的电脑或服务器上部署。部署后可浏览地图图层、管理数据、运行工作流和时序分析，也可继续开发新的数据产品、算法和地图助手功能。首版随包提供用于验收的软件功能样例。

## 1. 从这里开始

1. 从仓库的 Releases 下载 `GeoFlow-Delivery-v1.0.0.zip` 和同名 `.sha256` 文件，也可以克隆仓库并检出 `v1.0.0` 标签。
2. 下载 ZIP 的读者可执行 `Get-FileHash .\GeoFlow-Delivery-v1.0.0.zip -Algorithm SHA256`，对照 `.sha256` 文件首列，再将 ZIP 解压到开发目录。
3. 安装 Node.js 22、Python 3.12，以及可以运行 Linux 容器的 Docker 和 Compose。Windows 可使用 Docker Desktop 的 Linux 容器模式。
4. 进入解压后包含本 README 和 `deploy/` 的源码根目录。以下命令都从该目录执行。

## 2. 在本机部署

先构建前端。首次安装 npm 依赖及拉取容器基础镜像需能访问相应的软件源，或使用合作单位准备的镜像与缓存。

~~~powershell
Push-Location Code/frontend
npm ci
$env:VITE_BEHIND_GATEWAY = '1'
node node_modules/vite/bin/vite.js build
Pop-Location
~~~

生成自己的运行配置，再启动后端、任务进程、数据服务和网页网关。

~~~powershell
python deploy/init_config.py --output ../geoflow-private/runtime.env

docker compose -p geoflow-delivery --env-file ../geoflow-private/runtime.env -f deploy/compose.yaml build backend
docker compose -p geoflow-delivery --env-file ../geoflow-private/runtime.env -f deploy/compose.yaml up -d
docker compose -p geoflow-delivery --env-file ../geoflow-private/runtime.env -f deploy/compose.yaml ps
~~~

在部署机打开 [http://127.0.0.1:25175/](http://127.0.0.1:25175/)。首次启动从外置 `runtime.env` 的 `DELIVERY_ADMIN_USER` 和 `DELIVERY_ADMIN_PASSWORD` 读取初始账号。`init-admin` 成功创建首个管理员后退出，已有账户会保留。

默认入口只供部署机本机访问。部署到服务器时，供其他电脑访问的域名、HTTPS 和入口由合作单位按自己的网络配置。交付环境使用独立数据卷及内部网络。运行配置保存在源码目录之外。详见[部署与运行](Docs/部署与运行.md)。

## 3. 用合成样例验收

保持服务运行，在源码根目录加载随包样例。

~~~powershell
docker compose -p geoflow-delivery --env-file ../geoflow-private/runtime.env -f deploy/compose.yaml --profile samples run --rm sample-loader
~~~

| 检查 | 如何核对 |
| --- | --- |
| 登录 | 用本机生成的管理员账号进入地图页面。 |
| 数据导入 | 选取 [样例目录](samples/generated/README.md)中的 GeoTIFF，查看导入结果和图层范围。 |
| 点位与区域时序 | 使用样例中的月度栅格和 [GeoJSON 边界](samples/generated/boundary.geojson)，分别检查点位、合并区域和缺测结果。[样例与验证方法](samples/README.md) |
| 地图助手 | 在开发环境运行固定用例，检查识别图层、显示、选中和日期操作。[前端测试说明](Test/frontend/README.md) · [二次开发](Docs/二次开发.md) |

本交付已用全新数据卷跑通上表涉及的登录、导入及点位和区域后端流程，Agent 精选回归 73 项和时序分析前端测试 32 项通过。合成样例用于验证软件行为。真实 NAS、在线模型与科学数据由合作单位按自己的服务配置后联调。[完整验收范围](Docs/交付验收记录.md)

## 4. 从哪里开始二次开发

建议基于 `v1.0.0` 在自己的仓库创建开发分支，先用合成样例复现现有功能，再接入新数据。

| 想开发的功能 | 对应入口 |
| --- | --- |
| 地图、图层列表、时间轴和图表 | [前端工程](Code/frontend/README.md) |
| API、权限和后台任务 | [后端工程](Code/backend/README.md) |
| 新增气象、水文或遥感数据产品和算法 | [算法模块](Code/algorithms/README.md) · [共享接口协议](Code/shared/README.md) |
| 地图助手的指令、提示词和工具 | [助手提示词与工具](Code/agentKits/README.md) · [二次开发说明](Docs/二次开发.md#3-助手操作约定) |
| 修改后重建服务、运行回归 | [停止与更新](Docs/部署与运行.md#7-停止与更新) · [测试目录](Test/README.md) |

源码含前端、后端、算法、助手提示词、部署脚本、合成样例和回归用例。各层 README 可继续向下查找实际文件和入口。交付部署统一使用 `deploy/` 下的 Compose 编排，根目录的 `start.bat` 和 `start.sh` 为原开发辅助入口。

## 本层目录导航

交付运行说明：[部署与运行](Docs/%E9%83%A8%E7%BD%B2%E4%B8%8E%E8%BF%90%E8%A1%8C.md)。本层原有开发说明保留，运行入口与最终验收以交付部署文档为准。

### 子目录

| 目录                           | 说明                           |
| ---------------------------- | ---------------------------- |
| [Code](Code/README.md)       | 应用源码与共享组件。                   |
| [Docs](Docs/README.md)       | 交付部署、运行与开发文档。                |
| [Env](Env/README.md)         | 开发环境辅助脚本。                    |
| [Test](Test/README.md)       | 回归用例与检查辅助。                   |
| [Tools](Tools/README.md)     | 开发与数据准备辅助工具。                 |
| [deploy](deploy/README.md)   | 独立交付环境的初始化与容器编排。             |
| [launch](launch/README.md)   | 模块化启动辅助源码；交付运行按 deploy 文档执行。 |
| [samples](samples/README.md) | 合成样例、生成与功能检查脚本。              |

### 文件

| 文件                                                 | 类型           |
| -------------------------------------------------- | ------------ |
| [.dockerignore](.dockerignore)                     | 源码或配置        |
| [.editorconfig](.editorconfig)                     | 源码或配置        |
| [.gitattributes](.gitattributes)                   | 源码或配置        |
| [.gitignore](.gitignore)                           | 源码或配置        |
| [.pre-commit-config.yaml](.pre-commit-config.yaml) | YAML 配置      |
| [launch.py](launch.py)                             | Python 模块或脚本 |
| [ruff.toml](ruff.toml)                             | 源码或配置        |
| [start.bat](start.bat)                             | 原开发辅助入口         |
| [start.sh](start.sh)                               | Shell 脚本     |
| [stop.bat](stop.bat)                               | 原开发辅助入口         |
| [stop.sh](stop.sh)                                 | Shell 脚本     |
