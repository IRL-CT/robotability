import { Menu, X, Calendar, MapPin, BarChart2 } from 'lucide-react';
import { Card } from "../components/ui/card";
import { LAYER_CONFIG, COLORS, DEPLOYMENTS } from './map-config';
import { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import maplibregl from 'maplibre-gl';
import { GeoJsonLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';


export const DeploymentCard = ({ deployment, onClose }) => {
  const { title, date, status, score, metrics, highlights } = deployment;
  
  return (
    <Card className="p-4 w-64 bg-white/95 backdrop-blur shadow-lg">
      <div className="flex justify-between items-start mb-2">
        <h3 className="font-semibold text-sm">{title}</h3>
        <button 
          onClick={onClose}
          className="text-gray-500 hover:text-gray-700"
        >
          <X size={16} />
        </button>
      </div>
      
      <div className="flex items-center gap-2 text-xs text-gray-600 mb-2">
        <Calendar size={12} />
        <span>{date}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs mt-2">
        <div>
          <span className="font-medium">Status: </span>
          <span className={status === 'Active' ? 'text-green-600' : 'text-yellow-600'}>
            {status}
          </span>
        </div>
        <div>
          <span className="font-medium">Score: </span>
          <span>{score}%</span>
        </div>
      </div>

      <div className="mt-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <BarChart2 size={12} className="inline mr-1" />
            <span className="font-medium">Daily Trips:</span>
            <div>{metrics.avgDailyTrips}</div>
          </div>
          <div>
            <span className="font-medium">Success Rate:</span>
            <div>{metrics.successRate}</div>
          </div>
        </div>
      </div>
    </Card>
  );
};



export const Sidebar = ({ 
  isOpen, 
  onToggle, 
  visibleLayers, 
  setVisibleLayers, 
  selectedDeployment, 
  onDeploymentSelect
}) => {
  // Handle deployment selection
  const handleDeploymentChange = (deploymentName) => {
    if (deploymentName) {
      onDeploymentSelect(deploymentName);
    }
  };

  return (
    <>
      <button
        onClick={onToggle}
        className={`
          fixed lg:absolute top-4 z-50 
          p-2 bg-white rounded-full shadow-lg 
          hover:bg-gray-100 transition-all duration-300
          ${isOpen ? 'left-4 lg:left-[384px]' : 'left-4'}
        `}
        aria-label={isOpen ? "Close sidebar" : "Open sidebar"}
      >
        {isOpen ? <X size={24} /> : <Menu size={24} />}
      </button>

      <div className={`
        fixed 
        w-full lg:w-96 
        h-2/5 lg:h-screen
        bg-white shadow-lg
        transition-all duration-300 ease-in-out
        overflow-y-auto
        ${isOpen 
          ? 'bottom-0 lg:left-0 opacity-100 translate-y-0 lg:translate-y-0' 
          : 'bottom-[-40%] lg:left-[-384px] opacity-0 translate-y-full lg:translate-y-0'
        }
        z-40
      `}>
        <div className="p-4 mt-14 md:mt-4">
          <div className="mb-8">
            <h3 className="text-xl font-semibold italic mb-4">THE ROBOTABILITY SCORE</h3>
            <p className="mb-4">New York City deployment, September 2024</p>
            <select 
              className="w-full p-2 border rounded"
              value={selectedDeployment?.name || ''}
              onChange={(e) => handleDeploymentChange(e.target.value)}
            >
              <option value="">Select Deployment</option>
              {Object.entries(DEPLOYMENTS).map(([key, deployment]) => (
                <option key={key} value={key}>
                  {deployment.name || key}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-8">
            <h3 className="text-lg font-semibold mb-4">Layers</h3>
            <div className="space-y-2">
              {Object.entries(visibleLayers).map(([key, value]) => {
                const layerConfig = LAYER_CONFIG[key];
                return (
                  <div key={key} className="mb-3">
                    <label className="flex items-center group cursor-pointer">
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
                      <div>
                        <div className="font-medium">{layerConfig.label}</div>
                        <div className="text-sm text-gray-500 hidden group-hover:block">
                          {layerConfig.description}
                        </div>
                      </div>
                    </label>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h4 className="text-lg font-semibold mb-2">Score Legend</h4>
            <div className="bg-gray-100 p-4 rounded flex flex-wrap justify-center gap-1">
              {COLORS.map((color, i) => (
                <div
                  key={i}
                  className="w-5 h-5"
                  style={{
                    backgroundColor: `rgb(${color.join(',')})`
                  }}
                  title={`Score range: ${Math.round((i / (COLORS.length - 1)) * 100)}%`}
                />
              ))}
            </div>
            <p className="text-center mt-2">Low → High</p>
          </div>
        </div>
      </div>
    </>
  );
};