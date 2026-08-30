const vscode = require('vscode');
const { exec, execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_ROBOT_NAME = 'LEGO Bricks';

let globalState;
let extensionPath;
let output;

// Most recent BLE scan, reused when the tree is redrawn without rescanning.
let lastScan = { devices: [], error: null, at: 0 };

// Live connection state, driven by events from the hub agent.
let hub = { state: 'disconnected', name: null, address: null, programRunning: false, programState: 'idle' };

function log(message) {
	if (output) output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

function getRobotName() {
	return globalState.get('selectedRobotName', DEFAULT_ROBOT_NAME);
}

function setRobotName(name) {
	return globalState.update('selectedRobotName', name);
}

function getRobotNameList() {
	return globalState.get('robotNameList', []);
}

function setRobotNameList(list) {
	return globalState.update('robotNameList', list);
}

async function addRobotName(name) {
	const list = getRobotNameList();
	if (!name || list.includes(name)) return false;
	await setRobotNameList([...list, name]);
	log(`Saved robot "${name}"`);
	return true;
}

// Removes names from the saved list. If the selected robot is removed, the
// selection falls back to the default so `run` stops passing a stale --name.
async function removeRobotNames(names) {
	const doomed = new Set(names.filter(Boolean));
	if (doomed.size === 0) return 0;

	const list = getRobotNameList();
	const kept = list.filter(n => !doomed.has(n));
	await setRobotNameList(kept);

	if (doomed.has(getRobotName())) {
		await setRobotName(DEFAULT_ROBOT_NAME);
	}

	log(`Removed ${list.length - kept.length} saved robot(s): ${[...doomed].join(', ')}`);
	return list.length - kept.length;
}

// ============================================================================
// TOOL DISCOVERY
// ============================================================================

function getVenvBinDir() {
	return path.join(os.homedir(), '.pybricks-venv', process.platform === 'win32' ? 'Scripts' : 'bin');
}

function getVenvExecutable(name) {
	return path.join(getVenvBinDir(), process.platform === 'win32' ? `${name}.exe` : name);
}

function getPybricksdevCommand(showDebug = false) {
	const venvPybricksdev = getVenvExecutable('pybricksdev');

	if (showDebug) {
		console.log('[Pybricks Debug] Home dir:', os.homedir());
		console.log('[Pybricks Debug] Looking for:', venvPybricksdev);
		console.log('[Pybricks Debug] File exists:', fs.existsSync(venvPybricksdev));
	}

	if (fs.existsSync(venvPybricksdev)) {
		return `"${venvPybricksdev}"`;
	}

	return 'pybricksdev';
}

// Helper scripts run on the interpreter that owns pybricksdev, so bleak and
// pybricksdev itself are always importable.
function getPythonCommand() {
	const candidates = process.platform === 'win32'
		? [getVenvExecutable('python')]
		: [getVenvExecutable('python3'), getVenvExecutable('python')];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}

	return process.platform === 'win32' ? 'python' : 'python3';
}

function scriptPath(name) {
	return path.join(extensionPath, 'scripts', name);
}

// ============================================================================
// DEVICE SCANNING
// ============================================================================

function describeScanFailure(err, stderr, python) {
	if (err && err.code === 'ENOENT') {
		return `Python was not found (tried "${python}"). Install pybricksdev with the bundled installer.`;
	}
	if (err && err.killed) {
		return 'The scan timed out. Is Bluetooth turned on?';
	}
	const detail = (stderr || '').trim().split(/\r?\n/).filter(Boolean).pop();
	return detail || (err && err.message) || 'Unknown scanning error.';
}

function scanForDevices() {
	const config = vscode.workspace.getConfiguration('pybricksRunner');
	const timeout = Math.max(1, config.get('scanTimeout', 5));
	const includeAll = config.get('showAllBluetoothDevices', false);

	const python = getPythonCommand();
	const args = [scriptPath('ble_scan.py'), '--timeout', String(timeout)];
	if (includeAll) args.push('--all');

	log(`Scanning for ${timeout}s using ${python}${includeAll ? ' (all BLE devices)' : ''}`);

	return new Promise(resolve => {
		execFile(
			python,
			args,
			{ timeout: (timeout + 10) * 1000, maxBuffer: 4 * 1024 * 1024 },
			(err, stdout, stderr) => {
				// The script prints one JSON line; tolerate warnings printed before it.
				const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
				let parsed = null;
				try {
					if (lines.length) parsed = JSON.parse(lines[lines.length - 1]);
				} catch {
					parsed = null;
				}

				if (parsed && parsed.error) {
					log(`Scan failed: ${parsed.error}`);
					resolve({ devices: [], error: parsed.error });
					return;
				}

				if (parsed && Array.isArray(parsed.devices)) {
					log(`Scan found ${parsed.devices.length} device(s): ${parsed.devices.map(d => d.name).join(', ') || 'none'}`);
					resolve({ devices: parsed.devices, error: null });
					return;
				}

				const message = describeScanFailure(err, stderr, python);
				log(`Scan failed: ${message}`);
				resolve({ devices: [], error: message });
			}
		);
	});
}

// Merges the last scan with the saved list so the tree shows nearby hubs and
// remembered ones together, each tagged with where it came from.
function buildDeviceList() {
	const saved = getRobotNameList();
	const selected = getRobotName();
	const byName = new Map();

	for (const device of lastScan.devices) {
		byName.set(device.name, {
			name: device.name,
			address: device.address,
			rssi: device.rssi,
			kind: device.kind,
			nearby: true,
			saved: false
		});
	}

	for (const name of saved) {
		const entry = byName.get(name) || { name, nearby: false };
		entry.saved = true;
		byName.set(name, entry);
	}

	if (selected && selected !== DEFAULT_ROBOT_NAME && !byName.has(selected)) {
		byName.set(selected, { name: selected, nearby: false, saved: false });
	}

	// A connected hub stops advertising, so it will not appear in a scan.
	if (hub.name && !byName.has(hub.name)) {
		byName.set(hub.name, { name: hub.name, nearby: false, saved: false });
	}

	const rank = d => (d.connected ? 0 : d.selected ? 1 : d.nearby ? 2 : 3);
	return [...byName.values()]
		.map(d => ({
			...d,
			selected: d.name === selected,
			connected: hub.state === 'connected' && d.name === hub.name,
			connecting: hub.state === 'connecting' && d.name === hub.name
		}))
		.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ============================================================================
// HUB AGENT
// ============================================================================

// Owns the long-lived Python process that holds the BLE connection. Commands
// are request/response by id; everything else arrives as an unsolicited event.
class HubAgent {
	constructor(onEvent) {
		this.onEvent = onEvent;
		this.proc = null;
		this.buffer = '';
		this.nextId = 1;
		this.pending = new Map();
	}

	isRunning() {
		return this.proc !== null;
	}

	start() {
		if (this.proc) return;

		const python = getPythonCommand();
		log(`Starting hub agent: ${python} ${scriptPath('hub_agent.py')}`);
		// -u so the agent's JSON lines are not held in a pipe buffer.
		this.proc = spawn(python, ['-u', scriptPath('hub_agent.py')], { stdio: ['pipe', 'pipe', 'pipe'] });

		this.proc.stdout.setEncoding('utf8');
		this.proc.stdout.on('data', chunk => this._consume(chunk));
		this.proc.stderr.setEncoding('utf8');
		this.proc.stderr.on('data', chunk => {
			// pybricksdev renders a tqdm progress bar to stderr while downloading a
			// program. It is not an error and would swamp the log on every run.
			for (const line of String(chunk).split(/[\r\n]+/)) {
				const text = line.trim();
				if (!text || /^\d{1,3}%\|/.test(text)) continue;
				log(`[agent stderr] ${text}`);
			}
		});

		this.proc.on('error', err => this._die(`agent failed to start: ${err.message}`));
		this.proc.on('exit', (code, signal) => {
			this._die(`agent exited (${signal || `code ${code}`})`);
		});
	}

	_consume(chunk) {
		this.buffer += chunk;
		let index;
		while ((index = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;

			let message;
			try {
				message = JSON.parse(line);
			} catch {
				log(`[agent] unparsable line: ${line}`);
				continue;
			}

			if (message.event === 'result') {
				const waiter = this.pending.get(message.id);
				if (waiter) {
					this.pending.delete(message.id);
					if (message.ok) waiter.resolve(message);
					else waiter.reject(new Error(message.error || 'command failed'));
				}
				continue;
			}

			this.onEvent(message);
		}
	}

	_die(reason) {
		if (!this.proc) return;
		this.proc = null;
		this.buffer = '';
		log(`Hub agent stopped: ${reason}`);

		for (const waiter of this.pending.values()) {
			waiter.reject(new Error(reason));
		}
		this.pending.clear();

		this.onEvent({ event: 'state', state: 'disconnected', reason });
	}

	send(cmd, payload = {}) {
		if (!this.proc) return Promise.reject(new Error('hub agent is not running'));

		const id = this.nextId++;
		const line = JSON.stringify({ id, cmd, ...payload }) + '\n';

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc.stdin.write(line, err => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	async shutdown() {
		if (!this.proc) return;
		const proc = this.proc;
		try {
			await this.send('shutdown');
		} catch {
			// Agent already gone; fall through to the kill below.
		}
		if (proc && !proc.killed) proc.kill();
		this.proc = null;
	}
}

// ============================================================================
// HUB OUTPUT TERMINAL
// ============================================================================

let hubTerminal = null;
let hubWriter = null;
let hubTerminalOpen = false;
let hubPending = [];

function ensureHubTerminal() {
	if (hubTerminal) return;

	hubWriter = new vscode.EventEmitter();
	const pty = {
		onDidWrite: hubWriter.event,
		open: () => {
			hubTerminalOpen = true;
			for (const text of hubPending) hubWriter.fire(text);
			hubPending = [];
		},
		close: () => {
			hubTerminalOpen = false;
		}
	};

	hubTerminal = vscode.window.createTerminal({ name: 'Pybricks Hub', pty });
}

function hubWrite(text) {
	ensureHubTerminal();
	const normalized = String(text).replace(/\r?\n/g, '\r\n');
	if (hubTerminalOpen) hubWriter.fire(normalized);
	else hubPending.push(normalized);
}

function disposeHubTerminal() {
	hubTerminal = null;
	hubWriter = null;
	hubTerminalOpen = false;
	hubPending = [];
}

// ============================================================================
// SIDEBAR VIEWS
// ============================================================================

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, c => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	})[c]);
}

class SelectedRobotView {
	resolveWebviewView(view) {
		view.webview.options = { enableScripts: true };
		this.view = view;
		this.refresh();
	}
	refresh() {
		if (!this.view) return;

		const robotName = escapeHtml(getRobotName());
		const status = hub.state === 'connected'
			? (hub.programState === 'running' ? 'Connected — program running'
				: hub.programState === 'uploading' ? 'Connected — uploading'
				: 'Connected')
			: hub.state === 'connecting' ? 'Connecting...' : 'Not connected';
		const color = hub.state === 'connected'
			? 'var(--vscode-testing-iconPassed, #3fb950)'
			: 'var(--vscode-descriptionForeground)';

		this.view.webview.html = `
		<div style="padding:12px;font-family:var(--vscode-font-family)">
		  <h3 style="margin:0 0 8px;color:var(--vscode-foreground)">🤖 ${robotName}</h3>
		  <p style="margin:0 0 4px;color:${color};font-size:12px">${escapeHtml(status)}</p>
		  <p style="margin:0;color:var(--vscode-descriptionForeground);font-size:12px">
		    Currently selected robot
		  </p>
		</div>`;
	}
}

class DeviceItem extends vscode.TreeItem {
	constructor(device) {
		super(device.name, vscode.TreeItemCollapsibleState.None);
		this.name = device.name;

		// Dot-separated tokens so package.json `when` clauses can match on
		// selection, connection and whether the entry is removable.
		const tokens = ['device', device.selected ? 'selected' : 'unselected'];
		tokens.push(device.connected ? 'connected' : 'offline');
		if (device.saved) tokens.push('saved');
		if (device.nearby) tokens.push('nearby');
		this.contextValue = tokens.join('.');

		const labels = [];
		if (device.connected) labels.push(device.programRunning ? 'connected · running' : 'connected');
		else if (device.connecting) labels.push('connecting...');
		if (device.selected) labels.push('selected');
		if (!device.connected) {
			if (device.nearby) {
				labels.push(typeof device.rssi === 'number' ? `nearby (${device.rssi} dBm)` : 'nearby');
			} else if (device.saved) {
				labels.push('saved');
			}
		}
		if (device.kind === 'lwp3') labels.push('no Pybricks firmware');
		this.description = labels.join(' · ');

		if (device.connected) {
			this.iconPath = new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('charts.green'));
		} else if (device.connecting) {
			this.iconPath = new vscode.ThemeIcon('sync~spin');
		} else if (device.selected) {
			this.iconPath = new vscode.ThemeIcon('circle-filled');
		} else if (device.nearby) {
			this.iconPath = new vscode.ThemeIcon('broadcast');
		} else {
			this.iconPath = new vscode.ThemeIcon('circle-large-outline');
		}

		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${device.name}**\n\n`);
		if (device.address) tooltip.appendMarkdown(`Address: \`${device.address}\`\n\n`);
		if (device.connected) {
			tooltip.appendMarkdown('Connected. The hub has stopped advertising and programs are sent over this link.');
		} else if (device.nearby) {
			tooltip.appendMarkdown('Advertising right now — ready to connect.');
		} else {
			tooltip.appendMarkdown('Saved, not seen in the last scan.');
		}
		if (device.kind === 'lwp3') {
			tooltip.appendMarkdown('\n\nThis hub is running LEGO firmware, not Pybricks. Flash Pybricks before running programs on it.');
		}
		this.tooltip = tooltip;

		if (!device.connected) {
			this.command = { command: 'pybricks.selectDevice', title: 'Select', arguments: [device.name] };
		}
	}
}

