import {wrapScriptExecution, parseArgs} from "../sources/hooks/wrapScriptExecution";

describe(`wrapScriptExecution`, () => {

});

describe(`parseArgs`, () => {
  it(`should parse out well-formed positional args`, () => {
    expect(parseArgs(`yarn run script`)).toEqual([`yarn`, `run`, `script`]);
  });

  it(`should parse out position args with extraneous whitespace`, () => {
    expect(parseArgs(` \tyarn \t run\t\t script    `)).toEqual([`yarn`, `run`, `script`]);
  });
});
