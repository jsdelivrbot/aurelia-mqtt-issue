/* */ 
(function(process) {
  'use strict';
  var commist = require('commist')();
  var help = require('./help-me')();
  commist.register('help', help.toStdout);
  commist.parse(process.argv.splice(2));
})(require('process'));
