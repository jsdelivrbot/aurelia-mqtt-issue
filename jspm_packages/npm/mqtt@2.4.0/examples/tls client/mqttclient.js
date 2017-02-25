/* */ 
'use strict';
var mqtt = require('../../lib/connect/index');
var fs = require('@empty');
var path = require('path');
var KEY = fs.readFileSync(path.join(__dirname, '/tls-key.pem'));
var CERT = fs.readFileSync(path.join(__dirname, '/tls-cert.pem'));
var TRUSTED_CA_LIST = fs.readFileSync(path.join(__dirname, '/crt.ca.cg.pem'));
var PORT = 1883;
var HOST = 'stark';
var options = {
  port: PORT,
  host: HOST,
  key: KEY,
  cert: CERT,
  rejectUnauthorized: true,
  ca: TRUSTED_CA_LIST
};
var client = mqtt.connect(options);
client.subscribe('messages');
client.publish('messages', 'Current time is: ' + new Date());
client.on('message', function(topic, message) {
  console.log(message);
});
client.on('connect', function() {
  console.log('Connected');
});
