/* */ 
'use strict';
var mqtt = require('../../lib/connect/index');
var client = mqtt.connect();
client.subscribe('presence');
client.on('message', function(topic, message) {
  console.log(message);
});
