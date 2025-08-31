import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSeason, getSeasonalTemp } from '../utils/timeUtils.js';
import { getCityConfig } from '../utils/cityConfigs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class WeatherSimulator {
  constructor(cityId = 'edinburgh') {
    this.cityId = cityId;
    this.cityConfig = getCityConfig(cityId);
    this.weatherData = new Map();
    this.availableDateRange = null;
    this.isLoaded = false;
    // Single weather file for all UK cities
    this.dataPath = join(__dirname, '..', '..', 'data', 'weather_data.csv');
    this.baseHistoricalDate = null;
    this.simulationStartTime = null;
  }

  async initialize() {
    if (this.isLoaded) return;
    
    console.log(`🌤️ Loading UK weather data for ${this.cityId}...`);
    
    try {
      const csvData = readFileSync(this.dataPath, 'utf8');
      const lines = csvData.split('\n');
      
      let earliestDate = null;
      let latestDate = null;
      let recordCount = 0;
      
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const values = line.split(',');
        const datetime = values[0];
        
        if (!datetime) continue;
        
        const date = new Date(datetime);
        if (!earliestDate || date < earliestDate) earliestDate = date;
        if (!latestDate || date > latestDate) latestDate = date;
        
        this.weatherData.set(datetime, {
          datetime: datetime,
          temperature: parseFloat(values[1]),
          humidity: parseFloat(values[2]),
          precipitation: parseFloat(values[3]),
          precipitationProbability: parseFloat(values[4]),
          precipitationType: values[5],
          windSpeed: parseFloat(values[6]),
          conditions: values[7].replace(/"/g, ''),
          icon: values[8],
          source: 'historical_1min_uk'
        });
        
        recordCount++;
      }
      
      this.availableDateRange = {
        start: earliestDate,
        end: latestDate,
        totalRecords: recordCount
      };
      
      this.isLoaded = true;
      this.baseHistoricalDate = this.getRandomStartDate();
      
      console.log(`✅ Loaded ${recordCount} UK weather records for ${this.cityId}`);
      console.log(`📅 Date range: ${earliestDate.toISOString()} to ${latestDate.toISOString()}`);
      console.log(`🎲 Selected random start date: ${this.baseHistoricalDate.toISOString()}`);
      
    } catch (error) {
      console.warn(`⚠️ Could not load UK weather data for ${this.cityId}, using fallback generation:`, error.message);
      this.isLoaded = false;
    }
  }

  getRandomStartDate() {
    if (!this.availableDateRange) {
      throw new Error('Weather data not loaded');
    }
    
    const { start, end } = this.availableDateRange;
    const timeRange = end.getTime() - start.getTime();
    const bufferDays = 7 * 24 * 60 * 60 * 1000;
    const randomTime = start.getTime() + Math.random() * (timeRange - bufferDays);
    
    const randomDate = new Date(randomTime);
    randomDate.setMinutes(0, 0, 0);
    
    return randomDate;
  }

  async simulateForTime(requestedSimulationTime) {
    if (!this.simulationStartTime) {
      this.simulationStartTime = new Date(requestedSimulationTime);
      console.log(`🌤️ ${this.cityId} weather simulation started at: ${this.simulationStartTime.toISOString()}`);
    }
    
    const currentSimTime = new Date(requestedSimulationTime);
    const simulationElapsed = currentSimTime.getTime() - this.simulationStartTime.getTime();
    const historicalDateTime = new Date(this.baseHistoricalDate.getTime() + simulationElapsed);
    
    try {
      const weatherData = this.getWeatherForDateTime(historicalDateTime);
      
      // Apply minor city-specific variations to make weather slightly different
      const cityVariations = this.getCityWeatherVariations();
      
      const simulationWeather = {
        temperature: Math.round((weatherData.temperature + cityVariations.tempOffset) * 10) / 10,
        humidity: Math.round(Math.max(0, Math.min(100, weatherData.humidity + cityVariations.humidityOffset))),
        windSpeed: Math.round(Math.max(0, weatherData.windSpeed + cityVariations.windOffset) * 10) / 10,
        condition: this.mapConditionToSimulation(weatherData.conditions),
        pressure: this.estimatePressure(weatherData),
        precipitation: weatherData.precipitation,
        source: `historical_1min_uk_${this.cityId}`,
        historical_time: historicalDateTime.toISOString(),
        simulation_time: currentSimTime.toISOString(),
        raw_conditions: weatherData.conditions
      };
      
      return simulationWeather;
      
    } catch (error) {
      console.warn(`Failed to get ${this.cityId} weather for ${historicalDateTime.toISOString()}:`, error.message);
      return this.generateFallbackWeather(currentSimTime);
    }
  }

  getCityWeatherVariations() {
    // Small variations to make each city's weather slightly different
    // while still using the same base data
    const variations = {
      edinburgh: {
        tempOffset: -1.0,    // Slightly cooler
        humidityOffset: 2,   // Slightly more humid
        windOffset: 1.0      // Slightly windier
      },
      york: {
        tempOffset: 0.5,     // Slightly warmer
        humidityOffset: -1,  // Slightly less humid  
        windOffset: -0.5     // Slightly less windy
      },
      london: {
        tempOffset: 2.0,     // Warmer (urban heat island)
        humidityOffset: -3,  // Less humid
        windOffset: -1.0     // Less windy (sheltered by buildings)
      },
      manchester: {
        tempOffset: 0.0,     // Same as base
        humidityOffset: 3,   // More humid (industrial/coastal influence)
        windOffset: 0.5      // Slightly windier
      }
    };
    
    return variations[this.cityId] || { tempOffset: 0, humidityOffset: 0, windOffset: 0 };
  }

  getWeatherForDateTime(targetDateTime) {
    const datetimeKey = targetDateTime.toISOString().slice(0, 19);
    
    if (this.weatherData.has(datetimeKey)) {
      return this.weatherData.get(datetimeKey);
    }
    
    return this.findClosestWeatherData(targetDateTime);
  }

  findClosestWeatherData(targetDateTime) {
    let closestKey = null;
    let closestDiff = Infinity;
    
    const targetTime = targetDateTime.getTime();
    
    for (const [key, data] of this.weatherData.entries()) {
      const dataTime = new Date(key).getTime();
      const diff = Math.abs(dataTime - targetTime);
      
      if (diff < closestDiff && diff < 60000) {
        closestDiff = diff;
        closestKey = key;
      }
    }
    
    if (closestKey) {
      const data = this.weatherData.get(closestKey);
      return {
        ...data,
        source: `historical_1min_interpolated_uk_${this.cityId}`,
        time_diff_seconds: Math.round(closestDiff / 1000)
      };
    }
    
    throw new Error(`No weather data found near ${targetDateTime.toISOString()}`);
  }

  mapConditionToSimulation(conditions) {
    const conditionLower = conditions.toLowerCase();
    
    if (conditionLower.includes('rain')) return 'rainy';
    if (conditionLower.includes('snow')) return 'snowy';
    if (conditionLower.includes('storm') || conditionLower.includes('thunder')) return 'stormy';
    if (conditionLower.includes('clear') || conditionLower.includes('sunny')) return 'sunny';
    if (conditionLower.includes('cloud') || conditionLower.includes('overcast')) return 'cloudy';
    if (conditionLower.includes('partly')) return 'partly_cloudy';
    
    return 'partly_cloudy';
  }

  estimatePressure(weatherData) {
    let basePressure = 1013.25;
    
    if (weatherData.conditions.toLowerCase().includes('rain')) {
      basePressure -= 10;
    }
    if (weatherData.conditions.toLowerCase().includes('storm')) {
      basePressure -= 20;
    }
    if (weatherData.conditions.toLowerCase().includes('clear')) {
      basePressure += 5;
    }
    
    return Math.round(basePressure * 10) / 10;
  }

  generateFallbackWeather(currentTime) {
    const hour = currentTime.getHours();
    const season = getSeason(currentTime);
    
    const timeOfDayFactor = Math.sin((hour - 6) * Math.PI / 12);
    const seasonalTemp = getSeasonalTemp(season);
    const baseTemp = seasonalTemp + (timeOfDayFactor * 8);
    
    // Apply city variations to fallback weather too
    const cityVariations = this.getCityWeatherVariations();
    
    const temperature = baseTemp + cityVariations.tempOffset + (Math.random() - 0.5) * 4;
    const humidity = 60 + cityVariations.humidityOffset + (1 - timeOfDayFactor) * 25 + (Math.random() - 0.5) * 20;
    const windSpeed = Math.max(0, 5 + cityVariations.windOffset + (Math.random() - 0.5) * 15);
    const condition = this.determineCondition(temperature, humidity, windSpeed, season);
    const pressure = 1013 + (Math.random() - 0.5) * 40;
    
    return {
      temperature: Math.round(temperature * 10) / 10,
      humidity: Math.max(0, Math.min(100, Math.round(humidity))),
      windSpeed: Math.round(windSpeed * 10) / 10,
      condition: condition,
      pressure: Math.round(pressure * 10) / 10,
      source: `fallback_generated_uk_${this.cityId}`,
      simulation_time: currentTime.toISOString()
    };
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