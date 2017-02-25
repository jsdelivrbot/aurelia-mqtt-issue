/* */ 
(function(process) {
  'use strict';
  var mqtt = require('../../lib/connect/index');
  var HttpsProxyAgent = require('https-proxy-agent');
  var url = require('url');
  var endpoint = 'wss://<host><path>';
  var proxy = process.env.http_proxy || 'http://<proxy>:<port>';
  var parsed = url.parse(endpoint);
  var proxyOpts = url.parse(proxy);
  proxyOpts.secureEndpoint = parsed.protocol ? parsed.protocol === 'wss:' : true;
  var agent = new HttpsProxyAgent(proxyOpts);
  var wsOptions = {agent: agent};
  var mqttOptions = {
    keepalive: 60,
    reschedulePings: true,
    protocolId: 'MQTT',
    protocolVersion: 4,
    reconnectPeriod: 1000,
    connectTimeout: 30 * 1000,
    clean: true,
    clientId: 'testClient',
    wsOptions: wsOptions
  };
  var client = mqtt.connect(parsed, mqttOptions);
  client.on('connect', function() {
    console.log('connected');
  });
  client.on('error', function(a) {
    console.log('error!' + a);
  });
  client.on('offline', function(a) {
    console.log('lost connection!' + a);
  });
  client.on('close', function(a) {
    console.log('connection closed!' + a);
  });
  client.on('message', function(topic, message) {
    console.log(message.toString());
  });
})(require('process'));
