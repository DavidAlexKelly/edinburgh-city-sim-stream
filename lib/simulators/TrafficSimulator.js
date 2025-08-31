import { loadCityDatazones } from '../utils/dataLoaders.js';
import { ROAD_TYPE_WEIGHTS, PEAK_HOUR_MULTIPLIERS, AREA_MULTIPLIERS, WEEKEND_MULTIPLIERS } from '../utils/constants.js';

export class TrafficSimulator {
  constructor(cityId = 'edinburgh') {
    this.cityId = cityId;
    this.datazones = [];
    this.previousHourData = null;
    this.isInitialized = false;
    this.roadTypeWeights = ROAD_TYPE_WEIGHTS;
    this.peakHourMultipliers = PEAK_HOUR_MULTIPLIERS;
  }

  async initializeWithDatazones(datazoneData) {
    if (this.isInitialized) return;
    
    console.log(`🚗 Initializing ${this.cityId} traffic system with ${datazoneData.length} datazones...`);
    
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
    console.log(`✅ ${this.cityId} traffic system initialized. Average baseline congestion: ${this.getAverageBaseline().toFixed(1)}%`);
  }

  async simulateNextHour(currentTime, weather, events, previousTrafficData) {
    if (!this.isInitialized) {
      throw new Error(`${this.cityId} traffic simulator not initialized`);
    }

    const hour = currentTime.getHours();
    const dayOfWeek = currentTime.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    
    const factors = this.calculateTrafficFactors(hour, dayOfWeek, weather, events);
    
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
          zoneCongestion = (zoneCongestion * 0.7) + (prevZone.datazone_congestion * momentum);
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

  calculateTrafficFactors(hour, dayOfWeek, weather, events) {
    let timeMultiplier = 1.0;
    if (hour >= 7 && hour <= 9) timeMultiplier = 1.6;
    else if (hour >= 16 && hour <= 18) timeMultiplier = 1.8;
    else if (hour >= 22 || hour <= 5) timeMultiplier = 0.3;
    else if (hour >= 10 && hour <= 15) timeMultiplier = 0.8;
    
    let weatherMultiplier = 1.0;
    if (weather.condition === 'rainy') weatherMultiplier = 1.4;
    else if (weather.condition === 'snowy') weatherMultiplier = 2.2;
    else if (weather.condition === 'stormy') weatherMultiplier = 1.8;
    else if (weather.condition === 'sunny') weatherMultiplier = 0.95;
    
    if (weather.windSpeed > 30) weatherMultiplier *= 1.2;
    
    let eventsMultiplier = 1.0;
    if (events && events.length > 0) {
      for (const event of events) {
        eventsMultiplier += (event.impact_factor || 0.2) * 0.1;
      }
    }
    
    const zoneEventImpacts = this.calculateZoneEventImpacts(events);
    
    return {
      timeMultiplier,
      weatherMultiplier,
      eventsMultiplier,
      zoneEventImpacts
    };
  }

  calculateZoneEventImpacts(events) {
    const zoneImpacts = new Map();
    if (!events || events.length === 0) {
      return zoneImpacts;
    }
    
    for (const event of events) {
      // Use specific datazone codes from the event
      const affectedDatazones = event.affected_datazones || [];
      
      for (let i = 0; i < affectedDatazones.length; i++) {
        const datazoneCode = affectedDatazones[i];
        
        if (i === 0) {
          // Primary zone (event location) - full impact
          const primaryImpact = 1.0 + (event.impact_factor || 0.3);
          zoneImpacts.set(datazoneCode, Math.max(zoneImpacts.get(datazoneCode) || 1.0, primaryImpact));
        } else {
          // Secondary zones - reduced impact based on distance from event
          const distanceReduction = Math.max(0.3, 1.0 - (i * 0.1));
          const secondaryImpact = 1.0 + ((event.impact_factor || 0.3) * distanceReduction);
          zoneImpacts.set(datazoneCode, Math.max(zoneImpacts.get(datazoneCode) || 1.0, secondaryImpact));
        }
      }
      
      console.log(`🚗 ${this.cityId} event "${event.name}" affecting ${affectedDatazones.length} specific datazones with ${event.impact_factor}x impact`);
    }
    
    return zoneImpacts;
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

  getPeakMultiplierForArea(areaType, dominantRoadType) {
    const areaMultiplier = AREA_MULTIPLIERS[areaType] || 1.3;
    const roadMultiplier = this.peakHourMultipliers[dominantRoadType] || 1.2;
    return (roadMultiplier + areaMultiplier) / 2;
  }

  getWeekendMultiplierForArea(areaType) {
    return WEEKEND_MULTIPLIERS[areaType] || 0.8;
  }
}