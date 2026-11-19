// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { mergeBoundaryFeatures } from "@/components/timeseries/boundary-input";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/services/_http", () => ({ requestJson: request }));
vi.mock("@/services/data-import", () => ({ parseVectorFile: vi.fn() }));
const polygon: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};
const feature = (geometry: GeoJSON.Geometry): GeoJSON.Feature => ({
  type: "Feature",
  geometry,
  properties: {},
});

beforeEach(() => {
  request.mockReset();
});

it("submits every polygon and keeps the exact dissolved geometry returned by the server", async () => {
  const hole = [
    [0.2, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
    [0.8, 0.2],
    [0.2, 0.2],
  ];
  const merged = {
    type: "MultiPolygon",
    coordinates: [[polygon.coordinates[0], hole], polygon.coordinates],
  };
  request.mockResolvedValue({ geometry: merged, feature_count: 2 });
  const features = [
    feature(polygon),
    feature(polygon),
    feature({ type: "Point", coordinates: [2, 2] }),
  ];
  expect(await mergeBoundaryFeatures(features)).toEqual(merged);
  const [path, options] = request.mock.calls[0];
  expect(path).toBe("/analysis/time-series/boundary/merge");
  expect(JSON.parse(options.body).features).toEqual(features.slice(0, 2));
  expect(options.method).toBe("POST");
});

it("does not send an empty or non-polygon input", async () => {
  await expect(mergeBoundaryFeatures([])).rejects.toThrow("没有可合并");
  await expect(
    mergeBoundaryFeatures([feature({ type: "Point", coordinates: [2, 2] })]),
  ).rejects.toThrow("没有可合并");
  expect(request).not.toHaveBeenCalled();
});

it("propagates union failure rather than returning a bounding rectangle", async () => {
  request.mockRejectedValue(new Error("区域边界合并失败：边界无效"));
  await expect(mergeBoundaryFeatures([feature(polygon)])).rejects.toThrow(
    "区域边界合并失败",
  );
});

it("rejects an empty exported geometry", async () => {
  request.mockResolvedValue({
    geometry: { type: "Polygon", coordinates: [] },
    feature_count: 1,
  });
  await expect(mergeBoundaryFeatures([feature(polygon)])).rejects.toThrow(
    "未返回有效多边形",
  );
});
