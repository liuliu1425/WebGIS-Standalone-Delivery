# frontend

前端组件、状态与接口回归用例。

## 运行前端测试

从仓库根目录执行。测试位于 `Test/frontend/`，依赖安装在 `Code/frontend/`。  
在仓库根目录创建依赖目录链接，让测试与应用共用同一份 Vue、Pinia 和 MapLibre。若根目录已有 `node_modules`，请先核对其指向。

Windows PowerShell

```powershell
npm --prefix Code/frontend ci
if (-not (Test-Path -LiteralPath 'node_modules')) {
  New-Item -ItemType Junction -Path 'node_modules' -Target (Resolve-Path 'Code/frontend/node_modules').Path | Out-Null
}
npm --prefix Code/frontend test
```

Linux 或 macOS

```sh
npm --prefix Code/frontend ci
test -e node_modules || ln -s Code/frontend/node_modules node_modules
npm --prefix Code/frontend test
```

只复跑时序分析用例时，使用 `npm --prefix Code/frontend test -- spatial-timeseries`。  
交付复测覆盖 5 个时序分析前端测试文件，共 32 个用例通过。

## 本层目录导航

[源码根目录](../../README.md) · [上一级](../README.md)

交付运行说明：[部署与运行](../../Docs/%E9%83%A8%E7%BD%B2%E4%B8%8E%E8%BF%90%E8%A1%8C.md)。本层原有开发说明保留，运行入口与最终验收以交付部署文档为准。

### 子目录

| 目录                                     | 说明                 |
| -------------------------------------- | ------------------ |
| [components](components/README.md)     | 本目录的源码、配置与说明见下方导航。 |
| [composables](composables/README.md)   | 本目录的源码、配置与说明见下方导航。 |
| [data](data/README.md)                 | 本目录的源码、配置与说明见下方导航。 |
| [data-manager](data-manager/README.md) | 本目录的源码、配置与说明见下方导航。 |
| [directives](directives/README.md)     | 本目录的源码、配置与说明见下方导航。 |
| [fixtures](fixtures/README.md)         | 本目录的源码、配置与说明见下方导航。 |
| [layers](layers/README.md)             | 本目录的源码、配置与说明见下方导航。 |
| [services](services/README.md)         | 本目录的源码、配置与说明见下方导航。 |
| [stores](stores/README.md)             | 本目录的源码、配置与说明见下方导航。 |
| [styles](styles/README.md)             | 本目录的源码、配置与说明见下方导航。 |
| [ui-copy](ui-copy/README.md)           | 本目录的源码、配置与说明见下方导航。 |
| [utils](utils/README.md)               | 本目录的源码、配置与说明见下方导航。 |
| [views](views/README.md)               | 本目录的源码、配置与说明见下方导航。 |

### 文件

| 文件                                                                                     | 类型               |
| -------------------------------------------------------------------------------------- | ---------------- |
| [auth-router.test.ts](auth-router.test.ts)                                             | TypeScript 模块或类型 |
| [session-expired.test.ts](session-expired.test.ts)                                     | TypeScript 模块或类型 |
| [spatial-timeseries-availability.test.ts](spatial-timeseries-availability.test.ts)     | TypeScript 模块或类型 |
| [spatial-timeseries-boundary-merge.test.ts](spatial-timeseries-boundary-merge.test.ts) | TypeScript 模块或类型 |
| [spatial-timeseries-map.test.ts](spatial-timeseries-map.test.ts)                       | TypeScript 模块或类型 |
| [spatial-timeseries-results.test.ts](spatial-timeseries-results.test.ts)               | TypeScript 模块或类型 |
| [spatial-timeseries.test.ts](spatial-timeseries.test.ts)                               | TypeScript 模块或类型 |
