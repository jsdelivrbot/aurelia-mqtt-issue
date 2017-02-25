/* */ 
'use strict';
var mqtt = require('./mqtt');
var crypto = require('crypto');
var max = 1E5;
var i;
var start = Date.now() / 1000;
var time;
var errors = 0;
var packets = 0;
var randomPacket;
var firstBytes = [16 * 1, 16 * 2, 16 * 3, 16 * 3 + 1, 16 * 3 + 8, 16 * 3 + 1 + 8, 16 * 3 + 2, 16 * 3 + 2 + 1, 16 * 3 + 2 + 8, 16 * 3 + 2 + 1 + 8, 16 * 3 + 4, 16 * 3 + 4 + 1, 16 * 3 + 4 + 8, 16 * 3 + 4 + 1 + 8, 16 * 4, 16 * 5, 16 * 6, 16 * 7, 16 * 8, 16 * 9, 16 * 10, 16 * 11, 16 * 12, 16 * 13, 16 * 14, 16 * 15];
function doParse() {
  var parser = mqtt.parser();
  parser.on('error', onError);
  parser.on('packet', onPacket);
  randomPacket = crypto.randomBytes(Math.floor(Math.random() * 512));
  if (Math.random() > 0.2 && randomPacket.length > 0)
    randomPacket.writeUInt8(firstBytes[Math.floor(Math.random() * firstBytes.length)], 0);
  parser.parse(randomPacket);
}
try {
  console.log('Starting benchmark');
  for (i = 0; i < max; i++) {
    doParse();
  }
} catch (e) {
  console.log('Exception occured at packet');
  console.log(randomPacket);
  console.log(e.message);
  console.log(e.stack);
}
function onError() {
  errors++;
}
function onPacket() {
  packets++;
}
var delta = Math.abs(max - packets - errors);
time = Date.now() / 1000 - start;
console.log('Benchmark complete');
console.log('==========================');
console.log('Sent packets:', max);
console.log('Total time:', Math.round(time * 100) / 100, 'seconds', '\r\n');
console.log('Valid packets:', packets);
console.log('Erroneous packets:', errors);
if ((max - packets - errors) < 0)
  console.log('Excess packets:', delta, '\r\n');
else
  console.log('Missing packets:', delta, '\r\n');
console.log('Total packets:', packets + errors);
console.log('Total errors:', errors + delta);
console.log('Error rate:', ((errors + delta) / max * 100).toFixed(2) + '%');
console.log('==========================');
