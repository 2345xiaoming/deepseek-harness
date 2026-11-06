# dsh-open-code-review

Hybrid code review plugin: deterministic engineering (selection, rules, bundling, positioning) around LLM review workers. This glossary names the domain concepts its modules speak about.

## Language

**Review Spec**:
The deterministic product of target selection: reviewable files, rule groups, and bundles.
_Avoid_: plan

**Review Run**:
A review spec together with the diff of every target — the complete material one run consumes.
_Avoid_: context bundle, input snapshot

**Bundle**:
Related files reviewed together by one review worker, so cross-file observations stay in one context.

**Rule Group**:
Files sharing one resolved review checklist.

**Review Plan**:
The pre-review document one bundle's plan task produces: a change summary plus the risk points worth checking and the context checks that would confirm each.
_Avoid_: checklist, todo list

**Comment Relocation**:
Anchoring a review comment to the diff lines it targets, so its finding carries a verified position.
_Avoid_: line matching

**Review Worker**:
The isolated LLM execution unit that takes one worker task and returns one structured document.
_Avoid_: reviewer agent, sub-agent

**Worker Task**:
One assignment handed to a review worker: the review or filter prose paired with its wire schema.

**Structured Document**:
The model-authored wire value a review worker returns, admitted only through the contract parser.
_Avoid_: response, payload

**Finding**:
A verified review comment in the canonical tool output.
_Avoid_: issue, comment (for the output record)

**Coverage**:
Per-file accounting of a run: every selected file ends reviewed — its bundle's worker completed — or skipped, with a reason.

**Fail-open filter**:
The reflection filter's failure policy: a failed filter never destroys findings.
