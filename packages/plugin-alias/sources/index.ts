import {Plugin} from '@yarnpkg/core';

import aliasRun from './commands/alias-run';

const plugin: Plugin = {
  commands: [
    aliasRun,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
