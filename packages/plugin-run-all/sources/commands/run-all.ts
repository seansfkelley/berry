import {BaseCommand, WorkspaceRequiredError} from '@yarnpkg/cli';
import {Configuration, Project}              from '@yarnpkg/core';
import {MessageName, Report, StreamReport}   from '@yarnpkg/core';
import {formatUtils, miscUtils}              from '@yarnpkg/core';
import {Command, Option, Usage, UsageError}  from 'clipanion';
import {cpus}                                from 'os';
import pLimit                                from 'p-limit';
import {Writable}                            from 'stream';
import * as t                                from 'typanion';

export const STAR = Symbol(`*`);
export const STAR_STAR = Symbol(`**`);

export class RunAllCommand extends BaseCommand {
  static paths = [
    [`run-all`],
  ];

  static usage: Usage = Command.Usage({
    description: `run all matching scripts in a workspace`,
    details: `
      This command will run one or more scripts in a workspace.
    `,
    examples: [[
      `Run a few scripts in the specified order`,
      `yarn run-all clean build publish`,
    ], [
      `Run all scripts matching a simple glob even if they fail`,
      `yarn run-all -c 'test:unit:*'`,
    ], [
      `Run all scripts and sub-scripts matching a double glob in parallel`,
      `yarn run-all -p 'lint:**'`,
    ]],
  });

  continue = Option.Boolean(`-c,--continue`, false, {
    description: `Keep running if a script fails`,
  });

  parallel = Option.Boolean(`-p,--parallel`, false, {
    description: `Run the scripts in parallel`,
  });

  verbose = Option.Boolean(`-v,--verbose`, false, {
    description: `Prefix each output line with the name of the originating script`,
  });

  interlaced = Option.Boolean(`-i,--interlaced`, false, {
    description: `Print the output of scripts in real-time instead of buffering it`,
  });

  jobs = Option.String(`-j,--jobs`, {
    description: `The maximum number of parallel tasks that the execution will be limited to`,
    validator: t.applyCascade(t.isNumber(), [t.isInteger(), t.isAtLeast(2)]),
  });

  // The way options parsing is done, we have to have a "buffer" in between the Proxy argument
  // and all the flags, else the proxy will eat everything.
  scriptName = Option.String();
  otherScriptNames = Option.Proxy();

  async execute() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project, workspace} = await Project.find(configuration, this.context.cwd);

    // This is definitely required otherwise it blows up, but I don't really know what it does.
    // Borrowed from run.ts.
    await project.restoreInstallState();

    if (!workspace)
      throw new WorkspaceRequiredError(project.cwd, this.context.cwd);

    const scriptInvocations = [this.scriptName, ...this.otherScriptNames].map(_parseScriptInvocation);
    const scriptNames = [...workspace.manifest.scripts.keys()];
    // n^2 but whatever...
    const scriptsToRun = scriptInvocations.flatMap(invocation => {
      return scriptNames.filter(s => _matchesScript(invocation.pattern, s)).map(s => [s, ...invocation.args]);
    });

    const concurrency = this.jobs || (this.parallel ? Math.max(1, cpus().length / 2) : 1);

    let parallel = this.parallel;
    if (concurrency === 1 || scriptsToRun.length === 1)
      parallel = false;

    let interlaced = this.interlaced;
    // No need to buffer the output if we're executing the commands sequentially
    if (!parallel)
      interlaced = true;

    const limit = pLimit(concurrency);

    let finalExitCode: number | null = null;

    let abortNextCommands = false;

    const report = await StreamReport.start({
      configuration,
      stdout: this.context.stdout,
    }, async report => {
      const runScript = async (script: Array<string>, {scriptIndex}: {scriptIndex: number}) => {
        if (abortNextCommands)
          return -1;

        if (!parallel && this.verbose && scriptIndex > 1)
          report.reportSeparator();

        const prefix = getPrefix(script[0], {configuration, verbose: this.verbose, scriptIndex});

        const [stdout, stdoutEnd] = createStream(report, {prefix, interlaced});
        const [stderr, stderrEnd] = createStream(report, {prefix, interlaced});

        try {
          if (this.verbose)
            report.reportInfo(null, `${prefix} Process started`);

          const start = Date.now();

          // This runs the `run` command in-process. That command, in turn, may or may not spawn
          // another process. This follows the some structure as `workspaces foreach`, which it is
          // a heavily modified form of. In general, scripts may go through a couple layers of
          // `yarn run other-script`, but will bottom out with short-to-run snippets that are run
          // in-process (e.g. `cd foo && echo bar`) or by shelling out to another executable (e.g.
          // `yarn run eslint` or `yarn exec foo bar`). In short: while this theoretically runs the
          // risk of slamming the process by doing a huge amount of work without shelling out, in
          // practice, it doesn't happen due to the architecture of Yarn and its task-running.
          const exitCode = (await this.cli.run([`run`, ...script], {
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

      const scriptPromises = scriptsToRun.map((script, scriptIndex) =>
        limit(async () => {
          try {
            return await runScript(script, {scriptIndex});
          } catch (e) {
            report.reportError(MessageName.EXCEPTION, e.stack || e.message);
            if (this.continue) {
              finalExitCode = 1;
              return 0;
            } else {
              abortNextCommands = true;
              return 1;
            }
          }
        })
      );

      const exitCodes: Array<number> = await Promise.all(scriptPromises);
      const errorCode = exitCodes.find(code => code !== 0);

      // The order in which the exit codes will be processed is fairly
      // opaque, so better just return a generic "1" for determinism.
      if (finalExitCode === null) {
        finalExitCode = typeof errorCode !== `undefined` ? 1 : finalExitCode;
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
  // how to parse? The below is not sufficient because it only looks at args[0].
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
  scriptIndex: number;
  verbose: boolean;
};

function getPrefix(scriptName: string, {configuration, scriptIndex, verbose}: GetPrefixOptions) {
  if (!verbose)
    return null;

  const prefix = `[${scriptName}]:`;

  const colors = [`#2E86AB`, `#A23B72`, `#F18F01`, `#C73E1D`, `#CCE2A3`];
  const colorName = colors[scriptIndex % colors.length];

  return formatUtils.pretty(configuration, prefix, colorName);
}
