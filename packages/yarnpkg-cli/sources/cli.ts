import './polyfills';

import {YarnVersion}            from '@yarnpkg/core';

import {main}                   from './main';
import {getPluginConfiguration} from './tools/getPluginConfiguration';

console.log(`initializing, pid:`, process.pid);

main({
  binaryVersion: YarnVersion || `<unknown>`,
  pluginConfiguration: getPluginConfiguration(),
});
