import {Plugin}        from '@yarnpkg/core';

import {RunAllCommand} from "./commands/run-all";

const plugin: Plugin = {
  commands: [
    RunAllCommand,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
