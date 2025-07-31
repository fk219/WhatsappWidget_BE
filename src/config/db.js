import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.error(`[${new Date().toISOString()}] No MongoDB URI provided`);
      process.exit(1);
    }

    // Set up connection event listeners with original logging style
    mongoose.connection.on('connected', () => {
      console.log(`[${new Date().toISOString()}] MongoDB Connected Successfully!: ${mongoose.connection.host}`);
    });
    mongoose.connection.on('disconnected', () => {
      console.error(`[${new Date().toISOString()}] MongoDB Disconnected`);
    });
    mongoose.connection.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] MongoDB Connection Error: ${err.message}`);
    });

    // Handle purposeful shutdown
    const shutdown = async () => {
      await mongoose.connection.close();
      console.log(`[${new Date().toISOString()}] MongoDB Connection Closed`);
      process.exit(0);
    };

    // Connect to MongoDB with initial log
    console.log(`[${new Date().toISOString()}] Attempting to connect to MongoDB...`);
    await mongoose.connect(process.env.MONGO_URI);

    // Handle process termination
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to connect to MongoDB: ${err.message}`);
    process.exit(1);
  }
};

export default connectDB;