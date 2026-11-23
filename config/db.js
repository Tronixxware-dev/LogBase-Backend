const mongoose = require('mongoose');

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 50, // enough for a busy server, far below the 500 connections of the free Atlas tier
      serverSelectionTimeoutMS: 10000, // a database that does not answer is an error after 10 s, not a request hanging for ever
      socketTimeoutMS: 45000,
    });
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = connectDB;