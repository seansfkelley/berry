import {Workspace, Project, Configuration, ProjectLookup}        from "@yarnpkg/core";
import {PortablePath, npath}                                     from '@yarnpkg/fslib';
import {UsageError}                                              from "clipanion";
import {Writable, Readable}                                      from 'stream';

import {_parseScriptInvocation, _matchesScript, STAR, STAR_STAR} from "../sources/commands/runall";

describe(`_parseScriptInvocation`, () => {
  it.each([
    [`a simple script name`, `script`, {pattern: [`script`], args: []}],
    [`a scoped script name`, `scoped:script`, {pattern: [`scoped`, `script`], args: []}],
    [`a scoped script with a splat at the beginning`, `*:b:c`, {pattern: [STAR, `b`, `c`], args: []}],
    [`a scoped script with a splat int the middle`, `a:*:c`, {pattern: [`a`, STAR, `c`], args: []}],
    [`a scoped script with a splat at the end`, `a:b:*`, {pattern: [`a`, `b`, STAR], args: []}],
    [`a scoped script with multiple splats`, `*:*`, {pattern: [STAR, STAR], args: []}],
    [`a scoped script with a double splat at the end`, `scoped:**`, {pattern: [`scoped`, STAR_STAR], args: []}],
    [`a scoped script with a splat and a double splat at the end`, `*:**`, {pattern: [STAR, STAR_STAR], args: []}],
    [`a simple script name with unquoted arguments`, `script with arguments`, {pattern: [`script`], args: [`with`, `arguments`]}],
    [`a simple script name with quoted arguments of both kinds`, `script "with arguments" 'and whitespace'`, {pattern: [`script`], args: [`with arguments`, `and whitespace`]}],
    [`a scoped script name with splats and quoted arguments of both kinds`, `a:*:** "with arguments" 'and whitespace'`, {pattern: [`a`, STAR, STAR_STAR], args: [`with arguments`, `and whitespace`]}],
  ])(`should parse %s`, (_, given, expected) => {
    expect(_parseScriptInvocation(given)).toEqual(expected);
  });

  it.each([
    [`the empty string`, ``, `requires at least one`],
    [`a string with only whitespace`, ` \t \t `, `requires at least one`],
    [`a string with a partial splat`, `script*`, `* alongside other characters`],
    [`a scoped script with a double splat in the middle`, `**:script`, `end of a pattern`],
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
