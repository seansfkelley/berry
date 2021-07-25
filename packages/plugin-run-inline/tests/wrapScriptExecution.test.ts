import {Workspace, Project, Configuration, ProjectLookup} from "@yarnpkg/core";
import {PortablePath, npath}                              from '@yarnpkg/fslib';
import {Writable, Readable}                               from 'stream';

import {wrapScriptExecution, _parseCommandString}         from "../sources/hooks/wrapScriptExecution";

jest.mock(`@yarnpkg/core`, () => ({
  ...jest.requireActual(`@yarnpkg/core`),
  scriptUtils: {
    ...jest.requireActual(`@yarnpkg/core`).scriptUtils,
    executePackageScript: jest.fn(),
    executeWorkspaceScript: jest.fn(),
  },
}));

const PROJECT_FIXTURE_PATH = npath.join(__dirname, `fixtures`) as PortablePath;

type ProcessEnvironment = Record<string, string>;

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

  let project: Project;
  let primaryWorkspace: Workspace;
  let secondaryWorkspace: Workspace;
  let tertiaryWorkspace: Workspace;

  beforeAll(async () => {
    const configuration = await Configuration.find(PROJECT_FIXTURE_PATH, null, {lookup: ProjectLookup.MANIFEST, strict: false});
    project = (await Project.find(configuration, PROJECT_FIXTURE_PATH)).project;
    primaryWorkspace = project.workspaces.find(w => w.locator.name === `primary`)!;
    secondaryWorkspace = project.workspaces.find(w => w.locator.name === `secondary`)!;
    tertiaryWorkspace = project.workspaces.find(w => w.locator.name === `tertiary`)!;
  });

  afterAll(() => {
    jest.unmock(`@yarnpkg/core`);
  });

  beforeEach(() => {
    scriptUtils.executePackageScript.mockReset();
    scriptUtils.executeWorkspaceScript.mockReset();

    primaryWorkspace.manifest.scripts = new Map();
    secondaryWorkspace.manifest.scripts = new Map();
    tertiaryWorkspace.manifest.scripts = new Map();
  });

  function executeHook(
    scriptName: string,
    extra?: {args?: Array<string>, cwd?: PortablePath, env?: ProcessEnvironment}
  ) {
    return wrapScriptExecution(
      defaultExecutor,
      project,
      primaryWorkspace.locator,
      scriptName,
      {
        script: primaryWorkspace.manifest.scripts.get(scriptName)!,
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
      primaryWorkspace.manifest.scripts = new Map([
        [`script`, `notyarn run another:script`],
      ]);

      expect(await executeHook(`script`)).toBe(defaultExecutor);
    });

    // TODO: Do we want to this executePackageScript instead?
    test(`when running a script that implicitly wraps a local script`, async () => {
      primaryWorkspace.manifest.scripts = new Map([
        [`local-script`, `this is the local script`],
        [`wrapper-script`, `yarn local-script`],
      ]);

      expect(await executeHook(`wrapper-script`)).toBe(defaultExecutor);
    });

    test(`when trying to run a global script whose name does not contain a colon`, async () => {
      primaryWorkspace.manifest.scripts = new Map([
        [`wrapper-script`, `yarn run not-actually-a-global-script`],
      ]);
      secondaryWorkspace.manifest.scripts = new Map([
        [`not-actually-a-global-script`, `this is the global script`],
      ]);

      expect(await executeHook(`wrapper-script`)).toBe(defaultExecutor);
    });

    test(`when trying to run a global script that has multiple other definitions`, async () => {
      primaryWorkspace.manifest.scripts = new Map([
        [`wrapper-script`, `yarn run global:script`],
      ]);
      secondaryWorkspace.manifest.scripts = new Map([
        [`global:script`, `this is the global script`],
      ]);
      tertiaryWorkspace.manifest.scripts = new Map([
        [`global:script`, `this is the global script`],
      ]);

      expect(await executeHook(`wrapper-script`)).toBe(defaultExecutor);
    });
  });

  describe(`should return an executor that wraps executePackageScript`, () => {
    test(`when running a script that explicitly wraps a local script`, async () => {
      primaryWorkspace.manifest.scripts = new Map([
        [`local-script`, `this is the local script`],
        [`wrapper-script`, `yarn run local-script`],
      ]);

      await runExecutorAndAssert(
        await executeHook(`wrapper-script`),
        scriptUtils.executePackageScript, [
          primaryWorkspace.locator,
          `local-script`,
          [],
          {project, stdin, stdout, stderr},
        ],
      );
    });
  });

  describe(`should return an executor that wraps executeWorkspaceScript`, () => {
    test(`when running a script that wraps a global script whose name includes a colon`, async () => {
      primaryWorkspace.manifest.scripts = new Map([
        [`wrapper-script`, `yarn run global:script`],
      ]);
      secondaryWorkspace.manifest.scripts = new Map([
        [`global:script`, `this is the global script`],
      ]);

      await runExecutorAndAssert(
        await executeHook(`wrapper-script`),
        scriptUtils.executeWorkspaceScript,
        [
          secondaryWorkspace,
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
    [`short and long flags`, `-f --lag -s --with args`, [`-f`, `--lag`, `-s`, `--with`, `args`]],
    [`file paths and simple pattern lists`, `/absolute/path relative/path.ext . .. foo/,bar/`, [`/absolute/path`, `relative/path.ext`, `.`, `..`, `foo/,bar/`]],
    [`numbers and unusual identifiers`, `123 yarn:script:name SHOUTING_CASE @scope/package@1.2.3`, [`123`, `yarn:script:name`, `SHOUTING_CASE`, `@scope/package@1.2.3`]],
    [`quoted strings without whitespace`, `'foo' "bar"`, [`foo`, `bar`]],
    [`quoted strings with whitespace`, `'simple white space' " \t lots \tof white  space\t\t"`, [`simple white space`, ` \t lots \tof white  space\t\t`]],
    [`single-quoted strings containing double quotes`, `'foo " bar " baz'`, [`foo " bar " baz`]],
    [`double-quoted strings containing single quotes`, `"foo ' bar ' baz"`, [`foo ' bar ' baz`]],
  ])(`should parse %s`, (_, given, expected) => {
    expect(_parseCommandString(given)).toEqual(expected);
  });

  it.each([
    [`parentheses`, `(foo)`],
    [`brackets`, `[ foo ]`],
    [`braces`, `{glib,glob}`],
    [`dollar signs`, `$env`],
    [`asterisks`, `*.splat`],
    [`plus signs`, `+`],
    [`semicolons`, `first ; second`],
    [`ampersands`, `and && and`],
    [`pipes`, `or || or`],
    [`carets`, `^1.2.3`],
    [`tildes`, `~1.2.3`],
    [`exclamation points`, `!not`],
    [`equal signs`, `FOO=bar`],
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
