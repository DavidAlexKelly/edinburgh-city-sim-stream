// server.js - Edinburgh City Simulation API with integrated Foundry configuration
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { CitySimulation, activeSimulations } from './lib/simulation.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ 
  server,
  path: '/ws'
});

// Validate Foundry configuration on startup (optional)
function validateFoundryConfig() {
  const foundryUrl = process.env.FOUNDRY_URL;
  const clientId = process.env.FOUNDRY_CLIENT_ID;
  const clientSecret = process.env.FOUNDRY_CLIENT_SECRET;
  const streamRid = process.env.FOUNDRY_STREAM_RID;
  
  if (foundryUrl && clientId && clientSecret && streamRid) {
    console.log('✅ Foundry configuration detected - integration enabled');
    
    // Validate URL format
    if (!foundryUrl.startsWith('https://')) {
      console.error('❌ FOUNDRY_URL must use HTTPS');
      return false;
    }
    
    // Validate RID format
    if (!streamRid.startsWith('ri.foundry.main.stream.')) {
      console.error('❌ Invalid FOUNDRY_STREAM_RID format');
      return false;
    }
    
    return true;
  } else {
    console.log('⚠️ Foundry configuration incomplete - running without Foundry integration');
    console.log('💡 To enable Foundry: Set FOUNDRY_URL, FOUNDRY_CLIENT_ID, FOUNDRY_CLIENT_SECRET, FOUNDRY_STREAM_RID');
    return false;
  }
}

// Check Foundry config on startup
const foundryEnabled = validateFoundryConfig();

// WebSocket connection handling
wss.on('connection', (ws, request) => {
  console.log('🔌 New WebSocket connection established');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('📨 Received WebSocket message:', data.type);
      
      // Handle different message types if needed
      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          break;
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket connection closed');
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

// =============================================================================
// API ROUTES
// =============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    foundry_integration: foundryEnabled,
    active_simulations: activeSimulations.size
  });
});

// Get all simulations
app.get('/api/simulations', (req, res) => {
  try {
    const simulations = Array.from(activeSimulations.values()).map(sim => ({
      simulation_id: sim.id,
      is_running: sim.isRunning,
      current_time: sim.currentTime.toISOString(),
      hour_counter: sim.hourCounter,
      seconds_per_hour: sim.secondsPerHour,
      foundry_integration: !!sim.foundryConfig,
      foundry_connected: !!sim.foundryToken,
      uptime_hours: sim.hourCounter
    }));
    
    res.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      active_simulations: simulations.length,
      simulations: simulations
    });
  } catch (error) {
    console.error('❌ Error getting simulations:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve simulations',
      error: error.message
    });
  }
});

