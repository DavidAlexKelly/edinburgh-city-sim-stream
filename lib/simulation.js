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
  constructor(websocket, id, secondsPerHour = 10) {
    this.ws = websocket;
    this.id = id;
    this.isRunning = false;
    this.interval = null;
    this.currentTime = new Date();
    this.hourCounter = 0;
    
    // Time compression settings
    this.secondsPerHour = secondsPerHour;
    this.intervalMs = secondsPerHour * 1000;
    
    // Foundry integration config - loaded from environment
    this.foundryConfig = this.loadFoundryConfig();
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
    if (this.foundryConfig) {
      this.initializeFoundryConnection();
    }
    
    console.log(`🎯 Created simulation ${id} with ${secondsPerHour}s per hour${this.foundryConfig ? ' (Foundry enabled)' : ''}`);
  }
  
  loadFoundryConfig() {
    // Load Foundry configuration from environment variables
    const foundryUrl = process.env.FOUNDRY_URL;
    const clientId = process.env.FOUNDRY_CLIENT_ID;
    const clientSecret = process.env.FOUNDRY_CLIENT_SECRET;
    const streamRid = process.env.FOUNDRY_STREAM_RID;
    
    // If any required env var is missing, disable Foundry integration
    if (!foundryUrl || !clientId || !clientSecret || !streamRid) {
      console.log('⚠️ Foundry environment variables not configured - Foundry integration disabled');
      return null;
    }
    
    // Validate configuration
    if (!foundryUrl.startsWith('https://')) {
      console.error('❌ FOUNDRY_URL must use HTTPS');
      return null;
    }
    
    if (!streamRid.startsWith('ri.foundry.main.stream.')) {
      console.error('❌ Invalid FOUNDRY_STREAM_RID format');
      return null;
    }
    
    console.log(`✅ Foundry configuration loaded: ${foundryUrl}`);
    
    return {
      foundryUrl,
      clientId,
      clientSecret,
      streamRid
    };
  }
  
  async initializeTrafficSystem() {
    try {
      const datazones = await loadEdinburghDatazones();
      await this.trafficSim.initializeWithDatazones(datazones);
    } catch (error) {
      console.error('❌ Failed to initialize traffic system:', error);
      throw error;
    }
  }
  
  async initializeEventsSystem() {
    try {
      await this.eventsSim.generateInitialEvents(this.currentTime);
    } catch (error) {
      console.error('❌ Failed to initialize events system:', error);
      throw error;
    }
  }
  
  async initializeFoundryConnection() {
    if (!this.foundryConfig || !this.foundryConfig.foundryUrl) {
      return;
    }
    
    try {
      const axios = (await import('axios')).default;
      
      console.log(`🔗 Connecting to Foundry at ${this.foundryConfig.foundryUrl}...`);
      
      const authResponse = await axios.post(
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
          timeout: 30000
        }
      );
      
      this.foundryToken = authResponse.data.access_token;
      console.log(`✅ Foundry authentication successful for simulation ${this.id}`);
      
    } catch (error) {
      console.error(`❌ Foundry connection failed for simulation ${this.id}:`, {
        message: error.message,
        status: error.response?.status,
        foundryUrl: this.foundryConfig.foundryUrl
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
        
        // Enhanced Events data with status tracking
        events_active_count: data.events.active_count,
        events_scheduled_count: data.events.scheduled_count,
        events_completed_count: data.events.completed_count,
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
      
      // Process events for this hour - NOW RETURNS ALL EVENTS WITH STATUS
      const eventsData = this.eventsSim.processEventsForHour(this.currentTime);
      
      // Get only active events for traffic simulation (maintains compatibility)
      const activeEvents = this.eventsSim.getActiveEvents(this.currentTime);
      
      // Generate traffic data (using active events only)
      const traffic = await this.trafficSim.simulateNextHour(
        this.currentTime, 
        weather, 
        activeEvents, 
        this.previousTraffic
      );
      
      // Update state
      this.previousWeather = weather;
      this.previousTraffic = traffic;
      
      // Create simulation data package with enhanced events data
      const simulationData = {
        type: 'simulation_data',
        simulation_id: this.id,
        hour: this.hourCounter,
        timestamp: this.currentTime.toISOString(),
        real_timestamp: new Date().toISOString(),
        seconds_per_hour: this.secondsPerHour,
        next_update_in_seconds: this.secondsPerHour,
        weather: weather,
        events: eventsData, // Now includes ALL events with status
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
      
      // Generate new events every 24 hours (less frequent forced generation since we generate every tick now)
      if (this.hourCounter % 24 === 0) {
        this.eventsSim.generateMoreEvents(this.currentTime);
      }
      
      const trafficSummary = `${traffic.congestion_level.toFixed(1)}% congestion, ${traffic.datazones.length} zones`;
      
      // Enhanced logging with event statistics
      const eventStats = this.eventsSim.getEventStatistics();
      const eventsSummary = `${eventStats.active} active, ${eventStats.scheduled} scheduled, ${eventStats.completed} completed`;
      
      console.log(`📊 Simulation ${this.id} - Hour ${this.hourCounter}: ${weather.condition}, ${trafficSummary}, Events: ${eventsSummary}`);
      
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
    
    // Get all events with their status information
    const allEventsData = this.eventsSim.getAllEvents(this.currentTime);
    
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
        active_count: allEventsData.active_count,
        scheduled_count: allEventsData.scheduled_count,
        completed_count: allEventsData.completed_count,
        events: allEventsData.events // ALL events with status
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
          street_congestion: zone.street_congestion,
          area_type: zone.area_type,
          congestion_trend: zone.congestion_trend,
        }))
      }
    };
  }
  
  start() {
    if (this.isRunning) {
      console.log(`⚠️ Simulation ${this.id} is already running`);
      return;
    }
    
    console.log(`▶️ Starting simulation ${this.id}`);
    this.isRunning = true;
    
    this.interval = setInterval(() => {
      this.generateAndSendData().catch(error => {
        console.error(`❌ Simulation ${this.id} fatal error:`, error);
        this.stop();
      });
    }, this.intervalMs);
  }
  
  stop() {
    if (!this.isRunning) {
      console.log(`⚠️ Simulation ${this.id} is already stopped`);
      return;
    }
    
    console.log(`⏹️ Stopping simulation ${this.id}`);
    this.isRunning = false;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({
        type: 'simulation_stopped',
        simulation_id: this.id,
        message: 'Simulation has been stopped',
        timestamp: new Date().toISOString()
      }));
    }
  }
  
  updateTimeCompression(secondsPerHour) {
    this.secondsPerHour = secondsPerHour;
    this.intervalMs = secondsPerHour * 1000;
    
    if (this.isRunning) {
      console.log(`🕐 Updating simulation ${this.id} time compression to ${secondsPerHour}s per hour`);
      this.stop();
      this.start();
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

// Updated Events Manager
class EventsManager {
  constructor() {
    this.activeEvents = [];
    this.scheduledEvents = [];
    this.completedEvents = [];
    this.eventIdCounter = 1;
    this.sampleEvents = null;
    this.isInitialized = false;
    
    // Updated parameters per requirements
    this.eventGenerationChance = 0.1; // 10% chance each tick to generate new event
    this.minHoursInFuture = 48;
    this.maxHoursInFuture = 168; // Keep original 48-168 hour window
    
    // Track events for cleanup
    this.maxCompletedEventsToKeep = 50; // Prevent memory issues
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
    this.moveExpiredEventsToCompleted(currentTime);
    this.cleanupOldCompletedEvents();
    
    // Generate event with 10% chance each tick
    if (Math.random() < this.eventGenerationChance) {
      this.generateRandomEvent(currentTime);
    }
    
    // Return ALL events with their status instead of just active events
    const allEvents = [
      // Scheduled events
      ...this.scheduledEvents.map(event => ({
        id: event.id,
        type: event.type,
        name: event.name,
        description: event.description,
        datazones: event.datazones,
        impact_factor: event.impact_factor,
        start_hour: event.start_hour,
        end_hour: event.end_hour,
        duration_hours: event.duration_hours,
        scheduled_start_time: event.scheduled_start_time.toISOString(),
        actual_start_time: null,
        actual_end_time: null,
        status: 'scheduled',
        hours_until_start: this.calculateHoursUntilStart(event, currentTime),
        hours_remaining: null
      })),
      // Active events
      ...this.activeEvents.map(event => ({
        id: event.id,
        type: event.type,
        name: event.name,
        description: event.description,
        datazones: event.datazones,
        impact_factor: event.impact_factor,
        start_hour: event.start_hour,
        end_hour: event.end_hour,
        duration_hours: event.duration_hours,
        scheduled_start_time: event.scheduled_start_time.toISOString(),
        actual_start_time: event.actual_start_time ? event.actual_start_time.toISOString() : null,
        actual_end_time: event.actual_end_time ? event.actual_end_time.toISOString() : null,
        status: 'active',
        hours_until_start: 0,
        hours_remaining: this.calculateHoursRemaining(event, currentTime)
      })),
      // Completed events (recent ones)
      ...this.completedEvents.map(event => ({
        id: event.id,
        type: event.type,
        name: event.name,
        description: event.description,
        datazones: event.datazones,
        impact_factor: event.impact_factor,
        start_hour: event.start_hour,
        end_hour: event.end_hour,
        duration_hours: event.duration_hours,
        scheduled_start_time: event.scheduled_start_time.toISOString(),
        actual_start_time: event.actual_start_time ? event.actual_start_time.toISOString() : null,
        actual_end_time: event.actual_end_time ? event.actual_end_time.toISOString() : null,
        status: 'completed',
        hours_until_start: null,
        hours_remaining: 0
      }))
    ];
    
    return {
      active_count: this.activeEvents.length,
      scheduled_count: this.scheduledEvents.length,
      completed_count: this.completedEvents.length,
      events: allEvents
    };
  }
  
  generateRandomEvent(currentTime) {
    const randomEventTemplate = this.sampleEvents[Math.floor(Math.random() * this.sampleEvents.length)];
    
    // Calculate hours in future (48-168 hours)
    const hoursInFuture = this.minHoursInFuture + 
                         Math.floor(Math.random() * (this.maxHoursInFuture - this.minHoursInFuture));
    
    // Calculate the target date
    const targetDate = new Date(currentTime.getTime() + (hoursInFuture * 60 * 60 * 1000));
    
    // Set the event to start at the correct hour on the target date
    const eventStartTime = new Date(targetDate);
    eventStartTime.setHours(randomEventTemplate.start_hour, 0, 0, 0);
    
    // If the calculated start time is before the minimum required time,
    // move it to the next day at the same hour
    const minimumStartTime = new Date(currentTime.getTime() + (this.minHoursInFuture * 60 * 60 * 1000));
    if (eventStartTime < minimumStartTime) {
      eventStartTime.setDate(eventStartTime.getDate() + 1);
    }
    
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
    
    const daysUntilEvent = Math.floor((eventStartTime - currentTime) / (24 * 60 * 60 * 1000));
    console.log(`📅 Scheduled ${event.type} "${event.name}" for ${daysUntilEvent} days from now at ${event.start_hour}:00`);
  }
  
  activateScheduledEvents(currentTime) {
    const currentHour = currentTime.getHours();
    
    const toActivate = this.scheduledEvents.filter(event => {
      // Check if we've reached the scheduled date and the correct hour
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
      
      console.log(`🎉 Event activated: ${event.type} "${event.name}" (will run for ${event.duration_hours} hours)`);
    }
  }
  
  moveExpiredEventsToCompleted(currentTime) {
    const expiredEvents = this.activeEvents.filter(event => {
      // Check if the event has reached its natural end time
      return event.actual_end_time && currentTime >= event.actual_end_time;
    });
    
    for (const event of expiredEvents) {
      event.status = 'completed';
      this.completedEvents.push(event);
      console.log(`🏁 Event completed: ${event.type} "${event.name}"`);
    }
    
    // Remove expired events from active list
    this.activeEvents = this.activeEvents.filter(event => !expiredEvents.includes(event));
  }
  
  cleanupOldCompletedEvents() {
    // Keep only the most recent completed events to prevent memory issues
    if (this.completedEvents.length > this.maxCompletedEventsToKeep) {
      const eventsToRemove = this.completedEvents.length - this.maxCompletedEventsToKeep;
      this.completedEvents.splice(0, eventsToRemove);
      console.log(`🧹 Cleaned up ${eventsToRemove} old completed events`);
    }
  }
  
  calculateHoursUntilStart(event, currentTime) {
    if (event.scheduled_start_time) {
      const msUntilStart = event.scheduled_start_time.getTime() - currentTime.getTime();
      return Math.max(0, Math.round(msUntilStart / (60 * 60 * 1000)));
    }
    return 0;
  }
  
  calculateHoursRemaining(event, currentTime) {
    if (event.actual_end_time) {
      const msRemaining = event.actual_end_time.getTime() - currentTime.getTime();
      return Math.max(0, Math.round(msRemaining / (60 * 60 * 1000)));
    }
    
    // Fallback calculation using hours of day
    const currentHour = currentTime.getHours();
    if (currentHour <= event.end_hour) {
      return event.end_hour - currentHour;
    }
    
    return 0;
  }
  
  // Get only active events (for traffic simulation compatibility)
  getActiveEvents(currentTime) {
    return this.activeEvents;
  }
  
  // Get all events with status information
  getAllEvents(currentTime) {
    return this.processEventsForHour(currentTime);
  }
  
  generateMoreEvents(currentTime) {
    // Generate additional events if we have too few scheduled
    if (this.scheduledEvents.length < 3) {
      const newEventCount = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < newEventCount; i++) {
        this.generateRandomEvent(currentTime);
      }
      console.log(`🎪 Force generated ${newEventCount} additional events`);
    }
  }
  
  // Debug method to get statistics
  getEventStatistics() {
    return {
      scheduled: this.scheduledEvents.length,
      active: this.activeEvents.length,
      completed: this.completedEvents.length,
      total: this.scheduledEvents.length + this.activeEvents.length + this.completedEvents.length,
      next_event_id: this.eventIdCounter
    };
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
  
  async simulateNextHour(currentTime, weather, events, previousTrafficData) {
    if (!this.isInitialized) {
      throw new Error('Traffic simulator not initialized');
    }
    
    const hour = currentTime.getHours();
    const dayOfWeek = currentTime.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    
    const factors = this.calculateGlobalFactors(hour, dayOfWeek, weather, events);
    
    let totalCongestion = 0;
    let totalSpeed = 0;
    let totalVehicles = 0;
    let peakHourDetected = false;
    
    const updatedDatazones = this.datazones.map(zone => {
      let zoneCongestion = zone.baseline_congestion;
      
      if (!isWeekend) {
        const peakMultiplier = this.getPeakMultiplierForArea(zone.area_type, zone.dominant_street_type);
        zoneCongestion *= factors.timeMultiplier * peakMultiplier;
      } else {
        const weekendMultiplier = this.getWeekendMultiplierForArea(zone.area_type);
        zoneCongestion *= weekendMultiplier;
      }
      
      zoneCongestion *= factors.weatherMultiplier;
      
      const zoneEventImpact = factors.zoneEventImpacts.get(zone.datazone_code) || 1.0;
      zoneCongestion *= zoneEventImpact;
      
      if (previousTrafficData) {
        const prevZone = previousTrafficData.datazones.find(z => z.datazone_code === zone.datazone_code);
        if (prevZone) {
          const momentum = 0.3;
          zoneCongestion = (zoneCongestion * (1 - momentum)) + (prevZone.datazone_congestion * momentum);
        }
      }
      
      zoneCongestion = Math.max(0.1, Math.min(10.0, zoneCongestion));
      
      const congestionTrend = previousTrafficData ? 
        Math.round((zoneCongestion - (previousTrafficData.datazones.find(z => z.datazone_code === zone.datazone_code)?.datazone_congestion || zoneCongestion)) * 100) / 100 :
        0;
      
      const streetCongestion = this.calculateStreetCongestion(zone.street_ids, zoneCongestion);
      
      const speed = Math.max(5, 50 - (zoneCongestion * 8));
      const vehicles = Math.round(zoneCongestion * zone.traffic_capacity * (0.8 + Math.random() * 0.4));
      
      totalCongestion += zoneCongestion;
      totalSpeed += speed;
      totalVehicles += vehicles;
      
      if (factors.timeMultiplier > 1.5) {
        peakHourDetected = true;
      }
      
      return {
        datazone_code: zone.datazone_code,
        datazone_congestion: Math.round(zoneCongestion * 100) / 100,
        street_ids: zone.street_ids,
        street_congestion: streetCongestion,
        area_type: zone.area_type,
        congestion_trend: congestionTrend,
      };
    });
    
    const averageCongestion = totalCongestion / this.datazones.length;
    const averageSpeed = totalSpeed / this.datazones.length;
    
    return {
      congestion_level: Math.round(averageCongestion * 100) / 100,
      average_speed: Math.round(averageSpeed * 10) / 10,
      total_vehicles: totalVehicles,
      peak_hour: peakHourDetected,
      weather_impact: Math.round(factors.weatherMultiplier * 100) / 100,
      events_impact: Math.round(factors.eventsMultiplier * 100) / 100,
      datazones: updatedDatazones,
      simulation_time: currentTime.toISOString(),
      weekend_mode: isWeekend
    };
  }
  
  calculateBaselineCongestion(zone) {
    let baseScore = 0.8;
    
    if (zone.street_type_counts) {
      const totalStreets = zone.street_count || Object.values(zone.street_type_counts).reduce((a, b) => a + b, 0);
      
      for (const [roadType, count] of Object.entries(zone.street_type_counts)) {
        const weight = this.roadTypeWeights[roadType] || 20;
        const proportion = count / totalStreets;
        baseScore += (weight * proportion) / 100;
      }
    }
    
    const randomVariation = 0.8 + (Math.random() * 0.4);
    return Math.max(0.3, Math.min(3.0, baseScore * randomVariation));
  }
  
  calculateStreetCongestion(streetIds, zoneCongestion) {
    if (!streetIds || streetIds.length === 0) return [];
    
    return streetIds.map(streetId => {
      const streetVariation = 0.7 + (Math.random() * 0.6);
      const streetCongestion = zoneCongestion * streetVariation;
      return {
        street_id: streetId,
        congestion_level: Math.round(streetCongestion * 100) / 100
      };
    });
  }
  
  determineAreaType(zone) {
    if (!zone.street_type_counts) return 'mixed_local';
    
    const counts = zone.street_type_counts;
    const totalStreets = Object.values(counts).reduce((a, b) => a + b, 0);
    
    if ((counts.motorway || 0) + (counts.trunk || 0) > totalStreets * 0.3) {
      return 'major_transport_hub';
    }
    
    if ((counts.primary || 0) + (counts.secondary || 0) > totalStreets * 0.4) {
      return 'commercial_arterial';
    }
    
    if ((counts.residential || 0) > totalStreets * 0.6) {
      return totalStreets > 50 ? 'dense_residential' : 'suburban_residential';
    }
    
    return 'mixed_development';
  }
  
  calculateTrafficCapacity(zone) {
    const baseCapacity = 100;
    const streetCount = zone.street_count || 10;
    const streetMultiplier = Math.log(streetCount + 1) * 50;
    
    let typeMultiplier = 1.0;
    if (zone.street_type_counts) {
      const majorRoads = (zone.street_type_counts.motorway || 0) + 
                        (zone.street_type_counts.trunk || 0) + 
                        (zone.street_type_counts.primary || 0);
      typeMultiplier = 1.0 + (majorRoads * 0.5);
    }
    
    return Math.round(baseCapacity + streetMultiplier * typeMultiplier);
  }
  
  calculateBottleneckRisk(zone) {
    const streetCount = zone.street_count || 1;
    const connectionDensity = (zone.street_ids?.length || 1) / streetCount;
    
    if (connectionDensity < 0.5) return 'high';
    if (connectionDensity < 1.0) return 'medium';
    return 'low';
  }
  
  getAverageBaseline() {
    if (this.datazones.length === 0) return 0;
    const total = this.datazones.reduce((sum, zone) => sum + zone.baseline_congestion, 0);
    return total / this.datazones.length;
  }
  
  getZoneCongestionPercentile(datazone_code, congestionLevel) {
    const allCongestionLevels = this.datazones.map(z => z.current_congestion).sort((a, b) => a - b);
    const position = allCongestionLevels.findIndex(level => level >= congestionLevel);
    
    if (position === -1) return 100;
    return Math.round((position / allCongestionLevels.length) * 100);
  }
  
  getHighestCongestionZones(limit = 5) {
    return [...this.datazones]
      .sort((a, b) => b.current_congestion - a.current_congestion)
      .slice(0, limit)
      .map(zone => ({
        datazone_code: zone.datazone_code,
        congestion: zone.current_congestion,
        area_type: zone.area_type,
        bottleneck_risk: zone.bottleneck_risk
      }));
  }
  
  getEventImpactSummary(events) {
    if (!events || events.length === 0) {
      return 'No active events affecting traffic';
    }
    
    const impactedZones = new Set();
    events.forEach(event => {
      if (event.datazones) {
        event.datazones.forEach(zone => impactedZones.add(zone));
      }
    });
    
    const totalZones = this.datazones.length;
    const impactPercentage = Math.round((impactedZones.size / totalZones) * 100);
    
    return `${events.length} events affecting ${impactedZones.size}/${totalZones} zones (${impactPercentage}%)`;
  }
  
  getTrafficSummaryForZone(datazone_code) {
    const zone = this.datazones.find(z => z.datazone_code === datazone_code);
    if (!zone) return null;
    
    const zoneEventImpact = this.getCurrentZoneEventImpact(datazone_code);
    
    return {
      datazone_code: zone.datazone_code,
      baseline_congestion: zone.baseline_congestion,
      current_congestion: zone.current_congestion,
      area_type: zone.area_type,
      street_count: zone.street_count,
      traffic_capacity: zone.traffic_capacity,
      bottleneck_risk: zone.bottleneck_risk,
      event_impact_multiplier: zoneEventImpact > 1 ? Math.round((zoneEventImpact - 1) * 100) : 0
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
      'dense_residential': 0.9,
      'suburban_residential': 1.1,
      'mixed_local': 0.85
    };
    
    return weekendMultipliers[areaType] || 0.8;
  }
  
  getCurrentZoneEventImpact(datazone_code) {
    // This would be calculated during the last simulation run
    // For now, return a default value
    return 1.0;
  }
}

export { CitySimulation };