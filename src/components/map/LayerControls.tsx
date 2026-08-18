// LayerControls shows the layer toggles and the score legend over the map.
// The toggles switch layer visibility through maplibre setLayoutProperty.
// The legend draws the 11 ramp colors from low to high percentile.
import { NO_DATA_COLOR, SCORE_COLORS } from './constants';
import { WEIGHTS } from './breakdownData';

// The three toggleable layers. The keys match the maplibre layer ids.
export type ToggleableLayer = 'segments' | 'census' | 'deployments';

export type LayerVisibility = Record<ToggleableLayer, boolean>;

// What the segments layer draws. 'score' is the composite Robotability
// score; any other value is one feature name from weights.json.
export const SCORE_LAYER = 'score';

type LayerControlsProps = {
  readonly visibility: LayerVisibility;
  readonly censusAvailable: boolean;
  readonly onToggle: (layer: ToggleableLayer) => void;
  // The active colour source: SCORE_LAYER or a feature name.
  readonly colorBy: string;
  readonly onColorByChange: (value: string) => void;
  // Set while the feature table is downloading and parsing.
  readonly featureLoading: boolean;
  // Why a feature layer is unavailable, or null when it is available.
  readonly featureDisabledReason: string | null;
};

// One toggle row. The label names the layer. The checkbox shows the
// current visibility.
function ToggleRow(props: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem',
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
      />
      <span>{props.label}</span>
    </label>
  );
}

export default function LayerControls(props: LayerControlsProps) {
  const {
    visibility,
    censusAvailable,
    onToggle,
    colorBy,
    onColorByChange,
    featureLoading,
    featureDisabledReason,
  } = props;
  const isScore = colorBy === SCORE_LAYER;
  // A negative-polarity feature paints red at its high end. See
  // featureRampExpression.
  const invertRamp =
    !isScore && (WEIGHTS.find((w) => w.feature === colorBy)?.polarity ?? 1) < 0;
  return (
    <div
      data-testid="layer-controls"
      style={{
        position: 'absolute',
        top: '1rem',
        left: '1rem',
        zIndex: 140,
        padding: '0.75rem 1rem',
        backgroundColor: 'rgb(var(--color-fill))',
        color: 'rgb(var(--color-text-base))',
        border: '1px solid rgb(var(--color-border))',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        fontSize: '0.85rem',
        maxWidth: '16rem',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: '0.5rem' }}>Layers</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        <ToggleRow
          label="Segments"
          checked={visibility.segments}
          disabled={false}
          onChange={() => onToggle('segments')}
        />
        <ToggleRow
          label="Census blocks"
          checked={visibility.census}
          disabled={!censusAvailable}
          onChange={() => onToggle('census')}
        />
        <ToggleRow
          label="Deployment markers"
          checked={visibility.deployments}
          disabled={false}
          onChange={() => onToggle('deployments')}
        />
      </div>

      <div style={{ fontWeight: 700, marginTop: '0.75rem', marginBottom: '0.35rem' }}>
        Colour by
      </div>
      <select
        data-testid="color-by"
        value={colorBy}
        disabled={featureDisabledReason !== null}
        onChange={(event) => onColorByChange(event.target.value)}
        style={{
          width: '100%',
          padding: '0.25rem',
          fontSize: '0.85rem',
          backgroundColor: 'rgb(var(--color-fill))',
          color: 'rgb(var(--color-text-base))',
          border: '1px solid rgb(var(--color-border))',
        }}
      >
        <option value={SCORE_LAYER}>Robotability score</option>
        {WEIGHTS.map((w) => (
          <option key={w.feature} value={w.feature}>
            {w.displayName}
          </option>
        ))}
      </select>
      {featureDisabledReason !== null && (
        <div data-testid="color-by-disabled" style={{ marginTop: '0.3rem', opacity: 0.75 }}>
          {featureDisabledReason}
        </div>
      )}
      {featureLoading && (
        <div data-testid="color-by-loading" style={{ marginTop: '0.3rem', opacity: 0.75 }}>
          Loading feature values...
        </div>
      )}

      <div style={{ fontWeight: 700, marginTop: '0.75rem', marginBottom: '0.5rem' }}>
        {isScore ? 'Score percentile' : 'Feature percentile'}
      </div>
      <div data-testid="score-legend">
        {SCORE_COLORS.map((color, index) => {
          // Both ramps use deciles of the snapshot's own values, so the
          // label is a percentile either way.
          //
          // A negative-polarity feature paints its ramp in reverse, so
          // red keeps meaning worse for a robot. The legend has to
          // reverse with it: the swatch drawn beside "90%" must be the
          // colour a segment in the 90th percentile actually gets.
          const fraction = index / (SCORE_COLORS.length - 1);
          const percentile = `${Math.round(fraction * 100)}%`;
          if (invertRamp) color = SCORE_COLORS[SCORE_COLORS.length - 1 - index];
          return (
            <div
              key={percentile}
              data-testid="legend-swatch"
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: '1.4rem',
                  height: '0.7rem',
                  backgroundColor: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
                  border: '1px solid rgb(var(--color-border))',
                }}
              />
              <span>{percentile}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
        <span>Low</span>
        <span>High</span>
      </div>
      {invertRamp && (
        <div data-testid="polarity-note" style={{ marginTop: '0.35rem', opacity: 0.8 }}>
          More of this feature is worse for a robot, so the ramp runs the
          other way: red is the high end.
        </div>
      )}
      {!isScore && (
        <div
          data-testid="no-data-key"
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem' }}
        >
          <span
            style={{
              display: 'inline-block',
              width: '1.4rem',
              height: '0.7rem',
              backgroundColor: NO_DATA_COLOR,
              border: '1px solid rgb(var(--color-border))',
            }}
          />
          <span>No value</span>
        </div>
      )}
    </div>
  );
}
