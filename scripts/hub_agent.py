#!/usr/bin/env python3
"""Hold a live BLE connection to a Pybricks hub on behalf of the VS Code extension.

A Pybricks hub accepts a single BLE connection and stops advertising while it is
connected, so `pybricksdev run ble` (which opens its own connection) cannot be
used once the extension is holding one. This agent keeps the connection open and
runs programs over it instead.

Protocol: newline-delimited JSON, commands on stdin, events on stdout.

Commands:
    {"id": 1, "cmd": "connect", "name": "Spike Prime", "timeout": 15}
    {"id": 2, "cmd": "run", "path": "/abs/path/program.py"}
    {"id": 3, "cmd": "stop"}
    {"id": 4, "cmd": "disconnect"}
    {"id": 5, "cmd": "shutdown"}

Events:
    {"event": "ready"}
    {"event": "state", "state": "connecting|connected|disconnected", ...}
    {"event": "output", "text": "..."}          # program stdout, streamed
    {"event": "program", "status": "started|finished", ...}
    {"event": "result", "id": 1, "ok": true}
    {"event": "result", "id": 1, "ok": false, "error": "..."}
"""

import asyncio
import codecs
import json
import sys
import threading

# How long to wait for the hub to clear its user-program-running flag.
STOP_TIMEOUT = 3.0
POLL_INTERVAL = 0.1
# How long to wait for the hub's first real STATUS_REPORT after connecting.
STATUS_TIMEOUT = 2.0
# How long to allow for download + start before treating the hub as stalled. Only
# this phase is timed; once the program is actually running it may take as long as
# it likes. See https://github.com/pybricks/support/issues/1145 - the hub sometimes
# fails to answer a write-with-response during download, which hangs the transfer.
START_TIMEOUT = 30.0
# Every write-with-response can stall: the hub sometimes never sends the response
# (pybricks/support#1145). Nothing may await one indefinitely.
WRITE_TIMEOUT = 10.0
CONNECT_TIMEOUT = 30.0
DISCONNECT_TIMEOUT = 10.0


