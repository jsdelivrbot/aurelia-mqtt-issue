/* */ 
(function(Buffer) {
  module.exports = shift;
  function shift(stream) {
    var rs = stream._readableState;
    if (!rs)
      return null;
    return rs.objectMode ? stream.read() : stream.read(getStateLength(rs));
  }
  function getStateLength(state) {
    if (state.buffer.length) {
      if (state.buffer.head) {
        return state.buffer.head.data.length;
      }
      return state.buffer[0].length;
    }
    return state.length;
  }
})(require('buffer').Buffer);
