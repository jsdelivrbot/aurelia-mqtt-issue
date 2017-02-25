/* */ 
(function(Buffer, process) {
  'use strict';
  var protocol = require('./constants');
  var empty = new Buffer(0);
  var zeroBuf = new Buffer([0]);
  var numCache = require('./numbers');
  var nextTick = require('process-nextick-args');
  function generate(packet, stream) {
    if (stream.cork) {
      stream.cork();
      nextTick(uncork, stream);
    }
    switch (packet.cmd) {
      case 'connect':
        return connect(packet, stream);
      case 'connack':
        return connack(packet, stream);
      case 'publish':
        return publish(packet, stream);
      case 'puback':
      case 'pubrec':
      case 'pubrel':
      case 'pubcomp':
      case 'unsuback':
        return confirmation(packet, stream);
      case 'subscribe':
        return subscribe(packet, stream);
      case 'suback':
        return suback(packet, stream);
      case 'unsubscribe':
        return unsubscribe(packet, stream);
      case 'pingreq':
      case 'pingresp':
      case 'disconnect':
        return emptyPacket(packet, stream);
      default:
        stream.emit('error', new Error('Unknown command'));
        return false;
    }
  }
  function uncork(stream) {
    stream.uncork();
  }
  function connect(opts, stream) {
    var settings = opts || {};
    var protocolId = settings.protocolId || 'MQTT';
    var protocolVersion = settings.protocolVersion || 4;
    var will = settings.will;
    var clean = settings.clean;
    var keepalive = settings.keepalive || 0;
    var clientId = settings.clientId || '';
    var username = settings.username;
    var password = settings.password;
    if (clean === undefined)
      clean = true;
    var length = 0;
    if (!protocolId || (typeof protocolId !== 'string' && !Buffer.isBuffer(protocolId))) {
      stream.emit('error', new Error('Invalid protocol id'));
      return false;
    } else
      length += protocolId.length + 2;
    if (protocolVersion !== 3 && protocolVersion !== 4) {
      stream.emit('error', new Error('Invalid protocol version'));
      return false;
    } else
      length += 1;
    if ((typeof clientId === 'string' || Buffer.isBuffer(clientId)) && (clientId || protocolVersion === 4) && (clientId || clean)) {
      length += clientId.length + 2;
    } else {
      if (protocolVersion < 4) {
        stream.emit('error', new Error('clientId must be supplied before 3.1.1'));
        return false;
      }
      if ((clean * 1) === 0) {
        stream.emit('error', new Error('clientId must be given if cleanSession set to 0'));
        return false;
      }
    }
    if (typeof keepalive !== 'number' || keepalive < 0 || keepalive > 65535 || keepalive % 1 !== 0) {
      stream.emit('error', new Error('Invalid keepalive'));
      return false;
    } else
      length += 2;
    length += 1;
    if (will) {
      if (typeof will !== 'object') {
        stream.emit('error', new Error('Invalid will'));
        return false;
      }
      if (!will.topic || typeof will.topic !== 'string') {
        stream.emit('error', new Error('Invalid will topic'));
        return false;
      } else {
        length += Buffer.byteLength(will.topic) + 2;
      }
      if (will.payload && will.payload) {
        if (will.payload.length >= 0) {
          if (typeof will.payload === 'string') {
            length += Buffer.byteLength(will.payload) + 2;
          } else {
            length += will.payload.length + 2;
          }
        } else {
          stream.emit('error', new Error('Invalid will payload'));
          return false;
        }
      } else {
        length += 2;
      }
    }
    if (username) {
      if (username.length) {
        length += Buffer.byteLength(username) + 2;
      } else {
        stream.emit('error', new Error('Invalid username'));
        return false;
      }
    }
    if (password) {
      if (password.length) {
        length += byteLength(password) + 2;
      } else {
        stream.emit('error', new Error('Invalid password'));
        return false;
      }
    }
    stream.write(protocol.CONNECT_HEADER);
    writeLength(stream, length);
    writeStringOrBuffer(stream, protocolId);
    stream.write(protocolVersion === 4 ? protocol.VERSION4 : protocol.VERSION3);
    var flags = 0;
    flags |= username ? protocol.USERNAME_MASK : 0;
    flags |= password ? protocol.PASSWORD_MASK : 0;
    flags |= (will && will.retain) ? protocol.WILL_RETAIN_MASK : 0;
    flags |= (will && will.qos) ? will.qos << protocol.WILL_QOS_SHIFT : 0;
    flags |= will ? protocol.WILL_FLAG_MASK : 0;
    flags |= clean ? protocol.CLEAN_SESSION_MASK : 0;
    stream.write(new Buffer([flags]));
    writeNumber(stream, keepalive);
    writeStringOrBuffer(stream, clientId);
    if (will) {
      writeString(stream, will.topic);
      writeStringOrBuffer(stream, will.payload);
    }
    if (username)
      writeStringOrBuffer(stream, username);
    if (password)
      writeStringOrBuffer(stream, password);
    return true;
  }
  function connack(opts, stream) {
    var settings = opts || {};
    var rc = settings.returnCode;
    if (typeof rc !== 'number') {
      stream.emit('error', new Error('Invalid return code'));
      return false;
    }
    stream.write(protocol.CONNACK_HEADER);
    writeLength(stream, 2);
    stream.write(opts.sessionPresent ? protocol.SESSIONPRESENT_HEADER : zeroBuf);
    return stream.write(new Buffer([rc]));
  }
  function publish(opts, stream) {
    var settings = opts || {};
    var qos = settings.qos || 0;
    var retain = settings.retain ? protocol.RETAIN_MASK : 0;
    var topic = settings.topic;
    var payload = settings.payload || empty;
    var id = settings.messageId;
    var length = 0;
    if (typeof topic === 'string')
      length += Buffer.byteLength(topic) + 2;
    else if (Buffer.isBuffer(topic))
      length += topic.length + 2;
    else {
      stream.emit('error', new Error('Invalid topic'));
      return false;
    }
    if (!Buffer.isBuffer(payload))
      length += Buffer.byteLength(payload);
    else
      length += payload.length;
    if (qos && typeof id !== 'number') {
      stream.emit('error', new Error('Invalid message id'));
      return false;
    } else if (qos)
      length += 2;
    stream.write(protocol.PUBLISH_HEADER[qos][opts.dup ? 1 : 0][retain ? 1 : 0]);
    writeLength(stream, length);
    writeNumber(stream, byteLength(topic));
    stream.write(topic);
    if (qos > 0)
      writeNumber(stream, id);
    return stream.write(payload);
  }
  function confirmation(opts, stream) {
    var settings = opts || {};
    var type = settings.cmd || 'puback';
    var id = settings.messageId;
    var dup = (settings.dup && type === 'pubrel') ? protocol.DUP_MASK : 0;
    var qos = 0;
    if (type === 'pubrel')
      qos = 1;
    if (typeof id !== 'number') {
      stream.emit('error', new Error('Invalid message id'));
      return false;
    }
    stream.write(protocol.ACKS[type][qos][dup][0]);
    writeLength(stream, 2);
    return writeNumber(stream, id);
  }
  function subscribe(opts, stream) {
    var settings = opts || {};
    var dup = settings.dup ? protocol.DUP_MASK : 0;
    var id = settings.messageId;
    var subs = settings.subscriptions;
    var length = 0;
    if (typeof id !== 'number') {
      stream.emit('error', new Error('Invalid message id'));
      return false;
    } else
      length += 2;
    if (typeof subs === 'object' && subs.length) {
      for (var i = 0; i < subs.length; i += 1) {
        var itopic = subs[i].topic;
        var iqos = subs[i].qos;
        if (typeof itopic !== 'string') {
          stream.emit('error', new Error('Invalid subscriptions - invalid topic'));
          return false;
        }
        if (typeof iqos !== 'number') {
          stream.emit('error', new Error('Invalid subscriptions - invalid qos'));
          return false;
        }
        length += Buffer.byteLength(itopic) + 2 + 1;
      }
    } else {
      stream.emit('error', new Error('Invalid subscriptions'));
      return false;
    }
    stream.write(protocol.SUBSCRIBE_HEADER[1][dup ? 1 : 0][0]);
    writeLength(stream, length);
    writeNumber(stream, id);
    var result = true;
    for (var j = 0; j < subs.length; j++) {
      var sub = subs[j];
      var jtopic = sub.topic;
      var jqos = sub.qos;
      writeString(stream, jtopic);
      result = stream.write(protocol.QOS[jqos]);
    }
    return result;
  }
  function suback(opts, stream) {
    var settings = opts || {};
    var id = settings.messageId;
    var granted = settings.granted;
    var length = 0;
    if (typeof id !== 'number') {
      stream.emit('error', new Error('Invalid message id'));
      return false;
    } else
      length += 2;
    if (typeof granted === 'object' && granted.length) {
      for (var i = 0; i < granted.length; i += 1) {
        if (typeof granted[i] !== 'number') {
          stream.emit('error', new Error('Invalid qos vector'));
          return false;
        }
        length += 1;
      }
    } else {
      stream.emit('error', new Error('Invalid qos vector'));
      return false;
    }
    stream.write(protocol.SUBACK_HEADER);
    writeLength(stream, length);
    writeNumber(stream, id);
    return stream.write(new Buffer(granted));
  }
  function unsubscribe(opts, stream) {
    var settings = opts || {};
    var id = settings.messageId;
    var dup = settings.dup ? protocol.DUP_MASK : 0;
    var unsubs = settings.unsubscriptions;
    var length = 0;
    if (typeof id !== 'number') {
      stream.emit('error', new Error('Invalid message id'));
      return false;
    } else {
      length += 2;
    }
    if (typeof unsubs === 'object' && unsubs.length) {
      for (var i = 0; i < unsubs.length; i += 1) {
        if (typeof unsubs[i] !== 'string') {
          stream.emit('error', new Error('Invalid unsubscriptions'));
          return false;
        }
        length += Buffer.byteLength(unsubs[i]) + 2;
      }
    } else {
      stream.emit('error', new Error('Invalid unsubscriptions'));
      return false;
    }
    stream.write(protocol.UNSUBSCRIBE_HEADER[1][dup ? 1 : 0][0]);
    writeLength(stream, length);
    writeNumber(stream, id);
    var result = true;
    for (var j = 0; j < unsubs.length; j++) {
      result = writeString(stream, unsubs[j]);
    }
    return result;
  }
  function emptyPacket(opts, stream) {
    return stream.write(protocol.EMPTY[opts.cmd]);
  }
  function calcLengthLength(length) {
    if (length >= 0 && length < 128)
      return 1;
    else if (length >= 128 && length < 16384)
      return 2;
    else if (length >= 16384 && length < 2097152)
      return 3;
    else if (length >= 2097152 && length < 268435456)
      return 4;
    else
      return 0;
  }
  function genBufLength(length) {
    var digit = 0;
    var pos = 0;
    var buffer = new Buffer(calcLengthLength(length));
    do {
      digit = length % 128 | 0;
      length = length / 128 | 0;
      if (length > 0)
        digit = digit | 0x80;
      buffer.writeUInt8(digit, pos++, true);
    } while (length > 0);
    return buffer;
  }
  var lengthCache = {};
  function writeLength(stream, length) {
    var buffer = lengthCache[length];
    if (!buffer) {
      buffer = genBufLength(length);
      if (length < 16384)
        lengthCache[length] = buffer;
    }
    stream.write(buffer);
  }
  function writeString(stream, string) {
    var strlen = Buffer.byteLength(string);
    writeNumber(stream, strlen);
    stream.write(string, 'utf8');
  }
  function writeNumber(stream, number) {
    return stream.write(numCache[number]);
  }
  function writeStringOrBuffer(stream, toWrite) {
    if (toWrite && typeof toWrite === 'string')
      writeString(stream, toWrite);
    else if (toWrite) {
      writeNumber(stream, toWrite.length);
      stream.write(toWrite);
    } else
      writeNumber(stream, 0);
  }
  function byteLength(bufOrString) {
    if (!bufOrString)
      return 0;
    else if (Buffer.isBuffer(bufOrString))
      return bufOrString.length;
    else
      return Buffer.byteLength(bufOrString);
  }
  module.exports = generate;
})(require('buffer').Buffer, require('process'));
