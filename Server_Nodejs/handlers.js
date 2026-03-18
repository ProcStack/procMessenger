/**
 * procMessenger — Node.js Message Handlers
 *
 * Runtime functionality for handling incoming messages.
 * Imported by client.js to process messages received from the server.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("./config");

/**
 * Get list of available scripts in the scripts directory.
 */
function getAvailableScripts() {
    const scriptsDir = path.resolve(config.SCRIPTS_DIR);
    if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
        return [];
    }

    return fs.readdirSync(scriptsDir)
        .filter((f) => fs.statSync(path.join(scriptsDir, f)).isFile())
        .map((f) => ({
            name: f,
            description: `Script: ${f}`,
        }));
}

/**
 * Execute a script by name from the scripts directory.
 * Returns a promise resolving to { exitCode, stdout, stderr }.
 */
function executeScript(scriptName, args = []) {
    return new Promise((resolve) => {
        const scriptsDir = path.resolve(config.SCRIPTS_DIR);
        const scriptPath = path.join(scriptsDir, scriptName);

        // Security: prevent path traversal
        const realScriptsDir = fs.realpathSync(scriptsDir);
        let realScriptPath;
        try {
            realScriptPath = fs.realpathSync(scriptPath);
        } catch {
            resolve({ exitCode: -1, stdout: "", stderr: `Script not found: ${scriptName}` });
            return;
        }

        if (!realScriptPath.startsWith(realScriptsDir + path.sep)) {
            resolve({ exitCode: -1, stdout: "", stderr: "Security error: path traversal detected." });
            return;
        }

        const stringArgs = args.map(String);

        execFile(realScriptPath, stringArgs, { cwd: realScriptsDir, timeout: 120000 }, (error, stdout, stderr) => {
            if (error && error.killed) {
                resolve({ exitCode: -1, stdout: "", stderr: "Script execution timed out (120s limit)." });
            } else {
                resolve({
                    exitCode: error ? error.code || -1 : 0,
                    stdout: stdout || "",
                    stderr: stderr || "",
                });
            }
        });
    });
}

/**
 * Handle a run_script message.
 */
async function handleRunScript(payload) {
    const action = payload.action || "";

    if (action === "list_scripts") {
        return { action: "script_list", scripts: getAvailableScripts() };
    }

    if (action === "execute") {
        const scriptName = payload.scriptName || "";
        const args = payload.args || [];
        if (!scriptName) {
            return { action: "result", scriptName: "", exitCode: -1, stdout: "", stderr: "No scriptName provided." };
        }
        const result = await executeScript(scriptName, args);
        return { action: "result", scriptName, ...result };
    }

    return { action: "error", message: `Unknown run_script action: ${action}` };
}

/**
 * Handle a gather_research message.
 * Placeholder — requires Puppeteer + Search API + local LLM integration.
 */
async function handleGatherResearch(payload) {
    const query = payload.query || "";
    console.log(`[RESEARCH] Query: ${query}`);

    // Placeholder response
    return {
        status: "unsupported",
        message: "Gather Research is not yet fully implemented. Requires Puppeteer + Search API + LLM setup.",
        query,
    };
}

/**
 * Handle an edit_story message.
 */
function handleEditStory(payload) {
    const message = payload.message || "";
    console.log(`[STORY] ${message}`);

    return {
        message: `[Story Editor] Received: ${message}`,
        status: "received",
    };
}

/**
 * Main dispatcher — routes a parsed message to the appropriate handler.
 * Returns [responseType, responsePayload] or [null, null].
 */
async function handleMessage(msg) {
    const type = msg.type || "";
    const payload = msg.payload || {};

    if (type === "run_script") {
        return ["run_script", await handleRunScript(payload)];
    }

    if (type === "gather_research") {
        return ["gather_research", await handleGatherResearch(payload)];
    }

    if (type === "edit_story") {
        return ["edit_story", handleEditStory(payload)];
    }

    return [null, null];
}

module.exports = { handleMessage, getAvailableScripts, executeScript };
