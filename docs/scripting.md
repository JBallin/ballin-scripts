# Using Ballin in shell scripts

Check each command's exit status before using its output. Status meanings differ
by command:

| Command | Existing exit behavior |
| --- | --- |
| `ballin doctor` | `0` for healthy results or warnings alone; `1` for failed readiness; `2` for invalid arguments. |
| `ballin config get update.cleanup` | `0` prints the value followed by a newline; `1` for a missing key or unreadable/invalid config; `2` for invalid usage. |
| `ballin backup read zshrc.sh` | `0` writes the saved snapshot's original bytes; `1` for an unavailable snapshot, invalid arguments, or an operational failure. |

For example, branch on readiness without parsing the report:

```shell
if ballin doctor; then
  echo 'Readiness passed (warnings may still need attention).'
else
  status=$?
  printf 'Doctor exited with status %s\n' "$status" >&2
fi
```

Read an explicit preference or save a snapshot for inspection:

```shell
ballin config get update.cleanup
ballin backup read zshrc.sh > saved-zshrc.sh
```

The redirect creates or truncates `saved-zshrc.sh` before Ballin runs; use its
contents only if the command succeeds. A successful explicit snapshot read adds
no framing or newline. A missing selector or unknown snapshot can instead print
saved options to stdout while exiting `1`. Prompts and update-stage output also
use stdout. Ballin adds no emphasis to piped or captured output, config values,
or snapshot contents; native tools control their own output. Do not treat every
Ballin stdout stream as machine-only data. See [working with settings](optional-capabilities.md#working-with-settings)
and [using saved state](new-mac.md) for preference and snapshot guidance.

For bundle snapshots, `--file <path>` writes the selected member's original bytes,
including binary content and line endings, without framing or newline changes.
`--list` displays control and directional characters as visible escapes;
`--file` does not decode those escapes. For escaped or ambiguous names, read the
raw bundle without `--list` or `--file` and pass the selected entry's JSON-decoded
`path` value to `--file` as one shell argument. See
[bundle inspection](backup-design.md#bundle-inspection) for details.

## Offline help

Use `ballin help <command...>` for offline syntax and options. Each preferred
form and its alternative print the same help:

| Preferred form | Alternative |
| --- | --- |
| `ballin help <command>` | `ballin <command> --help` |
| `ballin help backup <subcommand>` | `ballin backup <subcommand> --help` |

Supported backup subcommands are `setup`, `open`, `list`, `read`, and
`disconnect`. Supply no selectors, repository names, or other options. These
forms exit `0`, write help to stdout and nothing to stderr, and do not access
configuration, analytics identity, authentication, network services, prompts,
or local backup state.

The existing `ballin config help` alias prints config help; `ballin backup help`
prints the general Ballin overview. Both are also local and side-effect-free.
Other placements and extra arguments retain ordinary command handling; they
are not requests for offline help. In particular, a `--help` supplied as the
path after `read <snapshot> --file` remains a literal saved-file path.

## Answers and interruption

Redirected stdin can supply answers. Ballin yes/no prompts accept completed
`y`/`yes` and `n`/`no` answers, ignoring case and surrounding whitespace. Invalid
completed answers repeat the question. A blank line selects the shown default;
EOF, including text without a terminating newline, leaves the pending choice
unconfirmed. Consequences depend on the flow:

- At fresh-install consent, explicit No or a blank line using the No default
  exits `0` without installing; EOF exits `1`. Required prerequisite consent also
  needs a completed answer. EOF during optional onboarding can still allow
  already approved core installation work to finish.
- `ballin setup` cancels preference review with `0` on EOF. Unconfirmed choices
  stay unchanged; earlier confirmed choices remain saved.
- `ballin backup setup` can exit `0` after skipping setup or cancelling on EOF,
  without configuring a destination. Declining final create/reconnect
  confirmation with a completed No (or its blank default) exits `1`.

Paths, menus, and native-tool prompts keep their own input rules. See
[installation answers and recovery](installation.md#answers-input-ending-and-interruption)
and [guided preference review](optional-capabilities.md#guided-preference-review).

Interruption statuses are `130` for SIGINT and `143` for SIGTERM. Installer and
backup/readiness subprocess checks also treat numeric child exits `130` and
`143` as interruption. For `ballin update` stage children, however, a signal or
numeric exit is recorded as a stage failure: if Ballin keeps running, later
stages continue and the last nonzero stage status wins, even over an earlier
`130` or `143`. Terminating Ballin stops later stages; an interruption in its
in-process readiness check also stops before backup. Completed changes remain.
See [interrupting updates](optional-capabilities.md#interrupting-updates) for
process and recovery limits.
