import {Hooks, Project, Locator, scriptUtils} from "@yarnpkg/core";
import {PortablePath}                         from '@yarnpkg/fslib';
import {Writable, Readable}                   from 'stream';

type ProcessEnvironment = Record<string, string>;

export const wrapScriptExecution: Required<Hooks>["wrapScriptExecution"] = async (
  executor: () => Promise<number>,
  project: Project,
  locator: Locator,
  scriptName: string,
  extra: {script: string, args: Array<string>, cwd: PortablePath, env: ProcessEnvironment, stdin: Readable | null, stdout: Writable, stderr: Writable},
): Promise<() => Promise<number>> => {
  const workspace = project.workspacesByIdent.get(locator.identHash);
  if (!workspace) // I dunno what this would mean or if it's even possible.
    return executor;

  // console.log();
  // console.log(`hooking script, parameters:`);
  // console.log(`script`, JSON.stringify(extra.script));
  // console.log(`args`, JSON.stringify(extra.args));
  // console.log(`cwd`, JSON.stringify(extra.cwd));

  const parsedCommand = _parseCommandString(extra.script);
  // TODO: Can we support yarn exec? What about implicit run (without the run keyword)?
  if (parsedCommand?.length > 2 && parsedCommand[0] === `yarn` && parsedCommand[1] === `run`) {
    const [scriptName, ...restArgs] = parsedCommand.slice(2);
    const args = [...restArgs, ...extra.args];
    if (workspace.manifest.scripts.has(scriptName)) {
      // console.log(`will execute package-local script ${scriptName} with`, args);
      return () => {
        // TODO: should we be concerned about things like INIT_CWD or other things we're not explicitly emulating when inlining?
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
        // console.log(`will execute global script ${scriptName} with`, args);
        return () => {
          // TODO: should we be concerned about things like INIT_CWD or other things we're not explicitly emulating when inlining?
          return scriptUtils.executeWorkspaceScript(candidates[0], scriptName, args, {
            stdin: extra.stdin,
            stdout: extra.stdout,
            stderr: extra.stderr,
          });
        };
      }
    }
  }

  // console.log(`using default behavior`);
  return executor;
};

const SHELL_SAFE_CHARACTERS = `-.,a-zA-Z0-9_/:=`;
const UNQUOTED_CHARACTERS = new RegExp(`^[${SHELL_SAFE_CHARACTERS}]+`);
const DOUBLE_QUOTED_CHARACTERS = new RegExp(`^[${SHELL_SAFE_CHARACTERS}\t ']+`);
const SINGLE_QUOTED_CHARACTERS = new RegExp(`^[${SHELL_SAFE_CHARACTERS}\t ()[\\]{};$*+|&"]+`);

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
