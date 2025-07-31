// lib/simulation.js - Enhanced simulation with Foundry push integration
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get current directory for file imports
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Global state for simulations (in production, use a database)
export const activeSimulations = new Map();

// Global datazone data (loaded once, shared by all simulations)
let edinburghDatazones = null;

// Load Edinburgh datazones data
async function loadEdinburghDatazones() {
  if (edinburghDatazones) return edinburghDatazones;
  
  console.log('📍 Loading Edinburgh datazones data...');
  const datazoneFilePath = join(__dirname, '..', 'datazones_with_streets.json');
  const datazoneData = JSON.parse(readFileSync(datazoneFilePath, 'utf8'));
  
  edinburghDatazones = datazoneData;
  console.log(`✅ Loaded ${edinburghDatazones.length} Edinburgh datazones`);
  return edinburghDatazones;
}

// Global sample events data (loaded once, shared by all simulations)
let sampleEventsData = null;

// Load sample events data
async function loadSampleEvents() {
  if (sampleEventsData) return sampleEventsData;
  
  console.log('🎪 Loading sample events data...');
  const eventsFilePath = join(__dirname, '..', 'sample_events.json');
  const eventsData = JSON.parse(readFileSync(eventsFilePath, 'utf8'));
  
  sampleEventsData = eventsData;
  console.log(`✅ Loaded ${sampleEventsData.length} sample event types`);
  return sampleEventsData;
}

class CitySimulation {
  constructor(websocket, id, secondsPerHour = 10, foundryConfig = null) {
    this.ws = websocket;
    this.id = id;
    this.isRunning = false;
    this.interval = null;
    this.currentTime = new Date();
    this.hourCounter = 0;
    
    // Time compression settings
    this.secondsPerHour = secondsPerHour;
    this.intervalMs = secondsPerHour * 1000;
    
    // Foundry integration config
    this.foundryConfig = foundryConfig;
    this.foundryToken = null;
    this.foundryRetryCount = 0;
    this.maxFoundryRetries = 3;
    
    // Initialize simulators
    this.weatherSim = new WeatherSimulator();
    this.eventsSim = new EventsManager();
    this.trafficSim = new TrafficSimulator();
    
    this.previousWeather = null;
    this.previousTraffic = null;
    this.lastDataSent = null;
    
    // Initialize systems - these will throw if data not available
    this.initializeTrafficSystem();
    this.initializeEventsSystem();
    
    // Initialize Foundry connection if configured
    if (this.foundryConfig && this.foundryConfig.foundryUrl) {
      this.initializeFoundryConnection();
    }
    
    console.log(`🎯 Created simulation ${id} with ${secondsPerHour}s per hour${foundryConfig ? ' (Foundry enabled)' : ''}`);
  }
  
  async initializeTrafficSystem() {
    const datazones = await loadEdinburghDatazones();
    await this.trafficSim.initializeWithDatazones(datazones);
    console.log(`🚦 Simulation ${this.id} initialized with Edinburgh traffic system`);
  }
  
  async initializeEventsSystem() {
    await this.eventsSim.initialize();
    await this.eventsSim.generateInitialEvents(this.currentTime);
    console.log(`🎭 Simulation ${this.id} initialized with events system`);
  }
  
