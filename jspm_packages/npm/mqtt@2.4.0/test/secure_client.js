/* */ 
'use strict';
var mqtt = require('../lib/connect/index');
var path = require('path');
var abstractClientTests = require('./abstract_client');
var fs = require('@empty');
var port = 9899;
var KEY = path.join(__dirname, 'helpers', 'tls-key.pem');
var CERT = path.join(__dirname, 'helpers', 'tls-cert.pem');
var WRONG_CERT = path.join(__dirname, 'helpers', 'wrong-cert.pem');
var Server = require('./server');
var server = new Server.SecureServer({
  key: fs.readFileSync(KEY),
  cert: fs.readFileSync(CERT)
}, function(client) {
  client.on('connect', function(packet) {
    if (packet.clientId === 'invalid') {
      client.connack({returnCode: 2});
    } else {
      server.emit('connect', client);
      client.connack({returnCode: 0});
    }
  });
  client.on('publish', function(packet) {
    setImmediate(function() {
      switch (packet.qos) {
        case 0:
          break;
        case 1:
          client.puback(packet);
          break;
        case 2:
          client.pubrec(packet);
          break;
      }
    });
  });
  client.on('pubrel', function(packet) {
    client.pubcomp(packet);
  });
  client.on('pubrec', function(packet) {
    client.pubrel(packet);
  });
  client.on('pubcomp', function() {});
  client.on('subscribe', function(packet) {
    client.suback({
      messageId: packet.messageId,
      granted: packet.subscriptions.map(function(e) {
        return e.qos;
      })
    });
  });
  client.on('unsubscribe', function(packet) {
    client.unsuback(packet);
  });
  client.on('pingreq', function() {
    client.pingresp();
  });
}).listen(port);
describe('MqttSecureClient', function() {
  var config = {
    protocol: 'mqtts',
    port: port,
    rejectUnauthorized: false
  };
  abstractClientTests(server, config);
  describe('with secure parameters', function() {
    it('should validate successfully the CA', function(done) {
      var client = mqtt.connect({
        protocol: 'mqtts',
        port: port,
        ca: [fs.readFileSync(CERT)],
        rejectUnauthorized: true
      });
      client.on('error', function(err) {
        done(err);
      });
      server.once('connect', function() {
        done();
      });
    });
    it('should validate unsuccessfully the CA', function(done) {
      var client = mqtt.connect({
        protocol: 'mqtts',
        port: port,
        ca: [fs.readFileSync(WRONG_CERT)],
        rejectUnauthorized: true
      });
      client.once('error', function() {
        done();
        client.end();
        client.on('error', function() {});
      });
    });
    it('should emit close on TLS error', function(done) {
      var client = mqtt.connect({
        protocol: 'mqtts',
        port: port,
        ca: [fs.readFileSync(WRONG_CERT)],
        rejectUnauthorized: true
      });
      client.on('error', function() {});
      client.once('close', function() {
        done();
      });
    });
  });
});
