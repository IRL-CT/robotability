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

// One normalization window for one feature. The shape matches
// feature_stats in pipeline/contract/cluster_contract.md.
export type SnapshotFeatureStatsEntry = {
  readonly min: number;
  readonly max: number;
};

export type SnapshotEntry = {
  readonly date: string;
  readonly tag?: string;
  readonly feature_vectors?: boolean;
  readonly urls: SnapshotUrls;
  // Per-feature min/max stats from the snapshot manifest. Present only
  // on snapshots built by the cluster pipeline. The live refresh needs
  // them for normalization and refuses to run without them.
  readonly feature_stats?: Record<string, SnapshotFeatureStatsEntry>;
  // One score per ramp stop: this snapshot's own colour breaks. Absent
  // on the 2023 baseline and on any snapshot built before the cluster
  // emitted them, and the map then falls back to the fixed score
  // domain. See constants.parseScoreBreaks.
  readonly score_breaks?: readonly number[];
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