  async initializeFoundryConnection() {
    try {
      const axios = (await import('axios')).default;
      
      console.log(`🔗 Initializing Foundry connection to ${this.foundryConfig.foundryUrl}`);
      
      const tokenResponse = await axios.post(
        `${this.foundryConfig.foundryUrl}/multipass/api/oauth2/token`,
        {
          grant_type: 'client_credentials',
          client_id: this.foundryConfig.clientId,
          client_secret: this.foundryConfig.clientSecret
        },
        {
          headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'Edinburgh-City-Simulation/1.0.0'
          },
          timeout: 10000
        }
      );
      
      this.foundryToken = tokenResponse.data.access_token;
      this.foundryRetryCount = 0;
      console.log(`✅ Foundry connection initialized for simulation ${this.id}`);
      
    } catch (error) {
      console.error(`❌ Failed to initialize Foundry connection for simulation ${this.id}:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText
      });
      
      if (this.foundryRetryCount < this.maxFoundryRetries) {
        this.foundryRetryCount++;
        console.log(`🔄 Retrying Foundry connection (${this.foundryRetryCount}/${this.maxFoundryRetries}) in 5s...`);
        setTimeout(() => this.initializeFoundryConnection(), 5000);
      }
    }
  }
  
  async pushToFoundryStream(data) {
    if (!this.foundryToken || !this.foundryConfig || !this.foundryConfig.streamRid) {
      return;
    }
    
    try {
      const axios = (await import('axios')).default;
      
      const foundryRecord = {
        simulation_id: this.id,
        timestamp: data.timestamp,
        hour: data.hour,
        game_time: data.timestamp,
        real_time: new Date().toISOString(),
        
        // Weather data
        weather_temperature: parseFloat(data.weather.temperature.toFixed(2)),
        weather_humidity: parseFloat(data.weather.humidity.toFixed(2)),
        weather_wind_speed: parseFloat(data.weather.windSpeed.toFixed(2)),
        weather_condition: data.weather.condition,
        weather_pressure: data.weather.pressure || null,
        
        // Traffic data
        traffic_congestion_level: parseFloat(data.traffic.congestion_level.toFixed(2)),
        traffic_average_speed: parseFloat(data.traffic.average_speed.toFixed(2)),
        traffic_total_vehicles: data.traffic.total_vehicles || 0,
        traffic_peak_hour: data.traffic.peak_hour || false,
        traffic_weather_impact: data.traffic.weather_impact || 1.0,
        traffic_events_impact: data.traffic.events_impact || 1.0,
        
        // Events data
        events_active_count: data.events.active_count,
        events_summary: JSON.stringify(data.events.events),
        
        // Simulation metadata
        seconds_per_hour: this.secondsPerHour,
        next_update_in_seconds: this.secondsPerHour
      };
      
      const response = await axios.post(
        `${this.foundryConfig.foundryUrl}/api/v1/streams/${this.foundryConfig.streamRid}/records`,
        {
          records: [foundryRecord]
        },
        {
          headers: {
            'Authorization': `Bearer ${this.foundryToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Edinburgh-City-Simulation/1.0.0'
          },
          timeout: 15000
        }
      );
      
