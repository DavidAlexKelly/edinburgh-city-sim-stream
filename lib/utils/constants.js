export const ROAD_TYPE_WEIGHTS = {
  'primary': 100,
  'secondary': 80,
  'tertiary': 60,
  'trunk': 120,
  'motorway': 150,
  'residential': 20,
  'unclassified': 15,
  'service': 10,
  'footway': 0,
  'cycleway': 0
};

export const PEAK_HOUR_MULTIPLIERS = {
  'primary': 2.5,
  'secondary': 2.2,
  'tertiary': 1.8,
  'trunk': 2.8,
  'motorway': 3.0,
  'residential': 1.3,
  'unclassified': 1.2,
  'service': 1.1
};

export const AREA_MULTIPLIERS = {
  'major_transport_hub': 1.8,
  'commercial_arterial': 1.6,
  'mixed_development': 1.4,
  'dense_residential': 1.2,
  'suburban_residential': 1.1,
  'mixed_local': 1.3
};

export const WEEKEND_MULTIPLIERS = {
  'major_transport_hub': 0.7,
  'commercial_arterial': 0.6,
  'mixed_development': 0.8,
  'dense_residential': 0.9,
  'suburban_residential': 1.1,
  'mixed_local': 0.85
};