import {Workspace, Project, Configuration, ProjectLookup} from "@yarnpkg/core";
import {PortablePath, npath}                              from '@yarnpkg/fslib';
import {UsageError}                                       from "clipanion";
import {Writable, Readable}                               from 'stream';

import {_parseScriptInvocation}                           from "../sources/commands/run-all";

describe(`_parseScriptInvocation`, () => {
  it.each([
    [`a simple script name`, `script`, {pattern: `script`, args: []}],
    [`a scoped script name`, `scoped:script`, {pattern: `scoped:script`, args: []}],
    [`a scoped script with a splat`, `*:b:c`, {pattern: `*:b:c`, args: []}],
    [`a scoped script with multiple splats`, `*:*`, {pattern: `*:*`, args: []}],
    [`a string with a partial splat`, `script*`, {pattern: `script*`, args: []}],
    [`a scoped script with a double splat`, `scoped:**`, {pattern: `scoped:**`, args: []}],
    [`a simple script name with unquoted arguments`, `script with arguments`, {pattern: `script`, args: [`with`, `arguments`]}],
    [`a simple script name with quoted arguments of both kinds`, `script "with arguments" 'and whitespace'`, {pattern: `script`, args: [`with arguments`, `and whitespace`]}],
    [`a scoped script name with splats and quoted arguments of both kinds`, `a:*:** "with arguments" 'and whitespace'`, {pattern: `a:*:**`, args: [`with arguments`, `and whitespace`]}],
  ])(`should parse %s`, (_, given, expected) => {
    expect(_parseScriptInvocation(given)).toEqual(expected);
  });

  it.each([
    [`the empty string`, ``, `requires at least one`],
    [`a string with only whitespace`, ` \t \t `, `requires at least one`],
    [`a script with an unterminated single quote`, `script 'argument`, `illegal command string`],
    [`a script with an unterminated double quote`, `script 'double`, `illegal command string`],
  ])(`should throw when trying to parse %s`, (_, given, message) => {
    try {
      _parseScriptInvocation(given);
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect(e.message).toMatch(message);
      return;
    }
    throw new Error(`failed assertions`);
  });
});