      console.log(`📤 Pushed to Foundry stream: ${data.timestamp} (${response.status})`);
      this.foundryRetryCount = 0;
      
    } catch (error) {
      console.error(`❌ Failed to push to Foundry stream:`, {
        message: error.message,
        status: error.response?.status,
        simulation_id: this.id
      });
      
      if (error.response?.status === 401 || error.response?.status === 403) {
        console.log(`🔄 Re-authenticating with Foundry...`);
        await this.initializeFoundryConnection();
      }
    }
  }
  
  async generateAndSendData() {
    try {
      // Advance time by 1 hour
      this.currentTime = new Date(this.currentTime.getTime() + (60 * 60 * 1000));
      this.hourCounter++;
      
      // Generate simulation data
      const weather = this.weatherSim.simulateNextHour(this.currentTime, this.previousWeather);
      
      // Process events for this hour
      const eventsData = this.eventsSim.processEventsForHour(this.currentTime);
      const activeEvents = this.eventsSim.getActiveEvents(this.currentTime);
      
      // Generate traffic data
      const traffic = await this.trafficSim.simulateNextHour(
        this.currentTime, 
        weather, 
        activeEvents, 
        this.previousTraffic
      );
      
      // Update state
      this.previousWeather = weather;
      this.previousTraffic = traffic;
      
      // Create simulation data package
      const simulationData = {
        type: 'simulation_data',
        simulation_id: this.id,
        hour: this.hourCounter,
        timestamp: this.currentTime.toISOString(),
        real_timestamp: new Date().toISOString(),
        seconds_per_hour: this.secondsPerHour,
        next_update_in_seconds: this.secondsPerHour,
        weather: weather,
        events: eventsData,
        traffic: traffic,
        simulation_status: 'running'
      };
      
      this.lastDataSent = simulationData;
      
      // Send via WebSocket if available
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify(simulationData));
      }
      
      // Push to Foundry if configured
      if (this.foundryConfig) {
        await this.pushToFoundryStream(simulationData);
      }
      
      // Generate new events every 24 hours
      if (this.hourCounter % 24 === 0) {
        this.eventsSim.generateMoreEvents(this.currentTime);
      }
      
      const trafficSummary = `${traffic.congestion_level.toFixed(1)}% congestion, ${traffic.datazones.length} zones`;
      const eventsSummary = eventsData.active_count > 0 ? `, ${eventsData.active_count} active events` : '';
      
      console.log(`📊 Simulation ${this.id} - Hour ${this.hourCounter}: ${weather.condition}, ${trafficSummary}${eventsSummary}`);
      
    } catch (error) {
      console.error(`❌ Simulation ${this.id} error:`, error);
      
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({
          type: 'simulation_error',
          simulation_id: this.id,
          message: 'Simulation error occurred',
          error: error.message,
          timestamp: new Date().toISOString()
        }));
      }
      
      throw error; // Re-throw to handle at higher level
    }
  }
  
  getSimulationStatus() {
    return {
      simulation_id: this.id,
      is_running: this.isRunning,
      current_time: this.currentTime.toISOString(),
      hour_counter: this.hourCounter,
      seconds_per_hour: this.secondsPerHour,
      foundry_integration: !!this.foundryConfig,
      foundry_connected: !!this.foundryToken,
      traffic_system: 'Edinburgh Datazones',
      last_weather: this.previousWeather,
      last_traffic: this.previousTraffic ? {
        congestion_level: this.previousTraffic.congestion_level,
        average_speed: this.previousTraffic.average_speed,
        total_datazones: this.previousTraffic.datazones?.length || 0
      } : null,
      uptime_hours: this.hourCounter,
      created_at: this.currentTime ? new Date(this.currentTime.getTime() - (this.hourCounter * 60 * 60 * 1000)).toISOString() : null
    };
  }
  
  // This method returns data matching the required API schema
  getCurrentSnapshot() {
    if (!this.previousWeather || !this.previousTraffic) {
      throw new Error('No simulation data available yet - simulation is starting up');
    }
    
    const now = new Date();
    const activeEvents = this.eventsSim.getActiveEvents(this.currentTime);
    
    return {
      status: "success",
      retrieved_at: now.toISOString(),
      server_time: now.toISOString(),
      simulation_id: this.id,
      timestamp: this.currentTime.toISOString(),
      hour: this.hourCounter,
      is_running: this.isRunning,
      weather: {
        temperature: this.previousWeather.temperature,
        humidity: this.previousWeather.humidity,
        windSpeed: this.previousWeather.windSpeed,
        condition: this.previousWeather.condition,
        pressure: this.previousWeather.pressure
      },
      events: {
        active_count: activeEvents.length,
        events: activeEvents.map(event => ({
          id: event.id,
          type: event.type,
          name: event.name,
          datazones: event.datazones,
          impact_factor: event.impact_factor,
          start_hour: event.start_hour,
          end_hour: event.end_hour,
          hours_remaining: this.eventsSim.calculateHoursRemaining(event, this.currentTime)
        }))
      },
      traffic: {
        congestion_level: this.previousTraffic.congestion_level,
        average_speed: this.previousTraffic.average_speed,
        total_vehicles: this.previousTraffic.total_vehicles,
        peak_hour: this.previousTraffic.peak_hour,
        weather_impact: this.previousTraffic.weather_impact,
        events_impact: this.previousTraffic.events_impact,
        datazones: this.previousTraffic.datazones.map(zone => ({
          datazone_code: zone.datazone_code,
          datazone_congestion: zone.datazone_congestion,
          street_ids: zone.street_ids,
          street_congestion: zone.street_congestion,
          area_type: zone.area_type,
          congestion_trend: zone.congestion_trend,
          event_impact: zone.event_impact
        }))
      }
    };
  }
  
  start() {
    if (this.isRunning) {
      console.log(`⚠️ Simulation ${this.id} is already running`);
      return;
    }
    
    this.isRunning = true;
    console.log(`🚀 Starting simulation ${this.id} with ${this.secondsPerHour} seconds per game hour`);
    
    // Generate first data immediately
    this.generateAndSendData();
    
    // Set up interval for subsequent data generation
    this.interval = setInterval(() => {
      if (this.isRunning) {
        this.generateAndSendData();
      }
    }, this.intervalMs);
  }
  
  stop() {
    if (!this.isRunning) {
      console.log(`⚠️ Simulation ${this.id} is already stopped`);
      return;
    }
    
    this.isRunning = false;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({
        type: 'simulation_stopped',
        simulation_id: this.id,
        final_hour: this.hourCounter,
        final_time: this.currentTime.toISOString(),
        timestamp: new Date().toISOString()
      }));
    }
    
    console.log(`🛑 Stopped simulation ${this.id} at hour ${this.hourCounter}`);
  }
  
  updateTimeCompression(newSecondsPerHour) {
    const wasRunning = this.isRunning;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    this.secondsPerHour = newSecondsPerHour;
    this.intervalMs = newSecondsPerHour * 1000;
    
    console.log(`⚡ Updated simulation ${this.id} time compression to ${newSecondsPerHour} seconds per game hour`);
    
    if (wasRunning) {
      this.interval = setInterval(() => {
        if (this.isRunning) {
          this.generateAndSendData();
        }
      }, this.intervalMs);
      
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({
          type: 'time_compression_updated',
          simulation_id: this.id,
          seconds_per_hour: newSecondsPerHour,
          timestamp: new Date().toISOString()
        }));
      }
    }
  }
}

