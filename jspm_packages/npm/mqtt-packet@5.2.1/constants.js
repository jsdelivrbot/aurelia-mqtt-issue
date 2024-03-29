/* */ 
(function(Buffer) {
  var protocol = module.exports;
  protocol.types = {
    0: 'reserved',
    1: 'connect',
    2: 'connack',
    3: 'publish',
    4: 'puback',
    5: 'pubrec',
    6: 'pubrel',
    7: 'pubcomp',
    8: 'subscribe',
    9: 'suback',
    10: 'unsubscribe',
    11: 'unsuback',
    12: 'pingreq',
    13: 'pingresp',
    14: 'disconnect',
    15: 'reserved'
  };
  protocol.codes = {};
  for (var k in protocol.types) {
    var v = protocol.types[k];
    protocol.codes[v] = k;
  }
  protocol.CMD_SHIFT = 4;
  protocol.CMD_MASK = 0xF0;
  protocol.DUP_MASK = 0x08;
  protocol.QOS_MASK = 0x03;
  protocol.QOS_SHIFT = 1;
  protocol.RETAIN_MASK = 0x01;
  protocol.LENGTH_MASK = 0x7F;
  protocol.LENGTH_FIN_MASK = 0x80;
  protocol.SESSIONPRESENT_MASK = 0x01;
  protocol.SESSIONPRESENT_HEADER = new Buffer([protocol.SESSIONPRESENT_MASK]);
  protocol.CONNACK_HEADER = new Buffer([protocol.codes['connack'] << protocol.CMD_SHIFT]);
  protocol.USERNAME_MASK = 0x80;
  protocol.PASSWORD_MASK = 0x40;
  protocol.WILL_RETAIN_MASK = 0x20;
  protocol.WILL_QOS_MASK = 0x18;
  protocol.WILL_QOS_SHIFT = 3;
  protocol.WILL_FLAG_MASK = 0x04;
  protocol.CLEAN_SESSION_MASK = 0x02;
  protocol.CONNECT_HEADER = new Buffer([protocol.codes['connect'] << protocol.CMD_SHIFT]);
  function genHeader(type) {
    return [0, 1, 2].map(function(qos) {
      return [0, 1].map(function(dup) {
        return [0, 1].map(function(retain) {
          var buf = new Buffer(1);
          buf.writeUInt8(protocol.codes[type] << protocol.CMD_SHIFT | (dup ? protocol.DUP_MASK : 0) | qos << protocol.QOS_SHIFT | retain, 0, true);
          return buf;
        });
      });
    });
  }
  protocol.PUBLISH_HEADER = genHeader('publish');
  protocol.SUBSCRIBE_HEADER = genHeader('subscribe');
  protocol.UNSUBSCRIBE_HEADER = genHeader('unsubscribe');
  protocol.ACKS = {
    unsuback: genHeader('unsuback'),
    puback: genHeader('puback'),
    pubcomp: genHeader('pubcomp'),
    pubrel: genHeader('pubrel'),
    pubrec: genHeader('pubrec')
  };
  protocol.SUBACK_HEADER = new Buffer([protocol.codes['suback'] << protocol.CMD_SHIFT]);
  protocol.VERSION3 = new Buffer([3]);
  protocol.VERSION4 = new Buffer([4]);
  protocol.QOS = [0, 1, 2].map(function(qos) {
    return new Buffer([qos]);
  });
  protocol.EMPTY = {
    pingreq: new Buffer([protocol.codes['pingreq'] << 4, 0]),
    pingresp: new Buffer([protocol.codes['pingresp'] << 4, 0]),
    disconnect: new Buffer([protocol.codes['disconnect'] << 4, 0])
  };
})(require('buffer').Buffer);
