# 本地合成样例

本目录提供功能演示与验收使用的合成 GeoTIFF 和边界，按本地月度数据组织。样例不能作为真实观测、科学结论或 NAS 取数结果。

## 加载

在源码根目录，使用本交付环境的外置配置：

~~~powershell
docker compose -p geoflow-delivery --env-file ../geoflow-private/runtime.env -f deploy/compose.yaml --profile samples run --rm sample-loader
~~~

sample-loader 是服务名，samples 是 profile。独立新数据卷已完成该链路的 HTTP 验收。

## 已核对内容

- 合成 GeoTIFF 导入和点位时序。
- 两要素边界合并后的区域时序。
- 缺测与真零分别处理。
- 特定合成区域中的 50% 有效像元覆盖。

50% 覆盖属于该合成样例的检查结果，不代表真实产品覆盖率。月份、变量和网格以生成数据及元数据为准。

本次未将 NAS 或在线 Provider 联调、浏览器 CSV/PNG 按钮操作列为已完成验收。完整范围见 [交付验收记录](../Docs/交付验收记录.md)。

界面、截图与导出结果应保留合成样例标识；真实科学数据由接收方独立配置和验证。

<!-- geoflow-directory-navigation:start -->
## 本层目录导航

[源码根目录](../README.md) · [上一级](../README.md)

交付运行说明：[部署与运行](../Docs/%E9%83%A8%E7%BD%B2%E4%B8%8E%E8%BF%90%E8%A1%8C.md)。本层原有开发说明保留，运行入口与最终验收以交付部署文档为准。

### 子目录

| 目录 | 说明 |
|---|---|
| [generated](generated/README.md) | 已生成的合成样例与配套元数据，不作为真实科学结果。 |

### 文件

| 文件 | 类型 |
|---|---|
| [.gitignore](.gitignore) | 源码或配置 |
| [generate.py](generate.py) | Python 模块或脚本 |
| [smoke.py](smoke.py) | Python 模块或脚本 |

<!-- geoflow-directory-navigation:end -->
