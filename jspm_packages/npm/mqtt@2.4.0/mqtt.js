/* */ 
(function(process) {
  'use strict';
  var MqttClient = require('./lib/client');
  var connect = require('./lib/connect/index');
  var Store = require('./lib/store');
  module.exports.connect = connect;
  module.exports.MqttClient = MqttClient;
  module.exports.Client = MqttClient;
  module.exports.Store = Store;
  function cli() {
    var commist = require('commist')();
    var helpMe = require('help-me')();
    commist.register('publish', require('./bin/pub'));
    commist.register('subscribe', require('./bin/sub'));
    commist.register('version', function() {
      console.log('MQTT.js version:', require('./package.json!systemjs-json').version);
    });
    commist.register('help', helpMe.toStdout);
    if (commist.parse(process.argv.slice(2)) !== null) {
      console.log('No such command:', process.argv[2], '\n');
      helpMe.toStdout();
    }
  }
  if (require.main === module) {
    cli();
  }
})(require('process'));
