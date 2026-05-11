/**
 * Marwari Audio Recorder - Main Server
 * Express server for collecting Hindi to Marwari audio translations
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure required directories exist
const dirs = [
  path.join(__dirname, 'data'),
  path.join(__dirname, 'data', 'datasets'),
  path.join(__dirname, 'uploads')
];
dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Initialise data files if missing
const dataFiles = {
  'datasets-index.json': { datasets: [] },
  'users.json': { users: [] },
  'recordings.json': { recordings: [] }
};
Object.entries(dataFiles).forEach(([name, defaultContent]) => {
  const filePath = path.join(__dirname, 'data', name);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultContent, null, 2));
  }
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8, // 8 hours
    httpOnly: true
  }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

// Page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/record', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recorder.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Marwari Recorder running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}`);
});
