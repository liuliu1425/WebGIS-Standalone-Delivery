// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TimeSeriesWorkspace from "@/components/timeseries/TimeSeriesWorkspace.vue";
import { seriesCSV, type SeriesResult } from "@/services/spatial-timeseries";

const api = vi.hoisted(() => ({
  submit: vi.fn(),
  status: vi.fn(),
  result: vi.fn(),
  cancel: vi.fn(),
  admin: vi.fn(),
}));
vi.mock("@/app/admin-boundaries", () => ({
  loadWorldAdmin0Boundaries: api.admin,
  loadWorldAdmin1Boundaries: api.admin,
}));
vi.mock("@/services/spatial-timeseries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/spatial-timeseries")>()),
  getSeriesProducts: async () => ({
    items: [
      {
        id: "fixture-sm",
        catalog_id: "fixture-product",
        product_name: "测试夹具（非真实产品）",
        variable: "SM",
        variable_name: "土壤水分",
        unit: "m³/m³",
        unit_source: "fixture",
        native_step: "1d",
        timezone: "日期型观测",
        frames: [
          {
            key: "20251201",
            start: "2025-12-01",
            end: "2025-12-01",
            cadence: "daily",
          },
          {
            key: "20251203",
            start: "2025-12-03",
            end: "2025-12-03",
            cadence: "daily",
          },
        ],
      },
    ],
  }),
  submitSeries: api.submit,
  getSeriesRun: api.status,
  getSeriesResult: api.result,
  cancelSeries: api.cancel,
}));
const props = {
  open: true,
  locate: vi.fn(() => true),
  draw: vi.fn(() => true),
  cancelDraw: vi.fn(),
  preview: vi.fn(),
};
const create = async () => {
  const w = mount(TimeSeriesWorkspace, {
    props,
    global: { stubs: { TimeSeriesResults: true } },
  });
  await flushPromises();
  return w;
};
const clickGenerate = async (w: Awaited<ReturnType<typeof create>>) => {
  await w
    .findAll("button")
    .find((b) => b.text() === "生成曲线")!
    .trigger("click");
  await flushPromises();
};
beforeEach(() => {
  vi.clearAllMocks();
  api.submit.mockResolvedValue({ run_id: "fixture-run" });
  api.status.mockResolvedValue({
    status: "cancelled",
    progress: 0,
    message: "",
    result_refs: [],
  });
});
describe("时序表单与导出", () => {
  it.each(["cancelled", "succeeded"])("取消反馈以服务端实际终态 %s 为准", async (status) => {
    api.status.mockResolvedValue({status:"running",progress:35,result_refs:[]});
    api.cancel.mockResolvedValue({status});
    const w=await create();
    await clickGenerate(w);
    await w.findAll("button").find(b=>b.text()==="取消计算")!.trigger("click");
    await flushPromises();
    expect(w.text()).toContain(status==="cancelled" ? "用户已取消" : "任务已经完成");
    if(status==="succeeded") expect(w.text()).not.toContain("用户已取消");
    w.unmount();
  });
  it("切换行政区层级立即清除旧区域，迟到的边界也不会覆盖新的来源", async () => {
    const w = await create();
    const polygon = {
      type: "Feature",
      properties: { name: "夹具区域" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    };
    api.admin.mockResolvedValueOnce({
      type: "FeatureCollection",
      features: [polygon],
    });
    await w
      .findAll("button")
      .find((b) => b.text() === "区域分析")!
      .trigger("click");
    await w.get('[aria-label="区域来源"]').setValue("admin");
    await w
      .findAll("button")
      .find((b) => b.text() === "加载边界")!
      .trigger("click");
    await flushPromises();
    await w.get('[aria-label="选择一个区域要素"]').setValue("0");
    await w.get('[aria-label="行政区层级"]').setValue("country");
    await clickGenerate(w);
    expect(api.submit).not.toHaveBeenCalled();
    let finish: (value: unknown) => void = () => {};
    api.admin.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await w
      .findAll("button")
      .find((b) => b.text() === "加载边界")!
      .trigger("click");
    await w.get('[aria-label="区域来源"]').setValue("file");
    finish({ type: "FeatureCollection", features: [polygon] });
    await flushPromises();
    expect(w.find('[aria-label="选择一个区域要素"]').exists()).toBe(false);
    w.unmount();
  });
  it("数字输入 v-model 转换后仍按经度、纬度提交，不触发渲染异常", async () => {
    const w = await create();
    await w.get('[aria-label="分析经度"]').setValue("114.3");
    await w.get('[aria-label="分析纬度"]').setValue("30.6");
    await clickGenerate(w);
    expect(api.submit).toHaveBeenCalledWith(
      expect.objectContaining({ point: [114.3, 30.6], mode: "point" }),
    );
    w.unmount();
  });
  it("空坐标不能被当作 0", async () => {
    const w = await create();
    await w.get('[aria-label="分析经度"]').setValue("");
    await clickGenerate(w);
    expect(api.submit).not.toHaveBeenCalled();
    expect(w.text()).toContain("经度范围");
    w.unmount();
  });
  it("超出数据范围或倒置的日期拒绝提交", async () => {
    const w = await create();
    await w.get('[aria-label="分析开始日期"]').setValue("2025-12-04");
    await clickGenerate(w);
    expect(api.submit).not.toHaveBeenCalled();
    expect(w.text()).toContain("开始日期不能晚于结束日期");
    w.unmount();
  });
  it("改条件和地图定位均不触发分析", async () => {
    const w = await create();
    await w.get('[aria-label="分析经度"]').setValue("0");
    await w
      .findAll("button")
      .find((b) => b.text().includes("在地图上定位"))!
      .trigger("click");
    await flushPromises();
    expect(props.locate).toHaveBeenCalledWith([0, 39.9]);
    expect(api.submit).not.toHaveBeenCalled();
    w.unmount();
  });
  it("提交后改变坐标不会改变正在执行的请求", async () => {
    const w = await create();
    await clickGenerate(w);
    await w.get('[aria-label="分析经度"]').setValue("100");
    expect(api.submit.mock.calls[0][0].point).toEqual([116.4, 39.9]);
    expect(api.submit).toHaveBeenCalledTimes(1);
    w.unmount();
  });
  it("读取任务产物而不是工作流清单，完成后可展示空数据说明", async () => {
    api.status.mockResolvedValue({
      status: "succeeded",
      progress: 100,
      result_refs: [
        {
          result_id: "algorithm-manifest-a",
          result_kind: "file",
          title: "Algorithm manifest",
          resource_url: "/manifest",
        },
        {
          result_id: "algorithm-product-0-a",
          result_kind: "file",
          title: "Algorithm Output: SM",
          resource_url: "/actual-result",
        },
      ],
    });
    api.result.mockResolvedValue({
      schema_version: 1,
      rows: [],
      valid_count: 0,
    });
    const w = await create();
    await clickGenerate(w);
    expect(api.result).toHaveBeenCalledWith("/actual-result");
    expect(w.text()).toContain("分析完成：没有有效数据");
    w.unmount();
  });
  it("CSV 保留全部观测、缺测和精度，不用 0 替换缺失", () => {
    const r = {
      product: {
        product_name: "测试夹具",
        variable: "SM",
        variable_name: "土壤水分",
        unit: "m³/m³",
      },
      request: {
        mode: "point",
        point: [114.3, 30.6],
        geometry: null,
        cadence: "daily",
        location_name: "夹具点",
      },
      rows: [
        {
          key: "a",
          start: "2025-12-01",
          end: "2025-12-01",
          value: 0.1234567890123,
          status: "ok",
        },
        {
          key: "b",
          start: "2025-12-02",
          end: "2025-12-02",
          value: null,
          status: "missing_date",
        },
      ],
      timezone: "日期型观测",
      edge_rule: "中心像元",
      weighting: "等面积",
    } as SeriesResult;
    const csv = seriesCSV(r);
    expect(csv).toContain("0.1234567890123");
    expect(csv).toContain("missing_date");
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).toContain("2025-12-02");
    expect(csv).not.toContain("边界GeoJSON");
  });
});

it("初始化采用地图选中产品，后续条件和地图对象变化不会悄悄改分析对象", async () => {
  const w = mount(TimeSeriesWorkspace, {
    props: { ...props, mapContext: { productId: "fixture-sm", observationKey: "20251201_20251231", visible: true } },
    global: { stubs: { TimeSeriesResults: true } },
  });
  await flushPromises();
  expect(w.get('[aria-label="时序分析产品"]').element.value).toBe("fixture-sm");
  expect(w.text()).toContain("地图实际帧：20251201_20251231");
  expect(w.text()).toContain("分析与地图当前显示条件不同");
  await w.setProps({ mapContext: { productId: "different-product", observationKey: "20250701_20250731", visible: false } });
  expect(w.get('[aria-label="时序分析产品"]').element.value).toBe("fixture-sm");
  expect(api.submit).not.toHaveBeenCalled();
  w.unmount();
});
