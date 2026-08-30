# Change Log

All notable changes to the "pybricks-runner" extension will be documented in this file.

## [0.5.0] - 2026-08-30

### 🔌 Hold a connection to the hub

Previously every run was a fresh `pybricksdev run ble`: scan, connect, upload, run,
disconnect. The hub dropped back into advertising mode after each program and every run
paid the discovery cost again.

The extension can now hold the connection open.

#### Added
- **Connect to Hub / Disconnect from Hub** — opens a real BLE connection. The hub leaves
  advertising mode (solid light) and stays connected until you disconnect.
- Programs are sent over the held connection, skipping the per-run connect handshake.
- **Pybricks Hub** terminal showing streamed program output.
- **Stop Running Program** — halts the program without dropping the connection.
- Connection status in the status bar; click to connect or disconnect.
- `scripts/hub_agent.py`, a helper process that owns the connection and speaks
  newline-delimited JSON with the extension.
- Setting: `pybricksRunner.connectTimeout`.

#### Changed
- `pybricks.connect` / `pybricks.disconnect` meant *select* / *deselect*, which is
  confusing now that connecting is a real operation. They are renamed
  `pybricks.selectDevice` / `pybricks.deselectDevice`, and `pybricks.connectHub` /
  `pybricks.disconnectHub` do the actual connecting.
- **Run on LEGO Brick** sends over the open connection when connected, and otherwise falls
  back to `pybricksdev run ble` exactly as before.
- Running now saves the active file first — the hub reads it from disk, so unsaved edits
  were previously uploaded stale.
- Because a hub accepts one connection at a time, selecting a different robot, forgetting
  the connected robot, or clearing the list disconnects first and says so.
- Scanning while connected warns that the hub has stopped advertising and will not appear.


## [0.4.0] - 2026-08-29

### 🔍 Working device scanning + device list management

#### Fixed
- **Device scanning never worked.** The extension shelled out to `pybricksdev devices`,
  which is not a real subcommand (`pybricksdev` provides `compile`, `run`, `flash`, `dfu`,
  `oad`, `lwp3` and `udev`). The command always failed and the error was swallowed, so the
  Devices view only ever showed names that had been typed in by hand.
- Scanning now uses `scripts/ble_scan.py`, which drives `bleak` — already a dependency of
  `pybricksdev`, so no extra install is needed — and filters on the Pybricks service UUID.
- Selecting a device from the tree's right-click menu passed the tree item object instead of
  the device name, storing `[object Object]` as the robot name. Names are now resolved from
  either form.
- Scan failures are reported instead of silently producing an empty list, with detail in the
  new **Pybricks Runner** output channel.
- The Selected Robot webview no longer interpolates the robot name into HTML unescaped.

#### Added
- **Pybricks: Scan for Devices** — BLE scan showing nearby hubs with signal strength.
- **Remove from Saved List** — trash icon on any saved device in the Devices view, and next
  to saved entries in the Select LEGO Robot quick pick.
- **Remove Saved Robots...** — multi-select bulk removal.
- **Remove All Saved Robots** — clears the list after a confirmation prompt.
- **Add Robot by Name** — add a hub directly when you already know its name.
- **Show Log** — opens the output channel.
- Welcome view with Scan / Add buttons when no devices are known yet.
- Devices are tagged `nearby` / `saved` / `selected`, and LEGO hubs still running stock
  firmware are flagged as having no Pybricks firmware.
- Settings: `pybricksRunner.scanTimeout`, `pybricksRunner.showAllBluetoothDevices`,
  `pybricksRunner.scanOnStartup`.

#### Changed
- Devices found by a scan are no longer added to the saved list automatically; a hub is
  remembered when you select it. This keeps the saved list something you curate.
- **Deselect Device** (formerly Disconnect) now clears the selection, so `run` stops passing
  a stale `--name`. Removing the selected robot does the same.
- The Devices view title button now scans; **Refresh Device List** redraws without rescanning.


## [0.3.2] - 2025-10-31

### 🎯 Simplification Release

