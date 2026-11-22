# The Nix gate image's entrypoint (nix/gate.nix). Same contract as the
# Dockerfile gate's own throwaway-history step
# (.exophial/gate/Dockerfile): pre-commit needs a git repository to run
# against, and the judged tree this image's last layer copies in carries
# no .git. Built here at CONTAINER RUN time, not at image build time,
# since the image is built once and reused -- a baked-in commit would be
# stale the moment a different commit is judged with the same image.
set -e

cd /gate
if [ ! -d /gate/.git ]; then
  git init -q -b gate-tree
  git config user.email "gate@armada-sdk"
  git config user.name "gate"
  git add -A
  git commit -q -m "gate tree"
fi

exec "$@"
