// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useThemeStore } from "@/stores/theme";
import Chart from "vue-echarts";
import { describe, expect, it, vi } from "vitest";
import Results from "@/components/timeseries/TimeSeriesResults.vue";
import { timestamp, type SeriesResult } from "@/services/spatial-timeseries";
const dispatch = vi.hoisted(() => vi.fn());
const exportChart = vi.hoisted(() => ({
  setOption: vi.fn(),
  getDataURL: vi.fn(() => "data:image/png;base64,test"),
  dispose: vi.fn(),
}));
vi.mock("echarts/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("echarts/core")>();
  return { ...actual, init: () => exportChart };
});
vi.mock("vue-echarts", async () => {
  const { defineComponent } = await import("vue");
  return {
    default: defineComponent({
      name: "ChartProbe",
      props: ["option"],
      setup(_, { expose }) {
        expose({ dispatchAction: dispatch, getDataURL: () => "" });
        return () => null;
      },
    }),
  };
});
function fixture(values: (number | null)[]): SeriesResult {
  const rows = values.map((value, i) => {
    const date = new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10);
    return {
      key: date,
      start: date,
      end: date,
      value,
      count: value === null ? 0 : 1,
      total_count: 1,
      coverage: value === null ? 0 : 1,
      status: value === null ? "no_valid_data" : "ok",
    };
  });
  return {
    schema_version: 1,
    product: {
      id: "fixture",
      catalog_id: "fixture",
      product_name: "仅测试夹具",
      variable: "SM",
      variable_name: "土壤水分",
      unit: "m³/m³",
      unit_source: "fixture",
      native_step: "1d",
      timezone: "日期型观测",
    },
    request: {
      product_id: "fixture",
      mode: "point",
      point: [1, 2],
      geometry: null,
      location_name: "夹具",
      start: rows[0].start,
      end: rows.at(-1)!.end,
      cadence: "daily",
      statistic: "mean",
    },
    rows,
    valid_count: values.filter((v) => v !== null).length,
    timezone: "日期型观测（无小时/时区）",
    edge_rule: "中心",
    coverage_rule: "有效/总数",
    quality_rule: "不补零",
    weighting: "等面积",
  };
}
function create(values: (number | null)[]) {
  setActivePinia(createPinia());
  return mount(Results, {
    props: { result: fixture(values), stale: false },
    global: { stubs: { VChart: Chart } },
  });
}
describe("科研时序结果的边界情况", () => {
  it("主题切换更新图形且坐标轴有完整边框与纵轴标题", async () => {
    const w = create([0.1, 0.2, 0.3]);
    const theme = useThemeStore();
    theme.setTheme("light");
    await w.vm.$nextTick();
    const light = w.findComponent(Chart).props("option");
    expect(light.grid).toMatchObject({ show: true, borderWidth: 1.25 });
    expect(light.yAxis).toMatchObject({
      nameLocation: "middle",
      nameRotate: 90,
    });
    expect(light.yAxis.axisLine.show).toBe(true);
    expect(light.yAxis.axisLabel.hideOverlap).toBe(true);
    expect(light.yAxis.splitNumber).toBeLessThanOrEqual(6);
    expect(light.title.show).toBe(false);
    expect(w.get('[aria-label="本次分析条件"]').text()).toContain("仅测试夹具");
    theme.setTheme("dark");
    await w.vm.$nextTick();
    const dark = w.findComponent(Chart).props("option");
    expect(dark.backgroundColor).not.toBe(light.backgroundColor);
    expect(dark.series[0].data).toEqual(light.series[0].data);
    w.unmount();
  });
  it("PNG 包含标题与条件，白底导出不改变当前深色图及缩放范围", async () => {
    const w = create([0.1, 0.2, 0.3]);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    useThemeStore().setTheme("dark");
    const chart = w.findComponent(Chart);
    chart.vm.$emit("datazoom", { start: 20, end: 70 });
    await w.vm.$nextTick();
    const before = chart.props("option");
    await w.get('[aria-label="保存曲线图片"]').trigger("click");
    const exported = exportChart.setOption.mock.calls.at(-1)![0];
    expect(exported.backgroundColor).toBe("#FFFFFF");
    expect(exported.title).toMatchObject({
      show: true,
      text: "土壤水分时间变化",
    });
    expect(exported.title.subtext).toContain("仅测试夹具");
    expect(exported.dataZoom[0]).toMatchObject({ start: 20, end: 70 });
    expect(chart.props("option")).toEqual(before);
    expect(exportChart.dispose).toHaveBeenCalled();
    click.mockRestore();
    w.unmount();
  });
  it("单点和常数序列有非零轴范围，不伪造趋势", () => {
    for (const values of [[0], [2, 2, 2]]) {
      const w = create(values);
      const o = w.findComponent(Chart).props("option");
      expect(o.series[0].data).toHaveLength(values.length);
      expect(o.yAxis.min({ min: values[0], max: values[0] })).toBeLessThan(
        values[0],
      );
      expect(o.yAxis.max({ min: values[0], max: values[0] })).toBeGreaterThan(
        values[0],
      );
      expect(o.xAxis.max).toBeGreaterThan(o.xAxis.min);
      w.unmount();
    }
  });
  it("缺失断线且悬停给出无有效数据，使用真实日期间隔", () => {
    const w = create([0.2, null, 0.4]);
    const o = w.findComponent(Chart).props("option");
    expect(o.series[0].connectNulls).toBe(false);
    expect(o.series[0].smooth).toBe(false);
    expect(o.series[0].data[1]).toEqual([timestamp("2025-01-02"), null]);
    expect(
      o.tooltip.formatter([{ axisValue: timestamp("2025-01-02") }]),
    ).toContain("无有效数据");
    w.unmount();
  });
  it("长序列只减少常驻点标记，不抽掉观测或极值", () => {
    const values = Array.from({ length: 2000 }, (_, i) =>
      i === 101 ? 999 : i === 100 ? null : i / 1000,
    );
    const w = create(values);
    const o = w.findComponent(Chart).props("option");
    expect(o.series[0].data).toHaveLength(2000);
    expect(o.series[0].data[101][1]).toBe(999);
    expect(o.series[0].showSymbol).toBe(false);
    expect(o.series[0].data[100][1]).toBeNull();
    w.unmount();
  });
  it("全无效时显示说明而不是成功空图", () => {
    const w = create([null, null]);
    expect(w.findComponent(Chart).exists()).toBe(false);
    expect(w.text()).toContain("无有效数据");
    w.unmount();
  });
  it("大图、表格和收起保留查看范围，恢复按钮才重置", async () => {
    const w = create([0.1, 0.2, 0.3]);
    const chart = w.findComponent(Chart);
    chart.vm.$emit("datazoom", { start: 20, end: 70 });
    await w.vm.$nextTick();
    for (const label of [
      "放大或还原结果区",
      "收起或展开结果",
      "收起或展开结果",
    ])
      await w.get('[aria-label="' + label + '"]').trigger("click");
    await w
      .findAll("button")
      .find((b) => b.text() === "数据表")!
      .trigger("click");
    await w
      .findAll("button")
      .find((b) => b.text() === "曲线")!
      .trigger("click");
    expect(chart.props("option").dataZoom[0]).toMatchObject({
      start: 20,
      end: 70,
    });
    await w.get('[aria-label="恢复全范围"]').trigger("click");
    expect(chart.props("option").dataZoom[0]).toMatchObject({
      start: 0,
      end: 100,
    });
    w.unmount();
  });
});
