import {Hooks, Project, Locator, scriptUtils} from "@yarnpkg/core";
import {PortablePath}                         from '@yarnpkg/fslib';
import {Writable, Readable}                   from 'stream';

type ProcessEnvironment = Record<string, string>;

export const wrapScriptExecution: Required<Hooks>["wrapScriptExecution"] = async (
  executor: () => Promise<number>,
  project: Project,
  locator: Locator,
  _scriptName: string,
  extra: {script: string, args: Array<string>, cwd: PortablePath, env: ProcessEnvironment, stdin: Readable | null, stdout: Writable, stderr: Writable},
): Promise<() => Promise<number>> => {
  const workspace = project.workspacesByIdent.get(locator.identHash);
  if (!workspace) // I dunno what this would mean or if it's even possible.
    return executor;

  const parsedCommand = _parseCommandString(extra.script);

  if (!parsedCommand || parsedCommand.length === 1)
    return executor;

  // TODO: Should we intercept `yarn exec` as well?
  // TODO: Should we intercept implicit run (with a script name only, no `run` stated)?
  // TODO: How can we reach out and delegate to `run-all`?

  // Ideally, we could call `cli.run` and have this run in-process and all the interpretation Just
  // Work, but unfortunately, the hook doesn't receive the CLI object, so we have to reach down a
  // level and mimick some of the relevant behavior of `yarn run`'s implementation.
  //
  // I don't know if this is documented anywhere but you can see in the source that Yarn explicitly
  // supports calling `run` as an alias for `yarn run` in a script. This is done by the script
  // runtime putting one-line shell scripts at the beginning of $PATH, including `node`, `yarn` and
  // `run`.
  if ((parsedCommand[0] === `yarn` && parsedCommand[1] === `run`) || parsedCommand[0] === `run`) {
    const [scriptName, ...restArgs] = parsedCommand.slice(parsedCommand.indexOf(`run`) + 1);
    const args = [...restArgs, ...extra.args];
    if (workspace.manifest.scripts.has(scriptName)) {
      return () => {
        return scriptUtils.executePackageScript(locator, scriptName, args, {
          project,
          stdin: extra.stdin,
          stdout: extra.stdout,
          stderr: extra.stderr,
        });
      };
    } else if (scriptName.includes(`:`)) {
      const candidates = project.workspaces.filter(w => w.manifest.scripts.has(scriptName));
      if (candidates.length === 1) {
        return () => {
          return scriptUtils.executeWorkspaceScript(candidates[0], scriptName, args, {
            stdin: extra.stdin,
            stdout: extra.stdout,
            stderr: extra.stderr,
          });
        };
      }
    }
  }

  return executor;
};

const SHELL_SAFE_CHARACTERS = `-.,a-zA-Z0-9_/:@`;
const UNQUOTED_CHARACTERS = new RegExp(`^[${SHELL_SAFE_CHARACTERS}]+`);
const DOUBLE_QUOTED_CHARACTERS = new RegExp(`^[${SHELL_SAFE_CHARACTERS}\t ']+`);
const SINGLE_QUOTED_CHARACTERS = new RegExp(`^[${SHELL_SAFE_CHARACTERS}\t ()[\\]{};$*+|&"^~!=]+`);

/**
 * Exported for testing.
 *
 * Try to parse out the provided shell command string into, basically, a list of argv. This function
 * supports a small subset of legal shell syntax that can be safely and unambiguously parsed and
 * does not require a shell or environment to resolve. Quoting is supported. Enviroment variables,
 * control flow and subshells are not.
 *
 * The intent of this function is to parse out a command to see if it's a candidate for best-effort
 * inlining. This means that some complex constructs that are technically legal in that they are
 * unambiguous and don't require a shell, such as a lone double-quoted parenthesis, are not
 * supported due to the complexity/potential for bugs that parsing them would introduce and the
 * rarity with which they appear.
 */
export function _parseCommandString(command: string) {
  const args = [];
  let remaining = command.trim();

  function isArgumentTerminator(index: number) {
    return index >= remaining.length || ` \t`.includes(remaining[index]);
  }

  while (remaining.length > 0) {
    let match = UNQUOTED_CHARACTERS.exec(remaining);
    if (match) {
      const possibleArg = match[0];
      if (isArgumentTerminator(possibleArg.length)) {
        args.push(match[0]);
        remaining = remaining.slice(possibleArg.length).trimLeft();
        continue;
      }
      return undefined;
    }

    const c = remaining[0];
    remaining = remaining.slice(1);
    if (c === `'`)
      match = SINGLE_QUOTED_CHARACTERS.exec(remaining);
    else if (c === `"`)
      match = DOUBLE_QUOTED_CHARACTERS.exec(remaining);
    else
      return undefined;

    if (match) {
      const possibleArg = match[0];
      if (remaining[possibleArg.length] === c && isArgumentTerminator(possibleArg.length + 1)) {
        args.push(match[0]);
        remaining = remaining.slice(possibleArg.length + 1).trimLeft();
        continue;
      }
    }

    return undefined;
  }

  return args;
}
