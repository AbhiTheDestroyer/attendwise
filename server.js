'use strict';
/** Entry point. */
const { createServer } = require('./src/app');
const { db } = require('./src/db');
const { execSeed } = require('./src/seed');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// Auto-seed an empty database so a fresh clone runs out of the box
// (demo data is clearly labeled; set AMS_NO_AUTOSEED=1 to disable).
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0 && process.env.AMS_NO_AUTOSEED !== '1') {
  console.log('[init] empty database detected → seeding demo data (see README §Seed data)');
  execSeed(process.argv.includes('--force'));
}

const server = createServer();
server.listen(PORT, HOST, () => {
  console.log(`Attendance Management System listening on http://${HOST}:${PORT}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
