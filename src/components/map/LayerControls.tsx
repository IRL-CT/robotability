// LayerControls shows the layer toggles and the score legend over the map.
// The toggles switch layer visibility through maplibre setLayoutProperty.
// The legend draws the 11 ramp colors from low to high percentile.
import { SCORE_COLORS } from './constants';

// The three toggleable layers. The keys match the maplibre layer ids.
export type ToggleableLayer = 'segments' | 'census' | 'deployments';

export type LayerVisibility = Record<ToggleableLayer, boolean>;

type LayerControlsProps = {
  readonly visibility: LayerVisibility;
  readonly censusAvailable: boolean;
  readonly onToggle: (layer: ToggleableLayer) => void;
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
  const { visibility, censusAvailable, onToggle } = props;
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

      <div style={{ fontWeight: 700, marginTop: '0.75rem', marginBottom: '0.5rem' }}>
        Score percentile
      </div>
      <div data-testid="score-legend">
        {SCORE_COLORS.map((color, index) => {
          // Stop 0 is the lowest percentile. Stop 10 is the highest.
          // The 11 stops divide the domain into 10 equal steps.
          const percentile = Math.round((index / (SCORE_COLORS.length - 1)) * 100);
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
              <span>{percentile}%</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
        <span>Low</span>
        <span>High</span>
      </div>
    </div>
  );
}
