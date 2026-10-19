/**
 * Correlation ID & Observability Middleware (Sprint 3A)
 * Tracks request correlation IDs across the application lifecycle.
 */

const crypto = require('crypto');

function correlationMiddleware(req, res, next) {
  const incomingId = req.headers['x-correlation-id'];
  const correlationId = (typeof incomingId === 'string' && incomingId.trim().length > 0)
    ? incomingId.trim()
    : crypto.randomUUID();

  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  const startTime = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - startTime;
    // Log route, status, timing, correlationId
    if (process.env.NODE_ENV !== 'test' || elapsed > 500) {
      console.log(`[HTTP] [${correlationId}] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} (${elapsed}ms)`);
    }
  });

  next();
}

module.exports = {
  correlationMiddleware
};
