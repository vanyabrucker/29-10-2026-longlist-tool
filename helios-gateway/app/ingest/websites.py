"""Which website domains of an import still exist, by a DNS lookup.

Large business lists carry many dead websites (a domain nobody renewed, a
typo, a host that never existed). While the report is built, every distinct
domain is resolved with the standard library (`socket.getaddrinfo` in a
thread pool), first as it is, then as `www.<domain>`. Only a definite answer
that the name doesn't exist counts as dead; a timeout or network error is
"couldn't check", so a hiccup never marks a real site dead.

Nothing is dropped here: the report flags the value, lowers its score and the
reviewer decides.
"""

import socket
import threading
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed

OK, DEAD, UNKNOWN = "ok", "dead", "unknown"

# The resolver's answers that mean "this name has no address": it doesn't
# exist (NXDOMAIN), or exists without any address record. EAI_NODATA isn't
# defined on every platform (macOS reports both as EAI_NONAME).
_MISSING = {socket.EAI_NONAME} | (
    {socket.EAI_NODATA} if hasattr(socket, "EAI_NODATA") else set())

# Resolves a host or raises: socket.gaierror for a lookup failure, anything
# else for a network problem.
Resolver = Callable[[str], object]


def system_resolver(host: str) -> object:
    return socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)


def _lookup(host: str, resolver: Resolver, timeout: float) -> str:
    """OK, DEAD (the name has no address) or UNKNOWN (no answer in time, or
    any other error). getaddrinfo has no timeout of its own, so it runs in a
    daemon thread that is left behind if it takes too long."""
    result: list[str] = []

    def run() -> None:
        try:
            resolver(host)
            result.append(OK)
        except socket.gaierror as e:
            result.append(DEAD if e.errno in _MISSING else UNKNOWN)
        except Exception:  # noqa: BLE001 - any other failure only means we couldn't check
            result.append(UNKNOWN)

    t = threading.Thread(target=run, daemon=True, name=f"dns-{host}")
    t.start()
    t.join(timeout)
    return result[0] if result else UNKNOWN


def classify(domain: str, resolver: Resolver, timeout: float) -> str:
    """The domain, then www.<domain>: alive if either resolves, dead only if
    both definitely don't exist."""
    first = _lookup(domain, resolver, timeout)
    if first == OK:
        return OK
    second = _lookup(f"www.{domain}", resolver, timeout)
    if second == OK:
        return OK
    return DEAD if first == second == DEAD else UNKNOWN


def check(domains: Iterable[str], *, workers: int, timeout: float,
          resolver: Resolver = system_resolver,
          progress: Callable[[int, int], None] | None = None) -> dict[str, str]:
    """{domain: OK | DEAD | UNKNOWN} for each distinct domain, `progress(done,
    total)` as lookups finish."""
    todo = sorted(set(domains))
    out: dict[str, str] = {}
    if not todo:
        return out
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="website-check") as pool:
        futures = {pool.submit(classify, d, resolver, timeout): d for d in todo}
        for n, future in enumerate(as_completed(futures), 1):
            out[futures[future]] = future.result()
            if progress:
                progress(n, len(todo))
    return out
