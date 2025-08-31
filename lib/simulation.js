// Re-export everything for backward compatibility
export { WeatherSimulator } from './simulators/WeatherSimulator.js';
export { EventsManager } from './simulators/EventsManager.js';
export { TrafficSimulator } from './simulators/TrafficSimulator.js';
export { CitySimulation } from './simulators/CitySimulation.js';

// Keep the global state
export const activeSimulations = new Map();