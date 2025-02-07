import { useState, useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { DeploymentCard, Sidebar } from './components';
import { LAYER_CONFIG, COLORS, DEPLOYMENTS } from './map-config';
import DeploymentPopup from './deployment-popup';

const RobotabilityMap = () => {
  const mapContainer = useRef(null);
  const [map, setMap] = useState(null);
  const [deckgl, setDeckgl] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [selectedDeployment, setSelectedDeployment] = useState(null);
  const [mapData, setMapData] = useState({
    sidewalks: null,
    censusBlocks: null
  });
  const [visibleLayers, setVisibleLayers] = useState({
    sidewalkScores: true,
    censusBlocks: true,
    deploymentLocations: true
  });

  // Initialize map
  useEffect(() => {
    if (map || !mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [-73.9712, 40.7831],
      zoom: 12,
      pitch: 45,
      bearing: 0
    });

    mapInstance.on('load', () => {
      console.log('Map loaded successfully');
      const overlay = new MapboxOverlay({
        interleaved: true,
        layers: [],
        onClick: (info) => {
          if (info.object && info.object.properties.name) {
            const deploymentName = info.object.properties.name;
            const deployment = DEPLOYMENTS[deploymentName];
            if (deployment) {
              const clickX = info.x;
              const clickY = info.y;
              setSelectedDeployment({
                ...deployment,
                popupPosition: [clickX, clickY]
              });
            }
          } else {
            setSelectedDeployment(null);
          }
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

    return () => {
      mapInstance.remove();
    };
  }, []);

  // Load GeoJSON data
  useEffect(() => {
    const loadData = async () => {
      try {
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

  // Update layers
  useEffect(() => {
    if (!deckgl || !mapData.sidewalks) return;

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
          getLineColor: [100, 100, 100, 100]
        })
      );
    }

    if (visibleLayers.deploymentLocations) {
      const createDeploymentRings = () => {
        const features = [];
        const numRings = 15;
        const maxRadius = 0.004;
        const maxHeight = 150;

        Object.entries(DEPLOYMENTS).forEach(([name, info]) => {
          for (let i = 0; i < numRings; i++) {
            const progress = i / (numRings - 1);
            const radius = Math.cos(progress * Math.PI / 2) * maxRadius;
            const height = Math.sin(progress * Math.PI / 2) * maxHeight;

            const points = 32;
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
                height,
                opacity: 0.3 * (1 - progress),
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
          getLineColor: d => {
            const score = d.properties?.score ?? 0;
            const colorIndex = Math.floor(score * (COLORS.length - 1));
            return [...COLORS[colorIndex], 255];
          },
          getFillColor: d => {
            const score = d.properties?.score ?? 0;
            const colorIndex = Math.floor(score * (COLORS.length - 1));
            return [...COLORS[colorIndex], 255];
          }
        })
      );
    }

    deckgl.setProps({ layers });
  }, [deckgl, mapData, visibleLayers]);

  const zoomToDeployment = (deploymentName) => {
    const deployment = DEPLOYMENTS[deploymentName];
    if (!deployment || !map) return;

    // Use flyTo for smooth transition
    map.flyTo({
      center: [deployment.coords[1], deployment.coords[0]],
      zoom: 15,
      duration: 1500,
      essential: true
    });

    // Set the deployment after a small delay to let the animation complete
    setTimeout(() => {
      setSelectedDeployment({
        ...deployment,
        popupPosition: map.project([deployment.coords[1], deployment.coords[0]])
      });
    }, 1500);
  };

  return (
    <div className="relative h-screen w-full overflow-hidden">
      <Sidebar 
        isOpen={isSidebarOpen}
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        visibleLayers={visibleLayers}
        setVisibleLayers={setVisibleLayers}
        selectedDeployment={selectedDeployment}
        setSelectedDeployment={setSelectedDeployment}
        onDeploymentSelect={zoomToDeployment}
        map={map}
      />

      <div 
        className={`
          absolute inset-0 transition-all duration-300
          ${isSidebarOpen ? 'lg:left-96' : 'left-0'}
        `}
      >
        <div 
          ref={mapContainer} 
          className="h-full w-full"
        />
      </div>

      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {selectedDeployment && (
        <DeploymentPopup
          deployment={selectedDeployment}
          onClose={() => setSelectedDeployment(null)}
          position={selectedDeployment.popupPosition}
        />
      )}
    </div>
  );
};

export default RobotabilityMap;