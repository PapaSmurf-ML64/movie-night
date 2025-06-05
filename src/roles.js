// RSVP/Attendance tracking and role management
var rsvpSet = global._rsvpSet = global._rsvpSet || new Set();
var attendedSet = global._attendedSet = global._attendedSet || new Set();

function addRSVP(userId) {
  rsvpSet.add(userId);
}
function removeRSVP(userId) {
  rsvpSet.delete(userId);
}
function addAttendance(userId) {
  attendedSet.add(userId);
}
function removeAttendance(userId) {
  attendedSet.delete(userId);
}
function getRSVPs() {
  return Array.from(rsvpSet);
}
function getAttendance() {
  return Array.from(attendedSet);
}

module.exports = {
  addRSVP,
  removeRSVP,
  addAttendance,
  removeAttendance,
  getRSVPs,
  getAttendance
};
