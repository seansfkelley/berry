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
  const workspace = project.workspacesByIdent.get(locator.identHash);
  if (!workspace)
    throw new Error(`uh oh`);

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

function parseArgs(scriptText: string) {
  const args = [];

  for (let i = 0; i < scriptText.length; ++i)
    const c = scriptText[i];
    // define: simple character = [\.\-a-zA-Z0-9_/:]
    // simple characters can't do fancy shell things like conditionals or env vars or whatever
    // scan until we find non-whitespace
    // if simple character, match simple characters until we can't
    // if next character is whitespace, call that an arg and restart the process
    // else, bail
    // if single (or double) quote, match simple characters OR whitespace until we can't
    // if next character is single (or double) quote, call that an arg and restart the process
    // else, bail


  return scriptText.split(` `);
}
