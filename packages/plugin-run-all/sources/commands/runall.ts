import {BaseCommand, WorkspaceRequiredError}               from '@yarnpkg/cli';
import {Configuration, LocatorHash, Project, Workspace}    from '@yarnpkg/core';
import {DescriptorHash, MessageName, Report, StreamReport} from '@yarnpkg/core';
import {formatUtils, miscUtils, structUtils}               from '@yarnpkg/core';
import {Command, Option, Usage, UsageError}                from 'clipanion';
import micromatch                                          from 'micromatch';
import {cpus}                                              from 'os';
import pLimit                                              from 'p-limit';
import {Writable}                                          from 'stream';
import * as t                                              from 'typanion';

export const STAR = Symbol(`*`);
export const STAR_STAR = Symbol(`**`);

export class RunallCommand extends BaseCommand {
  static paths = [
    [`runall`],
    [`run-all`],
  ];

  continue = Option.Boolean(`-c,--continue`, false, {
    // description: `Find packages via dependencies/devDependencies instead of using the workspaces field`,
  });

  parallel = Option.Boolean(`-p,--parallel`, false, {
    description: `Run the commands in parallel`,
  });

  verbose = Option.Boolean(`-v,--verbose`, false, {
    description: `Prefix each output line with the name of the originating workspace`,
  });

  interlaced = Option.Boolean(`-i,--interlaced`, false, {
    description: `Print the output of commands in real-time instead of buffering it`,
  });

  jobs = Option.String(`-j,--jobs`, {
    description: `The maximum number of parallel tasks that the execution will be limited to`,
    validator: t.applyCascade(t.isNumber(), [t.isInteger(), t.isAtLeast(2)]),
  });

  delegateScriptCommands = Option.Proxy();

