import { WeatherSimulator } from './WeatherSimulator.js';
import { EventsManager } from './EventsManager.js';
import { TrafficSimulator } from './TrafficSimulator.js';
import { loadCityDatazones } from '../utils/dataLoaders.js';
import { getCityConfig } from '../utils/cityConfigs.js';

export class CitySimulation {
  constructor(id, secondsPerHour = 10, cityId = 'edinburgh') {
    this.id = id;
    this.cityId = cityId;
    this.cityConfig = getCityConfig(cityId);
    this.isRunning = false;
    this.currentTime = new Date();
    this.simulationHour = 9;
    this.hourCounter = 0;
    
    this.secondsPerHour = secondsPerHour;
    
    this.foundryConfig = this.loadFoundryConfig();
    this.foundryToken = null;
    this.foundryRetryCount = 0;
    this.maxFoundryRetries = 3;
    
    // Initialize simulators with city ID
    this.weatherSim = new WeatherSimulator(cityId);
    this.eventsSim = new EventsManager(cityId);
    this.trafficSim = new TrafficSimulator(cityId);
    
    this.previousWeather = null;
    this.previousTraffic = null;
    
    this.readyHourData = null;
    this.isInitialized = false;
    this.isGenerating = false;
    
    this.dashboardControlledTime = null;
    
    console.log(`🏙️ Created ${this.cityConfig.name} simulation ${id} with ${secondsPerHour}s per hour${this.foundryConfig ? ' (Foundry enabled)' : ''}`);
  }

