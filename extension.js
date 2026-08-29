const vscode = require('vscode');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_ROBOT_NAME = 'LEGO Bricks';

let globalState;
let extensionPath;
let output;

// Most recent BLE scan, reused when the tree is redrawn without rescanning.
let lastScan = { devices: [], error: null, at: 0 };

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

// The scanner runs on the same interpreter that owns pybricksdev, so `bleak` is
// guaranteed to be importable there.
function getPythonCommand() {
	const candidates = process.platform === 'win32'
		? [getVenvExecutable('python')]
		: [getVenvExecutable('python3'), getVenvExecutable('python')];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}

	return process.platform === 'win32' ? 'python' : 'python3';
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
	const script = path.join(extensionPath, 'scripts', 'ble_scan.py');
	const args = [script, '--timeout', String(timeout)];
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

	const rank = d => (d.selected ? 0 : d.nearby ? 1 : 2);
	return [...byName.values()]
		.map(d => ({ ...d, selected: d.name === selected }))
		.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
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
		this.view.webview.html = `
		<div style="padding:12px;font-family:var(--vscode-font-family)">
		  <h3 style="margin:0 0 8px;color:var(--vscode-foreground)">🤖 ${robotName}</h3>
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
		// selection state and on whether the entry is removable.
		const tokens = ['device', device.selected ? 'selected' : 'unselected'];
		if (device.saved) tokens.push('saved');
		if (device.nearby) tokens.push('nearby');
		this.contextValue = tokens.join('.');

		const labels = [];
		if (device.selected) labels.push('selected');
		if (device.nearby) {
			labels.push(typeof device.rssi === 'number' ? `nearby (${device.rssi} dBm)` : 'nearby');
		} else if (device.saved) {
			labels.push('saved');
		}
		if (device.kind === 'lwp3') labels.push('no Pybricks firmware');
		this.description = labels.join(' · ');

		if (device.selected) {
			this.iconPath = new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.green'));
		} else if (device.nearby) {
			this.iconPath = new vscode.ThemeIcon('broadcast');
		} else {
			this.iconPath = new vscode.ThemeIcon('circle-large-outline');
		}

		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${device.name}**\n\n`);
		if (device.address) tooltip.appendMarkdown(`Address: \`${device.address}\`\n\n`);
		tooltip.appendMarkdown(device.nearby ? 'Currently advertising.' : 'Saved, not seen in the last scan.');
		if (device.kind === 'lwp3') {
			tooltip.appendMarkdown('\n\nThis hub is running LEGO firmware, not Pybricks. Flash Pybricks before running programs on it.');
		}
		this.tooltip = tooltip;

		if (!device.selected) {
			this.command = { command: 'pybricks.connect', title: 'Select', arguments: [device.name] };
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
		this.devices = buildDeviceList().map(d => new DeviceItem(d));
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

	output = vscode.window.createOutputChannel('Pybricks Runner');
	context.subscriptions.push(output);

	// Status bar
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.command = 'pybricks.run';
	statusBarItem.tooltip = 'Run current Python file on robot using pybricksdev';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	let pybricksTerminal;

	// Sidebar
	const devicesProvider = new DevicesProvider();
	const selectedRobotView = new SelectedRobotView();

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('pybricks.devices', devicesProvider),
		vscode.window.registerWebviewViewProvider('pybricks.selectedRobot', selectedRobotView)
	);

	const refreshUi = () => {
		statusBarItem.text = '$(rocket) Run on ' + getRobotName();
		selectedRobotView.refresh();
		devicesProvider.refresh();
	};

	const selectRobot = async name => {
		await setRobotName(name || DEFAULT_ROBOT_NAME);
		if (name && name !== DEFAULT_ROBOT_NAME) await addRobotName(name);
		refreshUi();
	};

	const runScan = async ({ silent = false } = {}) => {
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

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('pybricks.scanDevices', () => runScan()),

		vscode.commands.registerCommand('pybricks.refreshDevices', () => {
			devicesProvider.refresh();
		}),

		vscode.commands.registerCommand('pybricks.connect', async (arg) => {
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

				await selectRobot(name);
				vscode.window.showInformationMessage(`Selected device: ${name}`);
			} catch (e) {
				vscode.window.showErrorMessage(`Failed to select device: ${e.message}`);
			}
		}),

		vscode.commands.registerCommand('pybricks.disconnect', async () => {
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
			await selectRobot(trimmed);
			vscode.window.showInformationMessage(`"${trimmed}" added to robot list`);
		}),

		vscode.commands.registerCommand('pybricks.forgetDevice', async (arg) => {
			const name = nameOf(arg);
			if (!name) return;
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
					description: nearbyNames.has(name) ? 'nearby' : 'not seen in last scan'
				})),
				{
					canPickMany: true,
					title: 'Remove Saved Robots',
					placeHolder: 'Select the robots to forget'
				}
			);

			if (!picks || picks.length === 0) return;

			const removed = await removeRobotNames(picks.map(p => p.label));
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
			info += `Python used for scanning: ${getPythonCommand()}\n`;
			info += `Scanner script: ${path.join(extensionPath, 'scripts', 'ble_scan.py')}\n\n`;
			info += `Selected robot: ${getRobotName()}\n`;
			info += `Saved robots: ${getRobotNameList().join(', ') || '(none)'}\n`;
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

			await selectRobot(robotName);
			vscode.window.showInformationMessage(`Robot name set to "${robotName}"`);
		})
	);

	vscode.window.onDidCloseTerminal(terminal => {
		if (terminal.name === 'Pybricks') {
			pybricksTerminal = undefined;
		}
	});

	// Initial device list population
	refreshUi();

	if (vscode.workspace.getConfiguration('pybricksRunner').get('scanOnStartup', false)) {
		runScan({ silent: true });
	}

	// Check if pybricksdev is installed
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