class DevicesProvider {
	constructor() {
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		this.devices = [];
	}
	refresh() {
		this.devices = buildDeviceList().map(d => new DeviceItem({ ...d, programState: hub.programState }));
		this._onDidChangeTreeData.fire();
	}
	getTreeItem(e) { return e; }
	getChildren() { return this.devices; }
}

// ============================================================================
// PICKERS
// ============================================================================

function nameOf(arg) {
	if (!arg) return null;
	if (typeof arg === 'string') return arg;
	if (arg.name) return arg.name;
	return typeof arg.label === 'string' ? arg.label : null;
}

// Quick pick listing nearby and saved robots, with a trash button on each saved
// entry so old names can be deleted from the same place they are chosen.
function pickRobot(onListChanged) {
	return new Promise(resolve => {
		const quickPick = vscode.window.createQuickPick();
		quickPick.title = 'Select LEGO Robot';
		quickPick.placeholder = 'Pick a robot, or choose "Enter a name..." to add one';
		quickPick.matchOnDescription = true;

		const removeButton = {
			iconPath: new vscode.ThemeIcon('trash'),
			tooltip: 'Remove from saved list'
		};

		const render = () => {
			const saved = getRobotNameList();
			const nearbyNames = new Set(lastScan.devices.map(d => d.name));
			const items = [];

			const unsavedNearby = lastScan.devices.filter(d => !saved.includes(d.name));
			if (unsavedNearby.length) {
				items.push({ label: 'Nearby', kind: vscode.QuickPickItemKind.Separator });
				for (const device of unsavedNearby) {
					items.push({
						label: device.name,
						description: typeof device.rssi === 'number' ? `${device.rssi} dBm` : 'nearby',
						robotName: device.name
					});
				}
			}

			if (saved.length) {
				items.push({ label: 'Saved', kind: vscode.QuickPickItemKind.Separator });
				for (const name of saved) {
					items.push({
						label: name,
						description: nearbyNames.has(name) ? 'saved · nearby' : 'saved',
						buttons: [removeButton],
						robotName: name
					});
				}
			}

			items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
			items.push({ label: '$(add) Enter a name...', isCustom: true });
			items.push({ label: '$(search) Scan for devices', isScan: true });

			quickPick.items = items;
		};

		let settled = false;
		const finish = value => {
			if (settled) return;
			settled = true;
			resolve(value);
			quickPick.hide();
		};

		quickPick.onDidTriggerItemButton(async event => {
			await removeRobotNames([event.item.robotName]);
			render();
			if (onListChanged) onListChanged();
		});

		quickPick.onDidAccept(() => {
			const selection = quickPick.selectedItems[0];
			if (!selection) return;
			if (selection.isCustom) {
				finish({ custom: true, seed: quickPick.value.trim() });
				return;
			}
			if (selection.isScan) {
				finish({ scan: true });
				return;
			}
			finish({ name: selection.robotName });
		});

		quickPick.onDidHide(() => {
			quickPick.dispose();
			if (!settled) {
				settled = true;
				resolve(undefined);
			}
		});

		render();
		quickPick.show();
	});
}

