import { loadCityEvents } from '../utils/dataLoaders.js';
import { calculateHoursUntilStart, calculateHoursRemaining, getDateKey } from '../utils/timeUtils.js';

export class EventsManager {
  constructor(cityId = 'edinburgh') {
    this.cityId = cityId;
    this.activeEvents = [];
    this.scheduledEvents = [];
    this.completedEvents = [];
    this.eventIdCounter = 1;
    this.cityEvents = null;
    this.isInitialized = false;
    
    this.eventGenerationChance = 0.1;
    this.minHoursInFuture = 48;
    this.maxHoursInFuture = 168;
    this.maxCompletedEventsToKeep = 50;
    
    this.maxEventsPerDay = 2;
    this.maxConcurrentEvents = 3;
    this.minimumEventGap = 4;
    
    this.dailyEventCounts = new Map();
    this.lastEventTime = null;
  }

  async initialize() {
    if (this.isInitialized) return;
    
    this.cityEvents = await loadCityEvents(this.cityId);
    this.isInitialized = true;
    console.log(`🎪 ${this.cityId} events manager initialized with ${this.cityEvents.length} event types`);
  }

  async generateInitialEvents(currentTime) {
    await this.initialize();
    
    const initialEventCount = 3 + Math.floor(Math.random() * 3);
    
    for (let i = 0; i < initialEventCount; i++) {
      this.generateRandomEvent(currentTime);
    }
    
    console.log(`📅 Generated ${this.scheduledEvents.length} initial ${this.cityId} events`);
  }

  processEventsForHour(currentTime, weatherData = null) {
    this.activateScheduledEvents(currentTime);
    this.moveExpiredEventsToCompleted(currentTime);
    this.cleanupOldCompletedEvents();
    this.cleanupDailyEventCounts(currentTime);
    
    if (this.canGenerateNewEvent(currentTime)) {
      if (Math.random() < this.eventGenerationChance) {
        this.generateRandomEvent(currentTime);
      }
    }
    
    return this.getAllEventsWithStatus(currentTime);
  }

  canGenerateNewEvent(currentTime) {
    const dateKey = getDateKey(currentTime);
    const todayEventCount = this.dailyEventCounts.get(dateKey) || 0;
    
    if (todayEventCount >= this.maxEventsPerDay) {
      return false;
    }
    
    if (this.activeEvents.length >= this.maxConcurrentEvents) {
      return false;
    }
    
    if (this.lastEventTime) {
      const hoursSinceLastEvent = (currentTime - this.lastEventTime) / (1000 * 60 * 60);
      if (hoursSinceLastEvent < this.minimumEventGap) {
        return false;
      }
    }
    
    return true;
  }

  generateRandomEvent(currentTime) {
    const randomEventTemplate = this.cityEvents[Math.floor(Math.random() * this.cityEvents.length)];
    
    const hoursInFuture = this.minHoursInFuture + 
      Math.floor(Math.random() * (this.maxHoursInFuture - this.minHoursInFuture));
    
    const targetDate = new Date(currentTime.getTime() + (hoursInFuture * 60 * 60 * 1000));
    const eventStartTime = new Date(targetDate);
    eventStartTime.setHours(randomEventTemplate.start_hour, 0, 0, 0);
    
    const event = {
      id: this.eventIdCounter++,
      type: randomEventTemplate.type,
      name: randomEventTemplate.name,
      description: randomEventTemplate.description,
      
      // City-specific datazone codes instead of generic zones
      affected_datazones: randomEventTemplate.affected_datazones || [],
      location_description: randomEventTemplate.location_description || '',
      
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
    
    const dateKey = getDateKey(currentTime);
    this.dailyEventCounts.set(dateKey, (this.dailyEventCounts.get(dateKey) || 0) + 1);
    this.lastEventTime = new Date(currentTime);

    const daysUntilEvent = Math.floor((eventStartTime - currentTime) / (24 * 60 * 60 * 1000));
    console.log(`📅 Scheduled ${this.cityId} ${event.type} "${event.name}" for ${daysUntilEvent} days from now at ${event.start_hour}:00 (${event.affected_datazones.length} datazones affected)`);
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

      console.log(`🎪 ${this.cityId} event started: ${event.type} "${event.name}" (${event.duration_hours}h, ${event.affected_datazones.length} datazones affected)`);
    }
  }

  moveExpiredEventsToCompleted(currentTime) {
    const expiredEvents = this.activeEvents.filter(event => {
      return event.actual_end_time && currentTime >= event.actual_end_time;
    });

    for (const event of expiredEvents) {
      event.status = 'completed';
      this.completedEvents.push(event);
      console.log(`✅ ${this.cityId} event completed: ${event.type} "${event.name}"`);
    }

    this.activeEvents = this.activeEvents.filter(event => !expiredEvents.includes(event));
  }

  cleanupOldCompletedEvents() {
    if (this.completedEvents.length > this.maxCompletedEventsToKeep) {
      const eventsToRemove = this.completedEvents.length - this.maxCompletedEventsToKeep;
      this.completedEvents.splice(0, eventsToRemove);
      console.log(`🧹 Cleaned up ${eventsToRemove} old ${this.cityId} events`);
    }
  }

  cleanupDailyEventCounts(currentTime) {
    const cutoffDate = new Date(currentTime.getTime() - (7 * 24 * 60 * 60 * 1000));
    const cutoffKey = getDateKey(cutoffDate);
    
    for (const [dateKey] of this.dailyEventCounts.entries()) {
      if (dateKey < cutoffKey) {
        this.dailyEventCounts.delete(dateKey);
      }
    }
  }

  getAllEventsWithStatus(currentTime) {
    const allEvents = [
      ...this.scheduledEvents.map(event => ({
        id: event.id,
        type: event.type,
        name: event.name,
        description: event.description,
        affected_datazones: event.affected_datazones,
        location_description: event.location_description,
        impact_factor: event.impact_factor,
        start_hour: event.start_hour,
        end_hour: event.end_hour,
        duration_hours: event.duration_hours,
        scheduled_start_time: event.scheduled_start_time.toISOString(),
        actual_start_time: null,
        actual_end_time: null,
        status: 'scheduled',
        hours_until_start: calculateHoursUntilStart(event, currentTime),
        hours_remaining: null
      })),
      ...this.activeEvents.map(event => ({
        id: event.id,
        type: event.type,
        name: event.name,
        description: event.description,
        affected_datazones: event.affected_datazones,
        location_description: event.location_description,
        impact_factor: event.impact_factor,
        start_hour: event.start_hour,
        end_hour: event.end_hour,
        duration_hours: event.duration_hours,
        scheduled_start_time: event.scheduled_start_time.toISOString(),
        actual_start_time: event.actual_start_time ? event.actual_start_time.toISOString() : null,
        actual_end_time: event.actual_end_time ? event.actual_end_time.toISOString() : null,
        status: 'active',
        hours_until_start: 0,
        hours_remaining: calculateHoursRemaining(event, currentTime)
      })),
      ...this.completedEvents.map(event => ({
        id: event.id,
        type: event.type,
        name: event.name,
        description: event.description,
        affected_datazones: event.affected_datazones,
        location_description: event.location_description,
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

  getActiveEvents(currentTime) {
    return this.activeEvents;
  }

  generateMoreEvents(currentTime) {
    if (this.scheduledEvents.length < 3) {
      const newEventCount = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < newEventCount; i++) {
        this.generateRandomEvent(currentTime);
      }
      console.log(`🎪 Force generated ${newEventCount} additional ${this.cityId} events`);
    }
  }

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