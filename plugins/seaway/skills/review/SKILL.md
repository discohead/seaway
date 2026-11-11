---
name: review
description: Review code that uses seaway. Runs seaway-lint, then has the plugin's reviewer agent read the code for what a linter cannot see, such as the wrong mode, a statement that mounts more than it needs, a turn that does not cover what it should, or a model handed too much.
argument-hint: "[paths, or nothing for the current changes]"
disable-model-invocation: true
allowed-tools: Bash(seaway-lint:*)
---

# Review seaway code

1. **Decide what to review.** The arguments, when given, are files or directories. With none, review the current changes: the files that `git status` and `git diff --name-only` show, kept to Python, TypeScript and JavaScript files that import seaway. If nothing has changed, ask what to review.

2. **Lint.** Run `seaway-lint <paths>`. It reads only files that import seaway, and exits 1 when it finds a `warn`. Keep its output.

3. **Have the code read.** Start the `seaway:reviewer` agent. Give it the paths, the lint output, and one sentence on what the code is for if you know it. Do not tell it what you expect it to find. It checks what a linter cannot: whether each mount's mode fits who writes it, what each statement's plan would mount, whether turns cover the writes that belong together, what a model's tools can reach, and what the code costs to run.

4. **Report** what was found, most serious first. For each finding: the file and line, what is wrong, what happens because of it, and the change that fixes it, as code. Keep lint findings and the reviewer's apart only where they disagree. Say plainly when nothing was found.

5. **Change nothing** unless asked. If asked, make the fixes, run `seaway-lint` again, and print the plan (`explain()`) of each statement whose scope changed.
