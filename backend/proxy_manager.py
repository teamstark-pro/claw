import logging
import urllib.parse
import requests
from collections import defaultdict
from typing import Optional, List, Tuple

log = logging.getLogger("ProxyManager")

def _mask_proxy(proxy_url: str) -> str:
    """Mask password in proxy URL for safe logging/display."""
    if not proxy_url:
        return ""
    try:
        p = urllib.parse.urlparse(proxy_url)
        if p.password:
            return proxy_url.replace(p.password, "****")
    except Exception:
        pass
    return proxy_url[:40] + ("..." if len(proxy_url) > 40 else "")

def _parse_proxy_url(proxy_url: str) -> Tuple[bool, str]:
    """
    Validate a proxy URL.
    Returns (is_valid, error_message).
    """
    try:
        p = urllib.parse.urlparse(proxy_url)
        if p.scheme not in ("http", "https", "socks5", "socks4"):
            return False, (
                f"Unsupported scheme '{p.scheme}'.\n"
                f"Use: http://, https://, socks5://, or socks4://"
            )
        if not p.hostname:
            return False, "Missing hostname in proxy URL"
        if not p.port:
            return False, "Missing port in proxy URL"
        return True, ""
    except Exception as e:
        return False, str(e)

def _test_proxy(proxy_url: str) -> Tuple[bool, str, str]:
    """
    Test proxy by fetching exit IP from api.ipify.org.
    Returns (success, ip_address, error_message).
    """
    try:
        s = requests.Session()
        if proxy_url:
            s.proxies = {"http": proxy_url, "https": proxy_url}
        r = s.get("https://api.ipify.org?format=json", timeout=10)
        r.raise_for_status()
        ip = r.json().get("ip", "unknown")
        return True, ip, ""
    except requests.exceptions.ProxyError as e:
        return False, "", f"Proxy unreachable: {e}"
    except requests.exceptions.Timeout:
        return False, "", "Timeout — proxy too slow or offline"
    except Exception as e:
        return False, "", str(e)

class ProxyPool:
    """
    Manages a rotating pool of proxies.
    - Automatically rotates to next on failure
    - Tracks fail counts per proxy
    - Removes permanently dead proxies after MAX_FAILS failures
    """
    MAX_FAILS = 3

    def __init__(self, proxies: List[str] = None):
        self._proxies   : List[str] = list(proxies or [])
        self._index     : int       = 0
        self._fails     : dict      = defaultdict(int)

    @property
    def count(self) -> int:
        return len(self._proxies)

    @property
    def active(self) -> str:
        """Return the current active proxy URL, or '' if pool is empty."""
        if not self._proxies:
            return ""
        self._index = self._index % len(self._proxies)
        return self._proxies[self._index]

    @property
    def active_index(self) -> int:
        """1-based index of active proxy (for display)."""
        if not self._proxies:
            return 0
        return (self._index % len(self._proxies)) + 1

    def all_proxies(self) -> List[dict]:
        """Return list of proxy info dicts."""
        return [
            {
                "id": i + 1,
                "url": _mask_proxy(url),
                "fails": self._fails.get(url, 0),
                "is_active": (i + 1) == self.active_index
            }
            for i, url in enumerate(self._proxies)
        ]

    def add(self, proxy_url: str) -> bool:
        """Add a proxy. Returns False if already in pool."""
        if proxy_url in self._proxies:
            return False
        self._proxies.append(proxy_url)
        log.info(f"Proxy added to pool: {_mask_proxy(proxy_url)}")
        return True

    def remove(self, index_1based: int) -> Optional[str]:
        """Remove proxy by 1-based index. Returns removed URL or None."""
        idx = index_1based - 1
        if idx < 0 or idx >= len(self._proxies):
            return None
        removed = self._proxies.pop(idx)
        self._fails.pop(removed, None)
        if self._proxies:
            self._index = self._index % len(self._proxies)
        else:
            self._index = 0
        log.info(f"Proxy removed: {_mask_proxy(removed)}")
        return removed

    def clear(self):
        """Remove all proxies."""
        self._proxies.clear()
        self._fails.clear()
        self._index = 0
        log.info("Proxy pool cleared")

    def rotate(self) -> str:
        """Move to next proxy. Returns new active proxy URL."""
        if len(self._proxies) <= 1:
            return self.active
        self._index = (self._index + 1) % len(self._proxies)
        log.info(f"Rotated to proxy #{self.active_index}: {_mask_proxy(self.active)}")
        return self.active

    def mark_failed(self, proxy_url: str) -> bool:
        """
        Mark a proxy as failed. Auto-removes after MAX_FAILS.
        Returns True if proxy was removed from pool.
        """
        if proxy_url not in self._proxies:
            return False
        self._fails[proxy_url] += 1
        fails = self._fails[proxy_url]
        log.warning(f"Proxy fail #{fails}/{self.MAX_FAILS}: {_mask_proxy(proxy_url)}")
        if fails >= self.MAX_FAILS:
            idx = self._proxies.index(proxy_url)
            self._proxies.pop(idx)
            self._fails.pop(proxy_url, None)
            if self._proxies:
                self._index = self._index % len(self._proxies)
            else:
                self._index = 0
            log.warning(f"Proxy permanently removed (too many failures): {_mask_proxy(proxy_url)}")
            return True
        if len(self._proxies) > 1:
            self.rotate()
        return False

    def mark_success(self, proxy_url: str):
        """Reset fail count on success."""
        if proxy_url in self._fails:
            self._fails[proxy_url] = 0

    def as_requests_dict(self) -> dict:
        """Return proxies dict for requests, or {} if no proxies."""
        url = self.active
        if not url:
            return {}
        return {"http": url, "https": url}
