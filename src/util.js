// Utility functions
function autoDelete(msg, scheduleMessageId) {
  if (!msg) return;
  if (msg.id && scheduleMessageId && msg.id === scheduleMessageId) return;
  setTimeout(() => {
    msg.delete().catch(() => {});
  }, 30 * 1000); // 30 seconds
}

module.exports = { autoDelete };