  loadFoundryConfig() {
    const foundryUrl = process.env.FOUNDRY_URL;
    const clientId = process.env.FOUNDRY_CLIENT_ID;
    const clientSecret = process.env.FOUNDRY_CLIENT_SECRET;
    const streamRid = process.env.FOUNDRY_STREAM_RID;
    
    if (!foundryUrl || !clientId || !clientSecret || !streamRid) {
      console.log('⚠️ Foundry environment variables not configured - Foundry integration disabled');
      return null;
    }
    
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
      const datazones = await loadCityDatazones(this.cityId);
      await this.trafficSim.initializeWithDatazones(datazones);
    } catch (error) {
      console.error(`❌ Failed to initialize ${this.cityId} traffic system:`, error);
      throw error;
    }
  }

  async initializeEventsSystem() {
    try {
      await this.eventsSim.generateInitialEvents(this.currentTime);
    } catch (error) {
      console.error(`❌ Failed to initialize ${this.cityId} events system:`, error);
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
            'User-Agent': 'City-Simulation/1.0.0'
          },
          timeout: 30000
        }
      );
      
      this.foundryToken = authResponse.data.access_token;
      console.log(`✅ Foundry authentication successful for ${this.cityConfig.name} simulation ${this.id}`);
      
    } catch (error) {
      console.error(`❌ Foundry connection failed for ${this.cityConfig.name} simulation ${this.id}:`, {
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
        city_id: this.cityId,
        city_name: this.cityConfig.name,
        timestamp: data.timestamp,
        hour: data.hour,
        game_time: data.timestamp,
        real_time: new Date().toISOString(),
        
        weather_temperature: parseFloat(data.weather.temperature.toFixed(2)),
        weather_humidity: parseFloat(data.weather.humidity.toFixed(2)),
        weather_wind_speed: parseFloat(data.weather.windSpeed.toFixed(2)),
        weather_condition: data.weather.condition,
        weather_pressure: data.weather.pressure || null,
        
        traffic_congestion_level: parseFloat(data.traffic.congestion_level.toFixed(2)),
        traffic_average_speed: parseFloat(data.traffic.average_speed.toFixed(2)),
        traffic_total_vehicles: data.traffic.total_vehicles || 0,
        traffic_peak_hour: data.traffic.peak_hour || false,
        traffic_weather_impact: data.traffic.weather_impact || 1.0,
        traffic_events_impact: data.traffic.events_impact || 1.0,
        
        events_active_count: data.events.active_count,
        events_scheduled_count: data.events.scheduled_count,
        events_completed_count: data.events.completed_count,
        events_summary: JSON.stringify(data.events.events),
        
        seconds_per_hour: this.secondsPerHour
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
            'User-Agent': 'City-Simulation/1.0.0'
          },
          timeout: 15000
        }
      );
      
      console.log(`📤 Pushed ${this.cityConfig.name} data to Foundry stream: ${data.timestamp} (${response.status})`);
      this.foundryRetryCount = 0;
      
    } catch (error) {
      console.error(`❌ Failed to push ${this.cityConfig.name} data to Foundry stream:`, {
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

  async generateNextHourData(dashboardRequestedTime = null) {
    if (this.isGenerating) {
      console.log(`⚠️ Generation already in progress for ${this.cityConfig.name} simulation ${this.id}`);
      return;
    }
    
    this.isGenerating = true;
    
    try {
      let targetTime;
      if (dashboardRequestedTime) {
        targetTime = new Date(dashboardRequestedTime);
        this.dashboardControlledTime = targetTime;
      } else if (this.dashboardControlledTime) {
        targetTime = this.dashboardControlledTime;
      } else {
        this.currentTime = new Date(this.currentTime.getTime() + (60 * 60 * 1000));
        targetTime = this.currentTime;
      }
      
      this.hourCounter++;
      this.simulationHour = targetTime.getHours();
      
      const weather = await this.weatherSim.simulateForTime(targetTime);
      const eventsData = this.eventsSim.processEventsForHour(targetTime, weather);
      const activeEvents = this.eventsSim.getActiveEvents(targetTime);
      
      const traffic = await this.trafficSim.simulateNextHour(
        targetTime, 
        weather, 
        activeEvents, 
        this.previousTraffic
      );
      
      this.previousWeather = weather;
      this.previousTraffic = traffic;
      this.currentTime = targetTime;
      
      const simulationData = {
        type: 'simulation_data',
        simulation_id: this.id,
        city_id: this.cityId,
        city_name: this.cityConfig.name,
        hour: this.simulationHour,
        timestamp: targetTime.toISOString(),
        real_timestamp: new Date().toISOString(),
        seconds_per_hour: this.secondsPerHour,
        weather: weather,
        events: eventsData,
        traffic: traffic,
        simulation_status: 'running'
      };
      
      this.readyHourData = simulationData;
      
      if (this.foundryConfig) {
        await this.pushToFoundryStream(simulationData);
      }
      
      if (this.hourCounter % 24 === 0) {
        this.eventsSim.generateMoreEvents(targetTime);
      }
      
      const trafficSummary = `${traffic.congestion_level.toFixed(1)}% congestion, ${traffic.datazones.length} zones`;
      const eventStats = this.eventsSim.getEventStatistics();
      const eventsSummary = `${eventStats.active} active, ${eventStats.scheduled} scheduled, ${eventStats.completed} completed`;
      
      console.log(`🏙️ ${this.cityConfig.name} simulation ${this.id} - Hour ${this.simulationHour}: ${weather.condition}, ${trafficSummary}, Events: ${eventsSummary}`);
      
      return simulationData;
      
    } catch (error) {
      console.error(`❌ ${this.cityConfig.name} simulation ${this.id} error:`, error);
      throw error;
    } finally {
      this.isGenerating = false;
    }
  }

  async start() {
    if (this.isRunning) {
      console.log(`⚠️ ${this.cityConfig.name} simulation ${this.id} is already running`);
      return;
    }
    
    console.log(`▶️ Starting ${this.cityConfig.name} simulation ${this.id}`);
    this.isRunning = true;
    
    try {
      await this.initializeTrafficSystem();
      await this.initializeEventsSystem();
      await this.weatherSim.initialize();
      
      if (this.foundryConfig) {
        await this.initializeFoundryConnection();
      }
      
      await this.generateNextHourData();
      this.isInitialized = true;
      
      console.log(`✅ ${this.cityConfig.name} simulation ${this.id} started with first hour pregenerated`);
      
    } catch (error) {
      console.error(`❌ Failed to start ${this.cityConfig.name} simulation ${this.id}:`, error);
      this.isRunning = false;
      throw error;
    }
  }

  async getDataAndAdvance() {
    if (!this.isRunning) {
      throw new Error(`${this.cityConfig.name} simulation is not running`);
    }
    
    if (!this.isInitialized || !this.readyHourData) {
      throw new Error(`No ${this.cityConfig.name} simulation data available yet - simulation is starting up`);
    }
    
    const dataToReturn = this.readyHourData;
    
    this.generateNextHourData().catch(error => {
      console.error(`❌ Background generation failed for ${this.cityConfig.name} simulation ${this.id}:`, error);
    });
    
    const now = new Date();
    
    return {
      status: "success",
      retrieved_at: now.toISOString(),
      server_time: now.toISOString(),
      simulation_id: this.id,
      city_id: this.cityId,
      city_name: this.cityConfig.name,
      timestamp: dataToReturn.timestamp,
      hour: this.simulationHour,
      is_running: this.isRunning,
      weather: {
        temperature: dataToReturn.weather.temperature,
        humidity: dataToReturn.weather.humidity,
        windSpeed: dataToReturn.weather.windSpeed,
        condition: dataToReturn.weather.condition,
        pressure: dataToReturn.weather.pressure
      },
      events: {
        active_count: dataToReturn.events.active_count,
        scheduled_count: dataToReturn.events.scheduled_count,
        completed_count: dataToReturn.events.completed_count,
        events: dataToReturn.events.events
      },
      traffic: {
        congestion_level: dataToReturn.traffic.congestion_level,
        average_speed: dataToReturn.traffic.average_speed,
        total_vehicles: dataToReturn.traffic.total_vehicles,
        peak_hour: dataToReturn.traffic.peak_hour,
        weather_impact: dataToReturn.traffic.weather_impact,
        events_impact: dataToReturn.traffic.events_impact,
        datazones: dataToReturn.traffic.datazones.map(zone => ({
          datazone_code: zone.datazone_code,
          datazone_congestion: zone.datazone_congestion,
          street_congestion: zone.street_congestion,
          area_type: zone.area_type,
          congestion_trend: zone.congestion_trend,
          estimated_vehicles: Math.round(zone.datazone_congestion * 50),
          average_speed: Math.max(5, 50 - (zone.datazone_congestion * 8))
        }))
      }
    };
  }

  getCurrentSnapshot() {
    if (!this.isInitialized || !this.readyHourData) {
      throw new Error(`No ${this.cityConfig.name} simulation data available yet - simulation is starting up`);
    }
    
    const now = new Date();
    
    return {
      status: "success",
      retrieved_at: now.toISOString(),
      server_time: now.toISOString(),
      simulation_id: this.id,
      city_id: this.cityId,
      city_name: this.cityConfig.name,
      timestamp: this.readyHourData.timestamp,
      hour: this.simulationHour,
      is_running: this.isRunning,
      weather: {
        temperature: this.readyHourData.weather.temperature,
        humidity: this.readyHourData.weather.humidity,
        windSpeed: this.readyHourData.weather.windSpeed,
        condition: this.readyHourData.weather.condition,
        pressure: this.readyHourData.weather.pressure
      },
      events: {
        active_count: this.readyHourData.events.active_count,
        scheduled_count: this.readyHourData.events.scheduled_count,
        completed_count: this.readyHourData.events.completed_count,
        events: this.readyHourData.events.events
      },
      traffic: {
        congestion_level: this.readyHourData.traffic.congestion_level,
        average_speed: this.readyHourData.traffic.average_speed,
        total_vehicles: this.readyHourData.traffic.total_vehicles,
        peak_hour: this.readyHourData.traffic.peak_hour,
        weather_impact: this.readyHourData.traffic.weather_impact,
        events_impact: this.readyHourData.traffic.events_impact,
        datazones: this.readyHourData.traffic.datazones.map(zone => ({
          datazone_code: zone.datazone_code,
          datazone_congestion: zone.datazone_congestion,
          street_congestion: zone.street_congestion,
          area_type: zone.area_type,
          congestion_trend: zone.congestion_trend,
          estimated_vehicles: Math.round(zone.datazone_congestion * 50),
          average_speed: Math.max(5, 50 - (zone.datazone_congestion * 8))
        }))
      }
    };
  }

  getSimulationStatus() {
    return {
      simulation_id: this.id,
      city_id: this.cityId,
      city_name: this.cityConfig.name,
      is_running: this.isRunning,
      current_time: this.currentTime.toISOString(),
      hour_counter: this.hourCounter,
      seconds_per_hour: this.secondsPerHour,
      foundry_integration: !!this.foundryConfig,
      foundry_connected: !!this.foundryToken,
      traffic_system: `${this.cityConfig.name} Datazones`,
      last_weather: this.previousWeather,
      last_traffic: this.previousTraffic ? {
        congestion_level: this.previousTraffic.congestion_level,
        average_speed: this.previousTraffic.average_speed,
        total_datazones: this.previousTraffic.datazones?.length || 0
      } : null,
      uptime_hours: this.hourCounter,
      created_at: this.currentTime ? new Date(this.currentTime.getTime() - (this.hourCounter * 60 * 60 * 1000)).toISOString() : null,
      is_initialized: this.isInitialized,
      has_ready_data: !!this.readyHourData,
      is_generating: this.isGenerating
    };
  }

  stop() {
    if (!this.isRunning) {
      console.log(`⚠️ ${this.cityConfig.name} simulation ${this.id} is already stopped`);
      return;
    }
    
    console.log(`⏹️ Stopping ${this.cityConfig.name} simulation ${this.id}`);
    this.isRunning = false;
    this.isInitialized = false;
    this.readyHourData = null;
  }

  updateTimeCompression(secondsPerHour) {
    this.secondsPerHour = secondsPerHour;
    console.log(`⏱️ Updated ${this.cityConfig.name} simulation ${this.id} time compression to ${secondsPerHour}s per hour`);
  }
}