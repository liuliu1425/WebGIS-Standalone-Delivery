# WebGIS GEE Core

`core` 目录用于承载 WebGIS 后端 `gee` 模块的所有 Python 代码。

当前阶段目标：

1. 建立可扩展的 GEE 工作流引擎骨架。
2. 定义统一的工作流、节点、账号池和存储抽象。
3. 提供可被 FastAPI 和 Celery 复用的服务层接口。

## 当前能力

1. 工作流定义模型
2. 节点注册机制
3. 基础工作流校验器
4. 最小执行服务
5. 示例节点

## 开发说明

安装依赖：

```bash
pip install -e .[dev]
```

运行测试：

```bash
pytest
```

<!-- geoflow-directory-navigation:start -->
## 本层目录导航

[源码根目录](../../../../../README.md) · [上一级](../README.md)

交付运行说明：[部署与运行](../../../../../Docs/%E9%83%A8%E7%BD%B2%E4%B8%8E%E8%BF%90%E8%A1%8C.md)。本层原有开发说明保留，运行入口与最终验收以交付部署文档为准。

### 子目录

| 目录 | 说明 |
|---|---|
| [src](src/README.md) | 本目录的源码、配置与说明见下方导航。 |
| [tests](tests/README.md) | 本目录的源码、配置与说明见下方导航。 |

### 文件

| 文件 | 类型 |
|---|---|
| [pyproject.toml](pyproject.toml) | 工程与依赖声明 |

<!-- geoflow-directory-navigation:end -->
