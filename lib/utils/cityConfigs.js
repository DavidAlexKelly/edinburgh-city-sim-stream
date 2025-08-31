export const CITY_CONFIGS = {
  edinburgh: {
    name: "Edinburgh, Scotland",
    country: "UK",
    timezone: "Europe/London",
    datazones_file: "data/datazones/edinburgh_datazones_with_streets.json",
    events_file: "data/events/edinburgh_events.json"
  },
  york: {
    name: "York, England", 
    country: "UK",
    timezone: "Europe/London",
    datazones_file: "data/datazones/york_datazones_with_streets.json",
    events_file: "data/events/york_events.json"
  },
  hull: {
    name: "Hull, England",
    country: "UK", 
    timezone: "Europe/London",
    datazones_file: "data/datazones/hull_datazones_with_streets.json",
    events_file: "data/events/hull_events.json"
  },
  manchester: {
    name: "Manchester, England",
    country: "UK",
    timezone: "Europe/London", 
    datazones_file: "data/datazones/manchester_datazones_with_streets.json",
    events_file: "data/events/manchester_events.json"
  }
};

export function getCityConfig(cityId) {
  const config = CITY_CONFIGS[cityId];
  if (!config) {
    throw new Error(`City '${cityId}' not found. Available cities: ${Object.keys(CITY_CONFIGS).join(', ')}`);
  }
  return config;
}

export function getAvailableCities() {
  return Object.entries(CITY_CONFIGS).map(([id, config]) => ({
    city_id: id,
    name: config.name,
    country: config.country,
    timezone: config.timezone
  }));
}