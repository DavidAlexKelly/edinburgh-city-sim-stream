import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getCityConfig } from './cityConfigs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache for loaded city data
const cityDataCache = new Map();
const cityEventsCache = new Map();

export async function loadCityDatazones(cityId) {
  if (cityDataCache.has(cityId)) {
    return cityDataCache.get(cityId);
  }
  
  console.log(`📍 Loading ${cityId} datazones data...`);
  
  try {
    const cityConfig = getCityConfig(cityId);
    const datazoneFilePath = join(__dirname, '..', '..', cityConfig.datazones_file);
    const datazoneData = JSON.parse(readFileSync(datazoneFilePath, 'utf8'));
    
    cityDataCache.set(cityId, datazoneData);
    console.log(`✅ Loaded ${datazoneData.length} ${cityId} datazones`);
    return datazoneData;
    
  } catch (error) {
    console.error(`❌ Failed to load ${cityId} datazones:`, error.message);
    throw new Error(`Could not load datazones for ${cityId}. Make sure ${getCityConfig(cityId).datazones_file} exists.`);
  }
}

export async function loadCityEvents(cityId) {
  if (cityEventsCache.has(cityId)) {
    return cityEventsCache.get(cityId);
  }
  
  console.log(`🎪 Loading ${cityId} events data...`);
  
  try {
    const cityConfig = getCityConfig(cityId);
    const eventsFilePath = join(__dirname, '..', '..', cityConfig.events_file);
    const eventsData = JSON.parse(readFileSync(eventsFilePath, 'utf8'));
    
    cityEventsCache.set(cityId, eventsData);
    console.log(`✅ Loaded ${eventsData.length} ${cityId} event types`);
    return eventsData;
    
  } catch (error) {
    console.error(`❌ Failed to load ${cityId} events:`, error.message);
    throw new Error(`Could not load events for ${cityId}. Make sure ${getCityConfig(cityId).events_file} exists.`);
  }
}

// Legacy function for backward compatibility
export async function loadEdinburghDatazones() {
  return await loadCityDatazones('edinburgh');
}

export async function loadSampleEvents() {
  return await loadCityEvents('edinburgh');
}