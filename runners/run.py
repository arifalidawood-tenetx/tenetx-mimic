"""runners/run.py - interactive dev-server runner.

Frees TCP ports (default 8998 backend / 6116 frontend) of any LISTENing
process, then launches `bun run dev -- --port <p> --strictPort` for the
frontend (tenetx-mimic, repo root) and `<repo_root>/tenetx-mimic-backend/.venv`'s
`uvicorn app.main:app` for the backend (tenetx-mimic-backend, a FastAPI service
since the mimic-backend-python-migration - no `package.json`/`bun` there
anymore), streaming both services' output live via `rich` while also
persisting each service's full output to a timestamped log file under
runners/logs/. The backend's dedicated venv is bootstrapped by run.ps1
(mirroring this script's own runners/.venv - kept separate so the tool's own
rich+psutil deps never mix with the app's fastapi/uvicorn/python3-saml deps).
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import psutil
from rich.console import Console

from env_file import parse_env_file

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "tenetx-mimic-backend"
BACKEND_VENV_PYTHON = BACKEND_DIR / ".venv" / "Scripts" / "python.exe"
LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)  # module-level so Part B is testable standalone

DEFAULT_BACKEND_PORT = 8998
DEFAULT_FRONTEND_PORT = 6116
ROLLING_BUFFER_MAXLEN = 200

SERVICE_COLORS = {"backend": "cyan", "frontend": "magenta"}
ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def parse_args(argv: "list[str] | None" = None) -> argparse.Namespace:
    """Parse CLI args: --backend-port, --frontend-port, --skip-kill."""
    parser = argparse.ArgumentParser(description="Free dev ports and run both services with live logging.")
    parser.add_argument("--backend-port", type=int, default=DEFAULT_BACKEND_PORT)
    parser.add_argument("--frontend-port", type=int, default=DEFAULT_FRONTEND_PORT)
    parser.add_argument("--skip-kill", action="store_true", help="Skip the port-freeing step.")
    return parser.parse_args(argv)


def free_port(port: int, label: str, console: Console) -> None:
    """Force-kill (taskkill /F /T) whatever holds `port` LISTENing, excluding
    this process's own PID. Raises RuntimeError if still bound after retries."""
    my_pid = os.getpid()
    pids: "set[int]" = set()
    for conn in psutil.net_connections(kind="tcp"):
        if conn.laddr and conn.laddr.port == port and conn.status == psutil.CONN_LISTEN:
            if conn.pid and conn.pid != my_pid:
                pids.add(conn.pid)

    if not pids:
        console.print(f"[green][{label}][/green] port {port}: nothing listening, already free.")
        return

    for pid in pids:
        try:
            proc_name = psutil.Process(pid).name()
        except psutil.NoSuchProcess:
            proc_name = "<gone>"
        console.print(f"[yellow][{label}][/yellow] port {port}: killing PID {pid} ({proc_name}) via taskkill /F /T ...")
        result = subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0 and "not found" not in (result.stderr or "").lower():
            console.print(f"[red][{label}][/red] taskkill PID {pid} failed (exit {result.returncode}): {(result.stderr or '').strip()}")

    for _ in range(5):
        time.sleep(0.2)
        still_bound = any(
            c.laddr and c.laddr.port == port and c.status == psutil.CONN_LISTEN
            for c in psutil.net_connections(kind="tcp")
        )
        if not still_bound:
            console.print(f"[green][{label}][/green] port {port}: confirmed free.")
            return

    raise RuntimeError(f"Failed to free port {port}: a process is still LISTENing after taskkill + retries.")


import queue
import threading
from collections import deque
from typing import IO

from rich.console import Group
from rich.table import Table
from rich.text import Text


def start_service(
    name: str, cmd: "list[str]", cwd: Path, log_path: Path, env: "dict[str, str] | None" = None
) -> "tuple[subprocess.Popen, IO[str]]":
    """Spawn `cmd` in `cwd`, merging stderr into stdout, and open `log_path`
    for line-buffered UTF-8 writes. Children get their own Windows process
    group so a Ctrl+C at the console does not reach them directly - only
    this script's own shutdown logic decides their fate. `env` (when given)
    fully replaces the inherited environment - callers must merge `os.environ`
    into it themselves if they only want to override/add a few keys."""
    log_file = open(log_path, "w", encoding="utf-8", errors="replace", buffering=1)
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    proc = subprocess.Popen(
        cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        creationflags=creationflags, env=env,
    )
    return proc, log_file


