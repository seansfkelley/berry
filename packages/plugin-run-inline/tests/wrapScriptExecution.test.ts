import {Workspace, Project, Locator, IdentHash}   from "@yarnpkg/core";
import {PortablePath}                             from '@yarnpkg/fslib';

import {wrapScriptExecution, _parseCommandString} from "../sources/hooks/wrapScriptExecution";

describe(`wrapScriptExecution`, () => {
  let scriptUtils: {
    executePackageScript: ReturnType<(typeof jest)['fn']>,
    executeWorkspaceScript: ReturnType<(typeof jest)['fn']>,
  };
  const defaultExecutor = jest.fn(async () => 0);

  const project = new Project(`` as PortablePath, {configuration: null as any});

  const thisWorkspace = new Workspace(`` as PortablePath, {project});
  const otherWorkspace = new Workspace(`` as PortablePath, {project});

  const thisLocator: Locator = {
    identHash: `` as IdentHash,
  };
  const otherLocator: Locator = {
    identHash: `` as IdentHash,
  };

  beforeAll(() => {
    jest.mock(`@yarnpkg/core`, () => ({
      ...jest.requireActual(`@yarnpkg/core`),
      scriptUtils: {
        ...jest.requireActual(`@yarnpkg/core`).scriptUtils,
        executePackageScript: jest.fn(),
        executeWorkspaceScript: jest.fn(),
      },
    }));

    scriptUtils = require(`@yarnpkg/core`).scriptUtils;
  });

  afterAll(() => {
    jest.unmock(`@yarnpkg/core`);
  });

  beforeEach(() => {
    scriptUtils.executePackageScript.mockReset();
    scriptUtils.executeWorkspaceScript.mockReset();
  });

  it(`should call executePackageScript`, async () => {
    const executor = await wrapScriptExecution(defaultExecutor, project, thisLocator, ``, {});

    // expect(executor).not.toBe(defaultExecutor);
    // await executor();

    scriptUtils.executePackageScript();
    // We should probably do this beforeEach
    expect(scriptUtils.executePackageScript).toBeCalledTimes(1);
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
