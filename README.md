# aurelia-mqtt-issue

I create a minimalist aurelia install based on instructions from [How to set up minimal Aurelia project from scratch](http://stackoverflow.com/questions/32080221/how-to-set-up-minimal-aurelia-project-from-scratch)

Then I install mqtt with :

```
jspm install npm:mqtt
```

Finally I try to import mqtt by adding the following line in the *app.js*.

```
import mqtt from 'mqtt';
```

Which results in the following error :

```
Error: (SystemJS) Cannot read property 'prototype' of undefined
	TypeError: Cannot read property 'prototype' of undefined
	    at inherits (http://localhost:9000/jspm_packages/npm/inherits@2.0.3/inherits_browser.js:6:45)
	    at Object.eval (http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/server.js:24:1)
	    at eval (http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/server.js:26:4)
	    at eval (http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/server.js:27:3)
	    at eval (<anonymous>)
	Evaluating http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/server.js
	Evaluating http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/index.js
	Evaluating http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3.js
	Evaluating http://localhost:9000/jspm_packages/npm/mqtt@2.4.0/lib/connect/ws.js
	Evaluating http://localhost:9000/jspm_packages/npm/mqtt@2.4.0/lib/connect/index.js
	Evaluating http://localhost:9000/jspm_packages/npm/mqtt@2.4.0/mqtt.js
	Evaluating http://localhost:9000/jspm_packages/npm/mqtt@2.4.0.js
	Error loading http://localhost:9000/app.js
	    at inherits (http://localhost:9000/jspm_packages/npm/inherits@2.0.3/inherits_browser.js:6:45)
	    at Object.eval (http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/server.js:24:1)
	    at eval (http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/server.js:26:4)
	    at eval (http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/server.js:27:3)
	    at eval (<anonymous>)
	Evaluating http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/server.js
	Evaluating http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3/index.js
	Evaluating http://localhost:9000/jspm_packages/npm/websocket-stream@3.3.3.js
	Evaluating http://localhost:9000/jspm_packages/npm/mqtt@2.4.0/lib/connect/ws.js
	Evaluating http://localhost:9000/jspm_packages/npm/mqtt@2.4.0/lib/connect/index.js
	Evaluating http://localhost:9000/jspm_packages/npm/mqtt@2.4.0/mqtt.js
	Evaluating http://localhost:9000/jspm_packages/npm/mqtt@2.4.0.js
	Error loading http://localhost:9000/app.js
  ```
