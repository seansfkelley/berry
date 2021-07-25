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
  // TODO: It appears that `run` is put on Yarn's path as an alias for `yarn run`? Do we support?
  if (parsedCommand?.length > 2 && parsedCommand[0] === `yarn` && parsedCommand[1] === `run`) {
    const [scriptName, ...restArgs] = parsedCommand.slice(2);
    const args = [...restArgs, ...extra.args];
    if (workspace.manifest.scripts.has(scriptName)) {
      // console.log(`will execute package-local script ${scriptName} with`, args);
      return () => {
        // TODO: should we be concerned about things like INIT_CWD or other things we're not
        // explicitly emulating when inlining?
        //
        // INIT_CWD appears to only be set when the script environment is first initialized for a
        // workspace. I don't think it's persisted to the workspace object or anything, though. This
        // means that if we hop around between nested runs within a workspace (or between, with
        // globals, but we don't need the additional complexity) that the script that it finally
        // bottoms out on -- the one that is actually executed by the default executor -- might not
        // receive the INIT_CWD it was expecting. In particular, if you have a script that is _only_
        // ever wrapped by other scripts, there would be a behavioral difference between not using
        // this plugin (wrapped script sees INIT == WORKSPACE) and using it (wrapped script is
        // unwrapped and sees INIT == wherever the user's shell was).
        //
        // It doesn't look like we can override INIT_CWD though. It's unconditionally set in the
        // initialization code that is run by executePackageScript. We hand off execution to that
        // method -- we don't introspect into how it does its job. And it's set to a fixed value
        // computed at process start time, rather than, say, from a parameter. So I think we just
        // have to document that it isn't a reliable value.
        //
        // Maybe the plugin can be configured to warn if it spots INIT_CWD in any scripts in your
        // workspace?
        //
        // Relatedly: should I file a ticket to get WORKSPACE_CWD injected into the environment?
        // Seems weird that there's INIT and PROJECT but not that one. I also think that WORKSPACE
        // is far more useful and more reliable the way we want to use wrapping.
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
