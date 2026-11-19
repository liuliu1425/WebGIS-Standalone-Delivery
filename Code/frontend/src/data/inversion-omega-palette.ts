import { GENERATED_PALETTE_ALIASES } from './weather-palettes-generated'

/** Four inversion products only; the old SMAP season-mean group remains compatible. */
export const INVERSION_OMEGA_PALETTE = 'omega-purple'

const INVERSION_OMEGA_OVERLAY_IDS = new Set([
  // method-fy-omega-doy-avg
  'imported-72aa577da95e',
  'imported-593978e6d739',
  'imported-ecfb489647d5',
  'imported-68723c6d5927',
  // method-fy-omega-doy-dynamic
  'imported-c6c55b8a9f4e',
  'imported-a3669154a666',
  'imported-c33bc332a282',
  'imported-a568bf81c4e0',
  // method-smap-omega-doy-avg
  'imported-9a7cf36832cd',
  'imported-4262abf3604f',
  'imported-bc49a65b8b18',
  'imported-320d5f7fc0a9',
  // method-smap-omega-doy-dynamic
  'imported-94501b455dcd',
  'imported-11c57b79844d',
  'imported-d46b3d19b929',
  'imported-03ec178d7f04',
  // method-smap-season-mean
  'imported-49101c3674f8',
  'imported-02755b4c70ad',
  'imported-2d388fb41905',
  'imported-bc611d25c775',
])

/** Stable IDs use the backend's sha1(catalog|label|variable) scheme. */
export function isInversionOmegaOverlayId(overlayId: string | null | undefined): boolean {
  return INVERSION_OMEGA_OVERLAY_IDS.has(
    String(overlayId ?? '')
      .trim()
      .toLowerCase(),
  )
}

/** Replace the red default only when a readable source can really recolor. */
export function resolveInversionOmegaDefaultPalette(
  overlayId: string | null | undefined,
  registeredPalette: string | null | undefined,
  supportsRecolor: boolean,
): string | undefined {
  const palette = registeredPalette ?? undefined
  if (!supportsRecolor || !isInversionOmegaOverlayId(overlayId)) return palette
  const key = palette?.trim() ?? ''
  const canonical =
    GENERATED_PALETTE_ALIASES[key] ??
    GENERATED_PALETTE_ALIASES[key.toLowerCase()] ??
    key.toLowerCase()
  // Preserve custom registered styles; callers still give explicit overrides priority.
  if (key && canonical !== 'reds') return palette
  return INVERSION_OMEGA_PALETTE
}