// Start a new simulation - SIMPLIFIED (no foundry_config parameter)
app.post('/api/simulations/start', (req, res) => {
  try {
    const { seconds_per_hour = 10, simulation_name } = req.body;
    
    // Validate input
    if (seconds_per_hour < 1 || seconds_per_hour > 3600) {
      return res.status(400).json({
        status: 'error',
        message: 'seconds_per_hour must be between 1 and 3600'
      });
    }
    
    // Generate unique simulation ID
    const simulationId = `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Find available WebSocket connection
    const availableWS = Array.from(wss.clients).find(ws => ws.readyState === 1);
    
    if (!availableWS) {
      return res.status(503).json({
        status: 'error',
        message: 'No WebSocket connections available'
      });
    }
    
    // Create simulation (Foundry config loaded automatically from environment)
    const simulation = new CitySimulation(
      availableWS,
      simulationId,
      seconds_per_hour
      // No foundry_config parameter - handled internally
    );
    
    // Store simulation
    activeSimulations.set(simulationId, simulation);
    
    // Start simulation
    simulation.start();
    
    const response = {
      status: 'success',
      simulation_id: simulationId,
      simulation_name: simulation_name || `Edinburgh Simulation ${simulationId}`,
      seconds_per_hour: seconds_per_hour,
      simulation_status: 'starting',
      foundry_integration: !!simulation.foundryConfig,
      message: 'Simulation started successfully',
      started_at: new Date().toISOString(),
      next_data_in_seconds: seconds_per_hour,
      api_endpoints: {
        status: `/api/simulations/${simulationId}/status`,
        snapshot: `/api/simulations/${simulationId}/data`,
        stop: `/api/simulations/${simulationId}/stop`
      }
    };
    
    console.log(`🚀 Started simulation ${simulationId} with ${seconds_per_hour}s per hour`);
    res.status(201).json(response);
    
  } catch (error) {
    console.error('❌ Error starting simulation:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to start simulation',
      error: error.message
    });
  }
});

// Get simulation status
app.get('/api/simulations/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const simulation = activeSimulations.get(id);
    
    if (!simulation) {
      return res.status(404).json({
        status: 'error',
        message: 'Simulation not found'
      });
    }
    
    const status = simulation.getSimulationStatus();
    res.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      ...status
    });
    
  } catch (error) {
    console.error('❌ Error getting simulation status:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to get simulation status',
      error: error.message
    });
  }
});

// Get current simulation data snapshot
app.get('/api/simulations/:id/data', (req, res) => {
  try {
    const { id } = req.params;
    const simulation = activeSimulations.get(id);
    
    if (!simulation) {
      return res.status(404).json({
        status: 'error',
        message: 'Simulation not found'
      });
    }
    
    const snapshot = simulation.getCurrentSnapshot();
    res.json(snapshot);
    
  } catch (error) {
    console.error('❌ Error getting simulation data:', error);
    
    if (error.message.includes('No simulation data available yet')) {
      res.status(202).json({
        status: 'starting',
        message: 'Simulation is starting up, please try again in a few seconds',
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

// Stop simulation
app.post('/api/simulations/:id/stop', (req, res) => {
  try {
    const { id } = req.params;
    const simulation = activeSimulations.get(id);
    
    if (!simulation) {
      return res.status(404).json({
        status: 'error',
        message: 'Simulation not found'
      });
    }
    
    const finalHour = simulation.hourCounter;
    simulation.stop();
    activeSimulations.delete(id);
    
    res.json({
      status: 'success',
      simulation_id: id,
      simulation_status: 'stopped',
      message: 'Simulation stopped successfully',
      stopped_at: new Date().toISOString(),
      final_hour: finalHour
    });
    
    console.log(`⏹️ Stopped simulation ${id} at hour ${finalHour}`);
    
  } catch (error) {
    console.error('❌ Error stopping simulation:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to stop simulation',
      error: error.message
    });
  }
});

// Update time compression
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
        message: 'Simulation not found'
      });
    }
    
    const previousSecondsPerHour = simulation.secondsPerHour;
    simulation.updateTimeCompression(seconds_per_hour);
    
    res.json({
      status: 'success',
      simulation_id: id,
      seconds_per_hour: seconds_per_hour,
      previous_seconds_per_hour: previousSecondsPerHour,
      simulation_status: simulation.isRunning ? 'running' : 'stopped',
      message: 'Time compression updated successfully',
      updated_at: new Date().toISOString()
    });
    
    console.log(`⏰ Updated simulation ${id} time compression: ${previousSecondsPerHour}s → ${seconds_per_hour}s per hour`);
    
  } catch (error) {
    console.error('❌ Error updating time compression:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update time compression',
      error: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Endpoint not found'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  
  // Stop all active simulations
  for (const [id, simulation] of activeSimulations.entries()) {
    console.log(`⏹️ Stopping simulation ${id}...`);
    simulation.stop();
  }
  
  // Close WebSocket server
  wss.close(() => {
    console.log('🔌 WebSocket server closed');
  });
  
  // Close HTTP server
  server.close(() => {
    console.log('🌐 HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  process.emit('SIGTERM');
});

// Start server
server.listen(PORT, () => {
  console.log(`🌐 Edinburgh City Simulation API running on port ${PORT}`);
  console.log(`🔌 WebSocket server available at ws://localhost:${PORT}/ws`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🎯 Foundry integration: ${foundryEnabled ? 'ENABLED' : 'DISABLED'}`);
  
  if (!foundryEnabled) {
    console.log('💡 To enable Foundry integration, set these environment variables:');
    console.log('   - FOUNDRY_URL');
    console.log('   - FOUNDRY_CLIENT_ID');
    console.log('   - FOUNDRY_CLIENT_SECRET');
    console.log('   - FOUNDRY_STREAM_RID');
  }
});

export default app;