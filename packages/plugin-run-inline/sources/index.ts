import {Plugin}              from '@yarnpkg/core';

import {wrapScriptExecution} from './hooks/wrapScriptExecution';

const plugin: Plugin = {
  hooks: {
    wrapScriptExecution,
  },
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
