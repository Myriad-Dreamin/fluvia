# The skill

`skills/fluvia/SKILL.md` is the agent-facing half of fluvia. The runtime enforces
what a line may say; the skill teaches a model what to *do* with lines that never
block.

It is a standard directory-bundle skill — one markdown file with YAML
frontmatter — and it describes fluvia, not a harness, so the same file works
unchanged everywhere.

## What it teaches

| section | what it establishes |
| --- | --- |
| Start it | the flags that matter to an agent: `--notify dsh` for coalesced envelopes, `--json` when something parses rather than reads, `defs` to see the instruction set |
| One call per line | the JS call syntax and, more importantly, the four things it rejects: nested calls, operators, member access, anything computed |
| Two handles per call | that a call binds `<out><n>` and `err<n>`, that exactly one becomes ready, and that the names must be **read off the acknowledgement** rather than assumed — on a shared runtime the first call may well be `c7 ⇒ kernel7` |
| Chain by passing handles | the table of what happens to a consumer depending on which channel it read, and that recovery is therefore just another line submitted up front |
| Notifications | that they arrive on their own, the fixed layout of an envelope, and that the right reaction is submitting the next lines rather than re-reading state |
| Control calls | `list`, `cancel`, `inspect` at its three scopes, `vars`, `defs`, `help` |
| Several agents, one runtime | the `@name` prefix and that notifications are addressed to the submitter |
| Working habits | the six rules below |
| Worked example | a full session: eight calls, three real dependencies, two turns of attention |

## The habits

Without these, fluvia is just a slow synchronous CLI, which is why the skill
states them as rules rather than as advice:

1. **Fire independent calls in one burst.** Three lines back to back run
   concurrently; three lines one notification apart run in series and cost three
   turns.
2. **Never poll.** No `list` loop, no "let me check if it finished". `list` is for
   deciding what to cancel, not for waiting.
3. **Pass handles, not values.** Never wait for `kernel0` in order to call
   `compileKernel(kernel0, …)` — submit it now and let the runtime substitute.
4. **Submit recovery paths up front**, on the error channel.
5. **Cancel work you no longer need.** A superseded branch still holds a
   concurrency slot.
6. **Let one envelope be one thought**: read it whole, then submit one burst.

## Where to install it

The skill is a directory bundle, so installing it is copying or symlinking that
directory:

| harness | path |
| --- | --- |
| DeepSeek Harness | `<project>/.dsh/skills/fluvia/` |
| Claude Code | `<project>/.claude/skills/fluvia/` |

For dsh you can also point the skill filesystem plugin at the repo's `skills/`
directory instead of copying:

```ts
ctx.plugin(skillFilesystem, { customSkillDirs: ['/path/to/fluvia/skills'] })
```

or ship it in the deployment's bundled skill root. See
[DeepSeek Harness](./dsh#registering-the-skill) for the rest of that wiring.

The skill assumes the default toolbox in its examples, because a worked example
needs real function names. Nothing in it depends on that toolbox being the one
loaded: the syntax, the handles and the habits are the runtime's, and `defs` is
what tells the model which instructions it actually has.