// Weather Simulator
class WeatherSimulator {
  constructor() {
    this.baseTemp = 12; // Edinburgh average
    this.tempVariation = 15;
  }
  
  simulateNextHour(currentTime, previousWeather) {
    const hour = currentTime.getHours();
    const season = this.getSeason(currentTime);
    
    // Temperature based on time of day and season
    const timeOfDayFactor = Math.sin((hour - 6) * Math.PI / 12);
    const seasonalTemp = this.getSeasonalTemp(season);
    const baseTemp = seasonalTemp + (timeOfDayFactor * 8);
    
    const previousTemp = previousWeather?.temperature || baseTemp;
    const temperature = baseTemp + (Math.random() - 0.5) * 4 + (previousTemp - baseTemp) * 0.3;
    
    const humidity = 60 + (1 - timeOfDayFactor) * 25 + (Math.random() - 0.5) * 20;
    const windSpeed = Math.max(0, 5 + (Math.random() - 0.5) * 15);
    const condition = this.determineCondition(temperature, humidity, windSpeed, season);
    const pressure = 1013 + (Math.random() - 0.5) * 40;
    
    return {
      temperature: Math.round(temperature * 10) / 10,
      humidity: Math.max(0, Math.min(100, Math.round(humidity))),
      windSpeed: Math.round(windSpeed * 10) / 10,
      condition: condition,
      pressure: Math.round(pressure * 10) / 10
    };
  }
  
  getSeason(date) {
    const month = date.getMonth();
    if (month >= 2 && month <= 4) return 'spring';
    if (month >= 5 && month <= 7) return 'summer';
    if (month >= 8 && month <= 10) return 'autumn';
    return 'winter';
  }
  
  getSeasonalTemp(season) {
    const temps = { spring: 10, summer: 18, autumn: 12, winter: 4 };
    return temps[season];
  }
  
  determineCondition(temperature, humidity, windSpeed, season) {
    if (humidity > 85 && temperature > 2) return 'rainy';
    if (humidity > 70 && windSpeed > 15) return 'stormy';
    if (temperature < 2 && humidity > 80) return 'snowy';
    if (humidity < 30) return 'sunny';
    if (humidity > 60) return 'cloudy';
    return 'partly_cloudy';
  }
}

// Events Manager
class EventsManager {
  constructor() {
    this.activeEvents = [];
    this.scheduledEvents = [];
    this.eventIdCounter = 1;
    this.sampleEvents = null;
    this.isInitialized = false;
    
    this.eventGenerationChance = 0.15;
    this.minHoursInFuture = 48;
    this.maxHoursInFuture = 168;
  }
  
  async initialize() {
    if (this.isInitialized) return;
    
    this.sampleEvents = await loadSampleEvents();
    this.isInitialized = true;
    console.log(`🎭 Events manager initialized with ${this.sampleEvents.length} event types`);
  }
  
  async generateInitialEvents(currentTime) {
    await this.initialize();
    
    const initialEventCount = 3 + Math.floor(Math.random() * 3);
    
    for (let i = 0; i < initialEventCount; i++) {
      this.generateRandomEvent(currentTime);
    }
    
    console.log(`🎪 Generated ${this.scheduledEvents.length} initial scheduled events`);
  }
  
