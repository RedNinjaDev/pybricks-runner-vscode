# Change Log

All notable changes to the "pybricks-runner" extension will be documented in this file.

## [0.4.8] - 2026-08-30

### Fixed
- **A stalled write could hang the connected Run path indefinitely.** Every command
  the agent sends the hub is a write-with-response, and the hub sometimes never sends
  that response ([pybricks/support#1145](https://github.com/pybricks/support/issues/1145)).
  Four of those awaits had no timeout, the worst being the `stop_user_program()` call
  the extension makes before every run when the hub reports a program already running.
  That call sits *before* the transfer budget added in 0.4.6, so the stall recovery
  never got a chance to act and Run appeared to hang forever.

  Connect, stop and disconnect are now all bounded. A stalled write is reported as
  the known upstream issue instead of blocking; a stalled disconnect still drops the
  connection. Nothing in the agent awaits the hub without a deadline.


## [0.4.7] - 2026-08-30

### Fixed
- **Run failed on Windows when the user profile path contained a space.** Running
  without connecting first builds a shell command and sends it to the integrated
  terminal. Because the path to `pybricksdev.exe` was quoted, the command looked like:

  ```
  "C:\Users\Lego Masters\.pybricks-venv\Scripts\pybricksdev.exe" run ble --name "Turtle Hub" run_1.py
  ```

  PowerShell — the default shell on Windows — parses a leading quoted string as a
  string literal rather than a command, and rejects the next word:
  `Unexpected token 'run' in expression or statement`. The program never ran. bash is
  unaffected, which is why Linux worked. This affected the extension as published,
  not just recent changes.

  The executable is now launched directly with its arguments as argv
  (`createTerminal({ shellPath, shellArgs })`), so no shell parses the command line
  and no quoting rules apply. When no virtualenv is present the extension still falls
  back to `pybricksdev` on PATH, where the bare command name needs no quoting and is
  safe in bash, cmd and PowerShell alike.


## [0.4.6] - 2026-08-30

### Added
- **Recovery from a stalled program transfer.** Sending a program to the hub can hang
  partway through: the hub sometimes fails to answer a write-with-response, because a
  status notification races the write response. This is an upstream Pybricks
  firmware/Bluetooth issue ([pybricks/support#1145](https://github.com/pybricks/support/issues/1145),
  [discussion #1142](https://github.com/orgs/pybricks/discussions/1142)) reported most
  often on Windows, and it is not specific to this extension — plain
  `pybricksdev run ble` hangs the same way.

  The transfer is now given a time budget (`pybricksRunner.startTimeout`, default 30s).
  If the program has not started within it, the extension stops the hub and retries
  once — automating the "press Stop, then Run again" workaround. If the retry also
  stalls, the run fails with an explanation and a link rather than hanging forever.

  Only the transfer is timed. Once the hub reports the program running, it may run for
  as long as it likes; verified on hardware with a 30s program under a 5s budget.

### Added setting
- `pybricksRunner.startTimeout` — seconds allowed for sending a program before the
  transfer is treated as stalled.


## [0.4.5] - 2026-08-30

### Verified on hardware (SPIKE Prime, Pybricks, pybricksdev 2.3.2, BlueZ)
Connect, upload, live stdout streaming, tracebacks from a failing program, stop and
disconnect all behave correctly over a held connection.

### Corrected
- The 0.4.2 notes described running a program on a busy hub as *hanging* in
  `_wait_for_user_program_stop`. On hardware it does not hang: the hub rejects the
  **download** with GATT application error `0x81` in about 0.2s, before the program
  is ever started. The guard added in 0.4.2 is still correct and necessary —
  stopping the running program first turns that failure into a successful run — but
  the mechanism described was wrong.

### Fixed
- That rejection surfaced as a raw `BleakGATTProtocolError`. It is now reported as
  "the hub refused the program download, which normally means a program is still
  running on it. Press Stop, then Run again."
- pybricksdev draws a tqdm progress bar on stderr while downloading, which the
  extension logged verbatim on every run. Progress-bar lines are now filtered out of
  the log; genuine stderr is still recorded.


## [0.4.4] - 2026-08-30

### Fixed
- Failing to find a hub reported a bare `TimeoutError:` with no message, because
  that is how bleak raises it. Connecting to a hub that is not advertising now says
  which hub was looked for, for how long, and what to do about it. Exceptions with
  no message no longer render as `SomeError:` with a dangling colon.

### Verified against real hardware
- `scripts/ble_scan.py` and `scripts/hub_agent.py` were run against pybricksdev
  2.3.2 and a real Bluetooth adapter: scanning returns live devices, service-UUID
  classification works, and every pybricksdev API this extension depends on
  (`find_device`, `PybricksHubBLE`, `run`, `stop_user_program`, `status_observable`,
  `StatusFlag`) matches the signatures assumed here.


## [0.4.3] - 2026-08-30

### Fixed
- **The 0.4.2 fix could miss an already-running program.** `connect()` subscribes to
  the Pybricks event characteristic but never reads the status, so
  `status_observable` holds its placeholder `StatusFlag(0)` until the hub sends its
  first `STATUS_REPORT`. Reading that value straight after connecting reported "no
  program running" regardless of the truth, so the guard added in 0.4.2 could be
  skipped and the hang would return. The agent now waits (up to 2s) for the hub's
  first real status report before deciding.
- Status logging no longer presents the placeholder zero as though it were hub
  state; it says "not yet reported by the hub" until a report arrives. If none
  arrives, the run proceeds and the log records that the hub's state is unknown.

### Changed
- The internal `status` command also reports `status_seen`, `running_program` and
  `selected_slot`.


## [0.4.2] - 2026-08-30

### Fixed
- **Running a program over a held connection could hang without starting it.**
  `hub.run()` downloads the program, sends START, then waits for the hub's
  `USER_PROGRAM_RUNNING` flag to clear. Firmware ignores START while a program is
  already running, so if the hub was busy when Run was pressed, the new program was
  never started and the wait blocked on a stop that never came — the UI reported a
  running program while the motors sat still. Pressing Stop cleared the flag, which
  is why stopping and retrying appeared to fix it. The agent now stops any program
  still running on the hub before starting the new one.
- If the hub does not clear the flag after a stop, the run fails with a message
  suggesting a power-cycle instead of blocking indefinitely.

### Changed
- The UI distinguishes **uploading** from **running**: the "running" state is now
  driven by the hub's own status flag rather than assumed as soon as the upload
  begins, so a stalled program can no longer be reported as running. A program that
  ends without ever starting is reported as "Ended without starting".
- Hub status flags are written to the Pybricks Runner log on connect and before each
  run, and a new internal `status` command reports them on demand.


## [0.4.1] - 2026-08-30

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