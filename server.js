// server.js - Edinburgh City Simulation API (Interface Compliant)
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { CitySimulation, activeSimulations } from './lib/simulation.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    active_simulations: activeSimulations.size,
    foundry_configured: !!(process.env.FOUNDRY_URL && process.env.FOUNDRY_CLIENT_ID),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Get all active simulations
app.get('/api/simulations', (req, res) => {
  try {
    const simulations = Array.from(activeSimulations.entries()).map(([id, sim]) => ({
      simulation_id: id,
      is_running: sim.isRunning,
      current_time: sim.currentTime.toISOString(),
      hour_counter: parseInt(sim.hourCounter),
      seconds_per_hour: parseInt(sim.secondsPerHour),
      foundry_integration: !!sim.foundryConfig,
      foundry_connected: !!sim.foundryToken,
      uptime_hours: parseInt(sim.hourCounter),
      is_initialized: sim.isInitialized,
      has_ready_data: !!sim.readyHourData,
      is_generating: sim.isGenerating
    }));

    res.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      active_simulations: simulations.length,
      simulations: simulations
    });
  } catch (error) {
    console.error('Error getting simulations:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve simulations',
      error: error.message
    });
  }
});

// Start a new simulation
app.get('/api/simulations/start', async (req, res) => {
  try {
    const { 
      seconds_per_hour = 60, 
      simulation_name = `simulation_${Date.now()}`,
      simulation_id
    } = req.query;
    
    const secondsPerHour = parseInt(seconds_per_hour) || 60;
    
    if (secondsPerHour < 1 || secondsPerHour > 3600) {
      return res.status(400).json({
        status: 'error',
        message: 'seconds_per_hour must be between 1 and 3600'
      });
    }
    
    const simId = simulation_id || `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    if (activeSimulations.has(simId)) {
      return res.status(409).json({
        status: 'error',
        message: `Simulation ${simId} already exists`
      });
    }
    
    console.log(`🚀 Starting new simulation: ${simId} (${secondsPerHour}s per hour)`);
    
    const simulation = new CitySimulation(simId, secondsPerHour);
    activeSimulations.set(simId, simulation);
    
    // Start the simulation (this will initialize and generate first hour)
    await simulation.start();
    
    res.status(201).json({
      status: 'success',
      simulation_id: simId,
      simulation_name: simulation_name,
      seconds_per_hour: String(secondsPerHour), 
      simulation_status: 'running',
      foundry_integration: !!simulation.foundryConfig,
      message: 'Simulation started successfully',
      started_at: new Date().toISOString(),
      api_endpoints: {
        status: `/api/simulations/${simId}/status`,
        data: `/api/simulations/${simId}/data`,
        stop: `/api/simulations/${simId}/stop`
      }
    });
    
  } catch (error) {
    console.error('Error starting simulation:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to start simulation',
      error: error.message
    });
  }
});

// Get current simulation data - Returns pre-generated data instantly and triggers next generation
app.get('/api/simulations/:id/data', async (req, res) => {
  try {
    const { id } = req.params;
    const simulation = activeSimulations.get(id);
    
    if (!simulation) {
      return res.status(404).json({
        status: 'error',
        message: `Simulation ${id} not found`
      });
    }
    
    // THIS IS THE KEY CHANGE: Get pre-generated data instantly and trigger next generation
    const snapshot = await simulation.getDataAndAdvance();
    
    // Transform the snapshot to match GetSimulationDataInterface exactly
    const transformedSnapshot = {
      status: 'success',
      retrieved_at: new Date().toISOString(),
      server_time: new Date().toISOString(),
      simulation_id: id,
      timestamp: snapshot.timestamp || new Date().toISOString(),
      hour: parseInt(snapshot.hour || 0),
      is_running: simulation.isRunning,
      weather: {
        temperature: parseFloat(snapshot.weather?.temperature || 15.0),
        humidity: parseInt(snapshot.weather?.humidity || 65),
        windSpeed: parseFloat(snapshot.weather?.windSpeed || 5.0),
        condition: snapshot.weather?.condition || 'clear',
        pressure: parseFloat(snapshot.weather?.pressure || 1013.25)
      },
      events: {
        active_count: parseInt(snapshot.events?.active_count || 0),
        scheduled_count: parseInt(snapshot.events?.scheduled_count || 0),
        completed_count: parseInt(snapshot.events?.completed_count || 0),
        events: (snapshot.events?.events || []).map(event => ({
          id: parseInt(event.id || 0),
          event_type: event.type || 'unknown',
          name: event.name || 'Unnamed Event',
          description: event.description || '',
          datazones: event.datazones || [],
          impact_factor: parseFloat(event.impact_factor || 1.0),
          start_hour: parseInt(event.start_hour || 0),
          end_hour: parseInt(event.end_hour || 0),
          duration_hours: parseInt(event.duration_hours || 0),
          scheduled_start_time: event.scheduled_start_time || '',
          actual_start_time: event.actual_start_time || '',
          actual_end_time: event.actual_end_time || '',
          status: event.status || 'unknown',
          hours_until_start: parseInt(event.hours_until_start ?? -1),
          hours_remaining: parseInt(event.hours_remaining ?? -1)
        }))
      },
      traffic: {
        congestion_level: parseFloat(snapshot.traffic?.congestion_level || 0),
        average_speed: parseFloat(snapshot.traffic?.average_speed || 0),
        total_vehicles: parseInt(snapshot.traffic?.total_vehicles || 0),
        peak_hour: snapshot.traffic?.peak_hour || false,
        weather_impact: parseFloat(snapshot.traffic?.weather_impact || 1.0),
        events_impact: parseFloat(snapshot.traffic?.events_impact || 1.0),
        datazones: (snapshot.traffic?.datazones || []).map(zone => ({
          datazone_code: zone.datazone_code || '',
          datazone_congestion: parseFloat(zone.datazone_congestion || 0),
          area_type: zone.area_type || 'unknown',
          congestion_trend: parseFloat(zone.congestion_trend || 0),
          estimated_vehicles: parseInt(zone.estimated_vehicles || 0),
          average_speed: parseFloat(zone.average_speed || 0)
        }))
      }
    };
    
    res.json(transformedSnapshot);
    
  } catch (error) {
    console.error(`Error getting simulation ${req.params.id} data:`, error);
    
    if (error.message && error.message.includes('No simulation data available yet')) {
      res.status(202).json({
        status: 'starting',
        message: 'Simulation is starting up, data will be available shortly',
        simulation_id: req.params.id,
        retry_after: 5
      });
    } else {
      res.status(500).json({
        status: 'error',
        message: 'Failed to get simulation data',
        error: error.message
      });
    }
  }
});

// Stop a specific simulation
app.get('/api/simulations/:id/stop', (req, res) => {
  try {
    const { id } = req.params;
    const simulation = activeSimulations.get(id);
    
    if (!simulation) {
      return res.status(404).json({
        status: 'error',
        message: `Simulation ${id} not found`
      });
    }
    
    const finalHour = simulation.hourCounter;
    simulation.stop();
    activeSimulations.delete(id);
    
    console.log(`⏹️ Stopped simulation: ${id}`);
    
    res.json({
      status: 'success',
      simulation_id: id,
      simulation_status: 'stopped',
      message: `Simulation ${id} stopped successfully`,
      stopped_at: new Date().toISOString(),
      final_hour: parseInt(finalHour)
    });
    
  } catch (error) {
    console.error(`Error stopping simulation ${req.params.id}:`, error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to stop simulation',
      error: error.message
    });
  }
});

// Stop all active simulations
app.post('/api/simulations/stop', (req, res) => {
  try {
    const stoppedSimulations = [];
    const errors = [];
    
    for (const [id, simulation] of activeSimulations.entries()) {
      try {
        simulation.stop();
        stoppedSimulations.push({
          simulation_id: id,
          status: 'stopped',
          uptime_hours: parseInt(simulation.hourCounter)
        });
        console.log(`⏹️ Stopped simulation: ${id}`);
      } catch (error) {
        console.error(`Error stopping simulation ${id}:`, error);
        errors.push({
          simulation_id: id,
          error: error.message
        });
      }
    }
    
    activeSimulations.clear();
    
    const response = {
      status: stoppedSimulations.length > 0 ? 'success' : 'no_simulations',
      message: stoppedSimulations.length > 0 
        ? `Stopped ${stoppedSimulations.length} simulation(s)`
        : 'No active simulations to stop',
      stopped_count: stoppedSimulations.length,
      stopped_simulations: stoppedSimulations,
      stopped_at: new Date().toISOString()
    };
    
    if (errors.length > 0) {
      response.errors = errors;
      response.status = 'partial_success';
      response.message += ` (${errors.length} errors occurred)`;
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('Error stopping all simulations:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to stop simulations',
      error: error.message
    });
  }
});

// Get simulation status (does NOT advance simulation)
app.get('/api/simulations/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const simulation = activeSimulations.get(id);
    
    if (!simulation) {
      return res.status(404).json({
        status: 'error',
        message: `Simulation ${id} not found`
      });
    }
    
    res.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      simulation_id: id,
      is_running: simulation.isRunning,
      is_initialized: simulation.isInitialized,
      current_time: simulation.currentTime.toISOString(),
      hour_counter: parseInt(simulation.hourCounter),
      seconds_per_hour: parseInt(simulation.secondsPerHour),
      foundry_integration: !!simulation.foundryConfig,
      foundry_connected: !!simulation.foundryToken,
      uptime_hours: parseInt(simulation.hourCounter),
      has_ready_data: !!simulation.readyHourData,
      is_generating: simulation.isGenerating,
      created_at: simulation.currentTime ? 
        new Date(simulation.currentTime.getTime() - (simulation.hourCounter * 60 * 60 * 1000)).toISOString() 
        : new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`Error getting simulation ${req.params.id} status:`, error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to get simulation status',
      error: error.message
    });
  }
});

// Update simulation time compression
app.get('/api/simulations/:id/time-compression', (req, res) => {
  try {
    const { id } = req.params;
    const { seconds_per_hour } = req.query;
    
    const secondsPerHour = parseInt(seconds_per_hour);
    
    if (!secondsPerHour || secondsPerHour < 1 || secondsPerHour > 3600) {
      return res.status(400).json({
        status: 'error',
        message: 'seconds_per_hour must be between 1 and 3600'
      });
    }
    
    const simulation = activeSimulations.get(id);
    
    if (!simulation) {
      return res.status(404).json({
        status: 'error',
        message: `Simulation ${id} not found`
      });
    }
    
    const oldCompression = simulation.secondsPerHour;
    simulation.updateTimeCompression(secondsPerHour);
    
    res.json({
      status: 'success',
      simulation_id: id,
      seconds_per_hour: secondsPerHour,
      previous_seconds_per_hour: parseInt(oldCompression),
      simulation_status: simulation.isRunning ? 'running' : 'stopped',
      message: 'Time compression updated successfully',
      updated_at: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`Error updating simulation ${req.params.id} time compression:`, error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update time compression',
      error: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Graceful shutdown handler
process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, stopping all simulations...');
  
  for (const [id, simulation] of activeSimulations.entries()) {
    try {
      simulation.stop();
      console.log(`⏹️ Stopped simulation: ${id}`);
    } catch (error) {
      console.error(`Error stopping simulation ${id}:`, error);
    }
  }
  
  activeSimulations.clear();
  console.log('✅ All simulations stopped');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🔄 SIGINT received, stopping all simulations...');
  
  for (const [id, simulation] of activeSimulations.entries()) {
    try {
      simulation.stop();
      console.log(`⏹️ Stopped simulation: ${id}`);
    } catch (error) {
      console.error(`Error stopping simulation ${id}:`, error);
    }
  }
  
  activeSimulations.clear();
  console.log('✅ All simulations stopped');
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🌍 Edinburgh City Simulation API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`🎯 Foundry integration: ${process.env.FOUNDRY_URL ? 'Enabled' : 'Disabled'}`);
  console.log(`🕐 Ready to start simulations with instant data delivery!`);
});