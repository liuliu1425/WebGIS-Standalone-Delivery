# services

业务服务与执行协作。

<!-- geoflow-directory-navigation:start -->
## 本层目录导航

[源码根目录](../../../../README.md) · [上一级](../README.md)

交付运行说明：[部署与运行](../../../../Docs/%E9%83%A8%E7%BD%B2%E4%B8%8E%E8%BF%90%E8%A1%8C.md)。本层原有开发说明保留，运行入口与最终验收以交付部署文档为准。

### 子目录

| 目录 | 说明 |
|---|---|
| [agent](agent/README.md) | 指令识别、对象定位、执行流程及模型工具适配。 |
| [crs](crs/README.md) | 本目录的源码、配置与说明见下方导航。 |
| [import_service](import_service/README.md) | 本目录的源码、配置与说明见下方导航。 |
| [nas_ondemand](nas_ondemand/README.md) | 按需数据访问与真实日期索引。 |
| [providers](providers/README.md) | 本目录的源码、配置与说明见下方导航。 |
| [remote_access](remote_access/README.md) | 本目录的源码、配置与说明见下方导航。 |
| [workflow](workflow/README.md) | 本目录的源码、配置与说明见下方导航。 |

### 文件

| 文件 | 类型 |
|---|---|
| [__init__.py](__init__.py) | Python 模块或脚本 |
| [_sqlite_pool.py](_sqlite_pool.py) | Python 模块或脚本 |
| [analysis_run_service.py](analysis_run_service.py) | Python 模块或脚本 |
| [analysis_tool_catalog.py](analysis_tool_catalog.py) | Python 模块或脚本 |
| [api_config.py](api_config.py) | Python 模块或脚本 |
| [api_keys_repository.py](api_keys_repository.py) | Python 模块或脚本 |
| [auth_bootstrap.py](auth_bootstrap.py) | Python 模块或脚本 |
| [bridge_protocol.py](bridge_protocol.py) | Python 模块或脚本 |
| [cache_service.py](cache_service.py) | Python 模块或脚本 |
| [circuit_breaker.py](circuit_breaker.py) | Python 模块或脚本 |
| [config_api_keys.py](config_api_keys.py) | Python 模块或脚本 |
| [config_gee_accounts.py](config_gee_accounts.py) | Python 模块或脚本 |
| [config_remote_storage.py](config_remote_storage.py) | Python 模块或脚本 |
| [config_service.py](config_service.py) | Python 模块或脚本 |
| [config_weather_providers.py](config_weather_providers.py) | Python 模块或脚本 |
| [coordinate_transform_service.py](coordinate_transform_service.py) | Python 模块或脚本 |
| [credential_resolver.py](credential_resolver.py) | Python 模块或脚本 |
| [data_cache_service.py](data_cache_service.py) | Python 模块或脚本 |
| [data_input_policy_service.py](data_input_policy_service.py) | Python 模块或脚本 |
| [dataset_registry_service.py](dataset_registry_service.py) | Python 模块或脚本 |
| [deployment_config.py](deployment_config.py) | Python 模块或脚本 |
| [download_manifest_writer.py](download_manifest_writer.py) | Python 模块或脚本 |
| [download_orchestrator.py](download_orchestrator.py) | Python 模块或脚本 |
| [download_progress_tracker.py](download_progress_tracker.py) | Python 模块或脚本 |
| [download_service.py](download_service.py) | Python 模块或脚本 |
| [download_utils.py](download_utils.py) | Python 模块或脚本 |
| [effective_config.py](effective_config.py) | Python 模块或脚本 |
| [engine_request_registry.py](engine_request_registry.py) | Python 模块或脚本 |
| [env_file_upsert.py](env_file_upsert.py) | Python 模块或脚本 |
| [errors.py](errors.py) | Python 模块或脚本 |
| [failure_classifier.py](failure_classifier.py) | Python 模块或脚本 |
| [feedback_store.py](feedback_store.py) | Python 模块或脚本 |
| [gee_bridge_service.py](gee_bridge_service.py) | Python 模块或脚本 |
| [gee_credentials_repository.py](gee_credentials_repository.py) | Python 模块或脚本 |
| [gee_parallel_config.py](gee_parallel_config.py) | Python 模块或脚本 |
| [geo_math.py](geo_math.py) | Python 模块或脚本 |
| [layer_catalog.py](layer_catalog.py) | Python 模块或脚本 |
| [layer_group_repository.py](layer_group_repository.py) | Python 模块或脚本 |
| [layer_workflow_validator.py](layer_workflow_validator.py) | Python 模块或脚本 |
| [login_lockout.py](login_lockout.py) | Python 模块或脚本 |
| [node_template_registry.py](node_template_registry.py) | Python 模块或脚本 |
| [object_store.py](object_store.py) | Python 模块或脚本 |
| [online_tile_source_service.py](online_tile_source_service.py) | Python 模块或脚本 |
| [open_meteo_sync_executor.py](open_meteo_sync_executor.py) | Python 模块或脚本 |
| [overlay_asset_workflow_service.py](overlay_asset_workflow_service.py) | Python 模块或脚本 |
| [overlay_recolor.py](overlay_recolor.py) | Python 模块或脚本 |
| [overlay_registry.py](overlay_registry.py) | Python 模块或脚本 |
| [overlay_tile_service.py](overlay_tile_service.py) | Python 模块或脚本 |
| [passwords.py](passwords.py) | Python 模块或脚本 |
| [permission_repository.py](permission_repository.py) | Python 模块或脚本 |
| [portal_catalog.py](portal_catalog.py) | Python 模块或脚本 |
| [portal_credentials.py](portal_credentials.py) | Python 模块或脚本 |
| [portal_workflow_map.py](portal_workflow_map.py) | Python 模块或脚本 |
| [provider_result_builder.py](provider_result_builder.py) | Python 模块或脚本 |
| [provider_workflow_service.py](provider_workflow_service.py) | Python 模块或脚本 |
| [python_provider_bridge_service.py](python_provider_bridge_service.py) | Python 模块或脚本 |
| [python_provider_request_builder.py](python_provider_request_builder.py) | Python 模块或脚本 |
| [python_provider_result_builder.py](python_provider_result_builder.py) | Python 模块或脚本 |
| [raster_preview_service.py](raster_preview_service.py) | Python 模块或脚本 |
| [remote_auth_resolver.py](remote_auth_resolver.py) | Python 模块或脚本 |
| [remote_dataset_grants.py](remote_dataset_grants.py) | Python 模块或脚本 |
| [remote_source_migration.py](remote_source_migration.py) | Python 模块或脚本 |
| [remote_source_registry.py](remote_source_registry.py) | Python 模块或脚本 |
| [remote_storage_credentials_repository.py](remote_storage_credentials_repository.py) | Python 模块或脚本 |
| [research_data_settings_repository.py](research_data_settings_repository.py) | Python 模块或脚本 |
| [resource_profile_resolver.py](resource_profile_resolver.py) | Python 模块或脚本 |
| [result_storage.py](result_storage.py) | Python 模块或脚本 |
| [result_view_service.py](result_view_service.py) | Python 模块或脚本 |
| [secret_cipher.py](secret_cipher.py) | Python 模块或脚本 |
| [service_restart.py](service_restart.py) | Python 模块或脚本 |
| [session_service.py](session_service.py) | Python 模块或脚本 |
| [source_fetcher.py](source_fetcher.py) | Python 模块或脚本 |
| [spatial_repository.py](spatial_repository.py) | Python 模块或脚本 |
| [spatial_timeseries_service.py](spatial_timeseries_service.py) | Python 模块或脚本 |
| [spatial_timeseries_source.py](spatial_timeseries_source.py) | Python 模块或脚本 |
| [spatialite_loader.py](spatialite_loader.py) | Python 模块或脚本 |
| [theme_repository.py](theme_repository.py) | Python 模块或脚本 |
| [tile_provider_protocol.py](tile_provider_protocol.py) | Python 模块或脚本 |
| [tile_provider_registry.py](tile_provider_registry.py) | Python 模块或脚本 |
| [tile_proxy_service.py](tile_proxy_service.py) | Python 模块或脚本 |
| [user_repository.py](user_repository.py) | Python 模块或脚本 |
| [user_token_repository.py](user_token_repository.py) | Python 模块或脚本 |
| [user_workspace_store.py](user_workspace_store.py) | Python 模块或脚本 |
| [weather_bridge_service.py](weather_bridge_service.py) | Python 模块或脚本 |
| [weather_coverage_cache.py](weather_coverage_cache.py) | Python 模块或脚本 |
| [weather_engine_settings.py](weather_engine_settings.py) | Python 模块或脚本 |
| [weather_engine_settings_repository.py](weather_engine_settings_repository.py) | Python 模块或脚本 |
| [weather_providers_repository.py](weather_providers_repository.py) | Python 模块或脚本 |
| [weather_sync_service.py](weather_sync_service.py) | Python 模块或脚本 |
| [workflow_definition_service.py](workflow_definition_service.py) | Python 模块或脚本 |
| [workflow_execution.py](workflow_execution.py) | Python 模块或脚本 |
| [workflow_graph_compiler.py](workflow_graph_compiler.py) | Python 模块或脚本 |
| [workflow_repository.py](workflow_repository.py) | Python 模块或脚本 |
| [workflow_request_resolver.py](workflow_request_resolver.py) | Python 模块或脚本 |
| [workflow_timer_service.py](workflow_timer_service.py) | Python 模块或脚本 |
| [workspace_dismissals.py](workspace_dismissals.py) | Python 模块或脚本 |
| [zonal_stats_service.py](zonal_stats_service.py) | Python 模块或脚本 |

<!-- geoflow-directory-navigation:end -->
