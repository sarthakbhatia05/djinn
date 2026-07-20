// Express 4 only forwards synchronous throws in a route handler to error
// middleware automatically; a rejected promise from an async handler is not
// caught and becomes an unhandled rejection instead of a JSON error response.
// Wrap async route handlers with this so rejections reach next(err).
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
