/* */ 
(function(Buffer) {
  var mqtt = require('../mqtt');
  var parser = mqtt.parser();
  var max = 10000000;
  var i;
  var start = Date.now() / 1000;
  var time;
  for (i = 0; i < max; i++) {
    parser.parse(new Buffer([48, 10, 0, 4, 116, 101, 115, 116, 116, 101, 115, 116]));
  }
  time = Date.now() / 1000 - start;
  console.log('Total packets', max);
  console.log('Total time', Math.round(time * 100) / 100);
  console.log('Packet/s', max / time);
})(require('buffer').Buffer);
