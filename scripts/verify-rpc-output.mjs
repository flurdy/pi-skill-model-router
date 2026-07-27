import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

console.log("Installed extension command and external configuration verified.");
