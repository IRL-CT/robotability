import React, { useState } from 'react';
import { X, Minimize2, Maximize2 } from 'lucide-react';

const DeploymentPopup = ({ deployment, onClose, position }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!deployment || !position) return null;

  return (
    <div 
      className={`
        absolute z-10 bg-white rounded-lg shadow-lg overflow-hidden
        transition-all duration-200 ease-in-out
        ${isExpanded ? 'w-96' : 'w-72'}
      `}
      style={{
        left: position[0],
        top: position[1],
        transform: 'translate(-50%, -100%) translateY(-20px)'
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 bg-gray-50">
        <h3 className="font-semibold text-sm">{deployment.name}</h3>
        <div className="flex gap-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 hover:bg-gray-200 rounded"
          >
            {isExpanded ? 
              <Minimize2 className="h-4 w-4" /> : 
              <Maximize2 className="h-4 w-4" />
            }
          </button>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-200 rounded"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-3">
        {deployment.videoUrl && (
          <div className={`
            aspect-video w-full bg-gray-100 rounded-lg overflow-hidden mb-3
            ${isExpanded ? 'block' : 'hidden'}
          `}>
            <iframe
              src={deployment.videoUrl}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        )}

        <p className="text-sm text-gray-600 mb-3">
          {isExpanded ? deployment.description : 
            deployment.description?.slice(0, 100) + '...'}
        </p>

        {deployment.stats && (
          <div className="grid grid-cols-2 gap-2 text-sm">
            {Object.entries(deployment.stats)
              .slice(0, isExpanded ? undefined : 4)
              .map(([key, value]) => (
                <div key={key} className="bg-gray-50 p-2 rounded">
                  <div className="text-gray-500 text-xs">{key}</div>
                  <div className="font-medium">{value}</div>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Footer with expand button if collapsed */}
      {!isExpanded && deployment.description?.length > 100 && (
        <button
          onClick={() => setIsExpanded(true)}
          className="w-full p-2 text-xs text-blue-600 hover:bg-gray-50 border-t"
        >
          Show more details
        </button>
      )}
    </div>
  );
};

export default DeploymentPopup;