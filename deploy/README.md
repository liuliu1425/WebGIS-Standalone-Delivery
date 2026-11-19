# 运行编排入口

本目录包含独立交付环境的配置初始化、容器编排、首位管理员创建和网关配置。

- init_config.py：在源码目录之外生成私有配置。
- init_admin.py：账户库为空时创建首位管理员，已有账户保持不变。
- compose.yaml：默认编排；包含一次性 init-admin，入口限本机，应用网络内部隔离。
- compose.egress.yaml：为接收方自选 Provider 显式提供可选网络通路。
- seed_samples.py：本地合成样例加载，服务名 sample-loader，profile 为 samples。
- .env.example：配置字段示例，不附真实认证材料。

初始管理员信息从生成的私有配置读取，不在此列出。详细命令和账号初始化行为见 [部署与运行](../Docs/部署与运行.md)。

独立新数据卷验收已通过，实际范围见 [交付验收记录](../Docs/交付验收记录.md)。npm ci 保留为正常首次安装流程，本次前端构建采用锁文件匹配的本机依赖副本。

<!-- geoflow-directory-navigation:start -->
## 本层目录导航

[源码根目录](../README.md) · [上一级](../README.md)

交付运行说明：[部署与运行](../Docs/%E9%83%A8%E7%BD%B2%E4%B8%8E%E8%BF%90%E8%A1%8C.md)。本层原有开发说明保留，运行入口与最终验收以交付部署文档为准。

### 文件

| 文件 | 类型 |
|---|---|
| [.env.example](.env.example) | 配置字段示例 |
| [compose.egress.yaml](compose.egress.yaml) | YAML 配置 |
| [compose.yaml](compose.yaml) | YAML 配置 |
| [constraints.txt](constraints.txt) | 依赖清单或约束 |
| [Dockerfile.backend](Dockerfile.backend) | 镜像构建定义 |
| [init_admin.py](init_admin.py) | Python 模块或脚本 |
| [init_config.py](init_config.py) | Python 模块或脚本 |
| [nginx.conf](nginx.conf) | 源码或配置 |
| [seed_samples.py](seed_samples.py) | Python 模块或脚本 |

<!-- geoflow-directory-navigation:end -->
