import './polyfills';

// eslint-disable-next-line arca/import-ordering
import {YarnVersion}            from '@yarnpkg/core';

import {main}                   from './main';
import {getPluginConfiguration} from './tools/getPluginConfiguration';

console.log(`yarn pid: ${process.pid}; args: ${process.argv.slice(2).join(` `)}`);

main({
  binaryVersion: YarnVersion || `<unknown>`,
  pluginConfiguration: getPluginConfiguration(),
});
