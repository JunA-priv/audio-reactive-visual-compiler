#!/usr/bin/env python3
"""Temporary TCP relay for the isolated SCNet Docker validation container.

Run inside that container's network namespace. It binds only to 127.0.0.1:54321
and forwards bytes unchanged to host.docker.internal:54321. It never logs payloads.
"""

from __future__ import annotations

import os
import signal
import socket
import threading
from pathlib import Path

LISTEN = ("127.0.0.1", 54321)
UPSTREAM = ("host.docker.internal", 54321)
PID_FILE = Path("/tmp/arvc-scnet-auth-relay.pid")
ERROR_FILE = Path("/tmp/arvc-scnet-auth-relay.error")
stop_event = threading.Event()
relay_failed = False


def relay(client: socket.socket) -> None:
    global relay_failed
    try:
        upstream = socket.create_connection(UPSTREAM, timeout=5)
    except OSError:
        client.close()
        relay_failed = True
        ERROR_FILE.write_text("upstream connection failed\n", encoding="ascii")
        stop_event.set()
        return
    client.settimeout(None)
    upstream.settimeout(None)

    def pump(source: socket.socket, destination: socket.socket) -> None:
        try:
            while not stop_event.is_set():
                payload = source.recv(65536)
                if not payload:
                    break
                destination.sendall(payload)
        except OSError:
            pass
        finally:
            try:
                destination.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    forward = threading.Thread(target=pump, args=(client, upstream), daemon=True)
    reverse = threading.Thread(target=pump, args=(upstream, client), daemon=True)
    forward.start()
    reverse.start()
    try:
        forward.join()
        reverse.join()
    finally:
        client.close()
        upstream.close()


def stop(_signum: int, _frame: object) -> None:
    stop_event.set()


def main() -> int:
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(LISTEN)
        listener.listen(8)
        listener.settimeout(0.5)
    except OSError:
        print("SCNet Auth relay failed to bind 127.0.0.1:54321", flush=True)
        return 1

    PID_FILE.write_text(f"{os.getpid()}\n", encoding="ascii")
    ERROR_FILE.unlink(missing_ok=True)
    workers: list[threading.Thread] = []
    try:
        while not stop_event.is_set():
            try:
                client, _ = listener.accept()
            except TimeoutError:
                continue
            except OSError:
                if stop_event.is_set():
                    break
                print("SCNet Auth relay accept failed", flush=True)
                return 1
            worker = threading.Thread(target=relay, args=(client,), daemon=True)
            workers.append(worker)
            worker.start()
    finally:
        listener.close()
        for worker in workers:
            worker.join(timeout=1)
        PID_FILE.unlink(missing_ok=True)
    return 1 if relay_failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
