#!/usr/bin/env python3
"""Scan for nearby Pybricks / LEGO Powered Up hubs and print them as JSON.

Used by the Pybricks Runner VS Code extension. Depends only on ``bleak``, which
is already a dependency of ``pybricksdev``, so the extension's virtualenv needs
no extra packages.

On success a single JSON object is written to stdout::

    {"devices": [{"name": ..., "address": ..., "rssi": ..., "kind": ...}, ...]}

On failure::

    {"error": "..."}
"""

import argparse
import asyncio
import json
import sys

PYBRICKS_SERVICE_UUID = "c5f50001-8280-46da-89f4-6d8051e4aeef"
LWP3_HUB_SERVICE_UUID = "00001623-1212-efde-1623-785feabcd123"

KIND_ORDER = {"pybricks": 0, "lwp3": 1, "other": 2}


def classify(uuids):
	lowered = {str(u).lower() for u in (uuids or [])}
	if PYBRICKS_SERVICE_UUID in lowered:
		return "pybricks"
	if LWP3_HUB_SERVICE_UUID in lowered:
		return "lwp3"
	return "other"


async def scan(timeout, include_all):
	from bleak import BleakScanner

	try:
		discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
		entries = list(discovered.values())
	except TypeError:
		# bleak < 0.20 has no return_adv keyword.
		entries = [(d, None) for d in await BleakScanner.discover(timeout=timeout)]

	devices = {}
	for device, adv in entries:
		uuids = getattr(adv, "service_uuids", None)
		if not uuids:
			metadata = getattr(device, "metadata", None) or {}
			uuids = metadata.get("uuids") or []

		kind = classify(uuids)
		if kind == "other" and not include_all:
			continue

		name = (getattr(adv, "local_name", None) or device.name or "").strip()
		if not name:
			continue

		rssi = getattr(adv, "rssi", None)
		if rssi is None:
			rssi = getattr(device, "rssi", None)

		# A hub can advertise more than once; keep the strongest sighting.
		previous = devices.get(name)
		if previous is not None and (previous["rssi"] or -999) >= (rssi or -999):
			continue

		devices[name] = {
			"name": name,
			"address": device.address,
			"rssi": rssi,
			"kind": kind,
		}

	return sorted(
		devices.values(),
		key=lambda d: (KIND_ORDER[d["kind"]], -(d["rssi"] or -999), d["name"].lower()),
	)


def main():
	parser = argparse.ArgumentParser(description="Scan for nearby LEGO hubs.")
	parser.add_argument("--timeout", type=float, default=5.0, help="scan duration in seconds")
	parser.add_argument("--all", action="store_true", help="also report BLE devices that are not LEGO hubs")
	args = parser.parse_args()

	try:
		devices = asyncio.run(scan(args.timeout, args.all))
	except ImportError:
		print(json.dumps({"error": "The 'bleak' package is not available. Install pybricksdev (pip install pybricksdev)."}))
		return 1
	except Exception as e:  # noqa: BLE001 - reported verbatim to the extension
		print(json.dumps({"error": "{}: {}".format(type(e).__name__, e)}))
		return 1

	print(json.dumps({"devices": devices}))
	return 0


if __name__ == "__main__":
	sys.exit(main())
