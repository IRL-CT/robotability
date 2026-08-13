// Shared snapshot types for the map components.
// One entry matches one snapshot object in public/manifest.json.
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';

// The tiles URL appears under "segments" in new manifests and under
// "tiles" in the T4 baseline manifest. The parser accepts both keys.
// The parquet URL appears under "parquet" or the older "features" key.
export type SnapshotUrls = {
  readonly segments?: string;
  readonly census?: string;
  readonly parquet?: string;
  readonly features?: string;
};

export type SnapshotEntry = {
  readonly date: string;
  readonly tag?: string;
  readonly feature_vectors?: boolean;
  readonly urls: SnapshotUrls;
};

// The exact fallback sentence for snapshots without feature vectors.
// The e2e spec asserts this text byte for byte. Do not edit it
// without the same edit in e2e/breakdown.spec.ts.
export const FALLBACK_SENTENCE =
  'Feature-level data is unavailable for the 2023 baseline. Only the aggregate score exists.';

// One entry in the layer-spec registry.
// The source spec and the layer spec travel together. A style switch
// removes every source and layer from the map. The restore step re-adds
// every registry entry, so no layer is lost.
export type RegisteredLayer = {
  readonly sourceId: string;
  readonly source: SourceSpecification;
  readonly layer: LayerSpecification;
};
