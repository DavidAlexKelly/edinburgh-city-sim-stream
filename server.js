// server.js - Main server for Railway deployment with WebSocket + REST API
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { handleWebSocket } from './lib/websocket.js';
import { activeSimulations, CitySimulation } from './lib/simulation.js';

const app = express();
const server = createServer(app);

// WebSocket Server
const wss = new WebSocketServer({ 
  server,
  path: '/ws' // Explicit WebSocket path
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check and API info
app.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const wsUrl = baseUrl.replace('http', 'ws') + '/ws';
  
  res.json({
    service: 'Edinburgh City Simulation API',
    status: 'running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    active_simulations: activeSimulations.size,
    endpoints: {
      websocket: wsUrl,
      rest_api: {
        base_url: baseUrl,
        endpoints: {
          list_simulations: 'GET /api/simulations',
          start_simulation: 'POST /api/simulations/start',
          get_simulation: 'GET /api/simulations/{id}',
          stop_simulation: 'POST /api/simulations/{id}/stop',
          get_snapshot: 'GET /api/simulations/{id}/snapshot',
          update_time_compression: 'PUT /api/simulations/{id}/time-compression'
        }
      }
    },
    foundry_integration: {
      supported: true,
      rest_api_ready: true,
      push_streams_supported: true
    }
  });
});

// FOUNDRY-COMPATIBLE REST API ROUTES

// List all active simulations
app.get('/api/simulations', (req, res) => {
  try {
    const simulations = Array.from(activeSimulations.entries()).map(([id, sim]) => ({
      simulation_id: id,
      is_running: sim.isRunning,
      current_time: sim.currentTime?.toISOString(),
      hour_counter: sim.hourCounter,
      seconds_per_hour: sim.secondsPerHour,
      foundry_integration: !!sim.foundryConfig
    }));
    
    res.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      active_simulations: simulations.length,
      simulations: simulations,
      message: 'Edinburgh City Simulation API - Foundry Compatible'
    });
  } catch (error) {
    console.error('List simulations error:', error);
    res.status(500).json({ 
      status: 'error',
      error: 'Failed to list simulations', 
      message: error.message 
    });
  }
});

// Start a new simulation (Foundry compatible)
app.post('/api/simulations/start', async (req, res) => {
  try {
    const { 
      seconds_per_hour = 10, 
      foundry_config,
      simulation_name = 'Edinburgh Simulation'
    } = req.body || {};
    
    // Validate time compression parameter
    if (!Number.isInteger(seconds_per_hour) || seconds_per_hour < 1 || seconds_per_hour > 3600) {
      return res.status(400).json({
        status: 'error',
        error: 'Invalid time compression',
        message: 'seconds_per_hour must be an integer between 1 and 3600'
      });
    }
    
    // Create REST-only WebSocket mock for Foundry integration
    const foundryWS = {
      send: (data) => {
        try {
          const parsed = JSON.parse(data);
          console.log(`[Foundry Integration] ${parsed.type}:`, {
            sim_id: parsed.simulation_id,
            hour: parsed.hour,
            timestamp: parsed.timestamp
          });
        } catch (e) {
          console.log('[Foundry Integration] Data sent:', data.substring(0, 100));
        }
      },
      readyState: 1 // WebSocket.OPEN
    };
    
    // Generate unique simulation ID
    const simulationId = Date.now() + Math.floor(Math.random() * 10000);
    
    // Create simulation instance
    const simulation = new CitySimulation(
      foundryWS, 
      simulationId, 
      seconds_per_hour, 
      foundry_config
    );
    
    // Store and start simulation
    activeSimulations.set(simulationId, simulation);
    simulation.start();
    
    console.log(`🚀 Started simulation ${simulationId} for Foundry integration`);
    
    res.status(201).json({
      status: 'success',
      simulation_id: simulationId,
      simulation_name: simulation_name,
      seconds_per_hour: seconds_per_hour,
      simulation_status: 'started',
      foundry_integration: !!foundry_config,
      message: `Simulation started - data updates every ${seconds_per_hour} seconds`,
      started_at: new Date().toISOString(),
      next_data_in_seconds: seconds_per_hour
    });
    
  } catch (error) {
    console.error('Start simulation error:', error);
    res.status(500).json({ 
      status: 'error',
      error: 'Failed to start simulation', 
      message: error.message 
    });
  }
});

// Get specific simulation status
app.get('/api/simulations/:id', (req, res) => {
  try {
    const simId = parseInt(req.params.id);
    
    if (isNaN(simId)) {
      return res.status(400).json({ 
        status: 'error',
        error: 'Invalid simulation ID format' 
      });
    }
    
    const simulation = activeSimulations.get(simId);
    if (!simulation) {
      return res.status(404).json({ 
        status: 'error',
        error: 'Simulation not found',
        simulation_id: simId 
      });
    }
    
    res.json({
      status: 'success',
      ...simulation.getSimulationStatus()
    });
    
  } catch (error) {
    console.error('Get simulation error:', error);
    res.status(500).json({ 
      status: 'error',
      error: 'Failed to get simulation status', 
      message: error.message 
    });
  }
});

