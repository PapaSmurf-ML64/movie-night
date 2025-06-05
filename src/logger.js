// logger.js: Central logging utility to avoid circular dependencies
const rfs = require('rotating-file-stream');
const path = require('path');

const logStream = rfs.createStream('bot.log', {
  interval: '1d', // rotate daily
  path: path.join(__dirname, '..'),
  maxFiles: 14
});

function logBot(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logStream.write(line + '\n');
  if (process.env.NODE_ENV !== 'production') {
    console.log(line);
  }
}

module.exports = { logBot };
