import {Hooks, Project, Locator, scriptUtils} from "@yarnpkg/core";
import {PortablePath}                         from '@yarnpkg/fslib';
import {Writable, Readable}                   from 'stream';

type ProcessEnvironment = Record<string, string>;

export const wrapScriptExecution: Hooks["wrapScriptExecution"] = async (
  executor: () => Promise<number>,
  project: Project,
  locator: Locator,
  scriptName: string,
  extra: {script: string, args: Array<string>, cwd: PortablePath, env: ProcessEnvironment, stdin: Readable | null, stdout: Writable, stderr: Writable},
): Promise<() => Promise<number>> => {
  if (extra.env.CI || extra.env.DONT_INLINE_RECURSIVE_YARN)
    return executor;

  const workspace = project.workspacesByIdent.get(locator.identHash);
  if (!workspace) // I dunno what this even means or if it's even possible.
    return executor;

  console.log();
  console.log(`hooking script, parameters:`);
  console.log(`script`, JSON.stringify(extra.script));
  console.log(`args`, JSON.stringify(extra.args));
  console.log(`cwd`, JSON.stringify(extra.cwd));

  const parsedArgs = parseArgs(extra.script);
  if (parsedArgs && parsedArgs[0] === `yarn` && parsedArgs[1] === `run`) {
    const [scriptName, ...restArgs] = parsedArgs.slice(2);
    const args = [...restArgs, ...extra.args];
    if (workspace.manifest.scripts.has(scriptName)) {
      console.log(`will execute package-local script ${scriptName} with`, args);
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
        console.log(`will execute global script ${scriptName} with`, args);
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

  console.log(`using default behavior`);
  return executor;
};

const SHELL_SAFE_CHARACTERS = `-.,a-zA-Z0-9_/:=`;
const UNQUOTED_CHARACTERS = new RegExp(`^[${SHELL_SAFE_CHARACTERS}]+`);
const DOUBLE_QUOTED_CHARACTERS = new RegExp(`^[${SHELL_SAFE_CHARACTERS}\t ']+`);
const SINGLE_QUOTED_CHARACTERS = new RegExp(`^[${SHELL_SAFE_CHARACTERS}\t ()[\\]{};$*+"]+`);

export function parseArgs(scriptText: string) {
  const args = [];
  let remainingText = scriptText.trim();

  function isArgumentTerminator(index: number) {
    return index >= remainingText.length || ` \t`.includes(remainingText[index]);
  }

  while (remainingText.length > 0) {
    let match = UNQUOTED_CHARACTERS.exec(remainingText);
    if (match) {
      const possibleArg = match[0];
      if (isArgumentTerminator(possibleArg.length)) {
        args.push(match[0]);
        remainingText = remainingText.slice(possibleArg.length).trimLeft();
        continue;
      }
      return undefined;
    }

    const c = remainingText[0];
    remainingText = remainingText.slice(1);
    if (c === `'`)
      match = SINGLE_QUOTED_CHARACTERS.exec(remainingText);
    else if (c === `"`)
      match = DOUBLE_QUOTED_CHARACTERS.exec(remainingText);
    else
      return undefined;

    if (match) {
      const possibleArg = match[0];
      if (remainingText[possibleArg.length] === c && isArgumentTerminator(possibleArg.length + 1)) {
        args.push(match[0]);
        remainingText = remainingText.slice(possibleArg.length + 1).trimLeft();
        continue;
      }
    }

    return undefined;
  }

  return args;
}
