# `plugin-run-inline`

This plugin intercepts scripts that use `yarn run` or `run` and makes a best-effort to run them in-process instead of spinning up another Yarn process.

## What?

Take the following example script list:

```json
"scripts": {
  "test:run": "jest --with --some --args",
  "test:unit": "yarn run test:run './unit/*'"
}
```

As you can see, `test:unit` is a convenience wrapper script around `test:run` that's pre-configured with arguments.

Without this plugin, `yarn run test:unit` will spin up a second Yarn instance, costing time and memory. If you have a lot of nested/delgating tasks and/or you use a monorepo managed by [Lerna](https://lerna.js.org/) or [workspace-tools](https://github.com/yarnpkg/berry/tree/master/packages/plugin-workspace-tools), you may very easily spin up 3, 4, 5 or 50 Yarn tasks unnecessarily.

This plugin sees that `test:unit` is simply a wrapper around another script, and will run that script in the existing Yarn process instead, passing the arguments along. It also supports multiple levels of script nesting and Yarn's [global scripts feature](https://yarnpkg.com/cli/run/#details) (ctrl-f "exactly one").

## "Best Effort"

This plugin has a limited scope. Yarn scripts support a significant chunk of shell syntax which is non-trivial to emulate. Instead of trying to cover 100% of cases where it is safe or "not that hard" to interpret a script command and run it in-process, this plugin only supports a subset of cross-platform syntax that can be safely and unambiguously parsed without needing to invoke a shell.

If the plugin cannot safely parse the expression, it will bail and forward to the default nesting Yarn behavior.

In particular, this plugin supports simple shell-safe characters like letters, numbers, dashes (for flags) and dots and slahes (for file paths) everywhere. It also supports passing whitespace with double or single quotes, and a wide range of special characters in single quotes. Using special characters outside of single quotes will cause the plugin to bail.

## Caveat: `$INIT_CWD` Correctness

From the [`yarn run` docs](https://yarnpkg.com/advanced/lifecycle-scripts/#environment-variables):

> `$INIT_CWD` represents the directory from which the script has been invoked. This isn't the same as the cwd, which for scripts is always equal to the closest package root.

Due to restrictions in Yarn's architecture, this plugin cannot modify `$INIT_CWD`. If you don't rely on it, you can stop reading here.

Recall the example scripts from above:

```json
"scripts": {
  "test:run": "jest --with --some --args",
  "test:unit": "yarn run test:run './unit/*'"
}
```

Let's say your shell's working directory is `unit/`, one level down the tree from this `package.json`. If you were to `yarn run test:unit` without this plugin, you would observe the following behavior:

1. A Yarn process starts. It then invokes `yarn run test:run './unit/*'` with `cwd` set to the workspace root, and `$INIT_CWD` set to `unit/`.
2. Another Yarn process starts. It then invokes `jest --with --some --args './unit/*'`, with `cwd` set to the workspace root, and `$INIT_CWD` _also_ set to the workspace root. This is because `cwd` was already the workspace root from the previous step.

If you were to instead use this plugin, you would observe the following behavior:

1. A Yarn process starts. It sees that the script can be safely delegated in-process, and makes the appropriate call, passing arguments.
2. Yarn invokes `jest --with --some --args './unit/*'` with `cwd` set to the workspace root, and `$INIT_CWD` set to `unit/`.

**This caveat is particularly dangerous because it can happen with what appears to be a harmless modification to the script!**

For instance, say you split the unit tests into groups and wanted to provide a glob to Jest instead:

```json
"scripts": {
  "test:unit": "yarn run test:run ./{unit,fast-unit}"
}
```

Because braces `{}` are considered a special character by this plugin requiring shell interpretation, it will bail to the default nested Yarn invocation behavior. If you were relying on `$INIT_CWD` in your Jest tests, it will now be different when run through `test:unit`!
