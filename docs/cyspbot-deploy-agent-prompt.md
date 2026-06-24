# Prompt for implementing the `cyspbot-deploy` side of submodule updates

Use this prompt with an agent that can access `chikachow/cyspbot-deploy`.

```text
Implement the `chikachow/cyspbot-deploy` side of the cyspbot submodule update automation.

Context:
- The `chikachow/cyspbot` repository now dispatches a workflow run in `chikachow/cyspbot-deploy/.github/workflows/update-cyspbot-submodule.yml` on each push to `cyspbot`'s `main` branch.
- The caller passes these inputs:
  - `cyspbot-repository`: the source repository, expected to be `chikachow/cyspbot`.
  - `cyspbot-ref`: the pushed commit SHA from `chikachow/cyspbot`.
- The deploy repository contains the cyspbot repository as a submodule at `./src/cyspbot`.

Requirements:
1. Add a GitHub Actions workflow at `.github/workflows/update-cyspbot-submodule.yml` with `on: workflow_dispatch`.
2. Accept required `workflow_dispatch` string inputs named `cyspbot-repository` and `cyspbot-ref`.
3. Give the workflow the minimum required permissions for checking out code, obtaining the cyspbot app token if that is the repository convention, pushing a branch, and opening/updating a pull request.
4. Follow the existing `cyspbot-deploy` workflow conventions, including pinned action versions and whichever app-token action or authentication pattern is already used in that repository.
5. Check out `chikachow/cyspbot-deploy` including submodules.
6. Update the `./src/cyspbot` submodule to exactly the `cyspbot-ref` commit from `cyspbot-repository`'s `main` branch.
7. Keep using the same update branch on every run, for example `cyspbot/update-submodule`, so repeated upstream pushes update the same pull request until it is merged.
8. Create or update a pull request targeting the deploy repository's mainline branch.
9. Use a semantic commit title, for example `feat(cyspbot): update submodule reference`.
10. Update the PR body on each run with a list of cyspbot commits included in the submodule update. The list should compare the old `./src/cyspbot` submodule commit on the deploy repository's mainline branch with the new `cyspbot-ref`. Include commit SHAs and subjects, and link to the GitHub compare view when possible.
11. If the submodule is already at `cyspbot-ref`, exit successfully without opening or updating a PR.
12. Run the repository's existing tests, lint, formatting, and workflow validation checks after making changes. If the repo uses `golangci-lint`, run `golangci-lint cache clean` before each `golangci-lint` invocation.
13. Commit the changes with the semantic commit message `feat(workflows): update cyspbot submodule from dispatch`.
14. Open a pull request with a summary of the workflow and the checks that were run.

Suggested implementation details:
- Prefer `peter-evans/create-pull-request` if it is already used in `cyspbot-deploy`; configure it with a stable `branch`, `delete-branch: true` if appropriate, and `sign-commits: true` if that is the repository convention.
- Generate the PR body in a shell step before `create-pull-request` and pass it through a file or step output.
- To compute commit lists, capture:
  - `old_sha=$(git rev-parse HEAD:src/cyspbot)` from the deploy repository mainline checkout.
  - `new_sha=<cyspbot-ref input>`.
  - Fetch the source repository inside the submodule, then run something equivalent to `git -C src/cyspbot log --oneline --no-decorate "$old_sha..$new_sha"`.
- Ensure the workflow handles the first update to an existing long-lived update branch by resetting or recreating the submodule update branch from the current deploy mainline before applying the new submodule SHA, so the PR stays focused and updateable.
```