#### Core Changes
- **Removed Web Bluetooth support** - Simplified extension to focus on native VS Code with pybricksdev CLI only
- **Removed remote workspace syncing** - Extension now works best with local workspaces
- **Removed multi-file bundling** - Use pybricksdev's native capabilities instead
- **Kept all UI elements** - Activity bar, sidebar, device scanning, and robot selection remain fully functional

#### What's Still Included
- ✅ Activity bar icon and sidebar
- ✅ Device scanning and management
- ✅ Robot name selection and persistence
- ✅ Status bar integration
- ✅ Two-button interface (Run + Select Robot)
- ✅ Terminal integration with pybricksdev CLI

#### Benefits
- **Simpler codebase** - Reduced from 1065 lines to 285 lines
- **Easier to maintain** - Focus on core functionality
- **More reliable** - Uses pybricksdev's native features directly
- **Better performance** - No unnecessary complexity

#### Migration Note
If you were using Web Bluetooth or remote workspace features, please use:
- **For code-server/browser:** Use pybricksdev directly or the official Pybricks web IDE
- **For remote workspaces:** Work with local copies or use VS Code's built-in remote development

## [0.3.1] - 2025-10-26

### 🐛 Bug Fixes
- **Fixed code-server and VSCodium compatibility** - Changed `extensionKind` to `["workspace", "ui"]` to ensure extension runs in workspace context where Node.js APIs are available
- Previously broke for browser-based VS Code environments (code-server, VSCodium) due to incorrect extension kind setting

### 📚 Documentation
- **Added comprehensive manual publishing guide** for maintainers
- Documented step-by-step process for publishing to VS Code Marketplace and Open VSX Registry
- Included token setup instructions and troubleshooting tips
- Added ready-to-use publishing script

### 🔧 Technical Changes
- Updated `extensionKind` from `["ui"]` to `["workspace", "ui"]` to support all environments
- Ensures extension works in VS Code, code-server, VSCodium, and other VS Code-compatible editors

## [0.3.0] - 2025-01-26

### 🎉 Major Features

#### Remote Workspace Support
- **SSH, WSL, and Dev Container support** - Extension now runs locally while workspace is remote
- Automatically syncs Python files from remote workspace to local machine for Bluetooth connectivity
- Works seamlessly with remote development - zero configuration needed!

#### Multi-File Project Support
- **Supports projects with multiple Python files and local imports**
- Automatically syncs all `.py` files while maintaining directory structure
- Imports like `from helpers import function` now work perfectly
- Project structure is preserved in temp directory

#### Easy Installation
- **One-click installers** for Windows and macOS
- `install-windows.bat` - Double-click installer for Windows
- `install-macos.command` - Double-click installer for macOS
- Creates isolated virtual environment at `~/.pybricks-venv`
- Extension automatically detects and uses venv installation

### ✨ Improvements

#### Robot Name Management
- Robot names now stored in VSCode global state (no more workspace files!)
- No more `.robotName` or `.robotNameList` files cluttering workspace
- Robot names persist across workspaces
- One-time migration from old file-based system

#### Better Error Handling
- Helpful error messages when pybricksdev is not installed
- "Easy Install" button opens installers folder automatically
- Installation guide link for manual installation
- Clear feedback in logs view for remote workspace operations

#### Virtual Environment Support
- Extension checks for pybricksdev in `~/.pybricks-venv` first
- Falls back to system installation if venv not found
- Works on both Windows and macOS

### 🐛 Bug Fixes
- Fixed extension running on remote host instead of local machine
- Fixed file path issues when using remote workspaces
- Fixed working directory for pybricksdev to support relative imports
- Fixed robot selection errors when workspace files don't exist

### 📚 Documentation
- Comprehensive installation guide for both platforms
- Remote workspace setup instructions
- Multi-file project examples
- Troubleshooting section with common issues

### 🔧 Technical Changes
- Changed `extensionKind` to `["ui"]` for local-only execution
- Added automatic file sync for remote workspaces
- Improved command execution logic for remote vs local
- Added startup check for pybricksdev installation

## [0.1.10] - Previous Release

- Initial marketplace release
- Basic pybricksdev integration
- Device scanning and selection
- Status bar integration
- Activity bar sidebar