// Stop simulation
app.post('/api/simulations/:id/stop', (req, res) => {
  try {
    const simId = parseInt(req.params.id);
    
    if (isNaN(simId)) {
      return res.status(400).json({ 
        status: 'error',
        error: 'Invalid simulation ID format' 
      });
    }
    
    const simulation = activeSimulations.get(simId);
    if (!simulation) {
      return res.status(404).json({ 
        status: 'error',
        error: 'Simulation not found',
        simulation_id: simId 
      });
    }
    
    simulation.stop();
    activeSimulations.delete(simId);
    
    console.log(`🛑 Stopped simulation ${simId}`);
    
    res.json({
      status: 'success',
      simulation_id: simId,
      simulation_status: 'stopped',
      message: 'Simulation stopped successfully',
      stopped_at: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Stop simulation error:', error);
    res.status(500).json({ 
      status: 'error',
      error: 'Failed to stop simulation', 
      message: error.message 
    });
  }
});

// Get current simulation snapshot (perfect for Foundry polling)
app.get('/api/simulations/:id/snapshot', (req, res) => {
  try {
    const simId = parseInt(req.params.id);
    
    if (isNaN(simId)) {
      return res.status(400).json({ 
        status: 'error',
        error: 'Invalid simulation ID format' 
      });
    }
    
    const simulation = activeSimulations.get(simId);
    if (!simulation) {
      return res.status(404).json({ 
        status: 'error',
        error: 'Simulation not found',
        simulation_id: simId 
      });
    }
    
    const snapshot = simulation.getCurrentSnapshot();
    
    res.json({
      status: 'success',
      retrieved_at: new Date().toISOString(),
      ...snapshot
    });
    
  } catch (error) {
    console.error('Get snapshot error:', error);
    res.status(500).json({ 
      status: 'error',
      error: 'Failed to get simulation snapshot', 
      message: error.message 
    });
  }
});

// Update time compression
app.put('/api/simulations/:id/time-compression', (req, res) => {
  try {
    const simId = parseInt(req.params.id);
    
    if (isNaN(simId)) {
      return res.status(400).json({ 
        status: 'error',
        error: 'Invalid simulation ID format' 
      });
    }
    
    const simulation = activeSimulations.get(simId);
    if (!simulation) {
      return res.status(404).json({ 
        status: 'error',
        error: 'Simulation not found',
        simulation_id: simId 
      });
    }
    
    const { seconds_per_hour } = req.body || {};
    
    if (!Number.isInteger(seconds_per_hour) || seconds_per_hour < 1 || seconds_per_hour > 3600) {
      return res.status(400).json({
        status: 'error',
        error: 'Invalid time compression',
        message: 'seconds_per_hour must be an integer between 1 and 3600'
      });
    }
    
    simulation.updateTimeCompression(seconds_per_hour);
    
    console.log(`⚡ Updated simulation ${simId} time compression to ${seconds_per_hour}s/hour`);
    
    res.json({
      status: 'success',
      simulation_id: simId,
      seconds_per_hour: seconds_per_hour,
      simulation_status: 'time_compression_updated',
      message: `Time compression updated to ${seconds_per_hour} seconds per game hour`,
      updated_at: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Update time compression error:', error);
    res.status(500).json({ 
      status: 'error',
      error: 'Failed to update time compression', 
      message: error.message 
    });
  }
});

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  console.log(`🔌 New WebSocket connection from ${clientIP}`);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connection_established',
    message: 'Connected to Edinburgh City Simulation WebSocket',
    server_time: new Date().toISOString(),
    instructions: {
      start_simulation: { action: 'startSimulation', seconds_per_hour: 10 },
      stop_simulation: { action: 'stopSimulation' },
      update_time: { action: 'updateTimeCompression', seconds_per_hour: 30 }
    }
  }));
  
  handleWebSocket(ws, req);
  
  ws.on('close', () => {
    console.log(`🔌 WebSocket connection closed from ${clientIP}`);
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Express error:', error);
  res.status(500).json({
    status: 'error',
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
    available_endpoints: [
      'GET /',
      'GET /api/simulations',
      'POST /api/simulations/start',
      'GET /api/simulations/{id}',
      'POST /api/simulations/{id}/stop',
      'GET /api/simulations/{id}/snapshot',
      'PUT /api/simulations/{id}/time-compression'
    ]
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Edinburgh City Simulation API running on port ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`🌐 REST API: http://localhost:${PORT}/api/simulations`);
  console.log(`🏗️  Foundry Integration: Ready`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  
  // Stop all active simulations
  for (const [id, simulation] of activeSimulations.entries()) {
    simulation.stop();
    console.log(`Stopped simulation ${id}`);
  }
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down...');
  process.kill(process.pid, 'SIGTERM');
});