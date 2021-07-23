import {BaseCommand, pluginCommands}        from '@yarnpkg/cli';
import {Configuration, Project, Workspace}  from '@yarnpkg/core';
import {scriptUtils, structUtils}           from '@yarnpkg/core';
import {parseShell}                         from '@yarnpkg/parsers';
import {Command, Option, Usage, UsageError} from 'clipanion';

// eslint-disable-next-line arca/no-default-export
export default class AliasRunCommand extends BaseCommand {
  static paths = [
    [`alias-run`],
    [`alias`],
  ];

  static usage: Usage = Command.Usage({
    description: `todo`,
    details: `
      todo
    `,
    examples: [[
      `todo`,
      `todo`,
    ]],
  });

  aliasName = Option.String();
  args = Option.Proxy();

  private async _delegateToRun(command: string) {
    // console.log(parseShell(command));
    // TODO: this is super naive
    const parts = command.split(` `);
    console.log(parts);
    const foo = this.cli.process(parts);
    return foo.validateAndExecute();
  }

  private async _resolve(commandSoFar: string, alias: string, aliases: Record<string, string>): Promise<number> {
    const next = aliases[alias];
    if (next == null) {
      return this._delegateToRun(`${alias} ${commandSoFar}`);
    } else {
      const [nextAlias, ...extraParts] = next.split(` `);
      // TODO: check for infinite recursion
      return this._resolve(`${extraParts.join(` `)} ${commandSoFar}`, nextAlias, aliases);
    }
  }

  async execute() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project, workspace, locator} = await Project.find(configuration, this.context.cwd);

    const aliases = workspace?.manifest.raw.aliases ?? {};
    return this._resolve(``, this.aliasName, aliases);

    /*
    await project.restoreInstallState();

    const effectiveLocator = this.topLevel
      ? project.topLevelWorkspace.anchoredLocator
      : locator;

    // First we check to see whether a script exist inside the current package
    // for the given name

    if (!this.binariesOnly && await scriptUtils.hasPackageScript(effectiveLocator, this.scriptName, {project}))
      return await scriptUtils.executePackageScript(effectiveLocator, this.scriptName, this.args, {project, stdin: this.context.stdin, stdout: this.context.stdout, stderr: this.context.stderr});

    // If we can't find it, we then check whether one of the dependencies of the
    // current package exports a binary with the requested name

    const binaries = await scriptUtils.getPackageAccessibleBinaries(effectiveLocator, {project});
    const binary = binaries.get(this.scriptName);

    if (binary) {
      const nodeArgs = [];

      if (this.inspect) {
        if (typeof this.inspect === `string`) {
          nodeArgs.push(`--inspect=${this.inspect}`);
        } else {
          nodeArgs.push(`--inspect`);
        }
      }

      if (this.inspectBrk) {
        if (typeof this.inspectBrk === `string`) {
          nodeArgs.push(`--inspect-brk=${this.inspectBrk}`);
        } else {
          nodeArgs.push(`--inspect-brk`);
        }
      }

      return await scriptUtils.executePackageAccessibleBinary(effectiveLocator, this.scriptName, this.args, {
        cwd: this.context.cwd,
        project,
        stdin: this.context.stdin,
        stdout: this.context.stdout,
        stderr: this.context.stderr,
        nodeArgs,
        packageAccessibleBinaries: binaries,
      });
    }

    // When it fails, we try to check whether it's a global script (ie we look
    // into all the workspaces to find one that exports this script). We only do
    // this if the script name contains a colon character (":"), and we skip
    // this logic if multiple workspaces share the same script name.
    //
    // We also disable this logic for packages coming from third-parties (ie
    // not workspaces). No particular reason except maybe security concerns.

    if (!this.topLevel && !this.binariesOnly && workspace && this.scriptName.includes(`:`)) {
      const candidateWorkspaces = await Promise.all(project.workspaces.map(async workspace => {
        return workspace.manifest.scripts.has(this.scriptName) ? workspace : null;
      }));

      const filteredWorkspaces = candidateWorkspaces.filter(workspace => {
        return workspace !== null;
      }) as Array<Workspace>;

      if (filteredWorkspaces.length === 1) {
        return await scriptUtils.executeWorkspaceScript(filteredWorkspaces[0], this.scriptName, this.args, {stdin: this.context.stdin, stdout: this.context.stdout, stderr: this.context.stderr});
      }
    }

    if (this.topLevel) {
      if (this.scriptName === `node-gyp`) {
        throw new UsageError(`Couldn't find a script name "${this.scriptName}" in the top-level (used by ${structUtils.prettyLocator(configuration, locator)}). This typically happens because some package depends on "node-gyp" to build itself, but didn't list it in their dependencies. To fix that, please run "yarn add node-gyp" into your top-level workspace. You also can open an issue on the repository of the specified package to suggest them to use an optional peer dependency.`);
      } else {
        throw new UsageError(`Couldn't find a script name "${this.scriptName}" in the top-level (used by ${structUtils.prettyLocator(configuration, locator)}).`);
      }
    } else {
      if (this.scriptName === `global`)
        throw new UsageError(`The 'yarn global' commands have been removed in 2.x - consider using 'yarn dlx' or a third-party plugin instead`);

      const userCommand = [this.scriptName].concat(this.args);

      for (const [pluginName, candidates] of pluginCommands)
        for (const candidate of candidates)
          if (userCommand.length >= candidate.length && JSON.stringify(userCommand.slice(0, candidate.length)) === JSON.stringify(candidate))
            throw new UsageError(`Couldn't find a script named "${this.scriptName}", but a matching command can be found in the ${pluginName} plugin. You can install it with "yarn plugin import ${pluginName}".`);

      throw new UsageError(`Couldn't find a script named "${this.scriptName}".`);
    }
    */
  }
}
