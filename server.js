/**
 * Marwari Audio Recorder - Main Server (v2 - MySQL)
 */

require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const rateLimit    = require('express-rate-limit');
const MySQLStore   = require('express-mysql-session')(session);
const path         = require('path');
const fs           = require('fs');

const { pool, initSchema, migrate } = require('./db');
const publicRoutes = require('./routes/public');
const adminRoutes  = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// Required for Hostinger (and any reverse-proxy) so Express sees the real
// protocol/IP from the X-Forwarded-* headers, and secure cookies work over HTTPS.
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Ensure upload directory exists (data/ directories no longer needed at runtime
// but keep them so any leftover JSON files can be used for the one-time migration)
// ---------------------------------------------------------------------------
const dirs = [path.join(__dirname, 'uploads')];
dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionStore = new MySQLStore({
  host              : process.env.MYSQL_HOST     || 'localhost',
  port              : parseInt(process.env.MYSQL_PORT || '3306'),
  user              : process.env.MYSQL_USER,
  password          : process.env.MYSQL_PASSWORD,
  database          : process.env.MYSQL_DATABASE,
  clearExpired      : true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration        : 8 * 60 * 60 * 1000,
  createDatabaseTable: true,
});

sessionStore.on('error', err => console.error('[session-store] MySQL error:', err));

app.use(session({
  secret           : process.env.SESSION_SECRET || 'change-this-secret-in-production',
  store            : sessionStore,
  resave           : false,
  saveUninitialized: false,
  proxy            : true,
  cookie: {
    maxAge  : 8 * 60 * 60 * 1000, // 8 hours
    httpOnly: true,
    sameSite: 'lax',
    secure  : process.env.NODE_ENV === 'production',
  },
}));

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Routes  (rate limiter applied only to login endpoints)
// ---------------------------------------------------------------------------
app.use('/api/login',       loginLimiter);
app.use('/api/admin/login', loginLimiter);

app.use('/api',       publicRoutes);
app.use('/api/admin', adminRoutes);

// Page routes
app.get('/',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/record', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recorder.html')));
app.get('/admin',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  console.log('[boot] Starting Marwari Recorder…');
  console.log('[boot] Env present:', {
    MYSQL_HOST    : !!process.env.MYSQL_HOST,
    MYSQL_USER    : !!process.env.MYSQL_USER,
    MYSQL_PASSWORD: !!process.env.MYSQL_PASSWORD,
    MYSQL_DATABASE: !!process.env.MYSQL_DATABASE,
    SESSION_SECRET: !!process.env.SESSION_SECRET,
    ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
  });

  try {
    console.log('[boot] Initialising schema…');
    await initSchema();
    console.log('[boot] Schema OK. Running migration if needed…');
    await migrate();
    console.log('[boot] Migration OK. Starting HTTP listener…');
    app.listen(PORT, () => {
      console.log(`[boot] Marwari Recorder running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[boot] FAILED:', err);
    process.exit(1);
  }
})();