// ============================================================================
// ACTIVATION
// ============================================================================

function activate(context) {
	globalState = context.globalState;
	extensionPath = context.extensionPath;
	hub = { state: 'disconnected', name: null, address: null, programRunning: false, programState: 'idle' };
	lastScan = { devices: [], error: null, at: 0 };

	output = vscode.window.createOutputChannel('Pybricks Runner');
	context.subscriptions.push(output);

	const runStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	runStatusItem.command = 'pybricks.run';
	runStatusItem.tooltip = 'Run current Python file on robot';
	runStatusItem.show();

	const connectionStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	connectionStatusItem.command = 'pybricks.toggleConnection';
	connectionStatusItem.show();

	context.subscriptions.push(runStatusItem, connectionStatusItem);

	let pybricksTerminal;

	const devicesProvider = new DevicesProvider();
	const selectedRobotView = new SelectedRobotView();

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('pybricks.devices', devicesProvider),
		vscode.window.registerWebviewViewProvider('pybricks.selectedRobot', selectedRobotView)
	);

	const refreshUi = () => {
		runStatusItem.text = '$(rocket) Run on ' + getRobotName();

		if (hub.state === 'connected') {
			connectionStatusItem.text = hub.programState === 'running'
				? `$(debug-stop) ${hub.name}: running`
				: hub.programState === 'uploading'
					? `$(sync~spin) ${hub.name}: uploading`
					: `$(vm-active) ${hub.name}: connected`;
			connectionStatusItem.tooltip = 'Connected. Click to disconnect.';
		} else if (hub.state === 'connecting') {
			connectionStatusItem.text = '$(sync~spin) Connecting...';
			connectionStatusItem.tooltip = 'Connecting to hub';
		} else {
			connectionStatusItem.text = '$(debug-disconnect) Not connected';
			connectionStatusItem.tooltip = 'Click to connect to the selected hub';
		}

		vscode.commands.executeCommand('setContext', 'pybricks.connected', hub.state === 'connected');
		selectedRobotView.refresh();
		devicesProvider.refresh();
	};

	// -- hub agent ---------------------------------------------------------

	const agent = new HubAgent(event => {
		switch (event.event) {
			case 'state':
				hub.state = event.state;
				if (event.state === 'connected') {
					hub.name = event.name || getRobotName();
					hub.address = event.address || null;
					hubWrite(`\r\n\x1b[32m● Connected to ${hub.name}\x1b[0m\r\n`);
				} else if (event.state === 'connecting') {
					hub.name = event.name || getRobotName();
				} else {
					if (hub.name) hubWrite(`\r\n\x1b[33m○ Disconnected from ${hub.name}\x1b[0m\r\n`);
					hub.name = null;
					hub.address = null;
					hub.programRunning = false;
					hub.programState = 'idle';
				}
				refreshUi();
				break;

			case 'output':
				hubWrite(event.text);
				break;

			case 'program':
				if (event.status === 'started') {
					hub.programRunning = true;
					hub.programState = 'uploading';
					hubWrite(`\r\n\x1b[36m▶ ${path.basename(event.path || '')}\x1b[0m\r\n`);
				} else if (event.status === 'running') {
					hub.programState = 'running';
				} else {
					hub.programRunning = false;
					hub.programState = 'idle';
					// started=false means the hub never reported the program as
					// running, so say so rather than implying it ran.
					hubWrite(event.started === false
						? '\r\n\x1b[33m■ Ended without starting\x1b[0m\r\n'
						: '\r\n\x1b[90m■ Program finished\x1b[0m\r\n');
				}
				refreshUi();
				break;

			case 'notice':
				hubWrite(`\r\n\x1b[33m! ${event.text}\x1b[0m\r\n`);
				log(event.text);
				break;

			case 'log':
				log(`[agent] ${event.text}`);
				break;

			case 'fatal':
				log(`Hub agent fatal: ${event.error}`);
				vscode.window.showErrorMessage(`Pybricks hub agent: ${event.error}`);
				break;

			default:
				log(`[agent] ${JSON.stringify(event)}`);
		}
	});

	context.subscriptions.push({ dispose: () => agent.shutdown() });

	const connectHub = async () => {
		if (hub.state === 'connected') {
			vscode.window.showInformationMessage(`Already connected to ${hub.name}.`);
			return;
		}

		let name = getRobotName();
		if (!name || name === DEFAULT_ROBOT_NAME) {
			const choice = await vscode.window.showInformationMessage(
				'No robot selected. Connect to any nearby Pybricks hub?',
				'Connect to Any',
				'Select a Robot'
			);
			if (choice === 'Select a Robot') {
				await vscode.commands.executeCommand('pybricks.selectRobot');
				name = getRobotName();
				if (!name || name === DEFAULT_ROBOT_NAME) return;
			} else if (choice === 'Connect to Any') {
				name = null;
			} else {
				return;
			}
		}

		agent.start();
		if (!agent.isRunning()) {
			vscode.window.showErrorMessage('Could not start the hub agent. See the Pybricks Runner log.');
			return;
		}

		const timeout = Math.max(1, vscode.workspace.getConfiguration('pybricksRunner').get('connectTimeout', 15));

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Connecting to ${name || 'any nearby hub'}...`
				},
				() => agent.send('connect', { name, timeout })
			);

			if (name) await addRobotName(name);
			vscode.window.showInformationMessage(`Connected to ${hub.name || name}. The hub has stopped advertising.`);
		} catch (e) {
			hub.state = 'disconnected';
			hub.name = null;
			refreshUi();
			const choice = await vscode.window.showErrorMessage(
				`Could not connect: ${e.message}`,
				'Show Log'
			);
			if (choice === 'Show Log') output.show();
		}
	};

	const disconnectHub = async () => {
		if (hub.state === 'disconnected') return;
		try {
			await agent.send('disconnect');
		} catch (e) {
			log(`Disconnect failed: ${e.message}`);
		}
		hub.state = 'disconnected';
		hub.name = null;
		hub.programRunning = false;
		hub.programState = 'idle';
		refreshUi();
	};

	const runOnConnectedHub = async filePath => {
		hubWrite('');
		if (hubTerminal) hubTerminal.show(true);
		try {
			await agent.send('run', { path: filePath });
		} catch (e) {
			hub.programRunning = false;
			hub.programState = 'idle';
			refreshUi();
			vscode.window.showErrorMessage(`Run failed: ${e.message}`);
		}
	};

	const runViaCli = filePath => {
		const robotName = getRobotName();
		const pybricksdevCmd = getPybricksdevCommand();

		if (!pybricksTerminal) {
			pybricksTerminal = vscode.window.createTerminal('Pybricks');
		}
		pybricksTerminal.show(true);

		let cmd = `${pybricksdevCmd} run ble "${filePath}"`;
		if (robotName && robotName !== DEFAULT_ROBOT_NAME) {
			cmd = `${pybricksdevCmd} run ble --name "${robotName}" "${filePath}"`;
		}

		pybricksTerminal.sendText(cmd);
		vscode.window.showInformationMessage(`Programming "${path.basename(filePath)}" to ${robotName}...`);
	};

	const selectRobotName = async name => {
		// The hub only accepts one connection, so switching targets means
		// dropping the current link first.
		if (hub.state === 'connected' && hub.name !== name) {
			const previous = hub.name;
			await disconnectHub();
			vscode.window.showInformationMessage(`Disconnected from ${previous} to select ${name}.`);
		}
		await setRobotName(name || DEFAULT_ROBOT_NAME);
		if (name && name !== DEFAULT_ROBOT_NAME) await addRobotName(name);
		refreshUi();
	};

	const runScan = async ({ silent = false } = {}) => {
		if (hub.state === 'connected' && !silent) {
			vscode.window.showWarningMessage(
				`${hub.name} is connected, so it has stopped advertising and will not appear in a scan.`
			);
		}

		const result = await vscode.window.withProgress(
			{
				location: silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
				title: 'Pybricks: scanning for nearby hubs...'
			},
			() => scanForDevices()
		);

		lastScan = { ...result, at: Date.now() };
		devicesProvider.refresh();

		if (silent) return result;

		if (result.error) {
			const choice = await vscode.window.showErrorMessage(`Scan failed: ${result.error}`, 'Show Log');
			if (choice === 'Show Log') output.show();
		} else if (result.devices.length === 0) {
			vscode.window.showWarningMessage(
				'No hubs found. Power on the hub and press its Bluetooth button until it blinks, then scan again.'
			);
		} else {
			vscode.window.showInformationMessage(`Found ${result.devices.length} device(s).`);
		}

		return result;
	};

	// -- commands ----------------------------------------------------------

	context.subscriptions.push(
		vscode.commands.registerCommand('pybricks.scanDevices', () => runScan()),

		vscode.commands.registerCommand('pybricks.refreshDevices', () => {
			devicesProvider.refresh();
		}),

		vscode.commands.registerCommand('pybricks.connectHub', async (arg) => {
			const name = nameOf(arg);
			if (name && name !== getRobotName()) await selectRobotName(name);
			await connectHub();
		}),

		vscode.commands.registerCommand('pybricks.disconnectHub', async () => {
			const name = hub.name;
			await disconnectHub();
			if (name) vscode.window.showInformationMessage(`Disconnected from ${name}.`);
		}),

		vscode.commands.registerCommand('pybricks.toggleConnection', async () => {
			if (hub.state === 'connected') await vscode.commands.executeCommand('pybricks.disconnectHub');
			else await connectHub();
		}),

		vscode.commands.registerCommand('pybricks.stopProgram', async () => {
			if (hub.state !== 'connected') {
				vscode.window.showWarningMessage('Not connected to a hub.');
				return;
			}
			try {
				await agent.send('stop');
			} catch (e) {
				vscode.window.showErrorMessage(`Could not stop the program: ${e.message}`);
			}
		}),

		vscode.commands.registerCommand('pybricks.selectDevice', async (arg) => {
			try {
				let name = nameOf(arg);

				if (!name) {
					const picked = await pickRobot(refreshUi);
					if (!picked) return;
					if (picked.scan) {
						await runScan();
						return;
					}
					if (picked.custom) {
						name = await vscode.window.showInputBox({
							prompt: 'Enter a robot name',
							value: picked.seed,
							placeHolder: 'e.g., SPIKE Prime, EV3, MyRobot'
						});
						name = name && name.trim();
						if (!name) return;
					} else {
						name = picked.name;
					}
				}

				await selectRobotName(name);
				vscode.window.showInformationMessage(`Selected device: ${name}`);
			} catch (e) {
				vscode.window.showErrorMessage(`Failed to select device: ${e.message}`);
			}
		}),

		vscode.commands.registerCommand('pybricks.deselectDevice', async () => {
			await disconnectHub();
			await setRobotName(DEFAULT_ROBOT_NAME);
			refreshUi();
		}),

		vscode.commands.registerCommand('pybricks.addRobot', async () => {
			const name = await vscode.window.showInputBox({
				prompt: 'Enter a robot name',
				placeHolder: 'e.g., SPIKE Prime, EV3, MyRobot'
			});
			const trimmed = name && name.trim();
			if (!trimmed) return;
			await selectRobotName(trimmed);
			vscode.window.showInformationMessage(`"${trimmed}" added to robot list`);
		}),

		vscode.commands.registerCommand('pybricks.forgetDevice', async (arg) => {
			const name = nameOf(arg);
			if (!name) return;
			if (hub.state === 'connected' && hub.name === name) await disconnectHub();
			await removeRobotNames([name]);
			refreshUi();
			vscode.window.showInformationMessage(`Removed "${name}" from the saved list.`);
		}),

		vscode.commands.registerCommand('pybricks.manageSavedDevices', async () => {
			const saved = getRobotNameList();
			if (saved.length === 0) {
				vscode.window.showInformationMessage('There are no saved robots to remove.');
				return;
			}

			const nearbyNames = new Set(lastScan.devices.map(d => d.name));
			const picks = await vscode.window.showQuickPick(
				saved.map(name => ({
					label: name,
					description: hub.state === 'connected' && hub.name === name
						? 'connected'
						: nearbyNames.has(name) ? 'nearby' : 'not seen in last scan'
				})),
				{
					canPickMany: true,
					title: 'Remove Saved Robots',
					placeHolder: 'Select the robots to forget'
				}
			);

			if (!picks || picks.length === 0) return;

			const names = picks.map(p => p.label);
			if (hub.state === 'connected' && names.includes(hub.name)) await disconnectHub();

			const removed = await removeRobotNames(names);
			refreshUi();
			vscode.window.showInformationMessage(`Removed ${removed} saved robot(s).`);
		}),

		vscode.commands.registerCommand('pybricks.clearSavedDevices', async () => {
			const saved = getRobotNameList();
			if (saved.length === 0) {
				vscode.window.showInformationMessage('There are no saved robots to remove.');
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				`Remove all ${saved.length} saved robot(s)?`,
				{ modal: true },
				'Remove All'
			);
			if (confirm !== 'Remove All') return;

			if (hub.state === 'connected') await disconnectHub();
			await removeRobotNames(saved);
			refreshUi();
		}),

		vscode.commands.registerCommand('pybricks.showLog', () => output.show()),

		vscode.commands.registerCommand('pybricks.showDebugInfo', async () => {
			const homeDir = os.homedir();
			const venvDir = path.join(homeDir, '.pybricks-venv');
			const venvPybricksdev = getVenvExecutable('pybricksdev');

			const venvExists = fs.existsSync(venvDir);
			const pybricksdevExists = fs.existsSync(venvPybricksdev);

			let info = '=== Pybricks Runner Debug Info ===\n\n';
			info += `Platform: ${process.platform}\n`;
			info += `Home Directory: ${homeDir}\n`;
			info += `Venv Directory: ${venvDir}\n`;
			info += `Venv Exists: ${venvExists ? '✓ YES' : '✗ NO'}\n\n`;
			info += `Looking for pybricksdev at:\n${venvPybricksdev}\n`;
			info += `pybricksdev Exists: ${pybricksdevExists ? '✓ YES' : '✗ NO'}\n\n`;
			info += `Python used for helpers: ${getPythonCommand()}\n`;
			info += `Scanner script: ${scriptPath('ble_scan.py')}\n`;
			info += `Agent script: ${scriptPath('hub_agent.py')}\n\n`;
			info += `Selected robot: ${getRobotName()}\n`;
			info += `Saved robots: ${getRobotNameList().join(', ') || '(none)'}\n`;
			info += `Connection: ${hub.state}${hub.name ? ` (${hub.name})` : ''}\n`;
			info += `Agent running: ${agent.isRunning() ? 'yes' : 'no'}\n`;
			info += `Last scan: ${lastScan.at ? new Date(lastScan.at).toLocaleString() : '(never)'}\n`;
			info += `Last scan result: ${lastScan.error ? `error - ${lastScan.error}` : `${lastScan.devices.length} device(s)`}\n\n`;

			if (venvExists) {
				info += 'Files in venv:\n';
				try {
					const scriptsDir = getVenvBinDir();
					if (fs.existsSync(scriptsDir)) {
						const files = fs.readdirSync(scriptsDir);
						info += files.slice(0, 20).join('\n') + '\n';
						if (files.length > 20) info += `... and ${files.length - 20} more files\n`;
					}
				} catch (e) {
					info += `Error reading directory: ${e.message}\n`;
				}
			}

			info += '\n';
			if (!pybricksdevExists) {
				info += '❌ pybricksdev not found!\n\n';
				info += 'Solutions:\n';
				info += '1. Run the installer: installers/install-windows.bat\n';
				info += '2. Or manually: pip install pybricksdev\n';
			} else {
				info += '✓ pybricksdev found!\n';
			}

			const doc = await vscode.workspace.openTextDocument({
				content: info,
				language: 'text'
			});
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('pybricks.run', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active Python file!');
				return;
			}

			const filePath = editor.document.fileName;
			if (!filePath.endsWith('.py')) {
				vscode.window.showErrorMessage('Please open a Python (.py) file.');
				return;
			}

			// The hub reads the file from disk, so unsaved edits would be ignored.
			if (editor.document.isDirty) await editor.document.save();

			if (hub.state === 'connected') {
				if (hub.programRunning) {
					const choice = await vscode.window.showWarningMessage(
						'A program is already running on the hub.',
						'Stop It',
						'Cancel'
					);
					if (choice !== 'Stop It') return;
					await vscode.commands.executeCommand('pybricks.stopProgram');
				}
				await runOnConnectedHub(filePath);
				return;
			}

			runViaCli(filePath);
		}),

		vscode.commands.registerCommand('pybricks.selectRobot', async () => {
			const picked = await pickRobot(refreshUi);
			if (!picked) return;

			if (picked.scan) {
				await runScan();
				await vscode.commands.executeCommand('pybricks.selectRobot');
				return;
			}

			let robotName = picked.name;
			if (picked.custom) {
				const custom = await vscode.window.showInputBox({
					prompt: 'Enter a custom robot name',
					value: picked.seed,
					placeHolder: 'e.g., SPIKE Prime, EV3, MyRobot'
				});
				robotName = custom && custom.trim();
				if (!robotName) return;
			}

			await selectRobotName(robotName);
			vscode.window.showInformationMessage(`Robot name set to "${robotName}"`);
		})
	);

	vscode.window.onDidCloseTerminal(terminal => {
		if (terminal.name === 'Pybricks') pybricksTerminal = undefined;
		if (terminal === hubTerminal) disposeHubTerminal();
	});

	refreshUi();

	if (vscode.workspace.getConfiguration('pybricksRunner').get('scanOnStartup', false)) {
		runScan({ silent: true });
	}

	if (!globalState.get('pybricksdevChecked')) {
		const pybricksdevCmd = getPybricksdevCommand(true);
		exec(`${pybricksdevCmd} --version`, { timeout: 3000 }, (err, stdout) => {
			if (err) {
				vscode.window.showWarningMessage(
					'pybricksdev is not installed. Please run the installer.',
					'Run Installer',
					'Show Debug Info',
					'Learn More'
				).then(selection => {
					if (selection === 'Run Installer') {
						const installersPath = path.join(context.extensionPath, 'installers');
						vscode.env.openExternal(vscode.Uri.file(installersPath));
					} else if (selection === 'Show Debug Info') {
						vscode.commands.executeCommand('pybricks.showDebugInfo');
					} else if (selection === 'Learn More') {
						vscode.env.openExternal(vscode.Uri.parse('https://github.com/pybricks/pybricksdev#installation'));
					}
				});
			} else {
				log(`pybricksdev version: ${stdout.trim()}`);
			}
			globalState.update('pybricksdevChecked', true);
		});
	}
}

function deactivate() {}

module.exports = { activate, deactivate };
