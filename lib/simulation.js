// lib/simulation.js - Enhanced simulation with Foundry push integration for Railway
// Global state for simulations (in production, use Redis or database)
export const activeSimulations = new Map();

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
    this.weatherSim = new AdvancedWeatherSimulator();
    this.eventsSim = new AdvancedEventsManager();
    this.trafficSim = new AdvancedTrafficSimulator();
    
    this.previousWeather = null;
    this.previousTraffic = null;
    this.lastDataSent = null;
    
    // Generate initial events
    this.eventsSim.generateInitialEvents(this.currentTime);
    
    // Initialize Foundry connection if configured
    if (this.foundryConfig && this.foundryConfig.foundryUrl) {
      this.initializeFoundryConnection();
    }
    
    console.log(`🎯 Created simulation ${id} with ${secondsPerHour}s per hour${foundryConfig ? ' (Foundry enabled)' : ''}`);
  }
  
  async initializeFoundryConnection() {
    try {
      // Dynamic import to handle potential module loading issues
      const axios = (await import('axios')).default;
      
      console.log(`🔗 Initializing Foundry connection to ${this.foundryConfig.foundryUrl}`);
      
      // Get OAuth2 token for Foundry
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
      
      // Retry logic
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
      
      // Transform simulation data for Foundry streaming
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
        traffic_congestion_level: parseFloat(data.traffic.congestionLevel.toFixed(2)),
        traffic_average_speed: parseFloat(data.traffic.averageSpeed.toFixed(2)),
        traffic_incident_count: data.traffic.incidents?.length || 0,
        traffic_total_vehicles: data.traffic.totalVehicles || 0,
        
        // Events data
        events_active_count: data.events.active_count,
        events_summary: JSON.stringify(data.events.events),
        
        // Simulation metadata
        seconds_per_hour: this.secondsPerHour,
        next_update_in_seconds: this.secondsPerHour
      };
      
      // Push to Foundry stream with retry logic
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
      this.foundryRetryCount = 0; // Reset retry count on success
      
    } catch (error) {
      console.error(`❌ Failed to push to Foundry stream:`, {
        message: error.message,
        status: error.response?.status,
        simulation_id: this.id
      });
      
      // Handle authentication errors
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
      const activeEvents = this.eventsSim.getActiveEvents(this.currentTime);
      const traffic = this.trafficSim.simulateNextHour(
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
        events: {
          active_count: activeEvents.length,
          events: activeEvents
        },
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
      
      // Periodically generate new events (every 24 hours)
      if (this.hourCounter % 24 === 0) {
        this.eventsSim.generateMoreEvents(this.currentTime);
      }
      
      console.log(`📊 Simulation ${this.id} - Hour ${this.hourCounter}: ${weather.condition}, ${traffic.congestionLevel.toFixed(1)}% congestion`);
      
    } catch (error) {
      console.error(`❌ Simulation ${this.id} error:`, error);
      
      // Send error via WebSocket
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({
          type: 'simulation_error',
          simulation_id: this.id,
          message: 'Simulation error occurred',
          error: error.message,
          timestamp: new Date().toISOString()
        }));
      }
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
      last_weather: this.previousWeather,
      last_traffic: this.previousTraffic,
      uptime_hours: this.hourCounter,
      created_at: this.currentTime ? new Date(this.currentTime.getTime() - (this.hourCounter * 60 * 60 * 1000)).toISOString() : null
    };
  }
  
  getCurrentSnapshot() {
    if (!this.previousWeather || !this.previousTraffic) {
      return { 
        simulation_id: this.id,
        error: 'No simulation data available yet',
        message: 'Simulation is starting up, please wait for first data generation'
      };
    }
    
    return {
      simulation_id: this.id,
      timestamp: this.currentTime.toISOString(),
      real_timestamp: new Date().toISOString(),
      hour: this.hourCounter,
      is_running: this.isRunning,
      weather: this.previousWeather,
      traffic: this.previousTraffic,
      events: {
        active_count: this.eventsSim.getActiveEvents(this.currentTime).length,
        events: this.eventsSim.getActiveEvents(this.currentTime)
      },
      simulation_config: {
        seconds_per_hour: this.secondsPerHour,
        foundry_integration: !!this.foundryConfig
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
    
    // Send stop notification via WebSocket
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
    
    // Clear existing interval
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    // Update settings
    this.secondsPerHour = newSecondsPerHour;
    this.intervalMs = newSecondsPerHour * 1000;
    
    console.log(`⚡ Updated simulation ${this.id} time compression to ${newSecondsPerHour} seconds per game hour`);
    
    // Restart interval if simulation was running
    if (wasRunning) {
      this.interval = setInterval(() => {
        if (this.isRunning) {
          this.generateAndSendData();
        }
      }, this.intervalMs);
      
      // Send update notification
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

// Enhanced Weather Simulator
class AdvancedWeatherSimulator {
  constructor() {
    this.baseTemp = 12; // Edinburgh average
    this.tempVariation = 15;
  }
  
  simulateNextHour(currentTime, previousWeather) {
    const hour = currentTime.getHours();
    const season = this.getSeason(currentTime);
    
    // Temperature based on time of day and season
    const timeOfDayFactor = Math.sin((hour - 6) * Math.PI / 12); // Peak at 2 PM
    const seasonalTemp = this.getSeasonalTemp(season);
    const baseTemp = seasonalTemp + (timeOfDayFactor * 8);
    
    // Add some randomness and continuity from previous weather
    const previousTemp = previousWeather?.temperature || baseTemp;
    const temperature = baseTemp + (Math.random() - 0.5) * 4 + (previousTemp - baseTemp) * 0.3;
    
    // Humidity (higher at night, lower in afternoon)
    const humidity = 60 + (1 - timeOfDayFactor) * 25 + (Math.random() - 0.5) * 20;
    
    // Wind speed
    const windSpeed = Math.max(0, 5 + (Math.random() - 0.5) * 15);
    
    // Weather condition logic
    const condition = this.determineCondition(temperature, humidity, windSpeed, season);
    
    // Atmospheric pressure
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
    const temps = {
      spring: 10,
      summer: 18,
      autumn: 12,
      winter: 4
    };
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

// Enhanced Events Manager
class AdvancedEventsManager {
  constructor() {
    this.events = [];
    this.eventIdCounter = 1;
  }
  
  generateInitialEvents(currentTime) {
    const events = [
      {
        id: this.eventIdCounter++,
        type: 'concert',
        name: 'Edinburgh Castle Concert',
        location: 'Edinburgh Castle',
        startTime: new Date(currentTime.getTime() + 2 * 60 * 60 * 1000),
        endTime: new Date(currentTime.getTime() + 5 * 60 * 60 * 1000),
        capacity: 5000,
        impact_factor: 0.3
      },
      {
        id: this.eventIdCounter++,
        type: 'festival',
        name: 'Royal Mile Festival',
        location: 'Royal Mile',
        startTime: new Date(currentTime.getTime() + 6 * 60 * 60 * 1000),
        endTime: new Date(currentTime.getTime() + 12 * 60 * 60 * 1000),
        capacity: 15000,
        impact_factor: 0.5
      },
      {
        id: this.eventIdCounter++,
        type: 'sports',
        name: 'Hibernian FC Match',
        location: 'Easter Road Stadium',
        startTime: new Date(currentTime.getTime() + 24 * 60 * 60 * 1000),
        endTime: new Date(currentTime.getTime() + 26 * 60 * 60 * 1000),
        capacity: 20421,
        impact_factor: 0.4
      }
    ];
    
    this.events = events;
    console.log(`🎪 Generated ${events.length} initial events`);
  }
  
  getActiveEvents(currentTime) {
    return this.events.filter(event => 
      currentTime >= event.startTime && currentTime <= event.endTime
    );
  }
  
  generateMoreEvents(currentTime) {
    const newEvents = [
      {
        id: this.eventIdCounter++,
        type: 'conference',
        name: 'Tech Edinburgh Conference',
        location: 'EICC',
        startTime: new Date(currentTime.getTime() + 48 * 60 * 60 * 1000),
        endTime: new Date(currentTime.getTime() + 56 * 60 * 60 * 1000),
        capacity: 3000,
        impact_factor: 0.2
      }
    ];
    
    this.events.push(...newEvents);
    console.log(`🎪 Generated ${newEvents.length} additional events`);
  }
}

// Enhanced Traffic Simulator
class AdvancedTrafficSimulator {
  constructor() {
    this.baseVehicles = 50000; // Edinburgh typical traffic
  }
  
  simulateNextHour(currentTime, weather, events, previousTraffic) {
    const hour = currentTime.getHours();
    const dayOfWeek = currentTime.getDay(); // 0 = Sunday
    
    // Base traffic patterns
    let trafficMultiplier = this.getHourlyTrafficMultiplier(hour);
    
    // Weekend adjustments
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      trafficMultiplier *= 0.7; // Less traffic on weekends
    }
    
    // Weather impact
    let weatherFactor = 1.0;
    if (weather.condition === 'rainy') weatherFactor = 1.3;
    if (weather.condition === 'snowy') weatherFactor = 1.8;
    if (weather.condition === 'stormy') weatherFactor = 1.5;
    
    // Events impact
    let eventsFactor = 1.0;
    for (const event of events) {
      eventsFactor += event.impact_factor;
    }
    
    // Calculate metrics
    const totalVehicles = Math.floor(
      this.baseVehicles * trafficMultiplier * weatherFactor * eventsFactor * (0.8 + Math.random() * 0.4)
    );
    
    const maxCapacity = 75000; // Edinburgh road capacity
    const congestionLevel = Math.min(100, (totalVehicles / maxCapacity) * 100);
    
    // Average speed decreases with congestion
    const baseSpeed = 35; // km/h average in Edinburgh
    const congestionSpeedFactor = Math.max(0.2, 1 - (congestionLevel / 100) * 0.8);
    const averageSpeed = baseSpeed * congestionSpeedFactor * (weather.condition === 'sunny' ? 1.1 : weatherFactor > 1 ? 0.8 : 1.0);
    
    // Generate random incidents
    const incidents = this.generateIncidents(congestionLevel, weather);
    
    return {
      congestionLevel: Math.round(congestionLevel * 10) / 10,
      averageSpeed: Math.round(averageSpeed * 10) / 10,
      totalVehicles: totalVehicles,
      incidents: incidents,
      weather_impact: weatherFactor,
      events_impact: eventsFactor,
      peak_hour: this.isPeakHour(hour)
    };
  }
  
  getHourlyTrafficMultiplier(hour) {
    // Edinburgh traffic patterns
    const patterns = {
      0: 0.1, 1: 0.05, 2: 0.03, 3: 0.02, 4: 0.03, 5: 0.1,
      6: 0.3, 7: 0.8, 8: 1.0, 9: 0.7, 10: 0.5, 11: 0.6,
      12: 0.7, 13: 0.8, 14: 0.7, 15: 0.6, 16: 0.8, 17: 1.0,
      18: 0.9, 19: 0.6, 20: 0.4, 21: 0.3, 22: 0.2, 23: 0.15
    };
    return patterns[hour] || 0.5;
  }
  
  isPeakHour(hour) {
    return (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18);
  }
  
  generateIncidents(congestionLevel, weather) {
    const incidents = [];
    let incidentProbability = congestionLevel / 1000; // Base probability
    
    // Weather increases incident probability
    if (weather.condition === 'rainy') incidentProbability *= 2;
    if (weather.condition === 'snowy') incidentProbability *= 3;
    if (weather.condition === 'stormy') incidentProbability *= 2.5;
    
    // Generate incidents
    while (Math.random() < incidentProbability && incidents.length < 5) {
      incidents.push({
        id: Math.floor(Math.random() * 10000),
        type: this.getRandomIncidentType(),
        location: this.getRandomLocation(),
        severity: Math.floor(Math.random() * 5) + 1,
        duration_minutes: Math.floor(Math.random() * 60) + 15
      });
      incidentProbability /= 2; // Reduce probability for additional incidents
    }
    
    return incidents;
  }
  
  getRandomIncidentType() {
    const types = ['accident', 'breakdown', 'roadwork', 'emergency_services', 'debris'];
    return types[Math.floor(Math.random() * types.length)];
  }
  
  getRandomLocation() {
    const locations = [
      'A1 near Cameron Toll',
      'Princes Street',
      'Royal Mile',
      'A720 City Bypass',
      'Lothian Road',
      'Easter Road',
      'Leith Walk',
      'George Street',
      'A90 Queensferry Road',
      'Dalkeith Road'
    ];
    return locations[Math.floor(Math.random() * locations.length)];
  }
}

export { CitySimulation };