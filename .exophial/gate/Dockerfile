# armada-sdk commit-boundary gate image (D49, ADR
# exophial/docs/decisions/2026-10-14-gate-runs-in-a-container-built-from-the-judged-commit.md).
# The pattern is armada-poc's .exophial/gate/Dockerfile.
#
# gate_container.build_gate_image builds this image from the judged commit's
# own tree (a tar of the working tree, .git and .scratch excluded) with
# `docker build --quiet -f .exophial/gate/Dockerfile -`.
# gate_container.run_in_container then runs gate.command (.exophial/config.yaml)
# as the sole process, with no volume and no environment from the host. The
# image's own ENV, HOME and WORKDIR are all that the container sees.
#
# gate.command runs, in order: npm ci --offline, pre-commit run --all-files,
# npm run lint, typecheck, typecheck:vendor, build, test, the POI grep, and
# scripts/check-vendor-divergence.mjs. Each tool that these steps call is image
# content, pinned to the version that the host runs:
#   python 3.12 + uv + git + the exophial wheel -> from exophial-e2e-base
#       (the local hooks call exophial-check-claude-md and
#        exophial-reroute-main-commit)
#   node 24.18.0 + npm 11.16.0                  -> npm ci, eslint, tsc, tsup, vitest
#   the npm cache                               -> npm ci --offline
#   the pre-commit hook environments            -> pre-commit run --all-files
FROM exophial-e2e-base

USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl xz-utils ca-certificates build-essential pkg-config git \
    && rm -rf /var/lib/apt/lists/*

# --- Node 24.18.0 + npm 11.16.0 (the host's versions) ---
RUN curl -fsSL https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz \
        | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g npm@11.16.0

# --- pre-commit 4.5.1 (the host's version) ---
RUN uv tool install pre-commit==4.5.1

WORKDIR /gate
COPY . .

# Under `docker build --quiet` a RUN step that streams much output to the step
# pipe can die mid-write (armada-poc: npm ci exited 146). Each heavy step writes
# to a log file and prints the log tail only on failure.

# --- npm cache + node_modules, so that the gate's `npm ci --offline` resolves
#     from the image's ~/.npm cache. ---
RUN npm ci --no-audit --no-fund --loglevel=error \
        > /tmp/npm-ci.log 2>&1 || { tail -c 40000 /tmp/npm-ci.log; exit 1; }

# --- A throwaway git history gives pre-commit a repo (the judged tree has no
#     .git). `git add -A` honors .gitignore, so the file set matches the host's
#     `pre-commit run --all-files`. install-hooks builds each hook environment
#     and registers no git hook. The branch is not main, because the
#     reroute-main-commit hook refuses a commit on main. ---
RUN { git init -q -b gate-tree \
        && git add -A \
        && git -c user.email=gate@armada-sdk -c user.name=gate \
               commit -qm "gate tree" \
        && pre-commit install-hooks --config .pre-commit-config.yaml ; } \
        > /tmp/precommit.log 2>&1 || { tail -c 40000 /tmp/precommit.log; exit 1; }

# No ENTRYPOINT: run_in_container passes gate.command directly. It runs in
# WORKDIR /gate with this image's PATH.
