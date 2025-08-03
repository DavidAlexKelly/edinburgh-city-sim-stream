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

// Get all active simulations - CORRECTED to match GetAllSimulationsInterface
app.get('/api/simulations', (req, res) => {
  try {
    const simulations = Array.from(activeSimulations.entries()).map(([id, sim]) => ({
      simulation_id: id, // Keep as string (matches interface)
      is_running: sim.isRunning,
      current_time: sim.currentTime.toISOString(),
      hour_counter: parseInt(sim.hourCounter), // Ensure Integer type
      seconds_per_hour: parseInt(sim.secondsPerHour), // Ensure Integer type
      foundry_integration: !!sim.foundryConfig,
      foundry_connected: !!sim.foundryToken,
      uptime_hours: parseInt(sim.hourCounter) // Ensure Integer type
    }));

    // Match GetAllSimulationsInterface exactly
    res.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      active_simulations: simulations.length, // Integer count
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

// Start a new simulation - CORRECTED to match StartSimulationResponseInterface
app.post('/api/simulations/start', async (req, res) => {
  try {
    const { 
      seconds_per_hour = 60, 
      simulation_name = `simulation_${Date.now()}`,
      simulation_id // Optional parameter from request body
    } = req.body;
    
    // Validate seconds_per_hour
    if (seconds_per_hour < 1 || seconds_per_hour > 3600) {
      return res.status(400).json({
        status: 'error',
        message: 'seconds_per_hour must be between 1 and 3600'
      });
    }
    
    // Generate simulation ID - use provided ID or generate new one
    const simId = simulation_id || `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Check if simulation already exists
    if (activeSimulations.has(simId)) {
      return res.status(409).json({
        status: 'error',
        message: `Simulation ${simId} already exists`
      });
    }
    
    console.log(`🚀 Starting new simulation: ${simId} (${seconds_per_hour}s per hour)`);
    
    // Create and initialize simulation
    const simulation = new CitySimulation(simId, seconds_per_hour);
    
    // Store simulation
    activeSimulations.set(simId, simulation);
    
    // Start the simulation
    simulation.start();
    
    // Match StartSimulationResponseInterface exactly
    res.status(201).json({
      status: 'success',
      simulation_id: simId,
      simulation_name: simulation_name,
      seconds_per_hour: parseInt(seconds_per_hour), // Ensure Integer
      simulation_status: 'running',
      foundry_integration: !!simulation.foundryConfig,
      message: 'Simulation started successfully',
      started_at: new Date().toISOString(),
      next_data_in_seconds: parseInt(seconds_per_hour), // Integer
      api_endpoints: {
        status: `/api/simulations/${simId}/status`,
        snapshot: `/api/simulations/${simId}/data`,
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

// Stop a specific simulation - CORRECTED to match StopSimulationResponseInterface
app.post('/api/simulations/:id/stop', (req, res) => {
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
    
    // Match StopSimulationResponseInterface exactly
    res.json({
      status: 'success',
      simulation_id: id,
      simulation_status: 'stopped',
      message: `Simulation ${id} stopped successfully`,
      stopped_at: new Date().toISOString(),
      final_hour: parseInt(finalHour) // Ensure Integer
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

// Stop all active simulations - Updated for consistency
app.post('/api/simulations/stop', (req, res) => {
  try {
    const stoppedSimulations = [];
    const errors = [];
    
    // Stop all active simulations
    for (const [id, simulation] of activeSimulations.entries()) {
      try {
        simulation.stop();
        stoppedSimulations.push({
          simulation_id: id,
          status: 'stopped',
          uptime_hours: parseInt(simulation.hourCounter) // Ensure Integer
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
    
    // Clear all simulations from memory
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

// Get simulation status - CORRECTED to match GetSimulationStatusInterface
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
    
    // Match GetSimulationStatusInterface exactly
    res.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      simulation_id: id,
      is_running: simulation.isRunning,
      current_time: simulation.currentTime.toISOString(),
      hour_counter: parseInt(simulation.hourCounter), // Ensure Integer
      seconds_per_hour: parseInt(simulation.secondsPerHour), // Ensure Integer
      foundry_integration: !!simulation.foundryConfig,
      foundry_connected: !!simulation.foundryToken,
      uptime_hours: parseInt(simulation.hourCounter), // Ensure Integer
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

// Get current simulation data - CORRECTED to match GetSimulationDataInterface
app.get('/api/simulations/:id/data', (req, res) => {
  try {
    const { id } = req.params;
    const simulation = activeSimulations.get(id);
    
    if (!simulation) {
      return res.status(404).json({
        status: 'error',
        message: `Simulation ${id} not found`
      });
    }
    
    const snapshot = simulation.getCurrentSnapshot();
    
    // Transform the snapshot to match GetSimulationDataInterface exactly
    const transformedSnapshot = {
      status: 'success',
      retrieved_at: new Date().toISOString(),
      server_time: new Date().toISOString(),
      simulation_id: id,
      timestamp: snapshot.timestamp || new Date().toISOString(),
      hour: parseInt(snapshot.hour || 0), // Ensure Integer
      is_running: simulation.isRunning,
      weather: {
        temperature: parseFloat(snapshot.weather?.temperature || 15.0), // Ensure Double
        humidity: parseInt(snapshot.weather?.humidity || 65), // Ensure Integer
        windSpeed: parseFloat(snapshot.weather?.windSpeed || 5.0), // Ensure Double
        condition: snapshot.weather?.condition || 'clear',
        pressure: parseFloat(snapshot.weather?.pressure || 1013.25) // Ensure Double
      },
      events: {
        active_count: parseInt(snapshot.events?.active_count || 0), // Ensure Integer
        scheduled_count: parseInt(snapshot.events?.scheduled_count || 0), // Ensure Integer
        completed_count: parseInt(snapshot.events?.completed_count || 0), // Ensure Integer
        total_count: parseInt(snapshot.events?.total_count || 0), // Ensure Integer
        events: (snapshot.events?.events || []).map(event => ({
          id: parseInt(event.id || 0), // Ensure Integer
          type: event.type || 'unknown',
          name: event.name || 'Unnamed Event',
          description: event.description || '',
          datazones: event.datazones || [],
          impact_factor: parseFloat(event.impact_factor || 1.0), // Ensure Double
          start_hour: parseInt(event.start_hour || 0), // Ensure Integer
          end_hour: parseInt(event.end_hour || 0), // Ensure Integer
          duration_hours: parseInt(event.duration_hours || 0), // Ensure Integer
          scheduled_start_time: event.scheduled_start_time || '',
          actual_start_time: event.actual_start_time || '', // Empty string instead of null
          actual_end_time: event.actual_end_time || '', // Empty string instead of null
          status: event.status || 'unknown',
          hours_until_start: parseInt(event.hours_until_start ?? -1), // -1 instead of null
          hours_remaining: parseInt(event.hours_remaining ?? -1) // -1 instead of null
        }))
      },
      traffic: {
        congestion_level: parseFloat(snapshot.traffic?.congestion_level || 0), // Ensure Double
        average_speed: parseFloat(snapshot.traffic?.average_speed || 0), // Ensure Double
        total_vehicles: parseInt(snapshot.traffic?.total_vehicles || 0), // Ensure Integer
        peak_hour: snapshot.traffic?.peak_hour || false,
        weather_impact: parseFloat(snapshot.traffic?.weather_impact || 1.0), // Ensure Double
        events_impact: parseFloat(snapshot.traffic?.events_impact || 1.0), // Ensure Double
        datazones: (snapshot.traffic?.datazones || []).map(zone => ({
          datazone_code: zone.datazone_code || '',
          datazone_congestion: parseFloat(zone.datazone_congestion || 0), // Ensure Double
          street_congestion: (zone.street_congestion || []).map(street => ({
            street_id: parseInt(street.street_id || 0), // Ensure Integer
            congestion_level: parseFloat(street.congestion_level || 0) // Ensure Double
          })),
          area_type: zone.area_type || 'unknown',
          congestion_trend: parseFloat(zone.congestion_trend || 0), // Ensure Double
          estimated_vehicles: parseInt(zone.estimated_vehicles || 0), // Ensure Integer
          average_speed: parseFloat(zone.average_speed || 0) // Ensure Double
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
        retry_after: 10
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

// Update simulation time compression - CORRECTED to match UpdateTimeCompressionResponseInterface
app.put('/api/simulations/:id/time-compression', (req, res) => {
  try {
    const { id } = req.params;
    const { seconds_per_hour } = req.body;
    
    if (!seconds_per_hour || seconds_per_hour < 1 || seconds_per_hour > 3600) {
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
    simulation.updateTimeCompression(seconds_per_hour);
    
    // Match UpdateTimeCompressionResponseInterface exactly
    res.json({
      status: 'success',
      simulation_id: id,
      seconds_per_hour: parseInt(seconds_per_hour), // Ensure Integer
      previous_seconds_per_hour: parseInt(oldCompression), // Ensure Integer
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
  console.log(`🕐 Ready to start simulations!`);
});