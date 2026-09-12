#!/usr/bin/env bash
set -euo pipefail

repository_root=$(git rev-parse --show-toplevel)
if ! git -C "$repository_root" diff --quiet || ! git -C "$repository_root" diff --cached --quiet; then
	echo "verify-git-install requires a clean tracked working tree" >&2
	exit 1
fi

git -C "$repository_root" ls-files --error-unmatch package.json >/dev/null
commit=$(git -C "$repository_root" rev-parse HEAD)
repository_path=$(node - "$repository_root/package.json" <<'NODE'
const { readFileSync } = require("node:fs");
const packageJson = JSON.parse(readFileSync(process.argv[2], "utf8"));
const repositoryUrl = typeof packageJson.repository === "string" ? packageJson.repository : packageJson.repository?.url;
if (!repositoryUrl) throw new Error("package.json repository URL is required");
const path = new URL(repositoryUrl.replace(/^git\+/, "")).pathname.replace(/^\//, "").replace(/\.git$/, "");
if (!/^[^/]+\/[^/]+$/.test(path)) throw new Error(`unsupported repository URL: ${repositoryUrl}`);
console.log(path);
NODE
)
temporary_root=$(mktemp -d)
server_pid=""
cleanup() {
	if [[ -n "$server_pid" ]]; then
		kill "$server_pid" 2>/dev/null || true
		wait "$server_pid" 2>/dev/null || true
	fi
	rm -rf "$temporary_root"
}
trap cleanup EXIT

http_root="$temporary_root/http-root"
bare_repository="$http_root/$repository_path.git"
mkdir -p "$(dirname "$bare_repository")"
git clone --bare --no-local "$repository_root" "$bare_repository" >/dev/null
git --git-dir="$bare_repository" update-server-info

port=$(node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')
python3 -m http.server "$port" \
	--bind 127.0.0.1 \
	--directory "$http_root" \
	>"$temporary_root/http-server.log" 2>&1 &
server_pid=$!

repository_url="http://localhost:$port/$repository_path.git"
for _ in $(seq 1 50); do
	if git ls-remote "$repository_url" HEAD >/dev/null 2>&1; then
		break
	fi
	sleep 0.1
done
if ! git ls-remote "$repository_url" HEAD >/dev/null 2>&1; then
	cat "$temporary_root/http-server.log" >&2
	echo "temporary Git HTTP server did not become ready" >&2
	exit 1
fi

agent_dir="$temporary_root/agent"
work_dir="$temporary_root/work"
mkdir -p "$agent_dir" "$work_dir"
source="git:$repository_url@$commit"
(
	cd "$work_dir"
	PI_CODING_AGENT_DIR="$agent_dir" \
	PI_SKIP_VERSION_CHECK=1 \
	PI_TELEMETRY=0 \
	GIT_TERMINAL_PROMPT=0 \
	GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5" \
	pi install "$source"
)

installed_path="$agent_dir/git/localhost/$repository_path"
test "$(git -C "$installed_path" rev-parse HEAD)" = "$commit"
test ! -e "$installed_path/model-tier-router.json"

config_path="$agent_dir/model-tier-router.json"
printf '%s\n' '{"enabled":false,"tiers":{},"modelPolicies":{"fixture/model":{"metered":true,"consent":"allow"}}}' >"$config_path"
printf '%s\n' \
	'{"id":"commands","type":"get_commands"}' \
	'{"id":"status","type":"prompt","message":"/model-tier status"}' \
	'{"id":"policy","type":"prompt","message":"/model-tier policy fixture/model"}' \
	| (
		cd "$work_dir"
		PI_CODING_AGENT_DIR="$agent_dir" \
		PI_SKIP_VERSION_CHECK=1 \
		PI_TELEMETRY=0 \
		timeout 20 pi --mode rpc --no-session
	) >"$temporary_root/rpc-output.jsonl" 2>"$temporary_root/rpc-error.log"

node "$repository_root/scripts/verify-rpc-output.mjs" \
	"$temporary_root/rpc-output.jsonl" \
	"$config_path"

echo "Verified git package at immutable ref $commit"