  processEventsForHour(currentTime) {
    this.activateScheduledEvents(currentTime);
    this.removeExpiredEvents(currentTime);
    
    if (Math.random() < this.eventGenerationChance) {
      this.generateRandomEvent(currentTime);
    }
    
    return {
      active_count: this.activeEvents.length,
      events: this.activeEvents.map(event => ({
        id: event.id,
        type: event.type,
        name: event.name,
        datazones: event.datazones,
        impact_factor: event.impact_factor,
        start_hour: event.start_hour,
        end_hour: event.end_hour,
        hours_remaining: this.calculateHoursRemaining(event, currentTime)
      }))
    };
  }
  
  generateRandomEvent(currentTime) {
    const randomEventTemplate = this.sampleEvents[Math.floor(Math.random() * this.sampleEvents.length)];
    
    const hoursInFuture = this.minHoursInFuture + 
                         Math.floor(Math.random() * (this.maxHoursInFuture - this.minHoursInFuture));
    
    const eventStartTime = new Date(currentTime.getTime() + (hoursInFuture * 60 * 60 * 1000));
    
    const event = {
      id: this.eventIdCounter++,
      type: randomEventTemplate.type,
      name: randomEventTemplate.name,
      description: randomEventTemplate.description,
      datazones: [...randomEventTemplate.datazones],
      impact_factor: randomEventTemplate.impact_factor,
      start_hour: randomEventTemplate.start_hour,
      end_hour: randomEventTemplate.end_hour,
      duration_hours: randomEventTemplate.duration_hours,
      
      scheduled_start_time: eventStartTime,
      actual_start_time: null,
      actual_end_time: null,
      status: 'scheduled'
    };
    
    this.scheduledEvents.push(event);
    console.log(`📅 Scheduled ${event.type} "${event.name}" for ${Math.round(hoursInFuture)} hours from now`);
  }
  
  activateScheduledEvents(currentTime) {
    const currentHour = currentTime.getHours();
    
    const toActivate = this.scheduledEvents.filter(event => {
      const dayReached = currentTime >= event.scheduled_start_time;
      const hourMatches = currentHour === event.start_hour;
      return dayReached && hourMatches;
    });
    
    for (const event of toActivate) {
      event.actual_start_time = new Date(currentTime);
      event.actual_end_time = new Date(currentTime.getTime() + (event.duration_hours * 60 * 60 * 1000));
      event.status = 'active';
      
      this.activeEvents.push(event);
      this.scheduledEvents = this.scheduledEvents.filter(e => e.id !== event.id);
      
      console.log(`🎉 Event activated: ${event.type} "${event.name}"`);
    }
  }
  
  removeExpiredEvents(currentTime) {
    const currentHour = currentTime.getHours();
    
    const expiredEvents = this.activeEvents.filter(event => {
      return currentHour >= event.end_hour || 
             (event.actual_end_time && currentTime >= event.actual_end_time);
    });
    
    for (const event of expiredEvents) {
      console.log(`🏁 Event ended: ${event.type} "${event.name}"`);
    }
    
    this.activeEvents = this.activeEvents.filter(event => !expiredEvents.includes(event));
  }
  
  calculateHoursRemaining(event, currentTime) {
    if (event.actual_end_time) {
      const msRemaining = event.actual_end_time.getTime() - currentTime.getTime();
      return Math.max(0, Math.round(msRemaining / (60 * 60 * 1000)));
    }
    
    const currentHour = currentTime.getHours();
    if (currentHour <= event.end_hour) {
      return event.end_hour - currentHour;
    }
    
    return 0;
  }
  
  getActiveEvents(currentTime) {
    return this.activeEvents;
  }
  
  generateMoreEvents(currentTime) {
    if (this.scheduledEvents.length < 3) {
      const newEventCount = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < newEventCount; i++) {
        this.generateRandomEvent(currentTime);
      }
      console.log(`🎪 Force generated ${newEventCount} additional events`);
    }
  }
}