  async execute() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project, workspace} = await Project.find(configuration, this.context.cwd);

    if (!workspace)
      // if we don't use workspaces, does the project devolve into the only workspace?
      // is this okay? topLevelWorkspace?
      throw new Error(`what`);


    const scriptInvocations = this.delegateScriptCommands.map(_parseScriptInvocation);
    // n^2 but whatever...
    const matchingScriptNames = [...workspace.manifest.scripts.keys()].filter(s => scriptInvocations.some(i => _matchesScript(i.pattern, s)));

    // HERE IS WHERE I GOT TO

    const workspaces: Array<Workspace> = [];

    for (const workspace of candidates) {
      if (scriptName && !workspace.manifest.scripts.has(scriptName) && !scriptName.includes(`:`))
        continue;

      // Prevents infinite loop in the case of configuring a script as such:
      // "lint": "yarn workspaces foreach --all lint"
      if (scriptName === process.env.npm_lifecycle_event && workspace.cwd === cwdWorkspace!.cwd)
        continue;

      if (this.include.length > 0 && !micromatch.isMatch(structUtils.stringifyIdent(workspace.locator), this.include))
        continue;

      if (this.exclude.length > 0 && micromatch.isMatch(structUtils.stringifyIdent(workspace.locator), this.exclude))
        continue;

      if (this.publicOnly && workspace.manifest.private === true)
        continue;

      workspaces.push(workspace);
    }

    let interlaced = this.interlaced;

    // No need to buffer the output if we're executing the commands sequentially
    if (!this.parallel)
      interlaced = true;

    const needsProcessing = new Map<LocatorHash, Workspace>();
    const processing = new Set<DescriptorHash>();

    const concurrency = this.parallel ? Math.max(1, cpus().length / 2) : 1;
    const limit = pLimit(this.jobs || concurrency);

    let commandCount = 0;
    let finalExitCode: number | null = null;

    let abortNextCommands = false;

    const report = await StreamReport.start({
      configuration,
      stdout: this.context.stdout,
    }, async report => {
      const runCommand = async (workspace: Workspace, {commandIndex}: {commandIndex: number}) => {
        if (abortNextCommands)
          return -1;

        if (!this.parallel && this.verbose && commandIndex > 1)
          report.reportSeparator();

        const prefix = getPrefix(workspace, {configuration, verbose: this.verbose, commandIndex});

        const [stdout, stdoutEnd] = createStream(report, {prefix, interlaced});
        const [stderr, stderrEnd] = createStream(report, {prefix, interlaced});

        try {
          if (this.verbose)
            report.reportInfo(null, `${prefix} Process started`);

          const start = Date.now();

          const exitCode = (await this.cli.run([this.commandName, ...this.args], {
            cwd: workspace.cwd,
            stdout,
            stderr,
          })) || 0;

          stdout.end();
          stderr.end();

          await stdoutEnd;
          await stderrEnd;

          const end = Date.now();
          if (this.verbose) {
            const timerMessage = configuration.get(`enableTimers`) ? `, completed in ${formatUtils.pretty(configuration, end - start, formatUtils.Type.DURATION)}` : ``;
            report.reportInfo(null, `${prefix} Process exited (exit code ${exitCode})${timerMessage}`);
          }

          if (exitCode === 130) {
            // Process exited with the SIGINT signal, aka ctrl+c. Since the process didn't handle
            // the signal but chose to exit, we should exit as well.
            abortNextCommands = true;
            finalExitCode = exitCode;
          }

          return exitCode;
        } catch (err) {
          stdout.end();
          stderr.end();

          await stdoutEnd;
          await stderrEnd;

          throw err;
        }
      };

      for (const workspace of workspaces)
        needsProcessing.set(workspace.anchoredLocator.locatorHash, workspace);

      while (needsProcessing.size > 0) {
        if (report.hasErrors())
          break;

        const commandPromises = [];

        for (const [identHash, workspace] of needsProcessing) {
          // If we are already running the command on that workspace, skip
          if (processing.has(workspace.anchoredDescriptor.descriptorHash))
            continue;

          let isRunnable = true;

          if (this.topological || this.topologicalDev) {
            const resolvedSet = this.topologicalDev
              ? new Map([...workspace.manifest.dependencies, ...workspace.manifest.devDependencies])
              : workspace.manifest.dependencies;

            for (const descriptor of resolvedSet.values()) {
              const workspace = project.tryWorkspaceByDescriptor(descriptor);
              isRunnable = workspace === null || !needsProcessing.has(workspace.anchoredLocator.locatorHash);

              if (!isRunnable) {
                break;
              }
            }
          }

          if (!isRunnable)
            continue;

          processing.add(workspace.anchoredDescriptor.descriptorHash);

          commandPromises.push(limit(async () => {
            const exitCode = await runCommand(workspace, {
              commandIndex: ++commandCount,
            });

            needsProcessing.delete(identHash);
            processing.delete(workspace.anchoredDescriptor.descriptorHash);

            return exitCode;
          }));

          // If we're not executing processes in parallel we can just wait for it
          // to finish outside of this loop (it'll then reenter it anyway)
          if (!this.parallel) {
            break;
          }
        }

        if (commandPromises.length === 0) {
          const cycle = Array.from(needsProcessing.values()).map(workspace => {
            return structUtils.prettyLocator(configuration, workspace.anchoredLocator);
          }).join(`, `);

          report.reportError(MessageName.CYCLIC_DEPENDENCIES, `Dependency cycle detected (${cycle})`);
          return;
        }

        const exitCodes: Array<number> = await Promise.all(commandPromises);
        const errorCode = exitCodes.find(code => code !== 0);

        // The order in which the exit codes will be processed is fairly
        // opaque, so better just return a generic "1" for determinism.
        if (finalExitCode === null)
          finalExitCode = typeof errorCode !== `undefined` ? 1 : finalExitCode;

        if ((this.topological || this.topologicalDev) && typeof errorCode !== `undefined`) {
          report.reportError(MessageName.UNNAMED, `The command failed for workspaces that are depended upon by other workspaces; can't satisfy the dependency graph`);
        }
      }
    });

    if (finalExitCode !== null) {
      return finalExitCode;
    } else {
      return report.exitCode();
    }
  }
}

type ScriptPattern = Array<string | typeof STAR | typeof STAR_STAR>;

