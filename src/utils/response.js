class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res, status, code, message, details) =>
  res.status(status).json({ success: false, error: { code, message, details } });

module.exports = { AppError, ok, fail };
