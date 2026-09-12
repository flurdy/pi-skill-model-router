import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [outputPath, expectedConfigPath] = process.argv.slice(2);
assert.ok(outputPath && expectedConfigPath, "usage: verify-rpc-output.mjs <output> <config-path>");
const events = readFileSync(outputPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

const commandsResponse = events.find((event) => event.type === "response" && event.command === "get_commands");
assert.equal(commandsResponse?.success, true, "get_commands did not succeed");
const modelTierCommand = commandsResponse.data.commands.find((command) => command.name === "model-tier");
assert.equal(modelTierCommand?.source, "extension", "model-tier command was not loaded from the extension");

const promptResponse = events.find((event) => event.type === "response" && event.command === "prompt");
assert.equal(promptResponse?.success, true, "model-tier status command did not execute");
const statusNotification = events.find(
	(event) => event.type === "extension_ui_request"
		&& event.method === "notify"
		&& typeof event.message === "string"
		&& event.message.includes("active tier:"),
);
assert.ok(statusNotification, "model-tier status notification was not emitted");
assert.match(statusNotification.message, /enabled: false/);
assert.ok(
	statusNotification.message.includes(`config: ${expectedConfigPath}`),
	"status did not report the external agent configuration path",
);

const policyResponse = events.find((event) => event.type === "response" && event.id === "policy");
assert.equal(policyResponse?.success, true, "installed policy command did not execute");
const policyNotification = events.find((event) => event.type === "extension_ui_request"
	&& event.method === "notify" && event.message?.startsWith('{"version":1,"runtime":"pi"'));
assert.ok(policyNotification, "installed policy evidence was not emitted");
const evidence = JSON.parse(policyNotification.message);
assert.equal(evidence.source.path, expectedConfigPath);
assert.equal(evidence.source.revision, createHash("sha256").update(readFileSync(expectedConfigPath)).digest("hex"));
assert.deepEqual(evidence.policies, [{ model: "fixture/model", meteredClassification: true, consentPolicy: "allow", basis: "explicit" }]);
assert.equal(events.some((event) => event.type === "agent_start"), false, "policy query started a model turn");
console.log("Installed commands, external configuration and launch-free policy evidence verified.");
