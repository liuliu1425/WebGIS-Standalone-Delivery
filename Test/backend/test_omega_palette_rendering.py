"""Synthetic pixel fixtures, not scientific product results; no app startup or data writes."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "Code/backend/app/services/raster_preview_service.py"
spec = importlib.util.spec_from_file_location("isolated_omega_palette_rendering", SOURCE)
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)

COLORS = ["#DFE6F2", "#B8BDDE", "#9894C7", "#7C6AAD", "#5A3C89"]
RGB = [[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in COLORS]


class OmegaPaletteRenderingTests(unittest.TestCase):
    def test_registry_recognizes_dedicated_palette(self):
        self.assertEqual(render.resolve_palette_id("omega-purple"), "omega-purple")
        self.assertEqual(render.get_palette_rgb_stops("omega-purple"), [tuple(c) for c in RGB])

    def test_requested_stops_reach_actual_rgba_colorizer(self):
        data = np.array([[0.0, 0.125, 0.25, 0.375, 0.5]])
        result = render.colorize_array_to_rgba(data, palette="omega-purple", min_value=0, max_value=0.5)
        np.testing.assert_array_equal(result[0, :, :3], RGB)
        np.testing.assert_array_equal(result[0, :, 3], [255] * 5)

    def test_nodata_stays_transparent_and_does_not_modify_values(self):
        data = np.array([[0.0, np.nan, 0.5]])
        prior = data.copy()
        result = render.colorize_array_to_rgba(data, palette="omega-purple", min_value=0, max_value=0.5)
        self.assertEqual(int(result[0, 1, 3]), 0)
        np.testing.assert_array_equal(data, prior)

    def test_old_red_palette_is_unchanged(self):
        self.assertEqual(render.get_palette_rgb_stops("reds"), [
            (255, 245, 240), (254, 224, 210), (252, 187, 161), (252, 146, 114),
            (251, 106, 74), (239, 59, 44), (203, 24, 29), (153, 0, 13),
        ])

    def test_range_clipping_keeps_existing_behavior(self):
        result = render.colorize_array_to_rgba(
            np.array([[-0.1, 0, 0.5, 0.6]]), palette="omega-purple", min_value=0, max_value=0.5,
        )
        np.testing.assert_array_equal(result[0, 0, :3], RGB[0])
        np.testing.assert_array_equal(result[0, -1, :3], RGB[-1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
