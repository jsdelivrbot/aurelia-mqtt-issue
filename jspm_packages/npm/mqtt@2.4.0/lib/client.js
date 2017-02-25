/* */ 
(function(Buffer, process) {
  'use strict';
  var events = require('events');
  var Store = require('./store');
  var eos = require('end-of-stream');
  var mqttPacket = require('mqtt-packet');
  var Writable = require('readable-stream').Writable;
  var inherits = require('inherits');
  var reInterval = require('reinterval');
  var validations = require('./validations');
  var setImmediate = global.setImmediate || function(callback) {
    process.nextTick(callback);
  };
  var defaultConnectOptions = {
    keepalive: 60,
    reschedulePings: true,
    protocolId: 'MQTT',
    protocolVersion: 4,
    reconnectPeriod: 1000,
    connectTimeout: 30 * 1000,
    clean: true
  };
  function defaultId() {
    return 'mqttjs_' + Math.random().toString(16).substr(2, 8);
  }
  function sendPacket(client, packet, cb) {
    client.emit('packetsend', packet);
    var result = mqttPacket.writeToStream(packet, client.stream);
    if (!result && cb) {
      client.stream.once('drain', cb);
    } else if (cb) {
      cb();
    }
  }
  function storeAndSend(client, packet, cb) {
    client.outgoingStore.put(packet, function storedPacket(err) {
      if (err) {
        return cb && cb(err);
      }
      sendPacket(client, packet, cb);
    });
  }
  function nop() {}
  function MqttClient(streamBuilder, options) {
    var k;
    var that = this;
    if (!(this instanceof MqttClient)) {
      return new MqttClient(streamBuilder, options);
    }
    this.options = options || {};
    for (k in defaultConnectOptions) {
      if (typeof this.options[k] === 'undefined') {
        this.options[k] = defaultConnectOptions[k];
      } else {
        this.options[k] = options[k];
      }
    }
    this.options.clientId = this.options.clientId || defaultId();
    this.streamBuilder = streamBuilder;
    this.outgoingStore = this.options.outgoingStore || new Store();
    this.incomingStore = this.options.incomingStore || new Store();
    this.queueQoSZero = this.options.queueQoSZero === undefined ? true : this.options.queueQoSZero;
    this._subscribedTopics = {};
    this.pingTimer = null;
    this.connected = false;
    this.disconnecting = false;
    this.queue = [];
    this.connackTimer = null;
    this.reconnectTimer = null;
    this.nextId = Math.floor(Math.random() * 65535);
    this.outgoing = {};
    this.on('connect', function() {
      if (this.disconnected) {
        return;
      }
      this.connected = true;
      var outStore = null;
      outStore = this.outgoingStore.createStream();
      outStore.once('readable', function() {
        function storeDeliver() {
          var packet = outStore.read(1);
          var cb;
          if (!packet) {
            return;
          }
          if (!that.disconnecting && !that.reconnectTimer && that.options.reconnectPeriod > 0) {
            outStore.read(0);
            cb = that.outgoing[packet.messageId];
            that.outgoing[packet.messageId] = function(err, status) {
              if (cb) {
                cb(err, status);
              }
              storeDeliver();
            };
            that._sendPacket(packet);
          } else if (outStore.destroy) {
            outStore.destroy();
          }
        }
        storeDeliver();
      }).on('error', this.emit.bind(this, 'error'));
    });
    this.on('close', function() {
      this.connected = false;
      clearTimeout(this.connackTimer);
    });
    this.on('connect', this._setupPingTimer);
    this.on('connect', function() {
      var queue = this.queue;
      function deliver() {
        var entry = queue.shift();
        var packet = null;
        if (!entry) {
          return;
        }
        packet = entry.packet;
        that._sendPacket(packet, function(err) {
          if (entry.cb) {
            entry.cb(err);
          }
          deliver();
        });
      }
      deliver();
    });
    this.on('connect', function() {
      if (this.options.clean && Object.keys(this._subscribedTopics).length > 0) {
        this.subscribe(this._subscribedTopics);
      }
    });
    this.on('close', function() {
      if (that.pingTimer !== null) {
        that.pingTimer.clear();
        that.pingTimer = null;
      }
    });
    this.on('close', this._setupReconnect);
    events.EventEmitter.call(this);
    this._setupStream();
  }
  inherits(MqttClient, events.EventEmitter);
  MqttClient.prototype._setupStream = function() {
    var connectPacket;
    var that = this;
    var writable = new Writable();
    var parser = mqttPacket.parser(this.options);
    var completeParse = null;
    var packets = [];
    this._clearReconnect();
    this.stream = this.streamBuilder(this);
    parser.on('packet', function(packet) {
      packets.push(packet);
    });
    function process() {
      var packet = packets.shift();
      var done = completeParse;
      if (packet) {
        that._handlePacket(packet, process);
      } else {
        completeParse = null;
        done();
      }
    }
    writable._write = function(buf, enc, done) {
      completeParse = done;
      parser.parse(buf);
      process();
    };
    this.stream.pipe(writable);
    this.stream.on('error', nop);
    eos(this.stream, this.emit.bind(this, 'close'));
    connectPacket = Object.create(this.options);
    connectPacket.cmd = 'connect';
    sendPacket(this, connectPacket);
    parser.on('error', this.emit.bind(this, 'error'));
    this.stream.setMaxListeners(1000);
    clearTimeout(this.connackTimer);
    this.connackTimer = setTimeout(function() {
      that._cleanUp(true);
    }, this.options.connectTimeout);
  };
  MqttClient.prototype._handlePacket = function(packet, done) {
    this.emit('packetreceive', packet);
    switch (packet.cmd) {
      case 'publish':
        this._handlePublish(packet, done);
        break;
      case 'puback':
      case 'pubrec':
      case 'pubcomp':
      case 'suback':
      case 'unsuback':
        this._handleAck(packet);
        done();
        break;
      case 'pubrel':
        this._handlePubrel(packet, done);
        break;
      case 'connack':
        this._handleConnack(packet);
        done();
        break;
      case 'pingresp':
        this._handlePingresp(packet);
        done();
        break;
      default:
        break;
    }
  };
  MqttClient.prototype._checkDisconnecting = function(callback) {
    if (this.disconnecting) {
      if (callback) {
        callback(new Error('client disconnecting'));
      } else {
        this.emit('error', new Error('client disconnecting'));
      }
    }
    return this.disconnecting;
  };
  MqttClient.prototype.publish = function(topic, message, opts, callback) {
    var packet;
    if (typeof opts === 'function') {
      callback = opts;
      opts = null;
    }
    if (!opts) {
      opts = {
        qos: 0,
        retain: false
      };
    }
    if (this._checkDisconnecting(callback)) {
      return this;
    }
    packet = {
      cmd: 'publish',
      topic: topic,
      payload: message,
      qos: opts.qos,
      retain: opts.retain,
      messageId: this._nextId()
    };
    switch (opts.qos) {
      case 1:
      case 2:
        this.outgoing[packet.messageId] = callback || nop;
        this._sendPacket(packet);
        break;
      default:
        this._sendPacket(packet, callback);
        break;
    }
    return this;
  };
  MqttClient.prototype.subscribe = function() {
    var packet;
    var args = Array.prototype.slice.call(arguments);
    var subs = [];
    var obj = args.shift();
    var callback = args.pop() || nop;
    var opts = args.pop();
    var invalidTopic;
    var that = this;
    if (typeof obj === 'string') {
      obj = [obj];
    }
    if (typeof callback !== 'function') {
      opts = callback;
      callback = nop;
    }
    invalidTopic = validations.validateTopics(obj);
    if (invalidTopic !== null) {
      setImmediate(callback, new Error('Invalid topic ' + invalidTopic));
      return this;
    }
    if (this._checkDisconnecting(callback)) {
      return this;
    }
    if (!opts) {
      opts = {qos: 0};
    }
    if (Array.isArray(obj)) {
      obj.forEach(function(topic) {
        subs.push({
          topic: topic,
          qos: opts.qos
        });
      });
    } else {
      Object.keys(obj).forEach(function(k) {
        subs.push({
          topic: k,
          qos: obj[k]
        });
      });
    }
    packet = {
      cmd: 'subscribe',
      subscriptions: subs,
      qos: 1,
      retain: false,
      dup: false,
      messageId: this._nextId()
    };
    this.outgoing[packet.messageId] = function(err, packet) {
      if (!err) {
        subs.forEach(function(sub) {
          that._subscribedTopics[sub.topic] = sub.qos;
        });
        var granted = packet.granted;
        for (var i = 0; i < granted.length; i += 1) {
          subs[i].qos = granted[i];
        }
      }
      callback(err, subs);
    };
    this._sendPacket(packet);
    return this;
  };
  MqttClient.prototype.unsubscribe = function(topic, callback) {
    var packet = {
      cmd: 'unsubscribe',
      qos: 1,
      messageId: this._nextId()
    };
    var that = this;
    callback = callback || nop;
    if (this._checkDisconnecting(callback)) {
      return this;
    }
    if (typeof topic === 'string') {
      packet.unsubscriptions = [topic];
    } else if (typeof topic === 'object' && topic.length) {
      packet.unsubscriptions = topic;
    }
    packet.unsubscriptions.forEach(function(topic) {
      delete that._subscribedTopics[topic];
    });
    this.outgoing[packet.messageId] = callback;
    this._sendPacket(packet);
    return this;
  };
  MqttClient.prototype.end = function(force, cb) {
    var that = this;
    if (typeof force === 'function') {
      cb = force;
      force = false;
    }
    function closeStores() {
      that.disconnected = true;
      that.incomingStore.close(function() {
        that.outgoingStore.close(cb);
      });
    }
    function finish() {
      that._cleanUp(force, setImmediate.bind(null, closeStores));
    }
    if (this.disconnecting) {
      return this;
    }
    this._clearReconnect();
    this.disconnecting = true;
    if (!force && Object.keys(this.outgoing).length > 0) {
      this.once('outgoingEmpty', setTimeout.bind(null, finish, 10));
    } else {
      finish();
    }
    return this;
  };
  MqttClient.prototype._reconnect = function() {
    this.emit('reconnect');
    this._setupStream();
  };
  MqttClient.prototype._setupReconnect = function() {
    var that = this;
    if (!that.disconnecting && !that.reconnectTimer && (that.options.reconnectPeriod > 0)) {
      if (!this.reconnecting) {
        this.emit('offline');
        this.reconnecting = true;
      }
      that.reconnectTimer = setInterval(function() {
        that._reconnect();
      }, that.options.reconnectPeriod);
    }
  };
  MqttClient.prototype._clearReconnect = function() {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  };
  MqttClient.prototype._cleanUp = function(forced, done) {
    if (done) {
      this.stream.on('close', done);
    }
    if (forced) {
      this.stream.destroy();
    } else {
      this._sendPacket({cmd: 'disconnect'}, setImmediate.bind(null, this.stream.end.bind(this.stream)));
    }
    if (!this.disconnecting) {
      this._clearReconnect();
      this._setupReconnect();
    }
    if (this.pingTimer !== null) {
      this.pingTimer.clear();
      this.pingTimer = null;
    }
  };
  MqttClient.prototype._sendPacket = function(packet, cb) {
    if (!this.connected) {
      if (packet.qos > 0 || packet.cmd !== 'publish' || this.queueQoSZero) {
        this.queue.push({
          packet: packet,
          cb: cb
        });
      } else if (cb) {
        cb(new Error('No connection to broker'));
      }
      return;
    }
    this._shiftPingInterval();
    if (packet.cmd !== 'publish') {
      sendPacket(this, packet, cb);
      return;
    }
    switch (packet.qos) {
      case 2:
      case 1:
        storeAndSend(this, packet, cb);
        break;
      case 0:
      default:
        sendPacket(this, packet, cb);
        break;
    }
  };
  MqttClient.prototype._setupPingTimer = function() {
    var that = this;
    if (!this.pingTimer && this.options.keepalive) {
      this.pingResp = true;
      this.pingTimer = reInterval(function() {
        that._checkPing();
      }, this.options.keepalive * 1000);
    }
  };
  MqttClient.prototype._shiftPingInterval = function() {
    if (this.pingTimer && this.options.keepalive && this.options.reschedulePings) {
      this.pingTimer.reschedule(this.options.keepalive * 1000);
    }
  };
  MqttClient.prototype._checkPing = function() {
    if (this.pingResp) {
      this.pingResp = false;
      this._sendPacket({cmd: 'pingreq'});
    } else {
      this._cleanUp(true);
    }
  };
  MqttClient.prototype._handlePingresp = function() {
    this.pingResp = true;
  };
  MqttClient.prototype._handleConnack = function(packet) {
    var rc = packet.returnCode;
    var errors = ['', 'Unacceptable protocol version', 'Identifier rejected', 'Server unavailable', 'Bad username or password', 'Not authorized'];
    clearTimeout(this.connackTimer);
    if (rc === 0) {
      this.reconnecting = false;
      this.emit('connect', packet);
    } else if (rc > 0) {
      this.emit('error', new Error('Connection refused: ' + errors[rc]));
    }
  };
  MqttClient.prototype._handlePublish = function(packet, done) {
    var topic = packet.topic.toString();
    var message = packet.payload;
    var qos = packet.qos;
    var mid = packet.messageId;
    var that = this;
    switch (qos) {
      case 2:
        this.incomingStore.put(packet, function() {
          that._sendPacket({
            cmd: 'pubrec',
            messageId: mid
          }, done);
        });
        break;
      case 1:
        this._sendPacket({
          cmd: 'puback',
          messageId: mid
        });
      case 0:
        this.emit('message', topic, message, packet);
        this.handleMessage(packet, done);
        break;
      default:
        break;
    }
  };
  MqttClient.prototype.handleMessage = function(packet, callback) {
    callback();
  };
  MqttClient.prototype._handleAck = function(packet) {
    var mid = packet.messageId;
    var type = packet.cmd;
    var response = null;
    var cb = this.outgoing[mid];
    var that = this;
    if (!cb) {
      return;
    }
    switch (type) {
      case 'pubcomp':
      case 'puback':
        delete this.outgoing[mid];
        this.outgoingStore.del(packet, cb);
        break;
      case 'pubrec':
        response = {
          cmd: 'pubrel',
          qos: 2,
          messageId: mid
        };
        this._sendPacket(response);
        break;
      case 'suback':
        delete this.outgoing[mid];
        cb(null, packet);
        break;
      case 'unsuback':
        delete this.outgoing[mid];
        cb(null);
        break;
      default:
        that.emit('error', new Error('unrecognized packet type'));
    }
    if (this.disconnecting && Object.keys(this.outgoing).length === 0) {
      this.emit('outgoingEmpty');
    }
  };
  MqttClient.prototype._handlePubrel = function(packet, callback) {
    var mid = packet.messageId;
    var that = this;
    that.incomingStore.get(packet, function(err, pub) {
      if (err) {
        return that.emit('error', err);
      }
      if (pub.cmd !== 'pubrel') {
        that.emit('message', pub.topic, pub.payload, pub);
        that.incomingStore.put(packet);
      }
      that._sendPacket({
        cmd: 'pubcomp',
        messageId: mid
      }, callback);
    });
  };
  MqttClient.prototype._nextId = function() {
    var id = this.nextId++;
    if (id === 65535) {
      this.nextId = 1;
    }
    return id;
  };
  MqttClient.prototype.getLastMessageId = function() {
    return (this.nextId === 1) ? 65535 : (this.nextId - 1);
  };
  module.exports = MqttClient;
})(require('buffer').Buffer, require('process'));