interface ScriptInvocation {
  pattern: ScriptPattern
  args: Array<string>;
}

export function _parseScriptInvocation(command: string): ScriptInvocation {
  const args: Array<string> = [];
  let remaining = command.trim();

  const UNQUOTED_STRING = /^([^ \t\\]+)/;
  const SINGLE_QUOTED_STRING = /^'([^'\\]+)'/;
  const DOUBLE_QUOTED_STRING = /^"([^"\\]+)"/;

  while (remaining.length > 0) {
    const c = remaining[0];
    let match;
    if (c === `'`)
      match = SINGLE_QUOTED_STRING.exec(remaining);
    else if (c === `"`)
      match = DOUBLE_QUOTED_STRING.exec(remaining);
    else
      match = UNQUOTED_STRING.exec(remaining);


    if (!match)
      throw new UsageError(`illegal command string for runall: ${command}`);

    args.push(match[1]);

    // TODO: Should be ban things like quotes immediately following quotes without whitespace?
    remaining = remaining.slice(match[0].length).trimLeft();
  }

  if (args.length === 0)
    throw new UsageError(`runall requires at least one script name or glob`);


  // TODO: Scripts can be given arguments by putting the whole in quotes, like `yarn run-all "script --args"
  // how to parse? The below is not sufficient.
  const pattern = args[0].split(`:`).map(segment => {
    if (segment === `**`) {
      return STAR_STAR;
    } else if (segment === `*`) {
      return STAR;
    } else if (segment.includes(`*`)) {
      throw new UsageError(`cannot use * alongside other characters in ${args[0]}`);
    } else {
      return segment;
    }
  });

  const firstStarStar = pattern.indexOf(STAR_STAR);
  if (firstStarStar !== -1 && firstStarStar < pattern.length - 1)
    throw new UsageError(`a ** can only appear at the end of a pattern`);

  return {pattern, args: args.slice(1)};
}

export function _matchesScript(pattern: ScriptPattern, scriptName: string) {
  const scriptNameParts = scriptName.split(`:`);
  if (pattern.length > scriptNameParts.length) {
    return false;
  } else {
    const matchesUpToPatternLength = pattern.every((patternPart, i) => {
      const namePart = scriptNameParts[i];
      return patternPart === namePart || patternPart === STAR || patternPart === STAR_STAR;
    });
    return matchesUpToPatternLength && (
      pattern.length === scriptNameParts.length ||
      pattern[pattern.length - 1] === STAR_STAR
    );
  }
}


function createStream(report: Report, {prefix, interlaced}: {prefix: string | null, interlaced: boolean}): [Writable, Promise<boolean>] {
  const streamReporter = report.createStreamReporter(prefix);

  const defaultStream = new miscUtils.DefaultStream();
  defaultStream.pipe(streamReporter, {end: false});
  defaultStream.on(`finish`, () => {
    streamReporter.end();
  });

  const promise = new Promise<boolean>(resolve => {
    streamReporter.on(`finish`, () => {
      resolve(defaultStream.active);
    });
  });

  if (interlaced)
    return [defaultStream, promise];

  const streamBuffer = new miscUtils.BufferStream();
  streamBuffer.pipe(defaultStream, {end: false});
  streamBuffer.on(`finish`, () => {
    defaultStream.end();
  });

  return [streamBuffer, promise];
}

type GetPrefixOptions = {
  configuration: Configuration;
  commandIndex: number;
  verbose: boolean;
};

function getPrefix(workspace: Workspace, {configuration, commandIndex, verbose}: GetPrefixOptions) {
  if (!verbose)
    return null;

  const ident = structUtils.convertToIdent(workspace.locator);
  const name = structUtils.stringifyIdent(ident);

  const prefix = `[${name}]:`;

  const colors = [`#2E86AB`, `#A23B72`, `#F18F01`, `#C73E1D`, `#CCE2A3`];
  const colorName = colors[commandIndex % colors.length];

  return formatUtils.pretty(configuration, prefix, colorName);
}
