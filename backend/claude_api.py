import json
import uuid
import logging
import time
import threading
from typing import Optional, List, Dict, Any, Generator
from dataclasses import dataclass, field
from curl_cffi import requests
from proxy_manager import ProxyPool

log = logging.getLogger("ClaudeAPI")

BASE_URL = "https://claude.ai/api"
DEFAULT_MODEL = "claude-sonnet-4-20250514"
RETRY_MAX = 3
RETRY_DELAY = 30

@dataclass
class UserSession:
    session_key     : str        = ""
    organization_id : str        = ""
    conversation_id : str        = ""
    model           : str        = DEFAULT_MODEL
    tracked_convs   : list       = field(default_factory=list)
    http            : requests.Session = field(default_factory=lambda: requests.Session(impersonate="chrome"))
    incognito       : bool       = True
    web_search      : bool       = False
    busy            : bool       = False
    account_pool    : List[Dict] = field(default_factory=list)
    pool_index      : int        = 0
    proxy_pool      : ProxyPool  = field(default_factory=lambda: ProxyPool([]))
    _lock           : threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self):
        self._apply_headers()
        self._sync_proxy()

    def _apply_headers(self):
        # Apply EXACT working headers from bot (1).py
        self.http.headers.update({
            "User-Agent"            : (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept"                : "*/*",
            "Accept-Language"       : "en-US,en;q=0.9",
            "Accept-Encoding"       : "gzip, deflate, br",
            "Content-Type"          : "application/json",
            "Origin"                : "https://claude.ai",
            "Referer"               : "https://claude.ai/chats",
            "Sec-Ch-Ua"             : '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "Sec-Ch-Ua-Mobile"      : "?0",
            "Sec-Ch-Ua-Platform"    : '"Windows"',
            "Sec-Fetch-Dest"        : "empty",
            "Sec-Fetch-Mode"        : "cors",
            "Sec-Fetch-Site"        : "same-origin",
        })

    def _sync_proxy(self):
        """Sync curl_cffi.Session proxies from the pool's active proxy."""
        url = self.proxy_pool.active
        if url:
            self.http.proxies = {"http": url, "https": url}
        else:
            self.http.proxies = {}

    def rotate_proxy(self) -> str:
        """Rotate to next proxy and sync session."""
        url = self.proxy_pool.rotate()
        self._sync_proxy()
        return url

    def rotate_account(self) -> bool:
        """Switch to next working account in the pool."""
        if not self.account_pool:
            return False
        
        self.pool_index = (self.pool_index + 1) % len(self.account_pool)
        acc = self.account_pool[self.pool_index]
        
        log.info(f"🔄 Rotating to next pool account: {acc.get('email')}")
        
        # 1. Update Proxy
        self.proxy_pool.clear()
        if acc.get("proxy"):
            self.proxy_pool.add(acc["proxy"])
        self._sync_proxy()
        
        # 2. Update Key
        self.set_key(acc["key"])
        
        # 3. Get Org ID (Validate)
        valid, org_id, info = validate_key(acc["key"], proxy_url=acc.get("proxy"))
        if valid:
            self.organization_id = org_id
            self.conversation_id = "" # Fresh start
            return True
        else:
            log.warning(f"Rotation account {acc.get('email')} failed validation: {info}")
            # Try next one
            return self.rotate_account()

    def set_key(self, key: str):
        self.session_key = key
        self.http.cookies.clear()
        self.http.cookies.set(
            name   = "sessionKey",
            value  = key,
            domain = ".claude.ai",
            path   = "/",
            secure = True,
        )
        log.debug(f"Session key set: {key[:20]}...")

def validate_key(session_key: str, proxy_url: str = "") -> tuple[bool, str, str]:
    """
    Validate a Claude session key.
    Returns (is_valid, org_id, org_name_or_error).
    """
    session_key = session_key.strip()
    
    s = requests.Session(impersonate="chrome")
    s.headers.update({
        "User-Agent"            : (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept"                : "*/*",
        "Accept-Language"       : "en-US,en;q=0.9",
        "Accept-Encoding"       : "gzip, deflate, br",
        "Content-Type"          : "application/json",
        "Origin"                : "https://claude.ai",
        "Referer"               : "https://claude.ai/chats",
        "Sec-Ch-Ua"             : '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "Sec-Ch-Ua-Mobile"      : "?0",
        "Sec-Ch-Ua-Platform"    : '"Windows"',
        "Sec-Fetch-Dest"        : "empty",
        "Sec-Fetch-Mode"        : "cors",
        "Sec-Fetch-Site"        : "same-origin",
    })
    s.cookies.set("sessionKey", session_key, domain=".claude.ai", path="/", secure=True)
    if proxy_url:
        s.proxies = {"http": proxy_url, "https": proxy_url}

    try:
        resp = s.get(f"{BASE_URL}/organizations", timeout=15)
        log.info(f"Validation step 1 (orgs) status: {resp.status_code}")



        if resp.status_code == 403:
            log.error(f"403 Forbidden on /organizations. Body: {resp.text[:200]}")
            return False, "", "Expired/Invalid key — or IP blocked by Claude (403)"
        if resp.status_code == 401:
            return False, "", "Unauthorized / Invalid Key (401)"

        resp.raise_for_status()
        orgs = resp.json()
        
        if not orgs:
            return False, "", "No organizations found on this account"

        org_name = orgs[0].get("name", "Unknown Org")
        org_id   = orgs[0]["uuid"]

        log.info(f"Step 2: Testing chat creation for org {org_id}")
        conv_resp = s.post(
            f"{BASE_URL}/organizations/{org_id}/chat_conversations",
            json    = {"uuid": str(uuid.uuid4()), "name": "", "model": DEFAULT_MODEL},
            timeout = 15,
        )
        log.info(f"Validation step 2 (chat) status: {conv_resp.status_code}")

        if conv_resp.status_code == 403:
            log.error(f"403 Forbidden on chat creation. Body: {conv_resp.text[:200]}")
            return False, "", "Key valid for auth but blocked for chat (403) — Your IP is likely flagged."

        if conv_resp.status_code not in (200, 201):
            return False, "", f"Cannot create conversations (HTTP {conv_resp.status_code})"

        test_id = conv_resp.json().get("uuid")
        if test_id:
            try:
                s.delete(f"{BASE_URL}/organizations/{org_id}/chat_conversations/{test_id}", timeout=5)
            except Exception:
                pass

        log.info(f"Key validated ✓ Org: {org_name}")
        return True, org_id, org_name

    except Exception as e:
        return False, "", str(e)

def create_conversation(us: UserSession) -> str:
    """Create a new blank conversation."""
    url = f"{BASE_URL}/organizations/{us.organization_id}/chat_conversations"
    resp = us.http.post(
        url,
        json    = {"uuid": str(uuid.uuid4()), "name": "", "model": us.model},
        timeout = 15,
    )
    if resp.status_code == 403:
        log.error(f"403 Forbidden on create_conversation. Body: {resp.text[:200]}")
    resp.raise_for_status()
    cid = resp.json()["uuid"]
    us.conversation_id = cid
    us.tracked_convs.append(cid)
    log.info(f"Created conversation: {cid[:12]}...")
    return cid

def delete_conversation(us: UserSession, conv_id: str) -> bool:
    """Silently delete a conversation."""
    try:
        r = us.http.delete(
            f"{BASE_URL}/organizations/{us.organization_id}/chat_conversations/{conv_id}",
            timeout=10,
        )
        if conv_id in us.tracked_convs:
            us.tracked_convs.remove(conv_id)
        return r.ok or r.status_code == 204
    except Exception as e:
        log.warning(f"Failed to delete conversation {conv_id[:12]}: {e}")
        return False

def wipe_all(us: UserSession):
    """Delete every tracked conversation."""
    for cid in list(us.tracked_convs):
        delete_conversation(us, cid)
    us.conversation_id = ""

def send_message_stream(us: UserSession, text: str, attachments: list = None) -> Generator[str, None, None]:
    """
    Send a message to Claude and yield the response stream.
    Aligns with bot (1).py by embedding text attachments into the prompt.
    """
    with us._lock:
        us.busy = True
        try:
            # 1. Process attachments like the bot (embed text in prompt)
            combined_prompt = text
            if attachments:
                for att in attachments:
                    if att.get("type") == "text":
                        file_name = att.get("file_name", "file")
                        content = att.get("content", "")
                        combined_prompt += f"\n\n[File: {file_name}]\n```\n{content}\n```"
                    elif att.get("type") == "image":
                        log.warning("Image attachments are not supported by this API endpoint.")

            if not us.conversation_id:
                create_conversation(us)

            url = (
                f"{BASE_URL}/organizations/{us.organization_id}"
                f"/chat_conversations/{us.conversation_id}/completion"
            )
            
            # Payload EXACTLY as bot (1).py (empty attachments/files)
            payload = {
                "prompt"     : combined_prompt,
                "timezone"   : "UTC",
                "attachments": [],
                "files"      : [],
                "tools"      : [],
            }

            last_error    = None
            retry_delay   = RETRY_DELAY

            for attempt in range(1, RETRY_MAX + 1):
                current_proxy = us.proxy_pool.active

                try:
                    us._sync_proxy()
                    log.debug(f"Attempt {attempt}/{RETRY_MAX} | Proxy: {current_proxy or 'direct'}")

                    resp = us.http.post(url, json=payload, stream=True, timeout=120)

                    if resp.status_code == 429:
                        log.warning(f"Rate limited (429) on attempt {attempt}")
                        if attempt < RETRY_MAX:
                            # If we have a pool, switch accounts immediately
                            if us.account_pool and len(us.account_pool) > 1:
                                if us.rotate_account():
                                    time.sleep(2)
                                    continue
                            
                            wait = retry_delay * attempt
                            time.sleep(wait)
                            if us.proxy_pool.count > 1:
                                us.rotate_proxy()
                            continue
                        break

                    if resp.status_code in (400, 403):
                        log.error(f"Error {resp.status_code} on attempt {attempt}. Body: {resp.text[:200]}")
                        
                        if attempt < RETRY_MAX:
                            # Try rotating account first if it looks like a block
                            if us.account_pool and len(us.account_pool) > 1:
                                if us.rotate_account():
                                    time.sleep(2)
                                    continue

                            log.info("Attempting to start a fresh conversation for retry...")
                            us.conversation_id = ""
                            create_conversation(us)
                            url = (
                                f"{BASE_URL}/organizations/{us.organization_id}"
                                f"/chat_conversations/{us.conversation_id}/completion"
                            )
                            time.sleep(2)
                            continue
                        break

                    resp.raise_for_status()

                    for line in resp.iter_lines():
                        if not line:
                            continue
                        try:
                            line_str = line.decode("utf-8")
                            if not line_str.startswith("data: "):
                                continue
                            event = json.loads(line_str[6:])
                            etype = event.get("type", "")
                            if etype == "completion":
                                yield event.get("completion", "")
                            elif etype == "error":
                                raise RuntimeError(event.get("error", {}).get("message", "Unknown error"))
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            continue

                    us.proxy_pool.mark_success(current_proxy)
                    return

                except Exception as e:
                    log.error(f"Error on attempt {attempt}: {e}")
                    last_error = e
                    if attempt < RETRY_MAX:
                        time.sleep(2)
                        continue
                    break

            if last_error:
                raise last_error
            raise RuntimeError("Failed after all retries")
        finally:
            us.busy = False