def stream_reader(name: str, proc: subprocess.Popen, log_file: IO[str], line_queue: "queue.Queue") -> None:
    """Read `proc`'s merged stdout line by line, strip ANSI escapes, write
    each line to `log_file`, and push (name, line) onto `line_queue`."""
    assert proc.stdout is not None
    for raw_line in proc.stdout:
        line = ANSI_ESCAPE_RE.sub("", raw_line.rstrip("\n"))
        log_file.write(line + "\n")
        log_file.flush()
        line_queue.put((name, line))


def build_status_table(services: "dict[str, dict]") -> Table:
    """Render a rich Table of service/PID/port/state/uptime."""
    table = Table(title="Services")
    table.add_column("Service")
    table.add_column("PID")
    table.add_column("Port")
    table.add_column("State")
    table.add_column("Uptime")
    for name, info in services.items():
        uptime = str(dt.timedelta(seconds=int(time.time() - info["started_at"])))
        table.add_row(
            Text(name.upper(), style=SERVICE_COLORS.get(name, "white")),
            str(info["pid"]), str(info["port"]), info["state"], uptime,
        )
    return table


def handle_service_exit(crashed_name: str, other_proc: subprocess.Popen, other_log_path: Path, console: Console) -> int:
    """Kill the surviving `other_proc` (full tree) and print the crashed
    service's log tail (last 20 lines). Always returns 1 (a crash)."""
    console.print(f"[red bold]{crashed_name} exited unexpectedly.[/red bold]")
    try:
        tail = other_log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-20:]
    except OSError:
        tail = []
    for line in tail:
        console.print(f"  {line}")
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(other_proc.pid)], capture_output=True, text=True)
    return 1


from rich.live import Live


