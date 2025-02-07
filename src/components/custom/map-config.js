// Layer configuration for the map
export const LAYER_CONFIG = {
    sidewalkScores: {
      id: 'sidewalkScores',
      label: 'Robotability Scores',
      description: 'Shows sidewalk accessibility scores'
    },
    censusBlocks: {
      id: 'censusBlocks',
      label: 'Census Block Groups',
      description: 'Shows census block group boundaries'
    },
    deploymentLocations: {
      id: 'deploymentLocations',
      label: 'Robot Deployment Sites',
      description: 'Shows active robot deployment locations'
    }
  };
  
  // Color scale for the robotability scores
  export const COLORS = [
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
  
  // Deployment data with detailed information
  export const DEPLOYMENTS = {
    'Elmhurst, Queens': {
      coords: [40.738536, -73.887267],
      title: 'Elmhurst Deployment',
      date: 'Sept 15, 2024',
      status: 'Active',
      score: 87.5,
      details: 'Urban mobility pilot focused on high-density residential areas with diverse pedestrian traffic patterns.',
      metrics: {
        avgDailyTrips: 142,
        totalDistance: '856 km',
        successRate: '94.3%'
      },
      highlights: [
        'Successfully navigated complex intersections',
        'High compliance with traffic signals',
        'Positive community feedback'
      ]
    },
    'Sutton Place, Manhattan': {
      coords: [40.758890, -73.958457],
      title: 'Sutton Place Initiative',
      date: 'Sept 18, 2024',
      status: 'Active',
      score: 92.3,
      details: 'Mixed residential-commercial deployment testing navigation in areas with high pedestrian density.',
      metrics: {
        avgDailyTrips: 167,
        totalDistance: '923 km',
        successRate: '96.1%'
      },
      highlights: [
        'Optimal performance during peak hours',
        'Seamless integration with bike lanes',
        'Zero safety incidents reported'
      ]
    },
    'Herald Square, Manhattan': {
      coords: [40.748422, -73.988275],
      title: 'Herald Square Operations',
      date: 'Sept 21, 2024',
      status: 'Active',
      score: 89.7,
      details: 'High-traffic commercial zone deployment focusing on pedestrian-dense areas and tourism hotspots.',
      metrics: {
        avgDailyTrips: 198,
        totalDistance: '1,102 km',
        successRate: '93.8%'
      },
      highlights: [
        'Excellent performance in crowded conditions',
        'Adaptive routing during events',
        'Strong business district integration'
      ]
    },
    'Jackson Heights, Queens': {
      coords: [40.747379, -73.889690],
      title: 'Jackson Heights Project',
      date: 'Sept 24, 2024',
      status: 'Active',
      score: 85.9,
      details: 'Diverse neighborhood deployment testing multilingual interfaces and cultural adaptation.',
      metrics: {
        avgDailyTrips: 156,
        totalDistance: '784 km',
        successRate: '92.5%'
      },
      highlights: [
        'Successful multilingual community engagement',
        'Effective navigation of street vendor areas',
        'Positive accessibility feedback'
      ]
    }
  };