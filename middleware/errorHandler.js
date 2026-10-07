function notFound(req, res, next) {
  res.status(404).json({ message: `Route not found: ${req.originalUrl}` });
}

function errorHandler(err, req, res, next) {
  // Errors we threw on purpose (httpError) are expected, so only log the unexpected ones.
  if (!err.statusCode) console.error(err);

  if (err.code === 11000) {
    return res.status(409).json({ message: 'A record with that value already exists' });
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json({ message: err.message });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ message: `Upload problem: ${err.message}` });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ message: 'Invalid id or value' });
  }

  res.status(err.statusCode || 500).json({ message: err.message || 'Server error' });
}

module.exports = { notFound, errorHandler };
