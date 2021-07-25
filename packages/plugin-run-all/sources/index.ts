import {Plugin}        from '@yarnpkg/core';

import {RunallCommand} from "./commands/runall";

const plugin: Plugin = {
  commands: [
    RunallCommand,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
