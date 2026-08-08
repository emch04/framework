function apiResponse(res, statusCode, message, data = null, success = statusCode < 400) {
  const payload = {
    success,
    message,
    data,
    timestamp: new Date().toISOString()
  };

  if (!success) {
    payload.error = message;
  }

  return res.status(statusCode).json(payload);
}

module.exports = apiResponse;