def main(argv: "list[str] | None" = None) -> int:
    """Free dev ports, spawn both services, stream live dashboard, handle
    graceful Ctrl+C shutdown and unexpected service crashes. Returns 0 on
    clean exit, 1 on startup failure or crash detection."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args(argv)
    console = Console()

    bun_exe = shutil.which("bun")
    if bun_exe is None:
        console.print("[red bold]'bun' was not found on PATH. Install it: https://bun.sh[/red bold]")
        return 1

    if not BACKEND_VENV_PYTHON.exists():
        console.print(
            f"[red bold]Backend venv not found at '{BACKEND_VENV_PYTHON}'.[/red bold]\n"
            "[red]Run via runners/run.ps1 (it bootstraps this venv automatically), "
            "or create it manually: "
            f"uv venv \"{BACKEND_DIR / '.venv'}\" --python 3.12 && "
            f"uv pip install --python \"{BACKEND_VENV_PYTHON}\" -r \"{BACKEND_DIR / 'requirements.txt'}\"[/red]"
        )
        return 1

    if not args.skip_kill:
        free_port(args.backend_port, "backend", console)
        free_port(args.frontend_port, "frontend", console)

    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backend_log_path = LOG_DIR / f"backend-{timestamp}.log"
    frontend_log_path = LOG_DIR / f"frontend-{timestamp}.log"

    backend_cmd = [
        str(BACKEND_VENV_PYTHON), "-m", "uvicorn", "app.main:app",
        "--host", "127.0.0.1", "--port", str(args.backend_port),
    ]
    frontend_cmd = [bun_exe, "run", "dev", "--", "--port", str(args.frontend_port), "--strictPort"]

    # Load .env.local (Keycloak + GCP WIF env) with non-clobber: process env wins.
    # Keycloak: KEYCLOAK_TOKEN_URL, KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET
    # GCP WIF: GCP_WIF_AUDIENCE, GCP_WIF_STS_TOKEN_URL, GCP_WIF_SERVICE_ACCOUNT_IMPERSONATION_URL,
    #          GCP_WIF_SUBJECT_TOKEN_TYPE, GCP_WIF_CREDENTIAL_CONFIG, GOOGLE_APPLICATION_CREDENTIALS
    # Project: GCP_PROJECT_ID, FIREBASE_PROJECT_ID (optional)
    # Never log secret values.
    env_file_path = REPO_ROOT / ".env.local"
    env_file_vars = {}
    if env_file_path.exists():
        env_file_vars = parse_env_file(env_file_path)
    
    # Non-clobber: only inject from .env.local if process env is unset.
    keys_to_inject = {
        "KEYCLOAK_TOKEN_URL",
        "KEYCLOAK_ISSUER",
        "KEYCLOAK_CLIENT_ID",
        "KEYCLOAK_CLIENT_SECRET",
        "GCP_WIF_AUDIENCE",
        "GCP_WIF_STS_TOKEN_URL",
        "GCP_WIF_SERVICE_ACCOUNT_IMPERSONATION_URL",
        "GCP_WIF_SUBJECT_TOKEN_TYPE",
        "GCP_WIF_CREDENTIAL_CONFIG",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GCP_PROJECT_ID",
        "FIREBASE_PROJECT_ID",
        "MIMIC_STATUS_SECRET",
    }
    
    merged_env = {}
    for key in keys_to_inject:
        if key in os.environ and os.environ[key]:
            merged_env[key] = os.environ[key]
        elif key in env_file_vars:
            merged_env[key] = env_file_vars[key]
    
    # app/main.py's CORSMiddleware allowlists ONLY os.environ["ALLOWED_ORIGIN"] (default: the
    # deployed prod Hosting origin) - override it to the frontend's own local origin so the
    # browser's fetch()es from the Vite dev server aren't silently CORS-rejected. This does NOT
    # touch backend source or its (intentionally still-missing) dotenv loading - it is just the
    # env this runner launches uvicorn with.
    #
    # MIMIC_STATUS_SECRET: app/status_token.py logs a WARNING at import when this is unset,
    # falling back to a forgeable dev-only secret. Inject a stable local value so dev runs are
    # quiet AND status tokens stay valid across restarts - but only when the caller hasn't
    # already exported a real secret (never clobber one). `or` also catches a blank value,
    # mirroring the backend's own `_status_secret or DEV_ONLY_SECRET` fallback. Same scope as
    # ALLOWED_ORIGIN above: launcher env only, no backend source change.
    backend_env = {
        **os.environ,
        **merged_env,
        "ALLOWED_ORIGIN": f"http://localhost:{args.frontend_port}",
        "MIMIC_STATUS_SECRET": merged_env.get("MIMIC_STATUS_SECRET") or "tenetx-mimic-dev-runner-secret",
    }

    try:
        backend_proc, backend_file = start_service(
            "backend", backend_cmd, BACKEND_DIR, backend_log_path, env=backend_env
        )
        frontend_proc, frontend_file = start_service("frontend", frontend_cmd, REPO_ROOT, frontend_log_path)
    except OSError as exc:
        console.print(f"[red bold]Failed to start a service: {exc}[/red bold]")
        return 1

    line_queue: "queue.Queue" = queue.Queue()
    threads = [
        threading.Thread(target=stream_reader, args=("backend", backend_proc, backend_file, line_queue), daemon=True),
        threading.Thread(target=stream_reader, args=("frontend", frontend_proc, frontend_file, line_queue), daemon=True),
    ]
    for t in threads:
        t.start()

    services = {
        "backend": {"pid": backend_proc.pid, "port": args.backend_port, "state": "running", "started_at": time.time()},
        "frontend": {"pid": frontend_proc.pid, "port": args.frontend_port, "state": "running", "started_at": time.time()},
    }
    rolling_lines: "deque" = deque(maxlen=ROLLING_BUFFER_MAXLEN)
    shutting_down = False
    exit_code = 0

    try:
        with Live(console=console, refresh_per_second=4) as live:
            while True:
                try:
                    name, line = line_queue.get(timeout=0.25)
                    rolling_lines.append((name, line))
                except queue.Empty:
                    pass

                if backend_proc.poll() is not None or frontend_proc.poll() is not None:
                    break

                body = Text("\n").join(
                    Text(f"[{n.upper()}] ", style=SERVICE_COLORS.get(n, "white")) + Text(l)
                    for n, l in rolling_lines
                )
                live.update(Group(build_status_table(services), body))
    except KeyboardInterrupt:
        shutting_down = True
        console.print("\n[cyan]Shutting down both services ...[/cyan]")
        for proc in (backend_proc, frontend_proc):
            if proc.poll() is None:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, text=True)
        exit_code = 0
    finally:
        backend_file.close()
        frontend_file.close()

    if not shutting_down:
        if backend_proc.poll() is not None and frontend_proc.poll() is None:
            exit_code = handle_service_exit("backend", frontend_proc, frontend_log_path, console)
        elif frontend_proc.poll() is not None and backend_proc.poll() is None:
            exit_code = handle_service_exit("frontend", backend_proc, backend_log_path, console)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
