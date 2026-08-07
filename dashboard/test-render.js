const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader, VirtualConsole } = require(path.join(process.env.APPDATA || (process.env.HOME || '.'), 'workbuddy-installed/jsdom')) || require('jsdom');
