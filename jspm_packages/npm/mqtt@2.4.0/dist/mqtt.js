/* */ 
"format cjs";
(function(Buffer, process) {
  (function(f) {
    if (typeof exports === "object" && typeof module !== "undefined") {
      module.exports = f();
    } else if (typeof define === "function" && define.amd) {
      define([], f);
    } else {
      var g;
      if (typeof window !== "undefined") {
        g = window;
      } else if (typeof global !== "undefined") {
        g = global;
      } else if (typeof self !== "undefined") {
        g = self;
      } else {
        g = this;
      }
      g.mqtt = f();
    }
  })(function() {
    var define,
        module,
        exports;
    return (function e(t, n, r) {
      function s(o, u) {
        if (!n[o]) {
          if (!t[o]) {
            var a = typeof require == "function" && require;
            if (!u && a)
              return a(o, !0);
            if (i)
              return i(o, !0);
            var f = new Error("Cannot find module '" + o + "'");
            throw f.code = "MODULE_NOT_FOUND", f;
          }
          var l = n[o] = {exports: {}};
          t[o][0].call(l.exports, function(e) {
            var n = t[o][1][e];
            return s(n ? n : e);
          }, l, l.exports, e, t, n, r);
        }
        return n[o].exports;
      }
      var i = typeof require == "function" && require;
      for (var o = 0; o < r.length; o++)
        s(r[o]);
      return s;
    })({
      1: [function(require, module, exports) {
        (function(process, global) {
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
        }).call(this, require('_process'), typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
      }, {
        "./store": 5,
        "./validations": 6,
        "_process": 31,
        "end-of-stream": 16,
        "events": 17,
        "inherits": 19,
        "mqtt-packet": 24,
        "readable-stream": 43,
        "reinterval": 45
      }],
      2: [function(require, module, exports) {
        'use strict';
        var net = require('@empty');
        function buildBuilder(client, opts) {
          var port,
              host;
          opts.port = opts.port || 1883;
          opts.hostname = opts.hostname || opts.host || 'localhost';
          port = opts.port;
          host = opts.hostname;
          return net.createConnection(port, host);
        }
        module.exports = buildBuilder;
      }, {"net": 10}],
      3: [function(require, module, exports) {
        'use strict';
        var tls = require('@empty');
        function buildBuilder(mqttClient, opts) {
          var connection;
          opts.port = opts.port || 8883;
          opts.host = opts.hostname || opts.host || 'localhost';
          opts.rejectUnauthorized = opts.rejectUnauthorized !== false;
          connection = tls.connect(opts);
          connection.on('secureConnect', function() {
            if (opts.rejectUnauthorized && !connection.authorized) {
              connection.emit('error', new Error('TLS not authorized'));
            } else {
              connection.removeListener('error', handleTLSerrors);
            }
          });
          function handleTLSerrors(err) {
            if (opts.rejectUnauthorized) {
              mqttClient.emit('error', err);
            }
            connection.end();
          }
          connection.on('error', handleTLSerrors);
          return connection;
        }
        module.exports = buildBuilder;
      }, {"tls": 10}],
      4: [function(require, module, exports) {
        (function(process) {
          'use strict';
          var websocket = require('websocket-stream');
          var urlModule = require('url');
          var WSS_OPTIONS = ['rejectUnauthorized', 'ca', 'cert', 'key', 'pfx', 'passphrase'];
          var IS_BROWSER = process.title === 'browser';
          function buildUrl(opts, client) {
            var url = opts.protocol + '://' + opts.hostname + ':' + opts.port + opts.path;
            if (typeof(opts.transformWsUrl) === 'function') {
              url = opts.transformWsUrl(url, opts, client);
            }
            return url;
          }
          function setDefaultOpts(opts) {
            if (!opts.hostname) {
              opts.hostname = 'localhost';
            }
            if (!opts.port) {
              if (opts.protocol === 'wss') {
                opts.port = 443;
              } else {
                opts.port = 80;
              }
            }
            if (!opts.path) {
              opts.path = '/';
            }
            if (!opts.wsOptions) {
              opts.wsOptions = {};
            }
            if (!IS_BROWSER && opts.protocol === 'wss') {
              WSS_OPTIONS.forEach(function(prop) {
                if (opts.hasOwnProperty(prop) && !opts.wsOptions.hasOwnProperty(prop)) {
                  opts.wsOptions[prop] = opts[prop];
                }
              });
            }
          }
          function createWebSocket(client, opts) {
            var websocketSubProtocol = (opts.protocolId === 'MQIsdp') && (opts.protocolVersion === 3) ? 'mqttv3.1' : 'mqtt';
            setDefaultOpts(opts);
            var url = buildUrl(opts, client);
            return websocket(url, [websocketSubProtocol], opts.wsOptions);
          }
          function buildBuilder(client, opts) {
            return createWebSocket(client, opts);
          }
          function buildBuilderBrowser(client, opts) {
            if (!opts.hostname) {
              opts.hostname = opts.host;
            }
            if (!opts.hostname) {
              if (typeof(document) === 'undefined') {
                throw new Error('Could not determine host. Specify host manually.');
              }
              var parsed = urlModule.parse(document.URL);
              opts.hostname = parsed.hostname;
              if (!opts.port) {
                opts.port = parsed.port;
              }
            }
            return createWebSocket(client, opts);
          }
          if (IS_BROWSER) {
            module.exports = buildBuilderBrowser;
          } else {
            module.exports = buildBuilder;
          }
        }).call(this, require('_process'));
      }, {
        "_process": 31,
        "url": 49,
        "websocket-stream": 55
      }],
      5: [function(require, module, exports) {
        (function(process) {
          'use strict';
          var Readable = require('readable-stream').Readable;
          var streamsOpts = {objectMode: true};
          function Store() {
            if (!(this instanceof Store)) {
              return new Store();
            }
            this._inflights = {};
          }
          Store.prototype.put = function(packet, cb) {
            this._inflights[packet.messageId] = packet;
            if (cb) {
              cb();
            }
            return this;
          };
          Store.prototype.createStream = function() {
            var stream = new Readable(streamsOpts);
            var inflights = this._inflights;
            var ids = Object.keys(this._inflights);
            var destroyed = false;
            var i = 0;
            stream._read = function() {
              if (!destroyed && i < ids.length) {
                this.push(inflights[ids[i++]]);
              } else {
                this.push(null);
              }
            };
            stream.destroy = function() {
              if (destroyed) {
                return;
              }
              var self = this;
              destroyed = true;
              process.nextTick(function() {
                self.emit('close');
              });
            };
            return stream;
          };
          Store.prototype.del = function(packet, cb) {
            packet = this._inflights[packet.messageId];
            if (packet) {
              delete this._inflights[packet.messageId];
              cb(null, packet);
            } else if (cb) {
              cb(new Error('missing packet'));
            }
            return this;
          };
          Store.prototype.get = function(packet, cb) {
            packet = this._inflights[packet.messageId];
            if (packet) {
              cb(null, packet);
            } else if (cb) {
              cb(new Error('missing packet'));
            }
            return this;
          };
          Store.prototype.close = function(cb) {
            this._inflights = null;
            if (cb) {
              cb();
            }
          };
          module.exports = Store;
        }).call(this, require('_process'));
      }, {
        "_process": 31,
        "readable-stream": 43
      }],
      6: [function(require, module, exports) {
        'use strict';
        function validateTopic(topic) {
          var parts = topic.split('/');
          for (var i = 0; i < parts.length; i++) {
            if (parts[i] === '+') {
              continue;
            }
            if (parts[i] === '#') {
              return i === parts.length - 1;
            }
            if (parts[i].indexOf('+') !== -1 || parts[i].indexOf('#') !== -1) {
              return false;
            }
          }
          return true;
        }
        function validateTopics(topics) {
          if (topics.length === 0) {
            return 'empty_topic_list';
          }
          for (var i = 0; i < topics.length; i++) {
            if (!validateTopic(topics[i])) {
              return topics[i];
            }
          }
          return null;
        }
        module.exports = {validateTopics: validateTopics};
      }, {}],
      7: [function(require, module, exports) {
        (function(process) {
          'use strict';
          var MqttClient = require('../client');
          var url = require('url');
          var xtend = require('xtend');
          var protocols = {};
          if (process.title !== 'browser') {
            protocols.mqtt = require('./tcp');
            protocols.tcp = require('./tcp');
            protocols.ssl = require('./tls');
            protocols.tls = require('./tls');
            protocols.mqtts = require('./tls');
          }
          protocols.ws = require('./ws');
          protocols.wss = require('./ws');
          function parseAuthOptions(opts) {
            var matches;
            if (opts.auth) {
              matches = opts.auth.match(/^(.+):(.+)$/);
              if (matches) {
                opts.username = matches[1];
                opts.password = matches[2];
              } else {
                opts.username = opts.auth;
              }
            }
          }
          function connect(brokerUrl, opts) {
            if ((typeof brokerUrl === 'object') && !opts) {
              opts = brokerUrl;
              brokerUrl = null;
            }
            opts = opts || {};
            if (brokerUrl) {
              opts = xtend(url.parse(brokerUrl, true), opts);
              if (opts.protocol === null) {
                throw new Error('Missing protocol');
              }
              opts.protocol = opts.protocol.replace(/:$/, '');
            }
            parseAuthOptions(opts);
            if (opts.query && typeof opts.query.clientId === 'string') {
              opts.clientId = opts.query.clientId;
            }
            if (opts.cert && opts.key) {
              if (opts.protocol) {
                if (['mqtts', 'wss'].indexOf(opts.protocol) === -1) {
                  switch (opts.protocol) {
                    case 'mqtt':
                      opts.protocol = 'mqtts';
                      break;
                    case 'ws':
                      opts.protocol = 'wss';
                      break;
                    default:
                      throw new Error('Unknown protocol for secure connection: "' + opts.protocol + '"!');
                      break;
                  }
                }
              } else {
                throw new Error('Missing secure protocol key');
              }
            }
            if (!protocols[opts.protocol]) {
              var isSecure = ['mqtts', 'wss'].indexOf(opts.protocol) !== -1;
              opts.protocol = ['mqtt', 'mqtts', 'ws', 'wss'].filter(function(key, index) {
                if (isSecure && index % 2 === 0) {
                  return false;
                }
                return (typeof protocols[key] === 'function');
              })[0];
            }
            if (opts.clean === false && !opts.clientId) {
              throw new Error('Missing clientId for unclean clients');
            }
            function wrapper(client) {
              if (opts.servers) {
                if (!client._reconnectCount || client._reconnectCount === opts.servers.length) {
                  client._reconnectCount = 0;
                }
                opts.host = opts.servers[client._reconnectCount].host;
                opts.port = opts.servers[client._reconnectCount].port;
                opts.hostname = opts.host;
                client._reconnectCount++;
              }
              return protocols[opts.protocol](client, opts);
            }
            return new MqttClient(wrapper, opts);
          }
          module.exports = connect;
          module.exports.connect = connect;
          module.exports.MqttClient = MqttClient;
        }).call(this, require('_process'));
      }, {
        "../client": 1,
        "./tcp": 2,
        "./tls": 3,
        "./ws": 4,
        "_process": 31,
        "url": 49,
        "xtend": 58
      }],
      8: [function(require, module, exports) {
        'use strict';
        exports.byteLength = byteLength;
        exports.toByteArray = toByteArray;
        exports.fromByteArray = fromByteArray;
        var lookup = [];
        var revLookup = [];
        var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array;
        var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        for (var i = 0,
            len = code.length; i < len; ++i) {
          lookup[i] = code[i];
          revLookup[code.charCodeAt(i)] = i;
        }
        revLookup['-'.charCodeAt(0)] = 62;
        revLookup['_'.charCodeAt(0)] = 63;
        function placeHoldersCount(b64) {
          var len = b64.length;
          if (len % 4 > 0) {
            throw new Error('Invalid string. Length must be a multiple of 4');
          }
          return b64[len - 2] === '=' ? 2 : b64[len - 1] === '=' ? 1 : 0;
        }
        function byteLength(b64) {
          return b64.length * 3 / 4 - placeHoldersCount(b64);
        }
        function toByteArray(b64) {
          var i,
              j,
              l,
              tmp,
              placeHolders,
              arr;
          var len = b64.length;
          placeHolders = placeHoldersCount(b64);
          arr = new Arr(len * 3 / 4 - placeHolders);
          l = placeHolders > 0 ? len - 4 : len;
          var L = 0;
          for (i = 0, j = 0; i < l; i += 4, j += 3) {
            tmp = (revLookup[b64.charCodeAt(i)] << 18) | (revLookup[b64.charCodeAt(i + 1)] << 12) | (revLookup[b64.charCodeAt(i + 2)] << 6) | revLookup[b64.charCodeAt(i + 3)];
            arr[L++] = (tmp >> 16) & 0xFF;
            arr[L++] = (tmp >> 8) & 0xFF;
            arr[L++] = tmp & 0xFF;
          }
          if (placeHolders === 2) {
            tmp = (revLookup[b64.charCodeAt(i)] << 2) | (revLookup[b64.charCodeAt(i + 1)] >> 4);
            arr[L++] = tmp & 0xFF;
          } else if (placeHolders === 1) {
            tmp = (revLookup[b64.charCodeAt(i)] << 10) | (revLookup[b64.charCodeAt(i + 1)] << 4) | (revLookup[b64.charCodeAt(i + 2)] >> 2);
            arr[L++] = (tmp >> 8) & 0xFF;
            arr[L++] = tmp & 0xFF;
          }
          return arr;
        }
        function tripletToBase64(num) {
          return lookup[num >> 18 & 0x3F] + lookup[num >> 12 & 0x3F] + lookup[num >> 6 & 0x3F] + lookup[num & 0x3F];
        }
        function encodeChunk(uint8, start, end) {
          var tmp;
          var output = [];
          for (var i = start; i < end; i += 3) {
            tmp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2]);
            output.push(tripletToBase64(tmp));
          }
          return output.join('');
        }
        function fromByteArray(uint8) {
          var tmp;
          var len = uint8.length;
          var extraBytes = len % 3;
          var output = '';
          var parts = [];
          var maxChunkLength = 16383;
          for (var i = 0,
              len2 = len - extraBytes; i < len2; i += maxChunkLength) {
            parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)));
          }
          if (extraBytes === 1) {
            tmp = uint8[len - 1];
            output += lookup[tmp >> 2];
            output += lookup[(tmp << 4) & 0x3F];
            output += '==';
          } else if (extraBytes === 2) {
            tmp = (uint8[len - 2] << 8) + (uint8[len - 1]);
            output += lookup[tmp >> 10];
            output += lookup[(tmp >> 4) & 0x3F];
            output += lookup[(tmp << 2) & 0x3F];
            output += '=';
          }
          parts.push(output);
          return parts.join('');
        }
      }, {}],
      9: [function(require, module, exports) {
        (function(Buffer) {
          var DuplexStream = require('readable-stream/duplex'),
              util = require('util');
          function BufferList(callback) {
            if (!(this instanceof BufferList))
              return new BufferList(callback);
            this._bufs = [];
            this.length = 0;
            if (typeof callback == 'function') {
              this._callback = callback;
              var piper = function piper(err) {
                if (this._callback) {
                  this._callback(err);
                  this._callback = null;
                }
              }.bind(this);
              this.on('pipe', function onPipe(src) {
                src.on('error', piper);
              });
              this.on('unpipe', function onUnpipe(src) {
                src.removeListener('error', piper);
              });
            } else {
              this.append(callback);
            }
            DuplexStream.call(this);
          }
          util.inherits(BufferList, DuplexStream);
          BufferList.prototype._offset = function _offset(offset) {
            var tot = 0,
                i = 0,
                _t;
            if (offset === 0)
              return [0, 0];
            for (; i < this._bufs.length; i++) {
              _t = tot + this._bufs[i].length;
              if (offset < _t || i == this._bufs.length - 1)
                return [i, offset - tot];
              tot = _t;
            }
          };
          BufferList.prototype.append = function append(buf) {
            var i = 0;
            if (Buffer.isBuffer(buf)) {
              this._appendBuffer(buf);
            } else if (Array.isArray(buf)) {
              for (; i < buf.length; i++)
                this.append(buf[i]);
            } else if (buf instanceof BufferList) {
              for (; i < buf._bufs.length; i++)
                this.append(buf._bufs[i]);
            } else if (buf != null) {
              if (typeof buf == 'number')
                buf = buf.toString();
              this._appendBuffer(new Buffer(buf));
            }
            return this;
          };
          BufferList.prototype._appendBuffer = function appendBuffer(buf) {
            this._bufs.push(buf);
            this.length += buf.length;
          };
          BufferList.prototype._write = function _write(buf, encoding, callback) {
            this._appendBuffer(buf);
            if (typeof callback == 'function')
              callback();
          };
          BufferList.prototype._read = function _read(size) {
            if (!this.length)
              return this.push(null);
            size = Math.min(size, this.length);
            this.push(this.slice(0, size));
            this.consume(size);
          };
          BufferList.prototype.end = function end(chunk) {
            DuplexStream.prototype.end.call(this, chunk);
            if (this._callback) {
              this._callback(null, this.slice());
              this._callback = null;
            }
          };
          BufferList.prototype.get = function get(index) {
            return this.slice(index, index + 1)[0];
          };
          BufferList.prototype.slice = function slice(start, end) {
            if (typeof start == 'number' && start < 0)
              start += this.length;
            if (typeof end == 'number' && end < 0)
              end += this.length;
            return this.copy(null, 0, start, end);
          };
          BufferList.prototype.copy = function copy(dst, dstStart, srcStart, srcEnd) {
            if (typeof srcStart != 'number' || srcStart < 0)
              srcStart = 0;
            if (typeof srcEnd != 'number' || srcEnd > this.length)
              srcEnd = this.length;
            if (srcStart >= this.length)
              return dst || new Buffer(0);
            if (srcEnd <= 0)
              return dst || new Buffer(0);
            var copy = !!dst,
                off = this._offset(srcStart),
                len = srcEnd - srcStart,
                bytes = len,
                bufoff = (copy && dstStart) || 0,
                start = off[1],
                l,
                i;
            if (srcStart === 0 && srcEnd == this.length) {
              if (!copy) {
                return this._bufs.length === 1 ? this._bufs[0] : Buffer.concat(this._bufs, this.length);
              }
              for (i = 0; i < this._bufs.length; i++) {
                this._bufs[i].copy(dst, bufoff);
                bufoff += this._bufs[i].length;
              }
              return dst;
            }
            if (bytes <= this._bufs[off[0]].length - start) {
              return copy ? this._bufs[off[0]].copy(dst, dstStart, start, start + bytes) : this._bufs[off[0]].slice(start, start + bytes);
            }
            if (!copy)
              dst = new Buffer(len);
            for (i = off[0]; i < this._bufs.length; i++) {
              l = this._bufs[i].length - start;
              if (bytes > l) {
                this._bufs[i].copy(dst, bufoff, start);
              } else {
                this._bufs[i].copy(dst, bufoff, start, start + bytes);
                break;
              }
              bufoff += l;
              bytes -= l;
              if (start)
                start = 0;
            }
            return dst;
          };
          BufferList.prototype.shallowSlice = function shallowSlice(start, end) {
            start = start || 0;
            end = end || this.length;
            if (start < 0)
              start += this.length;
            if (end < 0)
              end += this.length;
            var startOffset = this._offset(start),
                endOffset = this._offset(end),
                buffers = this._bufs.slice(startOffset[0], endOffset[0] + 1);
            if (startOffset[1] != 0)
              buffers[0] = buffers[0].slice(startOffset[1]);
            if (endOffset[1] == 0)
              buffers.pop();
            else
              buffers[buffers.length - 1] = buffers[buffers.length - 1].slice(0, endOffset[1]);
            return new BufferList(buffers);
          };
          BufferList.prototype.toString = function toString(encoding, start, end) {
            return this.slice(start, end).toString(encoding);
          };
          BufferList.prototype.consume = function consume(bytes) {
            while (this._bufs.length) {
              if (bytes >= this._bufs[0].length) {
                bytes -= this._bufs[0].length;
                this.length -= this._bufs[0].length;
                this._bufs.shift();
              } else {
                this._bufs[0] = this._bufs[0].slice(bytes);
                this.length -= bytes;
                break;
              }
            }
            return this;
          };
          BufferList.prototype.duplicate = function duplicate() {
            var i = 0,
                copy = new BufferList();
            for (; i < this._bufs.length; i++)
              copy.append(this._bufs[i]);
            return copy;
          };
          BufferList.prototype.destroy = function destroy() {
            this._bufs.length = 0;
            this.length = 0;
            this.push(null);
          };
          ;
          (function() {
            var methods = {
              'readDoubleBE': 8,
              'readDoubleLE': 8,
              'readFloatBE': 4,
              'readFloatLE': 4,
              'readInt32BE': 4,
              'readInt32LE': 4,
              'readUInt32BE': 4,
              'readUInt32LE': 4,
              'readInt16BE': 2,
              'readInt16LE': 2,
              'readUInt16BE': 2,
              'readUInt16LE': 2,
              'readInt8': 1,
              'readUInt8': 1
            };
            for (var m in methods) {
              (function(m) {
                BufferList.prototype[m] = function(offset) {
                  return this.slice(offset, offset + methods[m])[m](0);
                };
              }(m));
            }
          }());
          module.exports = BufferList;
        }).call(this, require('buffer').Buffer);
      }, {
        "buffer": 11,
        "readable-stream/duplex": 36,
        "util": 54
      }],
      10: [function(require, module, exports) {}, {}],
      11: [function(require, module, exports) {
        'use strict';
        var base64 = require('base64-js');
        var ieee754 = require('ieee754');
        exports.Buffer = Buffer;
        exports.SlowBuffer = SlowBuffer;
        exports.INSPECT_MAX_BYTES = 50;
        var K_MAX_LENGTH = 0x7fffffff;
        exports.kMaxLength = K_MAX_LENGTH;
        Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport();
        if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('This browser lacks typed array (Uint8Array) support which is required by ' + '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.');
        }
        function typedArraySupport() {
          try {
            var arr = new Uint8Array(1);
            arr.__proto__ = {
              __proto__: Uint8Array.prototype,
              foo: function() {
                return 42;
              }
            };
            return arr.foo() === 42;
          } catch (e) {
            return false;
          }
        }
        function createBuffer(length) {
          if (length > K_MAX_LENGTH) {
            throw new RangeError('Invalid typed array length');
          }
          var buf = new Uint8Array(length);
          buf.__proto__ = Buffer.prototype;
          return buf;
        }
        function Buffer(arg, encodingOrOffset, length) {
          if (typeof arg === 'number') {
            if (typeof encodingOrOffset === 'string') {
              throw new Error('If encoding is specified then the first argument must be a string');
            }
            return allocUnsafe(arg);
          }
          return from(arg, encodingOrOffset, length);
        }
        if (typeof Symbol !== 'undefined' && Symbol.species && Buffer[Symbol.species] === Buffer) {
          Object.defineProperty(Buffer, Symbol.species, {
            value: null,
            configurable: true,
            enumerable: false,
            writable: false
          });
        }
        Buffer.poolSize = 8192;
        function from(value, encodingOrOffset, length) {
          if (typeof value === 'number') {
            throw new TypeError('"value" argument must not be a number');
          }
          if (value instanceof ArrayBuffer) {
            return fromArrayBuffer(value, encodingOrOffset, length);
          }
          if (typeof value === 'string') {
            return fromString(value, encodingOrOffset);
          }
          return fromObject(value);
        }
        Buffer.from = function(value, encodingOrOffset, length) {
          return from(value, encodingOrOffset, length);
        };
        Buffer.prototype.__proto__ = Uint8Array.prototype;
        Buffer.__proto__ = Uint8Array;
        function assertSize(size) {
          if (typeof size !== 'number') {
            throw new TypeError('"size" argument must be a number');
          } else if (size < 0) {
            throw new RangeError('"size" argument must not be negative');
          }
        }
        function alloc(size, fill, encoding) {
          assertSize(size);
          if (size <= 0) {
            return createBuffer(size);
          }
          if (fill !== undefined) {
            return typeof encoding === 'string' ? createBuffer(size).fill(fill, encoding) : createBuffer(size).fill(fill);
          }
          return createBuffer(size);
        }
        Buffer.alloc = function(size, fill, encoding) {
          return alloc(size, fill, encoding);
        };
        function allocUnsafe(size) {
          assertSize(size);
          return createBuffer(size < 0 ? 0 : checked(size) | 0);
        }
        Buffer.allocUnsafe = function(size) {
          return allocUnsafe(size);
        };
        Buffer.allocUnsafeSlow = function(size) {
          return allocUnsafe(size);
        };
        function fromString(string, encoding) {
          if (typeof encoding !== 'string' || encoding === '') {
            encoding = 'utf8';
          }
          if (!Buffer.isEncoding(encoding)) {
            throw new TypeError('"encoding" must be a valid string encoding');
          }
          var length = byteLength(string, encoding) | 0;
          var buf = createBuffer(length);
          var actual = buf.write(string, encoding);
          if (actual !== length) {
            buf = buf.slice(0, actual);
          }
          return buf;
        }
        function fromArrayLike(array) {
          var length = array.length < 0 ? 0 : checked(array.length) | 0;
          var buf = createBuffer(length);
          for (var i = 0; i < length; i += 1) {
            buf[i] = array[i] & 255;
          }
          return buf;
        }
        function fromArrayBuffer(array, byteOffset, length) {
          if (byteOffset < 0 || array.byteLength < byteOffset) {
            throw new RangeError('\'offset\' is out of bounds');
          }
          if (array.byteLength < byteOffset + (length || 0)) {
            throw new RangeError('\'length\' is out of bounds');
          }
          var buf;
          if (byteOffset === undefined && length === undefined) {
            buf = new Uint8Array(array);
          } else if (length === undefined) {
            buf = new Uint8Array(array, byteOffset);
          } else {
            buf = new Uint8Array(array, byteOffset, length);
          }
          buf.__proto__ = Buffer.prototype;
          return buf;
        }
        function fromObject(obj) {
          if (Buffer.isBuffer(obj)) {
            var len = checked(obj.length) | 0;
            var buf = createBuffer(len);
            if (buf.length === 0) {
              return buf;
            }
            obj.copy(buf, 0, 0, len);
            return buf;
          }
          if (obj) {
            if (ArrayBuffer.isView(obj) || 'length' in obj) {
              if (typeof obj.length !== 'number' || isnan(obj.length)) {
                return createBuffer(0);
              }
              return fromArrayLike(obj);
            }
            if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
              return fromArrayLike(obj.data);
            }
          }
          throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.');
        }
        function checked(length) {
          if (length >= K_MAX_LENGTH) {
            throw new RangeError('Attempt to allocate Buffer larger than maximum ' + 'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes');
          }
          return length | 0;
        }
        function SlowBuffer(length) {
          if (+length != length) {
            length = 0;
          }
          return Buffer.alloc(+length);
        }
        Buffer.isBuffer = function isBuffer(b) {
          return b != null && b._isBuffer === true;
        };
        Buffer.compare = function compare(a, b) {
          if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
            throw new TypeError('Arguments must be Buffers');
          }
          if (a === b)
            return 0;
          var x = a.length;
          var y = b.length;
          for (var i = 0,
              len = Math.min(x, y); i < len; ++i) {
            if (a[i] !== b[i]) {
              x = a[i];
              y = b[i];
              break;
            }
          }
          if (x < y)
            return -1;
          if (y < x)
            return 1;
          return 0;
        };
        Buffer.isEncoding = function isEncoding(encoding) {
          switch (String(encoding).toLowerCase()) {
            case 'hex':
            case 'utf8':
            case 'utf-8':
            case 'ascii':
            case 'latin1':
            case 'binary':
            case 'base64':
            case 'ucs2':
            case 'ucs-2':
            case 'utf16le':
            case 'utf-16le':
              return true;
            default:
              return false;
          }
        };
        Buffer.concat = function concat(list, length) {
          if (!Array.isArray(list)) {
            throw new TypeError('"list" argument must be an Array of Buffers');
          }
          if (list.length === 0) {
            return Buffer.alloc(0);
          }
          var i;
          if (length === undefined) {
            length = 0;
            for (i = 0; i < list.length; ++i) {
              length += list[i].length;
            }
          }
          var buffer = Buffer.allocUnsafe(length);
          var pos = 0;
          for (i = 0; i < list.length; ++i) {
            var buf = list[i];
            if (!Buffer.isBuffer(buf)) {
              throw new TypeError('"list" argument must be an Array of Buffers');
            }
            buf.copy(buffer, pos);
            pos += buf.length;
          }
          return buffer;
        };
        function byteLength(string, encoding) {
          if (Buffer.isBuffer(string)) {
            return string.length;
          }
          if (ArrayBuffer.isView(string) || string instanceof ArrayBuffer) {
            return string.byteLength;
          }
          if (typeof string !== 'string') {
            string = '' + string;
          }
          var len = string.length;
          if (len === 0)
            return 0;
          var loweredCase = false;
          for (; ; ) {
            switch (encoding) {
              case 'ascii':
              case 'latin1':
              case 'binary':
                return len;
              case 'utf8':
              case 'utf-8':
              case undefined:
                return utf8ToBytes(string).length;
              case 'ucs2':
              case 'ucs-2':
              case 'utf16le':
              case 'utf-16le':
                return len * 2;
              case 'hex':
                return len >>> 1;
              case 'base64':
                return base64ToBytes(string).length;
              default:
                if (loweredCase)
                  return utf8ToBytes(string).length;
                encoding = ('' + encoding).toLowerCase();
                loweredCase = true;
            }
          }
        }
        Buffer.byteLength = byteLength;
        function slowToString(encoding, start, end) {
          var loweredCase = false;
          if (start === undefined || start < 0) {
            start = 0;
          }
          if (start > this.length) {
            return '';
          }
          if (end === undefined || end > this.length) {
            end = this.length;
          }
          if (end <= 0) {
            return '';
          }
          end >>>= 0;
          start >>>= 0;
          if (end <= start) {
            return '';
          }
          if (!encoding)
            encoding = 'utf8';
          while (true) {
            switch (encoding) {
              case 'hex':
                return hexSlice(this, start, end);
              case 'utf8':
              case 'utf-8':
                return utf8Slice(this, start, end);
              case 'ascii':
                return asciiSlice(this, start, end);
              case 'latin1':
              case 'binary':
                return latin1Slice(this, start, end);
              case 'base64':
                return base64Slice(this, start, end);
              case 'ucs2':
              case 'ucs-2':
              case 'utf16le':
              case 'utf-16le':
                return utf16leSlice(this, start, end);
              default:
                if (loweredCase)
                  throw new TypeError('Unknown encoding: ' + encoding);
                encoding = (encoding + '').toLowerCase();
                loweredCase = true;
            }
          }
        }
        Buffer.prototype._isBuffer = true;
        function swap(b, n, m) {
          var i = b[n];
          b[n] = b[m];
          b[m] = i;
        }
        Buffer.prototype.swap16 = function swap16() {
          var len = this.length;
          if (len % 2 !== 0) {
            throw new RangeError('Buffer size must be a multiple of 16-bits');
          }
          for (var i = 0; i < len; i += 2) {
            swap(this, i, i + 1);
          }
          return this;
        };
        Buffer.prototype.swap32 = function swap32() {
          var len = this.length;
          if (len % 4 !== 0) {
            throw new RangeError('Buffer size must be a multiple of 32-bits');
          }
          for (var i = 0; i < len; i += 4) {
            swap(this, i, i + 3);
            swap(this, i + 1, i + 2);
          }
          return this;
        };
        Buffer.prototype.swap64 = function swap64() {
          var len = this.length;
          if (len % 8 !== 0) {
            throw new RangeError('Buffer size must be a multiple of 64-bits');
          }
          for (var i = 0; i < len; i += 8) {
            swap(this, i, i + 7);
            swap(this, i + 1, i + 6);
            swap(this, i + 2, i + 5);
            swap(this, i + 3, i + 4);
          }
          return this;
        };
        Buffer.prototype.toString = function toString() {
          var length = this.length;
          if (length === 0)
            return '';
          if (arguments.length === 0)
            return utf8Slice(this, 0, length);
          return slowToString.apply(this, arguments);
        };
        Buffer.prototype.equals = function equals(b) {
          if (!Buffer.isBuffer(b))
            throw new TypeError('Argument must be a Buffer');
          if (this === b)
            return true;
          return Buffer.compare(this, b) === 0;
        };
        Buffer.prototype.inspect = function inspect() {
          var str = '';
          var max = exports.INSPECT_MAX_BYTES;
          if (this.length > 0) {
            str = this.toString('hex', 0, max).match(/.{2}/g).join(' ');
            if (this.length > max)
              str += ' ... ';
          }
          return '<Buffer ' + str + '>';
        };
        Buffer.prototype.compare = function compare(target, start, end, thisStart, thisEnd) {
          if (!Buffer.isBuffer(target)) {
            throw new TypeError('Argument must be a Buffer');
          }
          if (start === undefined) {
            start = 0;
          }
          if (end === undefined) {
            end = target ? target.length : 0;
          }
          if (thisStart === undefined) {
            thisStart = 0;
          }
          if (thisEnd === undefined) {
            thisEnd = this.length;
          }
          if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
            throw new RangeError('out of range index');
          }
          if (thisStart >= thisEnd && start >= end) {
            return 0;
          }
          if (thisStart >= thisEnd) {
            return -1;
          }
          if (start >= end) {
            return 1;
          }
          start >>>= 0;
          end >>>= 0;
          thisStart >>>= 0;
          thisEnd >>>= 0;
          if (this === target)
            return 0;
          var x = thisEnd - thisStart;
          var y = end - start;
          var len = Math.min(x, y);
          var thisCopy = this.slice(thisStart, thisEnd);
          var targetCopy = target.slice(start, end);
          for (var i = 0; i < len; ++i) {
            if (thisCopy[i] !== targetCopy[i]) {
              x = thisCopy[i];
              y = targetCopy[i];
              break;
            }
          }
          if (x < y)
            return -1;
          if (y < x)
            return 1;
          return 0;
        };
        function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
          if (buffer.length === 0)
            return -1;
          if (typeof byteOffset === 'string') {
            encoding = byteOffset;
            byteOffset = 0;
          } else if (byteOffset > 0x7fffffff) {
            byteOffset = 0x7fffffff;
          } else if (byteOffset < -0x80000000) {
            byteOffset = -0x80000000;
          }
          byteOffset = +byteOffset;
          if (isNaN(byteOffset)) {
            byteOffset = dir ? 0 : (buffer.length - 1);
          }
          if (byteOffset < 0)
            byteOffset = buffer.length + byteOffset;
          if (byteOffset >= buffer.length) {
            if (dir)
              return -1;
            else
              byteOffset = buffer.length - 1;
          } else if (byteOffset < 0) {
            if (dir)
              byteOffset = 0;
            else
              return -1;
          }
          if (typeof val === 'string') {
            val = Buffer.from(val, encoding);
          }
          if (Buffer.isBuffer(val)) {
            if (val.length === 0) {
              return -1;
            }
            return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
          } else if (typeof val === 'number') {
            val = val & 0xFF;
            if (typeof Uint8Array.prototype.indexOf === 'function') {
              if (dir) {
                return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
              } else {
                return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
              }
            }
            return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
          }
          throw new TypeError('val must be string, number or Buffer');
        }
        function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
          var indexSize = 1;
          var arrLength = arr.length;
          var valLength = val.length;
          if (encoding !== undefined) {
            encoding = String(encoding).toLowerCase();
            if (encoding === 'ucs2' || encoding === 'ucs-2' || encoding === 'utf16le' || encoding === 'utf-16le') {
              if (arr.length < 2 || val.length < 2) {
                return -1;
              }
              indexSize = 2;
              arrLength /= 2;
              valLength /= 2;
              byteOffset /= 2;
            }
          }
          function read(buf, i) {
            if (indexSize === 1) {
              return buf[i];
            } else {
              return buf.readUInt16BE(i * indexSize);
            }
          }
          var i;
          if (dir) {
            var foundIndex = -1;
            for (i = byteOffset; i < arrLength; i++) {
              if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
                if (foundIndex === -1)
                  foundIndex = i;
                if (i - foundIndex + 1 === valLength)
                  return foundIndex * indexSize;
              } else {
                if (foundIndex !== -1)
                  i -= i - foundIndex;
                foundIndex = -1;
              }
            }
          } else {
            if (byteOffset + valLength > arrLength)
              byteOffset = arrLength - valLength;
            for (i = byteOffset; i >= 0; i--) {
              var found = true;
              for (var j = 0; j < valLength; j++) {
                if (read(arr, i + j) !== read(val, j)) {
                  found = false;
                  break;
                }
              }
              if (found)
                return i;
            }
          }
          return -1;
        }
        Buffer.prototype.includes = function includes(val, byteOffset, encoding) {
          return this.indexOf(val, byteOffset, encoding) !== -1;
        };
        Buffer.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
          return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
        };
        Buffer.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
          return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
        };
        function hexWrite(buf, string, offset, length) {
          offset = Number(offset) || 0;
          var remaining = buf.length - offset;
          if (!length) {
            length = remaining;
          } else {
            length = Number(length);
            if (length > remaining) {
              length = remaining;
            }
          }
          var strLen = string.length;
          if (strLen % 2 !== 0)
            throw new TypeError('Invalid hex string');
          if (length > strLen / 2) {
            length = strLen / 2;
          }
          for (var i = 0; i < length; ++i) {
            var parsed = parseInt(string.substr(i * 2, 2), 16);
            if (isNaN(parsed))
              return i;
            buf[offset + i] = parsed;
          }
          return i;
        }
        function utf8Write(buf, string, offset, length) {
          return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
        }
        function asciiWrite(buf, string, offset, length) {
          return blitBuffer(asciiToBytes(string), buf, offset, length);
        }
        function latin1Write(buf, string, offset, length) {
          return asciiWrite(buf, string, offset, length);
        }
        function base64Write(buf, string, offset, length) {
          return blitBuffer(base64ToBytes(string), buf, offset, length);
        }
        function ucs2Write(buf, string, offset, length) {
          return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
        }
        Buffer.prototype.write = function write(string, offset, length, encoding) {
          if (offset === undefined) {
            encoding = 'utf8';
            length = this.length;
            offset = 0;
          } else if (length === undefined && typeof offset === 'string') {
            encoding = offset;
            length = this.length;
            offset = 0;
          } else if (isFinite(offset)) {
            offset = offset >>> 0;
            if (isFinite(length)) {
              length = length >>> 0;
              if (encoding === undefined)
                encoding = 'utf8';
            } else {
              encoding = length;
              length = undefined;
            }
          } else {
            throw new Error('Buffer.write(string, encoding, offset[, length]) is no longer supported');
          }
          var remaining = this.length - offset;
          if (length === undefined || length > remaining)
            length = remaining;
          if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
            throw new RangeError('Attempt to write outside buffer bounds');
          }
          if (!encoding)
            encoding = 'utf8';
          var loweredCase = false;
          for (; ; ) {
            switch (encoding) {
              case 'hex':
                return hexWrite(this, string, offset, length);
              case 'utf8':
              case 'utf-8':
                return utf8Write(this, string, offset, length);
              case 'ascii':
                return asciiWrite(this, string, offset, length);
              case 'latin1':
              case 'binary':
                return latin1Write(this, string, offset, length);
              case 'base64':
                return base64Write(this, string, offset, length);
              case 'ucs2':
              case 'ucs-2':
              case 'utf16le':
              case 'utf-16le':
                return ucs2Write(this, string, offset, length);
              default:
                if (loweredCase)
                  throw new TypeError('Unknown encoding: ' + encoding);
                encoding = ('' + encoding).toLowerCase();
                loweredCase = true;
            }
          }
        };
        Buffer.prototype.toJSON = function toJSON() {
          return {
            type: 'Buffer',
            data: Array.prototype.slice.call(this._arr || this, 0)
          };
        };
        function base64Slice(buf, start, end) {
          if (start === 0 && end === buf.length) {
            return base64.fromByteArray(buf);
          } else {
            return base64.fromByteArray(buf.slice(start, end));
          }
        }
        function utf8Slice(buf, start, end) {
          end = Math.min(buf.length, end);
          var res = [];
          var i = start;
          while (i < end) {
            var firstByte = buf[i];
            var codePoint = null;
            var bytesPerSequence = (firstByte > 0xEF) ? 4 : (firstByte > 0xDF) ? 3 : (firstByte > 0xBF) ? 2 : 1;
            if (i + bytesPerSequence <= end) {
              var secondByte,
                  thirdByte,
                  fourthByte,
                  tempCodePoint;
              switch (bytesPerSequence) {
                case 1:
                  if (firstByte < 0x80) {
                    codePoint = firstByte;
                  }
                  break;
                case 2:
                  secondByte = buf[i + 1];
                  if ((secondByte & 0xC0) === 0x80) {
                    tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F);
                    if (tempCodePoint > 0x7F) {
                      codePoint = tempCodePoint;
                    }
                  }
                  break;
                case 3:
                  secondByte = buf[i + 1];
                  thirdByte = buf[i + 2];
                  if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
                    tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F);
                    if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
                      codePoint = tempCodePoint;
                    }
                  }
                  break;
                case 4:
                  secondByte = buf[i + 1];
                  thirdByte = buf[i + 2];
                  fourthByte = buf[i + 3];
                  if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
                    tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F);
                    if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
                      codePoint = tempCodePoint;
                    }
                  }
              }
            }
            if (codePoint === null) {
              codePoint = 0xFFFD;
              bytesPerSequence = 1;
            } else if (codePoint > 0xFFFF) {
              codePoint -= 0x10000;
              res.push(codePoint >>> 10 & 0x3FF | 0xD800);
              codePoint = 0xDC00 | codePoint & 0x3FF;
            }
            res.push(codePoint);
            i += bytesPerSequence;
          }
          return decodeCodePointsArray(res);
        }
        var MAX_ARGUMENTS_LENGTH = 0x1000;
        function decodeCodePointsArray(codePoints) {
          var len = codePoints.length;
          if (len <= MAX_ARGUMENTS_LENGTH) {
            return String.fromCharCode.apply(String, codePoints);
          }
          var res = '';
          var i = 0;
          while (i < len) {
            res += String.fromCharCode.apply(String, codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH));
          }
          return res;
        }
        function asciiSlice(buf, start, end) {
          var ret = '';
          end = Math.min(buf.length, end);
          for (var i = start; i < end; ++i) {
            ret += String.fromCharCode(buf[i] & 0x7F);
          }
          return ret;
        }
        function latin1Slice(buf, start, end) {
          var ret = '';
          end = Math.min(buf.length, end);
          for (var i = start; i < end; ++i) {
            ret += String.fromCharCode(buf[i]);
          }
          return ret;
        }
        function hexSlice(buf, start, end) {
          var len = buf.length;
          if (!start || start < 0)
            start = 0;
          if (!end || end < 0 || end > len)
            end = len;
          var out = '';
          for (var i = start; i < end; ++i) {
            out += toHex(buf[i]);
          }
          return out;
        }
        function utf16leSlice(buf, start, end) {
          var bytes = buf.slice(start, end);
          var res = '';
          for (var i = 0; i < bytes.length; i += 2) {
            res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256));
          }
          return res;
        }
        Buffer.prototype.slice = function slice(start, end) {
          var len = this.length;
          start = ~~start;
          end = end === undefined ? len : ~~end;
          if (start < 0) {
            start += len;
            if (start < 0)
              start = 0;
          } else if (start > len) {
            start = len;
          }
          if (end < 0) {
            end += len;
            if (end < 0)
              end = 0;
          } else if (end > len) {
            end = len;
          }
          if (end < start)
            end = start;
          var newBuf = this.subarray(start, end);
          newBuf.__proto__ = Buffer.prototype;
          return newBuf;
        };
        function checkOffset(offset, ext, length) {
          if ((offset % 1) !== 0 || offset < 0)
            throw new RangeError('offset is not uint');
          if (offset + ext > length)
            throw new RangeError('Trying to access beyond buffer length');
        }
        Buffer.prototype.readUIntLE = function readUIntLE(offset, byteLength, noAssert) {
          offset = offset >>> 0;
          byteLength = byteLength >>> 0;
          if (!noAssert)
            checkOffset(offset, byteLength, this.length);
          var val = this[offset];
          var mul = 1;
          var i = 0;
          while (++i < byteLength && (mul *= 0x100)) {
            val += this[offset + i] * mul;
          }
          return val;
        };
        Buffer.prototype.readUIntBE = function readUIntBE(offset, byteLength, noAssert) {
          offset = offset >>> 0;
          byteLength = byteLength >>> 0;
          if (!noAssert) {
            checkOffset(offset, byteLength, this.length);
          }
          var val = this[offset + --byteLength];
          var mul = 1;
          while (byteLength > 0 && (mul *= 0x100)) {
            val += this[offset + --byteLength] * mul;
          }
          return val;
        };
        Buffer.prototype.readUInt8 = function readUInt8(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 1, this.length);
          return this[offset];
        };
        Buffer.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 2, this.length);
          return this[offset] | (this[offset + 1] << 8);
        };
        Buffer.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 2, this.length);
          return (this[offset] << 8) | this[offset + 1];
        };
        Buffer.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 4, this.length);
          return ((this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16)) + (this[offset + 3] * 0x1000000);
        };
        Buffer.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 4, this.length);
          return (this[offset] * 0x1000000) + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]);
        };
        Buffer.prototype.readIntLE = function readIntLE(offset, byteLength, noAssert) {
          offset = offset >>> 0;
          byteLength = byteLength >>> 0;
          if (!noAssert)
            checkOffset(offset, byteLength, this.length);
          var val = this[offset];
          var mul = 1;
          var i = 0;
          while (++i < byteLength && (mul *= 0x100)) {
            val += this[offset + i] * mul;
          }
          mul *= 0x80;
          if (val >= mul)
            val -= Math.pow(2, 8 * byteLength);
          return val;
        };
        Buffer.prototype.readIntBE = function readIntBE(offset, byteLength, noAssert) {
          offset = offset >>> 0;
          byteLength = byteLength >>> 0;
          if (!noAssert)
            checkOffset(offset, byteLength, this.length);
          var i = byteLength;
          var mul = 1;
          var val = this[offset + --i];
          while (i > 0 && (mul *= 0x100)) {
            val += this[offset + --i] * mul;
          }
          mul *= 0x80;
          if (val >= mul)
            val -= Math.pow(2, 8 * byteLength);
          return val;
        };
        Buffer.prototype.readInt8 = function readInt8(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 1, this.length);
          if (!(this[offset] & 0x80))
            return (this[offset]);
          return ((0xff - this[offset] + 1) * -1);
        };
        Buffer.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 2, this.length);
          var val = this[offset] | (this[offset + 1] << 8);
          return (val & 0x8000) ? val | 0xFFFF0000 : val;
        };
        Buffer.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 2, this.length);
          var val = this[offset + 1] | (this[offset] << 8);
          return (val & 0x8000) ? val | 0xFFFF0000 : val;
        };
        Buffer.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 4, this.length);
          return (this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24);
        };
        Buffer.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 4, this.length);
          return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | (this[offset + 3]);
        };
        Buffer.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 4, this.length);
          return ieee754.read(this, offset, true, 23, 4);
        };
        Buffer.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 4, this.length);
          return ieee754.read(this, offset, false, 23, 4);
        };
        Buffer.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 8, this.length);
          return ieee754.read(this, offset, true, 52, 8);
        };
        Buffer.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
          offset = offset >>> 0;
          if (!noAssert)
            checkOffset(offset, 8, this.length);
          return ieee754.read(this, offset, false, 52, 8);
        };
        function checkInt(buf, value, offset, ext, max, min) {
          if (!Buffer.isBuffer(buf))
            throw new TypeError('"buffer" argument must be a Buffer instance');
          if (value > max || value < min)
            throw new RangeError('"value" argument is out of bounds');
          if (offset + ext > buf.length)
            throw new RangeError('Index out of range');
        }
        Buffer.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength, noAssert) {
          value = +value;
          offset = offset >>> 0;
          byteLength = byteLength >>> 0;
          if (!noAssert) {
            var maxBytes = Math.pow(2, 8 * byteLength) - 1;
            checkInt(this, value, offset, byteLength, maxBytes, 0);
          }
          var mul = 1;
          var i = 0;
          this[offset] = value & 0xFF;
          while (++i < byteLength && (mul *= 0x100)) {
            this[offset + i] = (value / mul) & 0xFF;
          }
          return offset + byteLength;
        };
        Buffer.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength, noAssert) {
          value = +value;
          offset = offset >>> 0;
          byteLength = byteLength >>> 0;
          if (!noAssert) {
            var maxBytes = Math.pow(2, 8 * byteLength) - 1;
            checkInt(this, value, offset, byteLength, maxBytes, 0);
          }
          var i = byteLength - 1;
          var mul = 1;
          this[offset + i] = value & 0xFF;
          while (--i >= 0 && (mul *= 0x100)) {
            this[offset + i] = (value / mul) & 0xFF;
          }
          return offset + byteLength;
        };
        Buffer.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 1, 0xff, 0);
          this[offset] = (value & 0xff);
          return offset + 1;
        };
        Buffer.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 2, 0xffff, 0);
          this[offset] = (value & 0xff);
          this[offset + 1] = (value >>> 8);
          return offset + 2;
        };
        Buffer.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 2, 0xffff, 0);
          this[offset] = (value >>> 8);
          this[offset + 1] = (value & 0xff);
          return offset + 2;
        };
        Buffer.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 4, 0xffffffff, 0);
          this[offset + 3] = (value >>> 24);
          this[offset + 2] = (value >>> 16);
          this[offset + 1] = (value >>> 8);
          this[offset] = (value & 0xff);
          return offset + 4;
        };
        Buffer.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 4, 0xffffffff, 0);
          this[offset] = (value >>> 24);
          this[offset + 1] = (value >>> 16);
          this[offset + 2] = (value >>> 8);
          this[offset + 3] = (value & 0xff);
          return offset + 4;
        };
        Buffer.prototype.writeIntLE = function writeIntLE(value, offset, byteLength, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert) {
            var limit = Math.pow(2, (8 * byteLength) - 1);
            checkInt(this, value, offset, byteLength, limit - 1, -limit);
          }
          var i = 0;
          var mul = 1;
          var sub = 0;
          this[offset] = value & 0xFF;
          while (++i < byteLength && (mul *= 0x100)) {
            if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
              sub = 1;
            }
            this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
          }
          return offset + byteLength;
        };
        Buffer.prototype.writeIntBE = function writeIntBE(value, offset, byteLength, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert) {
            var limit = Math.pow(2, (8 * byteLength) - 1);
            checkInt(this, value, offset, byteLength, limit - 1, -limit);
          }
          var i = byteLength - 1;
          var mul = 1;
          var sub = 0;
          this[offset + i] = value & 0xFF;
          while (--i >= 0 && (mul *= 0x100)) {
            if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
              sub = 1;
            }
            this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
          }
          return offset + byteLength;
        };
        Buffer.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 1, 0x7f, -0x80);
          if (value < 0)
            value = 0xff + value + 1;
          this[offset] = (value & 0xff);
          return offset + 1;
        };
        Buffer.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 2, 0x7fff, -0x8000);
          this[offset] = (value & 0xff);
          this[offset + 1] = (value >>> 8);
          return offset + 2;
        };
        Buffer.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 2, 0x7fff, -0x8000);
          this[offset] = (value >>> 8);
          this[offset + 1] = (value & 0xff);
          return offset + 2;
        };
        Buffer.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
          this[offset] = (value & 0xff);
          this[offset + 1] = (value >>> 8);
          this[offset + 2] = (value >>> 16);
          this[offset + 3] = (value >>> 24);
          return offset + 4;
        };
        Buffer.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert)
            checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
          if (value < 0)
            value = 0xffffffff + value + 1;
          this[offset] = (value >>> 24);
          this[offset + 1] = (value >>> 16);
          this[offset + 2] = (value >>> 8);
          this[offset + 3] = (value & 0xff);
          return offset + 4;
        };
        function checkIEEE754(buf, value, offset, ext, max, min) {
          if (offset + ext > buf.length)
            throw new RangeError('Index out of range');
          if (offset < 0)
            throw new RangeError('Index out of range');
        }
        function writeFloat(buf, value, offset, littleEndian, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert) {
            checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38);
          }
          ieee754.write(buf, value, offset, littleEndian, 23, 4);
          return offset + 4;
        }
        Buffer.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
          return writeFloat(this, value, offset, true, noAssert);
        };
        Buffer.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
          return writeFloat(this, value, offset, false, noAssert);
        };
        function writeDouble(buf, value, offset, littleEndian, noAssert) {
          value = +value;
          offset = offset >>> 0;
          if (!noAssert) {
            checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308);
          }
          ieee754.write(buf, value, offset, littleEndian, 52, 8);
          return offset + 8;
        }
        Buffer.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
          return writeDouble(this, value, offset, true, noAssert);
        };
        Buffer.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
          return writeDouble(this, value, offset, false, noAssert);
        };
        Buffer.prototype.copy = function copy(target, targetStart, start, end) {
          if (!start)
            start = 0;
          if (!end && end !== 0)
            end = this.length;
          if (targetStart >= target.length)
            targetStart = target.length;
          if (!targetStart)
            targetStart = 0;
          if (end > 0 && end < start)
            end = start;
          if (end === start)
            return 0;
          if (target.length === 0 || this.length === 0)
            return 0;
          if (targetStart < 0) {
            throw new RangeError('targetStart out of bounds');
          }
          if (start < 0 || start >= this.length)
            throw new RangeError('sourceStart out of bounds');
          if (end < 0)
            throw new RangeError('sourceEnd out of bounds');
          if (end > this.length)
            end = this.length;
          if (target.length - targetStart < end - start) {
            end = target.length - targetStart + start;
          }
          var len = end - start;
          var i;
          if (this === target && start < targetStart && targetStart < end) {
            for (i = len - 1; i >= 0; --i) {
              target[i + targetStart] = this[i + start];
            }
          } else if (len < 1000) {
            for (i = 0; i < len; ++i) {
              target[i + targetStart] = this[i + start];
            }
          } else {
            Uint8Array.prototype.set.call(target, this.subarray(start, start + len), targetStart);
          }
          return len;
        };
        Buffer.prototype.fill = function fill(val, start, end, encoding) {
          if (typeof val === 'string') {
            if (typeof start === 'string') {
              encoding = start;
              start = 0;
              end = this.length;
            } else if (typeof end === 'string') {
              encoding = end;
              end = this.length;
            }
            if (val.length === 1) {
              var code = val.charCodeAt(0);
              if (code < 256) {
                val = code;
              }
            }
            if (encoding !== undefined && typeof encoding !== 'string') {
              throw new TypeError('encoding must be a string');
            }
            if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
              throw new TypeError('Unknown encoding: ' + encoding);
            }
          } else if (typeof val === 'number') {
            val = val & 255;
          }
          if (start < 0 || this.length < start || this.length < end) {
            throw new RangeError('Out of range index');
          }
          if (end <= start) {
            return this;
          }
          start = start >>> 0;
          end = end === undefined ? this.length : end >>> 0;
          if (!val)
            val = 0;
          var i;
          if (typeof val === 'number') {
            for (i = start; i < end; ++i) {
              this[i] = val;
            }
          } else {
            var bytes = Buffer.isBuffer(val) ? val : new Buffer(val, encoding);
            var len = bytes.length;
            for (i = 0; i < end - start; ++i) {
              this[i + start] = bytes[i % len];
            }
          }
          return this;
        };
        var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;
        function base64clean(str) {
          str = stringtrim(str).replace(INVALID_BASE64_RE, '');
          if (str.length < 2)
            return '';
          while (str.length % 4 !== 0) {
            str = str + '=';
          }
          return str;
        }
        function stringtrim(str) {
          if (str.trim)
            return str.trim();
          return str.replace(/^\s+|\s+$/g, '');
        }
        function toHex(n) {
          if (n < 16)
            return '0' + n.toString(16);
          return n.toString(16);
        }
        function utf8ToBytes(string, units) {
          units = units || Infinity;
          var codePoint;
          var length = string.length;
          var leadSurrogate = null;
          var bytes = [];
          for (var i = 0; i < length; ++i) {
            codePoint = string.charCodeAt(i);
            if (codePoint > 0xD7FF && codePoint < 0xE000) {
              if (!leadSurrogate) {
                if (codePoint > 0xDBFF) {
                  if ((units -= 3) > -1)
                    bytes.push(0xEF, 0xBF, 0xBD);
                  continue;
                } else if (i + 1 === length) {
                  if ((units -= 3) > -1)
                    bytes.push(0xEF, 0xBF, 0xBD);
                  continue;
                }
                leadSurrogate = codePoint;
                continue;
              }
              if (codePoint < 0xDC00) {
                if ((units -= 3) > -1)
                  bytes.push(0xEF, 0xBF, 0xBD);
                leadSurrogate = codePoint;
                continue;
              }
              codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000;
            } else if (leadSurrogate) {
              if ((units -= 3) > -1)
                bytes.push(0xEF, 0xBF, 0xBD);
            }
            leadSurrogate = null;
            if (codePoint < 0x80) {
              if ((units -= 1) < 0)
                break;
              bytes.push(codePoint);
            } else if (codePoint < 0x800) {
              if ((units -= 2) < 0)
                break;
              bytes.push(codePoint >> 0x6 | 0xC0, codePoint & 0x3F | 0x80);
            } else if (codePoint < 0x10000) {
              if ((units -= 3) < 0)
                break;
              bytes.push(codePoint >> 0xC | 0xE0, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
            } else if (codePoint < 0x110000) {
              if ((units -= 4) < 0)
                break;
              bytes.push(codePoint >> 0x12 | 0xF0, codePoint >> 0xC & 0x3F | 0x80, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
            } else {
              throw new Error('Invalid code point');
            }
          }
          return bytes;
        }
        function asciiToBytes(str) {
          var byteArray = [];
          for (var i = 0; i < str.length; ++i) {
            byteArray.push(str.charCodeAt(i) & 0xFF);
          }
          return byteArray;
        }
        function utf16leToBytes(str, units) {
          var c,
              hi,
              lo;
          var byteArray = [];
          for (var i = 0; i < str.length; ++i) {
            if ((units -= 2) < 0)
              break;
            c = str.charCodeAt(i);
            hi = c >> 8;
            lo = c % 256;
            byteArray.push(lo);
            byteArray.push(hi);
          }
          return byteArray;
        }
        function base64ToBytes(str) {
          return base64.toByteArray(base64clean(str));
        }
        function blitBuffer(src, dst, offset, length) {
          for (var i = 0; i < length; ++i) {
            if ((i + offset >= dst.length) || (i >= src.length))
              break;
            dst[i + offset] = src[i];
          }
          return i;
        }
        function isnan(val) {
          return val !== val;
        }
      }, {
        "base64-js": 8,
        "ieee754": 18
      }],
      12: [function(require, module, exports) {
        (function(global) {
          'use strict';
          var buffer = require('buffer');
          var Buffer = buffer.Buffer;
          var SlowBuffer = buffer.SlowBuffer;
          var MAX_LEN = buffer.kMaxLength || 2147483647;
          exports.alloc = function alloc(size, fill, encoding) {
            if (typeof Buffer.alloc === 'function') {
              return Buffer.alloc(size, fill, encoding);
            }
            if (typeof encoding === 'number') {
              throw new TypeError('encoding must not be number');
            }
            if (typeof size !== 'number') {
              throw new TypeError('size must be a number');
            }
            if (size > MAX_LEN) {
              throw new RangeError('size is too large');
            }
            var enc = encoding;
            var _fill = fill;
            if (_fill === undefined) {
              enc = undefined;
              _fill = 0;
            }
            var buf = new Buffer(size);
            if (typeof _fill === 'string') {
              var fillBuf = new Buffer(_fill, enc);
              var flen = fillBuf.length;
              var i = -1;
              while (++i < size) {
                buf[i] = fillBuf[i % flen];
              }
            } else {
              buf.fill(_fill);
            }
            return buf;
          };
          exports.allocUnsafe = function allocUnsafe(size) {
            if (typeof Buffer.allocUnsafe === 'function') {
              return Buffer.allocUnsafe(size);
            }
            if (typeof size !== 'number') {
              throw new TypeError('size must be a number');
            }
            if (size > MAX_LEN) {
              throw new RangeError('size is too large');
            }
            return new Buffer(size);
          };
          exports.from = function from(value, encodingOrOffset, length) {
            if (typeof Buffer.from === 'function' && (!global.Uint8Array || Uint8Array.from !== Buffer.from)) {
              return Buffer.from(value, encodingOrOffset, length);
            }
            if (typeof value === 'number') {
              throw new TypeError('"value" argument must not be a number');
            }
            if (typeof value === 'string') {
              return new Buffer(value, encodingOrOffset);
            }
            if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
              var offset = encodingOrOffset;
              if (arguments.length === 1) {
                return new Buffer(value);
              }
              if (typeof offset === 'undefined') {
                offset = 0;
              }
              var len = length;
              if (typeof len === 'undefined') {
                len = value.byteLength - offset;
              }
              if (offset >= value.byteLength) {
                throw new RangeError('\'offset\' is out of bounds');
              }
              if (len > value.byteLength - offset) {
                throw new RangeError('\'length\' is out of bounds');
              }
              return new Buffer(value.slice(offset, offset + len));
            }
            if (Buffer.isBuffer(value)) {
              var out = new Buffer(value.length);
              value.copy(out, 0, 0, value.length);
              return out;
            }
            if (value) {
              if (Array.isArray(value) || (typeof ArrayBuffer !== 'undefined' && value.buffer instanceof ArrayBuffer) || 'length' in value) {
                return new Buffer(value);
              }
              if (value.type === 'Buffer' && Array.isArray(value.data)) {
                return new Buffer(value.data);
              }
            }
            throw new TypeError('First argument must be a string, Buffer, ' + 'ArrayBuffer, Array, or array-like object.');
          };
          exports.allocUnsafeSlow = function allocUnsafeSlow(size) {
            if (typeof Buffer.allocUnsafeSlow === 'function') {
              return Buffer.allocUnsafeSlow(size);
            }
            if (typeof size !== 'number') {
              throw new TypeError('size must be a number');
            }
            if (size >= MAX_LEN) {
              throw new RangeError('size is too large');
            }
            return new SlowBuffer(size);
          };
        }).call(this, typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
      }, {"buffer": 11}],
      13: [function(require, module, exports) {
        (function(Buffer) {
          function isArray(arg) {
            if (Array.isArray) {
              return Array.isArray(arg);
            }
            return objectToString(arg) === '[object Array]';
          }
          exports.isArray = isArray;
          function isBoolean(arg) {
            return typeof arg === 'boolean';
          }
          exports.isBoolean = isBoolean;
          function isNull(arg) {
            return arg === null;
          }
          exports.isNull = isNull;
          function isNullOrUndefined(arg) {
            return arg == null;
          }
          exports.isNullOrUndefined = isNullOrUndefined;
          function isNumber(arg) {
            return typeof arg === 'number';
          }
          exports.isNumber = isNumber;
          function isString(arg) {
            return typeof arg === 'string';
          }
          exports.isString = isString;
          function isSymbol(arg) {
            return typeof arg === 'symbol';
          }
          exports.isSymbol = isSymbol;
          function isUndefined(arg) {
            return arg === void 0;
          }
          exports.isUndefined = isUndefined;
          function isRegExp(re) {
            return objectToString(re) === '[object RegExp]';
          }
          exports.isRegExp = isRegExp;
          function isObject(arg) {
            return typeof arg === 'object' && arg !== null;
          }
          exports.isObject = isObject;
          function isDate(d) {
            return objectToString(d) === '[object Date]';
          }
          exports.isDate = isDate;
          function isError(e) {
            return (objectToString(e) === '[object Error]' || e instanceof Error);
          }
          exports.isError = isError;
          function isFunction(arg) {
            return typeof arg === 'function';
          }
          exports.isFunction = isFunction;
          function isPrimitive(arg) {
            return arg === null || typeof arg === 'boolean' || typeof arg === 'number' || typeof arg === 'string' || typeof arg === 'symbol' || typeof arg === 'undefined';
          }
          exports.isPrimitive = isPrimitive;
          exports.isBuffer = Buffer.isBuffer;
          function objectToString(o) {
            return Object.prototype.toString.call(o);
          }
        }).call(this, {"isBuffer": require('../../is-buffer/index')});
      }, {"../../is-buffer/index.js": 20}],
      14: [function(require, module, exports) {
        (function(process, Buffer) {
          var stream = require('readable-stream');
          var eos = require('end-of-stream');
          var inherits = require('inherits');
          var shift = require('stream-shift');
          var SIGNAL_FLUSH = new Buffer([0]);
          var onuncork = function(self, fn) {
            if (self._corked)
              self.once('uncork', fn);
            else
              fn();
          };
          var destroyer = function(self, end) {
            return function(err) {
              if (err)
                self.destroy(err.message === 'premature close' ? null : err);
              else if (end && !self._ended)
                self.end();
            };
          };
          var end = function(ws, fn) {
            if (!ws)
              return fn();
            if (ws._writableState && ws._writableState.finished)
              return fn();
            if (ws._writableState)
              return ws.end(fn);
            ws.end();
            fn();
          };
          var toStreams2 = function(rs) {
            return new (stream.Readable)({
              objectMode: true,
              highWaterMark: 16
            }).wrap(rs);
          };
          var Duplexify = function(writable, readable, opts) {
            if (!(this instanceof Duplexify))
              return new Duplexify(writable, readable, opts);
            stream.Duplex.call(this, opts);
            this._writable = null;
            this._readable = null;
            this._readable2 = null;
            this._forwardDestroy = !opts || opts.destroy !== false;
            this._forwardEnd = !opts || opts.end !== false;
            this._corked = 1;
            this._ondrain = null;
            this._drained = false;
            this._forwarding = false;
            this._unwrite = null;
            this._unread = null;
            this._ended = false;
            this.destroyed = false;
            if (writable)
              this.setWritable(writable);
            if (readable)
              this.setReadable(readable);
          };
          inherits(Duplexify, stream.Duplex);
          Duplexify.obj = function(writable, readable, opts) {
            if (!opts)
              opts = {};
            opts.objectMode = true;
            opts.highWaterMark = 16;
            return new Duplexify(writable, readable, opts);
          };
          Duplexify.prototype.cork = function() {
            if (++this._corked === 1)
              this.emit('cork');
          };
          Duplexify.prototype.uncork = function() {
            if (this._corked && --this._corked === 0)
              this.emit('uncork');
          };
          Duplexify.prototype.setWritable = function(writable) {
            if (this._unwrite)
              this._unwrite();
            if (this.destroyed) {
              if (writable && writable.destroy)
                writable.destroy();
              return;
            }
            if (writable === null || writable === false) {
              this.end();
              return;
            }
            var self = this;
            var unend = eos(writable, {
              writable: true,
              readable: false
            }, destroyer(this, this._forwardEnd));
            var ondrain = function() {
              var ondrain = self._ondrain;
              self._ondrain = null;
              if (ondrain)
                ondrain();
            };
            var clear = function() {
              self._writable.removeListener('drain', ondrain);
              unend();
            };
            if (this._unwrite)
              process.nextTick(ondrain);
            this._writable = writable;
            this._writable.on('drain', ondrain);
            this._unwrite = clear;
            this.uncork();
          };
          Duplexify.prototype.setReadable = function(readable) {
            if (this._unread)
              this._unread();
            if (this.destroyed) {
              if (readable && readable.destroy)
                readable.destroy();
              return;
            }
            if (readable === null || readable === false) {
              this.push(null);
              this.resume();
              return;
            }
            var self = this;
            var unend = eos(readable, {
              writable: false,
              readable: true
            }, destroyer(this));
            var onreadable = function() {
              self._forward();
            };
            var onend = function() {
              self.push(null);
            };
            var clear = function() {
              self._readable2.removeListener('readable', onreadable);
              self._readable2.removeListener('end', onend);
              unend();
            };
            this._drained = true;
            this._readable = readable;
            this._readable2 = readable._readableState ? readable : toStreams2(readable);
            this._readable2.on('readable', onreadable);
            this._readable2.on('end', onend);
            this._unread = clear;
            this._forward();
          };
          Duplexify.prototype._read = function() {
            this._drained = true;
            this._forward();
          };
          Duplexify.prototype._forward = function() {
            if (this._forwarding || !this._readable2 || !this._drained)
              return;
            this._forwarding = true;
            var data;
            while (this._drained && (data = shift(this._readable2)) !== null) {
              if (this.destroyed)
                continue;
              this._drained = this.push(data);
            }
            this._forwarding = false;
          };
          Duplexify.prototype.destroy = function(err) {
            if (this.destroyed)
              return;
            this.destroyed = true;
            var self = this;
            process.nextTick(function() {
              self._destroy(err);
            });
          };
          Duplexify.prototype._destroy = function(err) {
            if (err) {
              var ondrain = this._ondrain;
              this._ondrain = null;
              if (ondrain)
                ondrain(err);
              else
                this.emit('error', err);
            }
            if (this._forwardDestroy) {
              if (this._readable && this._readable.destroy)
                this._readable.destroy();
              if (this._writable && this._writable.destroy)
                this._writable.destroy();
            }
            this.emit('close');
          };
          Duplexify.prototype._write = function(data, enc, cb) {
            if (this.destroyed)
              return cb();
            if (this._corked)
              return onuncork(this, this._write.bind(this, data, enc, cb));
            if (data === SIGNAL_FLUSH)
              return this._finish(cb);
            if (!this._writable)
              return cb();
            if (this._writable.write(data) === false)
              this._ondrain = cb;
            else
              cb();
          };
          Duplexify.prototype._finish = function(cb) {
            var self = this;
            this.emit('preend');
            onuncork(this, function() {
              end(self._forwardEnd && self._writable, function() {
                if (self._writableState.prefinished === false)
                  self._writableState.prefinished = true;
                self.emit('prefinish');
                onuncork(self, cb);
              });
            });
          };
          Duplexify.prototype.end = function(data, enc, cb) {
            if (typeof data === 'function')
              return this.end(null, null, data);
            if (typeof enc === 'function')
              return this.end(data, null, enc);
            this._ended = true;
            if (data)
              this.write(data);
            if (!this._writableState.ending)
              this.write(SIGNAL_FLUSH);
            return stream.Writable.prototype.end.call(this, cb);
          };
          module.exports = Duplexify;
        }).call(this, require('_process'), require('buffer').Buffer);
      }, {
        "_process": 31,
        "buffer": 11,
        "end-of-stream": 15,
        "inherits": 19,
        "readable-stream": 43,
        "stream-shift": 46
      }],
      15: [function(require, module, exports) {
        var once = require('once');
        var noop = function() {};
        var isRequest = function(stream) {
          return stream.setHeader && typeof stream.abort === 'function';
        };
        var eos = function(stream, opts, callback) {
          if (typeof opts === 'function')
            return eos(stream, null, opts);
          if (!opts)
            opts = {};
          callback = once(callback || noop);
          var ws = stream._writableState;
          var rs = stream._readableState;
          var readable = opts.readable || (opts.readable !== false && stream.readable);
          var writable = opts.writable || (opts.writable !== false && stream.writable);
          var onlegacyfinish = function() {
            if (!stream.writable)
              onfinish();
          };
          var onfinish = function() {
            writable = false;
            if (!readable)
              callback();
          };
          var onend = function() {
            readable = false;
            if (!writable)
              callback();
          };
          var onclose = function() {
            if (readable && !(rs && rs.ended))
              return callback(new Error('premature close'));
            if (writable && !(ws && ws.ended))
              return callback(new Error('premature close'));
          };
          var onrequest = function() {
            stream.req.on('finish', onfinish);
          };
          if (isRequest(stream)) {
            stream.on('complete', onfinish);
            stream.on('abort', onclose);
            if (stream.req)
              onrequest();
            else
              stream.on('request', onrequest);
          } else if (writable && !ws) {
            stream.on('end', onlegacyfinish);
            stream.on('close', onlegacyfinish);
          }
          stream.on('end', onend);
          stream.on('finish', onfinish);
          if (opts.error !== false)
            stream.on('error', callback);
          stream.on('close', onclose);
          return function() {
            stream.removeListener('complete', onfinish);
            stream.removeListener('abort', onclose);
            stream.removeListener('request', onrequest);
            if (stream.req)
              stream.req.removeListener('finish', onfinish);
            stream.removeListener('end', onlegacyfinish);
            stream.removeListener('close', onlegacyfinish);
            stream.removeListener('finish', onfinish);
            stream.removeListener('end', onend);
            stream.removeListener('error', callback);
            stream.removeListener('close', onclose);
          };
        };
        module.exports = eos;
      }, {"once": 29}],
      16: [function(require, module, exports) {
        var once = require('once');
        var noop = function() {};
        var isRequest = function(stream) {
          return stream.setHeader && typeof stream.abort === 'function';
        };
        var isChildProcess = function(stream) {
          return stream.stdio && Array.isArray(stream.stdio) && stream.stdio.length === 3;
        };
        var eos = function(stream, opts, callback) {
          if (typeof opts === 'function')
            return eos(stream, null, opts);
          if (!opts)
            opts = {};
          callback = once(callback || noop);
          var ws = stream._writableState;
          var rs = stream._readableState;
          var readable = opts.readable || (opts.readable !== false && stream.readable);
          var writable = opts.writable || (opts.writable !== false && stream.writable);
          var onlegacyfinish = function() {
            if (!stream.writable)
              onfinish();
          };
          var onfinish = function() {
            writable = false;
            if (!readable)
              callback();
          };
          var onend = function() {
            readable = false;
            if (!writable)
              callback();
          };
          var onexit = function(exitCode) {
            callback(exitCode ? new Error('exited with error code: ' + exitCode) : null);
          };
          var onclose = function() {
            if (readable && !(rs && rs.ended))
              return callback(new Error('premature close'));
            if (writable && !(ws && ws.ended))
              return callback(new Error('premature close'));
          };
          var onrequest = function() {
            stream.req.on('finish', onfinish);
          };
          if (isRequest(stream)) {
            stream.on('complete', onfinish);
            stream.on('abort', onclose);
            if (stream.req)
              onrequest();
            else
              stream.on('request', onrequest);
          } else if (writable && !ws) {
            stream.on('end', onlegacyfinish);
            stream.on('close', onlegacyfinish);
          }
          if (isChildProcess(stream))
            stream.on('exit', onexit);
          stream.on('end', onend);
          stream.on('finish', onfinish);
          if (opts.error !== false)
            stream.on('error', callback);
          stream.on('close', onclose);
          return function() {
            stream.removeListener('complete', onfinish);
            stream.removeListener('abort', onclose);
            stream.removeListener('request', onrequest);
            if (stream.req)
              stream.req.removeListener('finish', onfinish);
            stream.removeListener('end', onlegacyfinish);
            stream.removeListener('close', onlegacyfinish);
            stream.removeListener('finish', onfinish);
            stream.removeListener('exit', onexit);
            stream.removeListener('end', onend);
            stream.removeListener('error', callback);
            stream.removeListener('close', onclose);
          };
        };
        module.exports = eos;
      }, {"once": 29}],
      17: [function(require, module, exports) {
        function EventEmitter() {
          this._events = this._events || {};
          this._maxListeners = this._maxListeners || undefined;
        }
        module.exports = EventEmitter;
        EventEmitter.EventEmitter = EventEmitter;
        EventEmitter.prototype._events = undefined;
        EventEmitter.prototype._maxListeners = undefined;
        EventEmitter.defaultMaxListeners = 10;
        EventEmitter.prototype.setMaxListeners = function(n) {
          if (!isNumber(n) || n < 0 || isNaN(n))
            throw TypeError('n must be a positive number');
          this._maxListeners = n;
          return this;
        };
        EventEmitter.prototype.emit = function(type) {
          var er,
              handler,
              len,
              args,
              i,
              listeners;
          if (!this._events)
            this._events = {};
          if (type === 'error') {
            if (!this._events.error || (isObject(this._events.error) && !this._events.error.length)) {
              er = arguments[1];
              if (er instanceof Error) {
                throw er;
              } else {
                var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
                err.context = er;
                throw err;
              }
            }
          }
          handler = this._events[type];
          if (isUndefined(handler))
            return false;
          if (isFunction(handler)) {
            switch (arguments.length) {
              case 1:
                handler.call(this);
                break;
              case 2:
                handler.call(this, arguments[1]);
                break;
              case 3:
                handler.call(this, arguments[1], arguments[2]);
                break;
              default:
                args = Array.prototype.slice.call(arguments, 1);
                handler.apply(this, args);
            }
          } else if (isObject(handler)) {
            args = Array.prototype.slice.call(arguments, 1);
            listeners = handler.slice();
            len = listeners.length;
            for (i = 0; i < len; i++)
              listeners[i].apply(this, args);
          }
          return true;
        };
        EventEmitter.prototype.addListener = function(type, listener) {
          var m;
          if (!isFunction(listener))
            throw TypeError('listener must be a function');
          if (!this._events)
            this._events = {};
          if (this._events.newListener)
            this.emit('newListener', type, isFunction(listener.listener) ? listener.listener : listener);
          if (!this._events[type])
            this._events[type] = listener;
          else if (isObject(this._events[type]))
            this._events[type].push(listener);
          else
            this._events[type] = [this._events[type], listener];
          if (isObject(this._events[type]) && !this._events[type].warned) {
            if (!isUndefined(this._maxListeners)) {
              m = this._maxListeners;
            } else {
              m = EventEmitter.defaultMaxListeners;
            }
            if (m && m > 0 && this._events[type].length > m) {
              this._events[type].warned = true;
              console.error('(node) warning: possible EventEmitter memory ' + 'leak detected. %d listeners added. ' + 'Use emitter.setMaxListeners() to increase limit.', this._events[type].length);
              if (typeof console.trace === 'function') {
                console.trace();
              }
            }
          }
          return this;
        };
        EventEmitter.prototype.on = EventEmitter.prototype.addListener;
        EventEmitter.prototype.once = function(type, listener) {
          if (!isFunction(listener))
            throw TypeError('listener must be a function');
          var fired = false;
          function g() {
            this.removeListener(type, g);
            if (!fired) {
              fired = true;
              listener.apply(this, arguments);
            }
          }
          g.listener = listener;
          this.on(type, g);
          return this;
        };
        EventEmitter.prototype.removeListener = function(type, listener) {
          var list,
              position,
              length,
              i;
          if (!isFunction(listener))
            throw TypeError('listener must be a function');
          if (!this._events || !this._events[type])
            return this;
          list = this._events[type];
          length = list.length;
          position = -1;
          if (list === listener || (isFunction(list.listener) && list.listener === listener)) {
            delete this._events[type];
            if (this._events.removeListener)
              this.emit('removeListener', type, listener);
          } else if (isObject(list)) {
            for (i = length; i-- > 0; ) {
              if (list[i] === listener || (list[i].listener && list[i].listener === listener)) {
                position = i;
                break;
              }
            }
            if (position < 0)
              return this;
            if (list.length === 1) {
              list.length = 0;
              delete this._events[type];
            } else {
              list.splice(position, 1);
            }
            if (this._events.removeListener)
              this.emit('removeListener', type, listener);
          }
          return this;
        };
        EventEmitter.prototype.removeAllListeners = function(type) {
          var key,
              listeners;
          if (!this._events)
            return this;
          if (!this._events.removeListener) {
            if (arguments.length === 0)
              this._events = {};
            else if (this._events[type])
              delete this._events[type];
            return this;
          }
          if (arguments.length === 0) {
            for (key in this._events) {
              if (key === 'removeListener')
                continue;
              this.removeAllListeners(key);
            }
            this.removeAllListeners('removeListener');
            this._events = {};
            return this;
          }
          listeners = this._events[type];
          if (isFunction(listeners)) {
            this.removeListener(type, listeners);
          } else if (listeners) {
            while (listeners.length)
              this.removeListener(type, listeners[listeners.length - 1]);
          }
          delete this._events[type];
          return this;
        };
        EventEmitter.prototype.listeners = function(type) {
          var ret;
          if (!this._events || !this._events[type])
            ret = [];
          else if (isFunction(this._events[type]))
            ret = [this._events[type]];
          else
            ret = this._events[type].slice();
          return ret;
        };
        EventEmitter.prototype.listenerCount = function(type) {
          if (this._events) {
            var evlistener = this._events[type];
            if (isFunction(evlistener))
              return 1;
            else if (evlistener)
              return evlistener.length;
          }
          return 0;
        };
        EventEmitter.listenerCount = function(emitter, type) {
          return emitter.listenerCount(type);
        };
        function isFunction(arg) {
          return typeof arg === 'function';
        }
        function isNumber(arg) {
          return typeof arg === 'number';
        }
        function isObject(arg) {
          return typeof arg === 'object' && arg !== null;
        }
        function isUndefined(arg) {
          return arg === void 0;
        }
      }, {}],
      18: [function(require, module, exports) {
        exports.read = function(buffer, offset, isLE, mLen, nBytes) {
          var e,
              m;
          var eLen = nBytes * 8 - mLen - 1;
          var eMax = (1 << eLen) - 1;
          var eBias = eMax >> 1;
          var nBits = -7;
          var i = isLE ? (nBytes - 1) : 0;
          var d = isLE ? -1 : 1;
          var s = buffer[offset + i];
          i += d;
          e = s & ((1 << (-nBits)) - 1);
          s >>= (-nBits);
          nBits += eLen;
          for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}
          m = e & ((1 << (-nBits)) - 1);
          e >>= (-nBits);
          nBits += mLen;
          for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}
          if (e === 0) {
            e = 1 - eBias;
          } else if (e === eMax) {
            return m ? NaN : ((s ? -1 : 1) * Infinity);
          } else {
            m = m + Math.pow(2, mLen);
            e = e - eBias;
          }
          return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
        };
        exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
          var e,
              m,
              c;
          var eLen = nBytes * 8 - mLen - 1;
          var eMax = (1 << eLen) - 1;
          var eBias = eMax >> 1;
          var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0);
          var i = isLE ? 0 : (nBytes - 1);
          var d = isLE ? 1 : -1;
          var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;
          value = Math.abs(value);
          if (isNaN(value) || value === Infinity) {
            m = isNaN(value) ? 1 : 0;
            e = eMax;
          } else {
            e = Math.floor(Math.log(value) / Math.LN2);
            if (value * (c = Math.pow(2, -e)) < 1) {
              e--;
              c *= 2;
            }
            if (e + eBias >= 1) {
              value += rt / c;
            } else {
              value += rt * Math.pow(2, 1 - eBias);
            }
            if (value * c >= 2) {
              e++;
              c /= 2;
            }
            if (e + eBias >= eMax) {
              m = 0;
              e = eMax;
            } else if (e + eBias >= 1) {
              m = (value * c - 1) * Math.pow(2, mLen);
              e = e + eBias;
            } else {
              m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
              e = 0;
            }
          }
          for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}
          e = (e << mLen) | m;
          eLen += mLen;
          for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}
          buffer[offset + i - d] |= s * 128;
        };
      }, {}],
      19: [function(require, module, exports) {
        if (typeof Object.create === 'function') {
          module.exports = function inherits(ctor, superCtor) {
            ctor.super_ = superCtor;
            ctor.prototype = Object.create(superCtor.prototype, {constructor: {
                value: ctor,
                enumerable: false,
                writable: true,
                configurable: true
              }});
          };
        } else {
          module.exports = function inherits(ctor, superCtor) {
            ctor.super_ = superCtor;
            var TempCtor = function() {};
            TempCtor.prototype = superCtor.prototype;
            ctor.prototype = new TempCtor();
            ctor.prototype.constructor = ctor;
          };
        }
      }, {}],
      20: [function(require, module, exports) {
        module.exports = function(obj) {
          return obj != null && (isBuffer(obj) || isSlowBuffer(obj) || !!obj._isBuffer);
        };
        function isBuffer(obj) {
          return !!obj.constructor && typeof obj.constructor.isBuffer === 'function' && obj.constructor.isBuffer(obj);
        }
        function isSlowBuffer(obj) {
          return typeof obj.readFloatLE === 'function' && typeof obj.slice === 'function' && isBuffer(obj.slice(0, 0));
        }
      }, {}],
      21: [function(require, module, exports) {
        var toString = {}.toString;
        module.exports = Array.isArray || function(arr) {
          return toString.call(arr) == '[object Array]';
        };
      }, {}],
      22: [function(require, module, exports) {
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
        }).call(this, require('buffer').Buffer);
      }, {"buffer": 11}],
      23: [function(require, module, exports) {
        (function(Buffer) {
          'use strict';
          var writeToStream = require('./writeToStream');
          var EE = require('events').EventEmitter;
          var inherits = require('inherits');
          function generate(packet) {
            var stream = new Accumulator();
            writeToStream(packet, stream);
            return stream.concat();
          }
          function Accumulator() {
            this._array = new Array(20);
            this._i = 0;
          }
          inherits(Accumulator, EE);
          Accumulator.prototype.write = function(chunk) {
            this._array[this._i++] = chunk;
            return true;
          };
          Accumulator.prototype.concat = function() {
            var length = 0;
            var lengths = new Array(this._array.length);
            var list = this._array;
            var pos = 0;
            var i;
            var result;
            for (i = 0; i < list.length && list[i]; i++) {
              if (typeof list[i] !== 'string')
                lengths[i] = list[i].length;
              else
                lengths[i] = Buffer.byteLength(list[i]);
              length += lengths[i];
            }
            result = new Buffer(length);
            for (i = 0; i < list.length && list[i]; i++) {
              if (typeof list[i] !== 'string') {
                list[i].copy(result, pos);
                pos += lengths[i];
              } else {
                result.write(list[i], pos);
                pos += lengths[i];
              }
            }
            return result;
          };
          module.exports = generate;
        }).call(this, require('buffer').Buffer);
      }, {
        "./writeToStream": 28,
        "buffer": 11,
        "events": 17,
        "inherits": 19
      }],
      24: [function(require, module, exports) {
        'use strict';
        exports.parser = require('./parser');
        exports.generate = require('./generate');
        exports.writeToStream = require('./writeToStream');
      }, {
        "./generate": 23,
        "./parser": 27,
        "./writeToStream": 28
      }],
      25: [function(require, module, exports) {
        (function(Buffer) {
          'use strict';
          var max = 65536;
          var cache = {};
          var buffer;
          for (var i = 0; i < max; i++) {
            buffer = new Buffer(2);
            buffer.writeUInt8(i >> 8, 0, true);
            buffer.writeUInt8(i & 0x00FF, 0 + 1, true);
            cache[i] = buffer;
          }
          module.exports = cache;
        }).call(this, require('buffer').Buffer);
      }, {"buffer": 11}],
      26: [function(require, module, exports) {
        function Packet() {
          this.cmd = null;
          this.retain = false;
          this.qos = 0;
          this.dup = false;
          this.length = -1;
          this.topic = null;
          this.payload = null;
        }
        module.exports = Packet;
      }, {}],
      27: [function(require, module, exports) {
        'use strict';
        var bl = require('bl');
        var inherits = require('inherits');
        var EE = require('events').EventEmitter;
        var Packet = require('./packet');
        var constants = require('./constants');
        function Parser() {
          if (!(this instanceof Parser))
            return new Parser();
          this._states = ['_parseHeader', '_parseLength', '_parsePayload', '_newPacket'];
          this._resetState();
        }
        inherits(Parser, EE);
        Parser.prototype._resetState = function() {
          this.packet = new Packet();
          this.error = null;
          this._list = bl();
          this._stateCounter = 0;
        };
        Parser.prototype.parse = function(buf) {
          if (this.error)
            this._resetState();
          this._list.append(buf);
          while ((this.packet.length !== -1 || this._list.length > 0) && this[this._states[this._stateCounter]]() && !this.error) {
            this._stateCounter++;
            if (this._stateCounter >= this._states.length)
              this._stateCounter = 0;
          }
          return this._list.length;
        };
        Parser.prototype._parseHeader = function() {
          var zero = this._list.readUInt8(0);
          this.packet.cmd = constants.types[zero >> constants.CMD_SHIFT];
          this.packet.retain = (zero & constants.RETAIN_MASK) !== 0;
          this.packet.qos = (zero >> constants.QOS_SHIFT) & constants.QOS_MASK;
          this.packet.dup = (zero & constants.DUP_MASK) !== 0;
          this._list.consume(1);
          return true;
        };
        Parser.prototype._parseLength = function() {
          var bytes = 0;
          var mul = 1;
          var length = 0;
          var result = true;
          var current;
          while (bytes < 5) {
            current = this._list.readUInt8(bytes++);
            length += mul * (current & constants.LENGTH_MASK);
            mul *= 0x80;
            if ((current & constants.LENGTH_FIN_MASK) === 0)
              break;
            if (this._list.length <= bytes) {
              result = false;
              break;
            }
          }
          if (result) {
            this.packet.length = length;
            this._list.consume(bytes);
          }
          return result;
        };
        Parser.prototype._parsePayload = function() {
          var result = false;
          if (this.packet.length === 0 || this._list.length >= this.packet.length) {
            this._pos = 0;
            switch (this.packet.cmd) {
              case 'connect':
                this._parseConnect();
                break;
              case 'connack':
                this._parseConnack();
                break;
              case 'publish':
                this._parsePublish();
                break;
              case 'puback':
              case 'pubrec':
              case 'pubrel':
              case 'pubcomp':
                this._parseMessageId();
                break;
              case 'subscribe':
                this._parseSubscribe();
                break;
              case 'suback':
                this._parseSuback();
                break;
              case 'unsubscribe':
                this._parseUnsubscribe();
                break;
              case 'unsuback':
                this._parseUnsuback();
                break;
              case 'pingreq':
              case 'pingresp':
              case 'disconnect':
                break;
              default:
                this._emitError(new Error('Not supported'));
            }
            result = true;
          }
          return result;
        };
        Parser.prototype._parseConnect = function() {
          var protocolId;
          var clientId;
          var topic;
          var payload;
          var password;
          var username;
          var flags = {};
          var packet = this.packet;
          protocolId = this._parseString();
          if (protocolId === null)
            return this._emitError(new Error('Cannot parse protocol id'));
          if (protocolId !== 'MQTT' && protocolId !== 'MQIsdp') {
            return this._emitError(new Error('Invalid protocol id'));
          }
          packet.protocolId = protocolId;
          if (this._pos >= this._list.length)
            return this._emitError(new Error('Packet too short'));
          packet.protocolVersion = this._list.readUInt8(this._pos);
          if (packet.protocolVersion !== 3 && packet.protocolVersion !== 4) {
            return this._emitError(new Error('Invalid protocol version'));
          }
          this._pos++;
          if (this._pos >= this._list.length) {
            return this._emitError(new Error('Packet too short'));
          }
          flags.username = (this._list.readUInt8(this._pos) & constants.USERNAME_MASK);
          flags.password = (this._list.readUInt8(this._pos) & constants.PASSWORD_MASK);
          flags.will = (this._list.readUInt8(this._pos) & constants.WILL_FLAG_MASK);
          if (flags.will) {
            packet.will = {};
            packet.will.retain = (this._list.readUInt8(this._pos) & constants.WILL_RETAIN_MASK) !== 0;
            packet.will.qos = (this._list.readUInt8(this._pos) & constants.WILL_QOS_MASK) >> constants.WILL_QOS_SHIFT;
          }
          packet.clean = (this._list.readUInt8(this._pos) & constants.CLEAN_SESSION_MASK) !== 0;
          this._pos++;
          packet.keepalive = this._parseNum();
          if (packet.keepalive === -1)
            return this._emitError(new Error('Packet too short'));
          clientId = this._parseString();
          if (clientId === null)
            return this._emitError(new Error('Packet too short'));
          packet.clientId = clientId;
          if (flags.will) {
            topic = this._parseString();
            if (topic === null)
              return this._emitError(new Error('Cannot parse will topic'));
            packet.will.topic = topic;
            payload = this._parseBuffer();
            if (payload === null)
              return this._emitError(new Error('Cannot parse will payload'));
            packet.will.payload = payload;
          }
          if (flags.username) {
            username = this._parseString();
            if (username === null)
              return this._emitError(new Error('Cannot parse username'));
            packet.username = username;
          }
          if (flags.password) {
            password = this._parseBuffer();
            if (password === null)
              return this._emitError(new Error('Cannot parse password'));
            packet.password = password;
          }
          return packet;
        };
        Parser.prototype._parseConnack = function() {
          var packet = this.packet;
          if (this._list.length < 2)
            return null;
          packet.sessionPresent = !!(this._list.readUInt8(this._pos++) & constants.SESSIONPRESENT_MASK);
          packet.returnCode = this._list.readUInt8(this._pos);
          if (packet.returnCode === -1)
            return this._emitError(new Error('Cannot parse return code'));
        };
        Parser.prototype._parsePublish = function() {
          var packet = this.packet;
          packet.topic = this._parseString();
          if (packet.topic === null)
            return this._emitError(new Error('Cannot parse topic'));
          if (packet.qos > 0)
            if (!this._parseMessageId()) {
              return;
            }
          packet.payload = this._list.slice(this._pos, packet.length);
        };
        Parser.prototype._parseSubscribe = function() {
          var packet = this.packet;
          var topic;
          var qos;
          if (packet.qos !== 1) {
            return this._emitError(new Error('Wrong subscribe header'));
          }
          packet.subscriptions = [];
          if (!this._parseMessageId()) {
            return;
          }
          while (this._pos < packet.length) {
            topic = this._parseString();
            if (topic === null)
              return this._emitError(new Error('Cannot parse topic'));
            qos = this._list.readUInt8(this._pos++);
            packet.subscriptions.push({
              topic: topic,
              qos: qos
            });
          }
        };
        Parser.prototype._parseSuback = function() {
          this.packet.granted = [];
          if (!this._parseMessageId()) {
            return;
          }
          while (this._pos < this.packet.length) {
            this.packet.granted.push(this._list.readUInt8(this._pos++));
          }
        };
        Parser.prototype._parseUnsubscribe = function() {
          var packet = this.packet;
          packet.unsubscriptions = [];
          if (!this._parseMessageId()) {
            return;
          }
          while (this._pos < packet.length) {
            var topic;
            topic = this._parseString();
            if (topic === null)
              return this._emitError(new Error('Cannot parse topic'));
            packet.unsubscriptions.push(topic);
          }
        };
        Parser.prototype._parseUnsuback = function() {
          if (!this._parseMessageId())
            return this._emitError(new Error('Cannot parse message id'));
        };
        Parser.prototype._parseMessageId = function() {
          var packet = this.packet;
          packet.messageId = this._parseNum();
          if (packet.messageId === null) {
            this._emitError(new Error('Cannot parse message id'));
            return false;
          }
          return true;
        };
        Parser.prototype._parseString = function(maybeBuffer) {
          var length = this._parseNum();
          var result;
          var end = length + this._pos;
          if (length === -1 || end > this._list.length || end > this.packet.length)
            return null;
          result = this._list.toString('utf8', this._pos, end);
          this._pos += length;
          return result;
        };
        Parser.prototype._parseBuffer = function() {
          var length = this._parseNum();
          var result;
          var end = length + this._pos;
          if (length === -1 || end > this._list.length || end > this.packet.length)
            return null;
          result = this._list.slice(this._pos, end);
          this._pos += length;
          return result;
        };
        Parser.prototype._parseNum = function() {
          if (this._list.length - this._pos < 2)
            return -1;
          var result = this._list.readUInt16BE(this._pos);
          this._pos += 2;
          return result;
        };
        Parser.prototype._newPacket = function() {
          if (this.packet) {
            this._list.consume(this.packet.length);
            this.emit('packet', this.packet);
          }
          this.packet = new Packet();
          return true;
        };
        Parser.prototype._emitError = function(err) {
          this.error = err;
          this.emit('error', err);
        };
        module.exports = Parser;
      }, {
        "./constants": 22,
        "./packet": 26,
        "bl": 9,
        "events": 17,
        "inherits": 19
      }],
      28: [function(require, module, exports) {
        (function(Buffer) {
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
        }).call(this, require('buffer').Buffer);
      }, {
        "./constants": 22,
        "./numbers": 25,
        "buffer": 11,
        "process-nextick-args": 30
      }],
      29: [function(require, module, exports) {
        var wrappy = require('wrappy');
        module.exports = wrappy(once);
        once.proto = once(function() {
          Object.defineProperty(Function.prototype, 'once', {
            value: function() {
              return once(this);
            },
            configurable: true
          });
        });
        function once(fn) {
          var f = function() {
            if (f.called)
              return f.value;
            f.called = true;
            return f.value = fn.apply(this, arguments);
          };
          f.called = false;
          return f;
        }
      }, {"wrappy": 57}],
      30: [function(require, module, exports) {
        (function(process) {
          'use strict';
          if (!process.version || process.version.indexOf('v0.') === 0 || process.version.indexOf('v1.') === 0 && process.version.indexOf('v1.8.') !== 0) {
            module.exports = nextTick;
          } else {
            module.exports = process.nextTick;
          }
          function nextTick(fn, arg1, arg2, arg3) {
            if (typeof fn !== 'function') {
              throw new TypeError('"callback" argument must be a function');
            }
            var len = arguments.length;
            var args,
                i;
            switch (len) {
              case 0:
              case 1:
                return process.nextTick(fn);
              case 2:
                return process.nextTick(function afterTickOne() {
                  fn.call(null, arg1);
                });
              case 3:
                return process.nextTick(function afterTickTwo() {
                  fn.call(null, arg1, arg2);
                });
              case 4:
                return process.nextTick(function afterTickThree() {
                  fn.call(null, arg1, arg2, arg3);
                });
              default:
                args = new Array(len - 1);
                i = 0;
                while (i < args.length) {
                  args[i++] = arguments[i];
                }
                return process.nextTick(function afterTick() {
                  fn.apply(null, args);
                });
            }
          }
        }).call(this, require('_process'));
      }, {"_process": 31}],
      31: [function(require, module, exports) {
        var process = module.exports = {};
        var cachedSetTimeout;
        var cachedClearTimeout;
        function defaultSetTimout() {
          throw new Error('setTimeout has not been defined');
        }
        function defaultClearTimeout() {
          throw new Error('clearTimeout has not been defined');
        }
        (function() {
          try {
            if (typeof setTimeout === 'function') {
              cachedSetTimeout = setTimeout;
            } else {
              cachedSetTimeout = defaultSetTimout;
            }
          } catch (e) {
            cachedSetTimeout = defaultSetTimout;
          }
          try {
            if (typeof clearTimeout === 'function') {
              cachedClearTimeout = clearTimeout;
            } else {
              cachedClearTimeout = defaultClearTimeout;
            }
          } catch (e) {
            cachedClearTimeout = defaultClearTimeout;
          }
        }());
        function runTimeout(fun) {
          if (cachedSetTimeout === setTimeout) {
            return setTimeout(fun, 0);
          }
          if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
            cachedSetTimeout = setTimeout;
            return setTimeout(fun, 0);
          }
          try {
            return cachedSetTimeout(fun, 0);
          } catch (e) {
            try {
              return cachedSetTimeout.call(null, fun, 0);
            } catch (e) {
              return cachedSetTimeout.call(this, fun, 0);
            }
          }
        }
        function runClearTimeout(marker) {
          if (cachedClearTimeout === clearTimeout) {
            return clearTimeout(marker);
          }
          if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
            cachedClearTimeout = clearTimeout;
            return clearTimeout(marker);
          }
          try {
            return cachedClearTimeout(marker);
          } catch (e) {
            try {
              return cachedClearTimeout.call(null, marker);
            } catch (e) {
              return cachedClearTimeout.call(this, marker);
            }
          }
        }
        var queue = [];
        var draining = false;
        var currentQueue;
        var queueIndex = -1;
        function cleanUpNextTick() {
          if (!draining || !currentQueue) {
            return;
          }
          draining = false;
          if (currentQueue.length) {
            queue = currentQueue.concat(queue);
          } else {
            queueIndex = -1;
          }
          if (queue.length) {
            drainQueue();
          }
        }
        function drainQueue() {
          if (draining) {
            return;
          }
          var timeout = runTimeout(cleanUpNextTick);
          draining = true;
          var len = queue.length;
          while (len) {
            currentQueue = queue;
            queue = [];
            while (++queueIndex < len) {
              if (currentQueue) {
                currentQueue[queueIndex].run();
              }
            }
            queueIndex = -1;
            len = queue.length;
          }
          currentQueue = null;
          draining = false;
          runClearTimeout(timeout);
        }
        process.nextTick = function(fun) {
          var args = new Array(arguments.length - 1);
          if (arguments.length > 1) {
            for (var i = 1; i < arguments.length; i++) {
              args[i - 1] = arguments[i];
            }
          }
          queue.push(new Item(fun, args));
          if (queue.length === 1 && !draining) {
            runTimeout(drainQueue);
          }
        };
        function Item(fun, array) {
          this.fun = fun;
          this.array = array;
        }
        Item.prototype.run = function() {
          this.fun.apply(null, this.array);
        };
        process.title = 'browser';
        process.browser = true;
        process.env = {};
        process.argv = [];
        process.version = '';
        process.versions = {};
        function noop() {}
        process.on = noop;
        process.addListener = noop;
        process.once = noop;
        process.off = noop;
        process.removeListener = noop;
        process.removeAllListeners = noop;
        process.emit = noop;
        process.binding = function(name) {
          throw new Error('process.binding is not supported');
        };
        process.cwd = function() {
          return '/';
        };
        process.chdir = function(dir) {
          throw new Error('process.chdir is not supported');
        };
        process.umask = function() {
          return 0;
        };
      }, {}],
      32: [function(require, module, exports) {
        (function(global) {
          ;
          (function(root) {
            var freeExports = typeof exports == 'object' && exports && !exports.nodeType && exports;
            var freeModule = typeof module == 'object' && module && !module.nodeType && module;
            var freeGlobal = typeof global == 'object' && global;
            if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal || freeGlobal.self === freeGlobal) {
              root = freeGlobal;
            }
            var punycode,
                maxInt = 2147483647,
                base = 36,
                tMin = 1,
                tMax = 26,
                skew = 38,
                damp = 700,
                initialBias = 72,
                initialN = 128,
                delimiter = '-',
                regexPunycode = /^xn--/,
                regexNonASCII = /[^\x20-\x7E]/,
                regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g,
                errors = {
                  'overflow': 'Overflow: input needs wider integers to process',
                  'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
                  'invalid-input': 'Invalid input'
                },
                baseMinusTMin = base - tMin,
                floor = Math.floor,
                stringFromCharCode = String.fromCharCode,
                key;
            function error(type) {
              throw new RangeError(errors[type]);
            }
            function map(array, fn) {
              var length = array.length;
              var result = [];
              while (length--) {
                result[length] = fn(array[length]);
              }
              return result;
            }
            function mapDomain(string, fn) {
              var parts = string.split('@');
              var result = '';
              if (parts.length > 1) {
                result = parts[0] + '@';
                string = parts[1];
              }
              string = string.replace(regexSeparators, '\x2E');
              var labels = string.split('.');
              var encoded = map(labels, fn).join('.');
              return result + encoded;
            }
            function ucs2decode(string) {
              var output = [],
                  counter = 0,
                  length = string.length,
                  value,
                  extra;
              while (counter < length) {
                value = string.charCodeAt(counter++);
                if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
                  extra = string.charCodeAt(counter++);
                  if ((extra & 0xFC00) == 0xDC00) {
                    output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
                  } else {
                    output.push(value);
                    counter--;
                  }
                } else {
                  output.push(value);
                }
              }
              return output;
            }
            function ucs2encode(array) {
              return map(array, function(value) {
                var output = '';
                if (value > 0xFFFF) {
                  value -= 0x10000;
                  output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
                  value = 0xDC00 | value & 0x3FF;
                }
                output += stringFromCharCode(value);
                return output;
              }).join('');
            }
            function basicToDigit(codePoint) {
              if (codePoint - 48 < 10) {
                return codePoint - 22;
              }
              if (codePoint - 65 < 26) {
                return codePoint - 65;
              }
              if (codePoint - 97 < 26) {
                return codePoint - 97;
              }
              return base;
            }
            function digitToBasic(digit, flag) {
              return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
            }
            function adapt(delta, numPoints, firstTime) {
              var k = 0;
              delta = firstTime ? floor(delta / damp) : delta >> 1;
              delta += floor(delta / numPoints);
              for (; delta > baseMinusTMin * tMax >> 1; k += base) {
                delta = floor(delta / baseMinusTMin);
              }
              return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
            }
            function decode(input) {
              var output = [],
                  inputLength = input.length,
                  out,
                  i = 0,
                  n = initialN,
                  bias = initialBias,
                  basic,
                  j,
                  index,
                  oldi,
                  w,
                  k,
                  digit,
                  t,
                  baseMinusT;
              basic = input.lastIndexOf(delimiter);
              if (basic < 0) {
                basic = 0;
              }
              for (j = 0; j < basic; ++j) {
                if (input.charCodeAt(j) >= 0x80) {
                  error('not-basic');
                }
                output.push(input.charCodeAt(j));
              }
              for (index = basic > 0 ? basic + 1 : 0; index < inputLength; ) {
                for (oldi = i, w = 1, k = base; ; k += base) {
                  if (index >= inputLength) {
                    error('invalid-input');
                  }
                  digit = basicToDigit(input.charCodeAt(index++));
                  if (digit >= base || digit > floor((maxInt - i) / w)) {
                    error('overflow');
                  }
                  i += digit * w;
                  t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
                  if (digit < t) {
                    break;
                  }
                  baseMinusT = base - t;
                  if (w > floor(maxInt / baseMinusT)) {
                    error('overflow');
                  }
                  w *= baseMinusT;
                }
                out = output.length + 1;
                bias = adapt(i - oldi, out, oldi == 0);
                if (floor(i / out) > maxInt - n) {
                  error('overflow');
                }
                n += floor(i / out);
                i %= out;
                output.splice(i++, 0, n);
              }
              return ucs2encode(output);
            }
            function encode(input) {
              var n,
                  delta,
                  handledCPCount,
                  basicLength,
                  bias,
                  j,
                  m,
                  q,
                  k,
                  t,
                  currentValue,
                  output = [],
                  inputLength,
                  handledCPCountPlusOne,
                  baseMinusT,
                  qMinusT;
              input = ucs2decode(input);
              inputLength = input.length;
              n = initialN;
              delta = 0;
              bias = initialBias;
              for (j = 0; j < inputLength; ++j) {
                currentValue = input[j];
                if (currentValue < 0x80) {
                  output.push(stringFromCharCode(currentValue));
                }
              }
              handledCPCount = basicLength = output.length;
              if (basicLength) {
                output.push(delimiter);
              }
              while (handledCPCount < inputLength) {
                for (m = maxInt, j = 0; j < inputLength; ++j) {
                  currentValue = input[j];
                  if (currentValue >= n && currentValue < m) {
                    m = currentValue;
                  }
                }
                handledCPCountPlusOne = handledCPCount + 1;
                if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
                  error('overflow');
                }
                delta += (m - n) * handledCPCountPlusOne;
                n = m;
                for (j = 0; j < inputLength; ++j) {
                  currentValue = input[j];
                  if (currentValue < n && ++delta > maxInt) {
                    error('overflow');
                  }
                  if (currentValue == n) {
                    for (q = delta, k = base; ; k += base) {
                      t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
                      if (q < t) {
                        break;
                      }
                      qMinusT = q - t;
                      baseMinusT = base - t;
                      output.push(stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0)));
                      q = floor(qMinusT / baseMinusT);
                    }
                    output.push(stringFromCharCode(digitToBasic(q, 0)));
                    bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
                    delta = 0;
                    ++handledCPCount;
                  }
                }
                ++delta;
                ++n;
              }
              return output.join('');
            }
            function toUnicode(input) {
              return mapDomain(input, function(string) {
                return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
              });
            }
            function toASCII(input) {
              return mapDomain(input, function(string) {
                return regexNonASCII.test(string) ? 'xn--' + encode(string) : string;
              });
            }
            punycode = {
              'version': '1.4.1',
              'ucs2': {
                'decode': ucs2decode,
                'encode': ucs2encode
              },
              'decode': decode,
              'encode': encode,
              'toASCII': toASCII,
              'toUnicode': toUnicode
            };
            if (typeof define == 'function' && typeof define.amd == 'object' && define.amd) {
              define('punycode', function() {
                return punycode;
              });
            } else if (freeExports && freeModule) {
              if (module.exports == freeExports) {
                freeModule.exports = punycode;
              } else {
                for (key in punycode) {
                  punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
                }
              }
            } else {
              root.punycode = punycode;
            }
          }(this));
        }).call(this, typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
      }, {}],
      33: [function(require, module, exports) {
        'use strict';
        function hasOwnProperty(obj, prop) {
          return Object.prototype.hasOwnProperty.call(obj, prop);
        }
        module.exports = function(qs, sep, eq, options) {
          sep = sep || '&';
          eq = eq || '=';
          var obj = {};
          if (typeof qs !== 'string' || qs.length === 0) {
            return obj;
          }
          var regexp = /\+/g;
          qs = qs.split(sep);
          var maxKeys = 1000;
          if (options && typeof options.maxKeys === 'number') {
            maxKeys = options.maxKeys;
          }
          var len = qs.length;
          if (maxKeys > 0 && len > maxKeys) {
            len = maxKeys;
          }
          for (var i = 0; i < len; ++i) {
            var x = qs[i].replace(regexp, '%20'),
                idx = x.indexOf(eq),
                kstr,
                vstr,
                k,
                v;
            if (idx >= 0) {
              kstr = x.substr(0, idx);
              vstr = x.substr(idx + 1);
            } else {
              kstr = x;
              vstr = '';
            }
            k = decodeURIComponent(kstr);
            v = decodeURIComponent(vstr);
            if (!hasOwnProperty(obj, k)) {
              obj[k] = v;
            } else if (isArray(obj[k])) {
              obj[k].push(v);
            } else {
              obj[k] = [obj[k], v];
            }
          }
          return obj;
        };
        var isArray = Array.isArray || function(xs) {
          return Object.prototype.toString.call(xs) === '[object Array]';
        };
      }, {}],
      34: [function(require, module, exports) {
        'use strict';
        var stringifyPrimitive = function(v) {
          switch (typeof v) {
            case 'string':
              return v;
            case 'boolean':
              return v ? 'true' : 'false';
            case 'number':
              return isFinite(v) ? v : '';
            default:
              return '';
          }
        };
        module.exports = function(obj, sep, eq, name) {
          sep = sep || '&';
          eq = eq || '=';
          if (obj === null) {
            obj = undefined;
          }
          if (typeof obj === 'object') {
            return map(objectKeys(obj), function(k) {
              var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
              if (isArray(obj[k])) {
                return map(obj[k], function(v) {
                  return ks + encodeURIComponent(stringifyPrimitive(v));
                }).join(sep);
              } else {
                return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
              }
            }).join(sep);
          }
          if (!name)
            return '';
          return encodeURIComponent(stringifyPrimitive(name)) + eq + encodeURIComponent(stringifyPrimitive(obj));
        };
        var isArray = Array.isArray || function(xs) {
          return Object.prototype.toString.call(xs) === '[object Array]';
        };
        function map(xs, f) {
          if (xs.map)
            return xs.map(f);
          var res = [];
          for (var i = 0; i < xs.length; i++) {
            res.push(f(xs[i], i));
          }
          return res;
        }
        var objectKeys = Object.keys || function(obj) {
          var res = [];
          for (var key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key))
              res.push(key);
          }
          return res;
        };
      }, {}],
      35: [function(require, module, exports) {
        'use strict';
        exports.decode = exports.parse = require('./decode');
        exports.encode = exports.stringify = require('./encode');
      }, {
        "./decode": 33,
        "./encode": 34
      }],
      36: [function(require, module, exports) {
        module.exports = require('./lib/_stream_duplex');
      }, {"./lib/_stream_duplex.js": 37}],
      37: [function(require, module, exports) {
        'use strict';
        var objectKeys = Object.keys || function(obj) {
          var keys = [];
          for (var key in obj) {
            keys.push(key);
          }
          return keys;
        };
        module.exports = Duplex;
        var processNextTick = require('process-nextick-args');
        var util = require('core-util-is');
        util.inherits = require('inherits');
        var Readable = require('./_stream_readable');
        var Writable = require('./_stream_writable');
        util.inherits(Duplex, Readable);
        var keys = objectKeys(Writable.prototype);
        for (var v = 0; v < keys.length; v++) {
          var method = keys[v];
          if (!Duplex.prototype[method])
            Duplex.prototype[method] = Writable.prototype[method];
        }
        function Duplex(options) {
          if (!(this instanceof Duplex))
            return new Duplex(options);
          Readable.call(this, options);
          Writable.call(this, options);
          if (options && options.readable === false)
            this.readable = false;
          if (options && options.writable === false)
            this.writable = false;
          this.allowHalfOpen = true;
          if (options && options.allowHalfOpen === false)
            this.allowHalfOpen = false;
          this.once('end', onend);
        }
        function onend() {
          if (this.allowHalfOpen || this._writableState.ended)
            return;
          processNextTick(onEndNT, this);
        }
        function onEndNT(self) {
          self.end();
        }
        function forEach(xs, f) {
          for (var i = 0,
              l = xs.length; i < l; i++) {
            f(xs[i], i);
          }
        }
      }, {
        "./_stream_readable": 39,
        "./_stream_writable": 41,
        "core-util-is": 13,
        "inherits": 19,
        "process-nextick-args": 30
      }],
      38: [function(require, module, exports) {
        'use strict';
        module.exports = PassThrough;
        var Transform = require('./_stream_transform');
        var util = require('core-util-is');
        util.inherits = require('inherits');
        util.inherits(PassThrough, Transform);
        function PassThrough(options) {
          if (!(this instanceof PassThrough))
            return new PassThrough(options);
          Transform.call(this, options);
        }
        PassThrough.prototype._transform = function(chunk, encoding, cb) {
          cb(null, chunk);
        };
      }, {
        "./_stream_transform": 40,
        "core-util-is": 13,
        "inherits": 19
      }],
      39: [function(require, module, exports) {
        (function(process) {
          'use strict';
          module.exports = Readable;
          var processNextTick = require('process-nextick-args');
          var isArray = require('isarray');
          var Duplex;
          Readable.ReadableState = ReadableState;
          var EE = require('events').EventEmitter;
          var EElistenerCount = function(emitter, type) {
            return emitter.listeners(type).length;
          };
          var Stream;
          (function() {
            try {
              Stream = require('st' + 'ream');
            } catch (_) {} finally {
              if (!Stream)
                Stream = require('events').EventEmitter;
            }
          })();
          var Buffer = require('buffer').Buffer;
          var bufferShim = require('buffer-shims');
          var util = require('core-util-is');
          util.inherits = require('inherits');
          var debugUtil = require('util');
          var debug = void 0;
          if (debugUtil && debugUtil.debuglog) {
            debug = debugUtil.debuglog('stream');
          } else {
            debug = function() {};
          }
          var BufferList = require('./internal/streams/BufferList');
          var StringDecoder;
          util.inherits(Readable, Stream);
          function prependListener(emitter, event, fn) {
            if (typeof emitter.prependListener === 'function') {
              return emitter.prependListener(event, fn);
            } else {
              if (!emitter._events || !emitter._events[event])
                emitter.on(event, fn);
              else if (isArray(emitter._events[event]))
                emitter._events[event].unshift(fn);
              else
                emitter._events[event] = [fn, emitter._events[event]];
            }
          }
          function ReadableState(options, stream) {
            Duplex = Duplex || require('./_stream_duplex');
            options = options || {};
            this.objectMode = !!options.objectMode;
            if (stream instanceof Duplex)
              this.objectMode = this.objectMode || !!options.readableObjectMode;
            var hwm = options.highWaterMark;
            var defaultHwm = this.objectMode ? 16 : 16 * 1024;
            this.highWaterMark = hwm || hwm === 0 ? hwm : defaultHwm;
            this.highWaterMark = ~~this.highWaterMark;
            this.buffer = new BufferList();
            this.length = 0;
            this.pipes = null;
            this.pipesCount = 0;
            this.flowing = null;
            this.ended = false;
            this.endEmitted = false;
            this.reading = false;
            this.sync = true;
            this.needReadable = false;
            this.emittedReadable = false;
            this.readableListening = false;
            this.resumeScheduled = false;
            this.defaultEncoding = options.defaultEncoding || 'utf8';
            this.ranOut = false;
            this.awaitDrain = 0;
            this.readingMore = false;
            this.decoder = null;
            this.encoding = null;
            if (options.encoding) {
              if (!StringDecoder)
                StringDecoder = require('string_decoder').StringDecoder;
              this.decoder = new StringDecoder(options.encoding);
              this.encoding = options.encoding;
            }
          }
          function Readable(options) {
            Duplex = Duplex || require('./_stream_duplex');
            if (!(this instanceof Readable))
              return new Readable(options);
            this._readableState = new ReadableState(options, this);
            this.readable = true;
            if (options && typeof options.read === 'function')
              this._read = options.read;
            Stream.call(this);
          }
          Readable.prototype.push = function(chunk, encoding) {
            var state = this._readableState;
            if (!state.objectMode && typeof chunk === 'string') {
              encoding = encoding || state.defaultEncoding;
              if (encoding !== state.encoding) {
                chunk = bufferShim.from(chunk, encoding);
                encoding = '';
              }
            }
            return readableAddChunk(this, state, chunk, encoding, false);
          };
          Readable.prototype.unshift = function(chunk) {
            var state = this._readableState;
            return readableAddChunk(this, state, chunk, '', true);
          };
          Readable.prototype.isPaused = function() {
            return this._readableState.flowing === false;
          };
          function readableAddChunk(stream, state, chunk, encoding, addToFront) {
            var er = chunkInvalid(state, chunk);
            if (er) {
              stream.emit('error', er);
            } else if (chunk === null) {
              state.reading = false;
              onEofChunk(stream, state);
            } else if (state.objectMode || chunk && chunk.length > 0) {
              if (state.ended && !addToFront) {
                var e = new Error('stream.push() after EOF');
                stream.emit('error', e);
              } else if (state.endEmitted && addToFront) {
                var _e = new Error('stream.unshift() after end event');
                stream.emit('error', _e);
              } else {
                var skipAdd;
                if (state.decoder && !addToFront && !encoding) {
                  chunk = state.decoder.write(chunk);
                  skipAdd = !state.objectMode && chunk.length === 0;
                }
                if (!addToFront)
                  state.reading = false;
                if (!skipAdd) {
                  if (state.flowing && state.length === 0 && !state.sync) {
                    stream.emit('data', chunk);
                    stream.read(0);
                  } else {
                    state.length += state.objectMode ? 1 : chunk.length;
                    if (addToFront)
                      state.buffer.unshift(chunk);
                    else
                      state.buffer.push(chunk);
                    if (state.needReadable)
                      emitReadable(stream);
                  }
                }
                maybeReadMore(stream, state);
              }
            } else if (!addToFront) {
              state.reading = false;
            }
            return needMoreData(state);
          }
          function needMoreData(state) {
            return !state.ended && (state.needReadable || state.length < state.highWaterMark || state.length === 0);
          }
          Readable.prototype.setEncoding = function(enc) {
            if (!StringDecoder)
              StringDecoder = require('string_decoder').StringDecoder;
            this._readableState.decoder = new StringDecoder(enc);
            this._readableState.encoding = enc;
            return this;
          };
          var MAX_HWM = 0x800000;
          function computeNewHighWaterMark(n) {
            if (n >= MAX_HWM) {
              n = MAX_HWM;
            } else {
              n--;
              n |= n >>> 1;
              n |= n >>> 2;
              n |= n >>> 4;
              n |= n >>> 8;
              n |= n >>> 16;
              n++;
            }
            return n;
          }
          function howMuchToRead(n, state) {
            if (n <= 0 || state.length === 0 && state.ended)
              return 0;
            if (state.objectMode)
              return 1;
            if (n !== n) {
              if (state.flowing && state.length)
                return state.buffer.head.data.length;
              else
                return state.length;
            }
            if (n > state.highWaterMark)
              state.highWaterMark = computeNewHighWaterMark(n);
            if (n <= state.length)
              return n;
            if (!state.ended) {
              state.needReadable = true;
              return 0;
            }
            return state.length;
          }
          Readable.prototype.read = function(n) {
            debug('read', n);
            n = parseInt(n, 10);
            var state = this._readableState;
            var nOrig = n;
            if (n !== 0)
              state.emittedReadable = false;
            if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
              debug('read: emitReadable', state.length, state.ended);
              if (state.length === 0 && state.ended)
                endReadable(this);
              else
                emitReadable(this);
              return null;
            }
            n = howMuchToRead(n, state);
            if (n === 0 && state.ended) {
              if (state.length === 0)
                endReadable(this);
              return null;
            }
            var doRead = state.needReadable;
            debug('need readable', doRead);
            if (state.length === 0 || state.length - n < state.highWaterMark) {
              doRead = true;
              debug('length less than watermark', doRead);
            }
            if (state.ended || state.reading) {
              doRead = false;
              debug('reading or ended', doRead);
            } else if (doRead) {
              debug('do read');
              state.reading = true;
              state.sync = true;
              if (state.length === 0)
                state.needReadable = true;
              this._read(state.highWaterMark);
              state.sync = false;
              if (!state.reading)
                n = howMuchToRead(nOrig, state);
            }
            var ret;
            if (n > 0)
              ret = fromList(n, state);
            else
              ret = null;
            if (ret === null) {
              state.needReadable = true;
              n = 0;
            } else {
              state.length -= n;
            }
            if (state.length === 0) {
              if (!state.ended)
                state.needReadable = true;
              if (nOrig !== n && state.ended)
                endReadable(this);
            }
            if (ret !== null)
              this.emit('data', ret);
            return ret;
          };
          function chunkInvalid(state, chunk) {
            var er = null;
            if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && chunk !== null && chunk !== undefined && !state.objectMode) {
              er = new TypeError('Invalid non-string/buffer chunk');
            }
            return er;
          }
          function onEofChunk(stream, state) {
            if (state.ended)
              return;
            if (state.decoder) {
              var chunk = state.decoder.end();
              if (chunk && chunk.length) {
                state.buffer.push(chunk);
                state.length += state.objectMode ? 1 : chunk.length;
              }
            }
            state.ended = true;
            emitReadable(stream);
          }
          function emitReadable(stream) {
            var state = stream._readableState;
            state.needReadable = false;
            if (!state.emittedReadable) {
              debug('emitReadable', state.flowing);
              state.emittedReadable = true;
              if (state.sync)
                processNextTick(emitReadable_, stream);
              else
                emitReadable_(stream);
            }
          }
          function emitReadable_(stream) {
            debug('emit readable');
            stream.emit('readable');
            flow(stream);
          }
          function maybeReadMore(stream, state) {
            if (!state.readingMore) {
              state.readingMore = true;
              processNextTick(maybeReadMore_, stream, state);
            }
          }
          function maybeReadMore_(stream, state) {
            var len = state.length;
            while (!state.reading && !state.flowing && !state.ended && state.length < state.highWaterMark) {
              debug('maybeReadMore read 0');
              stream.read(0);
              if (len === state.length)
                break;
              else
                len = state.length;
            }
            state.readingMore = false;
          }
          Readable.prototype._read = function(n) {
            this.emit('error', new Error('_read() is not implemented'));
          };
          Readable.prototype.pipe = function(dest, pipeOpts) {
            var src = this;
            var state = this._readableState;
            switch (state.pipesCount) {
              case 0:
                state.pipes = dest;
                break;
              case 1:
                state.pipes = [state.pipes, dest];
                break;
              default:
                state.pipes.push(dest);
                break;
            }
            state.pipesCount += 1;
            debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);
            var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;
            var endFn = doEnd ? onend : cleanup;
            if (state.endEmitted)
              processNextTick(endFn);
            else
              src.once('end', endFn);
            dest.on('unpipe', onunpipe);
            function onunpipe(readable) {
              debug('onunpipe');
              if (readable === src) {
                cleanup();
              }
            }
            function onend() {
              debug('onend');
              dest.end();
            }
            var ondrain = pipeOnDrain(src);
            dest.on('drain', ondrain);
            var cleanedUp = false;
            function cleanup() {
              debug('cleanup');
              dest.removeListener('close', onclose);
              dest.removeListener('finish', onfinish);
              dest.removeListener('drain', ondrain);
              dest.removeListener('error', onerror);
              dest.removeListener('unpipe', onunpipe);
              src.removeListener('end', onend);
              src.removeListener('end', cleanup);
              src.removeListener('data', ondata);
              cleanedUp = true;
              if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain))
                ondrain();
            }
            var increasedAwaitDrain = false;
            src.on('data', ondata);
            function ondata(chunk) {
              debug('ondata');
              increasedAwaitDrain = false;
              var ret = dest.write(chunk);
              if (false === ret && !increasedAwaitDrain) {
                if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
                  debug('false write response, pause', src._readableState.awaitDrain);
                  src._readableState.awaitDrain++;
                  increasedAwaitDrain = true;
                }
                src.pause();
              }
            }
            function onerror(er) {
              debug('onerror', er);
              unpipe();
              dest.removeListener('error', onerror);
              if (EElistenerCount(dest, 'error') === 0)
                dest.emit('error', er);
            }
            prependListener(dest, 'error', onerror);
            function onclose() {
              dest.removeListener('finish', onfinish);
              unpipe();
            }
            dest.once('close', onclose);
            function onfinish() {
              debug('onfinish');
              dest.removeListener('close', onclose);
              unpipe();
            }
            dest.once('finish', onfinish);
            function unpipe() {
              debug('unpipe');
              src.unpipe(dest);
            }
            dest.emit('pipe', src);
            if (!state.flowing) {
              debug('pipe resume');
              src.resume();
            }
            return dest;
          };
          function pipeOnDrain(src) {
            return function() {
              var state = src._readableState;
              debug('pipeOnDrain', state.awaitDrain);
              if (state.awaitDrain)
                state.awaitDrain--;
              if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
                state.flowing = true;
                flow(src);
              }
            };
          }
          Readable.prototype.unpipe = function(dest) {
            var state = this._readableState;
            if (state.pipesCount === 0)
              return this;
            if (state.pipesCount === 1) {
              if (dest && dest !== state.pipes)
                return this;
              if (!dest)
                dest = state.pipes;
              state.pipes = null;
              state.pipesCount = 0;
              state.flowing = false;
              if (dest)
                dest.emit('unpipe', this);
              return this;
            }
            if (!dest) {
              var dests = state.pipes;
              var len = state.pipesCount;
              state.pipes = null;
              state.pipesCount = 0;
              state.flowing = false;
              for (var i = 0; i < len; i++) {
                dests[i].emit('unpipe', this);
              }
              return this;
            }
            var index = indexOf(state.pipes, dest);
            if (index === -1)
              return this;
            state.pipes.splice(index, 1);
            state.pipesCount -= 1;
            if (state.pipesCount === 1)
              state.pipes = state.pipes[0];
            dest.emit('unpipe', this);
            return this;
          };
          Readable.prototype.on = function(ev, fn) {
            var res = Stream.prototype.on.call(this, ev, fn);
            if (ev === 'data') {
              if (this._readableState.flowing !== false)
                this.resume();
            } else if (ev === 'readable') {
              var state = this._readableState;
              if (!state.endEmitted && !state.readableListening) {
                state.readableListening = state.needReadable = true;
                state.emittedReadable = false;
                if (!state.reading) {
                  processNextTick(nReadingNextTick, this);
                } else if (state.length) {
                  emitReadable(this, state);
                }
              }
            }
            return res;
          };
          Readable.prototype.addListener = Readable.prototype.on;
          function nReadingNextTick(self) {
            debug('readable nexttick read 0');
            self.read(0);
          }
          Readable.prototype.resume = function() {
            var state = this._readableState;
            if (!state.flowing) {
              debug('resume');
              state.flowing = true;
              resume(this, state);
            }
            return this;
          };
          function resume(stream, state) {
            if (!state.resumeScheduled) {
              state.resumeScheduled = true;
              processNextTick(resume_, stream, state);
            }
          }
          function resume_(stream, state) {
            if (!state.reading) {
              debug('resume read 0');
              stream.read(0);
            }
            state.resumeScheduled = false;
            state.awaitDrain = 0;
            stream.emit('resume');
            flow(stream);
            if (state.flowing && !state.reading)
              stream.read(0);
          }
          Readable.prototype.pause = function() {
            debug('call pause flowing=%j', this._readableState.flowing);
            if (false !== this._readableState.flowing) {
              debug('pause');
              this._readableState.flowing = false;
              this.emit('pause');
            }
            return this;
          };
          function flow(stream) {
            var state = stream._readableState;
            debug('flow', state.flowing);
            while (state.flowing && stream.read() !== null) {}
          }
          Readable.prototype.wrap = function(stream) {
            var state = this._readableState;
            var paused = false;
            var self = this;
            stream.on('end', function() {
              debug('wrapped end');
              if (state.decoder && !state.ended) {
                var chunk = state.decoder.end();
                if (chunk && chunk.length)
                  self.push(chunk);
              }
              self.push(null);
            });
            stream.on('data', function(chunk) {
              debug('wrapped data');
              if (state.decoder)
                chunk = state.decoder.write(chunk);
              if (state.objectMode && (chunk === null || chunk === undefined))
                return;
              else if (!state.objectMode && (!chunk || !chunk.length))
                return;
              var ret = self.push(chunk);
              if (!ret) {
                paused = true;
                stream.pause();
              }
            });
            for (var i in stream) {
              if (this[i] === undefined && typeof stream[i] === 'function') {
                this[i] = function(method) {
                  return function() {
                    return stream[method].apply(stream, arguments);
                  };
                }(i);
              }
            }
            var events = ['error', 'close', 'destroy', 'pause', 'resume'];
            forEach(events, function(ev) {
              stream.on(ev, self.emit.bind(self, ev));
            });
            self._read = function(n) {
              debug('wrapped _read', n);
              if (paused) {
                paused = false;
                stream.resume();
              }
            };
            return self;
          };
          Readable._fromList = fromList;
          function fromList(n, state) {
            if (state.length === 0)
              return null;
            var ret;
            if (state.objectMode)
              ret = state.buffer.shift();
            else if (!n || n >= state.length) {
              if (state.decoder)
                ret = state.buffer.join('');
              else if (state.buffer.length === 1)
                ret = state.buffer.head.data;
              else
                ret = state.buffer.concat(state.length);
              state.buffer.clear();
            } else {
              ret = fromListPartial(n, state.buffer, state.decoder);
            }
            return ret;
          }
          function fromListPartial(n, list, hasStrings) {
            var ret;
            if (n < list.head.data.length) {
              ret = list.head.data.slice(0, n);
              list.head.data = list.head.data.slice(n);
            } else if (n === list.head.data.length) {
              ret = list.shift();
            } else {
              ret = hasStrings ? copyFromBufferString(n, list) : copyFromBuffer(n, list);
            }
            return ret;
          }
          function copyFromBufferString(n, list) {
            var p = list.head;
            var c = 1;
            var ret = p.data;
            n -= ret.length;
            while (p = p.next) {
              var str = p.data;
              var nb = n > str.length ? str.length : n;
              if (nb === str.length)
                ret += str;
              else
                ret += str.slice(0, n);
              n -= nb;
              if (n === 0) {
                if (nb === str.length) {
                  ++c;
                  if (p.next)
                    list.head = p.next;
                  else
                    list.head = list.tail = null;
                } else {
                  list.head = p;
                  p.data = str.slice(nb);
                }
                break;
              }
              ++c;
            }
            list.length -= c;
            return ret;
          }
          function copyFromBuffer(n, list) {
            var ret = bufferShim.allocUnsafe(n);
            var p = list.head;
            var c = 1;
            p.data.copy(ret);
            n -= p.data.length;
            while (p = p.next) {
              var buf = p.data;
              var nb = n > buf.length ? buf.length : n;
              buf.copy(ret, ret.length - n, 0, nb);
              n -= nb;
              if (n === 0) {
                if (nb === buf.length) {
                  ++c;
                  if (p.next)
                    list.head = p.next;
                  else
                    list.head = list.tail = null;
                } else {
                  list.head = p;
                  p.data = buf.slice(nb);
                }
                break;
              }
              ++c;
            }
            list.length -= c;
            return ret;
          }
          function endReadable(stream) {
            var state = stream._readableState;
            if (state.length > 0)
              throw new Error('"endReadable()" called on non-empty stream');
            if (!state.endEmitted) {
              state.ended = true;
              processNextTick(endReadableNT, state, stream);
            }
          }
          function endReadableNT(state, stream) {
            if (!state.endEmitted && state.length === 0) {
              state.endEmitted = true;
              stream.readable = false;
              stream.emit('end');
            }
          }
          function forEach(xs, f) {
            for (var i = 0,
                l = xs.length; i < l; i++) {
              f(xs[i], i);
            }
          }
          function indexOf(xs, x) {
            for (var i = 0,
                l = xs.length; i < l; i++) {
              if (xs[i] === x)
                return i;
            }
            return -1;
          }
        }).call(this, require('_process'));
      }, {
        "./_stream_duplex": 37,
        "./internal/streams/BufferList": 42,
        "_process": 31,
        "buffer": 11,
        "buffer-shims": 12,
        "core-util-is": 13,
        "events": 17,
        "inherits": 19,
        "isarray": 21,
        "process-nextick-args": 30,
        "string_decoder/": 47,
        "util": 10
      }],
      40: [function(require, module, exports) {
        'use strict';
        module.exports = Transform;
        var Duplex = require('./_stream_duplex');
        var util = require('core-util-is');
        util.inherits = require('inherits');
        util.inherits(Transform, Duplex);
        function TransformState(stream) {
          this.afterTransform = function(er, data) {
            return afterTransform(stream, er, data);
          };
          this.needTransform = false;
          this.transforming = false;
          this.writecb = null;
          this.writechunk = null;
          this.writeencoding = null;
        }
        function afterTransform(stream, er, data) {
          var ts = stream._transformState;
          ts.transforming = false;
          var cb = ts.writecb;
          if (!cb)
            return stream.emit('error', new Error('no writecb in Transform class'));
          ts.writechunk = null;
          ts.writecb = null;
          if (data !== null && data !== undefined)
            stream.push(data);
          cb(er);
          var rs = stream._readableState;
          rs.reading = false;
          if (rs.needReadable || rs.length < rs.highWaterMark) {
            stream._read(rs.highWaterMark);
          }
        }
        function Transform(options) {
          if (!(this instanceof Transform))
            return new Transform(options);
          Duplex.call(this, options);
          this._transformState = new TransformState(this);
          var stream = this;
          this._readableState.needReadable = true;
          this._readableState.sync = false;
          if (options) {
            if (typeof options.transform === 'function')
              this._transform = options.transform;
            if (typeof options.flush === 'function')
              this._flush = options.flush;
          }
          this.once('prefinish', function() {
            if (typeof this._flush === 'function')
              this._flush(function(er, data) {
                done(stream, er, data);
              });
            else
              done(stream);
          });
        }
        Transform.prototype.push = function(chunk, encoding) {
          this._transformState.needTransform = false;
          return Duplex.prototype.push.call(this, chunk, encoding);
        };
        Transform.prototype._transform = function(chunk, encoding, cb) {
          throw new Error('_transform() is not implemented');
        };
        Transform.prototype._write = function(chunk, encoding, cb) {
          var ts = this._transformState;
          ts.writecb = cb;
          ts.writechunk = chunk;
          ts.writeencoding = encoding;
          if (!ts.transforming) {
            var rs = this._readableState;
            if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark)
              this._read(rs.highWaterMark);
          }
        };
        Transform.prototype._read = function(n) {
          var ts = this._transformState;
          if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
            ts.transforming = true;
            this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
          } else {
            ts.needTransform = true;
          }
        };
        function done(stream, er, data) {
          if (er)
            return stream.emit('error', er);
          if (data !== null && data !== undefined)
            stream.push(data);
          var ws = stream._writableState;
          var ts = stream._transformState;
          if (ws.length)
            throw new Error('Calling transform done when ws.length != 0');
          if (ts.transforming)
            throw new Error('Calling transform done when still transforming');
          return stream.push(null);
        }
      }, {
        "./_stream_duplex": 37,
        "core-util-is": 13,
        "inherits": 19
      }],
      41: [function(require, module, exports) {
        (function(process) {
          'use strict';
          module.exports = Writable;
          var processNextTick = require('process-nextick-args');
          var asyncWrite = !process.browser && ['v0.10', 'v0.9.'].indexOf(process.version.slice(0, 5)) > -1 ? setImmediate : processNextTick;
          var Duplex;
          Writable.WritableState = WritableState;
          var util = require('core-util-is');
          util.inherits = require('inherits');
          var internalUtil = {deprecate: require('util-deprecate')};
          var Stream;
          (function() {
            try {
              Stream = require('st' + 'ream');
            } catch (_) {} finally {
              if (!Stream)
                Stream = require('events').EventEmitter;
            }
          })();
          var Buffer = require('buffer').Buffer;
          var bufferShim = require('buffer-shims');
          util.inherits(Writable, Stream);
          function nop() {}
          function WriteReq(chunk, encoding, cb) {
            this.chunk = chunk;
            this.encoding = encoding;
            this.callback = cb;
            this.next = null;
          }
          function WritableState(options, stream) {
            Duplex = Duplex || require('./_stream_duplex');
            options = options || {};
            this.objectMode = !!options.objectMode;
            if (stream instanceof Duplex)
              this.objectMode = this.objectMode || !!options.writableObjectMode;
            var hwm = options.highWaterMark;
            var defaultHwm = this.objectMode ? 16 : 16 * 1024;
            this.highWaterMark = hwm || hwm === 0 ? hwm : defaultHwm;
            this.highWaterMark = ~~this.highWaterMark;
            this.needDrain = false;
            this.ending = false;
            this.ended = false;
            this.finished = false;
            var noDecode = options.decodeStrings === false;
            this.decodeStrings = !noDecode;
            this.defaultEncoding = options.defaultEncoding || 'utf8';
            this.length = 0;
            this.writing = false;
            this.corked = 0;
            this.sync = true;
            this.bufferProcessing = false;
            this.onwrite = function(er) {
              onwrite(stream, er);
            };
            this.writecb = null;
            this.writelen = 0;
            this.bufferedRequest = null;
            this.lastBufferedRequest = null;
            this.pendingcb = 0;
            this.prefinished = false;
            this.errorEmitted = false;
            this.bufferedRequestCount = 0;
            this.corkedRequestsFree = new CorkedRequest(this);
          }
          WritableState.prototype.getBuffer = function getBuffer() {
            var current = this.bufferedRequest;
            var out = [];
            while (current) {
              out.push(current);
              current = current.next;
            }
            return out;
          };
          (function() {
            try {
              Object.defineProperty(WritableState.prototype, 'buffer', {get: internalUtil.deprecate(function() {
                  return this.getBuffer();
                }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' + 'instead.')});
            } catch (_) {}
          })();
          var realHasInstance;
          if (typeof Symbol === 'function' && Symbol.hasInstance && typeof Function.prototype[Symbol.hasInstance] === 'function') {
            realHasInstance = Function.prototype[Symbol.hasInstance];
            Object.defineProperty(Writable, Symbol.hasInstance, {value: function(object) {
                if (realHasInstance.call(this, object))
                  return true;
                return object && object._writableState instanceof WritableState;
              }});
          } else {
            realHasInstance = function(object) {
              return object instanceof this;
            };
          }
          function Writable(options) {
            Duplex = Duplex || require('./_stream_duplex');
            if (!realHasInstance.call(Writable, this) && !(this instanceof Duplex)) {
              return new Writable(options);
            }
            this._writableState = new WritableState(options, this);
            this.writable = true;
            if (options) {
              if (typeof options.write === 'function')
                this._write = options.write;
              if (typeof options.writev === 'function')
                this._writev = options.writev;
            }
            Stream.call(this);
          }
          Writable.prototype.pipe = function() {
            this.emit('error', new Error('Cannot pipe, not readable'));
          };
          function writeAfterEnd(stream, cb) {
            var er = new Error('write after end');
            stream.emit('error', er);
            processNextTick(cb, er);
          }
          function validChunk(stream, state, chunk, cb) {
            var valid = true;
            var er = false;
            if (chunk === null) {
              er = new TypeError('May not write null values to stream');
            } else if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
              er = new TypeError('Invalid non-string/buffer chunk');
            }
            if (er) {
              stream.emit('error', er);
              processNextTick(cb, er);
              valid = false;
            }
            return valid;
          }
          Writable.prototype.write = function(chunk, encoding, cb) {
            var state = this._writableState;
            var ret = false;
            if (typeof encoding === 'function') {
              cb = encoding;
              encoding = null;
            }
            if (Buffer.isBuffer(chunk))
              encoding = 'buffer';
            else if (!encoding)
              encoding = state.defaultEncoding;
            if (typeof cb !== 'function')
              cb = nop;
            if (state.ended)
              writeAfterEnd(this, cb);
            else if (validChunk(this, state, chunk, cb)) {
              state.pendingcb++;
              ret = writeOrBuffer(this, state, chunk, encoding, cb);
            }
            return ret;
          };
          Writable.prototype.cork = function() {
            var state = this._writableState;
            state.corked++;
          };
          Writable.prototype.uncork = function() {
            var state = this._writableState;
            if (state.corked) {
              state.corked--;
              if (!state.writing && !state.corked && !state.finished && !state.bufferProcessing && state.bufferedRequest)
                clearBuffer(this, state);
            }
          };
          Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
            if (typeof encoding === 'string')
              encoding = encoding.toLowerCase();
            if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'raw'].indexOf((encoding + '').toLowerCase()) > -1))
              throw new TypeError('Unknown encoding: ' + encoding);
            this._writableState.defaultEncoding = encoding;
            return this;
          };
          function decodeChunk(state, chunk, encoding) {
            if (!state.objectMode && state.decodeStrings !== false && typeof chunk === 'string') {
              chunk = bufferShim.from(chunk, encoding);
            }
            return chunk;
          }
          function writeOrBuffer(stream, state, chunk, encoding, cb) {
            chunk = decodeChunk(state, chunk, encoding);
            if (Buffer.isBuffer(chunk))
              encoding = 'buffer';
            var len = state.objectMode ? 1 : chunk.length;
            state.length += len;
            var ret = state.length < state.highWaterMark;
            if (!ret)
              state.needDrain = true;
            if (state.writing || state.corked) {
              var last = state.lastBufferedRequest;
              state.lastBufferedRequest = new WriteReq(chunk, encoding, cb);
              if (last) {
                last.next = state.lastBufferedRequest;
              } else {
                state.bufferedRequest = state.lastBufferedRequest;
              }
              state.bufferedRequestCount += 1;
            } else {
              doWrite(stream, state, false, len, chunk, encoding, cb);
            }
            return ret;
          }
          function doWrite(stream, state, writev, len, chunk, encoding, cb) {
            state.writelen = len;
            state.writecb = cb;
            state.writing = true;
            state.sync = true;
            if (writev)
              stream._writev(chunk, state.onwrite);
            else
              stream._write(chunk, encoding, state.onwrite);
            state.sync = false;
          }
          function onwriteError(stream, state, sync, er, cb) {
            --state.pendingcb;
            if (sync)
              processNextTick(cb, er);
            else
              cb(er);
            stream._writableState.errorEmitted = true;
            stream.emit('error', er);
          }
          function onwriteStateUpdate(state) {
            state.writing = false;
            state.writecb = null;
            state.length -= state.writelen;
            state.writelen = 0;
          }
          function onwrite(stream, er) {
            var state = stream._writableState;
            var sync = state.sync;
            var cb = state.writecb;
            onwriteStateUpdate(state);
            if (er)
              onwriteError(stream, state, sync, er, cb);
            else {
              var finished = needFinish(state);
              if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
                clearBuffer(stream, state);
              }
              if (sync) {
                asyncWrite(afterWrite, stream, state, finished, cb);
              } else {
                afterWrite(stream, state, finished, cb);
              }
            }
          }
          function afterWrite(stream, state, finished, cb) {
            if (!finished)
              onwriteDrain(stream, state);
            state.pendingcb--;
            cb();
            finishMaybe(stream, state);
          }
          function onwriteDrain(stream, state) {
            if (state.length === 0 && state.needDrain) {
              state.needDrain = false;
              stream.emit('drain');
            }
          }
          function clearBuffer(stream, state) {
            state.bufferProcessing = true;
            var entry = state.bufferedRequest;
            if (stream._writev && entry && entry.next) {
              var l = state.bufferedRequestCount;
              var buffer = new Array(l);
              var holder = state.corkedRequestsFree;
              holder.entry = entry;
              var count = 0;
              while (entry) {
                buffer[count] = entry;
                entry = entry.next;
                count += 1;
              }
              doWrite(stream, state, true, state.length, buffer, '', holder.finish);
              state.pendingcb++;
              state.lastBufferedRequest = null;
              if (holder.next) {
                state.corkedRequestsFree = holder.next;
                holder.next = null;
              } else {
                state.corkedRequestsFree = new CorkedRequest(state);
              }
            } else {
              while (entry) {
                var chunk = entry.chunk;
                var encoding = entry.encoding;
                var cb = entry.callback;
                var len = state.objectMode ? 1 : chunk.length;
                doWrite(stream, state, false, len, chunk, encoding, cb);
                entry = entry.next;
                if (state.writing) {
                  break;
                }
              }
              if (entry === null)
                state.lastBufferedRequest = null;
            }
            state.bufferedRequestCount = 0;
            state.bufferedRequest = entry;
            state.bufferProcessing = false;
          }
          Writable.prototype._write = function(chunk, encoding, cb) {
            cb(new Error('_write() is not implemented'));
          };
          Writable.prototype._writev = null;
          Writable.prototype.end = function(chunk, encoding, cb) {
            var state = this._writableState;
            if (typeof chunk === 'function') {
              cb = chunk;
              chunk = null;
              encoding = null;
            } else if (typeof encoding === 'function') {
              cb = encoding;
              encoding = null;
            }
            if (chunk !== null && chunk !== undefined)
              this.write(chunk, encoding);
            if (state.corked) {
              state.corked = 1;
              this.uncork();
            }
            if (!state.ending && !state.finished)
              endWritable(this, state, cb);
          };
          function needFinish(state) {
            return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
          }
          function prefinish(stream, state) {
            if (!state.prefinished) {
              state.prefinished = true;
              stream.emit('prefinish');
            }
          }
          function finishMaybe(stream, state) {
            var need = needFinish(state);
            if (need) {
              if (state.pendingcb === 0) {
                prefinish(stream, state);
                state.finished = true;
                stream.emit('finish');
              } else {
                prefinish(stream, state);
              }
            }
            return need;
          }
          function endWritable(stream, state, cb) {
            state.ending = true;
            finishMaybe(stream, state);
            if (cb) {
              if (state.finished)
                processNextTick(cb);
              else
                stream.once('finish', cb);
            }
            state.ended = true;
            stream.writable = false;
          }
          function CorkedRequest(state) {
            var _this = this;
            this.next = null;
            this.entry = null;
            this.finish = function(err) {
              var entry = _this.entry;
              _this.entry = null;
              while (entry) {
                var cb = entry.callback;
                state.pendingcb--;
                cb(err);
                entry = entry.next;
              }
              if (state.corkedRequestsFree) {
                state.corkedRequestsFree.next = _this;
              } else {
                state.corkedRequestsFree = _this;
              }
            };
          }
        }).call(this, require('_process'));
      }, {
        "./_stream_duplex": 37,
        "_process": 31,
        "buffer": 11,
        "buffer-shims": 12,
        "core-util-is": 13,
        "events": 17,
        "inherits": 19,
        "process-nextick-args": 30,
        "util-deprecate": 51
      }],
      42: [function(require, module, exports) {
        'use strict';
        var Buffer = require('buffer').Buffer;
        var bufferShim = require('buffer-shims');
        module.exports = BufferList;
        function BufferList() {
          this.head = null;
          this.tail = null;
          this.length = 0;
        }
        BufferList.prototype.push = function(v) {
          var entry = {
            data: v,
            next: null
          };
          if (this.length > 0)
            this.tail.next = entry;
          else
            this.head = entry;
          this.tail = entry;
          ++this.length;
        };
        BufferList.prototype.unshift = function(v) {
          var entry = {
            data: v,
            next: this.head
          };
          if (this.length === 0)
            this.tail = entry;
          this.head = entry;
          ++this.length;
        };
        BufferList.prototype.shift = function() {
          if (this.length === 0)
            return;
          var ret = this.head.data;
          if (this.length === 1)
            this.head = this.tail = null;
          else
            this.head = this.head.next;
          --this.length;
          return ret;
        };
        BufferList.prototype.clear = function() {
          this.head = this.tail = null;
          this.length = 0;
        };
        BufferList.prototype.join = function(s) {
          if (this.length === 0)
            return '';
          var p = this.head;
          var ret = '' + p.data;
          while (p = p.next) {
            ret += s + p.data;
          }
          return ret;
        };
        BufferList.prototype.concat = function(n) {
          if (this.length === 0)
            return bufferShim.alloc(0);
          if (this.length === 1)
            return this.head.data;
          var ret = bufferShim.allocUnsafe(n >>> 0);
          var p = this.head;
          var i = 0;
          while (p) {
            p.data.copy(ret, i);
            i += p.data.length;
            p = p.next;
          }
          return ret;
        };
      }, {
        "buffer": 11,
        "buffer-shims": 12
      }],
      43: [function(require, module, exports) {
        (function(process) {
          var Stream = (function() {
            try {
              return require('st' + 'ream');
            } catch (_) {}
          }());
          exports = module.exports = require('./lib/_stream_readable');
          exports.Stream = Stream || exports;
          exports.Readable = exports;
          exports.Writable = require('./lib/_stream_writable');
          exports.Duplex = require('./lib/_stream_duplex');
          exports.Transform = require('./lib/_stream_transform');
          exports.PassThrough = require('./lib/_stream_passthrough');
          if (!process.browser && process.env.READABLE_STREAM === 'disable' && Stream) {
            module.exports = Stream;
          }
        }).call(this, require('_process'));
      }, {
        "./lib/_stream_duplex.js": 37,
        "./lib/_stream_passthrough.js": 38,
        "./lib/_stream_readable.js": 39,
        "./lib/_stream_transform.js": 40,
        "./lib/_stream_writable.js": 41,
        "_process": 31
      }],
      44: [function(require, module, exports) {
        module.exports = require('./lib/_stream_transform');
      }, {"./lib/_stream_transform.js": 40}],
      45: [function(require, module, exports) {
        'use strict';
        function ReInterval(callback, interval, args) {
          var self = this;
          this._callback = callback;
          this._args = args;
          this._interval = setInterval(callback, interval, this._args);
          this.reschedule = function(interval) {
            if (!interval)
              interval = self._interval;
            if (self._interval)
              clearInterval(self._interval);
            self._interval = setInterval(self._callback, interval, self._args);
          };
          this.clear = function() {
            if (self._interval) {
              clearInterval(self._interval);
              self._interval = undefined;
            }
          };
          this.destroy = function() {
            if (self._interval) {
              clearInterval(self._interval);
            }
            self._callback = undefined;
            self._interval = undefined;
            self._args = undefined;
          };
        }
        function reInterval() {
          if (typeof arguments[0] !== 'function')
            throw new Error('callback needed');
          if (typeof arguments[1] !== 'number')
            throw new Error('interval needed');
          var args;
          if (arguments.length > 0) {
            args = new Array(arguments.length - 2);
            for (var i = 0; i < args.length; i++) {
              args[i] = arguments[i + 2];
            }
          }
          return new ReInterval(arguments[0], arguments[1], args);
        }
        module.exports = reInterval;
      }, {}],
      46: [function(require, module, exports) {
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
      }, {}],
      47: [function(require, module, exports) {
        var Buffer = require('buffer').Buffer;
        var isBufferEncoding = Buffer.isEncoding || function(encoding) {
          switch (encoding && encoding.toLowerCase()) {
            case 'hex':
            case 'utf8':
            case 'utf-8':
            case 'ascii':
            case 'binary':
            case 'base64':
            case 'ucs2':
            case 'ucs-2':
            case 'utf16le':
            case 'utf-16le':
            case 'raw':
              return true;
            default:
              return false;
          }
        };
        function assertEncoding(encoding) {
          if (encoding && !isBufferEncoding(encoding)) {
            throw new Error('Unknown encoding: ' + encoding);
          }
        }
        var StringDecoder = exports.StringDecoder = function(encoding) {
          this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/, '');
          assertEncoding(encoding);
          switch (this.encoding) {
            case 'utf8':
              this.surrogateSize = 3;
              break;
            case 'ucs2':
            case 'utf16le':
              this.surrogateSize = 2;
              this.detectIncompleteChar = utf16DetectIncompleteChar;
              break;
            case 'base64':
              this.surrogateSize = 3;
              this.detectIncompleteChar = base64DetectIncompleteChar;
              break;
            default:
              this.write = passThroughWrite;
              return;
          }
          this.charBuffer = new Buffer(6);
          this.charReceived = 0;
          this.charLength = 0;
        };
        StringDecoder.prototype.write = function(buffer) {
          var charStr = '';
          while (this.charLength) {
            var available = (buffer.length >= this.charLength - this.charReceived) ? this.charLength - this.charReceived : buffer.length;
            buffer.copy(this.charBuffer, this.charReceived, 0, available);
            this.charReceived += available;
            if (this.charReceived < this.charLength) {
              return '';
            }
            buffer = buffer.slice(available, buffer.length);
            charStr = this.charBuffer.slice(0, this.charLength).toString(this.encoding);
            var charCode = charStr.charCodeAt(charStr.length - 1);
            if (charCode >= 0xD800 && charCode <= 0xDBFF) {
              this.charLength += this.surrogateSize;
              charStr = '';
              continue;
            }
            this.charReceived = this.charLength = 0;
            if (buffer.length === 0) {
              return charStr;
            }
            break;
          }
          this.detectIncompleteChar(buffer);
          var end = buffer.length;
          if (this.charLength) {
            buffer.copy(this.charBuffer, 0, buffer.length - this.charReceived, end);
            end -= this.charReceived;
          }
          charStr += buffer.toString(this.encoding, 0, end);
          var end = charStr.length - 1;
          var charCode = charStr.charCodeAt(end);
          if (charCode >= 0xD800 && charCode <= 0xDBFF) {
            var size = this.surrogateSize;
            this.charLength += size;
            this.charReceived += size;
            this.charBuffer.copy(this.charBuffer, size, 0, size);
            buffer.copy(this.charBuffer, 0, 0, size);
            return charStr.substring(0, end);
          }
          return charStr;
        };
        StringDecoder.prototype.detectIncompleteChar = function(buffer) {
          var i = (buffer.length >= 3) ? 3 : buffer.length;
          for (; i > 0; i--) {
            var c = buffer[buffer.length - i];
            if (i == 1 && c >> 5 == 0x06) {
              this.charLength = 2;
              break;
            }
            if (i <= 2 && c >> 4 == 0x0E) {
              this.charLength = 3;
              break;
            }
            if (i <= 3 && c >> 3 == 0x1E) {
              this.charLength = 4;
              break;
            }
          }
          this.charReceived = i;
        };
        StringDecoder.prototype.end = function(buffer) {
          var res = '';
          if (buffer && buffer.length)
            res = this.write(buffer);
          if (this.charReceived) {
            var cr = this.charReceived;
            var buf = this.charBuffer;
            var enc = this.encoding;
            res += buf.slice(0, cr).toString(enc);
          }
          return res;
        };
        function passThroughWrite(buffer) {
          return buffer.toString(this.encoding);
        }
        function utf16DetectIncompleteChar(buffer) {
          this.charReceived = buffer.length % 2;
          this.charLength = this.charReceived ? 2 : 0;
        }
        function base64DetectIncompleteChar(buffer) {
          this.charReceived = buffer.length % 3;
          this.charLength = this.charReceived ? 3 : 0;
        }
      }, {"buffer": 11}],
      48: [function(require, module, exports) {
        (function(process) {
          var Transform = require('readable-stream/transform'),
              inherits = require('util').inherits,
              xtend = require('xtend');
          function DestroyableTransform(opts) {
            Transform.call(this, opts);
            this._destroyed = false;
          }
          inherits(DestroyableTransform, Transform);
          DestroyableTransform.prototype.destroy = function(err) {
            if (this._destroyed)
              return;
            this._destroyed = true;
            var self = this;
            process.nextTick(function() {
              if (err)
                self.emit('error', err);
              self.emit('close');
            });
          };
          function noop(chunk, enc, callback) {
            callback(null, chunk);
          }
          function through2(construct) {
            return function(options, transform, flush) {
              if (typeof options == 'function') {
                flush = transform;
                transform = options;
                options = {};
              }
              if (typeof transform != 'function')
                transform = noop;
              if (typeof flush != 'function')
                flush = null;
              return construct(options, transform, flush);
            };
          }
          module.exports = through2(function(options, transform, flush) {
            var t2 = new DestroyableTransform(options);
            t2._transform = transform;
            if (flush)
              t2._flush = flush;
            return t2;
          });
          module.exports.ctor = through2(function(options, transform, flush) {
            function Through2(override) {
              if (!(this instanceof Through2))
                return new Through2(override);
              this.options = xtend(options, override);
              DestroyableTransform.call(this, this.options);
            }
            inherits(Through2, DestroyableTransform);
            Through2.prototype._transform = transform;
            if (flush)
              Through2.prototype._flush = flush;
            return Through2;
          });
          module.exports.obj = through2(function(options, transform, flush) {
            var t2 = new DestroyableTransform(xtend({
              objectMode: true,
              highWaterMark: 16
            }, options));
            t2._transform = transform;
            if (flush)
              t2._flush = flush;
            return t2;
          });
        }).call(this, require('_process'));
      }, {
        "_process": 31,
        "readable-stream/transform": 44,
        "util": 54,
        "xtend": 58
      }],
      49: [function(require, module, exports) {
        'use strict';
        var punycode = require('punycode');
        var util = require('./util');
        exports.parse = urlParse;
        exports.resolve = urlResolve;
        exports.resolveObject = urlResolveObject;
        exports.format = urlFormat;
        exports.Url = Url;
        function Url() {
          this.protocol = null;
          this.slashes = null;
          this.auth = null;
          this.host = null;
          this.port = null;
          this.hostname = null;
          this.hash = null;
          this.search = null;
          this.query = null;
          this.pathname = null;
          this.path = null;
          this.href = null;
        }
        var protocolPattern = /^([a-z0-9.+-]+:)/i,
            portPattern = /:[0-9]*$/,
            simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,
            delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],
            unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),
            autoEscape = ['\''].concat(unwise),
            nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
            hostEndingChars = ['/', '?', '#'],
            hostnameMaxLen = 255,
            hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/,
            hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/,
            unsafeProtocol = {
              'javascript': true,
              'javascript:': true
            },
            hostlessProtocol = {
              'javascript': true,
              'javascript:': true
            },
            slashedProtocol = {
              'http': true,
              'https': true,
              'ftp': true,
              'gopher': true,
              'file': true,
              'http:': true,
              'https:': true,
              'ftp:': true,
              'gopher:': true,
              'file:': true
            },
            querystring = require('querystring');
        function urlParse(url, parseQueryString, slashesDenoteHost) {
          if (url && util.isObject(url) && url instanceof Url)
            return url;
          var u = new Url;
          u.parse(url, parseQueryString, slashesDenoteHost);
          return u;
        }
        Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
          if (!util.isString(url)) {
            throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
          }
          var queryIndex = url.indexOf('?'),
              splitter = (queryIndex !== -1 && queryIndex < url.indexOf('#')) ? '?' : '#',
              uSplit = url.split(splitter),
              slashRegex = /\\/g;
          uSplit[0] = uSplit[0].replace(slashRegex, '/');
          url = uSplit.join(splitter);
          var rest = url;
          rest = rest.trim();
          if (!slashesDenoteHost && url.split('#').length === 1) {
            var simplePath = simplePathPattern.exec(rest);
            if (simplePath) {
              this.path = rest;
              this.href = rest;
              this.pathname = simplePath[1];
              if (simplePath[2]) {
                this.search = simplePath[2];
                if (parseQueryString) {
                  this.query = querystring.parse(this.search.substr(1));
                } else {
                  this.query = this.search.substr(1);
                }
              } else if (parseQueryString) {
                this.search = '';
                this.query = {};
              }
              return this;
            }
          }
          var proto = protocolPattern.exec(rest);
          if (proto) {
            proto = proto[0];
            var lowerProto = proto.toLowerCase();
            this.protocol = lowerProto;
            rest = rest.substr(proto.length);
          }
          if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
            var slashes = rest.substr(0, 2) === '//';
            if (slashes && !(proto && hostlessProtocol[proto])) {
              rest = rest.substr(2);
              this.slashes = true;
            }
          }
          if (!hostlessProtocol[proto] && (slashes || (proto && !slashedProtocol[proto]))) {
            var hostEnd = -1;
            for (var i = 0; i < hostEndingChars.length; i++) {
              var hec = rest.indexOf(hostEndingChars[i]);
              if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
                hostEnd = hec;
            }
            var auth,
                atSign;
            if (hostEnd === -1) {
              atSign = rest.lastIndexOf('@');
            } else {
              atSign = rest.lastIndexOf('@', hostEnd);
            }
            if (atSign !== -1) {
              auth = rest.slice(0, atSign);
              rest = rest.slice(atSign + 1);
              this.auth = decodeURIComponent(auth);
            }
            hostEnd = -1;
            for (var i = 0; i < nonHostChars.length; i++) {
              var hec = rest.indexOf(nonHostChars[i]);
              if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
                hostEnd = hec;
            }
            if (hostEnd === -1)
              hostEnd = rest.length;
            this.host = rest.slice(0, hostEnd);
            rest = rest.slice(hostEnd);
            this.parseHost();
            this.hostname = this.hostname || '';
            var ipv6Hostname = this.hostname[0] === '[' && this.hostname[this.hostname.length - 1] === ']';
            if (!ipv6Hostname) {
              var hostparts = this.hostname.split(/\./);
              for (var i = 0,
                  l = hostparts.length; i < l; i++) {
                var part = hostparts[i];
                if (!part)
                  continue;
                if (!part.match(hostnamePartPattern)) {
                  var newpart = '';
                  for (var j = 0,
                      k = part.length; j < k; j++) {
                    if (part.charCodeAt(j) > 127) {
                      newpart += 'x';
                    } else {
                      newpart += part[j];
                    }
                  }
                  if (!newpart.match(hostnamePartPattern)) {
                    var validParts = hostparts.slice(0, i);
                    var notHost = hostparts.slice(i + 1);
                    var bit = part.match(hostnamePartStart);
                    if (bit) {
                      validParts.push(bit[1]);
                      notHost.unshift(bit[2]);
                    }
                    if (notHost.length) {
                      rest = '/' + notHost.join('.') + rest;
                    }
                    this.hostname = validParts.join('.');
                    break;
                  }
                }
              }
            }
            if (this.hostname.length > hostnameMaxLen) {
              this.hostname = '';
            } else {
              this.hostname = this.hostname.toLowerCase();
            }
            if (!ipv6Hostname) {
              this.hostname = punycode.toASCII(this.hostname);
            }
            var p = this.port ? ':' + this.port : '';
            var h = this.hostname || '';
            this.host = h + p;
            this.href += this.host;
            if (ipv6Hostname) {
              this.hostname = this.hostname.substr(1, this.hostname.length - 2);
              if (rest[0] !== '/') {
                rest = '/' + rest;
              }
            }
          }
          if (!unsafeProtocol[lowerProto]) {
            for (var i = 0,
                l = autoEscape.length; i < l; i++) {
              var ae = autoEscape[i];
              if (rest.indexOf(ae) === -1)
                continue;
              var esc = encodeURIComponent(ae);
              if (esc === ae) {
                esc = escape(ae);
              }
              rest = rest.split(ae).join(esc);
            }
          }
          var hash = rest.indexOf('#');
          if (hash !== -1) {
            this.hash = rest.substr(hash);
            rest = rest.slice(0, hash);
          }
          var qm = rest.indexOf('?');
          if (qm !== -1) {
            this.search = rest.substr(qm);
            this.query = rest.substr(qm + 1);
            if (parseQueryString) {
              this.query = querystring.parse(this.query);
            }
            rest = rest.slice(0, qm);
          } else if (parseQueryString) {
            this.search = '';
            this.query = {};
          }
          if (rest)
            this.pathname = rest;
          if (slashedProtocol[lowerProto] && this.hostname && !this.pathname) {
            this.pathname = '/';
          }
          if (this.pathname || this.search) {
            var p = this.pathname || '';
            var s = this.search || '';
            this.path = p + s;
          }
          this.href = this.format();
          return this;
        };
        function urlFormat(obj) {
          if (util.isString(obj))
            obj = urlParse(obj);
          if (!(obj instanceof Url))
            return Url.prototype.format.call(obj);
          return obj.format();
        }
        Url.prototype.format = function() {
          var auth = this.auth || '';
          if (auth) {
            auth = encodeURIComponent(auth);
            auth = auth.replace(/%3A/i, ':');
            auth += '@';
          }
          var protocol = this.protocol || '',
              pathname = this.pathname || '',
              hash = this.hash || '',
              host = false,
              query = '';
          if (this.host) {
            host = auth + this.host;
          } else if (this.hostname) {
            host = auth + (this.hostname.indexOf(':') === -1 ? this.hostname : '[' + this.hostname + ']');
            if (this.port) {
              host += ':' + this.port;
            }
          }
          if (this.query && util.isObject(this.query) && Object.keys(this.query).length) {
            query = querystring.stringify(this.query);
          }
          var search = this.search || (query && ('?' + query)) || '';
          if (protocol && protocol.substr(-1) !== ':')
            protocol += ':';
          if (this.slashes || (!protocol || slashedProtocol[protocol]) && host !== false) {
            host = '//' + (host || '');
            if (pathname && pathname.charAt(0) !== '/')
              pathname = '/' + pathname;
          } else if (!host) {
            host = '';
          }
          if (hash && hash.charAt(0) !== '#')
            hash = '#' + hash;
          if (search && search.charAt(0) !== '?')
            search = '?' + search;
          pathname = pathname.replace(/[?#]/g, function(match) {
            return encodeURIComponent(match);
          });
          search = search.replace('#', '%23');
          return protocol + host + pathname + search + hash;
        };
        function urlResolve(source, relative) {
          return urlParse(source, false, true).resolve(relative);
        }
        Url.prototype.resolve = function(relative) {
          return this.resolveObject(urlParse(relative, false, true)).format();
        };
        function urlResolveObject(source, relative) {
          if (!source)
            return relative;
          return urlParse(source, false, true).resolveObject(relative);
        }
        Url.prototype.resolveObject = function(relative) {
          if (util.isString(relative)) {
            var rel = new Url();
            rel.parse(relative, false, true);
            relative = rel;
          }
          var result = new Url();
          var tkeys = Object.keys(this);
          for (var tk = 0; tk < tkeys.length; tk++) {
            var tkey = tkeys[tk];
            result[tkey] = this[tkey];
          }
          result.hash = relative.hash;
          if (relative.href === '') {
            result.href = result.format();
            return result;
          }
          if (relative.slashes && !relative.protocol) {
            var rkeys = Object.keys(relative);
            for (var rk = 0; rk < rkeys.length; rk++) {
              var rkey = rkeys[rk];
              if (rkey !== 'protocol')
                result[rkey] = relative[rkey];
            }
            if (slashedProtocol[result.protocol] && result.hostname && !result.pathname) {
              result.path = result.pathname = '/';
            }
            result.href = result.format();
            return result;
          }
          if (relative.protocol && relative.protocol !== result.protocol) {
            if (!slashedProtocol[relative.protocol]) {
              var keys = Object.keys(relative);
              for (var v = 0; v < keys.length; v++) {
                var k = keys[v];
                result[k] = relative[k];
              }
              result.href = result.format();
              return result;
            }
            result.protocol = relative.protocol;
            if (!relative.host && !hostlessProtocol[relative.protocol]) {
              var relPath = (relative.pathname || '').split('/');
              while (relPath.length && !(relative.host = relPath.shift()))
                ;
              if (!relative.host)
                relative.host = '';
              if (!relative.hostname)
                relative.hostname = '';
              if (relPath[0] !== '')
                relPath.unshift('');
              if (relPath.length < 2)
                relPath.unshift('');
              result.pathname = relPath.join('/');
            } else {
              result.pathname = relative.pathname;
            }
            result.search = relative.search;
            result.query = relative.query;
            result.host = relative.host || '';
            result.auth = relative.auth;
            result.hostname = relative.hostname || relative.host;
            result.port = relative.port;
            if (result.pathname || result.search) {
              var p = result.pathname || '';
              var s = result.search || '';
              result.path = p + s;
            }
            result.slashes = result.slashes || relative.slashes;
            result.href = result.format();
            return result;
          }
          var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
              isRelAbs = (relative.host || relative.pathname && relative.pathname.charAt(0) === '/'),
              mustEndAbs = (isRelAbs || isSourceAbs || (result.host && relative.pathname)),
              removeAllDots = mustEndAbs,
              srcPath = result.pathname && result.pathname.split('/') || [],
              relPath = relative.pathname && relative.pathname.split('/') || [],
              psychotic = result.protocol && !slashedProtocol[result.protocol];
          if (psychotic) {
            result.hostname = '';
            result.port = null;
            if (result.host) {
              if (srcPath[0] === '')
                srcPath[0] = result.host;
              else
                srcPath.unshift(result.host);
            }
            result.host = '';
            if (relative.protocol) {
              relative.hostname = null;
              relative.port = null;
              if (relative.host) {
                if (relPath[0] === '')
                  relPath[0] = relative.host;
                else
                  relPath.unshift(relative.host);
              }
              relative.host = null;
            }
            mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
          }
          if (isRelAbs) {
            result.host = (relative.host || relative.host === '') ? relative.host : result.host;
            result.hostname = (relative.hostname || relative.hostname === '') ? relative.hostname : result.hostname;
            result.search = relative.search;
            result.query = relative.query;
            srcPath = relPath;
          } else if (relPath.length) {
            if (!srcPath)
              srcPath = [];
            srcPath.pop();
            srcPath = srcPath.concat(relPath);
            result.search = relative.search;
            result.query = relative.query;
          } else if (!util.isNullOrUndefined(relative.search)) {
            if (psychotic) {
              result.hostname = result.host = srcPath.shift();
              var authInHost = result.host && result.host.indexOf('@') > 0 ? result.host.split('@') : false;
              if (authInHost) {
                result.auth = authInHost.shift();
                result.host = result.hostname = authInHost.shift();
              }
            }
            result.search = relative.search;
            result.query = relative.query;
            if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
              result.path = (result.pathname ? result.pathname : '') + (result.search ? result.search : '');
            }
            result.href = result.format();
            return result;
          }
          if (!srcPath.length) {
            result.pathname = null;
            if (result.search) {
              result.path = '/' + result.search;
            } else {
              result.path = null;
            }
            result.href = result.format();
            return result;
          }
          var last = srcPath.slice(-1)[0];
          var hasTrailingSlash = ((result.host || relative.host || srcPath.length > 1) && (last === '.' || last === '..') || last === '');
          var up = 0;
          for (var i = srcPath.length; i >= 0; i--) {
            last = srcPath[i];
            if (last === '.') {
              srcPath.splice(i, 1);
            } else if (last === '..') {
              srcPath.splice(i, 1);
              up++;
            } else if (up) {
              srcPath.splice(i, 1);
              up--;
            }
          }
          if (!mustEndAbs && !removeAllDots) {
            for (; up--; up) {
              srcPath.unshift('..');
            }
          }
          if (mustEndAbs && srcPath[0] !== '' && (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
            srcPath.unshift('');
          }
          if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
            srcPath.push('');
          }
          var isAbsolute = srcPath[0] === '' || (srcPath[0] && srcPath[0].charAt(0) === '/');
          if (psychotic) {
            result.hostname = result.host = isAbsolute ? '' : srcPath.length ? srcPath.shift() : '';
            var authInHost = result.host && result.host.indexOf('@') > 0 ? result.host.split('@') : false;
            if (authInHost) {
              result.auth = authInHost.shift();
              result.host = result.hostname = authInHost.shift();
            }
          }
          mustEndAbs = mustEndAbs || (result.host && srcPath.length);
          if (mustEndAbs && !isAbsolute) {
            srcPath.unshift('');
          }
          if (!srcPath.length) {
            result.pathname = null;
            result.path = null;
          } else {
            result.pathname = srcPath.join('/');
          }
          if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
            result.path = (result.pathname ? result.pathname : '') + (result.search ? result.search : '');
          }
          result.auth = relative.auth || result.auth;
          result.slashes = result.slashes || relative.slashes;
          result.href = result.format();
          return result;
        };
        Url.prototype.parseHost = function() {
          var host = this.host;
          var port = portPattern.exec(host);
          if (port) {
            port = port[0];
            if (port !== ':') {
              this.port = port.substr(1);
            }
            host = host.substr(0, host.length - port.length);
          }
          if (host)
            this.hostname = host;
        };
      }, {
        "./util": 50,
        "punycode": 32,
        "querystring": 35
      }],
      50: [function(require, module, exports) {
        'use strict';
        module.exports = {
          isString: function(arg) {
            return typeof(arg) === 'string';
          },
          isObject: function(arg) {
            return typeof(arg) === 'object' && arg !== null;
          },
          isNull: function(arg) {
            return arg === null;
          },
          isNullOrUndefined: function(arg) {
            return arg == null;
          }
        };
      }, {}],
      51: [function(require, module, exports) {
        (function(global) {
          module.exports = deprecate;
          function deprecate(fn, msg) {
            if (config('noDeprecation')) {
              return fn;
            }
            var warned = false;
            function deprecated() {
              if (!warned) {
                if (config('throwDeprecation')) {
                  throw new Error(msg);
                } else if (config('traceDeprecation')) {
                  console.trace(msg);
                } else {
                  console.warn(msg);
                }
                warned = true;
              }
              return fn.apply(this, arguments);
            }
            return deprecated;
          }
          function config(name) {
            try {
              if (!global.localStorage)
                return false;
            } catch (_) {
              return false;
            }
            var val = global.localStorage[name];
            if (null == val)
              return false;
            return String(val).toLowerCase() === 'true';
          }
        }).call(this, typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
      }, {}],
      52: [function(require, module, exports) {
        arguments[4][19][0].apply(exports, arguments);
      }, {"dup": 19}],
      53: [function(require, module, exports) {
        module.exports = function isBuffer(arg) {
          return arg && typeof arg === 'object' && typeof arg.copy === 'function' && typeof arg.fill === 'function' && typeof arg.readUInt8 === 'function';
        };
      }, {}],
      54: [function(require, module, exports) {
        (function(process, global) {
          var formatRegExp = /%[sdj%]/g;
          exports.format = function(f) {
            if (!isString(f)) {
              var objects = [];
              for (var i = 0; i < arguments.length; i++) {
                objects.push(inspect(arguments[i]));
              }
              return objects.join(' ');
            }
            var i = 1;
            var args = arguments;
            var len = args.length;
            var str = String(f).replace(formatRegExp, function(x) {
              if (x === '%%')
                return '%';
              if (i >= len)
                return x;
              switch (x) {
                case '%s':
                  return String(args[i++]);
                case '%d':
                  return Number(args[i++]);
                case '%j':
                  try {
                    return JSON.stringify(args[i++]);
                  } catch (_) {
                    return '[Circular]';
                  }
                default:
                  return x;
              }
            });
            for (var x = args[i]; i < len; x = args[++i]) {
              if (isNull(x) || !isObject(x)) {
                str += ' ' + x;
              } else {
                str += ' ' + inspect(x);
              }
            }
            return str;
          };
          exports.deprecate = function(fn, msg) {
            if (isUndefined(global.process)) {
              return function() {
                return exports.deprecate(fn, msg).apply(this, arguments);
              };
            }
            if (process.noDeprecation === true) {
              return fn;
            }
            var warned = false;
            function deprecated() {
              if (!warned) {
                if (process.throwDeprecation) {
                  throw new Error(msg);
                } else if (process.traceDeprecation) {
                  console.trace(msg);
                } else {
                  console.error(msg);
                }
                warned = true;
              }
              return fn.apply(this, arguments);
            }
            return deprecated;
          };
          var debugs = {};
          var debugEnviron;
          exports.debuglog = function(set) {
            if (isUndefined(debugEnviron))
              debugEnviron = process.env.NODE_DEBUG || '';
            set = set.toUpperCase();
            if (!debugs[set]) {
              if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
                var pid = process.pid;
                debugs[set] = function() {
                  var msg = exports.format.apply(exports, arguments);
                  console.error('%s %d: %s', set, pid, msg);
                };
              } else {
                debugs[set] = function() {};
              }
            }
            return debugs[set];
          };
          function inspect(obj, opts) {
            var ctx = {
              seen: [],
              stylize: stylizeNoColor
            };
            if (arguments.length >= 3)
              ctx.depth = arguments[2];
            if (arguments.length >= 4)
              ctx.colors = arguments[3];
            if (isBoolean(opts)) {
              ctx.showHidden = opts;
            } else if (opts) {
              exports._extend(ctx, opts);
            }
            if (isUndefined(ctx.showHidden))
              ctx.showHidden = false;
            if (isUndefined(ctx.depth))
              ctx.depth = 2;
            if (isUndefined(ctx.colors))
              ctx.colors = false;
            if (isUndefined(ctx.customInspect))
              ctx.customInspect = true;
            if (ctx.colors)
              ctx.stylize = stylizeWithColor;
            return formatValue(ctx, obj, ctx.depth);
          }
          exports.inspect = inspect;
          inspect.colors = {
            'bold': [1, 22],
            'italic': [3, 23],
            'underline': [4, 24],
            'inverse': [7, 27],
            'white': [37, 39],
            'grey': [90, 39],
            'black': [30, 39],
            'blue': [34, 39],
            'cyan': [36, 39],
            'green': [32, 39],
            'magenta': [35, 39],
            'red': [31, 39],
            'yellow': [33, 39]
          };
          inspect.styles = {
            'special': 'cyan',
            'number': 'yellow',
            'boolean': 'yellow',
            'undefined': 'grey',
            'null': 'bold',
            'string': 'green',
            'date': 'magenta',
            'regexp': 'red'
          };
          function stylizeWithColor(str, styleType) {
            var style = inspect.styles[styleType];
            if (style) {
              return '\u001b[' + inspect.colors[style][0] + 'm' + str + '\u001b[' + inspect.colors[style][1] + 'm';
            } else {
              return str;
            }
          }
          function stylizeNoColor(str, styleType) {
            return str;
          }
          function arrayToHash(array) {
            var hash = {};
            array.forEach(function(val, idx) {
              hash[val] = true;
            });
            return hash;
          }
          function formatValue(ctx, value, recurseTimes) {
            if (ctx.customInspect && value && isFunction(value.inspect) && value.inspect !== exports.inspect && !(value.constructor && value.constructor.prototype === value)) {
              var ret = value.inspect(recurseTimes, ctx);
              if (!isString(ret)) {
                ret = formatValue(ctx, ret, recurseTimes);
              }
              return ret;
            }
            var primitive = formatPrimitive(ctx, value);
            if (primitive) {
              return primitive;
            }
            var keys = Object.keys(value);
            var visibleKeys = arrayToHash(keys);
            if (ctx.showHidden) {
              keys = Object.getOwnPropertyNames(value);
            }
            if (isError(value) && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
              return formatError(value);
            }
            if (keys.length === 0) {
              if (isFunction(value)) {
                var name = value.name ? ': ' + value.name : '';
                return ctx.stylize('[Function' + name + ']', 'special');
              }
              if (isRegExp(value)) {
                return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
              }
              if (isDate(value)) {
                return ctx.stylize(Date.prototype.toString.call(value), 'date');
              }
              if (isError(value)) {
                return formatError(value);
              }
            }
            var base = '',
                array = false,
                braces = ['{', '}'];
            if (isArray(value)) {
              array = true;
              braces = ['[', ']'];
            }
            if (isFunction(value)) {
              var n = value.name ? ': ' + value.name : '';
              base = ' [Function' + n + ']';
            }
            if (isRegExp(value)) {
              base = ' ' + RegExp.prototype.toString.call(value);
            }
            if (isDate(value)) {
              base = ' ' + Date.prototype.toUTCString.call(value);
            }
            if (isError(value)) {
              base = ' ' + formatError(value);
            }
            if (keys.length === 0 && (!array || value.length == 0)) {
              return braces[0] + base + braces[1];
            }
            if (recurseTimes < 0) {
              if (isRegExp(value)) {
                return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
              } else {
                return ctx.stylize('[Object]', 'special');
              }
            }
            ctx.seen.push(value);
            var output;
            if (array) {
              output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
            } else {
              output = keys.map(function(key) {
                return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
              });
            }
            ctx.seen.pop();
            return reduceToSingleString(output, base, braces);
          }
          function formatPrimitive(ctx, value) {
            if (isUndefined(value))
              return ctx.stylize('undefined', 'undefined');
            if (isString(value)) {
              var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '').replace(/'/g, "\\'").replace(/\\"/g, '"') + '\'';
              return ctx.stylize(simple, 'string');
            }
            if (isNumber(value))
              return ctx.stylize('' + value, 'number');
            if (isBoolean(value))
              return ctx.stylize('' + value, 'boolean');
            if (isNull(value))
              return ctx.stylize('null', 'null');
          }
          function formatError(value) {
            return '[' + Error.prototype.toString.call(value) + ']';
          }
          function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
            var output = [];
            for (var i = 0,
                l = value.length; i < l; ++i) {
              if (hasOwnProperty(value, String(i))) {
                output.push(formatProperty(ctx, value, recurseTimes, visibleKeys, String(i), true));
              } else {
                output.push('');
              }
            }
            keys.forEach(function(key) {
              if (!key.match(/^\d+$/)) {
                output.push(formatProperty(ctx, value, recurseTimes, visibleKeys, key, true));
              }
            });
            return output;
          }
          function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
            var name,
                str,
                desc;
            desc = Object.getOwnPropertyDescriptor(value, key) || {value: value[key]};
            if (desc.get) {
              if (desc.set) {
                str = ctx.stylize('[Getter/Setter]', 'special');
              } else {
                str = ctx.stylize('[Getter]', 'special');
              }
            } else {
              if (desc.set) {
                str = ctx.stylize('[Setter]', 'special');
              }
            }
            if (!hasOwnProperty(visibleKeys, key)) {
              name = '[' + key + ']';
            }
            if (!str) {
              if (ctx.seen.indexOf(desc.value) < 0) {
                if (isNull(recurseTimes)) {
                  str = formatValue(ctx, desc.value, null);
                } else {
                  str = formatValue(ctx, desc.value, recurseTimes - 1);
                }
                if (str.indexOf('\n') > -1) {
                  if (array) {
                    str = str.split('\n').map(function(line) {
                      return '  ' + line;
                    }).join('\n').substr(2);
                  } else {
                    str = '\n' + str.split('\n').map(function(line) {
                      return '   ' + line;
                    }).join('\n');
                  }
                }
              } else {
                str = ctx.stylize('[Circular]', 'special');
              }
            }
            if (isUndefined(name)) {
              if (array && key.match(/^\d+$/)) {
                return str;
              }
              name = JSON.stringify('' + key);
              if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
                name = name.substr(1, name.length - 2);
                name = ctx.stylize(name, 'name');
              } else {
                name = name.replace(/'/g, "\\'").replace(/\\"/g, '"').replace(/(^"|"$)/g, "'");
                name = ctx.stylize(name, 'string');
              }
            }
            return name + ': ' + str;
          }
          function reduceToSingleString(output, base, braces) {
            var numLinesEst = 0;
            var length = output.reduce(function(prev, cur) {
              numLinesEst++;
              if (cur.indexOf('\n') >= 0)
                numLinesEst++;
              return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
            }, 0);
            if (length > 60) {
              return braces[0] + (base === '' ? '' : base + '\n ') + ' ' + output.join(',\n  ') + ' ' + braces[1];
            }
            return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
          }
          function isArray(ar) {
            return Array.isArray(ar);
          }
          exports.isArray = isArray;
          function isBoolean(arg) {
            return typeof arg === 'boolean';
          }
          exports.isBoolean = isBoolean;
          function isNull(arg) {
            return arg === null;
          }
          exports.isNull = isNull;
          function isNullOrUndefined(arg) {
            return arg == null;
          }
          exports.isNullOrUndefined = isNullOrUndefined;
          function isNumber(arg) {
            return typeof arg === 'number';
          }
          exports.isNumber = isNumber;
          function isString(arg) {
            return typeof arg === 'string';
          }
          exports.isString = isString;
          function isSymbol(arg) {
            return typeof arg === 'symbol';
          }
          exports.isSymbol = isSymbol;
          function isUndefined(arg) {
            return arg === void 0;
          }
          exports.isUndefined = isUndefined;
          function isRegExp(re) {
            return isObject(re) && objectToString(re) === '[object RegExp]';
          }
          exports.isRegExp = isRegExp;
          function isObject(arg) {
            return typeof arg === 'object' && arg !== null;
          }
          exports.isObject = isObject;
          function isDate(d) {
            return isObject(d) && objectToString(d) === '[object Date]';
          }
          exports.isDate = isDate;
          function isError(e) {
            return isObject(e) && (objectToString(e) === '[object Error]' || e instanceof Error);
          }
          exports.isError = isError;
          function isFunction(arg) {
            return typeof arg === 'function';
          }
          exports.isFunction = isFunction;
          function isPrimitive(arg) {
            return arg === null || typeof arg === 'boolean' || typeof arg === 'number' || typeof arg === 'string' || typeof arg === 'symbol' || typeof arg === 'undefined';
          }
          exports.isPrimitive = isPrimitive;
          exports.isBuffer = require('./support/isBuffer');
          function objectToString(o) {
            return Object.prototype.toString.call(o);
          }
          function pad(n) {
            return n < 10 ? '0' + n.toString(10) : n.toString(10);
          }
          var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          function timestamp() {
            var d = new Date();
            var time = [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(':');
            return [d.getDate(), months[d.getMonth()], time].join(' ');
          }
          exports.log = function() {
            console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
          };
          exports.inherits = require('inherits');
          exports._extend = function(origin, add) {
            if (!add || !isObject(add))
              return origin;
            var keys = Object.keys(add);
            var i = keys.length;
            while (i--) {
              origin[keys[i]] = add[keys[i]];
            }
            return origin;
          };
          function hasOwnProperty(obj, prop) {
            return Object.prototype.hasOwnProperty.call(obj, prop);
          }
        }).call(this, require('_process'), typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
      }, {
        "./support/isBuffer": 53,
        "_process": 31,
        "inherits": 52
      }],
      55: [function(require, module, exports) {
        (function(process, global, Buffer) {
          'use strict';
          var through = require('through2');
          var duplexify = require('duplexify');
          var WS = require('ws');
          module.exports = WebSocketStream;
          function WebSocketStream(target, protocols, options) {
            var stream,
                socket;
            var isBrowser = process.title === 'browser';
            var isNative = !!global.WebSocket;
            var socketWrite = isBrowser ? socketWriteBrowser : socketWriteNode;
            var proxy = through.obj(socketWrite, socketEnd);
            if (protocols && !Array.isArray(protocols) && 'object' === typeof protocols) {
              options = protocols;
              protocols = null;
              if (typeof options.protocol === 'string' || Array.isArray(options.protocol)) {
                protocols = options.protocol;
              }
            }
            if (!options)
              options = {};
            var bufferSize = options.browserBufferSize || 1024 * 512;
            var bufferTimeout = options.browserBufferTimeout || 1000;
            if (typeof target === 'object') {
              socket = target;
            } else {
              if (isNative && isBrowser) {
                socket = new WS(target, protocols);
              } else {
                socket = new WS(target, protocols, options);
              }
              socket.binaryType = 'arraybuffer';
            }
            if (socket.readyState === WS.OPEN) {
              stream = proxy;
            } else {
              stream = duplexify.obj();
              socket.onopen = onopen;
            }
            stream.socket = socket;
            socket.onclose = onclose;
            socket.onerror = onerror;
            socket.onmessage = onmessage;
            proxy.on('close', destroy);
            var coerceToBuffer = options.binary || options.binary === undefined;
            function socketWriteNode(chunk, enc, next) {
              if (coerceToBuffer && typeof chunk === 'string') {
                chunk = new Buffer(chunk, 'utf8');
              }
              socket.send(chunk, next);
            }
            function socketWriteBrowser(chunk, enc, next) {
              if (socket.bufferedAmount > bufferSize) {
                setTimeout(socketWriteBrowser, bufferTimeout, chunk, enc, next);
                return;
              }
              if (coerceToBuffer && typeof chunk === 'string') {
                chunk = new Buffer(chunk, 'utf8');
              }
              try {
                socket.send(chunk);
              } catch (err) {
                return next(err);
              }
              next();
            }
            function socketEnd(done) {
              socket.close();
              done();
            }
            function onopen() {
              stream.setReadable(proxy);
              stream.setWritable(proxy);
              stream.emit('connect');
            }
            function onclose() {
              stream.end();
              stream.destroy();
            }
            function onerror(err) {
              stream.destroy(err);
            }
            function onmessage(event) {
              var data = event.data;
              if (data instanceof ArrayBuffer)
                data = new Buffer(new Uint8Array(data));
              else
                data = new Buffer(data);
              proxy.push(data);
            }
            function destroy() {
              socket.close();
            }
            return stream;
          }
        }).call(this, require('_process'), typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {}, require('buffer').Buffer);
      }, {
        "_process": 31,
        "buffer": 11,
        "duplexify": 14,
        "through2": 48,
        "ws": 56
      }],
      56: [function(require, module, exports) {
        var ws = null;
        if (typeof WebSocket !== 'undefined') {
          ws = WebSocket;
        } else if (typeof MozWebSocket !== 'undefined') {
          ws = MozWebSocket;
        } else {
          ws = window.WebSocket || window.MozWebSocket;
        }
        module.exports = ws;
      }, {}],
      57: [function(require, module, exports) {
        module.exports = wrappy;
        function wrappy(fn, cb) {
          if (fn && cb)
            return wrappy(fn)(cb);
          if (typeof fn !== 'function')
            throw new TypeError('need wrapper function');
          Object.keys(fn).forEach(function(k) {
            wrapper[k] = fn[k];
          });
          return wrapper;
          function wrapper() {
            var args = new Array(arguments.length);
            for (var i = 0; i < args.length; i++) {
              args[i] = arguments[i];
            }
            var ret = fn.apply(this, args);
            var cb = args[args.length - 1];
            if (typeof ret === 'function' && ret !== cb) {
              Object.keys(cb).forEach(function(k) {
                ret[k] = cb[k];
              });
            }
            return ret;
          }
        }
      }, {}],
      58: [function(require, module, exports) {
        module.exports = extend;
        var hasOwnProperty = Object.prototype.hasOwnProperty;
        function extend() {
          var target = {};
          for (var i = 0; i < arguments.length; i++) {
            var source = arguments[i];
            for (var key in source) {
              if (hasOwnProperty.call(source, key)) {
                target[key] = source[key];
              }
            }
          }
          return target;
        }
      }, {}]
    }, {}, [7])(7);
  });
})(require('buffer').Buffer, require('process'));