class Agent:
	def __init__(self):
		self.hub = None
		self.device_name = None
		self.subscriptions = []
		self.run_task = None
		# status_observable is a BehaviorSubject seeded with StatusFlag(0); connect()
		# only subscribes, it never reads the status characteristic. Until the hub
		# sends its first STATUS_REPORT that zero is a placeholder, not hub state.
		self._status_seen = False
		self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
		# stdout_observable may fire from a different thread than the event loop.
		self._write_lock = threading.Lock()

	# -- output ------------------------------------------------------------

	def emit(self, **payload):
		line = json.dumps(payload)
		with self._write_lock:
			sys.stdout.write(line + "\n")
			sys.stdout.flush()

	def _on_stdout(self, data):
		try:
			text = self._decoder.decode(bytes(data))
		except Exception:  # noqa: BLE001 - never let a decode kill the stream
			text = repr(data)
		if text:
			self.emit(event="output", text=text)

	def _on_connection_state(self, state):
		# Compare by name so the ConnectionState enum need not be imported.
		name = getattr(state, "name", str(state)).upper()
		if name.endswith("DISCONNECTED") and self.hub is not None:
			self.hub = None
			self._dispose_subscriptions()
			self.emit(event="state", state="disconnected", reason="hub disconnected")

	def _dispose_subscriptions(self):
		for sub in self.subscriptions:
			try:
				sub.dispose()
			except Exception:  # noqa: BLE001
				pass
		self.subscriptions = []

	# -- commands ----------------------------------------------------------

	async def cmd_connect(self, msg):
		if self.hub is not None:
			raise RuntimeError(f"already connected to {self.device_name}")

		from pybricksdev.ble import find_device
		from pybricksdev.connections.pybricks import PybricksHubBLE

		name = msg.get("name") or None
		timeout = float(msg.get("timeout", 15))

		self.emit(event="state", state="connecting", name=name)
		try:
			device = await find_device(name, timeout=timeout)
		except asyncio.TimeoutError:
			# bleak raises TimeoutError with an empty message, which surfaces to
			# the user as a bare "TimeoutError:".
			target = f' named "{name}"' if name else ""
			raise RuntimeError(
				f"no Pybricks hub{target} found within {timeout:g}s. "
				"Power the hub on and hold its Bluetooth button until it blinks."
			) from None

		hub = PybricksHubBLE(device)
		self.subscriptions.append(hub.stdout_observable.subscribe(self._on_stdout))
		self.subscriptions.append(
			hub.connection_state_observable.subscribe(self._on_connection_state)
		)

		self._status_seen = False
		replayed = [True]

		def on_status(_flags):
			# The BehaviorSubject replays its seed value on subscribe; only
			# emissions after that are genuine reports from the hub.
			if replayed[0]:
				replayed[0] = False
				return
			self._status_seen = True

		self.subscriptions.append(hub.status_observable.subscribe(on_status))

		try:
			await self._bounded(hub.connect(), CONNECT_TIMEOUT, "the connection request")
		except Exception:
			self._dispose_subscriptions()
			raise

		self.hub = hub
		self.device_name = getattr(device, "name", None) or name
		self.emit(event="log", text=f"hub status at connect: {self._describe_status()}")
		self.emit(
			event="state",
			state="connected",
			name=self.device_name,
			address=getattr(device, "address", None),
		)

	async def _bounded(self, awaitable, timeout, what):
		"""Await a hub operation that could stall forever waiting for a response."""
		try:
			return await asyncio.wait_for(awaitable, timeout)
		except asyncio.TimeoutError:
			raise RuntimeError(
				f"the hub did not respond to {what} within {timeout:g}s. This is the "
				"known Pybricks write-response stall (pybricks/support#1145). "
				"Disconnect and reconnect the hub, and reduce other Bluetooth activity."
			) from None

	def _status_flags(self):
		try:
			return int(self.hub.status_observable.value)
		except Exception:  # noqa: BLE001 - diagnostics must never break a run
			return 0

	def _describe_status(self):
		if not self._status_seen:
			return "not yet reported by the hub"
		return f"{self._status_flags():#x}"

	async def _await_status(self):
		"""Wait for the hub's first real STATUS_REPORT.

		Without this the cached zero would be read as "no program running" and
		any already-running program would be missed.
		"""
		if self._status_seen:
			return True
		for _ in range(int(STATUS_TIMEOUT / POLL_INTERVAL)):
			await asyncio.sleep(POLL_INTERVAL)
			if self._status_seen:
				return True
		return False

	async def cmd_run(self, msg):
		if self.hub is None:
			raise RuntimeError("not connected")
		if self.run_task is not None and not self.run_task.done():
			raise RuntimeError("a program is already running")

		path = msg.get("path")
		if not path:
			raise RuntimeError("no program path given")

		from pybricksdev.ble.pybricks import StatusFlag

		self.run_task = asyncio.current_task()
		self.emit(event="log", text=f"hub status before run: {self._describe_status()}")

		self.emit(event="program", status="started", path=path)

		loop = asyncio.get_running_loop()
		started_event = asyncio.Event()
		state = {"running": False, "baseline": None}

		def on_status(flags):
			# status_observable is a BehaviorSubject: subscribing replays whatever
			# the flag is right now. That value describes the state BEFORE this run,
			# so it is only a baseline. Treating it as "the program started" would
			# report a running program before anything was uploaded and would skip
			# the transfer budget below. Only a clear -> set transition counts.
			is_running = bool(int(flags) & StatusFlag.USER_PROGRAM_RUNNING)
			if state["baseline"] is None:
				state["baseline"] = is_running
				return
			if is_running and not state["baseline"] and not state["running"]:
				state["running"] = True
				self.emit(event="program", status="running", path=path)
				loop.call_soon_threadsafe(started_event.set)
			state["baseline"] = is_running

		subscription = self.hub.status_observable.subscribe(on_status)
		try:
			await self._run_with_start_budget(
				path, started_event, float(msg.get("timeout") or START_TIMEOUT)
			)
		except Exception as e:
			# The hub rejects a program download while a program is running.
			text = str(e)
			if "0x81" in text or "Application-specific" in text:
				raise RuntimeError(
					"the hub refused the program download, which normally means a "
					"program is still running on it. Press Stop, then Run again."
				) from e
			raise
		finally:
			try:
				subscription.dispose()
			except Exception:  # noqa: BLE001
				pass
			self.emit(event="program", status="finished", started=state["running"])

	async def _run_with_start_budget(self, path, started_event, start_timeout):
		"""Run a program, bounding only the transfer.

		Once the hub reports the program actually running the call waits as long as
		the program takes. If it never starts, fail rather than block forever.
		"""
		run_task = asyncio.create_task(self.hub.run(path, wait=True, print_output=False))
		wait_started = asyncio.create_task(started_event.wait())

		done, _ = await asyncio.wait(
			{run_task, wait_started},
			timeout=start_timeout,
			return_when=asyncio.FIRST_COMPLETED,
		)
		wait_started.cancel()

		if run_task in done or started_event.is_set():
			return await run_task

		run_task.cancel()
		try:
			await run_task
		except (asyncio.CancelledError, Exception):  # noqa: BLE001
			pass

		raise RuntimeError(
			f"the hub did not start the program within {start_timeout:g}s. Every write "
			"pybricksdev makes waits for a response from the hub, and the hub sometimes "
			"never sends one (pybricks/support#1145). Press Stop, or disconnect and "
			"reconnect the hub."
		)

	async def cmd_stop(self, msg):
		if self.hub is None:
			raise RuntimeError("not connected")
		await self._bounded(self.hub.stop_user_program(), WRITE_TIMEOUT, "the stop command")

	async def cmd_status(self, msg):
		self.emit(
			event="status",
			connected=self.hub is not None,
			name=self.device_name,
			flags=self._status_flags(),
			status_seen=self._status_seen,
			running_program=getattr(self.hub, "_running_program", None) if self.hub else None,
			selected_slot=getattr(self.hub, "_selected_slot", None) if self.hub else None,
		)

	async def cmd_disconnect(self, msg):
		if self.hub is None:
			return
		hub, self.hub = self.hub, None
		self._dispose_subscriptions()
		try:
			await asyncio.wait_for(hub.disconnect(), DISCONNECT_TIMEOUT)
		except asyncio.TimeoutError:
			# Upstream reports bleak getting stuck in disconnect. The link is gone
			# from our point of view either way.
			self.emit(event="log", text=f"disconnect did not complete within {DISCONNECT_TIMEOUT:g}s")
		self.emit(event="state", state="disconnected", reason="requested")

	# -- dispatch ----------------------------------------------------------

	async def dispatch(self, msg):
		handler = getattr(self, "cmd_" + str(msg.get("cmd")), None)
		if handler is None:
			self.emit(event="result", id=msg.get("id"), ok=False,
			          error=f"unknown command: {msg.get('cmd')}")
			return
		try:
			await handler(msg)
			self.emit(event="result", id=msg.get("id"), ok=True)
		except Exception as e:  # noqa: BLE001 - reported to the extension verbatim
			# Some exceptions (notably bleak's TimeoutError) carry no message.
			detail = str(e).strip()
			self.emit(event="result", id=msg.get("id"), ok=False,
			          error=f"{type(e).__name__}: {detail}" if detail else type(e).__name__)

	async def serve(self):
		self.emit(event="ready")
		tasks = set()
		while True:
			# to_thread keeps this portable; asyncio pipe readers do not support
			# stdin on Windows proactor loops.
			line = await asyncio.to_thread(sys.stdin.readline)
			if not line:
				break
			line = line.strip()
			if not line:
				continue

			try:
				msg = json.loads(line)
			except ValueError:
				self.emit(event="result", id=None, ok=False, error="malformed JSON command")
				continue

			if msg.get("cmd") == "shutdown":
				self.emit(event="result", id=msg.get("id"), ok=True)
				break

			task = asyncio.create_task(self.dispatch(msg))
			tasks.add(task)
			task.add_done_callback(tasks.discard)

		await self.cleanup()

	async def cleanup(self):
		if self.hub is not None:
			try:
				await self.cmd_disconnect({})
			except Exception:  # noqa: BLE001
				pass


def main():
	agent = Agent()
	try:
		asyncio.run(agent.serve())
	except ImportError as e:
		agent.emit(event="fatal", error=f"pybricksdev is not available: {e}")
		return 1
	except KeyboardInterrupt:
		pass
	return 0


if __name__ == "__main__":
	sys.exit(main())
