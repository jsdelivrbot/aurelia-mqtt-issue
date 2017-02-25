/* */ 
'use strict';
var mqtt = require('../../lib/connect/index');
var client = mqtt.connect();
client.publish('presence', 'hello!');
client.end();
