// Socket.IO handler for real-time communication
import { logInfo, logError, logWarn } from './logger.js';

const connectedClients = new Map();

export default (io) => {
  io.on('error', (error) => logError('Socket.IO server error:', error));
  io.engine.on('connection_error', (err) => logError('Socket.IO connection error:', err));

  io.on('connection', (socket) => {
    const clientInfo = { id: socket.id, connectedAt: new Date(), lastActivity: new Date(), rooms: new Set() };
    connectedClients.set(socket.id, clientInfo);
    logInfo(`Client connected: ${socket.id}`, { totalClients: connectedClients.size });

    const heartbeatInterval = setInterval(() => socket.connected && socket.emit('ping'), 25000);

    socket.on('join', (contactId, ack) => {
      try {
        if (!contactId) throw new Error('contactId is required');
        clientInfo.rooms.forEach(room => socket.leave(room));
        clientInfo.rooms.clear();
        socket.join(contactId);
        clientInfo.rooms.add(contactId);
        clientInfo.lastActivity = new Date();
        logInfo(`Client ${socket.id} joined room ${contactId}`, { rooms: [...clientInfo.rooms] });
        ack && ack({ success: true, room: contactId });
      } catch (error) {
        logError('Error joining room:', { socketId: socket.id, contactId, error: error.message });
        ack && ack({ success: false, error: error.message });
      }
    });

    socket.on('pong', () => { clientInfo.lastActivity = new Date(); });
    socket.on('message:ack', (ackData, ackCallback) => {
      try {
        const { messageId, status } = ackData;
        if (!messageId || !status) throw new Error('messageId and status are required');
        logInfo(`Message ${messageId} acknowledged with status: ${status}`, { socketId: socket.id, ackData });
        ackCallback && ackCallback({ success: true });
      } catch (error) {
        logError('Error processing message acknowledgment:', { socketId: socket.id, error: error.message });
        ackCallback && ackCallback({ success: false, error: error.message });
      }
    });

    socket.on('disconnect', (reason) => {
      clearInterval(heartbeatInterval);
      connectedClients.delete(socket.id);
      logInfo(`Client disconnected: ${socket.id}`, { reason, totalClients: connectedClients.size, duration: Math.round((new Date() - clientInfo.connectedAt) / 1000) + 's' });
    });
  });

  setInterval(() => {
    const now = new Date();
    connectedClients.forEach((client, clientId) => {
      if (now - client.lastActivity > 300000) {
        const socket = io.sockets.sockets.get(clientId);
        if (socket) {
          socket.disconnect(true);
          logWarn(`Disconnected inactive client: ${clientId}`, { lastActivity: client.lastActivity, inactiveFor: Math.round((now - client.lastActivity) / 1000) + 's' });
        }
      }
    });
  }, 60000);

  const broadcastToRoom = (room, event, data) => {
    try { io.to(room).emit(event, data); return true; } catch (error) { logError(`Error broadcasting to room ${room}:`, error); return false; }
  };

  return { broadcastToRoom, getConnectedClients: () => connectedClients.size };
};