---
name: update-tests
description: "Update tests after implementation changes. Use when code was modified and tests need to be added, updated, or fixed to match the new implementation. Trigger when: user says 'update tests', 'fix tests', 'add tests for this', 'tests are outdated', or after the test-runner agent reports failures due to implementation changes. Argument: description of what changed in the implementation."
argument-hint: <description of implementation changes>
---

# Update Tests

Brings the test suite in line with implementation changes by spawning the **test-updater** agent (defined in `agents/test-updater.md`); the work stays out of the main context.

## Procedure

1. Build the change context: the argument, plus the changed-file list (`git diff --name-only main...HEAD` on a branch, else `git status --short`). If the test-runner just reported failures, include its diagnosis verbatim - the agent starts from the failing tests instead of rediscovering them.

2. Spawn **test-updater** (see "Delegation" in the global instructions) with:
   ```
   Implementation changes:
   {change description}

   Changed files:
   {file list}

   {test-runner diagnosis, when there is one}

   Update the tests to match the implementation, add coverage for new code paths, run the affected suites, and report.
   ```

3. Relay its report to the user. If it flags an implementation bug (a test it deliberately left failing), that is the user's call - do not silence the test.
