import {Plugin}              from '@yarnpkg/core';

import aliasRun              from './commands/alias-run';
import {wrapScriptExecution} from './hooks/wrapScriptExecution';

const plugin: Plugin = {
  commands: [
    aliasRun,
  ],
  hooks: {
    wrapScriptExecution,
  },
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
