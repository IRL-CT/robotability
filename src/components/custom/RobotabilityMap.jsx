import React, { useState, useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { GeoJsonLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';

const COLORS = [
  [165, 0, 38],    // Dark red
  [215, 48, 39],   // Red
  [244, 109, 67],  // Light red
  [253, 174, 97],  // Orange-red
  [254, 224, 144], // Light orange
  [255, 255, 191], // Yellow
  [217, 239, 139], // Light yellow-green
  [166, 217, 106], // Light green
  [102, 189, 99],  // Medium green
  [26, 152, 80],   // Green
  [0, 104, 55]     // Dark green
];

const RobotabilityMap = () => {
  const mapContainer = useRef(null);
  const [map, setMap] = useState(null);
  const [deckgl, setDeckgl] = useState(null);
  const [mapData, setMapData] = useState({
    sidewalks: null,
    censusBlocks: null
  });
  const [visibleLayers, setVisibleLayers] = useState({
    sidewalkScores: true,
    censusBlocks: true,
    deploymentLocations: true
  });
  const [selectedDeployment, setSelectedDeployment] = useState('');

  const DEPLOYMENTS = {
    'Elmhurst, Queens': {
      coords: [40.738536, -73.887267],
      video: 'elmhurst_deployment.mp4'
    },
    'Sutton Place, Manhattan': {
      coords: [40.758890, -73.958457],
      video: 'sutton_place_deployment.mp4'
    },
    'Herald Square, Manhattan': {
      coords: [40.748422, -73.988275],
      video: 'herald_square_deployment.mp4'
    },
    'Jackson Heights, Queens': {
      coords: [40.747379, -73.889690],
      video: 'jackson_heights_deployment.mp4'
    }
  };

  // dictionary to give layers nice names 
  const layerNames = {
    sidewalkScores: 'Sidewalk Scores',
    censusBlocks: 'Census Blocks',
    deploymentLocations: 'Deployment Locations'
  };

  // In your map initialization:
const [firstLabelLayerId, setFirstLabelLayerId] = useState(null);

useEffect(() => {
  if (!mapContainer.current) return;

  const mapInstance = new maplibregl.Map({
    container: mapContainer.current,
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    center: [-73.9712, 40.7831],
    zoom: 12,
    pitch: 45,
    bearing: 0
  });

  mapInstance.on('style.load', () => {
    // Find the first label layer
    const firstLabelLayer = mapInstance.getStyle().layers.find(layer => 
      layer.type === 'symbol' || layer.id.includes('label') || layer.id.includes('place')
    );
    setFirstLabelLayerId(firstLabelLayer.id);

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      getTooltip: ({object}) => {
        if (object) {
          const score = (object.properties.score * 100).toFixed(1);
          return {
            html: `Score: ${score}%`,
            style: {
              backgroundColor: 'white',
              fontSize: '0.8em',
              padding: '4px 8px',
              borderRadius: '4px',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
            }
          };
        }
        return null;
      }
    });

    mapInstance.addControl(overlay);
    setDeckgl(overlay);

    mapInstance.addControl(
      new maplibregl.NavigationControl(),
      'top-right'
    );
  });

  setMap(mapInstance);

  return () => mapInstance.remove();
}, []);

  // Load data
  useEffect(() => {
    const loadData = async () => {
      try {
        // Load both datasets in parallel
        const [sidewalksRes, censusRes] = await Promise.all([
          fetch('/data/sidewalks.geojson'),
          fetch('/data/census.geojson')
        ]);

        const [sidewalksData, censusData] = await Promise.all([
          sidewalksRes.json(),
          censusRes.json()
        ]);

        setMapData({
          sidewalks: sidewalksData,
          censusBlocks: censusData
        });
      } catch (error) {
        console.error('Error loading data:', error);
      }
    };

    loadData();
  }, []);

  // Update layers when visibility changes or data loads
  useEffect(() => {
    if (!deckgl || !mapData.sidewalks || !firstLabelLayerId) return;

    const layers = [];

    if (visibleLayers.censusBlocks && mapData.censusBlocks) {
      layers.push(
        new GeoJsonLayer({
          id: 'census-blocks',
          data: mapData.censusBlocks,
          pickable: false,
          stroked: true,
          filled: false,
          lineWidthScale: 3,
          getLineColor: [100, 100, 100, 100],
          beforeId: firstLabelLayerId
        })
      );
    }

    if (visibleLayers.deploymentLocations) {
      // Create rings for each deployment location
      const createDeploymentRings = () => {
        const features = [];
        const numRings = 15;
        const maxRadius = 0.004; // roughly 400 meters
        const maxHeight = 150;

        Object.entries(DEPLOYMENTS).forEach(([name, info]) => {
          for (let i = 0; i < numRings; i++) {
            const progress = i / (numRings - 1);
            const radius = Math.cos(progress * Math.PI / 2) * maxRadius;
            const height = Math.sin(progress * Math.PI / 2) * maxHeight;

            // Create a circle for each ring
            const points = 32; // number of points to approximate circle
            const coords = [];
            for (let j = 0; j <= points; j++) {
              const angle = (j / points) * Math.PI * 2;
              const lng = info.coords[1] + Math.cos(angle) * radius;
              const lat = info.coords[0] + Math.sin(angle) * radius;
              coords.push([lng, lat]);
            }

            features.push({
              type: 'Feature',
              properties: {
                name,
                video: info.video,
                height,
                opacity: 0.3 * (1 - progress),  // fade out as it goes up
                level: i
              },
              geometry: {
                type: 'Polygon',
                coordinates: [coords]
              }
            });
          }
        });

        return {
          type: 'FeatureCollection',
          features
        };
      };

      layers.push(
        new GeoJsonLayer({
          id: 'deployment-zones',
          data: createDeploymentRings(),
          pickable: true,
          stroked: false,
          filled: true,
          extruded: true,
          wireframe: false,
          getElevation: d => d.properties.height,
          getFillColor: d => [0, 128, 255, 255 * d.properties.opacity],
          parameters: {
            depthTest: true,
            depthMask: true,
            blend: true,
            blendFunc: [
              WebGLRenderingContext.SRC_ALPHA,
              WebGLRenderingContext.ONE_MINUS_SRC_ALPHA
            ]
          }
        })
      );
    }

    if (visibleLayers.sidewalkScores && mapData.sidewalks) {
      layers.push(
        new GeoJsonLayer({
          id: 'sidewalks',
          data: mapData.sidewalks,
          pickable: true,
          stroked: true,
          filled: true,
          lineWidthScale: 12,
          beforeId: firstLabelLayerId,
          getLineColor: d => {
            const score = d.properties?.score ?? 0;
            const colorIndex = Math.floor(score * 2.5 *(COLORS.length - 1));
            return [COLORS[colorIndex], 255];
          },
          getFillColor: d => {
            const score = d.properties?.score ?? 0;
            const colorIndex = Math.floor(score * (COLORS.length - 1));
            return [...COLORS[colorIndex], 255];
          }
        })
      );
    }

    // Update deck.gl layers
    deckgl.setProps({ layers });

    }, [deckgl, mapData, visibleLayers, map]);

  return (
    <div className="flex h-screen w-full">
      <div className="w-96 bg-white p-4 shadow-lg overflow-y-auto z-10">
        <div className="mb-8">
          <h3 className="poppins text-xl font-semibold italic mb-4">Robotability Proof-of-Concept</h3>
          <p className="poppins mb-4">New York City, September 2024</p>
          <select 
            className="poppins w-full p-2 border rounded"
            value={selectedDeployment}
            onChange={(e) => {
              setSelectedDeployment(e.target.value);
              if (e.target.value && DEPLOYMENTS[e.target.value]) {
                const [lat, lng] = DEPLOYMENTS[e.target.value].coords;
                map?.flyTo({
                  center: [lng, lat],
                  zoom: 16,
                  duration: 2000,
                  pitch: 60
                });
              }
            }}
          >
            <option value="">Select Deployment</option>
            {Object.keys(DEPLOYMENTS).map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        <div className="mb-8">
          <h3 className="poppins text-lg font-semibold mb-4">Layers</h3>
          <div className="space-y-2">
            {Object.entries(visibleLayers).map(([key, value]) => (
              <label key={key} className="poppins flex items-center">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={() => {
                    setVisibleLayers(prev => ({
                      ...prev,
                      [key]: !prev[key]
                    }));
                  }}
                  className="mr-2"
                />
                {layerNames[key]}
              </label>
            ))}
          </div>
        </div>

        <div>
          <h4 className="poppins text-lg font-semibold mb-2">Score Legend</h4>
          <div className="bg-gray-100 p-4 rounded flex flex-wrap justify-center gap-1">
            {COLORS.map((color, i) => (
              <div
                key={i}
                className="w-5 h-5"
                style={{
                  backgroundColor: `rgb(${color.join(',')})`
                }}
              />
            ))}
          </div>
          <p className="poppins text-center mt-2">Low Percentile → High Percentile</p>
        </div>
      </div>

      <div className="flex-1 relative">
        <div 
          ref={mapContainer} 
          className="absolute inset-0"
          style={{
            width: '100%',
            height: '100%'
          }}
        />
      </div>
    </div>
  );
};

export default RobotabilityMap;