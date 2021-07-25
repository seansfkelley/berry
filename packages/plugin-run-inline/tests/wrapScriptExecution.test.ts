import {Workspace, Project, Locator, IdentHash, LocatorHash, Manifest} from "@yarnpkg/core";
import {PortablePath}                                                  from '@yarnpkg/fslib';
import {Writable, Readable}                                            from 'stream';

import {wrapScriptExecution, _parseCommandString}                      from "../sources/hooks/wrapScriptExecution";

jest.mock(`@yarnpkg/core`, () => ({
  ...jest.requireActual(`@yarnpkg/core`),
  scriptUtils: {
    ...jest.requireActual(`@yarnpkg/core`).scriptUtils,
    executePackageScript: jest.fn(),
    executeWorkspaceScript: jest.fn(),
  },
}));

type ProcessEnvironment = Record<string, string>;

// Should be Writable but that's another type in this file.
type UnReadonly<T> = { -readonly [P in keyof T]: T[P] };

describe(`wrapScriptExecution`, () => {
  const scriptUtils: {
    executePackageScript: ReturnType<(typeof jest)['fn']>,
    executeWorkspaceScript: ReturnType<(typeof jest)['fn']>,
  } = require(`@yarnpkg/core`).scriptUtils;
  const defaultExecutor = jest.fn(async () => 0);

  // TODO: Move all these fixtures into a fixture directory or whatever.
  // TODO: These should probably be created afresh in each test...
  // TODO: We can make actual workspace on disk and use them as fixtures!
  const env: ProcessEnvironment = {};
  const stdin = Symbol(`stdin`) as unknown as Readable;
  const stdout = Symbol(`stdout`) as unknown as Writable;
  const stderr = Symbol(`stdout`) as unknown as Writable;

  const project = new Project(`/project` as PortablePath, {configuration: null as any});

  const thisWorkspace = new Workspace(`/project/this-workspace` as PortablePath, {project});
  const otherWorkspace = new Workspace(`/project/other-workspace` as PortablePath, {project});

  project.workspaces = [thisWorkspace, otherWorkspace];

  const thisLocator: Locator = {
    identHash: `1` as IdentHash,
    scope: null,
    name: `this`,
    locatorHash: `1` as LocatorHash,
    reference: `1`,
  };
  const otherLocator: Locator = {
    identHash: `2` as IdentHash,
    scope: null,
    name: `other`,
    locatorHash: `2` as LocatorHash,
    reference: `2`,
  };

  project.workspacesByIdent.set(thisLocator.identHash, thisWorkspace);
  project.workspacesByIdent.set(otherLocator.identHash, otherWorkspace);

  afterAll(() => {
    jest.unmock(`@yarnpkg/core`);
  });

  beforeEach(() => {
    scriptUtils.executePackageScript.mockReset();
    scriptUtils.executeWorkspaceScript.mockReset();

    (thisWorkspace as UnReadonly<typeof thisWorkspace>).manifest = new Manifest();
    (otherWorkspace as UnReadonly<typeof otherWorkspace>).manifest = new Manifest();
  });

  function executeHook(
    scriptName: string,
    extra?: {args?: Array<string>, cwd?: PortablePath, env?: ProcessEnvironment}
  ) {
    return wrapScriptExecution(
      defaultExecutor,
      project,
      thisLocator,
      scriptName,
      {
        script: thisWorkspace.manifest.scripts.get(scriptName)!,
        args: extra?.args ?? [],
        cwd: extra?.cwd ?? `/random/directory` as PortablePath,
        env: extra?.env ?? env,
        stdin,
        stdout,
        stderr,
      }
    );
  }

  async function runExecutorAndAssert(executor: () => Promise<number>, which: Function, expectedArgs: Array<unknown>) {
    // sanity-check the helper function!
    expect([scriptUtils.executePackageScript, scriptUtils.executeWorkspaceScript]).toContain(which);
    expect(executor).not.toBe(defaultExecutor);
    await executor();
    expect(which).toBeCalledTimes(1);
    expect(which).toHaveBeenLastCalledWith(...expectedArgs);
  }

  describe(`should return the default executor`, () => {
    test(`when trying to run a script that does not start with yarn`, async () => {
      thisWorkspace.manifest.scripts = new Map([
        [`script`, `notyarn run another:script`],
      ]);

      expect(await executeHook(`script`)).toBe(defaultExecutor);
    });

    // TODO: Do we want to this executePackageScript instead?
    test(`when running a script that implicitly wraps a local script`, async () => {
      thisWorkspace.manifest.scripts = new Map([
        [`local-script`, `this is the local script`],
        [`wrapper-script`, `yarn local-script`],
      ]);

      expect(await executeHook(`wrapper-script`)).toBe(defaultExecutor);
    });

    test(`when trying to run a global script whose name does not contain a colon`, async () => {
      thisWorkspace.manifest.scripts = new Map([
        [`wrapper-script`, `yarn run not-actually-a-global-script`],
      ]);
      otherWorkspace.manifest.scripts = new Map([
        [`not-actually-a-global-script`, `this is the global script`],
      ]);

      expect(await executeHook(`wrapper-script`)).toBe(defaultExecutor);
    });

    test(`when trying to run a global script that has multiple other definitions`, async () => {
      thisWorkspace.manifest.scripts = new Map([
        [`wrapper-script`, `yarn run global:script`],
      ]);
      otherWorkspace.manifest.scripts = new Map([
        [`global:script`, `this is the global script`],
      ]);
      // TODO: A third workspace!

      expect(await executeHook(`wrapper-script`)).toBe(defaultExecutor);
    });
  });

  describe(`should return an executor that wraps executePackageScript`, () => {
    test(`when running a script that explicitly wraps a local script`, async () => {
      thisWorkspace.manifest.scripts = new Map([
        [`local-script`, `this is the local script`],
        [`wrapper-script`, `yarn run local-script`],
      ]);

      await runExecutorAndAssert(
        await executeHook(`wrapper-script`),
        scriptUtils.executePackageScript, [
          thisLocator,
          `local-script`,
          [],
          {project, stdin, stdout, stderr},
        ],
      );
    });
  });

  describe(`should return an executor that wraps executeWorkspaceScript`, () => {
    test(`when running a script that wraps a global script whose name includes a colon`, async () => {
      thisWorkspace.manifest.scripts = new Map([
        [`wrapper-script`, `yarn run global:script`],
      ]);
      otherWorkspace.manifest.scripts = new Map([
        [`global:script`, `this is the global script`],
      ]);

      await runExecutorAndAssert(
        await executeHook(`wrapper-script`),
        scriptUtils.executeWorkspaceScript,
        [
          otherWorkspace,
          `global:script`,
          [],
          {stdin, stdout, stderr},
        ],
      );
    });
  });
});