// Traffic Simulator
class TrafficSimulator {
  constructor() {
    this.datazones = [];
    this.previousHourData = null;
    this.isInitialized = false;
    
    this.roadTypeWeights = {
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
    
    this.peakHourMultipliers = {
      'primary': 2.5,
      'secondary': 2.2,
      'tertiary': 1.8,
      'trunk': 2.8,
      'motorway': 3.0,
      'residential': 1.3,
      'unclassified': 1.2,
      'service': 1.1
    };
  }
  
  async initializeWithDatazones(datazoneData) {
    if (this.isInitialized) return;
    
    console.log(`🏗️ Initializing traffic system with ${datazoneData.length} Edinburgh datazones...`);
    
    this.datazones = datazoneData.map(zone => {
      const baselineCongestion = this.calculateBaselineCongestion(zone);
      
      return {
        datazone_code: zone.datazone_code,
        street_count: zone.street_count,
        street_type_counts: zone.street_type_counts,
        dominant_street_type: zone.dominant_street_type,
        street_ids: zone.street_ids,
        
        baseline_congestion: baselineCongestion,
        current_congestion: baselineCongestion,
        congestion_trend: 0,
        
        street_congestion: this.calculateStreetCongestion(zone.street_ids, baselineCongestion),
        
        area_type: this.determineAreaType(zone),
        traffic_capacity: this.calculateTrafficCapacity(zone),
        bottleneck_risk: this.calculateBottleneckRisk(zone)
      };
    });
    
    this.isInitialized = true;
    console.log(`✅ Traffic system initialized. Average baseline congestion: ${this.getAverageBaseline().toFixed(1)}%`);
  }
  
  calculateBaselineCongestion(zone) {
    let totalWeight = 0;
    
    for (const [roadType, count] of Object.entries(zone.street_type_counts)) {
      const weight = this.roadTypeWeights[roadType] || 15;
      totalWeight += weight * count;
    }
    
    const densityFactor = Math.min(zone.street_count / 50, 2);
    const roadMixScore = totalWeight / Math.max(zone.street_count, 1);
    const dominantBonus = this.roadTypeWeights[zone.dominant_street_type] || 15;
    
    let baseline = Math.min(100, (roadMixScore * densityFactor + dominantBonus) / 8);
    
    if (zone.street_type_counts.motorway > 0) baseline += 15;
    if (zone.street_type_counts.primary > 5) baseline += 10;
    if (zone.dominant_street_type === 'residential' && zone.street_count > 30) {
      baseline += 5;
    }
    
    return Math.max(5, Math.min(95, baseline));
  }
  
  calculateStreetCongestion(streetIds, datazoneBaseline) {
    return streetIds.map(streetId => {
      const variation = (Math.random() - 0.5) * 40;
      const streetCongestion = Math.max(0, Math.min(100, datazoneBaseline + variation));
      
      return {
        street_id: streetId,
        congestion_level: Math.round(streetCongestion * 10) / 10
      };
    });
  }
  
  determineAreaType(zone) {
    const { street_type_counts, dominant_street_type, street_count } = zone;
    
    if (street_type_counts.motorway > 0 || street_type_counts.trunk > 2) {
      return 'major_transport_hub';
    } else if (street_type_counts.primary > 3 || dominant_street_type === 'primary') {
      return 'commercial_arterial';
    } else if (dominant_street_type === 'secondary' || street_type_counts.secondary > 2) {
      return 'mixed_development';
    } else if (dominant_street_type === 'residential' && street_count > 25) {
      return 'dense_residential';
    } else if (dominant_street_type === 'residential') {
      return 'suburban_residential';
    } else {
      return 'mixed_local';
    }
  }
  
  calculateTrafficCapacity(zone) {
    let capacity = 0;
    
    for (const [roadType, count] of Object.entries(zone.street_type_counts)) {
      const baseCapacity = {
        'motorway': 2000,
        'trunk': 1500,
        'primary': 1200,
        'secondary': 800,
        'tertiary': 500,
        'residential': 200,
        'unclassified': 150,
        'service': 100
      }[roadType] || 100;
      
      capacity += baseCapacity * count;
    }
    
    return capacity;
  }
  
  calculateBottleneckRisk(zone) {
    let risk = 0;
    
    const primaryRatio = (zone.street_type_counts.primary || 0) / zone.street_count;
    const residentialRatio = (zone.street_type_counts.residential || 0) / zone.street_count;
    
    if (primaryRatio > 0.3 && residentialRatio > 0.4) risk += 30;
    if (zone.street_count > 40 && !zone.street_type_counts.motorway) risk += 20;
    if (zone.dominant_street_type === 'residential' && zone.street_type_counts.primary > 0) {
      risk += 15;
    }
    
    return Math.min(100, risk);
  }
  
  simulateNextHour(currentTime, weather, events, previousTrafficData) {
    if (!this.isInitialized) {
      throw new Error('Traffic simulator not initialized with datazone data');
    }
    
    const hour = currentTime.getHours();
    const dayOfWeek = currentTime.getDay();
    const isPeakHour = this.isPeakHour(hour, dayOfWeek);
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    
    console.log(`🚦 Simulating traffic for hour ${hour}, peak: ${isPeakHour}, weekend: ${isWeekend}`);
    
    const globalFactors = this.calculateGlobalFactors(hour, dayOfWeek, weather, events);
    
    const updatedDatazones = this.datazones.map(zone => {
      const updatedZone = this.updateDatazoneTraffic(zone, globalFactors, isPeakHour, isWeekend);
      return updatedZone;
    });
    
    this.datazones = updatedDatazones;
    
    const cityStats = this.calculateCityWideStats(updatedDatazones);
    
    return {
      congestion_level: cityStats.averageCongestion,
      average_speed: this.calculateAverageSpeed(cityStats.averageCongestion),
      total_vehicles: this.estimateTotalVehicles(cityStats, isPeakHour),
      peak_hour: isPeakHour,
      weather_impact: globalFactors.weatherMultiplier,
      events_impact: globalFactors.eventsMultiplier,
      
      datazones: updatedDatazones.map(zone => ({
        datazone_code: zone.datazone_code,
        datazone_congestion: zone.current_congestion,
        street_ids: zone.street_ids,
        street_congestion: zone.street_congestion,
        area_type: zone.area_type,
        congestion_trend: zone.congestion_trend > 0 ? 'increasing' : zone.congestion_trend < 0 ? 'decreasing' : 'stable',
        event_impact: zone.event_impact || 0
      }))
    };
  }
  
  updateDatazoneTraffic(zone, globalFactors, isPeakHour, isWeekend) {
    let newCongestion = zone.current_congestion;
    
    newCongestion *= globalFactors.weatherMultiplier;
    newCongestion *= globalFactors.eventsMultiplier;
    newCongestion *= globalFactors.timeMultiplier;
    
    const zoneEventImpact = globalFactors.zoneEventImpacts.get(zone.datazone_code) || 1.0;
    if (zoneEventImpact > 1.0) {
      newCongestion *= zoneEventImpact;
      console.log(`🎪 Datazone ${zone.datazone_code} event impact: ${((zoneEventImpact - 1) * 100).toFixed(0)}% increase`);
    }
    
    if (isPeakHour) {
      const peakMultiplier = this.getPeakMultiplierForArea(zone.area_type, zone.dominant_street_type);
      newCongestion *= peakMultiplier;
    }
    
    if (isWeekend) {
      const weekendMultiplier = this.getWeekendMultiplierForArea(zone.area_type);
      newCongestion *= weekendMultiplier;
    }
    
    const trendStrength = 0.1;
    const baselineReturn = 0.05;
    
    const previousTrend = zone.congestion_trend;
    let newTrend = previousTrend * (1 - trendStrength);
    
    newTrend += (Math.random() - 0.5) * 0.3;
    newTrend += (zone.baseline_congestion - newCongestion) * baselineReturn;
    
    newCongestion += newTrend * 5;
    
    newCongestion = Math.max(0, Math.min(100, newCongestion));
    newTrend = Math.max(-1, Math.min(1, newTrend));
    
    const newStreetCongestion = this.calculateStreetCongestion(zone.street_ids, newCongestion);
    
    return {
      ...zone,
      current_congestion: Math.round(newCongestion * 10) / 10,
      congestion_trend: Math.round(newTrend * 100) / 100,
      street_congestion: newStreetCongestion,
      event_impact: zoneEventImpact > 1.0 ? Math.round((zoneEventImpact - 1) * 100) : 0
    };
  }
  
  calculateGlobalFactors(hour, dayOfWeek, weather, events) {
    let weatherMultiplier = 1.0;
    if (weather.condition === 'rainy') weatherMultiplier = 1.4;
    else if (weather.condition === 'snowy') weatherMultiplier = 2.2;
    else if (weather.condition === 'stormy') weatherMultiplier = 1.8;
    else if (weather.condition === 'sunny') weatherMultiplier = 0.95;
    
    if (weather.windSpeed > 30) weatherMultiplier *= 1.2;
    
    let baseEventsMultiplier = 1.0;
    if (events && events.length > 0) {
      for (const event of events) {
        baseEventsMultiplier += (event.impact_factor || 0.2) * 0.1;
      }
    }
    
    const zoneEventImpacts = this.calculateZoneEventImpacts(events);
    
    let timeMultiplier = 1.0;
    if (hour >= 7 && hour <= 9) timeMultiplier = 1.6;
    else if (hour >= 16 && hour <= 18) timeMultiplier = 1.8;
    else if (hour >= 22 || hour <= 5) timeMultiplier = 0.3;
    else if (hour >= 10 && hour <= 15) timeMultiplier = 0.8;
    
    return {
      weatherMultiplier,
      eventsMultiplier: baseEventsMultiplier,
      timeMultiplier,
      zoneEventImpacts
    };
  }
  
  calculateZoneEventImpacts(events) {
    const zoneImpacts = new Map();
    
    if (!events || events.length === 0) {
      return zoneImpacts;
    }
    
    for (const event of events) {
      if (event.datazones && event.datazones.length > 0) {
        const primaryDatazone = event.datazones[0];
        const primaryImpact = 1.0 + (event.impact_factor || 0.3);
        zoneImpacts.set(primaryDatazone, Math.max(zoneImpacts.get(primaryDatazone) || 1.0, primaryImpact));
        
        for (let i = 1; i < event.datazones.length; i++) {
          const secondaryDatazone = event.datazones[i];
          const secondaryImpact = 1.0 + ((event.impact_factor || 0.3) * 0.7);
          zoneImpacts.set(secondaryDatazone, Math.max(zoneImpacts.get(secondaryDatazone) || 1.0, secondaryImpact));
        }
        
        console.log(`🎭 Event "${event.name}" affecting ${event.datazones.length} datazones`);
      }
    }
    
    return zoneImpacts;
  }
  
  getPeakMultiplierForArea(areaType, dominantRoadType) {
    const areaMultipliers = {
      'major_transport_hub': 1.8,
      'commercial_arterial': 1.6,
      'mixed_development': 1.4,
      'dense_residential': 1.2,
      'suburban_residential': 1.1,
      'mixed_local': 1.3
    };
    
    const roadMultiplier = this.peakHourMultipliers[dominantRoadType] || 1.2;
    const areaMultiplier = areaMultipliers[areaType] || 1.3;
    
    return (roadMultiplier + areaMultiplier) / 2;
  }
  
  getWeekendMultiplierForArea(areaType) {
    const weekendMultipliers = {
      'major_transport_hub': 0.7,
      'commercial_arterial': 0.6,
      'mixed_development': 0.8,
      'dense_residential': 1.1,
      'suburban_residential': 0.9,
      'mixed_local': 1.0
    };
    
    return weekendMultipliers[areaType] || 0.8;
  }
  
  calculateCityWideStats(datazones) {
    const totalCongestion = datazones.reduce((sum, zone) => sum + zone.current_congestion, 0);
    const averageCongestion = totalCongestion / datazones.length;
    
    const highCongestionZones = datazones.filter(zone => zone.current_congestion > 70);
    const lowCongestionZones = datazones.filter(zone => zone.current_congestion < 30);
    
    return {
      averageCongestion: Math.round(averageCongestion * 10) / 10,
      highCongestionCount: highCongestionZones.length,
      lowCongestionCount: lowCongestionZones.length,
      totalCapacity: datazones.reduce((sum, zone) => sum + zone.traffic_capacity, 0)
    };
  }
  
  isPeakHour(hour, dayOfWeek) {
    if (dayOfWeek === 0 || dayOfWeek === 6) return false;
    return (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18);
  }
  
  calculateAverageSpeed(congestionLevel) {
    const baseSpeed = 35;
    const speedReduction = (congestionLevel / 100) * 0.7;
    return Math.max(5, baseSpeed * (1 - speedReduction));
  }
  
  estimateTotalVehicles(cityStats, isPeakHour) {
    const baseVehicles = 45000;
    const congestionFactor = 1 + (cityStats.averageCongestion / 100);
    const peakFactor = isPeakHour ? 1.4 : 1.0;
    
    return Math.floor(baseVehicles * congestionFactor * peakFactor);
  }
  
  getAverageBaseline() {
    if (!this.isInitialized || this.datazones.length === 0) return 0;
    const total = this.datazones.reduce((sum, zone) => sum + zone.baseline_congestion, 0);
    return total / this.datazones.length;
  }
}

export { CitySimulation };