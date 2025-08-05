import 'dotenv/config'; // Load environment variables from a .env file into process.env
import express from 'express'; // Import Express framework to create the web server
import http from 'http'; // Import HTTP module to create the server
import cors from 'cors'; // Import CORS middleware to handle cross-origin requests
import mongoose from 'mongoose'; // Import Mongoose for MongoDB connection
import { Server } from 'socket.io'; // Import Socket.IO Server for real-time communication
import messageRoutes from './src/routes/messageRoutes.js'; // Import message-related routes
import webhookRoutes from './src/routes/webhookRoutes.js'; // Import webhook-related routes
import contactRoutes from './src/routes/contactRoutes.js'; // Import contact-related routes
import socketHandler from './src/utils/socket.js'; // Import Socket.IO handler utility
import connectDB from './src/config/db.js'; // Import MongoDB connection function
import fs from 'fs'; // Import file system module for lock file management

// ANSI escape code for green text
const green = '\x1b[32m';
const reset = '\x1b[0m'; // Reset to default color

// Create an Express application instance
const app = express();
// Create an HTTP server using the Express app
const server = http.createServer(app);

// Configure CORS options to allow Salesforce domains
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // List of allowed origins
    const allowedOrigins = [
      'https://resilient-bear-otclnn-dev-ed.trailblaze.lightning.force.com',
      'https://resilient-bear-otclnn-dev-ed.trailblaze.my.salesforce.com',
      'https://resilient-bear-otclnn-dev-ed.trailblaze.my.salesforce-scrt.com',
      'https://ind134.sfdc-y37hzm.salesforce.com',
      /\.lightning\.force\.com$/,
      /\.salesforce\.com$/,
      /\.my\.salesforce\.com$/,
      /\.trailblaze\.my\.salesforce\.com$/,
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002'
    ];
    
    // Check if origin is allowed
    const isAllowed = allowedOrigins.some(allowedOrigin => {
      if (typeof allowedOrigin === 'string') {
        return origin === allowedOrigin;
      } else if (allowedOrigin instanceof RegExp) {
        return allowedOrigin.test(origin);
      }
      return false;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.log(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With', 
    'Accept', 
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
    'X-CSRF-Token',
    'X-Salesforce-Chat',
    'Cache-Control',
    'Pragma'
  ],
  exposedHeaders: [
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Methods',
    'Access-Control-Allow-Headers'
  ],
  credentials: true,
  optionsSuccessStatus: 200,
  preflightContinue: false
};

// Apply CORS middleware to handle cross-origin requests
app.use(cors(corsOptions));
// Handle preflight requests with CORS
app.options('*', cors(corsOptions));

// Additional CORS headers middleware for extra compatibility
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers, X-CSRF-Token, X-Salesforce-Chat, Cache-Control, Pragma');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  next();
});

// Parse JSON bodies with a 50MB limit
app.use(express.json({ limit: '50mb' }));
// Parse URL-encoded bodies with a 50MB limit
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Origin: ${req.get('Origin') || 'N/A'}`);
  next();
});

// Add error logging middleware
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error:`, err);
  next(err);
});

// Initialize Socket.IO with the HTTP server and CORS configuration
const io = new Server(server, { 
  cors: {
    origin: function (origin, callback) {
      // Allow all origins for Socket.IO
      callback(null, true);
    },
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
  }, 
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Set up Socket.IO handler for real-time communication
socketHandler(io);
// Make Socket.IO instance accessible to routes
app.set('socketio', io);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'WhatsApp Widget Backend API',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/api/health',
      messages: '/messages',
      webhooks: '/webhook'
    }
  });
});

// Mount message-related routes under /api/messages
app.use('/api/messages', messageRoutes);
// Also mount directly under /messages for frontend compatibility
app.use('/messages', messageRoutes);
// Mount webhook-related routes under /webhook
app.use('/webhook', webhookRoutes);
// Mount contact-related routes under /api
app.use('/api', contactRoutes);

// Health check endpoint to verify server status
app.get('/api/health', (req, res) => 
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    uptime: process.uptime(),
    cors: 'enabled',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  })
);

// Health check endpoint for database status
app.get('/api/health/db', async (req, res) => 
  res.json({ 
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', 
    timestamp: new Date().toISOString() 
  })
);

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Global error handler - Error:`, err);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    availableRoutes: ['/api/health', '/messages', '/webhook']
  });
});

// Function to start the server with Render-compatible port binding
const startServer = () => {
  return new Promise((resolve, reject) => {
    const port = parseInt(process.env.PORT || '3002', 10); // Use Render's PORT or default to 3002
    console.log(`[${new Date().toISOString()}] ${green}Attempting to start server on port ${port}...${reset}`);
    server.listen(port, '0.0.0.0', () => {
      console.log(`[${new Date().toISOString()}] ${green}Server running on http://0.0.0.0:${port}${reset}`);
      console.log(`[${new Date().toISOString()}] ${green}Health check: http://0.0.0.0:${port}/api/health${reset}`);
      console.log(`[${new Date().toISOString()}] ${green}Database health: http://0.0.0.0:${port}/api/health/db${reset}`);
      console.log(`[${new Date().toISOString()}] ${green}CORS enabled for Salesforce domains${reset}`);
      resolve();
    }).on('error', (err) => {
      console.error(`[${new Date().toISOString()}] Server error:`, err.message);
      reject(err);
    });
  });
};

// Define the lock file path to prevent multiple server instances
const lockFile = '.server.lock';
// Function to clean up resources and exit the process
const cleanup = () => {
  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
    console.log(`[${new Date().toISOString()}] ${green}Removed server lock file on exit${reset}`);
  }
  server.close(() => process.exit(0));
};

// Remove existing lock file on restart or initial run to avoid blocking
if (fs.existsSync(lockFile)) {
  console.log(`[${new Date().toISOString()}] ${green}Removing existing lock file due to restart...${reset}`);
  fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile, process.pid.toString());

// Register cleanup on various exit signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

// Wrapper function to handle database connection and server startup
const connectDBWrapper = async () => {
  try {
    await connectDB();
    await startServer();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Failed to start server: ${error.message}`);
    cleanup();
    process.exit(1);
  }
};

// Handle unhandled promise rejections with cleanup
process.on('unhandledRejection', (err) => { 
  console.error(`[${new Date().toISOString()}] Unhandled Rejection: ${err.message}`); 
  cleanup(); 
});
// Handle uncaught exceptions with cleanup
process.on('uncaughtException', (err) => { 
  console.error(`[${new Date().toISOString()}] Uncaught Exception: ${err.message}`); 
  cleanup(); 
});

// Initiate the application startup process
connectDBWrapper();
// Export the app for potential use in other contexts (e.g., Vercel)
export default app;
