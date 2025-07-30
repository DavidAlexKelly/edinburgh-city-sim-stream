// lib/websocket.js - WebSocket handler for Railway deployment
import { activeSimulations, CitySimulation } from './simulation.js';

// WebSocket connection handler
export function handleWebSocket(ws, req) {
  let simulationId = null;
  let clientInfo = {
    ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
    userAgent: req.headers['user-agent'],
    connectedAt: new Date().toISOString()
  };
  
  console.log(`🔌 WebSocket client connected:`, clientInfo);
  
  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`📨 WebSocket message from ${clientInfo.ip}:`, data.action);
      
      // Handle different actions
      switch (data.action) {
        case 'startSimulation':
          simulationId = await handleStartSimulation(ws, data);
          break;
          
        case 'stopSimulation':
          handleStopSimulation(ws, simulationId);
          simulationId = null;
          break;
          
        case 'updateTimeCompression':
          handleUpdateTimeCompression(ws, simulationId, data);
          break;
          
        case 'getStatus':
          handleGetStatus(ws, simulationId);
          break;
          
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: new Date().toISOString(),
            server_time: new Date().toISOString()
          }));
          break;
          
        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown action: ${data.action}`,
            available_actions: [
              'startSimulation',
              'stopSimulation', 
              'updateTimeCompression',
              'getStatus',
              'ping'
            ]
          }));
      }
      
    } catch (error) {
      console.error('WebSocket message parsing error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format - expected JSON',
        example: {
          action: 'startSimulation',
          seconds_per_hour: 10,
          foundry_config: null
        }
      }));
    }
  });

  // Handle connection close
  ws.on('close', (code, reason) => {
    console.log(`🔌 WebSocket disconnected from ${clientInfo.ip}: ${code} ${reason}`);
    
    // Clean up simulation if client disconnects
    if (simulationId) {
      const simulation = activeSimulations.get(simulationId);
      if (simulation) {
        console.log(`🧹 Cleaning up simulation ${simulationId} after client disconnect`);
        simulation.stop();
        activeSimulations.delete(simulationId);
      }
    }
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error from ${clientInfo.ip}:`, error);
  });
  
  // Send periodic keepalive (every 30 seconds)
  const keepAliveInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'keepalive',
        timestamp: new Date().toISOString(),
        active_simulations: activeSimulations.size,
        simulation_id: simulationId
      }));
    } else {
      clearInterval(keepAliveInterval);
    }
  }, 30000);
}

// Start a new simulation via WebSocket
async function handleStartSimulation(ws, data) {
  try {
    const { 
      seconds_per_hour = 10, 
      foundry_config = null,
      simulation_name = 'WebSocket Simulation'
    } = data;
    
    // Validate time compression parameter
    if (!Number.isInteger(seconds_per_hour) || seconds_per_hour < 1 || seconds_per_hour > 3600) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'seconds_per_hour must be an integer between 1 and 3600'
      }));
      return null;
    }
    
    // Generate unique simulation ID
    const simulationId = Date.now() + Math.floor(Math.random() * 10000);
    
    // Create simulation with WebSocket connection
    const simulation = new CitySimulation(ws, simulationId, seconds_per_hour, foundry_config);
    
    // Store and start simulation
    activeSimulations.set(simulationId, simulation);
    simulation.start();
    
    // Send confirmation
    ws.send(JSON.stringify({
      type: 'simulation_started',
      simulation_id: simulationId,
      simulation_name: simulation_name,
      seconds_per_hour: seconds_per_hour,
      foundry_integration: !!foundry_config,
      message: `Simulation started - data streaming every ${seconds_per_hour} seconds`,
      started_at: new Date().toISOString(),
      next_data_in_seconds: seconds_per_hour
    }));
    
    console.log(`🚀 Started WebSocket simulation ${simulationId}`);
    return simulationId;
    
  } catch (error) {
    console.error('Start simulation error:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to start simulation',
      details: error.message
    }));
    return null;
  }
}

// Stop simulation via WebSocket
function handleStopSimulation(ws, simulationId) {
  if (!simulationId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'No active simulation to stop'
    }));
    return;
  }
  
  const simulation = activeSimulations.get(simulationId);
  if (!simulation) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Simulation ${simulationId} not found`
    }));
    return;
  }
  
  // Stop and remove simulation
  simulation.stop();
  activeSimulations.delete(simulationId);
  
  ws.send(JSON.stringify({
    type: 'simulation_stopped',
    simulation_id: simulationId,
    message: 'Simulation stopped successfully',
    stopped_at: new Date().toISOString()
  }));
  
  console.log(`🛑 Stopped WebSocket simulation ${simulationId}`);
}

// Update time compression via WebSocket
function handleUpdateTimeCompression(ws, simulationId, data) {
  if (!simulationId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'No active simulation to update'
    }));
    return;
  }
  
  const simulation = activeSimulations.get(simulationId);
  if (!simulation) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Simulation ${simulationId} not found`
    }));
    return;
  }
  
  const { seconds_per_hour } = data;
  
  if (!Number.isInteger(seconds_per_hour) || seconds_per_hour < 1 || seconds_per_hour > 3600) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'seconds_per_hour must be an integer between 1 and 3600'
    }));
    return;
  }
  
  // Update time compression
  simulation.updateTimeCompression(seconds_per_hour);
  
  ws.send(JSON.stringify({
    type: 'time_compression_updated',
    simulation_id: simulationId,
    seconds_per_hour: seconds_per_hour,
    message: `Time compression updated to ${seconds_per_hour} seconds per game hour`,
    updated_at: new Date().toISOString()
  }));
  
  console.log(`⚡ Updated WebSocket simulation ${simulationId} time compression to ${seconds_per_hour}s/hour`);
}

// Get simulation status via WebSocket
function handleGetStatus(ws, simulationId) {
  if (!simulationId) {
    ws.send(JSON.stringify({
      type: 'status_response',
      message: 'No active simulation',
      active_simulations: activeSimulations.size,
      timestamp: new Date().toISOString()
    }));
    return;
  }
  
  const simulation = activeSimulations.get(simulationId);
  if (!simulation) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Simulation ${simulationId} not found`
    }));
    return;
  }
  
  // Get current status and snapshot
  const status = simulation.getSimulationStatus();
  const snapshot = simulation.getCurrentSnapshot();
  
  ws.send(JSON.stringify({
    type: 'status_response',
    timestamp: new Date().toISOString(),
    status: status,
    current_data: snapshot
  }));
}

// Export for external use
export { activeSimulations };