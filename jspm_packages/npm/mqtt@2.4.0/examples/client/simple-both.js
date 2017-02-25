/* */ 
'use strict';
var mqtt = require('../../lib/connect/index');
var client = mqtt.connect();
client.subscribe('presence');
client.publish('presence', 'bin hier');
client.on('message', function(topic, message) {
  console.log(message);
});
client.end();