describe(`_parseCommandString`, () => {
  it.each([
    [`well-formatted positional args`, `yarn run script`, [`yarn`, `run`, `script`]],
    [`positional args with extraneous whitespace`, ` \tyarn \t run\t\t script    `, [`yarn`, `run`, `script`]],
    [`short and long flags`, `-f --lag -s --with=args`, [`-f`, `--lag`, `-s`, `--with=args`]],
    [`file paths and simple pattern lists`, `/absolute/path relative/path.ext . .. foo/,bar/`, [`/absolute/path`, `relative/path.ext`, `.`, `..`, `foo/,bar/`]],
    [`numbers and unusual identifiers`, `123 yarn:script:name SHOUTING_CASE`, [`123`, `yarn:script:name`, `SHOUTING_CASE`]],
    [`quoted strings without whitespace`, `'foo' "bar"`, [`foo`, `bar`]],
    [`quoted strings with whitespace`, `'simple white space' " \t lots \tof white  space\t\t"`, [`simple white space`, ` \t lots \tof white  space\t\t`]],
    [`single-quoted strings containing double quotes`, `'foo " bar " baz'`, [`foo " bar " baz`]],
    [`double-quoted strings containing single quotes`, `"foo ' bar ' baz"`, [`foo ' bar ' baz`]],
  ])(`should parse %s`, (_, given, expected) => {
    expect(_parseCommandString(given)).toEqual(expected);
  });

  it.each([
    [`parentheses`, `(foo)`],
    [`brackets`, `[ foo = bar ]`],
    [`braces`, `{glib,glob}`],
    [`dollar signs`, `$env`],
    [`asterisks`, `*.splat`],
    [`plus signs`, `+`],
    [`semicolons`, `first ; second`],
    [`ampersands`, `and && and`],
    [`pipes`, `or || or`],
  ])(`should parse %s in single quotes, but not raw or in double quotes`, (_, given) => {
    expect(_parseCommandString(given)).toBeUndefined();
    expect(_parseCommandString(`"${given}"`)).toBeUndefined();
    expect(_parseCommandString(`'${given}'`)).toEqual([given]);
  });

  it.each([
    [`backslashes`, `\\`],
  ])(`should not parse %s, either raw or in single or double quotes`, (_, given) => {
    expect(_parseCommandString(given)).toBeUndefined();
    expect(_parseCommandString(`"${given}"`)).toBeUndefined();
    expect(_parseCommandString(`'${given}'`)).toBeUndefined();
  });

  // TODO: Audit. Are there any constructs we currently allow that have significance to shells?
  // For example, we currently whitelist prefixing commands with environment variables, which
  // needs a shell to properly execute, which is not okay.
  it.each([
    [`single-quoted strings immediately following a simple string`, `quote'd'`],
    [`double-quoted strings immediately following a simple string`, `quote"d"`],
    [`single-quoted strings that are not followed by whitespace`, `'quote'd`],
    [`double-quoted strings that are not followed by whitespace`, `"quote"d`],
    [`a single quote terminated by a double quote`, `'foo"`],
    [`a double quote terminated by a single quote`, `"foo'`],
    [`a single-quoted string interrupted by an escaped single quote`, `'foo'"'"'bar'`],
    [`a double-quoted string interrupted by an escaped double quote`, `"foo"'"'"bar"`],
    // TODO: This one is a bummer, because the obvious way to ban it easily is to ban the equals
    // sign but those are also used to pass arguments sometimes!
    [`a command with an environment variable prefix`, `FOO=bar run`],
  ])(`should not parse %s`, (_, given) => {
    expect(_parseCommandString(given)).toBeUndefined();
  });
});
