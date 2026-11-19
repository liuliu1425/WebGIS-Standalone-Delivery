"""Point/region series provider; uses the existing workflow lifecycle."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from contracts.product import ProductManifest, ProductRef
from modules.base import BaseModule
from modules.registry import register_module_decorator
from modules.statistics import _store_manifest
from workflow.schemas import PortSpec


@register_module_decorator(name="spatial_timeseries")
class SpatialTimeSeriesModule(BaseModule):
    name = "spatial_timeseries"
    description = "Read containing pixel or fixed-region series from dated rasters."
    input_ports = [
        PortSpec(
            name="algorithm_params", kind="config", data_class="dict", required=False
        )
    ]
    output_ports = [
        PortSpec(name="manifest", kind="artifact", data_class="product_manifest")
    ]

    def execute(self, inputs, params, ctx):
        options = dict(inputs.get("algorithm_params", {}))
        flag = Path(
            options.get("cancel_flag_path")
            or ctx.runtime_context.env.get("cancel_flag_path")
            or ctx.runtime_context.tmp_dir / "cancel.requested"
        )

        def cancel():
            if flag.exists():
                raise RuntimeError("用户已取消时序分析。")

        cancel()
        output = (
            ctx.workspace
            / "products"
            / "spatial_timeseries"
            / ctx.runtime_context.run_id
        )
        output.mkdir(parents=True, exist_ok=True)
        path = output / "spatial-timeseries.json"
        plan_path, progress_path = output / "request.json", output / "progress.json"
        plan_path.write_text(
            json.dumps(options["plan"], ensure_ascii=False, allow_nan=False),
            encoding="utf-8",
        )
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(Path(__file__).resolve().parents[4]), *sys.path]
        )
        with (output / "reader.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    "-X",
                    "faulthandler",
                    "-m",
                    "shared.spatial_timeseries",
                    str(plan_path),
                    str(path),
                    str(flag),
                    str(progress_path),
                    str(os.getpid()),
                ],
                env=env,
                stdout=log,
                stderr=log,
            )
            last_done = 0
            try:
                while process.poll() is None:
                    cancel()
                    if progress_path.exists():
                        progress = json.loads(progress_path.read_text(encoding="utf-8"))
                        if progress["done"] != last_done and ctx.logger_adapter:
                            ctx.logger_adapter.emit_progress(
                                "spatial_timeseries",
                                progress["done"] / progress["total"],
                                f"已读取 {progress['done']}/{progress['total']} 个观测期",
                            )
                        last_done = progress["done"]
                    time.sleep(0.2)
                cancel()
                if process.returncode != 0:
                    raise RuntimeError(
                        f"时序数据读取失败（进程代码 {process.returncode}），请查看任务日志。"
                    )
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
        result = json.loads(path.read_text(encoding="utf-8"))
        manifest = ProductManifest(
            job_id=ctx.request.job_id,
            run_id=ctx.runtime_context.run_id,
            products=[
                ProductRef(
                    name="spatial_timeseries",
                    type="json",
                    uri=str(path),
                    variable=result["product"]["variable"],
                )
            ],
            main_layers=[],
        )
        return _store_manifest(
            ctx,
            module_name=self.name,
            manifest=manifest,
            metadata={"periods": len(result["rows"])},
        )
