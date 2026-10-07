require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

// Validate mandatory environment variables at startup
if (!process.env.SESSION_SECRET) {
  console.error('FATAL CONFIGURATION ERROR: SESSION_SECRET environment variable is missing!');
  if (require.main === module) {
    process.exit(1);
  }
}

const path = require('path');

const authRoutes = require('./routes/authRoutes');
const contactRoutes = require('./routes/contactRoutes');
const sourceRoutes = require('./routes/sourceRoutes');
const relationshipRoutes = require('./routes/relationshipRoutes');
const interactionRoutes = require('./routes/interactionRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const tellDossierRoutes = require('./routes/tellDossierRoutes');
const commitmentRoutes = require('./routes/commitmentRoutes');
const askDossierRoutes = require('./routes/askDossierRoutes');

const { getUploadDir } = require('./lib/uploadConfig');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve uploaded static files from persistent upload directory (/uploads)
app.use('/uploads', express.static(getUploadDir()));

// CORS configuration supporting credentials (cookies)
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001'];

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // In development mode, allow localhost and 127.0.0.1 on any port
    if (process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With']
}));

// Body & Cookie Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Uptime & Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Dossier API',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Versioned API Routes (/api/v1/...)
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/contacts', contactRoutes);
app.use('/api/v1/sources', sourceRoutes);
app.use('/api/v1/relationships', relationshipRoutes);
app.use('/api/v1/interactions', interactionRoutes);
app.use('/api/v1/upload', uploadRoutes);
app.use('/api/v1/tell-dossier', tellDossierRoutes);
app.use('/api/v1/commitments', commitmentRoutes);
app.use('/api/v1/ask-dossier', askDossierRoutes);

// Root Fallback Route
app.get('/', (req, res) => {
  res.json({
    name: 'Dossier API Service',
    documentation: 'All endpoints are versioned under /api/v1',
    healthCheck: '/health'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Dossier Express Backend listening on port ${PORT}`);
  console.log(`📍 Health check available at http://localhost:${PORT}/health`);
  console.log(`🌐 API Base URL: http://localhost:${PORT}/api/v1`);
});

module.exports = app;
